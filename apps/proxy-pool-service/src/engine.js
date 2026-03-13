const { EventEmitter } = require('node:events');
const { evaluateCombat, evaluateStateTransition } = require('./rank');
const { EVENT_LEVEL } = require('./constants');
const { generateRecruitName } = require('./naming');

function parseArrayJson(value) {
    try {
        if (!value) return [];
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function runWithConcurrency(items, limit, handler) {
    const running = new Set();
    const errors = [];

    for (const item of items) {
        const task = Promise.resolve()
            .then(() => handler(item))
            .catch((error) => {
                errors.push(error);
            });

        running.add(task);
        const cleanup = task.finally(() => running.delete(task));
        cleanup.catch(() => {});

        if (running.size >= limit) {
            await Promise.race(running);
        }
    }

    await Promise.allSettled(Array.from(running));

    if (errors.length > 0) {
        throw errors[0];
    }
}

function outcomeLabel(outcome) {
    if (outcome === 'success') return '成功';
    if (outcome === 'blocked') return 'blocked';
    if (outcome === 'timeout') return 'timeout';
    if (outcome === 'network_error') return 'networkError';
    return '未知';
}

function mapEventTypeToChinese(eventType) {
    if (eventType === 'promotion') return '晋升';
    if (eventType === 'demotion') return '降级';
    if (eventType === 'retirement') return '退伍';
    if (eventType === 'honor') return '授予荣誉';
    return '评分事件';
}

class ProxyHubEngine extends EventEmitter {
    constructor({ config, db, workerPool, logger, now }) {
        super();
        this.config = config;
        this.db = db;
        this.workerPool = workerPool;
        this.logger = logger;
        this.now = now || (() => new Date());

        this.started = false;
        this.sourceSyncTimer = null;
        this.stateReviewTimer = null;
        this.snapshotTimer = null;

        this.isSourceCycleRunning = false;
        this.isStateReviewRunning = false;
        this.threadPoolAlerting = false;
    }

    async start() {
        if (this.started) {
            return;
        }

        this.started = true;

        await this.runSourceCycle();
        await this.runStateReviewCycle();
        this.persistSnapshot();

        this.sourceSyncTimer = setInterval(() => {
            void this.runSourceCycle();
        }, this.config.scheduler.sourceSyncMs);

        this.stateReviewTimer = setInterval(() => {
            void this.runStateReviewCycle();
        }, this.config.scheduler.stateReviewMs);

        this.snapshotTimer = setInterval(() => {
            this.persistSnapshot();
        }, this.config.scheduler.snapshotPersistMs);

        this.logger.write({
            event: '等待下一轮',
            stage: '调度',
            result: 'ProxyHub 已启动',
            reason: `抓源间隔 ${Math.round(this.config.scheduler.sourceSyncMs / 1000)} 秒`,
            action: '调度循环启动',
        });
    }

    async stop() {
        this.started = false;
        if (this.sourceSyncTimer) {
            clearInterval(this.sourceSyncTimer);
            this.sourceSyncTimer = null;
        }
        if (this.stateReviewTimer) {
            clearInterval(this.stateReviewTimer);
            this.stateReviewTimer = null;
        }
        if (this.snapshotTimer) {
            clearInterval(this.snapshotTimer);
            this.snapshotTimer = null;
        }
    }

    createRecruitName() {
        return generateRecruitName((name) => this.db.isDisplayNameAvailable(name));
    }

    async runSourceCycle() {
        if (!this.started || this.isSourceCycleRunning) {
            return;
        }

        const sourceConfig = this.config.source.monosans;
        if (!sourceConfig?.enabled) {
            return;
        }

        this.isSourceCycleRunning = true;
        const startedAt = Date.now();
        const sourceName = sourceConfig.name;

        this.logger.write({
            event: '开始抓源',
            stage: '抓源',
            ipSource: sourceName,
            result: '开始',
            action: '拉取代理来源',
        });

        try {
            const fetchResult = await this.workerPool.runTask('fetch-source', {
                url: sourceConfig.url,
                timeoutMs: 20_000,
                allowedProtocols: this.config.validation.allowedProtocols,
            });

            const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const nowIso = this.now().toISOString();
            const upsertStats = this.db.upsertSourceBatch(
                fetchResult.proxies,
                () => this.createRecruitName(),
                sourceName,
                batchId,
                nowIso,
            );

            this.logger.write({
                event: '抓源成功',
                stage: '抓源',
                ipSource: sourceName,
                result: `总 ${fetchResult.normalized}，新增 ${upsertStats.inserted}，更新 ${upsertStats.touched}`,
                durationMs: Date.now() - startedAt,
                action: '进入校验队列',
            });

            await this.runValidationCycle(sourceName);
            this.logger.write({
                event: '等待下一轮',
                stage: '抓源',
                ipSource: sourceName,
                result: '本轮完成',
                action: '等待调度器下次触发',
            });
        } catch (error) {
            this.logger.write({
                event: '抓源失败',
                stage: '抓源',
                ipSource: sourceName,
                result: '失败',
                reason: error?.message || 'unknown',
                durationMs: Date.now() - startedAt,
                action: '等待自动重试',
            });
        } finally {
            this.isSourceCycleRunning = false;
        }
    }

    async runValidationCycle(sourceName) {
        const candidates = this.db.listProxiesForValidation(this.config.scheduler.maxValidationPerCycle);
        if (candidates.length === 0) {
            return;
        }

        const concurrency = Math.max(2, Math.min(this.config.threadPool.workers * 2, 20));
        await runWithConcurrency(candidates, concurrency, async (proxy) => {
            await this.processProxy(proxy, sourceName);
        });
    }

    async processProxy(proxy, sourceName) {
        const cycleStart = Date.now();

        try {
            this.logger.write({
                event: '开始校验',
                proxyName: proxy.display_name,
                ipSource: sourceName,
                stage: '校验',
                result: `${proxy.ip}:${proxy.port}`,
                action: '验证连通性',
            });

            const validation = await this.workerPool.runTask('validate-proxy', {
                ip: proxy.ip,
                port: proxy.port,
                timeoutMs: this.config.validation.maxTimeoutMs,
            });

            this.logger.write({
                event: validation.ok ? '校验通过' : '校验淘汰',
                proxyName: proxy.display_name,
                ipSource: sourceName,
                stage: '校验',
                result: validation.ok ? '通过' : '失败',
                durationMs: validation.latencyMs,
                reason: validation.reason,
                action: validation.ok ? '进入评分' : '记录失败并评分',
            });

            this.logger.write({
                event: '开始评分',
                proxyName: proxy.display_name,
                ipSource: sourceName,
                stage: '评分',
                result: '进行中',
                action: '计算战功与状态',
            });

            const scoreResult = await this.workerPool.runTask('score-proxy', {
                validation,
                seed: `${proxy.unique_key}:${proxy.total_samples}`,
            });

            const nowIso = this.now().toISOString();
            const combat = evaluateCombat({
                proxy,
                outcome: scoreResult.outcome,
                latencyMs: scoreResult.latencyMs || validation.latencyMs || 0,
                nowIso,
                config: this.config,
            });

            this.db.updateProxyById(proxy.id, {
                ...combat.updates,
                source: sourceName,
                updated_at: nowIso,
            });

            const updatedProxy = this.db.getProxyById(proxy.id);
            const activeHonors = parseArrayJson(updatedProxy.honor_active_json);

            for (const award of combat.awards) {
                this.db.upsertHonor({
                    proxy_id: proxy.id,
                    display_name: updatedProxy.display_name,
                    honor_type: award.type,
                    awarded_at: nowIso,
                    reason: award.reason,
                });
            }

            this.db.refreshHonorActive(proxy.id, activeHonors);

            if (proxy.lifecycle !== 'retired' && updatedProxy.lifecycle === 'retired') {
                this.db.insertRetirement({
                    proxy_id: proxy.id,
                    display_name: updatedProxy.display_name,
                    retired_type: updatedProxy.retired_type || '未知',
                    reason: `系统自动判定：${updatedProxy.retired_type || '未知'}`,
                    retired_at: nowIso,
                });
            }

            for (const event of combat.events) {
                this.db.insertProxyEvent({
                    timestamp: nowIso,
                    proxy_id: proxy.id,
                    display_name: updatedProxy.display_name,
                    event_type: event.event_type,
                    level: EVENT_LEVEL.INFO,
                    message: event.message,
                    details: event.details || {},
                });

                this.logger.write({
                    event: mapEventTypeToChinese(event.event_type),
                    proxyName: updatedProxy.display_name,
                    ipSource: sourceName,
                    stage: '评分',
                    result: event.message,
                    action: '状态已更新',
                    details: event.details,
                });
            }

            this.logger.write({
                event: '写数据库成功',
                proxyName: updatedProxy.display_name,
                ipSource: sourceName,
                stage: '入库',
                result: outcomeLabel(scoreResult.outcome),
                durationMs: Date.now() - cycleStart,
                reason: `${updatedProxy.rank}/${updatedProxy.lifecycle}`,
                action: '提交本轮结果',
            });
        } catch (error) {
            this.logger.write({
                event: '写数据库失败',
                proxyName: proxy.display_name,
                ipSource: sourceName,
                stage: '入库',
                result: '失败',
                durationMs: Date.now() - cycleStart,
                reason: error?.message || 'unknown',
                action: '等待下轮重试',
            });
        }
    }

    async runStateReviewCycle() {
        if (!this.started || this.isStateReviewRunning) {
            return;
        }
        this.isStateReviewRunning = true;

        try {
            const list = this.db.listProxiesForStateReview(Math.max(30, this.config.threadPool.workers * 20));
            const nowIso = this.now().toISOString();

            await runWithConcurrency(list, Math.max(2, this.config.threadPool.workers), async (proxy) => {
                await this.workerPool.runTask('state-transition', { proxyId: proxy.id });
                const result = evaluateStateTransition({
                    proxy,
                    nowIso,
                    config: this.config,
                });

                if (!result.change) {
                    return;
                }

                this.db.updateProxyById(proxy.id, {
                    ...result.updates,
                    updated_at: nowIso,
                });

                const refreshed = this.db.getProxyById(proxy.id);
                const msg = `状态迁移：${refreshed.display_name} -> ${refreshed.lifecycle}`;

                this.db.insertProxyEvent({
                    timestamp: nowIso,
                    proxy_id: proxy.id,
                    display_name: refreshed.display_name,
                    event_type: 'state_transition',
                    level: EVENT_LEVEL.INFO,
                    message: msg,
                    details: { change: result.change },
                });

                this.logger.write({
                    event: '开始评分',
                    proxyName: refreshed.display_name,
                    ipSource: refreshed.source,
                    stage: '状态迁移',
                    result: msg,
                    action: '维护生命周期状态',
                });
            });
        } catch (error) {
            this.logger.write({
                event: '线程池告警',
                stage: '状态迁移',
                result: '异常',
                reason: error?.message || 'state-review-error',
                action: '自动恢复重试',
            });
        } finally {
            this.isStateReviewRunning = false;
        }
    }

    persistSnapshot() {
        const poolStatus = this.workerPool.getStatus();
        const sourceDistribution = this.db.getSourceDistribution();
        const rankDistribution = this.db.getRankBoard().map((item) => ({
            rank: item.rank,
            count: item.count,
        }));
        const lifecycleDistribution = this.db.getLifecycleDistribution();

        this.db.insertPoolSnapshot({
            timestamp: this.now().toISOString(),
            workers_total: poolStatus.workersTotal,
            workers_busy: poolStatus.workersBusy,
            queue_size: poolStatus.queueSize,
            completed_tasks: poolStatus.completedTasks,
            failed_tasks: poolStatus.failedTasks,
            restarted_workers: poolStatus.restartedWorkers,
            source_distribution: sourceDistribution,
            rank_distribution: rankDistribution,
            lifecycle_distribution: lifecycleDistribution,
        });

        const highWaterMark = Math.max(20, poolStatus.workersTotal * 8);
        const recoverMark = Math.max(4, poolStatus.workersTotal * 2);

        if (!this.threadPoolAlerting && poolStatus.queueSize >= highWaterMark) {
            this.threadPoolAlerting = true;
            this.logger.write({
                event: '线程池告警',
                stage: '线程池',
                result: `队列积压 ${poolStatus.queueSize}`,
                reason: `忙碌线程 ${poolStatus.workersBusy}/${poolStatus.workersTotal}`,
                action: '系统持续消化队列',
            });
        } else if (this.threadPoolAlerting && poolStatus.queueSize <= recoverMark) {
            this.threadPoolAlerting = false;
            this.logger.write({
                event: '自动恢复',
                stage: '线程池',
                result: `队列回落 ${poolStatus.queueSize}`,
                action: '告警自动解除',
            });
        }

        this.emit('snapshot', {
            poolStatus,
            sourceDistribution,
            rankDistribution,
            lifecycleDistribution,
        });
    }
}

module.exports = {
    parseArrayJson,
    runWithConcurrency,
    outcomeLabel,
    mapEventTypeToChinese,
    ProxyHubEngine,
};

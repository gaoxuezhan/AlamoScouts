const { EventEmitter } = require('node:events');
const { evaluateCombat, evaluateStateTransition } = require('./rank');
const { EVENT_LEVEL } = require('./constants');
const { generateRecruitName } = require('./naming');

// 0023_parseArrayJson_解析数组JSON逻辑
function parseArrayJson(value) {
    try {
        if (!value) return [];
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// 0024_runWithConcurrency_执行并发逻辑
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

// 0025_outcomeLabel_结果标签逻辑
function outcomeLabel(outcome) {
    if (outcome === 'success') return '成功';
    if (outcome === 'blocked') return 'blocked';
    if (outcome === 'timeout') return 'timeout';
    if (outcome === 'network_error') return 'networkError';
    if (outcome === 'invalid_feedback') return 'invalidFeedback';
    return '未知';
}

// 0026_mapEventTypeToChinese_映射事件类型到中文逻辑
function mapEventTypeToChinese(eventType) {
    if (eventType === 'promotion') return '晋升';
    if (eventType === 'demotion') return '降级';
    if (eventType === 'retirement') return '退伍';
    if (eventType === 'honor') return '授予荣誉';
    return '评分事件';
}

// 0208_pickValidationFailureOutcome_选择L0失败结果逻辑
function pickValidationFailureOutcome(validation) {
    const reason = String(validation?.reason || '').toLowerCase();
    if (reason.includes('timeout')) {
        return 'timeout';
    }
    if (reason.includes('blocked')) {
        return 'blocked';
    }
    return 'network_error';
}

// 0209_buildBattleCounterUpdates_构建战场计数更新逻辑
function buildBattleCounterUpdates(proxy, nowIso, outcome) {
    const isSuccess = outcome === 'success';
    return {
        last_battle_checked_at: nowIso,
        last_battle_outcome: outcome,
        battle_success_count: (proxy.battle_success_count || 0) + (isSuccess ? 1 : 0),
        battle_fail_count: (proxy.battle_fail_count || 0) + (isSuccess ? 0 : 1),
    };
}

class ProxyHubEngine extends EventEmitter {
    // 0027_constructor_初始化实例逻辑
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
        this.battleL1Timer = null;
        this.battleL2Timer = null;

        this.isSourceCycleRunning = false;
        this.isStateReviewRunning = false;
        this.isBattleL1Running = false;
        this.isBattleL2Running = false;
        this.threadPoolAlerting = false;
    }

    // 0210_isBattleEnabled_判断战场测试开关逻辑
    isBattleEnabled() {
        return this.config?.battle?.enabled === true;
    }

    // 0028_start_启动逻辑
    async start() {
        if (this.started) {
            return;
        }

        this.started = true;

        await this.runSourceCycle();
        await this.runStateReviewCycle();
        if (this.isBattleEnabled()) {
            await this.runBattleL1Cycle();
            await this.runBattleL2Cycle();
        }
        this.persistSnapshot();

        this.sourceSyncTimer = setInterval(() => {
            void this.runSourceCycle();
        }, this.config.scheduler.sourceSyncMs);

        this.stateReviewTimer = setInterval(() => {
            void this.runStateReviewCycle();
        }, this.config.scheduler.stateReviewMs);

        if (this.isBattleEnabled()) {
            this.battleL1Timer = setInterval(() => {
                void this.runBattleL1Cycle();
            }, this.config.battle.l1SyncMs);

            this.battleL2Timer = setInterval(() => {
                void this.runBattleL2Cycle();
            }, this.config.battle.l2SyncMs);
        }

        this.snapshotTimer = setInterval(() => {
            this.persistSnapshot();
        }, this.config.scheduler.snapshotPersistMs);

        this.logger.write({
            event: '等待下一轮',
            stage: '调度',
            result: 'ProxyHub 已启动',
            reason: `抓源间隔 ${Math.round(this.config.scheduler.sourceSyncMs / 1000)} 秒`,
            action: this.isBattleEnabled()
                ? `L1 ${Math.round(this.config.battle.l1SyncMs / 1000)} 秒, L2 ${Math.round(this.config.battle.l2SyncMs / 1000)} 秒`
                : '调度循环启动',
        });
    }

    // 0029_stop_停止逻辑
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
        if (this.battleL1Timer) {
            clearInterval(this.battleL1Timer);
            this.battleL1Timer = null;
        }
        if (this.battleL2Timer) {
            clearInterval(this.battleL2Timer);
            this.battleL2Timer = null;
        }
    }

    // 0030_createRecruitName_创建新兵名称逻辑
    createRecruitName() {
        return generateRecruitName((name) => this.db.isDisplayNameAvailable(name));
    }

    // 0031_runSourceCycle_执行来源轮次逻辑
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

    // 0032_runValidationCycle_执行校验轮次逻辑
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

    // 0211_applyCombatOutcome_应用评分结果逻辑
    async applyCombatOutcome({ proxyId, sourceName, outcome, latencyMs, nowIso, stage, extraUpdates = {} }) {
        const currentProxy = this.db.getProxyById(proxyId);
        if (!currentProxy) {
            return;
        }

        const combat = evaluateCombat({
            proxy: currentProxy,
            outcome,
            latencyMs,
            nowIso,
            config: this.config,
        });

        this.db.updateProxyById(proxyId, {
            ...combat.updates,
            ...extraUpdates,
            updated_at: nowIso,
        });

        const updatedProxy = this.db.getProxyById(proxyId);
        const activeHonors = parseArrayJson(updatedProxy.honor_active_json);

        for (const award of combat.awards) {
            this.db.upsertHonor({
                proxy_id: proxyId,
                display_name: updatedProxy.display_name,
                honor_type: award.type,
                awarded_at: nowIso,
                reason: award.reason,
            });
        }

        this.db.refreshHonorActive(proxyId, activeHonors);

        if (currentProxy.lifecycle !== 'retired' && updatedProxy.lifecycle === 'retired') {
            this.db.insertRetirement({
                proxy_id: proxyId,
                display_name: updatedProxy.display_name,
                retired_type: updatedProxy.retired_type || '未知',
                reason: `系统自动判定：${updatedProxy.retired_type || '未知'}`,
                retired_at: nowIso,
            });
        }

        for (const event of combat.events) {
            this.db.insertProxyEvent({
                timestamp: nowIso,
                proxy_id: proxyId,
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
                stage,
                result: event.message,
                action: '状态已更新',
                details: event.details,
            });
        }

        this.logger.write({
            event: '写数据库成功',
            proxyName: updatedProxy.display_name,
            ipSource: sourceName,
            stage,
            result: outcomeLabel(outcome),
            reason: `${updatedProxy.rank}/${updatedProxy.lifecycle}`,
            action: '提交本轮结果',
        });
    }

    // 0033_processProxy_处理代理逻辑
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

            const nowIso = this.now().toISOString();
            this.db.updateProxyById(proxy.id, {
                last_validation_at: nowIso,
                last_validation_ok: validation.ok ? 1 : 0,
                last_validation_reason: validation.reason,
                last_validation_latency_ms: validation.latencyMs || 0,
                source: sourceName,
                updated_at: nowIso,
            });

            this.logger.write({
                event: validation.ok ? '校验通过' : '校验淘汰',
                proxyName: proxy.display_name,
                ipSource: sourceName,
                stage: '校验',
                result: validation.ok ? '通过' : '失败',
                durationMs: validation.latencyMs,
                reason: validation.reason,
                action: validation.ok ? '等待战场测试' : '记录失败并评分',
            });

            if (validation.ok) {
                if (!this.isBattleEnabled()) {
                    await this.applyCombatOutcome({
                        proxyId: proxy.id,
                        sourceName,
                        outcome: 'success',
                        latencyMs: validation.latencyMs || 0,
                        nowIso,
                        stage: '评分(L0回退)',
                    });

                    this.logger.write({
                        event: '写数据库成功',
                        proxyName: proxy.display_name,
                        ipSource: sourceName,
                        stage: '入库',
                        result: outcomeLabel('success'),
                        durationMs: Date.now() - cycleStart,
                        action: 'battle关闭，使用L0成功评分',
                    });
                }
                return;
            }

            const l0Outcome = pickValidationFailureOutcome(validation);
            await this.applyCombatOutcome({
                proxyId: proxy.id,
                sourceName,
                outcome: l0Outcome,
                latencyMs: validation.latencyMs || 0,
                nowIso,
                stage: '评分(L0)',
            });

            this.logger.write({
                event: '写数据库成功',
                proxyName: proxy.display_name,
                ipSource: sourceName,
                stage: '入库',
                result: outcomeLabel(l0Outcome),
                durationMs: Date.now() - cycleStart,
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

    // 0212_runBattleL1Cycle_执行战场L1轮次逻辑
    async runBattleL1Cycle() {
        if (!this.started || !this.isBattleEnabled() || this.isBattleL1Running) {
            return;
        }

        this.isBattleL1Running = true;
        const sourceName = 'battle-l1';

        try {
            const candidates = this.db.listProxiesForBattleL1(
                this.config.battle.maxBattleL1PerCycle,
                this.config.battle.candidateQuota,
            );
            if (candidates.length === 0) {
                return;
            }

            const concurrency = Math.max(2, Math.min(this.config.threadPool.workers, 10));
            await runWithConcurrency(candidates, concurrency, async (proxy) => {
                const result = await this.workerPool.runTask('battle-l1', {
                    proxy: {
                        ip: proxy.ip,
                        port: proxy.port,
                        protocol: proxy.protocol,
                    },
                    targets: this.config.battle.targets.l1,
                    timeoutMs: this.config.battle.timeoutMs.l1,
                    blockedStatusCodes: this.config.battle.blockedStatusCodes,
                    blockSignals: this.config.battle.blockSignals,
                });

                const nowIso = this.now().toISOString();
                for (const run of result.runs || []) {
                    this.db.insertBattleTestRun({
                        timestamp: nowIso,
                        proxy_id: proxy.id,
                        stage: 'l1',
                        target: run.target,
                        outcome: run.outcome,
                        status_code: run.statusCode,
                        latency_ms: run.latencyMs,
                        reason: run.reason,
                        details: run.details,
                    });
                }

                const latest = this.db.getProxyById(proxy.id);
                const battleUpdates = buildBattleCounterUpdates(latest || proxy, nowIso, result.outcome);
                await this.applyCombatOutcome({
                    proxyId: proxy.id,
                    sourceName,
                    outcome: result.outcome,
                    latencyMs: result.latencyMs || 0,
                    nowIso,
                    stage: '评分(L1)',
                    extraUpdates: battleUpdates,
                });
            });
        } catch (error) {
            this.logger.write({
                event: '线程池告警',
                stage: '战场测试L1',
                result: '异常',
                reason: error?.message || 'battle-l1-error',
                action: '等待自动恢复',
            });
        } finally {
            this.isBattleL1Running = false;
        }
    }

    // 0213_runBattleL2Cycle_执行战场L2轮次逻辑
    async runBattleL2Cycle() {
        if (!this.started || !this.isBattleEnabled() || this.isBattleL2Running) {
            return;
        }

        this.isBattleL2Running = true;
        const sourceName = 'battle-l2';

        try {
            const candidates = this.db.listProxiesForBattleL2(
                this.config.battle.maxBattleL2PerCycle,
                this.config.battle.l2LookbackMinutes,
            );
            if (candidates.length === 0) {
                return;
            }

            const concurrency = Math.max(1, Math.min(this.config.threadPool.workers, 6));
            await runWithConcurrency(candidates, concurrency, async (proxy) => {
                const result = await this.workerPool.runTask('battle-l2', {
                    proxy: {
                        ip: proxy.ip,
                        port: proxy.port,
                        protocol: proxy.protocol,
                    },
                    primaryTargets: this.config.battle.targets.l2Primary,
                    fallbackTargets: this.config.battle.targets.l2Fallback,
                    timeoutMs: this.config.battle.timeoutMs.l2,
                    blockedStatusCodes: this.config.battle.blockedStatusCodes,
                    blockSignals: this.config.battle.blockSignals,
                });

                const nowIso = this.now().toISOString();
                for (const run of result.runs || []) {
                    this.db.insertBattleTestRun({
                        timestamp: nowIso,
                        proxy_id: proxy.id,
                        stage: 'l2',
                        target: run.target,
                        outcome: run.outcome,
                        status_code: run.statusCode,
                        latency_ms: run.latencyMs,
                        reason: run.reason,
                        details: run.details,
                    });
                }

                const latest = this.db.getProxyById(proxy.id);
                const battleUpdates = buildBattleCounterUpdates(latest || proxy, nowIso, result.outcome);
                await this.applyCombatOutcome({
                    proxyId: proxy.id,
                    sourceName,
                    outcome: result.outcome,
                    latencyMs: result.latencyMs || 0,
                    nowIso,
                    stage: '评分(L2)',
                    extraUpdates: battleUpdates,
                });
            });
        } catch (error) {
            this.logger.write({
                event: '线程池告警',
                stage: '战场测试L2',
                result: '异常',
                reason: error?.message || 'battle-l2-error',
                action: '等待自动恢复',
            });
        } finally {
            this.isBattleL2Running = false;
        }
    }

    // 0034_runStateReviewCycle_执行状态巡检轮次逻辑
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

    // 0035_persistSnapshot_持久化快照逻辑
    persistSnapshot() {
        if (!this.started) {
            return;
        }

        const poolStatus = this.workerPool.getStatus();
        let sourceDistribution = [];
        let rankDistribution = [];
        let lifecycleDistribution = [];

        try {
            sourceDistribution = this.db.getSourceDistribution();
            rankDistribution = this.db.getRankBoard().map((item) => ({
                rank: item.rank,
                count: item.count,
            }));
            lifecycleDistribution = this.db.getLifecycleDistribution();

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
        } catch (error) {
            this.logger.write({
                event: '线程池告警',
                stage: '快照',
                result: '持久化失败',
                reason: error?.message || 'snapshot-persist-error',
                action: '等待下一次快照',
            });
            return;
        }

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
    pickValidationFailureOutcome,
    buildBattleCounterUpdates,
    ProxyHubEngine,
};


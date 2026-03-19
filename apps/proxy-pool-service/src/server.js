const path = require('node:path');
const express = require('express');
const defaultConfig = require('./config');
const { ProxyHubDb } = require('./db');
const { RuntimeLogger } = require('./logger');
const { WorkerPool } = require('./worker-pool');
const { ProxyHubEngine } = require('./engine');
const { RolloutOrchestrator } = require('./rollout-orchestrator');
const { renderProxyAdminPage } = require('./views/proxy-admin');
const { renderRuntimeLogsPage } = require('./views/runtime-logs');
const { normalizePolicyPatch, applyPolicyPatch, validatePolicy } = require('./policy');
const {
    ensureRolloutConfig,
    normalizeFeaturePatch,
    applyFeaturePatch,
    evaluateRolloutGuardrails,
} = require('./rollout-guardrails');

// 0091_sendSse_发送SSE逻辑
function sendSse(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// 0092_normalizeLimit_规范化限制逻辑
function normalizeLimit(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? fallback), 10);
    const normalized = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, normalized));
}

// 0093_createRuntime_创建运行时逻辑
function createRuntime(options = {}) {
    const config = options.config || defaultConfig;
    ensureRolloutConfig(config);
    const app = options.app || express();
    if (typeof app.use === 'function') {
        app.use(express.json());
    }

    const db = options.db || new ProxyHubDb(config);
    const logger = options.logger || new RuntimeLogger({ db, retention: config.service.logRetention });
    const workerPool = options.workerPool || new WorkerPool({
        size: config.threadPool.workers,
        taskTimeoutMs: config.threadPool.taskTimeoutMs,
        workerFile: path.join(__dirname, 'worker.js'),
    });
    const engine = options.engine || new ProxyHubEngine({ config, db, workerPool, logger });
    const orchestrator = options.orchestrator || new RolloutOrchestrator({
        config,
        db,
        logger,
    });

    const logClients = new Set();
    const poolClients = new Set();

    logger.subscribe((entry) => {
        for (const client of logClients) {
            sendSse(client, entry);
        }
    });

    workerPool.subscribe((status) => {
        const payload = {
            timestamp: new Date().toISOString(),
            poolStatus: status,
        };
        for (const client of poolClients) {
            sendSse(client, payload);
        }
    });

    engine.on('snapshot', (snapshot) => {
        const payload = {
            timestamp: new Date().toISOString(),
            poolStatus: snapshot.poolStatus,
            sourceDistribution: snapshot.sourceDistribution,
            rankDistribution: snapshot.rankDistribution,
            lifecycleDistribution: snapshot.lifecycleDistribution,
        };

        for (const client of poolClients) {
            sendSse(client, payload);
        }
    });

    app.get('/health', (_req, res) => {
        const poolStatus = workerPool.getStatus();
        res.json({
            ok: true,
            service: config.service.name,
            timezone: config.service.timezone,
            port: config.service.port,
            poolStatus,
        });
    });

    app.get('/proxy-admin', (_req, res) => {
        res.type('html').send(renderProxyAdminPage(config));
    });

    app.get('/runtime/logs', (_req, res) => {
        res.type('html').send(renderRuntimeLogsPage());
    });

    app.get('/v1/proxies/pool-status', (_req, res) => {
        res.json({
            poolStatus: workerPool.getStatus(),
            sourceDistribution: db.getSourceDistribution(),
            lifecycleDistribution: db.getLifecycleDistribution(),
            latestSnapshot: db.getLatestSnapshot(),
        });
    });

    app.get('/v1/proxies/list', (req, res) => {
        const limit = normalizeLimit(req.query.limit, 200, 1, 500);
        const rank = req.query.rank ? String(req.query.rank) : undefined;
        const lifecycle = req.query.lifecycle ? String(req.query.lifecycle) : undefined;

        res.json({
            items: db.getProxyList({ limit, rank, lifecycle }),
        });
    });

    app.get('/v1/proxies/events', (req, res) => {
        const limit = normalizeLimit(req.query.limit, 200, 1, 500);
        res.json({
            items: db.getEvents(limit),
        });
    });

    app.get('/v1/proxies/battle-tests', (req, res) => {
        const limit = normalizeLimit(req.query.limit, 200, 1, 500);
        res.json({
            items: db.getBattleTestRuns(limit),
        });
    });

    app.get('/v1/proxies/value-board', (req, res) => {
        const limit = normalizeLimit(req.query.limit, 100, 1, 500);
        const lifecycle = req.query.lifecycle ? String(req.query.lifecycle) : undefined;
        res.json({
            items: db.getValueBoard(limit, lifecycle),
        });
    });

    app.get('/v1/proxies/policy', (_req, res) => {
        res.json({
            policy: config.policy,
        });
    });

    app.get('/v1/proxies/rollout', (_req, res) => {
        res.json({
            rollout: config.rollout,
        });
    });

    app.get('/v1/proxies/rollout/guardrails', (_req, res) => {
        res.json({
            guardrails: evaluateRolloutGuardrails({
                db,
                config,
                nowIso: new Date().toISOString(),
            }),
        });
    });

    app.get('/v1/proxies/rollout/orchestrator/state', (_req, res) => {
        res.json({
            state: db.getRolloutSwitchState?.(new Date().toISOString()) || null,
            config: config.rollout.orchestrator,
            instanceId: orchestrator.instanceId,
        });
    });

    app.get('/v1/proxies/rollout/orchestrator/events', (req, res) => {
        const limit = normalizeLimit(req.query.limit, 200, 1, 500);
        res.json({
            items: db.getRolloutSwitchEvents?.(limit) || [],
        });
    });

    app.get('/v1/proxies/candidate-control', (_req, res) => {
        const distribution = db.getLifecycleDistribution?.() || [];
        const candidateCountFromDistribution = distribution
            .find((item) => String(item.lifecycle) === 'candidate')?.count || 0;
        const candidateCount = Number(
            db.getLifecycleCount?.('candidate') ?? candidateCountFromDistribution,
        ) || 0;
        res.json({
            candidateControl: config.candidateControl || {},
            candidateCount,
        });
    });

    app.post('/v1/proxies/policy', (req, res) => {
        const normalized = normalizePolicyPatch(req.body);
        if (!normalized.ok) {
            res.status(400).json({
                ok: false,
                error: normalized.error,
            });
            return;
        }

        const nextPolicy = applyPolicyPatch(config.policy, normalized.patch);
        const validation = validatePolicy(nextPolicy);
        if (!validation.ok) {
            res.status(400).json({
                ok: false,
                error: validation.error,
            });
            return;
        }

        config.policy = nextPolicy;
        logger.write({
            event: '策略调整',
            stage: '策略',
            result: '策略已更新',
            action: '即时生效',
            details: normalized.patch,
        });

        res.json({
            ok: true,
            policy: config.policy,
        });
    });

    app.post('/v1/proxies/rollout/features', (req, res) => {
        const normalized = normalizeFeaturePatch(req.body);
        if (!normalized.ok) {
            res.status(400).json({
                ok: false,
                error: normalized.error,
            });
            return;
        }

        const features = applyFeaturePatch(config, normalized.patch);
        logger.write({
            event: '策略调整',
            stage: 'rollout',
            result: '特性开关已更新',
            action: '即时生效',
            details: {
                patch: normalized.patch,
                features,
            },
        });

        res.json({
            ok: true,
            features,
        });
    });

    app.post('/v1/proxies/rollout/guardrails/rollback', (_req, res) => {
        const report = evaluateRolloutGuardrails({
            db,
            config,
            nowIso: new Date().toISOString(),
        });

        if (!report.shouldRollback) {
            res.json({
                ok: true,
                applied: false,
                features: config.rollout.features,
                guardrails: report,
            });
            return;
        }

        const patch = {};
        for (const key of report.recommendedRollbackFeatures) {
            patch[key] = false;
        }
        const features = applyFeaturePatch(config, patch);

        logger.write({
            event: '自动恢复',
            stage: 'rollout',
            result: '触发建议回滚',
            action: '已关闭建议特性开关',
            details: {
                patch,
                breaches: report.breaches,
            },
        });

        res.json({
            ok: true,
            applied: true,
            patch,
            features,
            guardrails: report,
        });
    });

    app.post('/v1/proxies/rollout/orchestrator/tick', async (_req, res) => {
        const report = await orchestrator.tick({ trigger: 'api' });
        res.json(report);
    });

    app.post('/v1/proxies/candidate-control', (req, res) => {
        const payload = req.body;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            res.status(400).json({
                ok: false,
                error: 'invalid-candidate-control-patch',
            });
            return;
        }

        if (!config.candidateControl || typeof config.candidateControl !== 'object') {
            config.candidateControl = {};
        }

        if (Object.prototype.hasOwnProperty.call(payload, 'max')) {
            const max = Number(payload.max);
            if (!Number.isFinite(max) || max < 0) {
                res.status(400).json({
                    ok: false,
                    error: 'invalid-candidate-max',
                });
                return;
            }
            config.candidateControl.max = max;
        }

        if (Object.prototype.hasOwnProperty.call(payload, 'gateOverride')) {
            if (typeof payload.gateOverride !== 'boolean') {
                res.status(400).json({
                    ok: false,
                    error: 'invalid-candidate-gate-override',
                });
                return;
            }
            config.candidateControl.gateOverride = payload.gateOverride;
        }

        logger.write({
            event: '策略调整',
            stage: 'candidate-control',
            result: '新兵治理开关已更新',
            action: '即时生效',
            details: {
                patch: payload,
                candidateControl: config.candidateControl,
            },
        });

        res.json({
            ok: true,
            candidateControl: config.candidateControl,
        });
    });

    app.get('/v1/proxies/ranks/board', (_req, res) => {
        res.json({
            items: db.getRankBoard(),
        });
    });

    app.get('/v1/proxies/honors', (req, res) => {
        const limit = normalizeLimit(req.query.limit, 100, 1, 500);
        res.json({
            items: db.getHonors(limit),
        });
    });

    app.get('/v1/proxies/retirements', (req, res) => {
        const limit = normalizeLimit(req.query.limit, 100, 1, 500);
        res.json({
            items: db.getRetirements(limit),
        });
    });

    app.get('/v1/runtime/logs', (req, res) => {
        const limit = normalizeLimit(req.query.limit, 200, 1, 1000);
        res.json({
            items: db.getRuntimeLogs(limit),
        });
    });

    app.get('/api/runtime/logs/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        logClients.add(res);

        for (const item of db.getRuntimeLogs(50).reverse()) {
            sendSse(res, item);
        }

        req.on('close', () => {
            logClients.delete(res);
        });
    });

    app.get('/api/runtime/thread-pools/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        poolClients.add(res);
        sendSse(res, {
            timestamp: new Date().toISOString(),
            poolStatus: workerPool.getStatus(),
            sourceDistribution: db.getSourceDistribution(),
            lifecycleDistribution: db.getLifecycleDistribution(),
            rankDistribution: db.getRankBoard(),
        });

        req.on('close', () => {
            poolClients.delete(res);
        });
    });

    let server;
    let engineStartPromise = null;
    let orchestratorStartPromise = null;

    // 0094_start_启动逻辑
    async function start() {
        return new Promise((resolve, reject) => {
            // 0095_onError_执行onError相关逻辑
            const onError = (err) => {
                reject(err);
            };

            try {
                server = app.listen(config.service.port, config.service.host, () => {
                    server.off('error', onError);
                    logger.write({
                        event: '自动恢复',
                        stage: '服务',
                        result: `${config.service.name} 已监听 ${config.service.host}:${config.service.port}`,
                        action: '可访问 /proxy-admin 和 /runtime/logs',
                    });

                    engineStartPromise = Promise.resolve()
                        .then(() => engine.start())
                        .catch((error) => {
                            logger.write({
                                event: '线程池告警',
                                stage: '启动',
                                result: '引擎启动失败',
                                reason: error?.message || 'unknown',
                                action: '保持服务在线并等待下次启动',
                            });
                        })
                        .finally(() => {
                            engineStartPromise = null;
                        });

                    orchestratorStartPromise = Promise.resolve()
                        .then(() => orchestrator.start())
                        .catch((error) => {
                            logger.write({
                                event: '线程池告警',
                                stage: 'rollout',
                                result: '自动编排启动失败',
                                reason: error?.message || 'unknown',
                                action: '保持服务在线并等待手动触发',
                            });
                        })
                        .finally(() => {
                            orchestratorStartPromise = null;
                        });

                    resolve(server);
                });

                server.once('error', onError);
            } catch (error) {
                reject(error);
            }
        });
    }

    // 0096_shutdown_执行shutdown相关逻辑
    async function shutdown(signal = 'SIGTERM') {
        logger.write({
            event: '线程池告警',
            stage: '服务',
            result: `收到退出信号 ${signal}`,
            action: '准备停止',
        });

        if (server) {
            await new Promise((resolve) => server.close(resolve));
            server = null;
        }

        await engine.stop();
        if (engineStartPromise) {
            await engineStartPromise;
        }
        await engine.stop();
        if (orchestratorStartPromise) {
            await orchestratorStartPromise;
        }
        await orchestrator.stop();
        await workerPool.close();
        db.close();
    }

    return {
        app,
        config,
        db,
        logger,
        workerPool,
        engine,
        orchestrator,
        start,
        shutdown,
        _clients: {
            logClients,
            poolClients,
        },
    };
}

// 0097_runCli_执行命令行逻辑
async function runCli(options = {}) {
    const runtime = options.runtime || createRuntime(options.runtimeOptions);
    const processRef = options.processRef || process;

    // 0098_shutdownAndExit_退出逻辑
    const shutdownAndExit = async (signal) => {
        try {
            await runtime.shutdown(signal);
            processRef.exit(0);
        } catch {
            processRef.exit(1);
        }
    };

    processRef.on('SIGINT', () => {
        void shutdownAndExit('SIGINT');
    });
    processRef.on('SIGTERM', () => {
        void shutdownAndExit('SIGTERM');
    });

    try {
        await runtime.start();
    } catch (error) {
        runtime.logger.write({
            event: '线程池告警',
            stage: '启动',
            result: '启动失败',
            reason: error?.message || 'unknown',
            action: '进程退出',
        });
        processRef.exit(1);
    }
}

/* c8 ignore start */
if (require.main === module) {
    void runCli();
}
/* c8 ignore stop */

module.exports = {
    sendSse,
    normalizeLimit,
    createRuntime,
    runCli,
};

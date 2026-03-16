const path = require('node:path');
const express = require('express');
const defaultConfig = require('./config');
const { ProxyHubDb } = require('./db');
const { RuntimeLogger } = require('./logger');
const { WorkerPool } = require('./worker-pool');
const { ProxyHubEngine } = require('./engine');
const { renderProxyAdminPage } = require('./views/proxy-admin');
const { renderRuntimeLogsPage } = require('./views/runtime-logs');
const { normalizePolicyPatch, applyPolicyPatch, validatePolicy } = require('./policy');

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

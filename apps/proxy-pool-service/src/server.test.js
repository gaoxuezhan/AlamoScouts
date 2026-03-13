const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { sendSse, normalizeLimit, createRuntime, runCli } = require('./server');

function createConfig(port = 0) {
    return {
        service: { name: 'ProxyHub', port, host: '127.0.0.1', timezone: 'Asia/Shanghai', logRetention: 100 },
        threadPool: { workers: 2, taskTimeoutMs: 100 },
        scheduler: { sourceSyncMs: 1000, stateReviewMs: 1000, snapshotPersistMs: 1000, maxValidationPerCycle: 10 },
        source: { monosans: { name: 'monosans', url: 'https://x', enabled: true } },
        validation: { allowedProtocols: ['http'], maxTimeoutMs: 1000 },
        policy: {
            serviceHourScale: 3,
            promotionProtectHours: 6,
            ranks: [{ rank: '新兵', minHours: 0, minPoints: 0, minSamples: 0 }, { rank: '列兵', minHours: 1, minPoints: 1, minSamples: 1 }],
            scoring: { success: 1, successFastBonusLt1200: 1, successFastBonusLt2500: 1, blocked: -1, timeout: -1, networkError: -1, invalidFeedback: -1 },
            demotion: { regularWindowSize: 50, regularBlockedRatio: 0.45, regularMinSamples: 3, severeWindowMinutes: 60, severeMinSamples: 3, severeBlockedRatio: 0.7, healthThreshold: 45, lowHealthRetireThreshold: 20 },
            retirement: { disciplineThreshold: 40, disciplineInvalidCount: 2, technicalMinSamples: 6, technicalSuccessRatio: 0.1, battleDamageBlockedRatio: 0.6, honorMinServiceHours: 500, honorMinSuccess: 800 },
            honors: { steelStreak: 3, riskyWarrior: 3, thousandService: 10 },
        },
        storage: { dbPath: 'unused.db', snapshotRetentionDays: 7 },
        ui: { refreshMs: 5000 },
        soak: { durationHours: 24, summaryIntervalMs: 3600000 },
    };
}

function createStubs() {
    const loggerEvents = new EventEmitter();
    const poolEvents = new EventEmitter();
    const state = { dbClosed: false, poolClosed: false, engineStarted: false, engineStopped: false };

    const db = {
        getSourceDistribution: () => [{ source: 'monosans', count: 2 }],
        getLifecycleDistribution: () => [{ lifecycle: 'active', count: 1 }],
        getLatestSnapshot: () => ({ workers_total: 2 }),
        getProxyList: () => [{ id: 1 }],
        getEvents: () => [{ id: 2 }],
        getRankBoard: () => [{ rank: '新兵', count: 1 }],
        getHonors: () => [{ id: 3 }],
        getRetirements: () => [{ id: 4 }],
        getRuntimeLogs: () => [{ id: 5, event: '开始抓源' }],
        close: () => {
            state.dbClosed = true;
        },
    };

    const logger = {
        entries: [],
        write(entry) {
            this.entries.push(entry);
            loggerEvents.emit('log', entry);
            return entry;
        },
        subscribe(handler) {
            loggerEvents.on('log', handler);
            return () => loggerEvents.off('log', handler);
        },
    };

    const workerPool = {
        getStatus: () => ({ workersTotal: 2, workersBusy: 1, queueSize: 0, runningTasks: 0, completedTasks: 1, failedTasks: 0, restartedWorkers: 0, workers: [] }),
        subscribe(handler) {
            poolEvents.on('status', handler);
            return () => poolEvents.off('status', handler);
        },
        close: async () => {
            state.poolClosed = true;
        },
    };

    const engine = new EventEmitter();
    engine.start = async () => {
        state.engineStarted = true;
    };
    engine.stop = async () => {
        state.engineStopped = true;
    };

    return { db, logger, workerPool, engine, state };
}

async function startRuntimeOnRandomPort(stubs) {
    const runtime = createRuntime({ config: createConfig(0), ...stubs });
    const server = await runtime.start();
    const addr = server.address();
    return { runtime, baseUrl: `http://127.0.0.1:${addr.port}` };
}

test('sendSse and normalizeLimit should handle boundaries', () => {
    const chunks = [];
    const fakeRes = { write: (chunk) => chunks.push(chunk) };
    sendSse(fakeRes, { ok: true });
    assert.equal(chunks[0].startsWith('data: '), true);

    assert.equal(normalizeLimit('300', 200, 1, 500), 300);
    assert.equal(normalizeLimit('x', 200, 1, 500), 200);
    assert.equal(normalizeLimit('-1', 200, 1, 500), 1);
    assert.equal(normalizeLimit('9999', 200, 1, 500), 500);
    assert.equal(normalizeLimit(undefined, 7, 1, 10), 7);
});

test('server runtime should expose all REST endpoints and shutdown cleanly', async () => {
    const stubs = createStubs();
    const { runtime, baseUrl } = await startRuntimeOnRandomPort(stubs);

    const urls = [
        '/health',
        '/proxy-admin',
        '/runtime/logs',
        '/v1/proxies/pool-status',
        '/v1/proxies/list?limit=9999',
        '/v1/proxies/list?limit=10&rank=%E5%88%97%E5%85%B5&lifecycle=active',
        '/v1/proxies/events?limit=0',
        '/v1/proxies/ranks/board',
        '/v1/proxies/honors?limit=1000',
        '/v1/proxies/retirements?limit=-1',
        '/v1/runtime/logs?limit=abc',
    ];

    for (const p of urls) {
        const res = await fetch(baseUrl + p, { signal: AbortSignal.timeout(10000) });
        assert.equal(res.status, 200);
    }

    const sseLogs = await fetch(baseUrl + '/api/runtime/logs/stream', {
        headers: { Accept: 'text/event-stream' },
        signal: AbortSignal.timeout(5000),
    });
    assert.equal((sseLogs.headers.get('content-type') || '').includes('text/event-stream'), true);
    sseLogs.body.cancel();

    const ssePool = await fetch(baseUrl + '/api/runtime/thread-pools/stream', {
        headers: { Accept: 'text/event-stream' },
        signal: AbortSignal.timeout(5000),
    });
    assert.equal((ssePool.headers.get('content-type') || '').includes('text/event-stream'), true);
    ssePool.body.cancel();

    await runtime.shutdown('TEST');
    assert.equal(stubs.state.dbClosed, true);
    assert.equal(stubs.state.poolClosed, true);
    assert.equal(stubs.state.engineStopped, true);
});

test('server start should reject when listen emits error', async () => {
    const fakeApp = new EventEmitter();
    fakeApp.use = () => {};
    fakeApp.get = () => {};
    fakeApp.listen = () => {
        const server = new EventEmitter();
        server.close = (cb) => cb();
        setImmediate(() => server.emit('error', new Error('listen-failed')));
        return server;
    };

    const runtime = createRuntime({ config: createConfig(5091), app: fakeApp, ...createStubs() });
    await assert.rejects(() => runtime.start(), /listen-failed/);
    await runtime.shutdown('TEST2');
});

test('server start should handle sync listen throw and engine async start failure', async () => {
    const fakeAppThrow = new EventEmitter();
    fakeAppThrow.use = () => {};
    fakeAppThrow.get = () => {};
    fakeAppThrow.listen = () => {
        throw new Error('listen-throw');
    };

    const runtimeThrow = createRuntime({ config: createConfig(5092), app: fakeAppThrow, ...createStubs() });
    await assert.rejects(() => runtimeThrow.start(), /listen-throw/);
    await runtimeThrow.shutdown('TEST3');

    const stubs = createStubs();
    stubs.engine.start = async () => {
        throw null;
    };

    const { runtime } = await startRuntimeOnRandomPort(stubs);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stubs.logger.entries.some((e) => e.result === '引擎启动失败' && e.reason === 'unknown'), true);
    await runtime.shutdown('TEST4');

    const stubsMsg = createStubs();
    stubsMsg.engine.start = async () => {
        throw new Error('engine-start-fail');
    };
    const { runtime: runtimeMsg } = await startRuntimeOnRandomPort(stubsMsg);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stubsMsg.logger.entries.some((e) => e.reason === 'engine-start-fail'), true);
    await runtimeMsg.shutdown('TEST4-MSG');
});

test('runCli should register signals and handle startup failure', async () => {
    const processEvents = {};
    const processRef = {
        exitCode: null,
        on(event, handler) {
            processEvents[event] = handler;
        },
        exit(code) {
            this.exitCode = code;
        },
    };

    const runtimeOk = {
        stopped: false,
        logger: { write() {} },
        async start() {},
        async shutdown() {
            this.stopped = true;
        },
    };

    await runCli({ runtime: runtimeOk, processRef });
    assert.equal(typeof processEvents.SIGINT, 'function');
    assert.equal(typeof processEvents.SIGTERM, 'function');

    await processEvents.SIGTERM();
    assert.equal(runtimeOk.stopped, true);
    assert.equal(processRef.exitCode, 0);

    const processRefSigint = {
        exitCode: null,
        on(event, handler) {
            processEvents[event] = handler;
        },
        exit(code) {
            this.exitCode = code;
        },
    };
    const runtimeSigint = {
        logger: { write() {} },
        async start() {},
        async shutdown() {
            throw new Error('shutdown-fail');
        },
    };
    await runCli({ runtime: runtimeSigint, processRef: processRefSigint });
    await processEvents.SIGINT();
    assert.equal(processRefSigint.exitCode, 1);

    const processRefFail = {
        exitCode: null,
        on() {},
        exit(code) { this.exitCode = code; },
    };

    const writes = [];
    const runtimeFail = {
        logger: { write(entry) { writes.push(entry); } },
        async start() {
            throw new Error('start-fail');
        },
        async shutdown() {},
    };

    await runCli({ runtime: runtimeFail, processRef: processRefFail });
    assert.equal(processRefFail.exitCode, 1);
    assert.equal(writes.some((w) => w.result === '启动失败'), true);

    const oldOn = process.on;
    const oldExit = process.exit;
    const handlers = {};
    let exitCode = null;
    process.on = (event, handler) => {
        handlers[event] = handler;
    };
    process.exit = (code) => {
        exitCode = code;
    };
    const defaultRuntime = {
        logger: { write(entry) { writes.push(entry); } },
        async start() {
            throw null;
        },
        async shutdown() {},
    };
    await runCli({ runtime: defaultRuntime });
    assert.equal(typeof handlers.SIGINT, 'function');
    assert.equal(exitCode, 1);
    assert.equal(writes.some((w) => w.reason === 'unknown'), true);
    process.on = oldOn;
    process.exit = oldExit;
});

test('createRuntime should support default options object path', async () => {
    const runtime = createRuntime();
    await runtime.shutdown('TEST-DEFAULTS');
});

test('runCli should create runtime when runtime is not injected', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyhub-runcli-'));
    const processEvents = {};
    const processRef = {
        exitCode: null,
        on(event, handler) {
            processEvents[event] = handler;
        },
        exit(code) {
            this.exitCode = code;
        },
    };
    const config = createConfig(0);
    config.storage.dbPath = path.join(dir, 'proxyhub.db');
    config.source.monosans.enabled = false;
    config.threadPool.workers = 1;
    config.scheduler.sourceSyncMs = 60_000;
    config.scheduler.stateReviewMs = 60_000;
    config.scheduler.snapshotPersistMs = 60_000;

    await runCli({ runtimeOptions: { config }, processRef });
    processEvents.SIGTERM();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(processRef.exitCode, 0);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('server runtime should cover default dependency wiring and SSE fanout loops', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyhub-server-'));
    const dbPath = path.join(dir, 'proxyhub.db');
    const config = createConfig(0);
    config.storage.dbPath = dbPath;
    config.source.monosans.enabled = false;
    config.threadPool.workers = 1;

    const runtime = createRuntime({ config });
    const writes = [];
    const logClient = {
        write(chunk) {
            writes.push(chunk);
        },
    };
    const poolClient = {
        write(chunk) {
            writes.push(chunk);
        },
    };
    runtime._clients.logClients.add(logClient);
    runtime._clients.poolClients.add(poolClient);

    runtime.logger.write({
        event: '开始抓源',
        stage: '抓源',
        result: 'ok',
        action: 'test',
    });
    runtime.workerPool.emitStatus();
    runtime.engine.emit('snapshot', {
        poolStatus: runtime.workerPool.getStatus(),
        sourceDistribution: [],
        rankDistribution: [],
        lifecycleDistribution: [],
    });

    assert.equal(writes.length >= 3, true);

    await runtime.shutdown('TEST5');
    fs.rmSync(dir, { recursive: true, force: true });
});



const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProxyHubDb } = require('./db');
const {
    parseArrayJson,
    runWithConcurrency,
    outcomeLabel,
    mapEventTypeToChinese,
    ProxyHubEngine,
} = require('./engine');

// 0036_createConfig_创建配置逻辑
function createConfig(dbPath) {
    return {
        service: { logRetention: 500 },
        storage: { dbPath, snapshotRetentionDays: 7 },
        threadPool: { workers: 2 },
        scheduler: { sourceSyncMs: 10000, stateReviewMs: 10000, snapshotPersistMs: 10000, maxValidationPerCycle: 5 },
        battle: {
            enabled: false,
            l1SyncMs: 300000,
            l2SyncMs: 1800000,
            maxBattleL1PerCycle: 60,
            maxBattleL2PerCycle: 20,
            candidateQuota: 0.15,
            l2LookbackMinutes: 10,
            timeoutMs: { l1: 5000, l2: 8000 },
            blockedStatusCodes: [401, 403, 429, 503],
            blockSignals: ['captcha'],
            targets: {
                l1: [{ name: 'ipify', url: 'https://api.ipify.org?format=json' }],
                l2Primary: [{ name: 'ly', url: 'https://www.ly.com/flights' }],
                l2Fallback: [{ name: 'baidu', url: 'https://www.baidu.com' }],
            },
        },
        source: { monosans: { name: 'monosans/proxy-list', url: 'https://example.com', enabled: true } },
        validation: { allowedProtocols: ['http', 'https', 'socks5'], maxTimeoutMs: 1000 },
        policy: {
            serviceHourScale: 3,
            promotionProtectHours: 6,
            ranks: [
                { rank: '新兵', minHours: 0, minPoints: 0, minSamples: 0 },
                { rank: '列兵', minHours: 1, minPoints: 5, minSamples: 2 },
                { rank: '士官', minHours: 2, minPoints: 20, minSamples: 4 },
                { rank: '尉官', minHours: 3, minPoints: 30, minSamples: 6 },
                { rank: '王牌', minHours: 4, minPoints: 50, minSamples: 8 },
            ],
            scoring: {
                success: 6,
                successFastBonusLt1200: 0,
                successFastBonusLt2500: 0,
                blocked: -8,
                timeout: -6,
                networkError: -5,
                invalidFeedback: -10,
            },
            demotion: {
                regularWindowSize: 50,
                regularBlockedRatio: 0.45,
                regularMinSamples: 3,
                severeWindowMinutes: 60,
                severeMinSamples: 3,
                severeBlockedRatio: 0.7,
                healthThreshold: 45,
                lowHealthRetireThreshold: 20,
            },
            retirement: {
                disciplineThreshold: 40,
                disciplineInvalidCount: 2,
                technicalMinSamples: 6,
                technicalSuccessRatio: 0.1,
                battleDamageBlockedRatio: 0.6,
                honorMinServiceHours: 500,
                honorMinSuccess: 800,
            },
            honors: { steelStreak: 3, riskyWarrior: 3, thousandService: 10 },
        },
    };
}

// 0037_createLogger_创建逻辑
function createLogger() {
    const entries = [];
    return {
        entries,
        // 0038_write_写入逻辑
        write(item) {
            entries.push(item);
            return item;
        },
    };
}

// 0039_createDbHandle_创建处理逻辑
function createDbHandle() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyhub-engine-'));
    const dbPath = path.join(dir, 'engine.db');
    const config = createConfig(dbPath);
    const db = new ProxyHubDb(config);
    return { dir, db, config };
}

// 0040_cleanupDb_执行cleanupDb相关逻辑
function cleanupDb(h) {
    h.db.close();
    fs.rmSync(h.dir, { recursive: true, force: true });
}

test('engine utility functions should cover helper branches', async () => {
    assert.deepEqual(parseArrayJson(null), []);
    assert.deepEqual(parseArrayJson('[]'), []);
    assert.deepEqual(parseArrayJson('{}'), []);
    assert.deepEqual(parseArrayJson('{bad'), []);
    assert.equal(outcomeLabel('success'), '成功');
    assert.equal(outcomeLabel('blocked'), 'blocked');
    assert.equal(outcomeLabel('timeout'), 'timeout');
    assert.equal(outcomeLabel('network_error'), 'networkError');
    assert.equal(outcomeLabel('invalid_feedback'), 'invalidFeedback');
    assert.equal(outcomeLabel('other'), '未知');

    assert.equal(mapEventTypeToChinese('promotion'), '晋升');
    assert.equal(mapEventTypeToChinese('demotion'), '降级');
    assert.equal(mapEventTypeToChinese('retirement'), '退伍');
    assert.equal(mapEventTypeToChinese('honor'), '授予荣誉');
    assert.equal(mapEventTypeToChinese('x'), '评分事件');

    const order = [];
    await runWithConcurrency([1, 2, 3], 2, async (n) => {
        order.push(n);
    });
    assert.equal(order.length, 3);

    await assert.rejects(
        () => runWithConcurrency([1, 2], 1, async (n) => {
            if (n === 2) {
                throw new Error('boom');
            }
        }),
        /boom/,
    );
});

test('engine start/stop should be idempotent and persist snapshot', async () => {
    const h = createDbHandle();
    const logger = createLogger();

    const workerPool = {
        // 0041_runTask_执行任务逻辑
        async runTask(type) {
            if (type === 'fetch-source') {
                return { normalized: 0, proxies: [] };
            }
            return { ok: true, latencyMs: 10, reason: 'connect_ok', outcome: 'success' };
        },
        // 0042_getStatus_获取逻辑
        getStatus() {
            return {
                workersTotal: 2,
                workersBusy: 0,
                queueSize: 0,
                runningTasks: 0,
                completedTasks: 0,
                failedTasks: 0,
                restartedWorkers: 0,
                workers: [],
            };
        },
    };

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger, now: () => new Date('2026-03-14T00:00:00.000Z') });

    await engine.start();
    await engine.start();
    await engine.stop();
    await engine.stop();

    const snapshot = h.db.getLatestSnapshot();
    assert.equal(snapshot != null, true);
    assert.equal(logger.entries.some((e) => e.event === '等待下一轮'), true);

    cleanupDb(h);
});

test('engine start should execute scheduled callback bodies', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    h.config.source.monosans.enabled = false;

    const workerPool = {
        // 0043_runTask_执行任务逻辑
        async runTask() {
            return { ok: true };
        },
        // 0044_getStatus_获取逻辑
        getStatus() {
            return {
                workersTotal: 1,
                workersBusy: 0,
                queueSize: 0,
                runningTasks: 0,
                completedTasks: 0,
                failedTasks: 0,
                restartedWorkers: 0,
                workers: [],
            };
        },
    };

    const oldSetInterval = global.setInterval;
    const oldClearInterval = global.clearInterval;
    const timers = [];
    global.setInterval = (fn) => {
        fn();
        const timer = { id: timers.length + 1 };
        timers.push(timer);
        return timer;
    };
    global.clearInterval = () => {};

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger, now: () => new Date('2026-03-14T00:00:00.000Z') });
    await engine.start();
    await engine.stop();

    global.setInterval = oldSetInterval;
    global.clearInterval = oldClearInterval;

    assert.equal(timers.length, 3);
    cleanupDb(h);
});

test('runSourceCycle should skip when not started or source disabled', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    const workerPool = {
        // 0045_runTask_执行任务逻辑
        async runTask() {
            throw new Error('should-not-run');
        },
        // 0046_getStatus_获取逻辑
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger });
    await engine.runSourceCycle();

    engine.started = true;
    h.config.source.monosans.enabled = false;
    await engine.runSourceCycle();

    assert.equal(logger.entries.length, 0);
    cleanupDb(h);
});

test('runSourceCycle and processProxy should handle success path', async () => {
    const h = createDbHandle();
    const logger = createLogger();

    const workerPool = {
        // 0047_runTask_执行任务逻辑
        async runTask(type) {
            if (type === 'fetch-source') {
                return {
                    normalized: 1,
                    proxies: [{ ip: '10.0.0.1', port: 8080, protocol: 'http' }],
                };
            }
            if (type === 'validate-proxy') {
                return { ok: true, reason: 'connect_ok', latencyMs: 20 };
            }
            return { ok: true };
        },
        // 0048_getStatus_获取逻辑
        getStatus() {
            return {
                workersTotal: 2,
                workersBusy: 0,
                queueSize: 0,
                runningTasks: 0,
                completedTasks: 10,
                failedTasks: 0,
                restartedWorkers: 0,
                workers: [],
            };
        },
    };

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger, now: () => new Date('2026-03-14T01:00:00.000Z') });
    engine.started = true;

    await engine.runSourceCycle();

    const proxies = h.db.getProxyList({ limit: 10 });
    assert.equal(proxies.length, 1);
    assert.equal(proxies[0].last_validation_ok, 1);
    assert.equal(logger.entries.some((e) => e.event === '抓源成功'), true);
    assert.equal(logger.entries.some((e) => e.event === '校验通过'), true);

    cleanupDb(h);
});

test('runSourceCycle should handle fetch errors', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    const workerPool = {
        // 0049_runTask_执行任务逻辑
        async runTask(type) {
            if (type === 'fetch-source') {
                throw new Error('fetch-failed');
            }
            return { ok: true };
        },
        // 0050_getStatus_获取逻辑
        getStatus() {
            return { workersTotal: 2, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger });
    engine.started = true;
    await engine.runSourceCycle();

    assert.equal(logger.entries.some((e) => e.event === '抓源失败'), true);

    cleanupDb(h);
});

test('runSourceCycle should use unknown fallback reason when thrown value has no message', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    const workerPool = {
        // 0051_runTask_执行任务逻辑
        async runTask(type) {
            if (type === 'fetch-source') {
                throw null;
            }
            return { ok: true };
        },
        // 0052_getStatus_获取逻辑
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger });
    engine.started = true;
    await engine.runSourceCycle();
    assert.equal(logger.entries.some((e) => e.event === '抓源失败' && e.reason === 'unknown'), true);
    cleanupDb(h);
});

test('processProxy should handle failure path', async () => {
    const h = createDbHandle();
    const logger = createLogger();

    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.2', port: 8081, protocol: 'http' }],
        () => '苍隼-玄武-02',
        'src',
        'batch',
        new Date().toISOString(),
    );

    const proxy = h.db.getProxyList({ limit: 1 })[0];

    const workerPool = {
        // 0053_runTask_执行任务逻辑
        async runTask(type) {
            if (type === 'validate-proxy') {
                throw new Error('validate-failed');
            }
            return { ok: true };
        },
        // 0054_getStatus_获取逻辑
        getStatus() {
            return { workersTotal: 2, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger });
    await engine.processProxy(proxy, 'src');

    assert.equal(logger.entries.some((e) => e.event === '写数据库失败'), true);

    cleanupDb(h);
});

test('processProxy should use unknown fallback reason when thrown value has no message', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.12', port: 8081, protocol: 'http' }],
        () => '苍隼-玄武-12',
        'src',
        'batch',
        new Date().toISOString(),
    );
    const proxy = h.db.getProxyList({ limit: 1 })[0];

    const workerPool = {
        // 0055_runTask_执行任务逻辑
        async runTask(type) {
            if (type === 'validate-proxy') return { ok: false, reason: 'x' };
            return { ok: true };
        },
        // 0056_getStatus_获取逻辑
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    const db = {
        ...h.db,
        // 0057_updateProxyById_更新代理标识逻辑
        updateProxyById() {
            throw null;
        },
    };

    const engine = new ProxyHubEngine({ config: h.config, db, workerPool, logger });
    await engine.processProxy(proxy, 'src');
    assert.equal(logger.entries.some((e) => e.event === '写数据库失败' && e.reason === 'unknown'), true);
    cleanupDb(h);
});

test('processProxy should cover validation false path and retirement/event fallbacks', async () => {
    const rankPath = require.resolve('./rank');
    const enginePath = require.resolve('./engine');
    const rankExports = require.cache[rankPath].exports;

    require.cache[rankPath].exports = {
        ...rankExports,
        evaluateCombat: () => ({
            updates: {
                lifecycle: 'retired',
                retired_type: null,
                rank: '新兵',
                honor_active_json: '[]',
            },
            awards: [{ type: '钢铁连胜', reason: 'x' }],
            events: [{ event_type: 'promotion', message: '晋升事件' }],
        }),
    };
    delete require.cache[enginePath];
    const { ProxyHubEngine: PatchedEngine } = require('./engine');

    const logger = createLogger();
    const calls = { honors: 0, retires: 0, eventDetails: null };
    let lifecycle = 'active';
    let retiredType = null;
    const db = {
        updateProxyById(_id, updates) {
            if (updates.lifecycle) lifecycle = updates.lifecycle;
            if (Object.prototype.hasOwnProperty.call(updates, 'retired_type')) retiredType = updates.retired_type;
        },
        // 0058_getProxyById_获取代理标识逻辑
        getProxyById() {
            return {
                id: 1,
                display_name: '苍隼-补分-01',
                lifecycle,
                retired_type: retiredType,
                rank: '新兵',
                honor_active_json: '[]',
            };
        },
        // 0059_upsertHonor_插入更新荣誉逻辑
        upsertHonor() {
            calls.honors += 1;
        },
        refreshHonorActive() {},
        // 0060_insertRetirement_写入退伍逻辑
        insertRetirement(record) {
            calls.retires += 1;
            calls.retireReason = record.reason;
        },
        // 0061_insertProxyEvent_写入代理事件逻辑
        insertProxyEvent(record) {
            calls.eventDetails = record.details;
        },
    };
    const config = createConfig(path.join(os.tmpdir(), 'proxyhub-engine-stub.db'));
    const workerPool = {
        // 0062_runTask_执行任务逻辑
        async runTask(type) {
            if (type === 'validate-proxy') return { ok: false, reason: 'blocked' };
            return { ok: true };
        },
        // 0063_getStatus_获取逻辑
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };
    const engine = new PatchedEngine({ config, db, workerPool, logger, now: () => new Date('2026-03-14T09:00:00.000Z') });
    const proxy = {
        id: 1,
        display_name: '苍隼-补分-01',
        ip: '1.1.1.1',
        port: 80,
        unique_key: '1.1.1.1:80:http',
        total_samples: 0,
        lifecycle: 'active',
    };
    await engine.processProxy(proxy, 'src');

    assert.equal(calls.honors, 1);
    assert.equal(calls.retires, 1);
    assert.equal(calls.retireReason.includes('未知'), true);
    assert.deepEqual(calls.eventDetails, {});
    assert.equal(logger.entries.some((e) => e.event === '校验淘汰'), true);

    require.cache[rankPath].exports = rankExports;
    delete require.cache[enginePath];
    require('./engine');
});

test('processProxy should persist awards and retirement events', async () => {
    const h = createDbHandle();
    const logger = createLogger();

    h.config.policy.retirement.honorMinServiceHours = 1;
    h.config.policy.retirement.honorMinSuccess = 1;
    h.config.policy.honors.thousandService = 10;
    h.config.battle.enabled = true;
    h.config.battle.maxBattleL1PerCycle = 10;
    h.config.battle.candidateQuota = 1;

    const now = new Date('2026-03-14T05:00:00.000Z').toISOString();
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.9', port: 8181, protocol: 'http' }],
        () => '苍隼-北辰-09',
        'src',
        'batch',
        now,
    );

    const proxy = h.db.getProxyList({ limit: 1 })[0];
    h.db.updateProxyById(proxy.id, {
        lifecycle: 'active',
        rank: '尉官',
        health_score: 90,
        service_hours: 2,
        success_count: 5,
        total_samples: 9,
        honor_history_json: '[]',
        honor_active_json: '[]',
        recent_window_json: JSON.stringify([
            { t: now, o: 'success' },
            { t: now, o: 'success' },
            { t: now, o: 'success' },
        ]),
        updated_at: now,
    });

    const freshProxy = h.db.getProxyById(proxy.id);
    const workerPool = {
        // 0064_runTask_执行任务逻辑
        async runTask(type) {
            if (type === 'battle-l1') {
                return {
                    stage: 'l1',
                    outcome: 'success',
                    latencyMs: 20,
                    runs: [{ target: 'ipify', outcome: 'success', statusCode: 200, latencyMs: 20, reason: 'ok', details: {} }],
                };
            }
            return { ok: true };
        },
        // 0065_getStatus_获取逻辑
        getStatus() {
            return { workersTotal: 2, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger, now: () => new Date('2026-03-14T06:00:00.000Z') });
    engine.started = true;
    await engine.runBattleL1Cycle();

    const honors = h.db.getHonors(10);
    const retirements = h.db.getRetirements(10);
    const events = h.db.getEvents(20);
    assert.equal(honors.length >= 1, true);
    assert.equal(retirements.length >= 1, true);
    assert.equal(events.some((e) => e.event_type === 'retirement'), true);
    assert.equal(logger.entries.some((e) => e.event === '退伍'), true);
    assert.equal(logger.entries.some((e) => e.event === '授予荣誉'), true);

    cleanupDb(h);
});

test('runStateReviewCycle should cover change/no-change and error branches', async () => {
    const h = createDbHandle();
    const logger = createLogger();

    const now = new Date().toISOString();
    h.db.upsertSourceBatch(
        [
            { ip: '10.0.0.3', port: 8082, protocol: 'http' },
            { ip: '10.0.0.4', port: 8083, protocol: 'http' },
        ],
        (() => {
            let i = 0;
            return () => `雷霄-北辰-0${++i}`;
        })(),
        'src',
        'batch',
        now,
    );

    const list = h.db.getProxyList({ limit: 10 });
    h.db.updateProxyById(list[0].id, {
        lifecycle: 'active',
        health_score: 10,
        recent_window_json: JSON.stringify([{ t: now, o: 'blocked' }, { t: now, o: 'blocked' }, { t: now, o: 'blocked' }]),
        updated_at: now,
    });

    h.db.updateProxyById(list[1].id, {
        lifecycle: 'candidate',
        health_score: 90,
        recent_window_json: JSON.stringify([{ t: now, o: 'success' }]),
        updated_at: now,
    });

    let shouldThrow = false;
    const workerPool = {
        // 0066_runTask_执行任务逻辑
        async runTask() {
            if (shouldThrow) {
                throw new Error('state-cycle-fail');
            }
            return { ok: true };
        },
        // 0067_getStatus_获取逻辑
        getStatus() {
            return { workersTotal: 2, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger, now: () => new Date('2026-03-14T02:00:00.000Z') });
    engine.started = true;

    await engine.runStateReviewCycle();
    assert.equal(logger.entries.some((e) => e.stage === '状态迁移'), true);

    engine.isStateReviewRunning = true;
    await engine.runStateReviewCycle();
    engine.isStateReviewRunning = false;

    shouldThrow = true;
    await engine.runStateReviewCycle();
    assert.equal(logger.entries.some((e) => e.event === '线程池告警'), true);

    cleanupDb(h);
});

test('runStateReviewCycle should fallback state-review-error reason when thrown value has no message', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.13', port: 8080, protocol: 'http' }],
        () => '雷霄-北辰-13',
        'src',
        'batch',
        new Date().toISOString(),
    );

    const workerPool = {
        // 0068_runTask_执行任务逻辑
        async runTask() {
            throw null;
        },
        // 0069_getStatus_获取逻辑
        getStatus() {
            return { workersTotal: 2, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger });
    engine.started = true;
    await engine.runStateReviewCycle();
    assert.equal(logger.entries.some((e) => e.event === '线程池告警' && e.reason === 'state-review-error'), true);
    cleanupDb(h);
});

test('persistSnapshot should emit thread pool alert and auto recovery', () => {
    const h = createDbHandle();
    const logger = createLogger();

    let queueSize = 30;
    const workerPool = {
        // 0070_getStatus_获取逻辑
        getStatus() {
            return {
                workersTotal: 2,
                workersBusy: queueSize > 0 ? 2 : 0,
                queueSize,
                runningTasks: 0,
                completedTasks: 0,
                failedTasks: 0,
                restartedWorkers: 0,
                workers: [],
            };
        },
    };

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger, now: () => new Date('2026-03-14T03:00:00.000Z') });

    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.7', port: 80, protocol: 'http' }],
        () => '风暴-北辰-07',
        'src',
        'batch',
        new Date('2026-03-14T03:00:00.000Z').toISOString(),
    );

    let emitted = 0;
    engine.on('snapshot', () => {
        emitted += 1;
    });

    engine.persistSnapshot();
    queueSize = 0;
    engine.persistSnapshot();

    assert.equal(emitted, 2);
    assert.equal(logger.entries.some((e) => e.event === '线程池告警'), true);
    assert.equal(logger.entries.some((e) => e.event === '自动恢复'), true);

    cleanupDb(h);
});

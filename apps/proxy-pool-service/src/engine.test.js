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
    pickValidationFailureOutcome,
    buildBattleCounterUpdates,
    readCandidateControl,
    buildCandidateGateState,
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
        candidateControl: {
            max: 3000,
            gateOverride: false,
            sweepMs: 900000,
            staleHours: 24,
            staleMinSamples: 3,
            timeoutHours: 72,
            maxRetirePerCycle: 2000,
        },
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
    assert.equal(outcomeLabel('blocked'), '封禁');
    assert.equal(outcomeLabel('timeout'), '超时');
    assert.equal(outcomeLabel('network_error'), '网络错误');
    assert.equal(outcomeLabel('invalid_feedback'), '反馈无效');
    assert.equal(outcomeLabel('other'), '未知');

    assert.equal(mapEventTypeToChinese('promotion'), '晋升');
    assert.equal(mapEventTypeToChinese('demotion'), '降级');
    assert.equal(mapEventTypeToChinese('retirement'), '退伍');
    assert.equal(mapEventTypeToChinese('honor'), '授予荣誉');
    assert.equal(mapEventTypeToChinese('x'), '评分事件');

    assert.equal(pickValidationFailureOutcome({ reason: 'Timeout reached' }), 'timeout');
    assert.equal(pickValidationFailureOutcome({ reason: 'blocked by target' }), 'blocked');
    assert.equal(pickValidationFailureOutcome({ reason: 'ECONNRESET' }), 'network_error');
    assert.equal(pickValidationFailureOutcome(), 'network_error');

    assert.deepEqual(buildBattleCounterUpdates({ battle_success_count: 1, battle_fail_count: 2 }, '2026-03-14T00:00:00.000Z', 'success'), {
        last_battle_checked_at: '2026-03-14T00:00:00.000Z',
        last_battle_outcome: 'success',
        battle_success_count: 2,
        battle_fail_count: 2,
    });
    assert.deepEqual(buildBattleCounterUpdates({ battle_success_count: 1, battle_fail_count: 2 }, '2026-03-14T00:00:00.000Z', 'blocked'), {
        last_battle_checked_at: '2026-03-14T00:00:00.000Z',
        last_battle_outcome: 'blocked',
        battle_success_count: 1,
        battle_fail_count: 3,
    });

    assert.deepEqual(readCandidateControl({}), {
        max: 0,
        gateOverride: false,
        sweepMs: 900000,
        staleHours: 24,
        staleMinSamples: 3,
        timeoutHours: 72,
        maxRetirePerCycle: 2000,
    });
    const gate = buildCandidateGateState({
        candidateControl: { max: 10, gateOverride: false },
    }, 12);
    assert.equal(gate.gateActive, true);
    const gateOverride = buildCandidateGateState({
        candidateControl: { max: 10, gateOverride: true },
    }, 12);
    assert.equal(gateOverride.gateActive, false);

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

test('persistSnapshot should return early when engine not started', () => {
    const h = createDbHandle();
    const logger = createLogger();
    let getStatusCalls = 0;
    const workerPool = {
        async runTask() {
            return { ok: true };
        },
        getStatus() {
            getStatusCalls += 1;
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

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger });
    engine.persistSnapshot();

    assert.equal(getStatusCalls, 0);
    assert.equal(h.db.getLatestSnapshot(), null);
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

    assert.equal(timers.length, 4);
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
    assert.equal(proxies[0].success_count >= 1, true);
    assert.equal(proxies[0].total_samples >= 1, true);
    assert.equal(logger.entries.some((e) => e.event === '抓源成功'), true);
    assert.equal(logger.entries.some((e) => e.event === '校验通过'), true);
    assert.equal(logger.entries.some((e) => e.stage === '评分(L0回退)' && e.result === '成功'), true);

    cleanupDb(h);
});

test('runSourceCycle should gate candidate inflow and support override switch', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    const nowIso = '2026-03-14T01:00:00.000Z';
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.10', port: 8080, protocol: 'http' }],
        () => '闸门-存量-10',
        'seed',
        'seed-batch',
        nowIso,
    );

    h.config.candidateControl.max = 1;
    h.config.candidateControl.gateOverride = false;
    const workerPool = {
        async runTask(type) {
            if (type === 'fetch-source') {
                return {
                    normalized: 2,
                    proxies: [
                        { ip: '10.0.0.10', port: 8080, protocol: 'http' },
                        { ip: '10.0.0.11', port: 8081, protocol: 'http' },
                    ],
                };
            }
            if (type === 'validate-proxy') {
                return { ok: true, reason: 'connect_ok', latencyMs: 10 };
            }
            return { ok: true };
        },
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

    const engine = new ProxyHubEngine({
        config: h.config,
        db: h.db,
        workerPool,
        logger,
        now: () => new Date('2026-03-14T01:30:00.000Z'),
    });
    engine.started = true;
    await engine.runSourceCycle();

    const gatedList = h.db.getProxyList({ limit: 10 });
    assert.equal(gatedList.length, 1);
    assert.equal(h.db.getEvents(20).some((item) => item.event_type === 'candidate_gate'), true);

    h.config.candidateControl.gateOverride = true;
    await engine.runSourceCycle();
    const overrideList = h.db.getProxyList({ limit: 10 });
    assert.equal(overrideList.length, 2);
    cleanupDb(h);
});

test('runCandidateSweepCycle should retire stale candidates with audit events', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    const nowIso = '2026-03-16T12:00:00.000Z';
    h.db.upsertSourceBatch(
        [
            { ip: '10.0.1.1', port: 8080, protocol: 'http' },
            { ip: '10.0.1.2', port: 8081, protocol: 'http' },
        ],
        (() => {
            let idx = 0;
            return () => `清库存-${++idx}`;
        })(),
        'src',
        'batch',
        nowIso,
    );
    const all = h.db.getProxyList({ limit: 10 });
    h.db.updateProxyById(all[0].id, {
        created_at: '2026-03-15T10:00:00.000Z',
        total_samples: 1,
        updated_at: nowIso,
    });
    h.db.updateProxyById(all[1].id, {
        created_at: '2026-03-12T10:00:00.000Z',
        total_samples: 10,
        updated_at: nowIso,
    });

    const workerPool = {
        async runTask() {
            return { ok: true };
        },
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

    const engine = new ProxyHubEngine({
        config: h.config,
        db: h.db,
        workerPool,
        logger,
        now: () => new Date(nowIso),
    });
    engine.started = true;

    await engine.runCandidateSweepCycle();
    const retirements = h.db.getRetirements(10);
    assert.equal(retirements.length >= 2, true);
    assert.equal(retirements.some((item) => item.retired_type === 'stale_candidate'), true);
    assert.equal(retirements.some((item) => item.retired_type === 'stale_timeout'), true);
    assert.equal(logger.entries.some((entry) => entry.stage === 'candidate-sweeper'), true);
    cleanupDb(h);
});

test('engine start should schedule battle timers when enabled', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    h.config.source.monosans.enabled = false;
    h.config.battle.enabled = true;

    const workerPool = {
        async runTask() {
            return { ok: true };
        },
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
    let l1Calls = 0;
    let l2Calls = 0;
    engine.runBattleL1Cycle = async () => {
        l1Calls += 1;
    };
    engine.runBattleL2Cycle = async () => {
        l2Calls += 1;
    };

    await engine.start();
    await engine.stop();

    global.setInterval = oldSetInterval;
    global.clearInterval = oldClearInterval;

    assert.equal(timers.length, 6);
    assert.equal(l1Calls >= 2, true);
    assert.equal(l2Calls >= 2, true);
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
    const latest = h.db.getProxyById(proxy.id);
    assert.equal(honors.length >= 1, true);
    assert.equal(retirements.length >= 1, true);
    assert.equal(events.some((e) => e.event_type === 'retirement'), true);
    assert.equal(latest.source, 'src');
    assert.equal(logger.entries.some((e) => e.event === '退伍'), true);
    assert.equal(logger.entries.some((e) => e.event === '授予荣誉'), true);

    cleanupDb(h);
});

test('processProxy success should fallback latency to zero when missing', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.55', port: 8081, protocol: 'http' }],
        () => '苍隼-回退-55',
        'src',
        'batch',
        new Date().toISOString(),
    );
    const proxy = h.db.getProxyList({ limit: 1 })[0];

    const workerPool = {
        async runTask(type) {
            if (type === 'validate-proxy') {
                return { ok: true, reason: 'connect_ok' };
            }
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 2, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };
    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger, now: () => new Date('2026-03-14T07:30:00.000Z') });
    await engine.processProxy(proxy, 'src');

    const latest = h.db.getProxyById(proxy.id);
    assert.equal(latest.success_count >= 1, true);
    assert.equal(logger.entries.some((e) => e.stage === '评分(L0回退)'), true);
    cleanupDb(h);
});

test('applyCombatOutcome should return early when proxy does not exist', async () => {
    const logger = createLogger();
    const config = createConfig(path.join(os.tmpdir(), 'proxyhub-engine-missing.db'));
    const db = {
        getProxyById() {
            return null;
        },
    };
    const workerPool = {
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };
    const engine = new ProxyHubEngine({ config, db, workerPool, logger, now: () => new Date('2026-03-14T06:00:00.000Z') });
    await engine.applyCombatOutcome({
        proxyId: 999,
        sourceName: 'src',
        outcome: 'success',
        latencyMs: 1,
        nowIso: '2026-03-14T06:00:00.000Z',
        stage: '评分',
    });
    assert.equal(logger.entries.length, 0);
});

test('runBattleL1Cycle should cover guard and error branches', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    h.config.battle.enabled = true;
    const now = new Date('2026-03-14T07:00:00.000Z').toISOString();
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.31', port: 8080, protocol: 'http' }],
        () => '战场-L1-31',
        'src',
        'batch',
        now,
    );
    const proxy = h.db.getProxyList({ limit: 1 })[0];
    h.db.updateProxyById(proxy.id, { lifecycle: 'active', updated_at: now });

    let mode = 'throw-message';
    const workerPool = {
        async runTask(type) {
            if (type === 'battle-l1') {
                if (mode === 'throw-message') {
                    throw new Error('battle-l1-boom');
                }
                if (mode === 'throw-null') {
                    throw null;
                }
                return {
                    stage: 'l1',
                    outcome: 'network_error',
                    // runs omitted intentionally to cover fallback branch
                };
            }
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 2, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger, now: () => new Date('2026-03-14T07:10:00.000Z') });
    engine.started = true;
    engine.isBattleL1Running = true;
    await engine.runBattleL1Cycle();
    engine.isBattleL1Running = false;

    await engine.runBattleL1Cycle();
    assert.equal(logger.entries.some((e) => e.event === '线程池告警' && e.stage === '战场测试L1' && e.reason === 'battle-l1-boom'), true);

    mode = 'throw-null';
    await engine.runBattleL1Cycle();
    assert.equal(logger.entries.some((e) => e.event === '线程池告警' && e.stage === '战场测试L1' && e.reason === 'battle-l1-error'), true);

    const oldGetById = h.db.getProxyById.bind(h.db);
    h.db.getProxyById = () => null;
    mode = 'no-runs';
    await engine.runBattleL1Cycle();
    h.db.getProxyById = oldGetById;

    cleanupDb(h);
});

test('runBattleL1Cycle should fallback to candidateQuota when l1LifecycleQuota is undefined', async () => {
    const logger = createLogger();
    const config = createConfig(path.join(os.tmpdir(), 'proxyhub-engine-l1quota.db'));
    config.battle.enabled = true;
    config.battle.maxBattleL1PerCycle = 10;
    config.battle.l1LifecycleQuota = undefined;
    config.battle.candidateQuota = 0.33;

    let receivedQuota = null;
    const db = {
        listProxiesForBattleL1(limit, quota) {
            receivedQuota = quota;
            return [];
        },
    };
    const workerPool = {
        async runTask() {
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 2, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    const engine = new ProxyHubEngine({ config, db, workerPool, logger, now: () => new Date() });
    engine.started = true;
    await engine.runBattleL1Cycle();

    assert.equal(receivedQuota, 0.33);
});

test('runBattleL2Cycle should process candidates and cover guard/error branches', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    h.config.battle.enabled = true;
    const now = new Date().toISOString();
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.41', port: 8080, protocol: 'http' }],
        () => '战场-L2-41',
        'src',
        'batch',
        now,
    );
    const proxy = h.db.getProxyList({ limit: 1 })[0];
    h.db.updateProxyById(proxy.id, { lifecycle: 'active', updated_at: now });
    h.db.insertBattleTestRun({
        timestamp: now,
        proxy_id: proxy.id,
        stage: 'l1',
        target: 'ipify',
        outcome: 'success',
        status_code: 200,
        latency_ms: 20,
        reason: 'ok',
        details: {},
    });

    let mode = 'success';
    const workerPool = {
        async runTask(type) {
            if (type === 'battle-l2') {
                if (mode === 'throw-message') {
                    throw new Error('battle-l2-boom');
                }
                if (mode === 'throw-null') {
                    throw null;
                }
                if (mode === 'no-runs') {
                    return {
                        stage: 'l2',
                        outcome: 'network_error',
                    };
                }
                return {
                    stage: 'l2',
                    outcome: 'success',
                    latencyMs: 18,
                    runs: [{ target: 'ly', outcome: 'success', statusCode: 200, latencyMs: 18, reason: 'ok', details: {} }],
                };
            }
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 2, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger, now: () => new Date() });

    engine.started = false;
    await engine.runBattleL2Cycle();

    engine.started = true;
    engine.isBattleL2Running = true;
    await engine.runBattleL2Cycle();
    engine.isBattleL2Running = false;

    await engine.runBattleL2Cycle();
    const runs = h.db.getBattleTestRuns(10);
    assert.equal(runs.some((r) => r.stage === 'l2'), true);

    mode = 'throw-message';
    await engine.runBattleL2Cycle();
    assert.equal(logger.entries.some((e) => e.event === '线程池告警' && e.stage === '战场测试L2' && e.reason === 'battle-l2-boom'), true);

    mode = 'throw-null';
    await engine.runBattleL2Cycle();
    assert.equal(logger.entries.some((e) => e.event === '线程池告警' && e.stage === '战场测试L2' && e.reason === 'battle-l2-error'), true);

    const oldGetById = h.db.getProxyById.bind(h.db);
    h.db.getProxyById = () => null;
    mode = 'no-runs';
    await engine.runBattleL2Cycle();
    h.db.getProxyById = oldGetById;

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

test('runStateReviewCycle should include empty event details fallback when rank result details are missing', async () => {
    const enginePath = require.resolve('./engine');
    const rankPath = require.resolve('./rank');
    const rankExports = require.cache[rankPath].exports;

    const h = createDbHandle();
    const logger = createLogger();
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.88', port: 8088, protocol: 'http' }],
        () => '雷霄-北辰-88',
        'src',
        'batch',
        new Date('2026-03-14T08:00:00.000Z').toISOString(),
    );

    try {
        require.cache[rankPath].exports = {
            ...rankExports,
            evaluateStateTransition() {
                return {
                    updates: {
                        lifecycle: 'reserve',
                        retired_type: null,
                        ip_value_score: 50,
                        ip_value_breakdown_json: '{}',
                        updated_at: '2026-03-14T08:00:00.000Z',
                    },
                    change: 'active_to_reserve',
                    eventDetails: null,
                };
            },
        };
        delete require.cache[enginePath];
        const { ProxyHubEngine: PatchedEngine } = require('./engine');

        const workerPool = {
            async runTask() {
                return { ok: true };
            },
            getStatus() {
                return { workersTotal: 2, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
            },
        };

        const engine = new PatchedEngine({
            config: h.config,
            db: h.db,
            workerPool,
            logger,
            now: () => new Date('2026-03-14T08:00:00.000Z'),
        });
        engine.started = true;
        await engine.runStateReviewCycle();

        const stateEvent = h.db.getEvents(20).find((item) => item.event_type === 'state_transition');
        assert.equal(Boolean(stateEvent), true);
        assert.deepEqual(JSON.parse(stateEvent.details_json), { change: 'active_to_reserve' });
    } finally {
        require.cache[rankPath].exports = rankExports;
        delete require.cache[enginePath];
        require('./engine');
        cleanupDb(h);
    }
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
    engine.started = true;

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

test('persistSnapshot should fallback snapshot error reason when thrown value has no message', () => {
    const logger = createLogger();
    const config = createConfig(path.join(os.tmpdir(), 'proxyhub-engine-snapshot-fallback.db'));
    const db = {
        getSourceDistribution() {
            throw null;
        },
    };
    const workerPool = {
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

    const engine = new ProxyHubEngine({ config, db, workerPool, logger });
    engine.started = true;
    engine.persistSnapshot();

    assert.equal(logger.entries.some((entry) => entry.event === '线程池告警' && entry.reason === 'snapshot-persist-error'), true);
});

test('persistSnapshot should not throw after db closed during shutdown race', () => {
    const h = createDbHandle();
    const logger = createLogger();
    const workerPool = {
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

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger, now: () => new Date('2026-03-14T03:00:00.000Z') });
    engine.started = true;
    h.db.close();

    assert.doesNotThrow(() => engine.persistSnapshot());
    assert.equal(logger.entries.some((e) => e.event === '线程池告警' && e.stage === '快照'), true);

    fs.rmSync(h.dir, { recursive: true, force: true });
});

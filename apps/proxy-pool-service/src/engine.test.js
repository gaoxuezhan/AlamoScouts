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
    readFailureBackoff,
    resolveFailureBackoff,
    resolveSourceFeeds,
    readBranchingConfig,
    resolveBranchingTransition,
    readNativeLookupConfig,
    isNativeRetryDue,
    normalizeNativeLookupStatus,
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
            l3: {
                enabled: true,
                syncMs: 2700000,
                maxPerCycle: 12,
                concurrency: 3,
                lookbackMinutes: 10,
                timeoutMs: 12000,
                allowedProtocols: ['http', 'https', 'socks5'],
                targets: [{ name: 'ly-browser', url: 'https://www.ly.com/flights/home' }],
            },
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
        failureBackoff: {
            enabled: true,
            l0BaseMs: 300000,
            l1BaseMs: 600000,
            l2BaseMs: 900000,
            multiplier: 2,
            maxMs: 3600000,
        },
        native: {
            enabled: false,
            timeoutMs: 3000,
            retryHours: 1,
            targetBranches: ['海军', '海豹突击队'],
        },
        validation: { allowedProtocols: ['http', 'https', 'socks4', 'socks5'], maxTimeoutMs: 1000 },
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

// 0041_waitFor_等待条件成立逻辑
async function waitFor(check, timeoutMs = 2000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (check()) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
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
    assert.deepEqual(readFailureBackoff({}), {
        enabled: true,
        l0BaseMs: 300000,
        l1BaseMs: 600000,
        l2BaseMs: 900000,
        multiplier: 1.8,
        maxMs: 21600000,
    });
    const branchPolicy = readBranchingConfig({});
    assert.equal(branchPolicy.enabled, true);
    assert.equal(branchPolicy.defaultBranch, '陆军');
    assert.equal(Array.isArray(branchPolicy.rules), true);
    assert.equal(branchPolicy.rules.length >= 4, true);
    assert.deepEqual(readNativeLookupConfig({}), {
        enabled: false,
        timeoutMs: 3000,
        retryHours: 1,
        targetBranches: ['海军', '海豹突击队'],
    });
    assert.deepEqual(readNativeLookupConfig({
        native: {
            enabled: true,
            timeoutMs: 1200,
            retryHours: 2,
            targetBranches: ['海军', '空军', '海军'],
        },
    }), {
        enabled: true,
        timeoutMs: 1200,
        retryHours: 2,
        targetBranches: ['海军', '空军'],
    });
    assert.deepEqual(readNativeLookupConfig({
        native: {
            enabled: true,
            targetBranches: [],
        },
    }).targetBranches, ['海军', '海豹突击队']);
    assert.equal(isNativeRetryDue(null, '2026-03-14T00:00:00.000Z'), true);
    assert.equal(isNativeRetryDue('2026-03-13T23:59:59.000Z', '2026-03-14T00:00:00.000Z'), true);
    assert.equal(isNativeRetryDue('2026-03-14T00:10:00.000Z', '2026-03-14T00:00:00.000Z'), false);
    assert.equal(isNativeRetryDue('bad-date', '2026-03-14T00:00:00.000Z'), true);
    assert.equal(normalizeNativeLookupStatus('resolved'), 'resolved');
    assert.equal(normalizeNativeLookupStatus('bad-value'), 'pending');
    assert.equal(normalizeNativeLookupStatus(null), 'pending');
    const disabledPolicy = readBranchingConfig({ branching: { enabled: false } });
    assert.equal(disabledPolicy.enabled, false);
    const normalizedPolicy = readBranchingConfig({
        branching: {
            rules: [{
                id: 'norm',
                stage: 'l9',
                outcomes: [],
                from: [],
                failStreakOp: 'bad-op',
                fallbackAt: 'bad',
                failStreakValue: 'bad',
            }],
        },
    });
    assert.equal(normalizedPolicy.rules[0].failStreakOp, 'none');
    assert.equal(normalizedPolicy.rules[0].fallbackAt, null);
    assert.equal(normalizedPolicy.rules[0].failStreakValue, 0);
    const generatedIdPolicy = readBranchingConfig({
        branching: {
            rules: [{
                stage: 'l2',
                outcomes: ['success'],
                from: ['陆军'],
            }],
        },
    });
    assert.equal(generatedIdPolicy.rules[0].id, 'branch_rule_1');
    const stringRulePolicy = readBranchingConfig({
        branching: {
            rules: [{
                id: 'string-rule',
                stages: 'l2',
                outcomes: 'success',
                from: '陆军',
            }],
        },
    });
    assert.deepEqual(stringRulePolicy.rules[0].stages, ['*']);
    assert.deepEqual(stringRulePolicy.rules[0].outcomes, ['*']);
    assert.deepEqual(stringRulePolicy.rules[0].from, ['*']);
    const branchPromote = resolveBranchingTransition({
        proxy: { service_branch: '陆军', branch_fail_streak: 0 },
        stage: 'l2',
        outcome: 'success',
        config: {},
    });
    assert.equal(branchPromote.updates.service_branch, '海军');
    assert.equal(branchPromote.updates.branch_fail_streak, undefined);
    assert.equal(branchPromote.events[0].event_type, 'branch_transfer');
    const branchDisabled = resolveBranchingTransition({
        proxy: { service_branch: '陆军', branch_fail_streak: 0 },
        stage: 'l2',
        outcome: 'success',
        config: { branching: { enabled: false } },
    });
    assert.deepEqual(branchDisabled, { updates: {}, events: [] });
    const branchNoMatch = resolveBranchingTransition({
        proxy: { service_branch: '陆军', branch_fail_streak: 0 },
        stage: 'l9',
        outcome: 'blocked',
        config: {},
    });
    assert.deepEqual(branchNoMatch, { updates: {}, events: [] });
    const branchSet = resolveBranchingTransition({
        proxy: { service_branch: '空军', branch_fail_streak: 1 },
        stage: 'l9',
        outcome: 'success',
        config: {
            branching: {
                rules: [{
                    id: 'set-streak',
                    stage: 'l9',
                    outcomes: ['success'],
                    from: ['空军'],
                    failStreakOp: 'set',
                    failStreakValue: 4,
                }],
            },
        },
    });
    assert.equal(branchSet.updates.branch_fail_streak, 4);
    assert.equal(branchSet.events[0].event_type, 'branch_streak');
    const branchNoop = resolveBranchingTransition({
        proxy: { service_branch: '空军', branch_fail_streak: 4 },
        stage: 'l9',
        outcome: 'success',
        config: {
            branching: {
                rules: [{
                    id: 'set-streak-noop',
                    stage: 'l9',
                    outcomes: ['success'],
                    from: ['空军'],
                    failStreakOp: 'set',
                    failStreakValue: 4,
                }],
            },
        },
    });
    assert.deepEqual(branchNoop, { updates: {}, events: [] });
    const branchResetOnly = resolveBranchingTransition({
        proxy: { service_branch: '海军', branch_fail_streak: 2 },
        stage: 'l2',
        outcome: 'success',
        config: {},
    });
    assert.equal(branchResetOnly.updates.branch_fail_streak, 0);
    assert.equal(branchResetOnly.events[0].event_type, 'branch_streak_reset');
    assert.equal(branchResetOnly.events[0].message.includes('编制计数清零'), true);
    const branchFallbackDefault = resolveBranchingTransition({
        proxy: { service_branch: '海军', branch_fail_streak: 0 },
        stage: 'l9',
        outcome: 'blocked',
        config: {
            branching: {
                defaultBranch: '预备役',
                rules: [{
                    id: 'fallback-default',
                    stage: 'l9',
                    outcomes: ['blocked'],
                    from: ['海军'],
                    failStreakOp: 'increment',
                    fallbackAt: 1,
                }],
            },
        },
    });
    assert.equal(branchFallbackDefault.updates.service_branch, '预备役');
    assert.equal(branchFallbackDefault.events[0].event_type, 'branch_fallback');
    const branchEmptyInputs = resolveBranchingTransition({
        proxy: { service_branch: '', branch_fail_streak: 0 },
        stage: '',
        outcome: '',
        config: {
            branching: {
                defaultBranch: '陆军',
                rules: [{
                    id: 'empty-inputs',
                    stages: ['*'],
                    outcomes: ['*'],
                    from: ['陆军'],
                    to: '海军',
                }],
            },
        },
    });
    assert.equal(branchEmptyInputs.updates.service_branch, '海军');
    assert.deepEqual(resolveSourceFeeds(), []);
    assert.deepEqual(resolveSourceFeeds({ source: {} }), []);
    assert.equal(resolveSourceFeeds({
        source: {
            activeFeeds: [
                { name: 'feed1', url: 'https://example.com/1', enabled: true, sourceFormat: 'line', defaultProtocol: 'socks5' },
                { name: 'feed2', url: 'https://example.com/2', enabled: false },
            ],
        },
    }).length, 1);
    assert.equal(resolveSourceFeeds({
        source: {
            monosans: { name: 'legacy', url: 'https://example.com/legacy', enabled: true },
        },
    }).length, 1);
    assert.equal(resolveSourceFeeds({
        source: {
            monosans: { url: 'https://example.com/legacy-default-name', enabled: true },
        },
    })[0].name, 'monosans/proxy-list');
    const fallbackFeed = resolveSourceFeeds({
        source: {
            activeFeeds: [
                { url: 'https://example.com/fallback-feed' },
            ],
        },
    })[0];
    assert.equal(fallbackFeed.name, 'unknown-source');
    assert.equal(fallbackFeed.url, 'https://example.com/fallback-feed');
    assert.equal(fallbackFeed.sourceFormat, 'auto');
    assert.equal(fallbackFeed.defaultProtocol, 'http');
    const backoff = resolveFailureBackoff({
        config: {
            failureBackoff: {
                enabled: true,
                l0BaseMs: 1000,
                l1BaseMs: 2000,
                l2BaseMs: 3000,
                multiplier: 2,
                maxMs: 10000,
            },
        },
        proxy: { consecutive_fail: 3 },
        nowIso: '2026-03-14T00:00:00.000Z',
        outcome: 'network_error',
        stage: 'l1',
    });
    assert.equal(backoff.shouldBackoff, true);
    assert.equal(backoff.delayMs, 60000);
    assert.equal(backoff.untilIso, '2026-03-14T00:01:00.000Z');
    const nowBefore = Date.now;
    Date.now = () => Date.parse('2026-03-14T00:02:00.000Z');
    const backoffBadNow = resolveFailureBackoff({
        config: {
            failureBackoff: {
                enabled: true,
                l0BaseMs: 60000,
                multiplier: 2,
                maxMs: 60000,
            },
        },
        proxy: { consecutive_fail: 2 },
        nowIso: 'bad-now',
        outcome: 'timeout',
        stage: 'l0',
    });
    Date.now = nowBefore;
    assert.equal(backoffBadNow.untilIso, '2026-03-14T00:03:00.000Z');
    assert.equal(resolveFailureBackoff({ outcome: 'success' }).shouldBackoff, false);

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
    h.config.storage.snapshotRetentionDays = 0;
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

test('runValidationCycle should use proxy source first and fallback to sourceName', async () => {
    const config = createConfig(path.join(os.tmpdir(), 'proxyhub-engine-validation-source.db'));
    const logger = createLogger();
    const candidates = [
        { id: 1, source: 'proxy-source-a' },
        { id: 2 },
    ];
    const db = {
        listProxiesForValidation() {
            return candidates;
        },
    };
    const workerPool = {
        async runTask() {
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };
    const engine = new ProxyHubEngine({ config, db, workerPool, logger });
    const seenSources = [];
    engine.processProxy = async (proxy, source) => {
        seenSources.push(`${proxy.id}:${source}`);
    };

    await engine.runValidationCycle('fallback-source');

    assert.deepEqual(seenSources, [
        '1:proxy-source-a',
        '2:fallback-source',
    ]);
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

test('runSourceCycle should fetch multiple active feeds and validate once', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    h.config.source = {
        activeProfile: 'speedx_bundle',
        activeFeeds: [
            {
                name: 'TheSpeedX/http',
                url: 'https://example.com/http.txt',
                enabled: true,
                sourceFormat: 'line',
                defaultProtocol: 'http',
            },
            {
                name: 'TheSpeedX/socks4',
                url: 'https://example.com/socks4.txt',
                enabled: true,
                sourceFormat: 'line',
                defaultProtocol: 'socks4',
            },
            {
                name: 'TheSpeedX/socks5',
                url: 'https://example.com/socks5.txt',
                enabled: true,
                sourceFormat: 'line',
                defaultProtocol: 'socks5',
            },
        ],
    };

    let fetchCalls = 0;
    let validateCalls = 0;
    const workerPool = {
        async runTask(type, payload) {
            if (type === 'fetch-source') {
                fetchCalls += 1;
                if (payload.defaultProtocol === 'http') {
                    return {
                        fetched: 1,
                        normalized: 1,
                        proxies: [{ ip: '10.9.0.1', port: 8080, protocol: 'http' }],
                    };
                }
                if (payload.defaultProtocol === 'socks4') {
                    return {
                        fetched: 1,
                        normalized: 1,
                        proxies: [{ ip: '10.9.0.2', port: 1080, protocol: 'socks4' }],
                    };
                }
                return {
                    fetched: 1,
                    normalized: 1,
                    proxies: [{ ip: '10.9.0.3', port: 1080, protocol: 'socks5' }],
                };
            }
            if (type === 'validate-proxy') {
                validateCalls += 1;
                return { ok: true, reason: 'connect_ok', latencyMs: 12 };
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

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger, now: () => new Date('2026-03-14T01:10:00.000Z') });
    engine.started = true;

    await engine.runSourceCycle();

    const proxies = h.db.getProxyList({ limit: 20 });
    assert.equal(fetchCalls, 3);
    assert.equal(proxies.length, 3);
    assert.equal(validateCalls, 3);
    assert.equal(proxies.some((item) => item.protocol === 'socks4'), true);
    assert.equal(proxies.some((item) => item.source === 'TheSpeedX/http'), true);
    assert.equal(proxies.some((item) => item.source === 'TheSpeedX/socks4'), true);
    assert.equal(proxies.some((item) => item.source === 'TheSpeedX/socks5'), true);
    assert.equal(proxies.some((item) => item.source === 'speedx_bundle'), false);
    assert.equal(logger.entries.some((entry) => entry.event === '抓源成功' && entry.ipSource === 'TheSpeedX/socks4'), true);
    assert.equal(logger.entries.some((entry) => entry.event === '等待下一轮' && entry.ipSource === 'speedx_bundle'), true);

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

test('runCandidateSweepCycle should return early when not started or already running', async () => {
    const h = createDbHandle();
    const logger = createLogger();
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
    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger });

    await engine.runCandidateSweepCycle();
    engine.started = true;
    engine.isCandidateSweepRunning = true;
    await engine.runCandidateSweepCycle();
    assert.equal(logger.entries.length, 0);
    cleanupDb(h);
});

test('runCandidateSweepCycle should log error and fallback reason when sweep fails', async () => {
    const logger = createLogger();
    const config = createConfig(path.join(os.tmpdir(), 'proxyhub-engine-sweeper-err.db'));
    const workerPool = {
        async runTask() {
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    let mode = 'msg';
    const db = {
        listCandidatesForSweep() {
            if (mode === 'msg') throw new Error('sweep-boom');
            throw null;
        },
    };

    const engine = new ProxyHubEngine({ config, db, workerPool, logger, now: () => new Date('2026-03-16T12:00:00.000Z') });
    engine.started = true;
    await engine.runCandidateSweepCycle();
    mode = 'null';
    await engine.runCandidateSweepCycle();

    assert.equal(logger.entries.some((entry) => entry.stage === 'candidate-sweeper' && entry.reason === 'sweep-boom'), true);
    assert.equal(logger.entries.some((entry) => entry.stage === 'candidate-sweeper' && entry.reason === 'candidate-sweeper-error'), true);
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
    let l3Calls = 0;
    engine.runBattleL1Cycle = async () => {
        l1Calls += 1;
    };
    engine.runBattleL2Cycle = async () => {
        l2Calls += 1;
    };
    engine.runBattleL3Cycle = async () => {
        l3Calls += 1;
    };

    await engine.start();
    await engine.stop();

    global.setInterval = oldSetInterval;
    global.clearInterval = oldClearInterval;

    assert.equal(timers.length, 7);
    assert.equal(l1Calls >= 2, true);
    assert.equal(l2Calls >= 2, true);
    assert.equal(l3Calls >= 2, true);
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
    const refreshed = h.db.getProxyById(proxy.id);
    assert.equal(typeof refreshed.backoff_until, 'string');
    assert.equal(refreshed.backoff_reason, 'l0:network_error');

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

test('applyCombatOutcome should clear backoff on success when reason is present', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    const now = '2026-03-14T09:00:00.000Z';
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.51', port: 8080, protocol: 'http' }],
        () => '退避-清除-51',
        'src',
        'batch',
        now,
    );
    const proxy = h.db.getProxyList({ limit: 1 })[0];
    h.db.updateProxyById(proxy.id, {
        backoff_until: null,
        backoff_reason: 'l1:network_error',
        updated_at: now,
    });

    const workerPool = {
        async runTask() {
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger });
    await engine.applyCombatOutcome({
        proxyId: proxy.id,
        sourceName: 'src',
        outcome: 'success',
        latencyMs: 20,
        nowIso: now,
        stage: '评分(L0)',
        combatStage: 'l0',
    });

    const refreshed = h.db.getProxyById(proxy.id);
    assert.equal(refreshed.backoff_until, null);
    assert.equal(refreshed.backoff_reason, null);
    assert.equal(h.db.getEvents(20).some((item) => item.event_type === 'backoff_clear'), true);
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

test('applyCombatOutcome should resolve native place asynchronously for target branches', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    h.config.native.enabled = true;
    h.config.native.targetBranches = ['海军', '海豹突击队'];
    const nowIso = '2026-03-14T09:30:00.000Z';
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.131', port: 8080, protocol: 'http' }],
        () => '籍贯-成功-131',
        'src',
        'batch',
        nowIso,
    );
    const proxy = h.db.getProxyList({ limit: 1 })[0];

    const workerPool = {
        async runTask() {
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };
    const engine = new ProxyHubEngine({
        config: h.config,
        db: h.db,
        workerPool,
        logger,
        now: () => new Date(nowIso),
    });
    h.db.db.pragma('foreign_keys = OFF');
    engine.resolveNativePlaceByIp = async () => ({
        provider: 'ip-api',
        country: '中国',
        city: '北京',
        place: '中国-北京',
        rawJson: '{"status":"success","country":"中国","city":"北京"}',
    });

    await engine.applyCombatOutcome({
        proxyId: proxy.id,
        sourceName: 'battle-l2',
        outcome: 'success',
        latencyMs: 18,
        nowIso,
        stage: '评分(L2)',
        combatStage: 'l2',
    });

    const resolved = await waitFor(() => h.db.getProxyById(proxy.id)?.native_lookup_status === 'resolved');
    assert.equal(resolved, true);
    const updated = h.db.getProxyById(proxy.id);
    assert.equal(updated.service_branch, '海军');
    assert.equal(updated.native_place, '中国-北京');
    assert.equal(updated.native_provider, 'ip-api');
    assert.equal(updated.native_lookup_raw_json.includes('"country":"中国"'), true);
    assert.equal(h.db.getEvents(30).some((item) => item.event_type === 'native_lookup_resolved'), true);
    assert.equal(logger.entries.some((item) => item.event === '籍贯解析成功'), true);

    cleanupDb(h);
});

test('applyCombatOutcome should mark native lookup failed with retry and keep existing fields', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    h.config.native.enabled = true;
    h.config.native.retryHours = 1;
    const nowIso = '2026-03-14T09:40:00.000Z';
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.132', port: 8080, protocol: 'http' }],
        () => '籍贯-失败-132',
        'src',
        'batch',
        nowIso,
    );
    const proxy = h.db.getProxyList({ limit: 1 })[0];
    h.db.updateProxyById(proxy.id, {
        service_branch: '海军',
        native_place: '未知',
        native_country: '中国',
        native_city: '上海',
        native_lookup_status: 'pending',
        native_next_retry_at: null,
        updated_at: nowIso,
    });

    const workerPool = {
        async runTask() {
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };
    const engine = new ProxyHubEngine({
        config: h.config,
        db: h.db,
        workerPool,
        logger,
        now: () => new Date(nowIso),
    });
    engine.resolveNativePlaceByIp = async () => {
        throw new Error('ip-api-timeout');
    };

    await engine.applyCombatOutcome({
        proxyId: proxy.id,
        sourceName: 'battle-l2',
        outcome: 'network_error',
        latencyMs: 0,
        nowIso,
        stage: '评分(L2)',
        combatStage: 'l2',
    });

    const failed = await waitFor(() => h.db.getProxyById(proxy.id)?.native_lookup_status === 'failed');
    assert.equal(failed, true);
    const updated = h.db.getProxyById(proxy.id);
    assert.equal(updated.native_place, '未知');
    assert.equal(updated.native_country, '中国');
    assert.equal(updated.native_city, '上海');
    assert.equal(typeof updated.native_next_retry_at, 'string');
    assert.equal(Date.parse(updated.native_next_retry_at) > Date.parse(nowIso), true);
    assert.equal(h.db.getEvents(30).some((item) => item.event_type === 'native_lookup_failed'), true);
    assert.equal(logger.entries.some((item) => item.event === '籍贯解析失败' && item.reason === 'ip-api-timeout'), true);

    cleanupDb(h);
});

test('applyCombatOutcome should skip non-target branch and honor native retry window', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    h.config.native.enabled = true;
    h.config.native.targetBranches = ['海军'];
    const nowIso = '2026-03-14T09:50:00.000Z';
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.133', port: 8080, protocol: 'http' }],
        () => '籍贯-跳过-133',
        'src',
        'batch',
        nowIso,
    );
    const proxy = h.db.getProxyList({ limit: 1 })[0];

    const workerPool = {
        async runTask() {
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };
    let lookupCalls = 0;
    let currentNow = nowIso;
    const engine = new ProxyHubEngine({
        config: h.config,
        db: h.db,
        workerPool,
        logger,
        now: () => new Date(currentNow),
    });
    engine.resolveNativePlaceByIp = async () => {
        lookupCalls += 1;
        return {
            provider: 'ip-api',
            country: '中国',
            city: '广州',
            place: '中国-广州',
            rawJson: '{"status":"success","country":"中国","city":"广州"}',
        };
    };

    await engine.applyCombatOutcome({
        proxyId: proxy.id,
        sourceName: 'src',
        outcome: 'success',
        latencyMs: 10,
        nowIso,
        stage: '评分(L0)',
        combatStage: 'l0',
    });
    const skipped = await waitFor(() => h.db.getProxyById(proxy.id)?.native_lookup_status === 'skipped');
    assert.equal(skipped, true);
    assert.equal(lookupCalls, 0);

    h.db.updateProxyById(proxy.id, {
        service_branch: '海军',
        native_place: '未知',
        native_lookup_status: 'failed',
        native_next_retry_at: '2026-03-14T10:30:00.000Z',
        updated_at: nowIso,
    });
    currentNow = '2026-03-14T10:00:00.000Z';
    await engine.applyCombatOutcome({
        proxyId: proxy.id,
        sourceName: 'battle-l2',
        outcome: 'success',
        latencyMs: 12,
        nowIso: currentNow,
        stage: '评分(L2)',
        combatStage: 'l2',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(lookupCalls, 0);

    h.db.updateProxyById(proxy.id, {
        native_next_retry_at: '2026-03-14T09:00:00.000Z',
        updated_at: currentNow,
    });
    currentNow = '2026-03-14T10:40:00.000Z';
    await engine.applyCombatOutcome({
        proxyId: proxy.id,
        sourceName: 'battle-l2',
        outcome: 'success',
        latencyMs: 12,
        nowIso: currentNow,
        stage: '评分(L2)',
        combatStage: 'l2',
    });
    const resolved = await waitFor(() => h.db.getProxyById(proxy.id)?.native_lookup_status === 'resolved');
    assert.equal(resolved, true);
    assert.equal(lookupCalls, 1);
    assert.equal(h.db.getProxyById(proxy.id).native_place, '中国-广州');
    cleanupDb(h);
});

test('resolveNativePlaceByIp should cover unavailable/http/json/status/success branches', async () => {
    const logger = createLogger();
    const config = createConfig(path.join(os.tmpdir(), 'proxyhub-engine-native-resolve.db'));
    config.native.enabled = true;
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
    const engine = new ProxyHubEngine({ config, db, workerPool, logger });
    const oldFetch = global.fetch;
    const oldAbortSignal = global.AbortSignal;
    const oldJsonParse = JSON.parse;

    try {
        global.fetch = undefined;
        await assert.rejects(
            () => engine.resolveNativePlaceByIp('1.1.1.1', 800),
            /ip-api-fetch-unavailable/,
        );

        global.fetch = async () => ({
            ok: true,
            status: 200,
            async text() {
                return '{"status":"success"}';
            },
        });
        await assert.rejects(
            () => engine.resolveNativePlaceByIp('', 800),
            /ip-api-ip-missing/,
        );

        global.AbortSignal = undefined;
        global.fetch = async () => ({
            ok: false,
            status: 500,
            async text() {
                return '';
            },
        });
        await assert.rejects(
            () => engine.resolveNativePlaceByIp('2.2.2.2', 900),
            /ip-api-http-500/,
        );

        global.AbortSignal = oldAbortSignal;
        global.fetch = async () => ({
            ok: true,
            status: 200,
            async text() {
                return '{bad-json';
            },
        });
        await assert.rejects(
            () => engine.resolveNativePlaceByIp('3.3.3.3', 900),
            /ip-api-invalid-json/,
        );

        global.fetch = async () => ({
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({ status: 'fail', message: 'quota' });
            },
        });
        await assert.rejects(
            () => engine.resolveNativePlaceByIp('4.4.4.4', 900),
            /ip-api-quota/,
        );

        global.fetch = async () => ({
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({ country: '美国', city: '纽约' });
            },
        });
        await assert.rejects(
            () => engine.resolveNativePlaceByIp('4.4.4.5', 900),
            /ip-api-request-failed/,
        );

        global.fetch = async () => ({
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({ status: 'success', country: '日本', city: '' });
            },
        });
        const resolved = await engine.resolveNativePlaceByIp('5.5.5.5', 900);
        assert.equal(resolved.provider, 'ip-api');
        assert.equal(resolved.place, '日本-未知');

        global.fetch = async () => ({
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({ status: 'success', country: '', city: '首尔' });
            },
        });
        const fallbackCountry = await engine.resolveNativePlaceByIp('5.5.5.6', 0);
        assert.equal(fallbackCountry.place, '未知-首尔');

        JSON.parse = (raw) => {
            if (raw === '') {
                return { status: 'success', country: '中国', city: '厦门' };
            }
            return oldJsonParse(raw);
        };
        global.fetch = async () => ({
            ok: true,
            status: 200,
            async text() {
                return '';
            },
        });
        const fallbackRawJson = await engine.resolveNativePlaceByIp('5.5.5.7', 900);
        assert.equal(fallbackRawJson.place, '中国-厦门');
        assert.equal(fallbackRawJson.rawJson, JSON.stringify({ status: 'success', country: '中国', city: '厦门' }));
    } finally {
        global.fetch = oldFetch;
        global.AbortSignal = oldAbortSignal;
        JSON.parse = oldJsonParse;
    }
});

test('native lookup decision/task/schedule helpers should cover edge branches', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    h.config.native.enabled = true;
    h.config.native.targetBranches = ['海军'];
    const nowIso = '2026-03-14T11:20:00.000Z';
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.134', port: 8080, protocol: 'http' }],
        () => '籍贯-边界-134',
        'src',
        'batch',
        nowIso,
    );
    const proxy = h.db.getProxyList({ limit: 1 })[0];

    const workerPool = {
        async runTask() {
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };
    const engine = new ProxyHubEngine({
        config: h.config,
        db: h.db,
        workerPool,
        logger,
        now: () => new Date(nowIso),
    });

    const missingDecision = engine.resolveNativeLookupDecision(null, nowIso);
    assert.equal(missingDecision.action, 'none');
    assert.equal(missingDecision.reason, 'proxy-missing');

    h.db.updateProxyById(proxy.id, {
        native_lookup_status: 'skipped',
        updated_at: nowIso,
    });
    const nonTargetDecision = engine.resolveNativeLookupDecision(h.db.getProxyById(proxy.id), nowIso);
    assert.equal(nonTargetDecision.action, 'none');
    assert.equal(nonTargetDecision.reason, 'branch-not-target');
    const missingBranchDecision = engine.resolveNativeLookupDecision({
        id: proxy.id,
        service_branch: null,
        native_place: '未知',
        native_lookup_status: null,
        native_next_retry_at: null,
    }, nowIso);
    assert.equal(missingBranchDecision.action, 'skip');
    assert.equal(missingBranchDecision.reason, 'branch-not-target');

    h.db.updateProxyById(proxy.id, {
        service_branch: '海军',
        native_place: '中国-上海',
        updated_at: nowIso,
    });
    const knownDecision = engine.resolveNativeLookupDecision(h.db.getProxyById(proxy.id), nowIso);
    assert.equal(knownDecision.action, 'none');
    assert.equal(knownDecision.reason, 'native-already-known');
    const emptyNativePlaceDecision = engine.resolveNativeLookupDecision({
        id: proxy.id,
        service_branch: '海军',
        native_place: '',
        native_lookup_status: 'pending',
        native_next_retry_at: null,
    }, nowIso);
    assert.equal(emptyNativePlaceDecision.action, 'lookup');
    assert.equal(emptyNativePlaceDecision.reason, 'eligible');

    await engine.runNativeLookupTask(99999, 'src');

    h.db.updateProxyById(proxy.id, {
        service_branch: '陆军',
        native_place: '未知',
        native_lookup_status: 'pending',
        native_next_retry_at: null,
        updated_at: nowIso,
    });
    await engine.runNativeLookupTask(proxy.id, 'src');
    assert.equal(h.db.getProxyById(proxy.id).native_lookup_status, 'skipped');

    h.db.updateProxyById(proxy.id, {
        service_branch: '海军',
        native_place: '未知',
        native_lookup_status: 'failed',
        native_next_retry_at: '2099-01-01T00:00:00.000Z',
        updated_at: nowIso,
    });
    await engine.runNativeLookupTask(proxy.id, 'src');
    assert.equal(h.db.getProxyById(proxy.id).native_lookup_status, 'failed');

    h.db.updateProxyById(proxy.id, {
        service_branch: '海军',
        native_place: '未知',
        native_lookup_status: 'pending',
        native_next_retry_at: null,
        updated_at: nowIso,
    });
    engine.resolveNativePlaceByIp = async () => {
        h.db.updateProxyById(proxy.id, {
            native_place: '中国-深圳',
            updated_at: nowIso,
        });
        return {
            provider: 'ip-api',
            country: '中国',
            city: '广州',
            place: '中国-广州',
            rawJson: '{"status":"success"}',
        };
    };
    await engine.runNativeLookupTask(proxy.id, 'src');
    assert.equal(h.db.getProxyById(proxy.id).native_place, '中国-深圳');

    h.db.updateProxyById(proxy.id, {
        service_branch: '海军',
        native_place: '未知',
        native_lookup_status: 'pending',
        native_next_retry_at: null,
        updated_at: nowIso,
    });
    engine.resolveNativePlaceByIp = async () => {
        h.db.updateProxyById(proxy.id, {
            native_place: '中国-杭州',
            updated_at: nowIso,
        });
        throw new Error('ip-api-recheck-fail');
    };
    await engine.runNativeLookupTask(proxy.id, 'src');
    assert.equal(h.db.getProxyById(proxy.id).native_lookup_status, 'pending');

    h.db.updateProxyById(proxy.id, {
        service_branch: '海军',
        native_place: '未知',
        native_lookup_status: 'pending',
        native_next_retry_at: null,
        updated_at: nowIso,
    });
    engine.nativeLookupInFlight.add(proxy.id);
    engine.scheduleNativeLookup(h.db.getProxyById(proxy.id), 'src', nowIso);
    assert.equal(engine.nativeLookupInFlight.has(proxy.id), true);
    engine.nativeLookupInFlight.delete(proxy.id);

    engine.runNativeLookupTask = async () => {
        throw new Error('native-lookup-task-failed');
    };
    engine.scheduleNativeLookup(h.db.getProxyById(proxy.id), 'src', nowIso);
    const logged = await waitFor(() => logger.entries.some((item) => item.reason === 'native-lookup-task-failed'));
    assert.equal(logged, true);

    const originalGetProxyById = h.db.getProxyById.bind(h.db);
    h.db.getProxyById = () => null;
    engine.markNativeLookupSkipped({
        id: proxy.id,
        display_name: '籍贯-跳过-兜底',
        ip: '10.0.0.134',
        service_branch: '陆军',
    }, 'src', nowIso, 'branch-not-target');
    h.db.getProxyById = originalGetProxyById;
    assert.equal(logger.entries.some((item) => item.event === '籍贯解析跳过' && item.proxyName === '籍贯-跳过-兜底'), true);

    cleanupDb(h);
});

test('native lookup should fallback to cached proxy when db row disappears and default error reason', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    h.config.native.enabled = true;
    h.config.native.targetBranches = ['海军'];
    const nowIso = '2026-03-14T11:40:00.000Z';
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.135', port: 8080, protocol: 'http' }],
        () => '籍贯-并发删除-135',
        'src',
        'batch',
        nowIso,
    );
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.136', port: 8080, protocol: 'http' }],
        () => '籍贯-并发删除-136',
        'src',
        'batch',
        nowIso,
    );
    const proxies = h.db.getProxyList({ limit: 5 });
    const proxySuccess = proxies.find((item) => item.ip === '10.0.0.135');
    const proxyFailure = proxies.find((item) => item.ip === '10.0.0.136');
    assert.ok(proxySuccess);
    assert.ok(proxyFailure);

    h.db.updateProxyById(proxySuccess.id, {
        service_branch: '海军',
        native_place: '未知',
        native_lookup_status: 'pending',
        native_next_retry_at: null,
        updated_at: nowIso,
    });
    h.db.updateProxyById(proxyFailure.id, {
        service_branch: '海军',
        native_place: '未知',
        native_lookup_status: 'pending',
        native_next_retry_at: null,
        updated_at: nowIso,
    });

    const workerPool = {
        async runTask() {
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };
    const engine = new ProxyHubEngine({
        config: h.config,
        db: h.db,
        workerPool,
        logger,
        now: () => new Date(nowIso),
    });
    const realGetProxyById = h.db.getProxyById.bind(h.db);
    let forceNullGetById = false;
    h.db.getProxyById = (id) => (forceNullGetById ? null : realGetProxyById(id));

    engine.resolveNativePlaceByIp = async (ip) => {
        if (ip === proxySuccess.ip) {
            forceNullGetById = true;
            return {
                provider: 'ip-api',
                country: '中国',
                city: '成都',
                place: '中国-成都',
                rawJson: '{"status":"success","country":"中国","city":"成都"}',
            };
        }
        throw new Error(`unexpected-ip-${ip}`);
    };
    await engine.runNativeLookupTask(proxySuccess.id, 'src');
    forceNullGetById = false;
    assert.equal(logger.entries.some((item) => item.event === '籍贯解析成功' && item.proxyName === proxySuccess.display_name), true);
    assert.equal(h.db.getEvents(30).some((item) => item.event_type === 'native_lookup_resolved'), true);

    engine.resolveNativeLookupDecision = () => ({
        action: 'lookup',
        reason: 'forced',
        policy: {
            enabled: true,
            timeoutMs: 800,
            retryHours: 0,
            targetBranches: ['海军'],
        },
    });
    engine.resolveNativePlaceByIp = async () => {
        forceNullGetById = true;
        throw null;
    };
    await engine.runNativeLookupTask(proxyFailure.id, 'src');
    forceNullGetById = false;
    assert.equal(logger.entries.some((item) => item.event === '籍贯解析失败' && item.proxyName === proxyFailure.display_name && item.reason === 'native-lookup-failed'), true);
    assert.equal(h.db.getEvents(30).some((item) => item.event_type === 'native_lookup_failed'), true);

    engine.runNativeLookupTask = async () => {
        throw null;
    };
    engine.scheduleNativeLookup({
        id: 778899,
        ip: '10.0.0.177',
        display_name: '籍贯-调度-回退-177',
        service_branch: '海军',
        native_place: '未知',
    }, 'src', nowIso);
    const fallbackLogged = await waitFor(() => logger.entries.some((item) => item.reason === 'native-lookup-task-failed'));
    assert.equal(fallbackLogged, true);
    h.db.getProxyById = realGetProxyById;

    cleanupDb(h);
});

test('resolveBranchingTransition should support custom rule extension', () => {
    const transition = resolveBranchingTransition({
        proxy: {
            service_branch: '空军',
            branch_fail_streak: 0,
        },
        stage: 'l9',
        outcome: 'success',
        config: {
            branching: {
                rules: [
                    {
                        id: 'custom-l9',
                        priority: 1,
                        stage: 'l9',
                        outcomes: ['success'],
                        from: ['空军'],
                        to: '天军',
                        failStreakOp: 'reset',
                    },
                ],
            },
        },
    });

    assert.equal(transition.updates.service_branch, '天军');
    assert.equal(transition.updates.branch_fail_streak, undefined);
    assert.equal(transition.events.length, 1);
    assert.equal(transition.events[0].event_type, 'branch_transition');
});

test('applyCombatOutcome should apply l2 branch transfer and fallback rules', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    const now = '2026-03-14T10:00:00.000Z';
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.91', port: 8080, protocol: 'http' }],
        () => '编制-流转-91',
        'src',
        'batch',
        now,
    );
    const proxy = h.db.getProxyList({ limit: 1 })[0];

    const workerPool = {
        async runTask() {
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };
    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger });

    await engine.applyCombatOutcome({
        proxyId: proxy.id,
        sourceName: 'battle-l2',
        outcome: 'success',
        latencyMs: 20,
        nowIso: '2026-03-14T10:00:00.000Z',
        stage: '评分(L2)',
        combatStage: 'l2',
    });
    const promoted = h.db.getProxyById(proxy.id);
    assert.equal(promoted.service_branch, '海军');
    assert.equal(promoted.branch_fail_streak, 0);

    await engine.applyCombatOutcome({
        proxyId: proxy.id,
        sourceName: 'battle-l2',
        outcome: 'network_error',
        latencyMs: 0,
        nowIso: '2026-03-14T10:10:00.000Z',
        stage: '评分(L2)',
        combatStage: 'l2',
    });
    await engine.applyCombatOutcome({
        proxyId: proxy.id,
        sourceName: 'battle-l2',
        outcome: 'network_error',
        latencyMs: 0,
        nowIso: '2026-03-14T10:20:00.000Z',
        stage: '评分(L2)',
        combatStage: 'l2',
    });
    const beforeFallback = h.db.getProxyById(proxy.id);
    assert.equal(beforeFallback.service_branch, '海军');
    assert.equal(beforeFallback.branch_fail_streak, 2);

    await engine.applyCombatOutcome({
        proxyId: proxy.id,
        sourceName: 'battle-l2',
        outcome: 'network_error',
        latencyMs: 0,
        nowIso: '2026-03-14T10:30:00.000Z',
        stage: '评分(L2)',
        combatStage: 'l2',
    });
    const fallenBack = h.db.getProxyById(proxy.id);
    assert.equal(fallenBack.service_branch, '陆军');
    assert.equal(fallenBack.branch_fail_streak, 0);
    assert.equal(h.db.getEvents(50).some((item) => item.event_type === 'branch_fallback'), true);
    assert.equal(logger.entries.some((item) => item.event === '编制流转'), true);

    cleanupDb(h);
});

test('applyCombatOutcome should score L3 with L2 weight while applying L3 branch transition', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    const now = '2026-03-14T11:00:00.000Z';
    h.config.policy.scoring.stageMultipliers = {
        score: { l1: 1, l2: 2 },
        health: { l1: 1, l2: 1 },
    };
    h.config.rollout = {
        features: {
            stageWeighting: true,
            lifecycleHysteresis: false,
            honorPromotionTuning: false,
        },
    };
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.92', port: 8080, protocol: 'http' }],
        () => '编制-L3-92',
        'src',
        'batch',
        now,
    );
    const proxy = h.db.getProxyList({ limit: 1 })[0];

    const workerPool = {
        async runTask() {
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };
    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger });

    await engine.applyCombatOutcome({
        proxyId: proxy.id,
        sourceName: 'battle-l3-browser',
        outcome: 'success',
        latencyMs: 20,
        nowIso: '2026-03-14T11:00:00.000Z',
        stage: '评分(L3)',
        combatStage: 'l2',
        branchingStage: 'l3',
    });

    const updated = h.db.getProxyById(proxy.id);
    assert.equal(updated.combat_points, 12);
    assert.equal(updated.service_branch, '海豹突击队');
    assert.equal(h.db.getEvents(20).some((item) => item.event_type === 'branch_transfer'), true);
    cleanupDb(h);
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
    assert.equal(logger.entries.some((e) => e.event === '战场测试L1失败' && e.stage === '战场测试L1' && e.reason === 'battle-l1-boom'), true);

    mode = 'throw-null';
    await engine.runBattleL1Cycle();
    assert.equal(logger.entries.some((e) => e.event === '战场测试L1失败' && e.stage === '战场测试L1' && e.reason === 'battle-l1-task-error'), true);

    const oldGetById = h.db.getProxyById.bind(h.db);
    h.db.getProxyById = () => null;
    mode = 'throw-message';
    await engine.runBattleL1Cycle();
    mode = 'no-runs';
    h.db.getProxyById = oldGetById;
    await engine.runBattleL1Cycle();
    const oldGetById2 = h.db.getProxyById.bind(h.db);
    h.db.getProxyById = () => null;
    mode = 'no-runs';
    await engine.runBattleL1Cycle();
    h.db.getProxyById = oldGetById2;
    assert.equal(logger.entries.some((e) => e.event === '战场测试L1失败' && e.reason === 'battle-l1-boom'), true);
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

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger, now: () => new Date('2026-03-14T07:10:00.000Z') });

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
    assert.equal(logger.entries.some((e) => e.event === '战场测试L2失败' && e.stage === '战场测试L2' && e.reason === 'battle-l2-boom'), true);

    mode = 'throw-null';
    await engine.runBattleL2Cycle();
    assert.equal(logger.entries.some((e) => e.event === '战场测试L2失败' && e.stage === '战场测试L2' && e.reason === 'battle-l2-task-error'), true);

    const oldGetById = h.db.getProxyById.bind(h.db);
    h.db.getProxyById = () => null;
    mode = 'throw-message';
    await engine.runBattleL2Cycle();
    mode = 'no-runs';
    h.db.getProxyById = oldGetById;
    await engine.runBattleL2Cycle();
    const oldGetById2 = h.db.getProxyById.bind(h.db);
    h.db.getProxyById = () => null;
    mode = 'no-runs';
    await engine.runBattleL2Cycle();
    h.db.getProxyById = oldGetById2;
    assert.equal(logger.entries.some((e) => e.event === '战场测试L2失败' && e.reason === 'battle-l2-boom'), true);
    h.db.getProxyById = oldGetById;

    cleanupDb(h);
});

test('runBattleL2Cycle should return early when there are no candidates', async () => {
    const logger = createLogger();
    const config = createConfig(path.join(os.tmpdir(), 'proxyhub-engine-l2-empty.db'));
    config.battle.enabled = true;

    let runTaskCalls = 0;
    const db = {
        listProxiesForBattleL2() {
            return [];
        },
    };
    const workerPool = {
        async runTask() {
            runTaskCalls += 1;
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 2, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    const engine = new ProxyHubEngine({ config, db, workerPool, logger });
    engine.started = true;

    await engine.runBattleL2Cycle();
    assert.equal(runTaskCalls, 0);
    assert.equal(engine.isBattleL2Running, false);
});

test('runBattleL3Cycle should process candidates and cover guard/error branches', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    h.config.battle.enabled = true;
    h.config.battle.l3.enabled = true;
    const now = new Date().toISOString();
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.51', port: 8080, protocol: 'http' }],
        () => '战场-L3-51',
        'src',
        'batch',
        now,
    );
    const proxy = h.db.getProxyList({ limit: 1 })[0];
    h.db.updateProxyById(proxy.id, { lifecycle: 'active', updated_at: now });
    h.db.insertBattleTestRun({
        timestamp: now,
        proxy_id: proxy.id,
        stage: 'l2',
        target: 'ly',
        outcome: 'success',
        status_code: 200,
        latency_ms: 20,
        reason: 'ok',
        details: {},
    });

    let mode = 'success';
    const workerPool = {
        async runTask(type) {
            if (type === 'battle-l3-browser') {
                if (mode === 'throw-message') {
                    throw new Error('battle-l3-boom');
                }
                if (mode === 'throw-null') {
                    throw null;
                }
                if (mode === 'no-runs') {
                    return {
                        stage: 'l3',
                        outcome: 'network_error',
                    };
                }
                return {
                    stage: 'l3',
                    outcome: 'success',
                    latencyMs: 21,
                    runs: [{ target: 'ly-browser', outcome: 'success', statusCode: 200, latencyMs: 21, reason: 'browser_ok', details: {} }],
                };
            }
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 2, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    const engine = new ProxyHubEngine({ config: h.config, db: h.db, workerPool, logger, now: () => new Date('2026-03-14T07:30:00.000Z') });

    engine.started = false;
    await engine.runBattleL3Cycle();

    engine.started = true;
    engine.isBattleL3Running = true;
    await engine.runBattleL3Cycle();
    engine.isBattleL3Running = false;

    await engine.runBattleL3Cycle();
    const runs = h.db.getBattleTestRuns(10);
    assert.equal(runs.some((run) => run.stage === 'l3'), true);

    mode = 'throw-message';
    await engine.runBattleL3Cycle();
    assert.equal(logger.entries.some((entry) => entry.event === '战场测试L3失败' && entry.stage === '战场测试L3' && entry.reason === 'battle-l3-boom'), true);

    mode = 'throw-null';
    await engine.runBattleL3Cycle();
    assert.equal(logger.entries.some((entry) => entry.event === '战场测试L3失败' && entry.stage === '战场测试L3' && entry.reason === 'battle-l3-task-error'), true);

    const oldGetById = h.db.getProxyById.bind(h.db);
    h.db.getProxyById = () => null;
    mode = 'throw-message';
    await engine.runBattleL3Cycle();
    mode = 'no-runs';
    h.db.getProxyById = oldGetById;
    await engine.runBattleL3Cycle();
    h.db.getProxyById = () => null;
    await engine.runBattleL3Cycle();
    h.db.getProxyById = oldGetById;
    assert.equal(logger.entries.some((entry) => entry.event === '战场测试L3失败' && entry.reason === 'battle-l3-boom'), true);

    cleanupDb(h);
});

test('runBattleL3Cycle should return early when disabled or there are no candidates', async () => {
    const logger = createLogger();
    const config = createConfig(path.join(os.tmpdir(), 'proxyhub-engine-l3-empty.db'));
    config.battle.enabled = true;

    let runTaskCalls = 0;
    const db = {
        listProxiesForBattleL3() {
            return [];
        },
    };
    const workerPool = {
        async runTask() {
            runTaskCalls += 1;
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 2, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    const engine = new ProxyHubEngine({ config, db, workerPool, logger });
    engine.started = true;
    config.battle.l3.enabled = false;
    await engine.runBattleL3Cycle();
    config.battle.l3.enabled = true;
    await engine.runBattleL3Cycle();

    assert.equal(runTaskCalls, 0);
    assert.equal(engine.isBattleL3Running, false);
});

test('runBattleL3Cycle should fallback l3 config object and concurrency defaults', async () => {
    const logger = createLogger();
    const config = createConfig(path.join(os.tmpdir(), 'proxyhub-engine-l3-fallback.db'));
    config.battle.enabled = true;
    config.battle.l3 = undefined;

    let runTaskCalls = 0;
    const db = {
        listProxiesForBattleL3() {
            return [{ id: 1, ip: '10.0.0.1', port: 8080, protocol: 'http', display_name: 'L3-兜底-1' }];
        },
        getProxyById() {
            return { id: 1, battle_success_count: 0, battle_fail_count: 0 };
        },
        insertBattleTestRun() {},
    };
    const workerPool = {
        async runTask(type, payload) {
            assert.equal(type, 'battle-l3-browser');
            assert.equal(payload.timeoutMs, undefined);
            runTaskCalls += 1;
            return {
                stage: 'l3',
                outcome: 'success',
                latencyMs: 12,
                runs: [],
            };
        },
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };

    const engine = new ProxyHubEngine({ config, db, workerPool, logger, now: () => new Date('2026-03-14T08:00:00.000Z') });
    engine.started = true;
    engine.isBattleL3Enabled = () => true;
    engine.applyCombatOutcome = async () => {};

    await engine.runBattleL3Cycle();

    assert.equal(runTaskCalls, 1);
    assert.equal(engine.isBattleL3Running, false);
});

test('runBattle cycles should log outer-catch fallback reason when candidate listing throws', async () => {
    const logger = createLogger();
    const config = createConfig(path.join(os.tmpdir(), 'proxyhub-engine-battle-outer.db'));
    config.battle.enabled = true;

    let throwMode = 'null';
    const db = {
        listProxiesForBattleL1() {
            if (throwMode === 'null') {
                throw null;
            }
            throw new Error('battle-l1-list-fail');
        },
        listProxiesForBattleL2() {
            if (throwMode === 'null') {
                throw null;
            }
            throw new Error('battle-l2-list-fail');
        },
        listProxiesForBattleL3() {
            if (throwMode === 'null') {
                throw null;
            }
            throw new Error('battle-l3-list-fail');
        },
    };
    const workerPool = {
        async runTask() {
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };
    const engine = new ProxyHubEngine({ config, db, workerPool, logger });
    engine.started = true;

    await engine.runBattleL1Cycle();
    await engine.runBattleL2Cycle();
    await engine.runBattleL3Cycle();

    assert.equal(logger.entries.some((e) => e.event === '线程池告警' && e.stage === '战场测试L1' && e.reason === 'battle-l1-error'), true);
    assert.equal(logger.entries.some((e) => e.event === '线程池告警' && e.stage === '战场测试L2' && e.reason === 'battle-l2-error'), true);
    assert.equal(logger.entries.some((e) => e.event === '线程池告警' && e.stage === '战场测试L3' && e.reason === 'battle-l3-error'), true);

    throwMode = 'message';
    await engine.runBattleL1Cycle();
    await engine.runBattleL2Cycle();
    await engine.runBattleL3Cycle();
    assert.equal(logger.entries.some((e) => e.event === '线程池告警' && e.stage === '战场测试L1' && e.reason === 'battle-l1-list-fail'), true);
    assert.equal(logger.entries.some((e) => e.event === '线程池告警' && e.stage === '战场测试L2' && e.reason === 'battle-l2-list-fail'), true);
    assert.equal(logger.entries.some((e) => e.event === '线程池告警' && e.stage === '战场测试L3' && e.reason === 'battle-l3-list-fail'), true);
});

test('runSourceCycle should audit manual override gate branch', async () => {
    const h = createDbHandle();
    const logger = createLogger();
    h.db.upsertSourceBatch(
        [{ ip: '10.0.0.61', port: 8080, protocol: 'http' }],
        () => '闸门-override-61',
        'seed',
        'seed-batch',
        '2026-03-14T10:00:00.000Z',
    );
    h.config.candidateControl.max = 1;
    h.config.candidateControl.gateOverride = true;

    const workerPool = {
        async runTask(type) {
            if (type === 'fetch-source') {
                return {
                    normalized: 1,
                    proxies: [{ ip: '10.0.0.61', port: 8080, protocol: 'http' }],
                };
            }
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };
    const engine = new ProxyHubEngine({
        config: h.config,
        db: h.db,
        workerPool,
        logger,
        now: () => new Date('2026-03-14T10:10:00.000Z'),
    });
    engine.started = true;
    engine.runValidationCycle = async () => {};
    await engine.runSourceCycle();

    const gateEvent = h.db.getEvents(20).find((item) => item.event_type === 'candidate_gate');
    assert.equal(Boolean(gateEvent), true);
    assert.equal(String(gateEvent.message).includes('override'), true);
    const gateDetails = JSON.parse(gateEvent.details_json || '{}');
    assert.equal(Number(gateDetails.skipped), 0);
    cleanupDb(h);
});

test('runCandidateSweepCycle should use fallback reason and counters when candidate fields are missing', async () => {
    const config = createConfig(path.join(os.tmpdir(), 'proxyhub-engine-sweep-fallback.db'));
    const logger = createLogger();
    let pass = 0;
    const db = {
        listCandidatesForSweep() {
            pass += 1;
            if (pass === 1) {
                return [{ id: 1, display_name: '清库存-缺省-01' }];
            }
            return [{ id: 2, display_name: '清库存-超时-02', sweep_reason: 'stale_timeout' }];
        },
        updateProxyById() {},
        insertRetirement() {},
        insertProxyEvent() {},
    };
    const workerPool = {
        async runTask() {
            return { ok: true };
        },
        getStatus() {
            return { workersTotal: 1, workersBusy: 0, queueSize: 0, runningTasks: 0, completedTasks: 0, failedTasks: 0, restartedWorkers: 0, workers: [] };
        },
    };
    const engine = new ProxyHubEngine({
        config,
        db,
        workerPool,
        logger,
        now: () => new Date('2026-03-14T11:00:00.000Z'),
    });
    engine.started = true;
    await engine.runCandidateSweepCycle();
    await engine.runCandidateSweepCycle();
    assert.equal(logger.entries.some((entry) => entry.stage === 'candidate-sweeper' && String(entry.action).includes('stale_timeout=0')), true);
    assert.equal(logger.entries.some((entry) => entry.stage === 'candidate-sweeper' && String(entry.action).includes('stale_candidate=0')), true);
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

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { sendSse, normalizeLimit, createRuntime, runCli } = require('./server');

// 0099_createConfig_创建配置逻辑
function createConfig(port = 0) {
    return {
        service: { name: 'ProxyHub', port, host: '127.0.0.1', timezone: 'Asia/Shanghai', logRetention: 100 },
        threadPool: { workers: 2, taskTimeoutMs: 100 },
        scheduler: { sourceSyncMs: 1000, stateReviewMs: 1000, snapshotPersistMs: 1000, maxValidationPerCycle: 10 },
        battle: {
            enabled: true,
            l1SyncMs: 300000,
            l2SyncMs: 1800000,
            maxBattleL1PerCycle: 60,
            maxBattleL2PerCycle: 20,
            candidateQuota: 0.15,
            l1LifecycleQuota: { active: 0.55, reserve: 0.30, candidate: 0.15 },
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
        source: {
            activeProfile: 'speedx_bundle',
            activeFeeds: [
                { name: 'TheSpeedX/http', url: 'https://example.com/http.txt', enabled: true, defaultProtocol: 'http', sourceFormat: 'line' },
                { name: 'TheSpeedX/socks4', url: 'https://example.com/socks4.txt', enabled: false, defaultProtocol: 'socks4', sourceFormat: 'line' },
                { name: 'TheSpeedX/socks5', url: 'https://example.com/socks5.txt', enabled: false, defaultProtocol: 'socks5', sourceFormat: 'line' },
            ],
            monosans: { name: 'monosans', url: 'https://x', enabled: true },
        },
        candidateControl: {
            max: 3000,
            low: 800,
            refillStop: 1350,
            gateOverride: false,
            sweepMs: 900000,
            staleHours: 24,
            staleMinSamples: 3,
            timeoutHours: 72,
            maxRetirePerCycle: 2000,
        },
        validation: { allowedProtocols: ['http'], maxTimeoutMs: 1000 },
        rollout: {
            version: 'v2',
            activeProfile: 'production',
            features: {
                stageWeighting: true,
                lifecycleHysteresis: true,
                honorPromotionTuning: false,
            },
            orchestrator: {
                enabled: true,
                intervalMs: 900000,
                stableHours: 48,
                cooldownHours: 24,
                minL2Samples: 20,
                leaseTtlMs: 120000,
            },
            guardrails: {
                windowHours: 24,
                activeDropThreshold: 0.2,
                l2DropPpThreshold: 0.03,
                retiredDailyMultiplier: 2,
                retiredDailyMinAbs: 5,
                baseline: {
                    activeCount: 100,
                    l2SuccessRate: 0.7,
                },
            },
        },
        policy: {
            serviceHourScale: 3,
            promotionProtectHours: 6,
            ranks: [{ rank: '新兵', minHours: 0, minPoints: 0, minSamples: 0 }, { rank: '列兵', minHours: 1, minPoints: 1, minSamples: 1 }],
            scoring: { success: 6, successFastBonusLt1200: 0, successFastBonusLt2500: 0, blocked: -8, timeout: -6, networkError: -5, invalidFeedback: -10 },
            demotion: { regularWindowSize: 50, regularBlockedRatio: 0.45, regularMinSamples: 3, severeWindowMinutes: 60, severeMinSamples: 3, severeBlockedRatio: 0.7, healthThreshold: 45, lowHealthRetireThreshold: 20 },
            retirement: { disciplineThreshold: 40, disciplineInvalidCount: 2, technicalMinSamples: 6, technicalSuccessRatio: 0.1, battleDamageBlockedRatio: 0.6, honorMinServiceHours: 500, honorMinSuccess: 800 },
            honors: { steelStreak: 3, riskyWarrior: 3, thousandService: 10 },
            valueModel: {
                combatPointCap: 1200,
                honorActiveWeight: 30,
                honorHistoryWeight: 10,
                weights: { rank: 16, combat: 24, health: 16, discipline: 14, successRatio: 12, battleRatio: 10, honor: 8 },
                lifecycleScoreMap: { active: 100, reserve: 72, candidate: 58, retired: 8 },
            },
        },
        storage: { dbPath: 'unused.db', snapshotRetentionDays: 7 },
        ui: { refreshMs: 5000 },
        soak: { durationHours: 10, summaryIntervalMs: 3600000 },
    };
}

// 0100_createStubs_创建逻辑
function createStubs() {
    const loggerEvents = new EventEmitter();
    const poolEvents = new EventEmitter();
    const state = {
        dbClosed: false,
        poolClosed: false,
        engineStarted: false,
        engineStopped: false,
        engineStopCalls: 0,
        socks4CleanupCalls: 0,
        socks5CleanupCalls: 0,
        rolloutState: {
            id: 1,
            mode: 'SAFE',
            stable_since: '2026-03-16T00:00:00.000Z',
            cooldown_until: null,
            last_tick_at: null,
            last_error: null,
            lease_owner: null,
            lease_until: null,
            updated_at: '2026-03-16T00:00:00.000Z',
        },
        rolloutEvents: [],
    };

    const db = {
        getSourceDistribution: () => [{ source: 'monosans', count: 2 }],
        getLifecycleDistribution: () => [{ lifecycle: 'active', count: 1 }],
        getLatestSnapshot: () => ({ workers_total: 2 }),
        getProxyList: () => [{ id: 1 }],
        getEvents: () => [{ id: 2 }],
        getBattleTestRuns: () => [{ id: 6, stage: 'l1' }],
        getValueBoard: () => [{
            id: 7,
            ip_value_score: 88.8,
            service_branch: '陆军',
            native_place: '未知',
            native_lookup_raw_json: '',
            native_lookup_readable_text: '',
            l0_success_count: 9,
            l0_fail_count: 1,
            l1_success_count: 4,
            l1_fail_count: 2,
            l2_success_count: 3,
            l2_fail_count: 1,
            l3_success_count: 2,
            l3_fail_count: 1,
        }],
        getRankBoard: () => [{ rank: '新兵', count: 1 }],
        getServiceBranchDistribution: () => [{ service_branch: '陆军', count: 1 }],
        getRecruitCampBoard: () => [
            { lifecycle: 'active', label: '新兵连', count: 1 },
            { lifecycle: 'reserve', label: '医务室', count: 0 },
            { lifecycle: 'candidate', label: '预备队', count: 2 },
            { lifecycle: 'retired', label: '已退役', count: 0 },
        ],
        getHonors: () => [{ id: 3 }],
        getRetirements: () => [{ id: 4 }],
        getActiveCount: () => 60,
        getBattleSuccessRateSince: () => ({ stage: 'l2', total: 50, success: 30, successRate: 0.6 }),
        getRetirementsCountSince: () => 12,
        getRetirementDailyCounts: () => [
            { day: '2026-03-09', count: 1 },
            { day: '2026-03-10', count: 2 },
            { day: '2026-03-11', count: 3 },
            { day: '2026-03-12', count: 2 },
            { day: '2026-03-13', count: 3 },
            { day: '2026-03-14', count: 4 },
            { day: '2026-03-15', count: 2 },
        ],
        getRolloutSwitchState: () => ({ ...state.rolloutState }),
        acquireRolloutSwitchLease: ({ owner, nowIso }) => {
            state.rolloutState.lease_owner = owner;
            state.rolloutState.lease_until = nowIso;
            return true;
        },
        updateRolloutSwitchState: (patch) => {
            state.rolloutState = { ...state.rolloutState, ...patch };
            return { ...state.rolloutState };
        },
        insertRolloutSwitchEvent: (event) => {
            state.rolloutEvents.push({
                id: state.rolloutEvents.length + 1,
                ...event,
            });
        },
        getRolloutSwitchEvents: (limit = 200) => state.rolloutEvents.slice(-limit).reverse(),
        getRuntimeLogs: () => [{ id: 5, event: '开始抓源' }],
        purgeSocks4Data: () => {
            state.socks4CleanupCalls += 1;
            return {
                sourceName: 'TheSpeedX/socks4',
                protocol: 'socks4',
                deleted: 2,
                beforeSource: 1,
                beforeProtocol: 1,
                afterSource: 0,
                afterProtocol: 0,
            };
        },
        purgeSocks5Data: () => {
            state.socks5CleanupCalls += 1;
            return {
                sourceName: 'TheSpeedX/socks5',
                protocol: 'socks5',
                deleted: 3,
                beforeSource: 2,
                beforeProtocol: 2,
                afterSource: 0,
                afterProtocol: 0,
            };
        },
        close: () => {
            state.dbClosed = true;
        },
    };

    const logger = {
        entries: [],
        // 0101_write_写入逻辑
        write(entry) {
            this.entries.push(entry);
            loggerEvents.emit('log', entry);
            return entry;
        },
        // 0102_subscribe_订阅逻辑
        subscribe(handler) {
            loggerEvents.on('log', handler);
            return () => loggerEvents.off('log', handler);
        },
    };

    const workerPool = {
        getStatus: () => ({ workersTotal: 2, workersBusy: 1, queueSize: 0, runningTasks: 0, completedTasks: 1, failedTasks: 0, restartedWorkers: 0, workers: [] }),
        // 0103_subscribe_订阅逻辑
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
        state.engineStopCalls += 1;
    };

    return { db, logger, workerPool, engine, state };
}

// 0104_startRuntimeOnRandomPort_启动运行时随机逻辑
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
        '/v1/proxies/list?limit=10&serviceBranch=%E6%B5%B7%E5%86%9B',
        '/v1/proxies/events?limit=0',
        '/v1/proxies/battle-tests?limit=1000',
        '/v1/proxies/value-board?limit=20',
        '/v1/proxies/value-board?limit=20&lifecycle=active',
        '/v1/proxies/value-board?limit=20&serviceBranch=%E6%B5%B7%E5%86%9B',
        '/v1/proxies/policy',
        '/v1/proxies/rollout',
        '/v1/proxies/rollout/guardrails',
        '/v1/proxies/rollout/orchestrator/state',
        '/v1/proxies/rollout/orchestrator/events',
        '/v1/proxies/candidate-control',
        '/v1/proxies/ranks/board',
        '/v1/proxies/branches/board',
        '/v1/proxies/recruit-camp',
        '/v1/proxies/honors?limit=1000',
        '/v1/proxies/retirements?limit=-1',
        '/v1/runtime/logs?limit=abc',
    ];

    for (const p of urls) {
        const res = await fetch(baseUrl + p, { signal: AbortSignal.timeout(10000) });
        assert.equal(res.status, 200);
    }

    const valueBoardRes = await fetch(baseUrl + '/v1/proxies/value-board?limit=20');
    const valueBoardPayload = await valueBoardRes.json();
    assert.equal(valueBoardPayload.items.length > 0, true);
    assert.equal(typeof valueBoardPayload.items[0].l0_success_count, 'number');
    assert.equal(typeof valueBoardPayload.items[0].l0_fail_count, 'number');
    assert.equal(typeof valueBoardPayload.items[0].l1_success_count, 'number');
    assert.equal(typeof valueBoardPayload.items[0].l1_fail_count, 'number');
    assert.equal(typeof valueBoardPayload.items[0].l2_success_count, 'number');
    assert.equal(typeof valueBoardPayload.items[0].l2_fail_count, 'number');
    assert.equal(typeof valueBoardPayload.items[0].l3_success_count, 'number');
    assert.equal(typeof valueBoardPayload.items[0].l3_fail_count, 'number');
    assert.equal(typeof valueBoardPayload.items[0].native_place, 'string');
    assert.equal(typeof valueBoardPayload.items[0].native_lookup_raw_json, 'string');
    assert.equal(typeof valueBoardPayload.items[0].native_lookup_readable_text, 'string');

    const patchOk = await fetch(baseUrl + '/v1/proxies/policy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            promotionProtectHours: 4,
            honors: { steelStreak: 2, riskyWarrior: 2, thousandService: 8 },
        }),
    });
    assert.equal(patchOk.status, 200);

    const patchInvalidBody = await fetch(baseUrl + '/v1/proxies/policy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([]),
    });
    assert.equal(patchInvalidBody.status, 400);

    const patchInvalidValue = await fetch(baseUrl + '/v1/proxies/policy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            retirement: { technicalSuccessRatio: 2 },
        }),
    });
    assert.equal(patchInvalidValue.status, 400);

    const featurePatchOk = await fetch(baseUrl + '/v1/proxies/rollout/features', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            honorPromotionTuning: true,
        }),
    });
    assert.equal(featurePatchOk.status, 200);

    const featurePatchInvalid = await fetch(baseUrl + '/v1/proxies/rollout/features', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            unknownFeature: true,
        }),
    });
    assert.equal(featurePatchInvalid.status, 400);

    const rollbackRes = await fetch(baseUrl + '/v1/proxies/rollout/guardrails/rollback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
    });
    assert.equal(rollbackRes.status, 200);
    const rollbackPayload = await rollbackRes.json();
    assert.equal(rollbackPayload.ok, true);
    assert.equal(rollbackPayload.applied, true);
    assert.equal(rollbackPayload.guardrails.shouldRollback, true);
    assert.equal(Array.isArray(rollbackPayload.guardrails.breaches), true);
    assert.equal(typeof rollbackPayload.features.lifecycleHysteresis, 'boolean');

    const manualTickRes = await fetch(baseUrl + '/v1/proxies/rollout/orchestrator/tick', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
    });
    assert.equal(manualTickRes.status, 200);
    const manualTick = await manualTickRes.json();
    assert.equal(typeof manualTick.ok, 'boolean');

    const candidateControlPatch = await fetch(baseUrl + '/v1/proxies/candidate-control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            max: 1234,
            low: 600,
            refillStop: 1100,
            gateOverride: true,
        }),
    });
    assert.equal(candidateControlPatch.status, 200);
    const candidateControlBody = await candidateControlPatch.json();
    assert.equal(candidateControlBody.ok, true);
    assert.equal(candidateControlBody.candidateControl.max, 1234);
    assert.equal(candidateControlBody.candidateControl.low, 600);
    assert.equal(candidateControlBody.candidateControl.refillStop, 1100);
    assert.equal(candidateControlBody.candidateControl.gateOverride, true);

    const candidateControlInvalid = await fetch(baseUrl + '/v1/proxies/candidate-control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            gateOverride: 'yes',
        }),
    });
    assert.equal(candidateControlInvalid.status, 400);

    const candidateControlInvalidPayload = await fetch(baseUrl + '/v1/proxies/candidate-control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([]),
    });
    assert.equal(candidateControlInvalidPayload.status, 400);

    const candidateControlInvalidMax = await fetch(baseUrl + '/v1/proxies/candidate-control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            max: -1,
        }),
    });
    assert.equal(candidateControlInvalidMax.status, 400);

    const candidateControlInvalidLow = await fetch(baseUrl + '/v1/proxies/candidate-control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            low: -1,
        }),
    });
    assert.equal(candidateControlInvalidLow.status, 400);

    const candidateControlInvalidRefillStop = await fetch(baseUrl + '/v1/proxies/candidate-control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            refillStop: 'bad',
        }),
    });
    assert.equal(candidateControlInvalidRefillStop.status, 400);

    const candidateControlNormalize = await fetch(baseUrl + '/v1/proxies/candidate-control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            max: 100,
            low: 200,
            refillStop: 50,
        }),
    });
    assert.equal(candidateControlNormalize.status, 200);
    const candidateControlNormalizeBody = await candidateControlNormalize.json();
    assert.equal(candidateControlNormalizeBody.candidateControl.max, 100);
    assert.equal(candidateControlNormalizeBody.candidateControl.low, 100);
    assert.equal(candidateControlNormalizeBody.candidateControl.refillStop, 100);

    const candidateControlZeroWatermark = await fetch(baseUrl + '/v1/proxies/candidate-control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            max: 100,
            low: 0,
            refillStop: 0,
        }),
    });
    assert.equal(candidateControlZeroWatermark.status, 200);
    const candidateControlZeroWatermarkBody = await candidateControlZeroWatermark.json();
    assert.equal(candidateControlZeroWatermarkBody.candidateControl.max, 100);
    assert.equal(candidateControlZeroWatermarkBody.candidateControl.low, 0);
    assert.equal(candidateControlZeroWatermarkBody.candidateControl.refillStop, 0);

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
    assert.equal(stubs.state.socks4CleanupCalls, 1);
    assert.equal(stubs.state.socks5CleanupCalls, 1);
    assert.equal(stubs.state.dbClosed, true);
    assert.equal(stubs.state.poolClosed, true);
    assert.equal(stubs.state.engineStopped, true);
});

test('soak guardrail endpoints should apply and recover runtime controls', async () => {
    const stubs = createStubs();
    let workersTotal = 6;
    let sourceThrottleFactor = 1;
    stubs.workerPool.getStatus = () => ({
        workersTotal,
        workersBusy: 0,
        queueSize: 0,
        runningTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        restartedWorkers: 0,
        workers: [],
    });
    stubs.workerPool.setSize = (nextWorkers) => {
        workersTotal = Number(nextWorkers);
        return {
            ...stubs.workerPool.getStatus(),
            targetWorkers: workersTotal,
        };
    };
    stubs.engine.setSourceCycleThrottleFactor = (factor) => {
        sourceThrottleFactor = Number(factor);
        return sourceThrottleFactor;
    };

    const { runtime, baseUrl } = await startRuntimeOnRandomPort(stubs);
    try {
        const applyRes = await fetch(baseUrl + '/v1/proxies/soak/guardrail', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                action: 'apply',
                reason: 'test-trigger',
                reduceWorkersBy: 1,
                minWorkers: 3,
                validationThrottleFactor: 2,
                sourceThrottleFactor: 3,
            }),
        });
        assert.equal(applyRes.status, 200);
        const applyBody = await applyRes.json();
        assert.equal(applyBody.ok, true);
        assert.equal(applyBody.guardrail.effective.workers, 5);
        assert.equal(applyBody.guardrail.effective.maxValidationPerCycle, 5);
        assert.equal(applyBody.guardrail.effective.validationThrottleFactor, 2);
        assert.equal(applyBody.guardrail.effective.sourceThrottleFactor, 3);
        assert.equal(sourceThrottleFactor, 3);

        const getRes = await fetch(baseUrl + '/v1/proxies/soak/guardrail');
        assert.equal(getRes.status, 200);
        const getBody = await getRes.json();
        assert.equal(getBody.guardrail.effective.workers, 5);

        const recoverRes = await fetch(baseUrl + '/v1/proxies/soak/guardrail', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                action: 'recover',
                reason: 'test-recover',
            }),
        });
        assert.equal(recoverRes.status, 200);
        const recoverBody = await recoverRes.json();
        assert.equal(recoverBody.ok, true);
        assert.equal(recoverBody.guardrail.effective.workers, 2);
        assert.equal(recoverBody.guardrail.effective.validationThrottleFactor, 1);
        assert.equal(recoverBody.guardrail.effective.sourceThrottleFactor, 1);
        assert.equal(sourceThrottleFactor, 1);
    } finally {
        await runtime.shutdown('TEST-SOAK-GUARDRAIL');
    }
});

test('soak guardrail endpoint should validate payload/action and cover workers patch branch', async () => {
    const stubs = createStubs();
    const config = createConfig(0);
    config.threadPool = null;
    config.battle.l3 = {
        enabled: true,
        syncMs: 2700000,
        maxPerCycle: 12,
    };

    let workersTotal = 4;
    stubs.workerPool.getStatus = () => ({
        workersTotal,
        workersBusy: 0,
        queueSize: 0,
        runningTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        restartedWorkers: 0,
        workers: [],
    });
    stubs.workerPool.setSize = (nextWorkers) => {
        workersTotal = Number(nextWorkers);
        return {
            ...stubs.workerPool.getStatus(),
            targetWorkers: workersTotal,
        };
    };
    stubs.engine.setSourceCycleThrottleFactor = () => 1;

    const { runtime, baseUrl } = await startRuntimeOnRandomPort({ ...stubs, config });
    try {
        const invalidBodyRes = await fetch(baseUrl + '/v1/proxies/soak/guardrail', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify([]),
        });
        assert.equal(invalidBodyRes.status, 400);
        const invalidBody = await invalidBodyRes.json();
        assert.equal(invalidBody.error, 'invalid-soak-guardrail-payload');

        const invalidActionRes = await fetch(baseUrl + '/v1/proxies/soak/guardrail', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'bad-action' }),
        });
        assert.equal(invalidActionRes.status, 400);
        const invalidAction = await invalidActionRes.json();
        assert.equal(invalidAction.error, 'invalid-soak-guardrail-action');

        const workersRes = await fetch(baseUrl + '/v1/proxies/soak/guardrail', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                action: 'apply',
                workers: 2,
                minWorkers: 0,
                validationThrottleFactor: 2,
            }),
        });
        assert.equal(workersRes.status, 200);
        const workersBody = await workersRes.json();
        assert.equal(workersBody.ok, true);
        assert.equal(workersBody.guardrail.effective.workers, 2);
        assert.equal(workersBody.guardrail.effective.maxBattleL3PerCycle, 6);
    } finally {
        await runtime.shutdown('TEST-SOAK-GUARDRAIL-VALIDATION');
    }
});

test('soak guardrail should fallback current workers to config baseline when pool reports zero', async () => {
    const stubs = createStubs();
    let workersTotal = 0;
    stubs.workerPool.getStatus = () => ({
        workersTotal,
        workersBusy: 0,
        queueSize: 0,
        runningTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        restartedWorkers: 0,
        workers: [],
    });
    stubs.workerPool.setSize = (nextWorkers) => {
        workersTotal = Number(nextWorkers);
        return {
            ...stubs.workerPool.getStatus(),
            targetWorkers: workersTotal,
        };
    };
    stubs.engine.setSourceCycleThrottleFactor = () => 1;

    const { runtime, baseUrl } = await startRuntimeOnRandomPort(stubs);
    try {
        const res = await fetch(baseUrl + '/v1/proxies/soak/guardrail', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                action: 'apply',
                reason: 'workers-fallback',
                minWorkers: 0,
            }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.guardrail.effective.workers, 2);
    } finally {
        await runtime.shutdown('TEST-SOAK-GUARDRAIL-WORKER-FALLBACK');
    }
});

test('soak guardrail endpoint should cover default action and fallback normalization branches', async () => {
    const stubs = createStubs();
    const config = createConfig(0);
    config.threadPool.workers = 0;
    config.scheduler.maxValidationPerCycle = 0;
    config.battle.maxBattleL1PerCycle = 0;
    config.battle.maxBattleL2PerCycle = 0;
    config.battle.l3 = config.battle.l3 || {
        enabled: true,
        syncMs: 2700000,
        maxPerCycle: 12,
    };
    config.battle.l3.maxPerCycle = 0;

    let workersTotal = 5;
    let setSizeCalls = 0;
    stubs.workerPool.getStatus = () => ({
        workersTotal,
        workersBusy: 0,
        queueSize: 0,
        runningTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        restartedWorkers: 0,
        workers: [],
    });
    stubs.workerPool.setSize = (nextWorkers) => {
        setSizeCalls += 1;
        const numericNext = Number(nextWorkers);
        workersTotal = Number.isFinite(numericNext) ? numericNext : workersTotal;
        if (setSizeCalls === 1) {
            return { workersTotal: 7 };
        }
        if (setSizeCalls === 2) {
            return { targetWorkers: 'not-a-number' };
        }
        return undefined;
    };
    stubs.engine.setSourceCycleThrottleFactor = () => 1;

    const { runtime, baseUrl } = await startRuntimeOnRandomPort({ ...stubs, config });
    try {
        const initialGetRes = await fetch(baseUrl + '/v1/proxies/soak/guardrail');
        assert.equal(initialGetRes.status, 200);
        const initialGet = await initialGetRes.json();
        assert.equal(initialGet.guardrail.baseline.workers, 5);
        assert.equal(initialGet.guardrail.baseline.maxValidationPerCycle, 1);
        assert.equal(initialGet.guardrail.baseline.maxBattleL1PerCycle, 1);
        assert.equal(initialGet.guardrail.baseline.maxBattleL2PerCycle, 1);

        const defaultApplyRes = await fetch(baseUrl + '/v1/proxies/soak/guardrail', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
        });
        assert.equal(defaultApplyRes.status, 200);
        const defaultApply = await defaultApplyRes.json();
        assert.equal(defaultApply.ok, true);
        assert.equal(defaultApply.guardrail.effective.workers, 7);

        const invalidApplyRes = await fetch(baseUrl + '/v1/proxies/soak/guardrail', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                action: 'apply',
                workers: 'bad-workers',
                minWorkers: 'bad-min',
                validationThrottleFactor: 'bad-factor',
                sourceThrottleFactor: 'bad-source',
            }),
        });
        assert.equal(invalidApplyRes.status, 200);
        const invalidApply = await invalidApplyRes.json();
        assert.equal(invalidApply.ok, true);
        assert.equal(invalidApply.guardrail.effective.workers, 5);
        assert.equal(invalidApply.guardrail.effective.validationThrottleFactor, 1);
        assert.equal(invalidApply.guardrail.effective.sourceThrottleFactor, 1);

        workersTotal = 0;
        const reduceRes = await fetch(baseUrl + '/v1/proxies/soak/guardrail', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                action: 'apply',
                reduceWorkersBy: 1,
                minWorkers: 0,
            }),
        });
        assert.equal(reduceRes.status, 200);
        const reduceBody = await reduceRes.json();
        assert.equal(reduceBody.ok, true);
        assert.equal(reduceBody.guardrail.effective.workers, 4);
    } finally {
        await runtime.shutdown('TEST-SOAK-GUARDRAIL-FALLBACK');
    }
});

test('startup socks4 cleanup should be skipped when socks4 feed is enabled', async () => {
    const stubs = createStubs();
    const config = createConfig(0);
    const socks4Feed = config.source.activeFeeds.find((feed) => feed.name === 'TheSpeedX/socks4');
    const socks5Feed = config.source.activeFeeds.find((feed) => feed.name === 'TheSpeedX/socks5');
    socks4Feed.enabled = true;
    socks5Feed.enabled = true;

    const { runtime } = await startRuntimeOnRandomPort({ ...stubs, config });
    try {
        assert.equal(stubs.state.socks4CleanupCalls, 0);
        assert.equal(stubs.state.socks5CleanupCalls, 0);
    } finally {
        await runtime.shutdown('TEST-SOCKS4-CLEANUP-SKIP');
    }
});

test('startup socks5 cleanup should be skipped when socks5 feed is enabled', async () => {
    const stubs = createStubs();
    const config = createConfig(0);
    const socks4Feed = config.source.activeFeeds.find((feed) => feed.name === 'TheSpeedX/socks4');
    const socks5Feed = config.source.activeFeeds.find((feed) => feed.name === 'TheSpeedX/socks5');
    socks4Feed.enabled = true;
    socks5Feed.enabled = true;

    const { runtime } = await startRuntimeOnRandomPort({ ...stubs, config });
    try {
        assert.equal(stubs.state.socks5CleanupCalls, 0);
    } finally {
        await runtime.shutdown('TEST-SOCKS5-CLEANUP-SKIP');
    }
});

test('startup cleanup should skip feed when purge method is missing', async () => {
    const stubs = createStubs();
    delete stubs.db.purgeSocks5Data;

    const { runtime } = await startRuntimeOnRandomPort(stubs);
    try {
        assert.equal(stubs.state.socks4CleanupCalls, 1);
        assert.equal(stubs.state.socks5CleanupCalls, 0);
    } finally {
        await runtime.shutdown('TEST-CLEANUP-METHOD-MISSING');
    }
});

test('startup socks4 cleanup should be skipped when activeFeeds is not an array', async () => {
    const stubs = createStubs();
    const config = createConfig(0);
    config.source.activeFeeds = null;

    const { runtime } = await startRuntimeOnRandomPort({ ...stubs, config });
    try {
        assert.equal(stubs.state.socks4CleanupCalls, 0);
        assert.equal(stubs.state.socks5CleanupCalls, 0);
    } finally {
        await runtime.shutdown('TEST-SOCKS4-CLEANUP-NON-ARRAY');
    }
});

test('excludeRetired flag should be forwarded to admin stats endpoints', async () => {
    const stubs = createStubs();
    const calls = {
        source: [],
        lifecycle: [],
        rank: [],
        branch: [],
        list: [],
        value: [],
    };

    stubs.db.getSourceDistribution = (options) => {
        calls.source.push(options);
        return [{ source: 'filtered-source', count: 1 }];
    };
    stubs.db.getLifecycleDistribution = (options) => {
        calls.lifecycle.push(options);
        return [{ lifecycle: 'active', count: 1 }];
    };
    stubs.db.getLatestSnapshot = () => ({
        workers_total: 2,
        source_distribution: [{ source: 'legacy-source', count: 9 }],
        rank_distribution: [{ rank: '新兵', count: 9 }],
        lifecycle_distribution: [{ lifecycle: 'retired', count: 9 }],
    });
    stubs.db.getRankBoard = (options) => {
        calls.rank.push(options);
        return [{ rank: '新兵', count: 1 }];
    };
    stubs.db.getServiceBranchDistribution = (options) => {
        calls.branch.push(options);
        return [{ service_branch: '海军', count: 1 }];
    };
    stubs.db.getProxyList = (options) => {
        calls.list.push(options);
        return [];
    };
    stubs.db.getValueBoard = (limit, lifecycle, options) => {
        calls.value.push({ limit, lifecycle, options });
        return [];
    };
    stubs.db.getRecruitCampBoard = () => [
        { lifecycle: 'active', label: '新兵连', count: 1 },
        { lifecycle: 'reserve', label: '医务室', count: 2 },
        { lifecycle: 'candidate', label: '预备队', count: 3 },
        { lifecycle: 'retired', label: '已退役', count: 4 },
    ];

    const { runtime, baseUrl } = await startRuntimeOnRandomPort(stubs);
    try {
        const poolStatusRes = await fetch(baseUrl + '/v1/proxies/pool-status?excludeRetired=true');
        const poolStatus = await poolStatusRes.json();
        await fetch(baseUrl + '/v1/proxies/ranks/board?excludeRetired=true');
        await fetch(baseUrl + '/v1/proxies/branches/board?excludeRetired=true');
        await fetch(baseUrl + '/v1/proxies/list?limit=20&excludeRetired=true&serviceBranch=%E6%B5%B7%E5%86%9B');
        await fetch(baseUrl + '/v1/proxies/value-board?limit=20&excludeRetired=true&serviceBranch=%E6%B5%B7%E5%86%9B');
        await fetch(baseUrl + '/v1/proxies/list?limit=20&excludeRetired=off');
        await fetch(baseUrl + '/v1/proxies/list?limit=20&excludeRetired=not-bool');
        const campRes = await fetch(baseUrl + '/v1/proxies/recruit-camp');
        const camp = await campRes.json();

        assert.equal(calls.source.at(-1).excludeRetired, true);
        assert.equal(calls.lifecycle.at(-1).excludeRetired, true);
        assert.equal(calls.rank.at(-2).excludeRetired, true);
        assert.equal(calls.branch.at(-1).excludeRetired, true);
        assert.equal(calls.list.at(-3).excludeRetired, true);
        assert.equal(calls.list.at(-3).serviceBranch, '海军');
        assert.equal(calls.list.at(-2).excludeRetired, false);
        assert.equal(calls.list.at(-1).excludeRetired, false);
        assert.equal(calls.value.at(-1).options.excludeRetired, true);
        assert.equal(calls.value.at(-1).options.serviceBranch, '海军');
        assert.deepEqual(poolStatus.latestSnapshot.source_distribution, [{ source: 'filtered-source', count: 1 }]);
        assert.deepEqual(poolStatus.latestSnapshot.rank_distribution, [{ rank: '新兵', count: 1 }]);
        assert.deepEqual(poolStatus.latestSnapshot.lifecycle_distribution, [{ lifecycle: 'active', count: 1 }]);
        assert.equal(camp.items.length, 4);
        assert.equal(camp.items[0].lifecycle, 'active');
        assert.equal(camp.items[3].lifecycle, 'retired');

        await fetch(baseUrl + '/v1/proxies/ranks/board');
        assert.equal(calls.rank.at(-1).excludeRetired, false);
    } finally {
        await runtime.shutdown('TEST-EXCLUDE-RETIRED');
    }
});

test('rollout rollback endpoint should skip apply when guardrails are healthy', async () => {
    const stubs = createStubs();
    stubs.db.getActiveCount = () => 100;
    stubs.db.getBattleSuccessRateSince = () => ({ stage: 'l2', total: 20, success: 16, successRate: 0.8 });
    stubs.db.getRetirementsCountSince = () => 1;
    stubs.db.getRetirementDailyCounts = () => [
        { day: '2026-03-09', count: 1 },
        { day: '2026-03-10', count: 1 },
        { day: '2026-03-11', count: 1 },
        { day: '2026-03-12', count: 1 },
        { day: '2026-03-13', count: 1 },
        { day: '2026-03-14', count: 1 },
        { day: '2026-03-15', count: 1 },
    ];

    const { runtime, baseUrl } = await startRuntimeOnRandomPort(stubs);
    const rollbackRes = await fetch(baseUrl + '/v1/proxies/rollout/guardrails/rollback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
    });
    assert.equal(rollbackRes.status, 200);
    const rollbackPayload = await rollbackRes.json();
    assert.equal(rollbackPayload.ok, true);
    assert.equal(rollbackPayload.applied, false);
    assert.equal(rollbackPayload.guardrails.shouldRollback, false);

    await runtime.shutdown('TEST-ROLLBACK-SKIP');
});

test('candidate control endpoint should initialize control object when missing', async () => {
    const stubs = createStubs();
    const config = createConfig(0);
    delete config.candidateControl;
    const runtime = createRuntime({ config, ...stubs });
    const server = await runtime.start();
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
        const res = await fetch(baseUrl + '/v1/proxies/candidate-control', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                max: 1200,
                gateOverride: true,
            }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.candidateControl.max, 1200);
        assert.equal(body.candidateControl.low, 800);
        assert.equal(body.candidateControl.refillStop, 1200);
        assert.equal(body.candidateControl.gateOverride, true);
    } finally {
        await runtime.shutdown('TEST-CANDIDATE-CONTROL-MISSING');
    }
});

test('candidate control GET should fallback when db method or config is missing', async () => {
    const stubs = createStubs();
    stubs.db.getLifecycleDistribution = undefined;
    stubs.db.getLifecycleCount = undefined;
    const config = createConfig(0);
    delete config.candidateControl;
    const runtime = createRuntime({ config, ...stubs });
    const server = await runtime.start();
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
        const res = await fetch(baseUrl + '/v1/proxies/candidate-control');
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.candidateCount, 0);
        assert.deepEqual(body.candidateControl, {});
    } finally {
        await runtime.shutdown('TEST-CANDIDATE-CONTROL-GET-FALLBACK');
    }
});

test('candidate control GET should fallback to candidate distribution count', async () => {
    const stubs = createStubs();
    stubs.db.getLifecycleDistribution = () => [
        { lifecycle: 'active', count: 1 },
        { lifecycle: 'candidate', count: '7' },
    ];
    stubs.db.getLifecycleCount = undefined;

    const { runtime, baseUrl } = await startRuntimeOnRandomPort(stubs);
    try {
        const res = await fetch(baseUrl + '/v1/proxies/candidate-control');
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.candidateCount, 7);
        assert.equal(body.candidateControl.max, 3000);
    } finally {
        await runtime.shutdown('TEST-CANDIDATE-CONTROL-DISTRIBUTION-FALLBACK');
    }
});

test('candidate control GET should prefer lifecycleCount when available', async () => {
    const stubs = createStubs();
    stubs.db.getLifecycleDistribution = () => [
        { lifecycle: 'candidate', count: 99 },
    ];
    stubs.db.getLifecycleCount = () => 5;

    const { runtime, baseUrl } = await startRuntimeOnRandomPort(stubs);
    try {
        const res = await fetch(baseUrl + '/v1/proxies/candidate-control');
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.candidateCount, 5);
    } finally {
        await runtime.shutdown('TEST-CANDIDATE-CONTROL-LIFECYCLE-COUNT');
    }
});

test('branches board endpoint should fallback when db method is missing', async () => {
    const stubs = createStubs();
    stubs.db.getServiceBranchDistribution = undefined;
    const { runtime, baseUrl } = await startRuntimeOnRandomPort(stubs);

    try {
        const res = await fetch(baseUrl + '/v1/proxies/branches/board?excludeRetired=true');
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.items, []);
    } finally {
        await runtime.shutdown('TEST-BRANCH-BOARD-FALLBACK');
    }
});

test('shutdown should wait for in-flight engine start before closing db', async () => {
    const stubs = createStubs();
    let releaseStart;
    const startGate = new Promise((resolve) => {
        releaseStart = resolve;
    });
    stubs.engine.start = async () => {
        stubs.state.engineStarted = true;
        await startGate;
    };

    const { runtime } = await startRuntimeOnRandomPort(stubs);
    const shutdownPromise = runtime.shutdown('RACE');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(stubs.state.engineStarted, true);
    assert.equal(stubs.state.engineStopCalls >= 1, true);
    assert.equal(stubs.state.dbClosed, false);
    assert.equal(stubs.state.poolClosed, false);

    releaseStart();
    await shutdownPromise;

    assert.equal(stubs.state.dbClosed, true);
    assert.equal(stubs.state.poolClosed, true);
    assert.equal(stubs.state.engineStopCalls >= 2, true);
});

test('server start should reject when listen emits error', async () => {
    const fakeApp = new EventEmitter();
    fakeApp.use = () => {};
    fakeApp.get = () => {};
    fakeApp.post = () => {};
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
    fakeAppThrow.post = () => {};
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

test('server start should log orchestrator async start failure', async () => {
    const stubs = createStubs();
    const orchestrator = {
        instanceId: 'orch-test',
        async start() {
            throw new Error('orch-start-fail');
        },
        async stop() {},
    };

    const { runtime } = await startRuntimeOnRandomPort({ ...stubs, orchestrator });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stubs.logger.entries.some((e) => e.result === '自动编排启动失败' && e.reason === 'orch-start-fail'), true);
    await runtime.shutdown('TEST-ORCH-FAIL');
});

test('server start should fallback orchestrator start failure reason to unknown', async () => {
    const stubs = createStubs();
    const orchestrator = {
        instanceId: 'orch-test-null',
        async start() {
            throw null;
        },
        async stop() {},
    };

    const { runtime } = await startRuntimeOnRandomPort({ ...stubs, orchestrator });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stubs.logger.entries.some((e) => e.result === '自动编排启动失败' && e.reason === 'unknown'), true);
    await runtime.shutdown('TEST-ORCH-FAIL-NULL');
});

test('shutdown should wait for in-flight orchestrator start before closing db', async () => {
    const stubs = createStubs();
    let releaseStart;
    const startGate = new Promise((resolve) => {
        releaseStart = resolve;
    });
    const orchestrator = {
        instanceId: 'orch-gate',
        stopped: false,
        async start() {
            await startGate;
        },
        async stop() {
            this.stopped = true;
        },
    };

    const { runtime } = await startRuntimeOnRandomPort({ ...stubs, orchestrator });
    const shutdownPromise = runtime.shutdown('RACE-ORCH');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(stubs.state.dbClosed, false);
    assert.equal(stubs.state.poolClosed, false);
    assert.equal(orchestrator.stopped, false);

    releaseStart();
    await shutdownPromise;

    assert.equal(stubs.state.dbClosed, true);
    assert.equal(stubs.state.poolClosed, true);
    assert.equal(orchestrator.stopped, true);
});

test('runCli should register signals and handle startup failure', async () => {
    const processEvents = {};
    const processRef = {
        exitCode: null,
        // 0105_on_执行on相关逻辑
        on(event, handler) {
            processEvents[event] = handler;
        },
        // 0106_exit_退出逻辑
        exit(code) {
            this.exitCode = code;
        },
    };

    const runtimeOk = {
        stopped: false,
        logger: { write() {} },
        async start() {},
        // 0107_shutdown_执行shutdown相关逻辑
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
        // 0108_on_执行on相关逻辑
        on(event, handler) {
            processEvents[event] = handler;
        },
        // 0109_exit_退出逻辑
        exit(code) {
            this.exitCode = code;
        },
    };
    const runtimeSigint = {
        logger: { write() {} },
        async start() {},
        // 0110_shutdown_执行shutdown相关逻辑
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
        // 0111_start_启动逻辑
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
        // 0112_start_启动逻辑
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
        // 0113_on_执行on相关逻辑
        on(event, handler) {
            processEvents[event] = handler;
        },
        // 0114_exit_退出逻辑
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
    for (let i = 0; i < 100 && processRef.exitCode == null; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(processRef.exitCode, 0);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('rollout orchestrator endpoints should fallback when db methods are missing', async () => {
    const stubs = createStubs();
    stubs.db.getRolloutSwitchState = undefined;
    stubs.db.getRolloutSwitchEvents = undefined;
    const { runtime, baseUrl } = await startRuntimeOnRandomPort(stubs);

    try {
        const stateRes = await fetch(baseUrl + '/v1/proxies/rollout/orchestrator/state');
        assert.equal(stateRes.status, 200);
        const stateBody = await stateRes.json();
        assert.equal(stateBody.state, null);
        assert.equal(stateBody.config.enabled, true);

        const eventsRes = await fetch(baseUrl + '/v1/proxies/rollout/orchestrator/events?limit=10');
        assert.equal(eventsRes.status, 200);
        const eventsBody = await eventsRes.json();
        assert.deepEqual(eventsBody.items, []);
    } finally {
        await runtime.shutdown('TEST-MISSING-ROLL-DB');
    }
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
        // 0115_write_写入逻辑
        write(chunk) {
            writes.push(chunk);
        },
    };
    const poolClient = {
        // 0116_write_写入逻辑
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



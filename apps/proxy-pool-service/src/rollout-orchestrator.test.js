const test = require('node:test');
const assert = require('node:assert/strict');
const {
    SAFE_FEATURES,
    FULL_FEATURES,
    resolveFeaturePatch,
    hoursBetween,
    pickCurrentMode,
    RolloutOrchestrator,
} = require('./rollout-orchestrator');

// 0253_createHarness_创建编排测试桩逻辑
function createHarness(options = {}) {
    const events = [];
    const state = {
        mode: options.state?.mode || 'SAFE',
        stable_since: options.state?.stable_since || '2026-03-14T00:00:00.000Z',
        cooldown_until: options.state?.cooldown_until || null,
        last_tick_at: options.state?.last_tick_at || null,
        last_error: options.state?.last_error || null,
        lease_owner: null,
        lease_until: null,
        updated_at: options.state?.updated_at || '2026-03-14T00:00:00.000Z',
    };
    const leaseAllowed = options.leaseAllowed !== false;

    const config = {
        rollout: {
            features: {
                stageWeighting: true,
                lifecycleHysteresis: true,
                honorPromotionTuning: false,
                ...(options.features || {}),
            },
            orchestrator: {
                enabled: true,
                intervalMs: 900000,
                stableHours: 48,
                cooldownHours: 24,
                minL2Samples: 20,
                leaseTtlMs: 120000,
                ...(options.orchestrator || {}),
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
                ...(options.guardrails || {}),
            },
        },
    };

    const db = {
        getRolloutSwitchState: () => ({ ...state }),
        acquireRolloutSwitchLease: () => leaseAllowed,
        updateRolloutSwitchState: (patch) => {
            Object.assign(state, patch, { updated_at: patch.nowIso || state.updated_at });
            return { ...state };
        },
        insertRolloutSwitchEvent: (event) => events.push(event),
        getRolloutSwitchEvents: () => [...events].reverse(),
        getActiveCount: () => Number(options.metrics?.activeNow ?? 100),
        getBattleSuccessRateSince: () => ({
            total: Number(options.metrics?.l2Total ?? 30),
            success: Number(options.metrics?.l2Success ?? 21),
            successRate: Number(options.metrics?.l2Rate ?? 0.7),
        }),
        getRetirementsCountSince: () => Number(options.metrics?.retired24h ?? 1),
        getRetirementDailyCounts: () => options.metrics?.retirementDaily || [
            { day: '2026-03-10', count: 1 },
            { day: '2026-03-11', count: 1 },
            { day: '2026-03-12', count: 1 },
            { day: '2026-03-13', count: 1 },
            { day: '2026-03-14', count: 1 },
            { day: '2026-03-15', count: 1 },
            { day: '2026-03-16', count: 1 },
        ],
        ...(options.dbOverrides || {}),
    };

    const logs = [];
    const logger = {
        write: (entry) => {
            logs.push(entry);
        },
    };

    const nowSeq = Array.isArray(options.nowSeq) && options.nowSeq.length > 0
        ? [...options.nowSeq]
        : ['2026-03-16T12:00:00.000Z'];
    const now = () => new Date(nowSeq.length > 1 ? nowSeq.shift() : nowSeq[0]);

    const orchestrator = new RolloutOrchestrator({
        config,
        db,
        logger,
        now,
        instanceId: 'test-owner',
    });

    return {
        orchestrator,
        config,
        db,
        logs,
        state,
        events,
    };
}

test('helpers should build patches and mode decisions', () => {
    assert.deepEqual(resolveFeaturePatch(SAFE_FEATURES, FULL_FEATURES), { honorPromotionTuning: true });
    assert.equal(hoursBetween('2026-03-15T00:00:00.000Z', '2026-03-16T00:00:00.000Z'), 24);
    assert.equal(hoursBetween('invalid-date', '2026-03-16T00:00:00.000Z'), 0);
    assert.equal(hoursBetween('2026-03-17T00:00:00.000Z', '2026-03-16T00:00:00.000Z'), 0);
    assert.equal(pickCurrentMode({ mode: 'COOLDOWN', cooldown_until: '2026-03-17T00:00:00.000Z' }, SAFE_FEATURES, '2026-03-16T00:00:00.000Z'), 'COOLDOWN');
    assert.equal(pickCurrentMode({ mode: 'SAFE' }, FULL_FEATURES, '2026-03-16T00:00:00.000Z'), 'FULL');
    assert.equal(pickCurrentMode({ mode: 'SAFE' }, SAFE_FEATURES, '2026-03-16T00:00:00.000Z'), 'SAFE');
});

test('tick should rollback on guardrail breach and enter cooldown', async () => {
    const h = createHarness({
        features: { honorPromotionTuning: true },
        state: {
            mode: 'FULL',
            stable_since: '2026-03-14T00:00:00.000Z',
        },
        metrics: {
            activeNow: 100,
            l2Total: 30,
            l2Success: 12,
            l2Rate: 0.4,
            retired24h: 1,
        },
        nowSeq: ['2026-03-16T12:00:00.000Z'],
    });

    const out = await h.orchestrator.tick({ trigger: 'manual' });
    assert.equal(out.ok, true);
    assert.equal(out.action, 'rollback');
    assert.equal(out.state.mode, 'COOLDOWN');
    assert.equal(h.config.rollout.features.honorPromotionTuning, false);
    assert.equal(h.config.rollout.features.stageWeighting, false);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].action, 'rollback');
});

test('tick should recover from cooldown and later promote to full', async () => {
    const h = createHarness({
        features: {
            stageWeighting: false,
            lifecycleHysteresis: true,
            honorPromotionTuning: false,
        },
        state: {
            mode: 'COOLDOWN',
            stable_since: null,
            cooldown_until: '2026-03-16T11:00:00.000Z',
        },
        metrics: {
            activeNow: 100,
            l2Total: 40,
            l2Success: 32,
            l2Rate: 0.8,
            retired24h: 1,
        },
        nowSeq: [
            '2026-03-16T12:00:00.000Z',
            '2026-03-18T13:00:00.000Z',
        ],
    });

    const recover = await h.orchestrator.tick({ trigger: 'manual' });
    assert.equal(recover.action, 'cooldown_recover');
    assert.equal(recover.state.mode, 'SAFE');
    assert.equal(h.config.rollout.features.stageWeighting, true);
    assert.equal(h.config.rollout.features.honorPromotionTuning, false);

    const promote = await h.orchestrator.tick({ trigger: 'manual' });
    assert.equal(promote.action, 'promote_full');
    assert.equal(promote.state.mode, 'FULL');
    assert.equal(h.config.rollout.features.honorPromotionTuning, true);
});

test('tick should skip when lease is not acquired', async () => {
    const h = createHarness({
        leaseAllowed: false,
    });
    const out = await h.orchestrator.tick({ trigger: 'manual' });
    assert.equal(out.ok, true);
    assert.equal(out.skipped, 'lease');
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].action, 'skip_lease');
});

test('start/stop should handle disabled and timer branches', async () => {
    const disabled = createHarness({
        orchestrator: { enabled: false },
    });
    await disabled.orchestrator.start();
    assert.equal(disabled.orchestrator.started, false);
    assert.equal(disabled.logs.some((x) => String(x.result || '').includes('自动编排已关闭')), true);

    const h = createHarness({
        nowSeq: ['2026-03-16T12:00:00.000Z'],
    });
    const oldSetInterval = global.setInterval;
    const oldClearInterval = global.clearInterval;
    const ids = [];
    global.setInterval = (fn) => {
        ids.push(fn);
        return { __id: 1 };
    };
    global.clearInterval = () => {};
    try {
        await h.orchestrator.start();
        assert.equal(h.orchestrator.started, true);
        assert.equal(ids.length >= 1, true);
        ids[0]();
        await h.orchestrator.start();
        await h.orchestrator.stop();
        assert.equal(h.orchestrator.started, false);
    } finally {
        global.setInterval = oldSetInterval;
        global.clearInterval = oldClearInterval;
    }
});

test('tick should cover inflight full hold full realign and safe hold', async () => {
    const inflight = createHarness();
    inflight.orchestrator.tickRunning = true;
    const inflightOut = await inflight.orchestrator.tick({ trigger: 'manual' });
    assert.equal(inflightOut.skipped, 'inflight');
    inflight.orchestrator.tickRunning = false;

    const fullHold = createHarness({
        features: {
            stageWeighting: true,
            lifecycleHysteresis: true,
            honorPromotionTuning: true,
        },
        state: { mode: 'FULL', stable_since: '2026-03-14T00:00:00.000Z' },
        metrics: { l2Total: 50, l2Success: 40, l2Rate: 0.8, retired24h: 1 },
    });
    const fullHoldOut = await fullHold.orchestrator.tick({ trigger: 'manual' });
    assert.equal(fullHoldOut.action, 'full_hold');

    const fullRealign = createHarness({
        features: {
            stageWeighting: false,
            lifecycleHysteresis: true,
            honorPromotionTuning: true,
        },
        state: { mode: 'FULL', stable_since: '2026-03-14T00:00:00.000Z' },
        metrics: { l2Total: 50, l2Success: 40, l2Rate: 0.8, retired24h: 1 },
    });
    const fullRealignOut = await fullRealign.orchestrator.tick({ trigger: 'manual' });
    assert.equal(fullRealignOut.action, 'full_realign');
    assert.equal(fullRealign.config.rollout.features.stageWeighting, true);

    const safeHold = createHarness({
        features: SAFE_FEATURES,
        state: { mode: 'SAFE', stable_since: '2026-03-16T11:00:00.000Z' },
        metrics: { l2Total: 10, l2Success: 9, l2Rate: 0.9, retired24h: 1 },
        nowSeq: ['2026-03-16T12:00:00.000Z'],
    });
    const safeHoldOut = await safeHold.orchestrator.tick({ trigger: 'manual' });
    assert.equal(safeHoldOut.action, 'safe_hold');
});

test('tick should cover cooldown_hold and safe_realign branches', async () => {
    const cooldownHold = createHarness({
        state: {
            mode: 'COOLDOWN',
            stable_since: null,
            cooldown_until: '2026-03-16T13:00:00.000Z',
        },
        nowSeq: ['2026-03-16T12:00:00.000Z'],
        metrics: { l2Total: 100, l2Success: 80, l2Rate: 0.8, retired24h: 1 },
    });
    const holdOut = await cooldownHold.orchestrator.tick({ trigger: 'manual' });
    assert.equal(holdOut.action, 'cooldown_hold');

    const safeRealign = createHarness({
        features: {
            stageWeighting: false,
            lifecycleHysteresis: true,
            honorPromotionTuning: false,
        },
        state: {
            mode: 'SAFE',
            stable_since: '2026-03-16T11:00:00.000Z',
        },
        nowSeq: ['2026-03-16T12:00:00.000Z'],
        metrics: { l2Total: 1, l2Success: 1, l2Rate: 1, retired24h: 1 },
    });
    const realignOut = await safeRealign.orchestrator.tick({ trigger: 'manual' });
    assert.equal(realignOut.action, 'safe_realign');
    assert.equal(safeRealign.config.rollout.features.stageWeighting, true);
});

test('tick should default lease to true and handle error branch', async () => {
    const leaseDefault = createHarness({
        state: {
            mode: 'SAFE',
            stable_since: '2026-03-16T11:59:00.000Z',
        },
        metrics: {
            l2Total: 1,
            l2Success: 1,
            l2Rate: 1,
        },
        dbOverrides: {
            acquireRolloutSwitchLease: undefined,
        },
    });
    const out = await leaseDefault.orchestrator.tick({ trigger: 'manual' });
    assert.equal(out.ok, true);
    assert.equal(out.action, 'safe_hold');

    const err = createHarness({
        dbOverrides: {
            acquireRolloutSwitchLease: () => {
                throw new Error('lease-broken');
            },
        },
    });
    const errOut = await err.orchestrator.tick({ trigger: 'manual' });
    assert.equal(errOut.ok, false);
    assert.equal(errOut.error, 'lease-broken');
    assert.equal(err.events.some((x) => x.action === 'error'), true);
    assert.equal(err.logs.some((x) => String(x.result || '').includes('自动编排失败')), true);
});

test('tick should fallback to default state when db state is missing', async () => {
    const h = createHarness({
        state: {
            mode: 'SAFE',
            stable_since: '2026-03-16T11:59:00.000Z',
        },
        dbOverrides: {
            getRolloutSwitchState: () => null,
        },
        nowSeq: ['2026-03-16T12:00:00.000Z'],
        metrics: { l2Total: 1, l2Success: 1, l2Rate: 1, retired24h: 1 },
    });

    const out = await h.orchestrator.tick({ trigger: 'manual' });
    assert.equal(out.ok, true);
    assert.equal(out.state.mode, 'SAFE');
    assert.equal(out.state.last_error, null);
});

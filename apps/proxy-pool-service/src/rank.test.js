const test = require('node:test');
const assert = require('node:assert/strict');
const { safeParseJson, evaluateCombat, evaluateStateTransition } = require('./rank');

// 0089_baseConfig_配置逻辑
function baseConfig() {
    return {
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
            honors: {
                steelStreak: 3,
                riskyWarrior: 3,
                thousandService: 10,
            },
        },
    };
}

// 0090A_enableHysteresis_启用滞回配置逻辑
function enableHysteresis(cfg) {
    cfg.rollout = {
        features: {
            stageWeighting: true,
            lifecycleHysteresis: true,
            honorPromotionTuning: true,
        },
    };
    cfg.policy.lifecycle = {
        transitionWindowSize: 20,
        minSamplesForTransition: 3,
        minStateStayMinutes: 0,
        activeToReserveHealthThreshold: 50,
        activeToReserveFailRatio: 0.8,
        activeToReserveConsecutiveFail: 2,
        reserveToActiveHealthThreshold: 60,
        reserveToActiveSuccessRatio: 0.35,
        reserveToActiveSuccessCount: 2,
        reserveToActiveRecentL1SuccessWindowMin: 60,
        reserveToActiveRecentL1BypassSuccessCount: 4,
    };
}

// 0090_baseProxy_代理逻辑
function baseProxy() {
    return {
        id: 1,
        display_name: '苍隼-北辰-01',
        lifecycle: 'candidate',
        rank: '新兵',
        service_hours: 0,
        rank_service_hours: 0,
        combat_points: 0,
        health_score: 60,
        discipline_score: 100,
        success_count: 0,
        block_count: 0,
        timeout_count: 0,
        network_error_count: 0,
        invalid_feedback_count: 0,
        total_samples: 0,
        consecutive_success: 0,
        consecutive_fail: 0,
        risky_success_count: 0,
        retired_type: null,
        promotion_protect_until: null,
        recent_window_json: '[]',
        honor_history_json: '[]',
        honor_active_json: '[]',
        last_checked_at: new Date(Date.now() - 3600_000).toISOString(),
    };
}

test('success outcome should increase points and samples', () => {
    const cfg = baseConfig();
    const proxy = baseProxy();
    const now = new Date().toISOString();
    const result = evaluateCombat({ proxy, outcome: 'success', latencyMs: 900, nowIso: now, config: cfg });

    assert.equal(result.updates.total_samples, 1);
    assert.ok(result.updates.combat_points >= 6);
    assert.equal(result.updates.success_count, 1);
    assert.equal(result.updates.lifecycle, 'active');
});

test('success should use fixed score mapping', () => {
    const cfg = baseConfig();
    const result = evaluateCombat({
        proxy: baseProxy(),
        outcome: 'success',
        latencyMs: 1500,
        nowIso: new Date().toISOString(),
        config: cfg,
    });

    assert.equal(result.updates.combat_points, 6);
});

test('success should apply latency bonus branches', () => {
    const cfg = baseConfig();
    cfg.policy.scoring.successFastBonusLt1200 = 2;
    cfg.policy.scoring.successFastBonusLt2500 = 1;

    const fast = evaluateCombat({
        proxy: baseProxy(),
        outcome: 'success',
        latencyMs: 900,
        nowIso: new Date().toISOString(),
        config: cfg,
    });
    const medium = evaluateCombat({
        proxy: baseProxy(),
        outcome: 'success',
        latencyMs: 1800,
        nowIso: new Date().toISOString(),
        config: cfg,
    });
    const slow = evaluateCombat({
        proxy: baseProxy(),
        outcome: 'success',
        latencyMs: 3000,
        nowIso: new Date().toISOString(),
        config: cfg,
    });

    assert.equal(fast.updates.combat_points, 8);
    assert.equal(medium.updates.combat_points, 7);
    assert.equal(slow.updates.combat_points, 6);
});

test('should promote when hours, points and samples all pass thresholds', () => {
    const cfg = baseConfig();
    const proxy = {
        ...baseProxy(),
        rank_service_hours: 1.2,
        combat_points: 8,
        total_samples: 2,
        rank: '新兵',
    };

    const result = evaluateCombat({
        proxy,
        outcome: 'success',
        latencyMs: 1000,
        nowIso: new Date().toISOString(),
        config: cfg,
    });

    assert.equal(result.updates.rank, '列兵');
    assert.ok(result.events.some((e) => e.event_type === 'promotion'));
});

test('severe blocked ratio should trigger demotion even in protection window', () => {
    const cfg = baseConfig();
    const now = new Date();
    const records = [
        { t: now.toISOString(), o: 'blocked' },
        { t: new Date(now.getTime() - 5 * 60_000).toISOString(), o: 'blocked' },
        { t: new Date(now.getTime() - 10 * 60_000).toISOString(), o: 'blocked' },
        { t: new Date(now.getTime() - 15 * 60_000).toISOString(), o: 'success' },
    ];

    const proxy = {
        ...baseProxy(),
        rank: '士官',
        promotion_protect_until: new Date(now.getTime() + 4 * 3600_000).toISOString(),
        recent_window_json: JSON.stringify(records),
        total_samples: 50,
    };

    const result = evaluateCombat({
        proxy,
        outcome: 'blocked',
        latencyMs: 2000,
        nowIso: now.toISOString(),
        config: cfg,
    });

    assert.equal(result.updates.rank, '列兵');
    assert.ok(result.events.some((e) => e.event_type === 'demotion'));
});

test('regular demotion should happen outside protection window', () => {
    const cfg = baseConfig();
    const now = new Date();
    const records = [
        { t: now.toISOString(), o: 'blocked' },
        { t: now.toISOString(), o: 'blocked' },
        { t: now.toISOString(), o: 'blocked' },
        { t: now.toISOString(), o: 'success' },
    ];

    const proxy = {
        ...baseProxy(),
        rank: '士官',
        promotion_protect_until: new Date(now.getTime() - 3600_000).toISOString(),
        recent_window_json: JSON.stringify(records),
        total_samples: 20,
    };

    const result = evaluateCombat({
        proxy,
        outcome: 'blocked',
        latencyMs: 1000,
        nowIso: now.toISOString(),
        config: cfg,
    });

    assert.equal(result.updates.rank, '列兵');
});

test('timeout and network error outcomes should update counters', () => {
    const cfg = baseConfig();

    const timeoutResult = evaluateCombat({
        proxy: baseProxy(),
        outcome: 'timeout',
        latencyMs: 2600,
        nowIso: new Date().toISOString(),
        config: cfg,
    });
    assert.equal(timeoutResult.updates.timeout_count, 1);

    const networkResult = evaluateCombat({
        proxy: baseProxy(),
        outcome: 'network_error',
        latencyMs: 500,
        nowIso: new Date().toISOString(),
        config: cfg,
    });
    assert.equal(networkResult.updates.network_error_count, 1);
});

test('invalid feedback should lower discipline and retire by discipline', () => {
    const cfg = baseConfig();
    const proxy = {
        ...baseProxy(),
        discipline_score: 45,
        invalid_feedback_count: 1,
        total_samples: 10,
        rank: '列兵',
        lifecycle: 'active',
    };

    const result = evaluateCombat({
        proxy,
        outcome: 'invalid_payload',
        latencyMs: 0,
        nowIso: new Date().toISOString(),
        config: cfg,
    });

    assert.equal(result.updates.lifecycle, 'retired');
    assert.equal(result.updates.retired_type, '纪律退伍');
});

test('battle damage retirement should trigger', () => {
    const cfg = baseConfig();
    const now = new Date().toISOString();
    const records = Array.from({ length: 19 }, () => ({ t: now, o: 'blocked' }));
    records.push({ t: now, o: 'success' });
    const proxy = {
        ...baseProxy(),
        lifecycle: 'active',
        health_score: 18,
        rank: '列兵',
        total_samples: 100,
        success_count: 50,
        recent_window_json: JSON.stringify(records),
    };

    const result = evaluateCombat({
        proxy,
        outcome: 'blocked',
        latencyMs: 900,
        nowIso: now,
        config: cfg,
    });

    assert.equal(result.updates.retired_type, '战损退伍');
});

test('technical retirement should trigger on low success ratio', () => {
    const cfg = baseConfig();
    const now = new Date().toISOString();
    const proxy = {
        ...baseProxy(),
        lifecycle: 'active',
        total_samples: 7,
        success_count: 0,
        rank: '列兵',
        recent_window_json: JSON.stringify([
            { t: now, o: 'blocked' },
            { t: now, o: 'blocked' },
            { t: now, o: 'timeout' },
            { t: now, o: 'network_error' },
        ]),
    };

    const result = evaluateCombat({
        proxy,
        outcome: 'blocked',
        latencyMs: 900,
        nowIso: now,
        config: cfg,
    });

    assert.equal(result.updates.retired_type, '技术退伍');
});

test('honor retirement should trigger when contribution is high', () => {
    const cfg = baseConfig();
    const proxy = {
        ...baseProxy(),
        lifecycle: 'active',
        rank: '尉官',
        service_hours: 800,
        success_count: 850,
        health_score: 88,
        total_samples: 900,
    };

    const result = evaluateCombat({
        proxy,
        outcome: 'success',
        latencyMs: 1000,
        nowIso: new Date().toISOString(),
        config: cfg,
    });

    assert.equal(result.updates.retired_type, '荣誉退伍');
});

test('steel streak honor should be awarded', () => {
    const cfg = baseConfig();
    const proxy = {
        ...baseProxy(),
        consecutive_success: 2,
        total_samples: 100,
        success_count: 100,
        rank: '士官',
    };

    const result = evaluateCombat({
        proxy,
        outcome: 'success',
        latencyMs: 500,
        nowIso: new Date().toISOString(),
        config: cfg,
    });

    assert.ok(result.awards.some((a) => a.type === '钢铁连胜'));
    assert.ok(result.events.some((e) => e.event_type === 'honor'));
});

test('risky warrior and thousand service honors should be awarded and active', () => {
    const cfg = baseConfig();
    const now = new Date().toISOString();
    const proxy = {
        ...baseProxy(),
        total_samples: 9,
        risky_success_count: 2,
        consecutive_success: 5,
        honor_history_json: JSON.stringify(['钢铁连胜']),
        recent_window_json: JSON.stringify([
            { t: now, o: 'blocked' },
            { t: now, o: 'blocked' },
            { t: now, o: 'blocked' },
            { t: now, o: 'blocked' },
            { t: now, o: 'blocked' },
            { t: now, o: 'blocked' },
            { t: now, o: 'blocked' },
            { t: now, o: 'success' },
            { t: now, o: 'success' },
        ]),
    };

    const result = evaluateCombat({
        proxy,
        outcome: 'success',
        latencyMs: 1000,
        nowIso: now,
        config: cfg,
    });

    const awardTypes = result.awards.map((a) => a.type);
    assert.equal(awardTypes.includes('逆风勇士'), true);
    assert.equal(awardTypes.includes('千次服役'), true);
    assert.equal(JSON.parse(result.updates.honor_active_json).includes('逆风勇士'), true);
});

test('combat events should include v1.1 details version', () => {
    const cfg = baseConfig();
    const nowIso = new Date().toISOString();
    const proxy = {
        ...baseProxy(),
        rank: '新兵',
        rank_service_hours: 1.2,
        combat_points: 8,
        total_samples: 2,
    };
    const result = evaluateCombat({
        proxy,
        outcome: 'success',
        latencyMs: 800,
        nowIso,
        config: cfg,
    });

    const promotion = result.events.find((item) => item.event_type === 'promotion');
    assert.equal(Boolean(promotion), true);
    assert.equal(promotion.details.version, 'v1.1');
});

test('invalid json in history fields should fallback safely', () => {
    const cfg = baseConfig();
    const proxy = {
        ...baseProxy(),
        recent_window_json: '{invalid}',
        honor_history_json: '{invalid}',
    };

    const result = evaluateCombat({
        proxy,
        outcome: 'success',
        latencyMs: 900,
        nowIso: new Date().toISOString(),
        config: cfg,
    });

    assert.equal(result.updates.total_samples, 1);
});

test('state transition should move active to reserve when health too low', () => {
    const cfg = baseConfig();
    const proxy = {
        ...baseProxy(),
        lifecycle: 'active',
        health_score: 40,
        recent_window_json: JSON.stringify([
            { t: new Date().toISOString(), o: 'blocked' },
            { t: new Date().toISOString(), o: 'blocked' },
            { t: new Date().toISOString(), o: 'blocked' },
        ]),
    };

    const result = evaluateStateTransition({
        proxy,
        nowIso: new Date().toISOString(),
        config: cfg,
    });

    assert.equal(result.updates.lifecycle, 'reserve');
    assert.equal(result.change, 'active_to_reserve');
});

test('state transition should move reserve to active', () => {
    const cfg = baseConfig();
    const proxy = {
        ...baseProxy(),
        lifecycle: 'reserve',
        health_score: 70,
        recent_window_json: JSON.stringify([
            { t: new Date().toISOString(), o: 'success' },
            { t: new Date().toISOString(), o: 'success' },
            { t: new Date().toISOString(), o: 'blocked' },
        ]),
    };

    const result = evaluateStateTransition({
        proxy,
        nowIso: new Date().toISOString(),
        config: cfg,
    });

    assert.equal(result.updates.lifecycle, 'active');
    assert.equal(result.change, 'reserve_to_active');
});

test('state transition should retire by discipline', () => {
    const cfg = baseConfig();
    const proxy = {
        ...baseProxy(),
        lifecycle: 'active',
        discipline_score: 10,
    };

    const result = evaluateStateTransition({
        proxy,
        nowIso: new Date().toISOString(),
        config: cfg,
    });

    assert.equal(result.updates.lifecycle, 'retired');
    assert.equal(result.change, 'retire_discipline');
});

test('evaluateCombat should handle unknown rank/lifecycle and null scores', () => {
    const cfg = baseConfig();
    const proxy = {
        ...baseProxy(),
        rank: '未知军衔',
        lifecycle: undefined,
        health_score: null,
        discipline_score: null,
        recent_window_json: '',
        honor_history_json: '',
    };

    const result = evaluateCombat({
        proxy,
        outcome: 'unknown-outcome',
        latencyMs: 0,
        nowIso: new Date().toISOString(),
        config: cfg,
    });

    assert.equal(result.updates.rank, '未知军衔');
    assert.equal(result.updates.lifecycle, 'candidate');
    assert.equal(result.updates.discipline_score <= 100, true);
    assert.equal(typeof result.updates.ip_value_score, 'number');
    assert.equal(typeof result.updates.ip_value_breakdown_json, 'string');
});

test('safeParseJson should return parsed object when fallback is object', () => {
    const parsed = safeParseJson('{"a":1}', {});
    assert.equal(parsed.a, 1);
    const fallback = safeParseJson('{"a":1}', []);
    assert.deepEqual(fallback, []);
});

test('evaluateCombat should fallback rank when proxy rank is missing', () => {
    const cfg = baseConfig();
    const proxy = {
        ...baseProxy(),
        rank: '',
    };

    const result = evaluateCombat({
        proxy,
        outcome: 'success',
        latencyMs: 800,
        nowIso: new Date().toISOString(),
        config: cfg,
    });

    assert.equal(result.updates.rank === '新兵' || result.updates.rank === '列兵', true);
});

test('state transition updates should include value score fields', () => {
    const cfg = baseConfig();
    const proxy = {
        ...baseProxy(),
        lifecycle: 'reserve',
        health_score: 70,
        recent_window_json: JSON.stringify([
            { t: new Date().toISOString(), o: 'success' },
            { t: new Date().toISOString(), o: 'success' },
        ]),
    };
    const result = evaluateStateTransition({
        proxy,
        nowIso: new Date().toISOString(),
        config: cfg,
    });
    assert.equal(typeof result.updates.ip_value_score, 'number');
    assert.equal(typeof result.updates.ip_value_breakdown_json, 'string');
});

test('hysteresis combat should move candidate to active and active to reserve', () => {
    const cfg = baseConfig();
    enableHysteresis(cfg);
    const now = new Date().toISOString();

    const candidate = evaluateCombat({
        proxy: baseProxy(),
        outcome: 'success',
        latencyMs: 100,
        nowIso: now,
        config: cfg,
    });
    assert.equal(candidate.updates.lifecycle, 'active');
    assert.equal(candidate.updates.lifecycle_changed_at, now);

    const activeProxy = {
        ...baseProxy(),
        lifecycle: 'active',
        health_score: 40,
        consecutive_fail: 2,
        recent_window_json: JSON.stringify([
            { t: now, o: 'blocked' },
            { t: now, o: 'blocked' },
            { t: now, o: 'blocked' },
        ]),
    };
    const demoteLifecycle = evaluateCombat({
        proxy: activeProxy,
        outcome: 'blocked',
        latencyMs: 200,
        nowIso: now,
        config: cfg,
    });
    assert.equal(demoteLifecycle.updates.lifecycle, 'reserve');
    assert.equal(demoteLifecycle.updates.lifecycle_changed_at, now);
});

test('hysteresis state transition should support reserve to active by recent L1 and bypass count', () => {
    const cfg = baseConfig();
    enableHysteresis(cfg);
    const nowIso = '2026-03-16T12:00:00.000Z';

    const reserveRecent = evaluateStateTransition({
        proxy: {
            ...baseProxy(),
            lifecycle: 'reserve',
            health_score: 80,
            lifecycle_changed_at: '2026-03-16T10:00:00.000Z',
            last_l1_success_at: '2026-03-16T11:40:00.000Z',
            recent_window_json: JSON.stringify([
                { t: nowIso, o: 'success' },
                { t: nowIso, o: 'success' },
                { t: nowIso, o: 'blocked' },
            ]),
        },
        nowIso,
        config: cfg,
    });
    assert.equal(reserveRecent.change, 'reserve_to_active');
    assert.equal(reserveRecent.updates.lifecycle, 'active');

    const reserveBypass = evaluateStateTransition({
        proxy: {
            ...baseProxy(),
            lifecycle: 'reserve',
            health_score: 80,
            lifecycle_changed_at: '2026-03-16T10:00:00.000Z',
            last_l1_success_at: '2026-03-16T07:00:00.000Z',
            recent_window_json: JSON.stringify([
                { t: nowIso, o: 'success' },
                { t: nowIso, o: 'success' },
                { t: nowIso, o: 'success' },
                { t: nowIso, o: 'success' },
            ]),
        },
        nowIso,
        config: cfg,
    });
    assert.equal(reserveBypass.change, 'reserve_to_active');
    assert.equal(reserveBypass.updates.lifecycle, 'active');
});

test('hysteresis state transition should move active to reserve when health drops', () => {
    const cfg = baseConfig();
    enableHysteresis(cfg);
    const nowIso = '2026-03-16T12:00:00.000Z';

    const result = evaluateStateTransition({
        proxy: {
            ...baseProxy(),
            lifecycle: 'active',
            health_score: 45,
            lifecycle_changed_at: '2026-03-16T09:00:00.000Z',
            recent_window_json: JSON.stringify([
                { t: nowIso, o: 'blocked' },
                { t: nowIso, o: 'blocked' },
                { t: nowIso, o: 'blocked' },
            ]),
        },
        nowIso,
        config: cfg,
    });
    assert.equal(result.change, 'active_to_reserve');
    assert.equal(result.updates.lifecycle, 'reserve');
});

test('hysteresis fail-ratio branches should demote lifecycle with high fail windows', () => {
    const cfg = baseConfig();
    enableHysteresis(cfg);
    const nowIso = '2026-03-16T12:00:00.000Z';

    const combatResult = evaluateCombat({
        proxy: {
            ...baseProxy(),
            lifecycle: 'active',
            health_score: 90,
            consecutive_fail: 1,
            recent_window_json: JSON.stringify([
                { t: nowIso, o: 'blocked' },
                { t: nowIso, o: 'blocked' },
                { t: nowIso, o: 'blocked' },
            ]),
        },
        outcome: 'blocked',
        latencyMs: 200,
        nowIso,
        config: cfg,
    });
    assert.equal(combatResult.updates.lifecycle, 'reserve');

    const stateResult = evaluateStateTransition({
        proxy: {
            ...baseProxy(),
            lifecycle: 'active',
            health_score: 90,
            consecutive_fail: 3,
            lifecycle_changed_at: '2026-03-16T09:00:00.000Z',
            recent_window_json: JSON.stringify([
                { t: nowIso, o: 'blocked' },
                { t: nowIso, o: 'blocked' },
                { t: nowIso, o: 'blocked' },
            ]),
        },
        nowIso,
        config: cfg,
    });
    assert.equal(stateResult.change, 'active_to_reserve');
});

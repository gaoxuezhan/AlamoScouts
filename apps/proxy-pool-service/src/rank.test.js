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

test('combat should prefer active to reserve when retired_spike guard is enabled', () => {
    const cfg = baseConfig();
    cfg.rollout = {
        runtime: {
            preferReserveBeforeRetire: true,
        },
    };
    const proxy = {
        ...baseProxy(),
        lifecycle: 'active',
        health_score: 90,
        discipline_score: 35,
        invalid_feedback_count: 1,
        total_samples: 5,
    };

    const result = evaluateCombat({
        proxy,
        outcome: 'invalid_payload',
        latencyMs: 0,
        nowIso: '2026-03-16T12:00:00.000Z',
        config: cfg,
    });

    assert.equal(result.updates.lifecycle, 'reserve');
    assert.equal(result.updates.retired_type, null);
    assert.equal(result.events.some((item) => item.event_type === 'state_transition' && item.details.trigger === 'retired_spike_guard'), true);
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

test('honor retirement should also allow school-rank officers', () => {
    const cfg = baseConfig();
    const proxy = {
        ...baseProxy(),
        lifecycle: 'active',
        rank: '校官',
        service_hours: 760,
        success_count: 830,
        health_score: 90,
        total_samples: 860,
    };

    const result = evaluateCombat({
        proxy,
        outcome: 'success',
        latencyMs: 900,
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

test('l2 mastery and discipline guard honors should be awarded and active', () => {
    const cfg = baseConfig();
    cfg.policy.honors.l2Mastery = 2;
    cfg.policy.honors.disciplineGuardMinScore = 95;
    cfg.policy.honors.disciplineGuardMaxInvalid = 0;
    cfg.policy.honors.disciplineGuardMinSamples = 6;

    const now = new Date().toISOString();
    const proxy = {
        ...baseProxy(),
        lifecycle: 'active',
        rank: '校官',
        total_samples: 5,
        success_count: 5,
        discipline_score: 100,
        invalid_feedback_count: 0,
        battle_success_count: 1,
        battle_fail_count: 0,
        honor_history_json: JSON.stringify([]),
    };

    const result = evaluateCombat({
        proxy,
        outcome: 'success',
        latencyMs: 1100,
        nowIso: now,
        stage: 'l2',
        config: cfg,
    });

    const awardTypes = result.awards.map((a) => a.type);
    const activeHonors = JSON.parse(result.updates.honor_active_json);
    assert.equal(result.updates.battle_success_count, 2);
    assert.equal(awardTypes.includes('攻坚大师'), true);
    assert.equal(awardTypes.includes('铁纪标兵'), true);
    assert.equal(activeHonors.includes('攻坚大师'), true);
    assert.equal(activeHonors.includes('铁纪标兵'), true);
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

test('state transition should prefer active to reserve guard when retired_spike guard is enabled', () => {
    const cfg = baseConfig();
    cfg.rollout = {
        runtime: {
            preferReserveBeforeRetire: true,
        },
    };
    const proxy = {
        ...baseProxy(),
        lifecycle: 'active',
        discipline_score: 10,
    };

    const result = evaluateStateTransition({
        proxy,
        nowIso: '2026-03-16T12:00:00.000Z',
        config: cfg,
    });

    assert.equal(result.updates.lifecycle, 'reserve');
    assert.equal(result.change, 'active_to_reserve_guard');
    assert.equal(result.eventDetails.trigger, 'retired_spike_guard');
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

test('combat should use legacy fallback thresholds when honor tuning is enabled', () => {
    const cfg = baseConfig();
    enableHysteresis(cfg);
    const fallbackRanks = cfg.policy.ranks;
    cfg.policy.ranks = null;
    cfg.policy.honors = null;
    cfg.policy.legacy = {
        ranks: fallbackRanks,
        honors: {
            steelStreak: 1,
            riskyWarrior: 1,
            thousandService: 1,
            riskyFailRatioThreshold: 0,
        },
    };
    cfg.policy.serviceHourScale = 0;
    cfg.policy.promotionProtectHours = 0;

    const nowIso = '2026-03-16T12:00:00.000Z';
    const result = evaluateCombat({
        proxy: {
            ...baseProxy(),
            lifecycle: 'active',
            rank: '新兵',
            rank_service_hours: 1,
            combat_points: 8,
            total_samples: 9,
            success_count: 3,
            consecutive_success: 0,
            risky_success_count: 0,
            last_checked_at: '2026-03-16T11:00:00.000Z',
            recent_window_json: '[]',
        },
        outcome: 'success',
        latencyMs: 800,
        nowIso,
        config: cfg,
    });

    assert.equal(result.updates.rank, '列兵');
    assert.equal(result.updates.service_hours, 1);
    assert.equal(result.awards.some((a) => a.type === '钢铁连胜'), true);
    assert.equal(result.awards.some((a) => a.type === '逆风勇士'), true);
    assert.equal(result.awards.some((a) => a.type === '千次服役'), true);
});

test('combat should keep steel and risky honors inactive when thresholds are missing', () => {
    const cfg = baseConfig();
    enableHysteresis(cfg);
    cfg.policy.honors = null;
    cfg.policy.legacy = {
        ...(cfg.policy.legacy || {}),
        ranks: cfg.policy.ranks,
        honors: null,
    };

    const nowIso = '2026-03-16T12:00:00.000Z';
    const result = evaluateCombat({
        proxy: {
            ...baseProxy(),
            lifecycle: 'active',
            rank: '士官',
            total_samples: 999,
            success_count: 800,
            consecutive_success: 998,
            risky_success_count: 998,
            honor_history_json: JSON.stringify(['钢铁连胜', '逆风勇士', '千次服役']),
            recent_window_json: JSON.stringify([{ t: nowIso, o: 'success' }]),
        },
        outcome: 'success',
        latencyMs: 500,
        nowIso,
        config: cfg,
    });

    assert.equal(result.awards.length, 0);
    assert.deepEqual(JSON.parse(result.updates.honor_active_json), ['千次服役']);
});

test('combat should apply retirement fallbacks when policy values are absent', () => {
    const cfg = baseConfig();
    enableHysteresis(cfg);
    cfg.policy.retirement = {
        disciplineThreshold: 0,
        disciplineInvalidCount: 99,
        technicalEligibleLifecycles: undefined,
        technicalMinSamples: undefined,
        technicalSuccessRatio: undefined,
        battleDamageFailRatio: undefined,
        battleDamageBlockedRatio: undefined,
        battleDamageMinSamples: undefined,
        honorMinServiceHours: undefined,
        honorMinSuccess: undefined,
    };
    cfg.policy.demotion.lowHealthRetireThreshold = 0;

    const result = evaluateCombat({
        proxy: {
            ...baseProxy(),
            lifecycle: 'active',
            rank: '列兵',
            total_samples: 79,
            success_count: 0,
            health_score: 90,
        },
        outcome: 'blocked',
        latencyMs: 500,
        nowIso: '2026-03-16T12:00:00.000Z',
        config: cfg,
    });

    assert.equal(result.updates.lifecycle, 'retired');
    assert.equal(result.updates.retired_type, '技术退伍');
});

test('combat should handle non-positive sample edge for overall success ratio fallback', () => {
    const cfg = baseConfig();
    const result = evaluateCombat({
        proxy: {
            ...baseProxy(),
            lifecycle: 'reserve',
            rank: '列兵',
            total_samples: -1,
            success_count: 0,
        },
        outcome: 'blocked',
        latencyMs: 600,
        nowIso: '2026-03-16T12:00:00.000Z',
        config: cfg,
    });

    assert.equal(result.updates.total_samples, 0);
    assert.equal(result.updates.rank, '列兵');
});

test('state transition should use hysteresis defaults with sparse policy and fallback timestamps', () => {
    const nowIso = '2026-03-16T12:00:00.000Z';
    const cfg = {
        rollout: {
            features: {
                lifecycleHysteresis: true,
            },
        },
        policy: {},
    };

    const activeResult = evaluateStateTransition({
        proxy: {
            ...baseProxy(),
            lifecycle: 'active',
            health_score: 49,
            lifecycle_changed_at: null,
            updated_at: '2026-03-16T10:00:00.000Z',
            recent_window_json: JSON.stringify([{ t: nowIso, o: 'blocked' }]),
        },
        nowIso,
        config: cfg,
    });
    assert.equal(activeResult.change, 'active_to_reserve');

    const reserveResult = evaluateStateTransition({
        proxy: {
            ...baseProxy(),
            lifecycle: 'reserve',
            health_score: 70,
            lifecycle_changed_at: null,
            updated_at: null,
            last_checked_at: '2026-03-16T10:00:00.000Z',
            last_l1_success_at: 'invalid-date',
            recent_window_json: JSON.stringify(Array.from({ length: 20 }, () => ({ t: nowIso, o: 'success' }))),
        },
        nowIso,
        config: cfg,
    });
    assert.equal(reserveResult.change, 'reserve_to_active');
});

test('state transition legacy and discipline fallback branches should be covered', () => {
    const cfg = baseConfig();
    const nowIso = '2026-03-16T12:00:00.000Z';

    const activeByBlocked = evaluateStateTransition({
        proxy: {
            ...baseProxy(),
            lifecycle: 'active',
            health_score: 0,
            discipline_score: 100,
            recent_window_json: JSON.stringify([
                { t: nowIso, o: 'blocked' },
                { t: nowIso, o: 'blocked' },
                { t: nowIso, o: 'success' },
            ]),
        },
        nowIso,
        config: cfg,
    });
    assert.equal(activeByBlocked.change, 'active_to_reserve');
    assert.equal(activeByBlocked.eventDetails.metrics.healthScore, 0);
    assert.equal(activeByBlocked.eventDetails.metrics.disciplineScore, 100);

    const reserveToActive = evaluateStateTransition({
        proxy: {
            ...baseProxy(),
            lifecycle: 'reserve',
            health_score: 70,
            recent_window_json: JSON.stringify([
                { t: nowIso, o: 'success' },
                { t: nowIso, o: 'success' },
                { t: nowIso, o: 'blocked' },
            ]),
        },
        nowIso,
        config: cfg,
    });
    assert.equal(reserveToActive.change, 'reserve_to_active');

    const retireByInvalid = evaluateStateTransition({
        proxy: {
            ...baseProxy(),
            lifecycle: 'active',
            discipline_score: 0,
            invalid_feedback_count: 5,
        },
        nowIso,
        config: cfg,
    });
    assert.equal(retireByInvalid.change, 'retire_discipline');
    assert.equal(retireByInvalid.eventDetails.metrics.disciplineScore, 0);
});

test('combat should fallback to empty honors when legacy and primary honors are absent', () => {
    const cfg = baseConfig();
    cfg.policy.honors = null;
    cfg.policy.legacy = {
        ranks: cfg.policy.ranks,
        honors: null,
    };

    const result = evaluateCombat({
        proxy: {
            ...baseProxy(),
            lifecycle: 'active',
            rank: '士官',
            honor_history_json: JSON.stringify(['钢铁连胜', '逆风勇士']),
        },
        outcome: 'success',
        latencyMs: 800,
        nowIso: '2026-03-16T12:00:00.000Z',
        config: cfg,
    });

    assert.equal(result.awards.length, 0);
    assert.deepEqual(JSON.parse(result.updates.honor_active_json), []);
});

test('combat should cover severe-window and health-threshold fallback branches', () => {
    const cfg = baseConfig();
    cfg.policy.demotion = {
        regularWindowSize: 20,
        regularMinSamples: 1,
        regularFailRatio: 1.1,
        severeWindowMinutes: 'not-a-number',
        severeMinSamples: 999,
        severeFailRatio: 1,
        healthThreshold: null,
        lowHealthRetireThreshold: 0,
    };
    cfg.policy.retirement = {
        technicalEligibleLifecycles: 'active',
        technicalMinSamples: 999,
        technicalSuccessRatio: 0,
    };

    const result = evaluateCombat({
        proxy: {
            ...baseProxy(),
            lifecycle: 'active',
            rank: '士官',
            health_score: 20,
            recent_window_json: JSON.stringify([{ t: '2026-03-16T12:00:00.000Z', o: 'success' }]),
        },
        outcome: 'blocked',
        latencyMs: 200,
        nowIso: '2026-03-16T12:00:00.000Z',
        config: cfg,
    });

    assert.equal(result.demoted, true);
    assert.equal(result.updates.rank, '列兵');
});

test('combat should apply stage multiplier positive and fallback branches', () => {
    const cfg = baseConfig();
    cfg.rollout = {
        features: {
            stageWeighting: true,
            lifecycleHysteresis: false,
            honorPromotionTuning: false,
        },
    };
    cfg.policy.scoring.stageMultipliers = {
        score: { l2: 1.5, l0: 0 },
        health: { l2: 1.2, l0: 0 },
    };

    const boosted = evaluateCombat({
        proxy: {
            ...baseProxy(),
            lifecycle: 'active',
        },
        outcome: 'success',
        latencyMs: 800,
        nowIso: '2026-03-16T12:00:00.000Z',
        config: cfg,
        stage: 'l2',
    });

    const fallback = evaluateCombat({
        proxy: {
            ...baseProxy(),
            lifecycle: 'active',
        },
        outcome: 'success',
        latencyMs: 800,
        nowIso: '2026-03-16T12:00:00.000Z',
        config: cfg,
        stage: 'l0',
    });

    assert.equal(boosted.updates.combat_points > fallback.updates.combat_points, true);
    assert.equal(boosted.updates.health_score > fallback.updates.health_score, true);
});

test('combat should support missing scoring demotion and retirement objects', () => {
    const cfg = {
        rollout: {
            features: {
                stageWeighting: false,
                lifecycleHysteresis: false,
                honorPromotionTuning: false,
            },
        },
        policy: {
            serviceHourScale: 1,
            promotionProtectHours: 6,
            ranks: baseConfig().policy.ranks,
            honors: baseConfig().policy.honors,
            legacy: {
                ranks: baseConfig().policy.ranks,
                honors: baseConfig().policy.honors,
            },
        },
    };

    const result = evaluateCombat({
        proxy: {
            ...baseProxy(),
            lifecycle: 'active',
            rank: '列兵',
        },
        outcome: 'success',
        latencyMs: 900,
        nowIso: '2026-03-16T12:00:00.000Z',
        config: cfg,
    });

    assert.equal(result.updates.total_samples, 1);
    assert.equal(result.updates.rank, '列兵');
});

test('combat should use explicit technical lifecycle allow-list when provided', () => {
    const cfg = baseConfig();
    cfg.policy.retirement.technicalEligibleLifecycles = ['active'];
    cfg.policy.retirement.technicalMinSamples = 1;
    cfg.policy.retirement.technicalSuccessRatio = 1;
    cfg.policy.retirement.disciplineThreshold = 0;
    cfg.policy.retirement.disciplineInvalidCount = 99;

    const result = evaluateCombat({
        proxy: {
            ...baseProxy(),
            lifecycle: 'active',
            rank: '列兵',
            total_samples: 10,
            success_count: 0,
            health_score: 90,
        },
        outcome: 'blocked',
        latencyMs: 1000,
        nowIso: '2026-03-16T12:00:00.000Z',
        config: cfg,
    });

    assert.equal(result.updates.retired_type, '技术退伍');
});

test('state transition should cover negative stay window and consecutive fail fallback', () => {
    const cfg = baseConfig();
    enableHysteresis(cfg);
    cfg.policy.lifecycle.minStateStayMinutes = -1;
    cfg.policy.lifecycle.minSamplesForTransition = 1;
    cfg.policy.lifecycle.activeToReserveFailRatio = 0;
    cfg.policy.lifecycle.activeToReserveConsecutiveFail = 0;

    const result = evaluateStateTransition({
        proxy: {
            ...baseProxy(),
            lifecycle: 'active',
            health_score: 90,
            consecutive_fail: undefined,
            recent_window_json: JSON.stringify([{ t: '2026-03-16T12:00:00.000Z', o: 'blocked' }]),
        },
        nowIso: '2026-03-16T12:00:00.000Z',
        config: cfg,
    });

    assert.equal(result.change, 'active_to_reserve');
});

test('rank branch matrix should exercise fallback and short-circuit paths', () => {
    const outcomes = ['success', 'blocked', 'timeout', 'network_error', 'invalid_payload'];
    const stages = ['l0', 'l1', 'l2'];
    const nowMs = Date.parse('2026-03-16T12:00:00.000Z');
    const fallbackRanks = baseConfig().policy.ranks;
    const fallbackHonors = baseConfig().policy.honors;

    for (let i = 0; i < 180; i += 1) {
        const cfg = baseConfig();
        cfg.rollout = {
            features: {
                stageWeighting: i % 2 === 0,
                lifecycleHysteresis: i % 3 !== 0,
                honorPromotionTuning: i % 4 === 0,
            },
        };

        if (i % 3 === 0) cfg.policy.ranks = null;
        if (i % 4 === 0) cfg.policy.honors = null;
        if (i % 5 === 0) cfg.policy.scoring = {};
        if (i % 6 === 0) cfg.policy.demotion = {};
        if (i % 7 === 0) cfg.policy.retirement = {};
        if (i % 8 === 0) cfg.policy.lifecycle = {};
        if (i % 9 === 0) cfg.policy.serviceHourScale = 0;
        if (i % 10 === 0) cfg.policy.promotionProtectHours = 0;
        if (i % 11 === 0) cfg.policy.demotion = { regularBlockedRatio: 0.7, severeBlockedRatio: 0.8 };
        if (i % 12 === 0) cfg.policy.retirement = { technicalEligibleLifecycles: 'invalid' };
        if (i % 13 === 0) cfg.policy.lifecycle = { minStateStayMinutes: 0 };
        if (i % 14 === 0) cfg.policy.scoring = { stageMultipliers: { score: {}, health: {} } };
        if (i % 15 === 0) cfg.policy.legacy = {};
        if (i % 16 === 0) cfg.policy.legacy = { ranks: fallbackRanks };
        if (i % 17 === 0) cfg.policy.legacy = { honors: fallbackHonors };
        if (i % 18 === 0) cfg.policy.legacy = { ranks: fallbackRanks, honors: fallbackHonors };

        const nowIso = new Date(nowMs + i * 60_000).toISOString();
        const windowSize = i % 26;
        const recentWindow = Array.from({ length: windowSize }, (_, idx) => {
            const eventAt = new Date(nowMs - idx * 120_000).toISOString();
            const windowOutcome = outcomes[(i + idx) % outcomes.length];
            return {
                t: idx % 7 === 0 ? 'invalid-date' : eventAt,
                o: windowOutcome === 'invalid_payload' ? 'blocked' : windowOutcome,
            };
        });
        const honors = [];
        if (i % 3 === 0) honors.push('钢铁连胜');
        if (i % 5 === 0) honors.push('逆风勇士');
        if (i % 7 === 0) honors.push('千次服役');

        const proxy = {
            ...baseProxy(),
            rank: ['新兵', '列兵', '士官', '尉官', '王牌', '未知军衔'][i % 6],
            lifecycle: ['candidate', 'active', 'reserve', 'retired', undefined][i % 5],
            service_hours: [0, 12, 780, null][i % 4],
            rank_service_hours: [0, 1.5, 5.5, null][i % 4],
            combat_points: [0, 20, 260, 900][i % 4],
            health_score: [null, 0, 18, 45, 62, 88][i % 6],
            discipline_score: [null, 0, 20, 40, 100][i % 5],
            success_count: [0, 1, 30, 850][i % 4],
            block_count: [0, 2, 10, 60][i % 4],
            timeout_count: [0, 1, 6, 30][i % 4],
            network_error_count: [0, 1, 5, 20][i % 4],
            invalid_feedback_count: [0, 1, 2, 5, 7][i % 5],
            total_samples: [0, 1, 9, 79, 120, -1][i % 6],
            consecutive_success: [0, 1, 3, 16, 30][i % 5],
            consecutive_fail: [0, 1, 2, 6, 9][i % 5],
            risky_success_count: [0, 1, 3, 10, 20][i % 5],
            retired_type: null,
            recent_window_json: JSON.stringify(recentWindow),
            honor_history_json: JSON.stringify(honors),
            honor_active_json: JSON.stringify([]),
            last_checked_at: i % 4 === 0 ? null : new Date(nowMs - (i % 8) * 3_600_000).toISOString(),
            lifecycle_changed_at: i % 3 === 0 ? null : new Date(nowMs - (i % 6) * 3_600_000).toISOString(),
            updated_at: i % 3 === 0 ? new Date(nowMs - 5 * 3_600_000).toISOString() : null,
            last_l1_success_at: [
                null,
                'invalid-date',
                new Date(nowMs - 30 * 60_000).toISOString(),
                new Date(nowMs - 4 * 3_600_000).toISOString(),
            ][i % 4],
        };

        assert.doesNotThrow(() => {
            evaluateCombat({
                proxy,
                outcome: outcomes[i % outcomes.length],
                latencyMs: [0, 500, 1500, 3000, Number.NaN][i % 5],
                nowIso,
                config: cfg,
                stage: stages[i % stages.length],
            });
        });

        assert.doesNotThrow(() => {
            evaluateStateTransition({
                proxy,
                nowIso,
                config: cfg,
            });
        });

        assert.doesNotThrow(() => {
            evaluateStateTransition({
                proxy,
                nowIso,
                config: {
                    rollout: cfg.rollout,
                },
            });
        });
    }
});

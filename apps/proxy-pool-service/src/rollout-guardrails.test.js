const test = require('node:test');
const assert = require('node:assert/strict');
const {
    median,
    ensureRolloutConfig,
    normalizeFeaturePatch,
    applyFeaturePatch,
    evaluateRolloutGuardrails,
    computeRecommendedRollbackFeatures,
} = require('./rollout-guardrails');

test('median should handle empty odd and even inputs', () => {
    assert.equal(median([]), 0);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 4, 2, 3]), 2.5);
});

test('ensureRolloutConfig should backfill rollout defaults', () => {
    const config = {};
    const rollout = ensureRolloutConfig(config);
    assert.equal(rollout.version, 'v1.1');
    assert.equal(rollout.activeProfile, 'production');
    assert.equal(rollout.features.stageWeighting, true);
    assert.equal(rollout.features.lifecycleHysteresis, true);
    assert.equal(rollout.features.honorPromotionTuning, false);
    assert.equal(typeof rollout.guardrails.baseline.activeCount, 'number');
});

test('feature patch helpers should validate and apply', () => {
    const cfg = { rollout: { features: { stageWeighting: true, lifecycleHysteresis: true, honorPromotionTuning: false } } };
    const ok = normalizeFeaturePatch({ honorPromotionTuning: true });
    assert.equal(ok.ok, true);
    const features = applyFeaturePatch(cfg, ok.patch);
    assert.equal(features.honorPromotionTuning, true);

    const invalidType = normalizeFeaturePatch({ stageWeighting: 1 });
    assert.equal(invalidType.ok, false);
    const invalidKey = normalizeFeaturePatch({ unknown: true });
    assert.equal(invalidKey.ok, false);
    assert.equal(normalizeFeaturePatch(null).ok, false);
    assert.equal(normalizeFeaturePatch([]).ok, false);
});

test('guardrail evaluation should report breaches and rollback recommendations', () => {
    const config = {
        rollout: {
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
            features: {
                stageWeighting: true,
                lifecycleHysteresis: true,
                honorPromotionTuning: false,
            },
        },
    };

    const report = evaluateRolloutGuardrails({
        db: {
            getActiveCount: () => 70,
            getBattleSuccessRateSince: () => ({ total: 20, success: 12, successRate: 0.6 }),
            getRetirementsCountSince: () => 9,
            getRetirementDailyCounts: () => [
                { day: '2026-03-10', count: 1 },
                { day: '2026-03-11', count: 0 },
                { day: '2026-03-12', count: 2 },
                { day: '2026-03-13', count: 1 },
                { day: '2026-03-14', count: 2 },
                { day: '2026-03-15', count: 1 },
            ],
        },
        config,
        nowIso: '2026-03-16T12:00:00.000Z',
    });

    assert.equal(report.shouldRollback, true);
    assert.equal(report.breaches.some((item) => item.code === 'active_drop'), true);
    assert.equal(report.breaches.some((item) => item.code === 'l2_drop'), true);
    assert.equal(report.breaches.some((item) => item.code === 'retired_spike'), true);
    assert.equal(report.recommendedRollbackFeatures.includes('stageWeighting'), true);
    assert.equal(report.recommendedRollbackFeatures.includes('lifecycleHysteresis'), true);
    assert.equal(report.metrics.retirementDaily.length, 7);
});

test('computeRecommendedRollbackFeatures should map breach codes', () => {
    const features = computeRecommendedRollbackFeatures([
        { code: 'active_drop' },
        { code: 'l2_drop' },
        { code: 'retired_spike' },
    ]);
    assert.equal(features.includes('stageWeighting'), true);
    assert.equal(features.includes('lifecycleHysteresis'), true);
});

test('guardrail evaluation should support missing db metric methods', () => {
    const report = evaluateRolloutGuardrails({
        db: {},
        config: { rollout: {} },
        nowIso: '2026-03-16T12:00:00.000Z',
    });
    assert.equal(report.metrics.activeNow, 0);
    assert.equal(report.metrics.l2.successRate, 0);
    assert.equal(Array.isArray(report.metrics.retirementDaily), true);
});

// 0232_toNumber_转换数字逻辑
function toNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

// 0233_median_计算中位数逻辑
function median(values) {
    const nums = values
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item))
        .sort((a, b) => a - b);
    if (nums.length === 0) return 0;
    const mid = Math.floor(nums.length / 2);
    if (nums.length % 2 === 1) return nums[mid];
    return (nums[mid - 1] + nums[mid]) / 2;
}

const DEFAULT_FEATURES = {
    stageWeighting: true,
    lifecycleHysteresis: true,
    honorPromotionTuning: false,
};

// 0234_ensureRolloutConfig_确保上线配置逻辑
function ensureRolloutConfig(config = {}) {
    if (!config.rollout || typeof config.rollout !== 'object') {
        config.rollout = {};
    }

    config.rollout.version = String(config.rollout.version || 'v2');
    config.rollout.activeProfile = String(config.rollout.activeProfile || 'production');
    config.rollout.features = {
        ...DEFAULT_FEATURES,
        ...(config.rollout.features || {}),
    };
    const orchestrator = config.rollout.orchestrator || {};
    config.rollout.orchestrator = {
        enabled: orchestrator.enabled !== false,
        intervalMs: toNumber(orchestrator.intervalMs, 900_000),
        stableHours: toNumber(orchestrator.stableHours, 48),
        cooldownHours: toNumber(orchestrator.cooldownHours, 24),
        minL2Samples: toNumber(orchestrator.minL2Samples, 20),
        leaseTtlMs: toNumber(orchestrator.leaseTtlMs, 120_000),
    };

    const guardrails = config.rollout.guardrails || {};
    config.rollout.guardrails = {
        windowHours: toNumber(guardrails.windowHours, 24),
        activeDropThreshold: toNumber(guardrails.activeDropThreshold, 0.2),
        l2DropPpThreshold: toNumber(guardrails.l2DropPpThreshold, 0.03),
        retiredDailyMultiplier: toNumber(guardrails.retiredDailyMultiplier, 2),
        retiredDailyMinAbs: toNumber(guardrails.retiredDailyMinAbs, 5),
        baseline: {
            activeCount: toNumber(guardrails?.baseline?.activeCount, 0),
            l2SuccessRate: toNumber(guardrails?.baseline?.l2SuccessRate, 0),
        },
    };

    return config.rollout;
}

// 0235_normalizeFeaturePatch_规范化开关补丁逻辑
function normalizeFeaturePatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { ok: false, error: 'invalid-feature-patch' };
    }

    const out = {};
    const allowed = new Set(Object.keys(DEFAULT_FEATURES));
    for (const [key, value] of Object.entries(patch)) {
        if (!allowed.has(key)) {
            return { ok: false, error: `unsupported-feature:${key}` };
        }
        if (typeof value !== 'boolean') {
            return { ok: false, error: `feature-not-boolean:${key}` };
        }
        out[key] = value;
    }

    return { ok: true, patch: out };
}

// 0236_applyFeaturePatch_应用开关补丁逻辑
function applyFeaturePatch(config, patch) {
    const rollout = ensureRolloutConfig(config);
    rollout.features = {
        ...rollout.features,
        ...patch,
    };
    return rollout.features;
}

// 0237_computeRecommendedRollbackFeatures_计算建议回滚开关逻辑
function computeRecommendedRollbackFeatures(breaches) {
    const set = new Set();
    for (const breach of breaches) {
        if (breach.code === 'active_drop') {
            set.add('lifecycleHysteresis');
        }
        if (breach.code === 'l2_drop') {
            set.add('stageWeighting');
        }
        if (breach.code === 'retired_spike') {
            set.add('lifecycleHysteresis');
        }
    }
    return Array.from(set);
}

// 0238_evaluateRolloutGuardrails_评估硬回滚阈值逻辑
function evaluateRolloutGuardrails({ db, config, nowIso = new Date().toISOString() }) {
    const rollout = ensureRolloutConfig(config);
    const guardrails = rollout.guardrails;
    const nowMs = Date.parse(nowIso);
    const sinceIso = new Date(nowMs - guardrails.windowHours * 60 * 60 * 1000).toISOString();

    const activeNow = Number(db.getActiveCount?.() || 0);
    const l2 = db.getBattleSuccessRateSince?.('l2', sinceIso) || { total: 0, success: 0, successRate: 0 };
    const activeRollingMedian = db.getLifecycleSnapshotMedian?.('active', 7, nowIso);
    const l2Daily = db.getBattleDailySuccessRates?.('l2', 7, nowIso) || [];
    const l2RollingMedian = median(l2Daily.map((item) => Number(item.successRate) || 0));
    const baselineActiveCount = Number.isFinite(activeRollingMedian)
        ? Number(activeRollingMedian)
        : Number(guardrails.baseline.activeCount || 0);
    const baselineL2SuccessRate = l2Daily.length > 0
        ? l2RollingMedian
        : Number(guardrails.baseline.l2SuccessRate || 0);
    const retired24h = Number(db.getRetirementsCountSince?.(sinceIso) || 0);
    const retirementDaily = db.getRetirementDailyCounts?.(7, nowIso) || [];
    const retirementDailyMap = new Map(retirementDaily.map((item) => [item.day, Number(item.count) || 0]));
    const retirementDailySeries = [];
    for (let idx = 6; idx >= 0; idx -= 1) {
        const dayKey = new Date(nowMs - idx * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        retirementDailySeries.push({
            day: dayKey,
            count: retirementDailyMap.get(dayKey) || 0,
        });
    }
    const retireMedian7d = median(retirementDailySeries.map((item) => item.count));
    const retiredThreshold = Math.max(retireMedian7d * guardrails.retiredDailyMultiplier, guardrails.retiredDailyMinAbs);

    const breaches = [];
    if (baselineActiveCount > 0) {
        const activeFloor = baselineActiveCount * (1 - guardrails.activeDropThreshold);
        if (activeNow < activeFloor) {
            breaches.push({
                code: 'active_drop',
                message: 'active 数量下降超过阈值',
                actual: activeNow,
                threshold: activeFloor,
            });
        }
    }

    if (baselineL2SuccessRate > 0 && l2.total > 0) {
        const l2Floor = baselineL2SuccessRate - guardrails.l2DropPpThreshold;
        if (l2.successRate < l2Floor) {
            breaches.push({
                code: 'l2_drop',
                message: 'L2 成功率下降超过阈值',
                actual: l2.successRate,
                threshold: l2Floor,
            });
        }
    }

    if (retired24h > retiredThreshold) {
        breaches.push({
            code: 'retired_spike',
            message: '24h 退役新增超过阈值',
            actual: retired24h,
            threshold: retiredThreshold,
        });
    }

    const recommendedRollbackFeatures = computeRecommendedRollbackFeatures(breaches);

    return {
        at: nowIso,
        since: sinceIso,
        windowHours: guardrails.windowHours,
        thresholds: {
            activeDropThreshold: guardrails.activeDropThreshold,
            l2DropPpThreshold: guardrails.l2DropPpThreshold,
            retiredDailyMultiplier: guardrails.retiredDailyMultiplier,
            retiredDailyMinAbs: guardrails.retiredDailyMinAbs,
            retiredThreshold,
            baselineActiveCount,
            baselineL2SuccessRate,
        },
        metrics: {
            activeNow,
            l2,
            l2Daily,
            retired24h,
            retireMedian7d,
            retirementDaily: retirementDailySeries,
            rollingBaselines: {
                activeMedian7d: Number.isFinite(activeRollingMedian) ? Number(activeRollingMedian) : 0,
                l2SuccessMedian7d: l2RollingMedian,
            },
        },
        breaches,
        shouldRollback: breaches.length > 0,
        recommendedRollbackFeatures,
    };
}

module.exports = {
    median,
    ensureRolloutConfig,
    normalizeFeaturePatch,
    applyFeaturePatch,
    evaluateRolloutGuardrails,
    computeRecommendedRollbackFeatures,
};

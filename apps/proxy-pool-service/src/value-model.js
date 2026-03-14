const { RANKS } = require('./constants');

// 0214_toFiniteNumber_转换为有限数字逻辑
function toFiniteNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

// 0215_clamp_限制逻辑
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

// 0216_parseJsonArray_解析JSON数组逻辑
function parseJsonArray(value) {
    try {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// 0217_safeRatio_安全比例逻辑
function safeRatio(numerator, denominator, fallback = 0.5) {
    const n = toFiniteNumber(numerator, 0);
    const d = toFiniteNumber(denominator, 0);
    if (d <= 0) return fallback;
    return clamp(n / d, 0, 1);
}

const DEFAULT_MODEL = {
    combatPointCap: 1200,
    honorActiveWeight: 30,
    honorHistoryWeight: 10,
    weights: {
        rank: 16,
        combat: 24,
        health: 16,
        discipline: 14,
        successRatio: 12,
        battleRatio: 10,
        honor: 8,
    },
    lifecycleScoreMap: {
        active: 100,
        reserve: 72,
        candidate: 58,
        retired: 8,
    },
};

// 0218_resolveModel_解析模型配置逻辑
function resolveModel(policy = {}) {
    const custom = policy.valueModel || {};
    return {
        ...DEFAULT_MODEL,
        ...custom,
        weights: {
            ...DEFAULT_MODEL.weights,
            ...(custom.weights || {}),
        },
        lifecycleScoreMap: {
            ...DEFAULT_MODEL.lifecycleScoreMap,
            ...(custom.lifecycleScoreMap || {}),
        },
    };
}

// 0219_buildGrade_构建等级逻辑
function buildGrade(score) {
    if (score >= 85) return 'S';
    if (score >= 70) return 'A';
    if (score >= 55) return 'B';
    if (score >= 40) return 'C';
    return 'D';
}

// 0220_computeProxyValue_计算IP价值逻辑
function computeProxyValue(proxy, policy = {}) {
    const model = resolveModel(policy);

    const rank = proxy.rank || RANKS[0];
    const rankIdx = Math.max(0, RANKS.indexOf(rank));
    const rankScore = RANKS.length > 1 ? (rankIdx / (RANKS.length - 1)) * 100 : 0;

    const combatPointCap = Math.max(1, toFiniteNumber(model.combatPointCap, DEFAULT_MODEL.combatPointCap));
    const combatScore = clamp((toFiniteNumber(proxy.combat_points, 0) / combatPointCap) * 100, 0, 100);
    const healthScore = clamp(toFiniteNumber(proxy.health_score, 60), 0, 100);
    const disciplineScore = clamp(toFiniteNumber(proxy.discipline_score, 100), 0, 100);
    const successScore = safeRatio(proxy.success_count, proxy.total_samples, 0.5) * 100;
    const battleScore = safeRatio(
        proxy.battle_success_count,
        toFiniteNumber(proxy.battle_success_count, 0) + toFiniteNumber(proxy.battle_fail_count, 0),
        0.5,
    ) * 100;

    const honorActive = parseJsonArray(proxy.honor_active_json);
    const honorHistory = parseJsonArray(proxy.honor_history_json);
    const honorScore = clamp(
        honorActive.length * Math.max(0, toFiniteNumber(model.honorActiveWeight, 30))
            + honorHistory.length * Math.max(0, toFiniteNumber(model.honorHistoryWeight, 10)),
        0,
        100,
    );

    const lifecycle = String(proxy.lifecycle || 'candidate');
    const lifecycleScore = clamp(
        toFiniteNumber(model.lifecycleScoreMap[lifecycle], model.lifecycleScoreMap.candidate),
        0,
        100,
    );

    const components = {
        rank: Number(rankScore.toFixed(2)),
        combat: Number(combatScore.toFixed(2)),
        health: Number(healthScore.toFixed(2)),
        discipline: Number(disciplineScore.toFixed(2)),
        successRatio: Number(successScore.toFixed(2)),
        battleRatio: Number(battleScore.toFixed(2)),
        honor: Number(honorScore.toFixed(2)),
        lifecycle: Number(lifecycleScore.toFixed(2)),
    };

    const weights = {
        rank: Math.max(0, toFiniteNumber(model.weights.rank, DEFAULT_MODEL.weights.rank)),
        combat: Math.max(0, toFiniteNumber(model.weights.combat, DEFAULT_MODEL.weights.combat)),
        health: Math.max(0, toFiniteNumber(model.weights.health, DEFAULT_MODEL.weights.health)),
        discipline: Math.max(0, toFiniteNumber(model.weights.discipline, DEFAULT_MODEL.weights.discipline)),
        successRatio: Math.max(0, toFiniteNumber(model.weights.successRatio, DEFAULT_MODEL.weights.successRatio)),
        battleRatio: Math.max(0, toFiniteNumber(model.weights.battleRatio, DEFAULT_MODEL.weights.battleRatio)),
        honor: Math.max(0, toFiniteNumber(model.weights.honor, DEFAULT_MODEL.weights.honor)),
    };

    const weightSum = Object.values(weights).reduce((acc, item) => acc + item, 0);
    const weightedCore = weightSum > 0
        ? (
            components.rank * weights.rank
            + components.combat * weights.combat
            + components.health * weights.health
            + components.discipline * weights.discipline
            + components.successRatio * weights.successRatio
            + components.battleRatio * weights.battleRatio
            + components.honor * weights.honor
        ) / weightSum
        : 0;

    let score = clamp(weightedCore * 0.82 + components.lifecycle * 0.18, 0, 100);
    if (lifecycle === 'retired') {
        score = Math.min(score, components.lifecycle);
    }

    score = Number(score.toFixed(2));
    return {
        score,
        breakdown: {
            ...components,
            grade: buildGrade(score),
        },
    };
}

module.exports = {
    toFiniteNumber,
    clamp,
    parseJsonArray,
    safeRatio,
    resolveModel,
    buildGrade,
    computeProxyValue,
};

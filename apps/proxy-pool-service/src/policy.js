// 0221_isPlainObject_判断普通对象逻辑
function isPlainObject(value) {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

// 0222_cloneJson_克隆JSON逻辑
function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

// 0223_mergeObjects_合并对象逻辑
function mergeObjects(base, patch) {
    if (!isPlainObject(base)) return cloneJson(patch);
    const result = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (Array.isArray(value)) {
            result[key] = cloneJson(value);
            continue;
        }
        if (isPlainObject(value) && isPlainObject(result[key])) {
            result[key] = mergeObjects(result[key], value);
            continue;
        }
        result[key] = value;
    }
    return result;
}

const ALLOWED_KEYS = new Set([
    'serviceHourScale',
    'promotionProtectHours',
    'ranks',
    'scoring',
    'demotion',
    'retirement',
    'honors',
    'valueModel',
]);

// 0224_normalizePolicyPatch_规范化策略补丁逻辑
function normalizePolicyPatch(rawPatch) {
    if (!isPlainObject(rawPatch)) {
        return { ok: false, error: 'invalid-policy-patch' };
    }
    const patch = rawPatch.policy && isPlainObject(rawPatch.policy) ? rawPatch.policy : rawPatch;
    for (const key of Object.keys(patch)) {
        if (!ALLOWED_KEYS.has(key)) {
            return { ok: false, error: `unsupported-policy-field:${key}` };
        }
    }
    return { ok: true, patch };
}

// 0225_applyPolicyPatch_应用策略补丁逻辑
function applyPolicyPatch(currentPolicy, patch) {
    return mergeObjects(currentPolicy, patch);
}

// 0226_toFinite_转换有限数字逻辑
function toFinite(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

// 0227_validateRanks_验证军衔逻辑
function validateRanks(ranks) {
    if (!Array.isArray(ranks) || ranks.length === 0) {
        return 'ranks-empty';
    }

    let prev = null;
    for (const item of ranks) {
        if (!isPlainObject(item) || typeof item.rank !== 'string' || item.rank.trim() === '') {
            return 'rank-item-invalid';
        }
        const minHours = toFinite(item.minHours);
        const minPoints = toFinite(item.minPoints);
        const minSamples = toFinite(item.minSamples);
        if (minHours == null || minPoints == null || minSamples == null) {
            return 'rank-threshold-invalid';
        }
        if (minHours < 0 || minPoints < 0 || minSamples < 0) {
            return 'rank-threshold-negative';
        }

        if (prev && (minHours < prev.minHours || minPoints < prev.minPoints || minSamples < prev.minSamples)) {
            return 'rank-threshold-not-ascending';
        }

        prev = { minHours, minPoints, minSamples };
    }
    return null;
}

// 0228_validatePolicy_验证策略逻辑
function validatePolicy(policy) {
    if (!isPlainObject(policy)) {
        return { ok: false, error: 'policy-invalid' };
    }

    const serviceHourScale = toFinite(policy.serviceHourScale);
    if (serviceHourScale == null || serviceHourScale <= 0) {
        return { ok: false, error: 'serviceHourScale-invalid' };
    }

    const promotionProtectHours = toFinite(policy.promotionProtectHours);
    if (promotionProtectHours == null || promotionProtectHours < 0) {
        return { ok: false, error: 'promotionProtectHours-invalid' };
    }

    const rankError = validateRanks(policy.ranks);
    if (rankError) {
        return { ok: false, error: rankError };
    }

    const ratioFields = [
        policy.demotion?.regularBlockedRatio,
        policy.demotion?.severeBlockedRatio,
        policy.retirement?.technicalSuccessRatio,
        policy.retirement?.battleDamageBlockedRatio,
    ];
    for (const value of ratioFields) {
        const num = toFinite(value);
        if (num == null || num < 0 || num > 1) {
            return { ok: false, error: 'ratio-invalid' };
        }
    }

    const honors = policy.honors || {};
    for (const key of ['steelStreak', 'riskyWarrior', 'thousandService']) {
        const num = toFinite(honors[key]);
        if (num == null || num <= 0) {
            return { ok: false, error: `honors-${key}-invalid` };
        }
    }

    const valueModel = policy.valueModel || {};
    if (Object.prototype.hasOwnProperty.call(valueModel, 'combatPointCap')) {
        const cap = toFinite(valueModel.combatPointCap);
        if (cap == null || cap <= 0) {
            return { ok: false, error: 'valueModel-combatPointCap-invalid' };
        }
    }

    if (isPlainObject(valueModel.weights)) {
        for (const [key, value] of Object.entries(valueModel.weights)) {
            const num = toFinite(value);
            if (num == null || num < 0) {
                return { ok: false, error: `valueModel-weight-${key}-invalid` };
            }
        }
    }

    return { ok: true };
}

module.exports = {
    isPlainObject,
    cloneJson,
    mergeObjects,
    normalizePolicyPatch,
    applyPolicyPatch,
    validateRanks,
    validatePolicy,
};

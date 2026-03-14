const test = require('node:test');
const assert = require('node:assert/strict');
const {
    isPlainObject,
    cloneJson,
    mergeObjects,
    normalizePolicyPatch,
    applyPolicyPatch,
    validateRanks,
    validatePolicy,
} = require('./policy');

// 0229_basePolicy_基础策略逻辑
function basePolicy() {
    return {
        serviceHourScale: 3,
        promotionProtectHours: 6,
        ranks: [
            { rank: '新兵', minHours: 0, minPoints: 0, minSamples: 0 },
            { rank: '列兵', minHours: 1, minPoints: 2, minSamples: 3 },
        ],
        scoring: {
            success: 6,
            successFastBonusLt1200: 2,
            successFastBonusLt2500: 1,
            blocked: -8,
            timeout: -6,
            networkError: -5,
            invalidFeedback: -10,
        },
        demotion: {
            regularWindowSize: 50,
            regularBlockedRatio: 0.45,
            regularMinSamples: 20,
            severeWindowMinutes: 60,
            severeMinSamples: 15,
            severeBlockedRatio: 0.7,
            healthThreshold: 45,
            lowHealthRetireThreshold: 20,
        },
        retirement: {
            disciplineThreshold: 40,
            disciplineInvalidCount: 5,
            technicalMinSamples: 60,
            technicalSuccessRatio: 0.1,
            battleDamageBlockedRatio: 0.6,
            honorMinServiceHours: 720,
            honorMinSuccess: 800,
        },
        honors: {
            steelStreak: 30,
            riskyWarrior: 20,
            thousandService: 1000,
        },
        valueModel: {
            combatPointCap: 1200,
            weights: {
                combat: 24,
            },
        },
    };
}

test('policy helpers should cover object cloning and merging', () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(null), false);

    const raw = { a: 1, b: { c: 2 }, d: [1, 2] };
    const cloned = cloneJson(raw);
    cloned.b.c = 9;
    assert.equal(raw.b.c, 2);

    const merged = mergeObjects(
        { a: 1, b: { c: 2, d: 3 }, e: [1, 2] },
        { b: { c: 9 }, e: [3], f: 7 },
    );
    assert.deepEqual(merged, { a: 1, b: { c: 9, d: 3 }, e: [3], f: 7 });
    assert.deepEqual(mergeObjects(null, { x: 1 }), { x: 1 });
});

test('normalizePolicyPatch should validate patch shape and supported fields', () => {
    assert.equal(normalizePolicyPatch(null).ok, false);
    assert.equal(normalizePolicyPatch('x').error, 'invalid-policy-patch');
    assert.equal(normalizePolicyPatch({ x: 1 }).error, 'unsupported-policy-field:x');
    assert.deepEqual(
        normalizePolicyPatch({ policy: { promotionProtectHours: 4 } }),
        { ok: true, patch: { promotionProtectHours: 4 } },
    );
});

test('applyPolicyPatch should merge nested objects', () => {
    const next = applyPolicyPatch(basePolicy(), {
        scoring: {
            success: 8,
        },
        honors: {
            steelStreak: 20,
        },
    });
    assert.equal(next.scoring.success, 8);
    assert.equal(next.honors.steelStreak, 20);
    assert.equal(next.honors.riskyWarrior, 20);
});

test('validateRanks should validate ordering and shape', () => {
    assert.equal(validateRanks([]), 'ranks-empty');
    assert.equal(validateRanks([{ rank: '', minHours: 0, minPoints: 0, minSamples: 0 }]), 'rank-item-invalid');
    assert.equal(validateRanks([{ rank: '新兵', minHours: 'x', minPoints: 0, minSamples: 0 }]), 'rank-threshold-invalid');
    assert.equal(validateRanks([{ rank: '新兵', minHours: -1, minPoints: 0, minSamples: 0 }]), 'rank-threshold-negative');
    assert.equal(validateRanks([
        { rank: '新兵', minHours: 1, minPoints: 2, minSamples: 3 },
        { rank: '列兵', minHours: 0, minPoints: 1, minSamples: 2 },
    ]), 'rank-threshold-not-ascending');
    assert.equal(validateRanks(basePolicy().ranks), null);
});

test('validatePolicy should cover invalid branches and success', () => {
    assert.equal(validatePolicy(null).error, 'policy-invalid');

    const p1 = basePolicy();
    p1.serviceHourScale = 0;
    assert.equal(validatePolicy(p1).error, 'serviceHourScale-invalid');

    const p2 = basePolicy();
    p2.promotionProtectHours = -1;
    assert.equal(validatePolicy(p2).error, 'promotionProtectHours-invalid');

    const p3 = basePolicy();
    p3.ranks = [];
    assert.equal(validatePolicy(p3).error, 'ranks-empty');

    const p4 = basePolicy();
    p4.demotion.regularBlockedRatio = 1.5;
    assert.equal(validatePolicy(p4).error, 'ratio-invalid');

    const p5 = basePolicy();
    p5.honors.steelStreak = 0;
    assert.equal(validatePolicy(p5).error, 'honors-steelStreak-invalid');

    const p6 = basePolicy();
    p6.valueModel.combatPointCap = 0;
    assert.equal(validatePolicy(p6).error, 'valueModel-combatPointCap-invalid');

    const p7 = basePolicy();
    p7.valueModel.weights.combat = -1;
    assert.equal(validatePolicy(p7).error, 'valueModel-weight-combat-invalid');

    const p8 = basePolicy();
    delete p8.honors;
    assert.equal(validatePolicy(p8).error, 'honors-steelStreak-invalid');

    const p9 = basePolicy();
    delete p9.valueModel;
    assert.equal(validatePolicy(p9).ok, true);

    assert.equal(validatePolicy(basePolicy()).ok, true);
});

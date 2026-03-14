const test = require('node:test');
const assert = require('node:assert/strict');
const constants = require('./constants');
const {
    toFiniteNumber,
    clamp,
    parseJsonArray,
    safeRatio,
    resolveModel,
    buildGrade,
    computeProxyValue,
} = require('./value-model');

test('value-model helpers should cover numeric and json branches', () => {
    assert.equal(toFiniteNumber('12.5', 0), 12.5);
    assert.equal(toFiniteNumber('bad', 7), 7);
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(11, 0, 10), 10);

    assert.deepEqual(parseJsonArray(null), []);
    assert.deepEqual(parseJsonArray([1, 2]), [1, 2]);
    assert.deepEqual(parseJsonArray('["a"]'), ['a']);
    assert.deepEqual(parseJsonArray('{}'), []);
    assert.deepEqual(parseJsonArray('{bad'), []);

    assert.equal(safeRatio(1, 2), 0.5);
    assert.equal(safeRatio(5, 0), 0.5);
    assert.equal(safeRatio(5, 2), 1);
});

test('resolveModel should merge custom weights and lifecycle map', () => {
    const model = resolveModel({
        valueModel: {
            combatPointCap: 2000,
            weights: {
                combat: 50,
            },
            lifecycleScoreMap: {
                reserve: 80,
            },
        },
    });

    assert.equal(model.combatPointCap, 2000);
    assert.equal(model.weights.combat, 50);
    assert.equal(model.weights.rank > 0, true);
    assert.equal(model.lifecycleScoreMap.reserve, 80);
    assert.equal(model.lifecycleScoreMap.active, 100);
});

test('buildGrade should map score to grade', () => {
    assert.equal(buildGrade(90), 'S');
    assert.equal(buildGrade(72), 'A');
    assert.equal(buildGrade(56), 'B');
    assert.equal(buildGrade(40), 'C');
    assert.equal(buildGrade(39.9), 'D');
});

test('computeProxyValue should output score and breakdown with defaults', () => {
    const proxy = {
        rank: '士官',
        combat_points: 300,
        health_score: 85,
        discipline_score: 88,
        success_count: 80,
        total_samples: 100,
        battle_success_count: 30,
        battle_fail_count: 10,
        honor_history_json: JSON.stringify(['钢铁连胜', '逆风勇士']),
        honor_active_json: JSON.stringify(['钢铁连胜']),
        lifecycle: 'active',
    };

    const result = computeProxyValue(proxy, {});
    assert.equal(result.score > 0, true);
    assert.equal(result.score <= 100, true);
    assert.equal(typeof result.breakdown.grade, 'string');
    assert.equal(result.breakdown.successRatio, 80);
    assert.equal(result.breakdown.battleRatio, 75);
});

test('computeProxyValue should handle retired branch and invalid config numbers', () => {
    const proxy = {
        rank: '未知军衔',
        combat_points: 'bad',
        health_score: null,
        discipline_score: null,
        success_count: 0,
        total_samples: 0,
        battle_success_count: 0,
        battle_fail_count: 0,
        honor_history_json: '{bad',
        honor_active_json: '{}',
        lifecycle: 'retired',
    };
    const result = computeProxyValue(proxy, {
        valueModel: {
            combatPointCap: 0,
            honorActiveWeight: -5,
            honorHistoryWeight: -7,
            weights: {
                rank: -10,
                combat: 'bad',
                health: -1,
                discipline: -1,
                successRatio: -1,
                battleRatio: -1,
                honor: -1,
            },
            lifecycleScoreMap: {
                retired: 12,
            },
        },
    });

    assert.equal(result.score <= 12, true);
    assert.equal(result.breakdown.lifecycle, 12);
    assert.equal(result.breakdown.honor, 0);
});

test('computeProxyValue should cover fallback rank/lifecycle and zero-weight branch', () => {
    const result = computeProxyValue(
        {
            rank: '',
            lifecycle: '',
            honor_history_json: '',
            honor_active_json: '',
        },
        {
            valueModel: {
                weights: {
                    rank: 0,
                    combat: 0,
                    health: 0,
                    discipline: 0,
                    successRatio: 0,
                    battleRatio: 0,
                    honor: 0,
                },
            },
        },
    );
    assert.equal(result.score, 10.44);
    assert.equal(result.breakdown.rank, 0);
    assert.equal(result.breakdown.lifecycle, 58);
});

test('computeProxyValue should fallback unknown lifecycle to candidate score', () => {
    const result = computeProxyValue(
        {
            rank: '新兵',
            lifecycle: 'unknown',
            combat_points: 10,
        },
        {},
    );
    assert.equal(result.breakdown.lifecycle, 58);
});

test('computeProxyValue should cover single-rank branch', () => {
    const originalRanks = [...constants.RANKS];
    constants.RANKS.splice(0, constants.RANKS.length, '单兵');
    const result = computeProxyValue({ rank: '单兵', lifecycle: 'active' }, {});
    assert.equal(result.breakdown.rank, 0);
    constants.RANKS.splice(0, constants.RANKS.length, ...originalRanks);
});

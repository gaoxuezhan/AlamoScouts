const test = require('node:test');
const assert = require('node:assert/strict');
const constants = require('./constants');

test('constants should include lifecycle and ranks', () => {
    assert.deepEqual(constants.RANKS, ['新兵', '列兵', '士官', '尉官', '王牌']);
    assert.deepEqual(constants.LIFECYCLE, ['candidate', 'active', 'reserve', 'retired']);
    assert.equal(constants.RETIREMENT_TYPES.HONOR, '荣誉退伍');
    assert.equal(constants.HONOR_TYPES.STEEL_STREAK, '钢铁连胜');
    assert.equal(constants.EVENT_LEVEL.ERROR, 'error');
});

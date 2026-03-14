const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('./config');

test('config should expose required default values', () => {
    assert.equal(config.service.name, 'ProxyHub');
    assert.equal(config.service.port, 5070);
    assert.equal(config.service.timezone, 'Asia/Shanghai');
    assert.equal(config.threadPool.workers > 0, true);
    assert.equal(Array.isArray(config.validation.allowedProtocols), true);
    assert.equal(config.source.monosans.enabled, true);
    assert.equal(config.source.monosans.url.includes('proxies.json'), true);
    assert.equal(config.battle.enabled, true);
    assert.equal(config.battle.l1SyncMs, 300000);
    assert.equal(config.battle.l2SyncMs, 1800000);
    assert.equal(config.battle.maxBattleL1PerCycle, 60);
    assert.equal(config.battle.maxBattleL2PerCycle, 20);
    assert.equal(config.battle.candidateQuota, 0.15);
    assert.equal(Array.isArray(config.battle.targets.l1), true);
});

test('config ranks should be ordered and complete', () => {
    const ranks = config.policy.ranks.map((item) => item.rank);
    assert.deepEqual(ranks, ['新兵', '列兵', '士官', '尉官', '王牌']);
    assert.equal(config.policy.promotionProtectHours, 6);
    assert.equal(config.policy.valueModel.combatPointCap, 1200);
    assert.equal(config.policy.valueModel.lifecycleScoreMap.retired, 8);
    assert.equal(config.soak.durationHours, 10);
});

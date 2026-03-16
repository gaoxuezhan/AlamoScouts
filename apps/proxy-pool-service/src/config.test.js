const test = require('node:test');
const assert = require('node:assert/strict');

function loadConfigWithEnv(overrides = {}) {
    const managedKeys = new Set([
        'PROXY_HUB_BATTLE_L2_PRIMARY_URL',
        'PROXY_HUB_FEATURE_STAGE_WEIGHTING',
        'PROXY_HUB_FEATURE_LIFECYCLE_HYSTERESIS',
        'PROXY_HUB_FEATURE_HONOR_PROMOTION_TUNING',
        ...Object.keys(overrides),
    ]);
    const originals = {};
    for (const key of managedKeys) {
        originals[key] = process.env[key];
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
            process.env[key] = overrides[key];
        } else {
            delete process.env[key];
        }
    }

    const modulePath = require.resolve('./config');
    delete require.cache[modulePath];
    const config = require('./config');

    for (const key of managedKeys) {
        if (originals[key] == null) {
            delete process.env[key];
        } else {
            process.env[key] = originals[key];
        }
    }
    delete require.cache[modulePath];
    return config;
}

test('config should expose required default values', { concurrency: false }, () => {
    const config = loadConfigWithEnv();
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
    assert.equal(config.battle.targets.l2Primary[0].name, 'ly-flight-main');
    assert.equal(config.battle.targets.l2Primary[0].url, 'https://www.ly.com/flights/home');
});

test('config ranks should be ordered and complete', { concurrency: false }, () => {
    const config = loadConfigWithEnv();
    const ranks = config.policy.ranks.map((item) => item.rank);
    assert.deepEqual(ranks, ['新兵', '列兵', '士官', '尉官', '王牌']);
    assert.equal(config.policy.promotionProtectHours, 6);
    assert.equal(config.policy.valueModel.combatPointCap, 1200);
    assert.equal(config.policy.valueModel.lifecycleScoreMap.retired, 8);
    assert.equal(config.soak.durationHours, 10);
});

test('config should support env override for L2 primary target', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_BATTLE_L2_PRIMARY_URL: 'https://example.com/l2-primary',
    });
    assert.equal(config.battle.targets.l2Primary[0].url, 'https://example.com/l2-primary');
});

test('config should parse rollout feature bool env values', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_FEATURE_STAGE_WEIGHTING: 'true',
        PROXY_HUB_FEATURE_LIFECYCLE_HYSTERESIS: 'false',
        PROXY_HUB_FEATURE_HONOR_PROMOTION_TUNING: 'unexpected',
    });
    assert.equal(config.rollout.features.stageWeighting, true);
    assert.equal(config.rollout.features.lifecycleHysteresis, false);
    assert.equal(config.rollout.features.honorPromotionTuning, false);
});

test('config should accept soak policy profile from env', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_POLICY_PROFILE: 'SOAK',
    });
    assert.equal(config.rollout.activeProfile, 'soak');
    assert.equal(config.battle.l1LifecycleQuota.candidate, 0.20);
});

test('config should keep production profile when profile env is explicitly production', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_POLICY_PROFILE: 'production',
    });
    assert.equal(config.rollout.activeProfile, 'production');
});

test('config should keep candidateQuota compatibility when lifecycle quota is not explicitly set', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_BATTLE_CANDIDATE_QUOTA: '0.33',
    });
    assert.equal(config.battle.candidateQuota, 0.33);
    assert.equal(config.battle.l1LifecycleQuota, undefined);
});

test('config should support explicit l1LifecycleQuota env override', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_BATTLE_CANDIDATE_QUOTA: '0.33',
        PROXY_HUB_BATTLE_L1_LIFECYCLE_QUOTA: '{"active":0.4,"reserve":0.4,"candidate":0.2}',
    });
    assert.deepEqual(config.battle.l1LifecycleQuota, { active: 0.4, reserve: 0.4, candidate: 0.2 });
});

test('config should fallback lifecycle quota when env json is invalid', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_BATTLE_L1_LIFECYCLE_QUOTA: '{bad-json',
    });
    assert.deepEqual(config.battle.l1LifecycleQuota, { active: 0.55, reserve: 0.30, candidate: 0.15 });
});

test('config should fallback lifecycle quota when env json shape is invalid', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_BATTLE_L1_LIFECYCLE_QUOTA: '[]',
    });
    assert.deepEqual(config.battle.l1LifecycleQuota, { active: 0.55, reserve: 0.30, candidate: 0.15 });
});

test('config should fallback lifecycle quota when env json values are non-finite', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_BATTLE_L1_LIFECYCLE_QUOTA: '{"active":"x","reserve":0.3,"candidate":0.2}',
    });
    assert.deepEqual(config.battle.l1LifecycleQuota, { active: 0.55, reserve: 0.30, candidate: 0.15 });
});

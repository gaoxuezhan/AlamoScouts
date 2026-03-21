const test = require('node:test');
const assert = require('node:assert/strict');

function loadConfigWithEnv(overrides = {}) {
    const managedKeys = new Set([
        'PROXY_HUB_BATTLE_L2_PRIMARY_URL',
        'PROXY_HUB_FEATURE_STAGE_WEIGHTING',
        'PROXY_HUB_FEATURE_LIFECYCLE_HYSTERESIS',
        'PROXY_HUB_FEATURE_HONOR_PROMOTION_TUNING',
        'PROXY_HUB_ROLLOUT_ORCHESTRATOR_ENABLED',
        'PROXY_HUB_ROLLOUT_ORCHESTRATOR_INTERVAL_MS',
        'PROXY_HUB_ROLLOUT_STABLE_HOURS',
        'PROXY_HUB_ROLLOUT_COOLDOWN_HOURS',
        'PROXY_HUB_ROLLOUT_MIN_L2_SAMPLES',
        'PROXY_HUB_ROLLOUT_LEASE_TTL_MS',
        'PROXY_HUB_POLICY_PROFILE',
        'PROXY_HUB_CANDIDATE_MAX',
        'PROXY_HUB_CANDIDATE_GATE_OVERRIDE',
        'PROXY_HUB_CANDIDATE_SWEEP_MS',
        'PROXY_HUB_CANDIDATE_STALE_HOURS',
        'PROXY_HUB_CANDIDATE_STALE_MIN_SAMPLES',
        'PROXY_HUB_CANDIDATE_TIMEOUT_HOURS',
        'PROXY_HUB_CANDIDATE_SWEEP_MAX_RETIRE',
        'PROXY_HUB_FAILURE_BACKOFF_ENABLED',
        'PROXY_HUB_FAILURE_BACKOFF_L0_MS',
        'PROXY_HUB_FAILURE_BACKOFF_L1_MS',
        'PROXY_HUB_FAILURE_BACKOFF_L2_MS',
        'PROXY_HUB_FAILURE_BACKOFF_MULTIPLIER',
        'PROXY_HUB_FAILURE_BACKOFF_MAX_MS',
        'PROXY_HUB_SOURCE_NAME',
        'PROXY_HUB_SOURCE_URL',
        'PROXY_HUB_SOURCE_ENABLED',
        'PROXY_HUB_SOURCE_DEFAULT_PROTOCOL',
        'PROXY_HUB_SOURCE_FORMAT',
        'PROXY_HUB_SOURCE_PROFILE',
        'PROXY_HUB_SPEEDX_SOCKS4_ENABLED',
        'PROXY_HUB_BRANCHING_ENABLED',
        'PROXY_HUB_BRANCHING_DEFAULT',
        'PROXY_HUB_BRANCHING_RULES_JSON',
        'PROXY_HUB_DB_PATH',
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
    assert.equal(config.source.activeProfile, 'speedx_bundle');
    assert.equal(config.source.legacySingleOverride, false);
    assert.equal(Array.isArray(config.source.activeFeeds), true);
    assert.equal(config.source.activeFeeds.length, 3);
    assert.equal(config.source.activeFeeds[0].url.includes('/http.txt'), true);
    assert.equal(config.source.activeFeeds.some((feed) => feed.name === 'TheSpeedX/socks4' && feed.enabled === false), true);
    assert.equal(config.source.profiles.monosans_archive.enabled, false);
    assert.equal(config.storage.dbPath.includes('proxyhub-speedx-bundle.db'), true);
    assert.equal(config.validation.allowedProtocols.includes('socks4'), true);
    assert.equal(config.branching.defaultBranch, '陆军');
    assert.equal(Array.isArray(config.branching.rules), true);
    assert.equal(config.branching.rules.length >= 4, true);
    assert.equal(config.battle.enabled, true);
    assert.equal(config.battle.l1SyncMs, 300000);
    assert.equal(config.battle.l2SyncMs, 1800000);
    assert.equal(config.battle.maxBattleL1PerCycle, 60);
    assert.equal(config.battle.maxBattleL2PerCycle, 20);
    assert.equal(config.battle.candidateQuota, 0.30);
    assert.equal(config.failureBackoff.enabled, true);
    assert.equal(config.failureBackoff.maxMs, 21600000);
    assert.equal(Array.isArray(config.battle.targets.l1), true);
    assert.equal(config.battle.targets.l2Primary[0].name, 'ly-flight-main');
    assert.equal(config.battle.targets.l2Primary[0].url, 'https://www.ly.com/flights/home');
});

test('config ranks should be ordered and complete', { concurrency: false }, () => {
    const config = loadConfigWithEnv();
    const ranks = config.policy.ranks.map((item) => item.rank);
    assert.deepEqual(ranks, ['新兵', '列兵', '士官', '尉官', '校官', '将官', '王牌']);
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

test('config should support source override for line-based lists', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_SOURCE_NAME: 'TheSpeedX/PROXY-List',
        PROXY_HUB_SOURCE_URL: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt',
        PROXY_HUB_SOURCE_ENABLED: 'true',
        PROXY_HUB_SOURCE_DEFAULT_PROTOCOL: 'socks5',
        PROXY_HUB_SOURCE_FORMAT: 'line',
    });

    assert.equal(config.source.legacySingleOverride, true);
    assert.equal(config.source.activeFeeds.length, 1);
    assert.equal(config.source.activeFeeds[0].name, 'TheSpeedX/PROXY-List');
    assert.equal(config.source.activeFeeds[0].url.includes('/socks5.txt'), true);
    assert.equal(config.source.activeFeeds[0].enabled, true);
    assert.equal(config.source.activeFeeds[0].defaultProtocol, 'socks5');
    assert.equal(config.source.activeFeeds[0].sourceFormat, 'line');
});

test('config should switch db and feeds by source profile when env profile changes', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_SOURCE_PROFILE: 'monosans_archive',
    });

    assert.equal(config.source.activeProfile, 'monosans_archive');
    assert.equal(config.source.activeFeeds.length, 1);
    assert.equal(config.source.activeFeeds[0].url.includes('proxies.json'), true);
    assert.equal(config.storage.dbPath.includes('proxyhub-v1.db'), true);
});

test('config should allow re-enable speedx socks4 feed by env switch', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_SOURCE_PROFILE: 'speedx_bundle',
        PROXY_HUB_SPEEDX_SOCKS4_ENABLED: 'true',
    });

    assert.equal(config.source.activeProfile, 'speedx_bundle');
    assert.equal(config.source.activeFeeds.some((feed) => feed.name === 'TheSpeedX/socks4' && feed.enabled === true), true);
});

test('config should support branching env overrides', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_BRANCHING_ENABLED: 'false',
        PROXY_HUB_BRANCHING_DEFAULT: '空军',
        PROXY_HUB_BRANCHING_RULES_JSON: JSON.stringify([
            {
                id: 'custom',
                priority: 1,
                stage: 'l2',
                outcomes: ['success'],
                from: ['空军'],
                to: '太空军',
            },
        ]),
    });

    assert.equal(config.branching.enabled, false);
    assert.equal(config.branching.defaultBranch, '空军');
    assert.equal(config.branching.rules.length, 1);
    assert.equal(config.branching.rules[0].id, 'custom');
});

test('config should fallback branching rules when env json is invalid', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_BRANCHING_RULES_JSON: '{bad-json',
    });

    assert.equal(Array.isArray(config.branching.rules), true);
    assert.equal(config.branching.rules.length >= 4, true);
});

test('config should fallback branching rules when env json is not an array', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_BRANCHING_RULES_JSON: '{"id":"not-array"}',
    });

    assert.equal(Array.isArray(config.branching.rules), true);
    assert.equal(config.branching.rules.length >= 4, true);
});

test('config should prioritize explicit PROXY_HUB_DB_PATH over profile db mapping', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_SOURCE_PROFILE: 'speedx_bundle',
        PROXY_HUB_DB_PATH: 'apps/proxy-pool-service/data/manual-override.db',
    });

    assert.equal(config.storage.dbPath, 'apps/proxy-pool-service/data/manual-override.db');
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

test('config should parse rollout orchestrator env values', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_ROLLOUT_ORCHESTRATOR_ENABLED: 'false',
        PROXY_HUB_ROLLOUT_ORCHESTRATOR_INTERVAL_MS: '120000',
        PROXY_HUB_ROLLOUT_STABLE_HOURS: '36',
        PROXY_HUB_ROLLOUT_COOLDOWN_HOURS: '12',
        PROXY_HUB_ROLLOUT_MIN_L2_SAMPLES: '30',
        PROXY_HUB_ROLLOUT_LEASE_TTL_MS: '90000',
    });
    assert.equal(config.rollout.orchestrator.enabled, false);
    assert.equal(config.rollout.orchestrator.intervalMs, 120000);
    assert.equal(config.rollout.orchestrator.stableHours, 36);
    assert.equal(config.rollout.orchestrator.cooldownHours, 12);
    assert.equal(config.rollout.orchestrator.minL2Samples, 30);
    assert.equal(config.rollout.orchestrator.leaseTtlMs, 90000);
});

test('config should parse candidate control env values', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_CANDIDATE_MAX: '4321',
        PROXY_HUB_CANDIDATE_GATE_OVERRIDE: 'true',
        PROXY_HUB_CANDIDATE_SWEEP_MS: '600000',
        PROXY_HUB_CANDIDATE_STALE_HOURS: '18',
        PROXY_HUB_CANDIDATE_STALE_MIN_SAMPLES: '2',
        PROXY_HUB_CANDIDATE_TIMEOUT_HOURS: '60',
        PROXY_HUB_CANDIDATE_SWEEP_MAX_RETIRE: '333',
    });
    assert.equal(config.candidateControl.max, 4321);
    assert.equal(config.candidateControl.gateOverride, true);
    assert.equal(config.candidateControl.sweepMs, 600000);
    assert.equal(config.candidateControl.staleHours, 18);
    assert.equal(config.candidateControl.staleMinSamples, 2);
    assert.equal(config.candidateControl.timeoutHours, 60);
    assert.equal(config.candidateControl.maxRetirePerCycle, 333);
});

test('config should parse failure backoff env values', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_FAILURE_BACKOFF_ENABLED: 'false',
        PROXY_HUB_FAILURE_BACKOFF_L0_MS: '111000',
        PROXY_HUB_FAILURE_BACKOFF_L1_MS: '222000',
        PROXY_HUB_FAILURE_BACKOFF_L2_MS: '333000',
        PROXY_HUB_FAILURE_BACKOFF_MULTIPLIER: '2.5',
        PROXY_HUB_FAILURE_BACKOFF_MAX_MS: '444000',
    });
    assert.equal(config.failureBackoff.enabled, false);
    assert.equal(config.failureBackoff.l0BaseMs, 111000);
    assert.equal(config.failureBackoff.l1BaseMs, 222000);
    assert.equal(config.failureBackoff.l2BaseMs, 333000);
    assert.equal(config.failureBackoff.multiplier, 2.5);
    assert.equal(config.failureBackoff.maxMs, 444000);
});

test('config should accept soak policy profile from env', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_POLICY_PROFILE: 'SOAK',
    });
    assert.equal(config.rollout.activeProfile, 'soak');
    assert.equal(config.battle.l1LifecycleQuota.candidate, 0.30);
});

test('config should keep production profile when profile env is explicitly production', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_POLICY_PROFILE: 'production',
    });
    assert.equal(config.rollout.activeProfile, 'production');
});

test('config should fallback to production profile when env profile is unsupported', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_POLICY_PROFILE: 'staging',
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
    assert.deepEqual(config.battle.l1LifecycleQuota, { active: 0.50, reserve: 0.20, candidate: 0.30 });
});

test('config should fallback lifecycle quota when env json shape is invalid', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_BATTLE_L1_LIFECYCLE_QUOTA: '[]',
    });
    assert.deepEqual(config.battle.l1LifecycleQuota, { active: 0.50, reserve: 0.20, candidate: 0.30 });
});

test('config should fallback lifecycle quota when env json values are non-finite', { concurrency: false }, () => {
    const config = loadConfigWithEnv({
        PROXY_HUB_BATTLE_L1_LIFECYCLE_QUOTA: '{"active":"x","reserve":0.3,"candidate":0.2}',
    });
    assert.deepEqual(config.battle.l1LifecycleQuota, { active: 0.50, reserve: 0.20, candidate: 0.30 });
});

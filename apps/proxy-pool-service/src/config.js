// 0230_toBool_转换布尔逻辑
function toBool(value, fallback) {
    if (value == null) return fallback;
    const text = String(value).trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
    return fallback;
}

// 0231_deepClone_深拷贝逻辑
function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

// 0271_parseJsonArrayEnv_解析JSON数组环境变量逻辑
function parseJsonArrayEnv(value, fallback) {
    if (value == null || String(value).trim() === '') {
        return deepClone(fallback);
    }
    try {
        const parsed = JSON.parse(String(value));
        return Array.isArray(parsed) ? parsed : deepClone(fallback);
    } catch {
        return deepClone(fallback);
    }
}

// 0280_parseCsvListEnv_解析CSV列表环境变量逻辑
function parseCsvListEnv(value, fallback = []) {
    if (value == null || String(value).trim() === '') {
        return deepClone(fallback);
    }
    const parsed = String(value)
        .split(',')
        .map((item) => String(item || '').trim())
        .filter((item, index, list) => item.length > 0 && list.indexOf(item) === index);
    return parsed.length > 0 ? parsed : deepClone(fallback);
}

const legacyRanks = [
    { rank: '新兵', minHours: 0, minPoints: 0, minSamples: 0 },
    { rank: '列兵', minHours: 12, minPoints: 80, minSamples: 20 },
    { rank: '士官', minHours: 24, minPoints: 220, minSamples: 60 },
    { rank: '尉官', minHours: 48, minPoints: 520, minSamples: 140 },
    { rank: '校官', minHours: 56, minPoints: 680, minSamples: 180 },
    { rank: '将官', minHours: 68, minPoints: 860, minSamples: 250 },
    { rank: '王牌', minHours: 84, minPoints: 1080, minSamples: 320 },
];

const legacyHonors = {
    steelStreak: 30,
    riskyWarrior: 20,
    thousandService: 1000,
    l2Mastery: 180,
    disciplineGuardMinScore: 92,
    disciplineGuardMaxInvalid: 2,
    disciplineGuardMinSamples: 300,
    riskyFailRatioThreshold: 0.35,
};

const basePolicyTemplate = {
    serviceHourScale: Number(process.env.PROXY_HUB_SERVICE_HOUR_SCALE || 3),
    promotionProtectHours: 6,
    scoring: {
        success: 6,
        successFastBonusLt1200: 0,
        successFastBonusLt2500: 0,
        blocked: -8,
        timeout: -6,
        networkError: -5,
        invalidFeedback: -10,
        stageMultipliers: {
            score: { l0: 1, l1: 1, l2: 1 },
            health: { l0: 1, l1: 1, l2: 1 },
        },
    },
    demotion: {
        regularWindowSize: 50,
        regularMinSamples: 20,
        regularFailRatio: 0.75,
        severeWindowMinutes: 60,
        severeMinSamples: 12,
        severeFailRatio: 0.90,
        healthThreshold: 40,
        lowHealthRetireThreshold: 20,
    },
    retirement: {
        disciplineThreshold: 40,
        disciplineInvalidCount: 5,
        technicalMinSamples: 80,
        technicalSuccessRatio: 0.08,
        technicalEligibleLifecycles: ['active', 'reserve'],
        battleDamageFailRatio: 0.85,
        battleDamageMinSamples: 20,
        honorMinServiceHours: 720,
        honorMinSuccess: 800,
    },
    lifecycle: {
        transitionWindowSize: 20,
        minSamplesForTransition: 20,
        minStateStayMinutes: 30,
        activeToReserveHealthThreshold: 50,
        activeToReserveFailRatio: 0.80,
        activeToReserveConsecutiveFail: 6,
        reserveToActiveHealthThreshold: 60,
        reserveToActiveSuccessRatio: 0.35,
        reserveToActiveSuccessCount: 4,
        reserveToActiveRecentL1SuccessWindowMin: 60,
        reserveToActiveRecentL1BypassSuccessCount: 6,
    },
    valueModel: {
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
    },
    legacy: {
        ranks: legacyRanks,
        honors: legacyHonors,
    },
};

const policyProfiles = {
    production: {
        ...deepClone(basePolicyTemplate),
        ranks: [
            { rank: '新兵', minHours: 0, minPoints: 0, minSamples: 0 },
            { rank: '列兵', minHours: 10, minPoints: 60, minSamples: 20 },
            { rank: '士官', minHours: 22, minPoints: 180, minSamples: 70 },
            { rank: '尉官', minHours: 44, minPoints: 430, minSamples: 180 },
            { rank: '校官', minHours: 52, minPoints: 560, minSamples: 220 },
            { rank: '将官', minHours: 64, minPoints: 760, minSamples: 290 },
            { rank: '王牌', minHours: 82, minPoints: 980, minSamples: 380 },
        ],
        honors: {
            steelStreak: 16,
            riskyWarrior: 15,
            thousandService: 800,
            l2Mastery: 120,
            disciplineGuardMinScore: 90,
            disciplineGuardMaxInvalid: 2,
            disciplineGuardMinSamples: 220,
            riskyFailRatioThreshold: 0.65,
        },
        scoring: {
            ...deepClone(basePolicyTemplate.scoring),
            stageMultipliers: {
                score: { l0: 0.35, l1: 1, l2: 1.2 },
                health: { l0: 0.4, l1: 1, l2: 1.1 },
            },
        },
        demotion: {
            ...deepClone(basePolicyTemplate.demotion),
            regularFailRatio: 0.72,
        },
    },
    soak: {
        ...deepClone(basePolicyTemplate),
        ranks: [
            { rank: '新兵', minHours: 0, minPoints: 0, minSamples: 0 },
            { rank: '列兵', minHours: 8, minPoints: 45, minSamples: 16 },
            { rank: '士官', minHours: 18, minPoints: 130, minSamples: 50 },
            { rank: '尉官', minHours: 36, minPoints: 320, minSamples: 120 },
            { rank: '校官', minHours: 42, minPoints: 420, minSamples: 150 },
            { rank: '将官', minHours: 52, minPoints: 580, minSamples: 210 },
            { rank: '王牌', minHours: 72, minPoints: 760, minSamples: 280 },
        ],
        honors: {
            steelStreak: 8,
            riskyWarrior: 8,
            thousandService: 300,
            l2Mastery: 70,
            disciplineGuardMinScore: 88,
            disciplineGuardMaxInvalid: 2,
            disciplineGuardMinSamples: 120,
            riskyFailRatioThreshold: 0.65,
        },
        scoring: {
            ...deepClone(basePolicyTemplate.scoring),
            stageMultipliers: {
                score: { l0: 0.25, l1: 1, l2: 1.3 },
                health: { l0: 0.3, l1: 1, l2: 1.15 },
            },
        },
        demotion: {
            ...deepClone(basePolicyTemplate.demotion),
            regularFailRatio: 0.70,
        },
        retirement: {
            ...deepClone(basePolicyTemplate.retirement),
            disciplineThreshold: 35,
        },
    },
};

const policyProfileRaw = String(process.env.PROXY_HUB_POLICY_PROFILE || '').toLowerCase();
const activeProfile = ['production', 'soak'].includes(policyProfileRaw)
    ? policyProfileRaw
    : 'production';

const battleL1LifecycleQuotaByProfile = {
    production: { active: 0.50, reserve: 0.20, candidate: 0.30 },
    soak: { active: 0.50, reserve: 0.20, candidate: 0.30 },
};

const l2LookbackByProfile = {
    production: 20,
    soak: 25,
};
const battleL2SyncMsByProfile = {
    production: 900_000,
    soak: 600_000,
};
const battleL3SyncMsByProfile = {
    production: 1_200_000,
    soak: 600_000,
};

const defaultBattleL3Targets = [
    {
        name: 'ly-flight-browser',
        url: process.env.PROXY_HUB_BATTLE_L3_PRIMARY_URL
            || process.env.PROXY_HUB_BATTLE_L2_PRIMARY_URL
            || 'https://www.ly.com/flights/home',
    },
    {
        name: 'baidu-browser',
        url: process.env.PROXY_HUB_BATTLE_L3_SECONDARY_URL
            || process.env.PROXY_HUB_BATTLE_L2_FALLBACK_URL
            || 'https://www.baidu.com',
    },
];
const resolvedBattleL3Targets = parseJsonArrayEnv(
    process.env.PROXY_HUB_BATTLE_L3_TARGETS_JSON,
    defaultBattleL3Targets,
).map((target) => ({
    name: String(target?.name || target?.url || 'l3-target'),
    url: String(target?.url || ''),
})).filter((target) => target.url.length > 0);
const resolvedBattleL3Protocols = String(process.env.PROXY_HUB_BATTLE_L3_ALLOWED_PROTOCOLS || 'http,https,socks5')
    .split(',')
    .map((protocol) => String(protocol || '').trim().toLowerCase())
    .filter((protocol, index, list) => protocol.length > 0 && list.indexOf(protocol) === index);

// 0232_hasOwnEnv_检查环境变量是否显式配置逻辑
function hasOwnEnv(name) {
    return Object.prototype.hasOwnProperty.call(process.env, name);
}

// 0233_parseLifecycleQuota_解析生命周期配额逻辑
function parseLifecycleQuota(raw, fallback) {
    if (raw == null || String(raw).trim() === '') return fallback;
    try {
        const parsed = JSON.parse(String(raw));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
        const active = Number(parsed.active);
        const reserve = Number(parsed.reserve);
        const candidate = Number(parsed.candidate);
        if (!Number.isFinite(active) || !Number.isFinite(reserve) || !Number.isFinite(candidate)) return fallback;
        return { active, reserve, candidate };
    } catch {
        return fallback;
    }
}

const defaultLifecycleQuota = deepClone(battleL1LifecycleQuotaByProfile[activeProfile]);
const hasCandidateQuotaEnv = hasOwnEnv('PROXY_HUB_BATTLE_CANDIDATE_QUOTA');
const hasLifecycleQuotaEnv = hasOwnEnv('PROXY_HUB_BATTLE_L1_LIFECYCLE_QUOTA');
const lifecycleQuotaFromEnv = parseLifecycleQuota(
    process.env.PROXY_HUB_BATTLE_L1_LIFECYCLE_QUOTA,
    defaultLifecycleQuota,
);
const resolvedLifecycleQuota = hasLifecycleQuotaEnv
    ? lifecycleQuotaFromEnv
    : (hasCandidateQuotaEnv ? undefined : defaultLifecycleQuota);

const defaultBranchingRules = [
    {
        id: 'l2_promote_navy',
        priority: 10,
        stage: 'l2',
        outcomes: ['success'],
        from: ['陆军'],
        to: '海军',
        failStreakOp: 'reset',
        eventType: 'branch_transfer',
    },
    {
        id: 'l2_reset_navy_streak',
        priority: 20,
        stage: 'l2',
        outcomes: ['success'],
        from: ['海军'],
        failStreakOp: 'reset',
        eventType: 'branch_streak_reset',
    },
    {
        id: 'l2_fail_navy_fallback',
        priority: 30,
        stage: 'l2',
        outcomes: ['blocked', 'timeout', 'network_error', 'invalid_feedback'],
        from: ['海军'],
        failStreakOp: 'increment',
        fallbackAt: 3,
        fallbackTo: '陆军',
        eventType: 'branch_fallback',
    },
    {
        id: 'l3_promote_seal',
        priority: 40,
        stage: 'l3',
        outcomes: ['success'],
        from: ['陆军', '海军', '海豹突击队'],
        to: '海豹突击队',
        failStreakOp: 'reset',
        eventType: 'branch_transfer',
    },
    {
        id: 'l3_fail_seal_fallback',
        priority: 50,
        stage: 'l3',
        outcomes: ['blocked', 'timeout', 'network_error', 'invalid_feedback'],
        from: ['海豹突击队'],
        failStreakOp: 'increment',
        fallbackAt: 3,
        fallbackTo: '陆军',
        eventType: 'branch_fallback',
    },
];
const resolvedBranchingRules = parseJsonArrayEnv(
    process.env.PROXY_HUB_BRANCHING_RULES_JSON,
    defaultBranchingRules,
);
const resolvedNativeTargetBranches = parseCsvListEnv(
    process.env.PROXY_HUB_NATIVE_TARGET_BRANCHES,
    ['海军', '海豹突击队'],
);

const sourceProfiles = {
    speedx_bundle: {
        name: 'TheSpeedX/PROXY-List',
        enabled: true,
        dbPath: 'apps/proxy-pool-service/data/proxyhub-speedx-bundle.db',
        feeds: [
            {
                name: 'TheSpeedX/http',
                url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
                enabled: true,
                defaultProtocol: 'http',
                sourceFormat: 'line',
            },
            {
                name: 'TheSpeedX/socks4',
                url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt',
                enabled: true,
                defaultProtocol: 'socks4',
                sourceFormat: 'line',
            },
            {
                name: 'TheSpeedX/socks5',
                url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
                enabled: true,
                defaultProtocol: 'socks5',
                sourceFormat: 'line',
            },
        ],
    },
    monosans_archive: {
        name: 'monosans/proxy-list',
        enabled: false,
        dbPath: 'apps/proxy-pool-service/data/proxyhub-v1.db',
        feeds: [
            {
                name: 'monosans/proxy-list',
                url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies.json',
                enabled: true,
                defaultProtocol: 'http',
                sourceFormat: 'json',
            },
        ],
    },
};

const sourceProfileRaw = String(process.env.PROXY_HUB_SOURCE_PROFILE || '').trim().toLowerCase();
const activeSourceProfile = Object.prototype.hasOwnProperty.call(sourceProfiles, sourceProfileRaw)
    ? sourceProfileRaw
    : 'speedx_bundle';
const speedxSocks4Enabled = toBool(process.env.PROXY_HUB_SPEEDX_SOCKS4_ENABLED, false);
const selectedSourceProfile = deepClone(sourceProfiles[activeSourceProfile]);
const speedxSocks4Feed = selectedSourceProfile.feeds.find((feed) => feed.name === 'TheSpeedX/socks4');
if (speedxSocks4Feed) {
    speedxSocks4Feed.enabled = speedxSocks4Enabled;
}

const hasLegacySourceOverride = hasOwnEnv('PROXY_HUB_SOURCE_NAME')
    || hasOwnEnv('PROXY_HUB_SOURCE_URL')
    || hasOwnEnv('PROXY_HUB_SOURCE_ENABLED')
    || hasOwnEnv('PROXY_HUB_SOURCE_DEFAULT_PROTOCOL')
    || hasOwnEnv('PROXY_HUB_SOURCE_FORMAT');

const legacySingleSourceFeed = {
    name: process.env.PROXY_HUB_SOURCE_NAME || 'monosans/proxy-list',
    url: process.env.PROXY_HUB_SOURCE_URL || 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies.json',
    enabled: toBool(process.env.PROXY_HUB_SOURCE_ENABLED, true),
    defaultProtocol: String(process.env.PROXY_HUB_SOURCE_DEFAULT_PROTOCOL || 'http').toLowerCase(),
    sourceFormat: String(process.env.PROXY_HUB_SOURCE_FORMAT || 'json').toLowerCase(),
};

let activeSourceFeeds = deepClone(selectedSourceProfile.feeds);
if (hasLegacySourceOverride) {
    activeSourceFeeds = [legacySingleSourceFeed];
}

const defaultStorageDbPath = selectedSourceProfile.dbPath;
const resolvedStorageDbPath = process.env.PROXY_HUB_DB_PATH || defaultStorageDbPath;

module.exports = {
    service: {
        name: 'ProxyHub',
        port: Number(process.env.PROXY_HUB_PORT || 5070),
        host: process.env.PROXY_HUB_HOST || '0.0.0.0',
        timezone: 'Asia/Shanghai',
        logRetention: 2000,
    },
    storage: {
        dbPath: resolvedStorageDbPath,
        snapshotRetentionDays: 7,
    },
    threadPool: {
        workers: Number(process.env.PROXY_HUB_WORKERS || 6),
        taskTimeoutMs: 120_000,
    },
    scheduler: {
        sourceSyncMs: Number(process.env.PROXY_HUB_SOURCE_SYNC_MS || 120_000),
        stateReviewMs: Number(process.env.PROXY_HUB_STATE_REVIEW_MS || 30_000),
        snapshotPersistMs: Number(process.env.PROXY_HUB_SNAPSHOT_MS || 60_000),
        maxValidationPerCycle: Number(process.env.PROXY_HUB_MAX_VALIDATE || 180),
    },
    candidateControl: {
        max: Number(process.env.PROXY_HUB_CANDIDATE_MAX || 3000),
        gateOverride: toBool(process.env.PROXY_HUB_CANDIDATE_GATE_OVERRIDE, false),
        sweepMs: Number(process.env.PROXY_HUB_CANDIDATE_SWEEP_MS || 900_000),
        staleHours: Number(process.env.PROXY_HUB_CANDIDATE_STALE_HOURS || 24),
        staleMinSamples: Number(process.env.PROXY_HUB_CANDIDATE_STALE_MIN_SAMPLES || 3),
        timeoutHours: Number(process.env.PROXY_HUB_CANDIDATE_TIMEOUT_HOURS || 72),
        maxRetirePerCycle: Number(process.env.PROXY_HUB_CANDIDATE_SWEEP_MAX_RETIRE || 2000),
    },
    failureBackoff: {
        enabled: toBool(process.env.PROXY_HUB_FAILURE_BACKOFF_ENABLED, true),
        l0BaseMs: Number(process.env.PROXY_HUB_FAILURE_BACKOFF_L0_MS || 300_000),
        l1BaseMs: Number(process.env.PROXY_HUB_FAILURE_BACKOFF_L1_MS || 600_000),
        l2BaseMs: Number(process.env.PROXY_HUB_FAILURE_BACKOFF_L2_MS || 900_000),
        multiplier: Number(process.env.PROXY_HUB_FAILURE_BACKOFF_MULTIPLIER || 1.8),
        maxMs: Number(process.env.PROXY_HUB_FAILURE_BACKOFF_MAX_MS || 21_600_000),
    },
    rollout: {
        version: 'v1.1',
        activeProfile,
        features: {
            stageWeighting: toBool(process.env.PROXY_HUB_FEATURE_STAGE_WEIGHTING, true),
            lifecycleHysteresis: toBool(process.env.PROXY_HUB_FEATURE_LIFECYCLE_HYSTERESIS, true),
            honorPromotionTuning: toBool(process.env.PROXY_HUB_FEATURE_HONOR_PROMOTION_TUNING, false),
        },
        orchestrator: {
            enabled: toBool(process.env.PROXY_HUB_ROLLOUT_ORCHESTRATOR_ENABLED, true),
            intervalMs: Number(process.env.PROXY_HUB_ROLLOUT_ORCHESTRATOR_INTERVAL_MS || 900_000),
            stableHours: Number(process.env.PROXY_HUB_ROLLOUT_STABLE_HOURS || 48),
            cooldownHours: Number(process.env.PROXY_HUB_ROLLOUT_COOLDOWN_HOURS || 24),
            minL2Samples: Number(process.env.PROXY_HUB_ROLLOUT_MIN_L2_SAMPLES || 20),
            leaseTtlMs: Number(process.env.PROXY_HUB_ROLLOUT_LEASE_TTL_MS || 120_000),
        },
        guardrails: {
            windowHours: Number(process.env.PROXY_HUB_ROLLBACK_WINDOW_HOURS || 24),
            activeDropThreshold: Number(process.env.PROXY_HUB_ROLLBACK_ACTIVE_DROP_RATIO || 0.20),
            l2DropPpThreshold: Number(process.env.PROXY_HUB_ROLLBACK_L2_DROP_PP || 0.03),
            retiredDailyMultiplier: Number(process.env.PROXY_HUB_ROLLBACK_RETIRED_MULTIPLIER || 2),
            retiredDailyMinAbs: Number(process.env.PROXY_HUB_ROLLBACK_RETIRED_MIN_ABS || 5),
            baseline: {
                activeCount: Number(process.env.PROXY_HUB_BASELINE_ACTIVE_COUNT || 84),
                l2SuccessRate: Number(process.env.PROXY_HUB_BASELINE_L2_SUCCESS_RATE || 0.5463),
            },
        },
    },
    battle: {
        enabled: String(process.env.PROXY_HUB_BATTLE_ENABLED || 'true') === 'true',
        l1SyncMs: Number(process.env.PROXY_HUB_BATTLE_L1_MS || 300_000),
        l2SyncMs: Number(process.env.PROXY_HUB_BATTLE_L2_MS || battleL2SyncMsByProfile[activeProfile] || 1_800_000),
        l2SyncMsByProfile: deepClone(battleL2SyncMsByProfile),
        maxBattleL1PerCycle: Number(process.env.PROXY_HUB_BATTLE_L1_MAX || 60),
        maxBattleL2PerCycle: Number(process.env.PROXY_HUB_BATTLE_L2_MAX || 20),
        candidateQuota: Number(process.env.PROXY_HUB_BATTLE_CANDIDATE_QUOTA || battleL1LifecycleQuotaByProfile[activeProfile].candidate),
        l1LifecycleQuota: resolvedLifecycleQuota,
        l2LookbackMinutes: Number(process.env.PROXY_HUB_BATTLE_L2_LOOKBACK_MINUTES || l2LookbackByProfile[activeProfile]),
        timeoutMs: {
            l1: Number(process.env.PROXY_HUB_BATTLE_L1_TIMEOUT_MS || 5_000),
            l2: Number(process.env.PROXY_HUB_BATTLE_L2_TIMEOUT_MS || 8_000),
        },
        l3: {
            enabled: toBool(process.env.PROXY_HUB_BATTLE_L3_ENABLED, true),
            syncMs: Number(process.env.PROXY_HUB_BATTLE_L3_MS || battleL3SyncMsByProfile[activeProfile] || 2_700_000),
            maxPerCycle: Number(process.env.PROXY_HUB_BATTLE_L3_MAX || 12),
            concurrency: Number(process.env.PROXY_HUB_BATTLE_L3_CONCURRENCY || 3),
            lookbackMinutes: Number(process.env.PROXY_HUB_BATTLE_L3_LOOKBACK_MINUTES || l2LookbackByProfile[activeProfile]),
            timeoutMs: Number(process.env.PROXY_HUB_BATTLE_L3_TIMEOUT_MS || 40_000),
            allowedProtocols: deepClone(resolvedBattleL3Protocols),
            targets: deepClone(resolvedBattleL3Targets),
            syncMsByProfile: deepClone(battleL3SyncMsByProfile),
        },
        blockedStatusCodes: [401, 403, 429, 503],
        blockSignals: [
            'captcha',
            'security check',
            'are you human',
            'access denied',
            'forbidden',
            'robot check',
            '验证码',
            '访问过于频繁',
            '异常访问',
            '人机验证',
        ],
        targets: {
            l1: [
                { name: 'httpbin/ip', url: 'https://httpbin.org/ip' },
                { name: 'ipify', url: 'https://api.ipify.org?format=json' },
            ],
            l2Primary: [
                {
                    name: 'ly-flight-main',
                    url: process.env.PROXY_HUB_BATTLE_L2_PRIMARY_URL || 'https://www.ly.com/flights/home',
                },
            ],
            l2Fallback: [
                { name: 'baidu-home', url: 'https://www.baidu.com' },
            ],
        },
    },
    source: {
        activeProfile: activeSourceProfile,
        profiles: deepClone(sourceProfiles),
        activeFeeds: deepClone(activeSourceFeeds),
        legacySingleOverride: hasLegacySourceOverride,
        monosans: deepClone(sourceProfiles.monosans_archive.feeds[0]),
    },
    validation: {
        allowedProtocols: ['http', 'https', 'socks4', 'socks5'],
        maxTimeoutMs: 2_500,
    },
    branching: {
        enabled: toBool(process.env.PROXY_HUB_BRANCHING_ENABLED, true),
        fieldName: 'service_branch',
        failStreakField: 'branch_fail_streak',
        defaultBranch: String(process.env.PROXY_HUB_BRANCHING_DEFAULT || '陆军'),
        rules: deepClone(resolvedBranchingRules),
    },
    native: {
        enabled: toBool(process.env.PROXY_HUB_NATIVE_ENABLED, true),
        timeoutMs: Number(process.env.PROXY_HUB_NATIVE_TIMEOUT_MS || 3000),
        retryHours: Number(process.env.PROXY_HUB_NATIVE_RETRY_HOURS || 1),
        targetBranches: deepClone(resolvedNativeTargetBranches),
    },
    policyProfiles: deepClone(policyProfiles),
    policy: deepClone(policyProfiles[activeProfile]),
    ui: {
        refreshMs: 5_000,
    },
    soak: {
        durationHours: 10,
        summaryIntervalMs: 3_600_000,
    },
};

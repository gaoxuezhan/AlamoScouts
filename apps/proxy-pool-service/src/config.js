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

const legacyRanks = [
    { rank: '新兵', minHours: 0, minPoints: 0, minSamples: 0 },
    { rank: '列兵', minHours: 12, minPoints: 80, minSamples: 20 },
    { rank: '士官', minHours: 24, minPoints: 220, minSamples: 60 },
    { rank: '尉官', minHours: 48, minPoints: 520, minSamples: 140 },
    { rank: '王牌', minHours: 72, minPoints: 980, minSamples: 260 },
];

const legacyHonors = {
    steelStreak: 30,
    riskyWarrior: 20,
    thousandService: 1000,
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
            { rank: '王牌', minHours: 70, minPoints: 860, minSamples: 320 },
        ],
        honors: {
            steelStreak: 16,
            riskyWarrior: 15,
            thousandService: 800,
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
            { rank: '王牌', minHours: 60, minPoints: 640, minSamples: 220 },
        ],
        honors: {
            steelStreak: 8,
            riskyWarrior: 8,
            thousandService: 300,
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

const activeProfile = ['production', 'soak'].includes(String(process.env.PROXY_HUB_POLICY_PROFILE || '').toLowerCase())
    ? String(process.env.PROXY_HUB_POLICY_PROFILE || '').toLowerCase()
    : 'production';

const battleL1LifecycleQuotaByProfile = {
    production: { active: 0.50, reserve: 0.20, candidate: 0.30 },
    soak: { active: 0.50, reserve: 0.20, candidate: 0.30 },
};

const l2LookbackByProfile = {
    production: 20,
    soak: 25,
};

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

module.exports = {
    service: {
        name: 'ProxyHub',
        port: Number(process.env.PROXY_HUB_PORT || 5070),
        host: process.env.PROXY_HUB_HOST || '0.0.0.0',
        timezone: 'Asia/Shanghai',
        logRetention: 2000,
    },
    storage: {
        dbPath: process.env.PROXY_HUB_DB_PATH || 'apps/proxy-pool-service/data/proxyhub-v1.db',
        snapshotRetentionDays: 7,
    },
    threadPool: {
        workers: Number(process.env.PROXY_HUB_WORKERS || 6),
        taskTimeoutMs: 60_000,
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
        l2SyncMs: Number(process.env.PROXY_HUB_BATTLE_L2_MS || 1_800_000),
        maxBattleL1PerCycle: Number(process.env.PROXY_HUB_BATTLE_L1_MAX || 60),
        maxBattleL2PerCycle: Number(process.env.PROXY_HUB_BATTLE_L2_MAX || 20),
        candidateQuota: Number(process.env.PROXY_HUB_BATTLE_CANDIDATE_QUOTA || battleL1LifecycleQuotaByProfile[activeProfile].candidate),
        l1LifecycleQuota: resolvedLifecycleQuota,
        l2LookbackMinutes: Number(process.env.PROXY_HUB_BATTLE_L2_LOOKBACK_MINUTES || l2LookbackByProfile[activeProfile]),
        timeoutMs: {
            l1: Number(process.env.PROXY_HUB_BATTLE_L1_TIMEOUT_MS || 5_000),
            l2: Number(process.env.PROXY_HUB_BATTLE_L2_TIMEOUT_MS || 8_000),
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
        monosans: {
            name: 'monosans/proxy-list',
            url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies.json',
            enabled: true,
        },
    },
    validation: {
        allowedProtocols: ['http', 'https', 'socks5'],
        maxTimeoutMs: 2_500,
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

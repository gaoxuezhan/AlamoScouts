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
    policy: {
        serviceHourScale: Number(process.env.PROXY_HUB_SERVICE_HOUR_SCALE || 3),
        promotionProtectHours: 6,
        ranks: [
            { rank: '新兵', minHours: 0, minPoints: 0, minSamples: 0 },
            { rank: '列兵', minHours: 12, minPoints: 80, minSamples: 20 },
            { rank: '士官', minHours: 24, minPoints: 220, minSamples: 60 },
            { rank: '尉官', minHours: 48, minPoints: 520, minSamples: 140 },
            { rank: '王牌', minHours: 72, minPoints: 980, minSamples: 260 },
        ],
        scoring: {
            success: 5,
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
            severeBlockedRatio: 0.70,
            healthThreshold: 45,
            lowHealthRetireThreshold: 20,
        },
        retirement: {
            disciplineThreshold: 40,
            disciplineInvalidCount: 5,
            technicalMinSamples: 60,
            technicalSuccessRatio: 0.10,
            battleDamageBlockedRatio: 0.60,
            honorMinServiceHours: 720,
            honorMinSuccess: 800,
        },
        honors: {
            steelStreak: 30,
            riskyWarrior: 20,
            thousandService: 1000,
        },
    },
    ui: {
        refreshMs: 5_000,
    },
    soak: {
        durationHours: 24,
        summaryIntervalMs: 3_600_000,
    },
};

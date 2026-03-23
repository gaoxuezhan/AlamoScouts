const { EventEmitter } = require('node:events');
const { evaluateCombat, evaluateStateTransition } = require('./rank');
const { EVENT_LEVEL } = require('./constants');
const { generateRecruitName } = require('./naming');

// 0023_parseArrayJson_解析数组JSON逻辑
function parseArrayJson(value) {
    try {
        if (!value) return [];
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// 0024_runWithConcurrency_执行并发逻辑
async function runWithConcurrency(items, limit, handler) {
    const running = new Set();
    const errors = [];

    for (const item of items) {
        const task = Promise.resolve()
            .then(() => handler(item))
            .catch((error) => {
                errors.push(error);
            });

        running.add(task);
        const cleanup = task.finally(() => running.delete(task));
        cleanup.catch(() => {});

        if (running.size >= limit) {
            await Promise.race(running);
        }
    }

    await Promise.allSettled(Array.from(running));

    if (errors.length > 0) {
        throw errors[0];
    }
}

// 0025_outcomeLabel_结果标签逻辑
function outcomeLabel(outcome) {
    if (outcome === 'success') return '成功';
    if (outcome === 'blocked') return '封禁';
    if (outcome === 'timeout') return '超时';
    if (outcome === 'network_error') return '网络错误';
    if (outcome === 'invalid_feedback') return '反馈无效';
    return '未知';
}

// 0026_mapEventTypeToChinese_映射事件类型到中文逻辑
function mapEventTypeToChinese(eventType) {
    if (eventType === 'promotion') return '晋升';
    if (eventType === 'demotion') return '降级';
    if (eventType === 'retirement') return '退伍';
    if (eventType === 'honor') return '授予荣誉';
    return '评分事件';
}

// 0208_pickValidationFailureOutcome_选择L0失败结果逻辑
function pickValidationFailureOutcome(validation) {
    const reason = String(validation?.reason || '').toLowerCase();
    if (reason.includes('timeout')) {
        return 'timeout';
    }
    if (reason.includes('blocked')) {
        return 'blocked';
    }
    return 'network_error';
}

// 0209_buildBattleCounterUpdates_构建战场计数更新逻辑
function buildBattleCounterUpdates(proxy, nowIso, outcome, stage) {
    const isSuccess = outcome === 'success';
    const updates = {
        last_battle_checked_at: nowIso,
        last_battle_outcome: outcome,
        battle_success_count: (proxy.battle_success_count || 0) + (isSuccess ? 1 : 0),
        battle_fail_count: (proxy.battle_fail_count || 0) + (isSuccess ? 0 : 1),
    };
    if (stage === 'l1' && isSuccess) {
        updates.last_l1_success_at = nowIso;
    }
    return updates;
}

// 0258_readCandidateControl_读取新兵治理配置逻辑
function readCandidateControl(config = {}) {
    const raw = config.candidateControl || {};
    const max = Math.max(0, Number(raw.max) || 0);
    const lowRaw = Number(raw.low);
    const refillStopRaw = Number(raw.refillStop);
    const lowDefault = max > 0 ? Math.min(800, max) : 0;
    const refillStopDefault = max > 0 ? Math.min(1350, max) : 0;
    const normalizedLow = max > 0
        ? Math.max(0, Math.min(max, Math.floor(Number.isFinite(lowRaw) ? lowRaw : lowDefault)))
        : 0;
    const normalizedRefillStop = max > 0
        ? Math.max(
            normalizedLow,
            Math.min(max, Math.floor(Number.isFinite(refillStopRaw) ? refillStopRaw : refillStopDefault)),
        )
        : 0;
    return {
        max,
        low: normalizedLow,
        refillStop: normalizedRefillStop,
        gateOverride: raw.gateOverride === true,
        sweepMs: Math.max(60_000, Number(raw.sweepMs) || 900_000),
        staleHours: Math.max(1, Number(raw.staleHours) || 24),
        staleMinSamples: Math.max(0, Number(raw.staleMinSamples) || 3),
        timeoutHours: Math.max(1, Number(raw.timeoutHours) || 72),
        maxRetirePerCycle: Math.max(1, Math.min(5000, Number(raw.maxRetirePerCycle) || 2000)),
    };
}

// 0259_buildCandidateGateState_构建新兵闸门状态逻辑
function buildCandidateGateState(config = {}, candidateCount = 0, refillWindowOpen = false) {
    const control = readCandidateControl(config);
    const normalizedCount = Math.max(0, Number(candidateCount) || 0);
    const refillWindowOpenBefore = refillWindowOpen === true;
    const hasHighWatermark = control.max > 0;
    const lowWatermarkReached = hasHighWatermark && normalizedCount <= control.low;
    const refillStopReached = hasHighWatermark && normalizedCount >= control.refillStop;
    const highWatermarkReached = hasHighWatermark && normalizedCount >= control.max;

    let nextRefillWindowOpen = refillWindowOpenBefore;
    if (!control.gateOverride && hasHighWatermark) {
        if (!nextRefillWindowOpen && lowWatermarkReached) {
            nextRefillWindowOpen = true;
        }
        if (nextRefillWindowOpen && refillStopReached) {
            nextRefillWindowOpen = false;
        }
    }

    const gatedByThreshold = highWatermarkReached;
    const gatedByHysteresis = hasHighWatermark
        && !control.gateOverride
        && !nextRefillWindowOpen
        && normalizedCount > control.low
        && normalizedCount < control.max;

    return {
        ...control,
        candidateCount: normalizedCount,
        lowWatermarkReached,
        refillStopReached,
        highWatermarkReached,
        refillWindowOpenBefore,
        refillWindowOpen: nextRefillWindowOpen,
        refillWindowStateChanged: nextRefillWindowOpen !== refillWindowOpenBefore,
        gatedByThreshold,
        gatedByHysteresis,
        gateActive: !control.gateOverride && (gatedByThreshold || gatedByHysteresis),
    };
}

// 0263_readFailureBackoff_读取失败退避配置逻辑
function readFailureBackoff(config = {}) {
    const raw = config.failureBackoff || {};
    const multiplier = Number(raw.multiplier);
    return {
        enabled: raw.enabled !== false,
        l0BaseMs: Math.max(60_000, Number(raw.l0BaseMs) || 300_000),
        l1BaseMs: Math.max(60_000, Number(raw.l1BaseMs) || 600_000),
        l2BaseMs: Math.max(60_000, Number(raw.l2BaseMs) || 900_000),
        multiplier: Number.isFinite(multiplier) && multiplier >= 1 ? multiplier : 1.8,
        maxMs: Math.max(60_000, Number(raw.maxMs) || 21_600_000),
    };
}

// 0264_resolveFailureBackoff_计算失败退避窗口逻辑
function resolveFailureBackoff({
    config = {},
    proxy = {},
    nowIso = new Date().toISOString(),
    outcome = 'network_error',
    stage = 'l0',
} = {}) {
    const policy = readFailureBackoff(config);
    if (!policy.enabled || outcome === 'success') {
        return {
            enabled: policy.enabled,
            shouldBackoff: false,
            delayMs: 0,
            untilIso: null,
            failStreak: 0,
        };
    }

    const failStreak = Math.max(1, Number(proxy?.consecutive_fail) || 1);
    const baseMs = stage === 'l2'
        ? policy.l2BaseMs
        : (stage === 'l1' ? policy.l1BaseMs : policy.l0BaseMs);
    const rawDelay = baseMs * (policy.multiplier ** Math.max(0, failStreak - 1));
    const delayMs = Math.max(baseMs, Math.min(policy.maxMs, Math.round(rawDelay)));
    const nowMs = Date.parse(nowIso);
    const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();

    return {
        enabled: policy.enabled,
        shouldBackoff: true,
        delayMs,
        untilIso: new Date(safeNowMs + delayMs).toISOString(),
        failStreak,
    };
}

// 0266_resolveSourceFeeds_解析抓源配置逻辑
function resolveSourceFeeds(config = {}) {
    const source = config.source || {};

    if (Array.isArray(source.activeFeeds) && source.activeFeeds.length > 0) {
        return source.activeFeeds
            .filter((feed) => feed && typeof feed === 'object' && feed.enabled !== false)
            .map((feed) => ({
                name: String(feed.name || 'unknown-source'),
                url: String(feed.url || ''),
                enabled: feed.enabled !== false,
                sourceFormat: String(feed.sourceFormat || 'auto').toLowerCase(),
                defaultProtocol: String(feed.defaultProtocol || 'http').toLowerCase(),
            }))
            .filter((feed) => feed.url.length > 0);
    }

    if (source.monosans && source.monosans.enabled !== false && source.monosans.url) {
        return [{
            name: String(source.monosans.name || 'monosans/proxy-list'),
            url: String(source.monosans.url),
            enabled: true,
            sourceFormat: String(source.monosans.sourceFormat || 'auto').toLowerCase(),
            defaultProtocol: String(source.monosans.defaultProtocol || 'http').toLowerCase(),
        }];
    }

    return [];
}

const DEFAULT_BRANCH_FAIL_OUTCOMES = ['blocked', 'timeout', 'network_error', 'invalid_feedback'];
const DEFAULT_BRANCHING_RULES = [
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
        outcomes: DEFAULT_BRANCH_FAIL_OUTCOMES,
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
        outcomes: DEFAULT_BRANCH_FAIL_OUTCOMES,
        from: ['海豹突击队'],
        failStreakOp: 'increment',
        fallbackAt: 3,
        fallbackTo: '陆军',
        eventType: 'branch_fallback',
    },
];

// 0273_normalizeBranchRuleList_规范化编制规则列表逻辑
function normalizeBranchRuleList(value, fallback = []) {
    if (!Array.isArray(value)) {
        return [...fallback];
    }
    const normalized = value
        .map((item) => String(item || '').trim())
        .filter((item) => item.length > 0);
    return normalized.length > 0 ? normalized : [...fallback];
}

// 0274_readBranchingConfig_读取编制配置逻辑
function readBranchingConfig(config = {}) {
    const raw = config.branching || {};
    const fieldName = String(raw.fieldName || 'service_branch').trim() || 'service_branch';
    const failStreakField = String(raw.failStreakField || 'branch_fail_streak').trim() || 'branch_fail_streak';
    const defaultBranch = String(raw.defaultBranch || '陆军').trim() || '陆军';
    const rawRules = Array.isArray(raw.rules) && raw.rules.length > 0
        ? raw.rules
        : DEFAULT_BRANCHING_RULES;

    const rules = rawRules.map((rule, index) => {
        const normalized = rule && typeof rule === 'object' ? rule : {};
        const stageList = normalizeBranchRuleList(
            normalized.stages || [normalized.stage || '*'],
            ['*'],
        ).map((item) => item.toLowerCase());
        const outcomeList = normalizeBranchRuleList(
            normalized.outcomes || [normalized.outcome || '*'],
            ['*'],
        ).map((item) => item.toLowerCase());
        const fromList = normalizeBranchRuleList(
            normalized.from || normalized.fromBranches || ['*'],
            ['*'],
        );
        const failStreakOp = ['none', 'reset', 'increment', 'set'].includes(String(normalized.failStreakOp || 'none'))
            ? String(normalized.failStreakOp || 'none')
            : 'none';
        const fallbackAt = Number(normalized.fallbackAt);
        const failStreakValue = Number(normalized.failStreakValue);
        return {
            id: String(normalized.id || `branch_rule_${index + 1}`),
            priority: Number(normalized.priority) || (index + 1) * 10,
            stages: stageList,
            outcomes: outcomeList,
            from: fromList,
            to: normalized.to == null ? null : String(normalized.to),
            failStreakOp,
            failStreakValue: Number.isFinite(failStreakValue) ? Math.max(0, Math.round(failStreakValue)) : 0,
            fallbackAt: Number.isFinite(fallbackAt) ? Math.max(1, Math.round(fallbackAt)) : null,
            fallbackTo: normalized.fallbackTo == null ? null : String(normalized.fallbackTo),
            eventType: String(normalized.eventType || 'branch_transition'),
        };
    }).sort((a, b) => a.priority - b.priority);

    return {
        enabled: raw.enabled !== false,
        fieldName,
        failStreakField,
        defaultBranch,
        rules,
    };
}

// 0275_resolveBranchingTransition_解析编制流转逻辑
function resolveBranchingTransition({
    proxy = {},
    stage = 'l2',
    outcome = 'success',
    config = {},
} = {}) {
    const policy = readBranchingConfig(config);
    if (!policy.enabled) {
        return { updates: {}, events: [] };
    }

    const stageText = String(stage || '').toLowerCase();
    const outcomeText = String(outcome || '').toLowerCase();
    const currentBranchRaw = proxy?.[policy.fieldName];
    const currentBranch = String(currentBranchRaw == null ? policy.defaultBranch : currentBranchRaw) || policy.defaultBranch;
    const currentStreak = Math.max(0, Number(proxy?.[policy.failStreakField]) || 0);

    const matchedRule = policy.rules.find((rule) => {
        const stageMatch = rule.stages.includes('*') || rule.stages.includes(stageText);
        const outcomeMatch = rule.outcomes.includes('*') || rule.outcomes.includes(outcomeText);
        const fromMatch = rule.from.includes('*') || rule.from.includes(currentBranch);
        return stageMatch && outcomeMatch && fromMatch;
    });
    if (!matchedRule) {
        return { updates: {}, events: [] };
    }

    let nextBranch = currentBranch;
    let nextStreak = currentStreak;
    if (matchedRule.to) {
        nextBranch = matchedRule.to;
    }

    if (matchedRule.failStreakOp === 'reset') {
        nextStreak = 0;
    } else if (matchedRule.failStreakOp === 'increment') {
        nextStreak = currentStreak + 1;
    } else if (matchedRule.failStreakOp === 'set') {
        nextStreak = matchedRule.failStreakValue;
    }

    let fallbackApplied = false;
    if (matchedRule.fallbackAt != null && nextStreak >= matchedRule.fallbackAt) {
        nextBranch = matchedRule.fallbackTo || policy.defaultBranch;
        nextStreak = 0;
        fallbackApplied = true;
    }

    const updates = {};
    if (nextBranch !== currentBranch) {
        updates[policy.fieldName] = nextBranch;
    }
    if (nextStreak !== currentStreak) {
        updates[policy.failStreakField] = nextStreak;
    }

    if (Object.keys(updates).length === 0) {
        return { updates, events: [] };
    }

    const details = {
        ruleId: matchedRule.id,
        stage: stageText,
        outcome: outcomeText,
        branchBefore: currentBranch,
        branchAfter: nextBranch,
        failStreakBefore: currentStreak,
        failStreakAfter: nextStreak,
        fallbackApplied,
    };
    const events = [];

    if (nextBranch !== currentBranch) {
        events.push({
            event_type: fallbackApplied ? 'branch_fallback' : matchedRule.eventType,
            message: `编制流转：${currentBranch} -> ${nextBranch}`,
            details,
        });
    } else if (nextStreak !== currentStreak) {
        events.push({
            event_type: matchedRule.failStreakOp === 'reset' ? 'branch_streak_reset' : 'branch_streak',
            message: matchedRule.failStreakOp === 'reset'
                ? `编制计数清零：${nextBranch}`
                : `编制连续失败：${nextBranch} (${nextStreak})`,
            details,
        });
    }

    return { updates, events };
}

// 0281_createAbortSignal_创建中止信号逻辑
function createAbortSignal(timeoutMs) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(timeoutMs);
    }
    return undefined;
}

// 0290_normalizeNativeReason_规范化籍贯错误原因逻辑
function normalizeNativeReason(value, fallback = 'request-failed') {
    const text = String(value == null ? '' : value).trim().toLowerCase();
    if (text.length === 0) {
        return fallback;
    }
    const normalized = text
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return normalized || fallback;
}

const NATIVE_LOOKUP_READABLE_LABELS = {
    ip: 'IP地址(ip)',
    ipAddress: 'IP地址(ipAddress)',
    network: '网络段(network)',
    version: 'IP版本(version)',
    ipVersion: 'IP版本(ipVersion)',
    city: '城市(city)',
    region: '地区(region)',
    region_code: '地区代码(region_code)',
    regionCode: '地区代码(regionCode)',
    country: '国家(country)',
    country_name: '国家(country_name)',
    country_code: '国家代码(country_code)',
    country_code_iso3: '国家三字码(country_code_iso3)',
    capital: '首都(capital)',
    country_capital: '首都(country_capital)',
    country_tld: '国家域名后缀(country_tld)',
    continent: '洲(continent)',
    continentCode: '洲代码(continentCode)',
    continent_code: '洲代码(continent_code)',
    in_eu: '是否欧盟(in_eu)',
    postal: '邮编(postal)',
    zipCode: '邮编(zipCode)',
    latitude: '纬度(latitude)',
    longitude: '经度(longitude)',
    timezone: '时区(timezone)',
    timeZones: '时区列表(timeZones)',
    utc_offset: 'UTC偏移(utc_offset)',
    phoneCodes: '电话区号列表(phoneCodes)',
    country_calling_code: '国家区号(country_calling_code)',
    currency: '货币代码(currency)',
    currencies: '货币列表(currencies)',
    currency_name: '货币名称(currency_name)',
    languages: '语言(languages)',
    country_area: '国家面积(country_area)',
    country_population: '国家人口(country_population)',
    asn: 'ASN(asn)',
    asnOrganization: 'ASN组织(asnOrganization)',
    org: '组织(org)',
    isp: '网络归属(isp)',
    countryName: '国家(countryName)',
    countryCode: '国家代码(countryCode)',
    cityName: '城市(cityName)',
    regionName: '地区(regionName)',
    latitudeLongitudeAccuracyRadius: '定位精度半径(latitudeLongitudeAccuracyRadius)',
    isProxy: '代理标记(isProxy)',
    error: '错误(error)',
    reason: '原因(reason)',
    message: '消息(message)',
};

// 0291_stableSortJsonValue_稳定排序JSON值逻辑
function stableSortJsonValue(value) {
    if (Array.isArray(value)) {
        return value.map((item) => stableSortJsonValue(item));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    const sortedKeys = Object.keys(value).sort((a, b) => a.localeCompare(b));
    const result = {};
    for (const key of sortedKeys) {
        result[key] = stableSortJsonValue(value[key]);
    }
    return result;
}

// 0292_parseJsonPayloadLoose_宽松解析JSON载荷逻辑
function parseJsonPayloadLoose(rawText, fallbackValue) {
    const text = String(rawText == null ? '' : rawText).trim();
    if (text.length > 0) {
        try {
            return JSON.parse(text);
        } catch {
            return fallbackValue;
        }
    }
    return fallbackValue;
}

// 0293_normalizeNativeRawJson_规范化籍贯原始JSON逻辑
function normalizeNativeRawJson(rawText, payload) {
    const parsed = parseJsonPayloadLoose(rawText, payload);
    if (parsed === undefined) {
        return String(rawText == null ? '' : rawText);
    }
    return JSON.stringify(stableSortJsonValue(parsed), null, 2);
}

// 0294_formatNativeReadableValue_格式化籍贯可读值逻辑
function formatNativeReadableValue(value) {
    if (value === undefined) {
        return 'null';
    }
    return JSON.stringify(stableSortJsonValue(value));
}

// 0295_buildNativeLookupReadableText_构建籍贯可读文本逻辑
function buildNativeLookupReadableText(payload) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const sorted = stableSortJsonValue(payload);
        const keys = Object.keys(sorted);
        if (keys.length === 0) {
            return '原文不可解析';
        }
        return keys.map((key) => {
            const label = NATIVE_LOOKUP_READABLE_LABELS[key] || `原键名(${key})`;
            return `${label}: ${formatNativeReadableValue(sorted[key])}`;
        }).join('\n');
    }
    if (Array.isArray(payload)) {
        return `原键名(root): ${JSON.stringify(stableSortJsonValue(payload))}`;
    }
    if (payload == null) {
        return '原文不可解析';
    }
    return `原键名(root): ${JSON.stringify(payload)}`;
}

const NATIVE_LOOKUP_PROVIDER_CHAIN = ['ipapi.co', 'freeipapi'];
const NATIVE_LOOKUP_PROVIDER_CHAIN_LABEL = NATIVE_LOOKUP_PROVIDER_CHAIN.join(',');

// 0282_readNativeLookupConfig_读取籍贯解析配置逻辑
function readNativeLookupConfig(config = {}) {
    const raw = config.native || {};
    const targetBranches = Array.isArray(raw.targetBranches)
        ? raw.targetBranches
            .map((item) => String(item || '').trim())
            .filter((item, index, list) => item.length > 0 && list.indexOf(item) === index)
        : ['海军', '海豹突击队'];
    return {
        enabled: raw.enabled === true,
        timeoutMs: Math.max(500, Number(raw.timeoutMs) || 3000),
        retryHours: Math.max(1, Number(raw.retryHours) || 1),
        targetBranches: targetBranches.length > 0 ? targetBranches : ['海军', '海豹突击队'],
    };
}

// 0283_isNativeRetryDue_判断籍贯重试窗口逻辑
function isNativeRetryDue(nextRetryAt, nowIso) {
    if (!nextRetryAt) {
        return true;
    }
    const nextMs = Date.parse(nextRetryAt);
    if (!Number.isFinite(nextMs)) {
        return true;
    }
    const nowMs = Date.parse(nowIso);
    return Number.isFinite(nowMs) ? nextMs <= nowMs : nextMs <= Date.now();
}

// 0284_normalizeNativeLookupStatus_规范化籍贯状态逻辑
function normalizeNativeLookupStatus(status) {
    const text = String(status || '').trim().toLowerCase();
    if (['pending', 'resolved', 'failed', 'skipped'].includes(text)) {
        return text;
    }
    return 'pending';
}

class ProxyHubEngine extends EventEmitter {
    // 0027_constructor_初始化实例逻辑
    constructor({ config, db, workerPool, logger, now }) {
        super();
        this.config = config;
        this.db = db;
        this.workerPool = workerPool;
        this.logger = logger;
        this.now = now || (() => new Date());

        this.started = false;
        this.sourceSyncTimer = null;
        this.stateReviewTimer = null;
        this.snapshotTimer = null;
        this.battleL1Timer = null;
        this.battleL2Timer = null;
        this.battleL3Timer = null;
        this.candidateSweepTimer = null;

        this.isSourceCycleRunning = false;
        this.isStateReviewRunning = false;
        this.isBattleL1Running = false;
        this.isBattleL2Running = false;
        this.isBattleL3Running = false;
        this.isCandidateSweepRunning = false;
        this.threadPoolAlerting = false;
        this.nativeLookupInFlight = new Set();
        this.sourceCycleThrottleFactor = 1;
        this.sourceCycleCounter = 0;
        this.candidateRefillWindowOpen = false;
    }

    // 0210_isBattleEnabled_判断战场测试开关逻辑
    isBattleEnabled() {
        return this.config?.battle?.enabled === true;
    }

    // 0278_isBattleL3Enabled_判断战场L3开关逻辑
    isBattleL3Enabled() {
        return this.isBattleEnabled() && this.config?.battle?.l3?.enabled === true;
    }

    // 0298_setSourceCycleThrottleFactor_设置抓源节流倍率逻辑
    setSourceCycleThrottleFactor(factor = 1) {
        const numeric = Number(factor);
        const normalized = Number.isFinite(numeric)
            ? Math.max(1, Math.min(12, Math.round(numeric)))
            : 1;
        this.sourceCycleThrottleFactor = normalized;
        return this.sourceCycleThrottleFactor;
    }

    // 0299_getSourceCycleThrottleState_获取抓源节流状态逻辑
    getSourceCycleThrottleState() {
        return {
            factor: this.sourceCycleThrottleFactor,
            counter: this.sourceCycleCounter,
        };
    }

    // 0285_resolveNativeLookupDecision_解析籍贯查询决策逻辑
    resolveNativeLookupDecision(proxy, nowIso = new Date().toISOString()) {
        const policy = readNativeLookupConfig(this.config);
        if (!policy.enabled) {
            return { action: 'none', reason: 'native-disabled', policy };
        }
        if (!proxy || !proxy.id) {
            return { action: 'none', reason: 'proxy-missing', policy };
        }

        const branch = String(proxy.service_branch || '').trim();
        const isTargetBranch = policy.targetBranches.includes(branch);
        const status = normalizeNativeLookupStatus(proxy.native_lookup_status);
        if (!isTargetBranch) {
            if (status === 'pending') {
                return { action: 'skip', reason: 'branch-not-target', policy };
            }
            return { action: 'none', reason: 'branch-not-target', policy };
        }

        const nativePlace = String(proxy.native_place || '未知').trim() || '未知';
        if (nativePlace !== '未知') {
            return { action: 'none', reason: 'native-already-known', policy };
        }
        if (!isNativeRetryDue(proxy.native_next_retry_at, nowIso)) {
            return { action: 'none', reason: 'retry-not-due', policy };
        }

        return { action: 'lookup', reason: 'eligible', policy };
    }

    // 0286_markNativeLookupSkipped_标记籍贯跳过逻辑
    markNativeLookupSkipped(proxy, sourceName, nowIso, reason = 'branch-not-target') {
        this.db.updateProxyById(proxy.id, {
            native_lookup_status: 'skipped',
            updated_at: nowIso,
        });
        const updatedProxy = this.db.getProxyById(proxy.id) || proxy;
        this.db.insertProxyEvent({
            timestamp: nowIso,
            proxy_id: proxy.id,
            display_name: updatedProxy.display_name,
            event_type: 'native_lookup_skipped',
            level: EVENT_LEVEL.INFO,
            message: `籍贯解析跳过：${updatedProxy.display_name}`,
            details: {
                ip: updatedProxy.ip,
                service_branch: updatedProxy.service_branch,
                provider: NATIVE_LOOKUP_PROVIDER_CHAIN_LABEL,
                status: 'skipped',
                reason,
            },
        });
        this.logger.write({
            event: '籍贯解析跳过',
            proxyName: updatedProxy.display_name,
            ipSource: sourceName,
            stage: '籍贯',
            result: '跳过',
            reason,
            action: '非目标兵种，不触发查询',
            details: {
                ip: updatedProxy.ip,
                service_branch: updatedProxy.service_branch,
                provider: NATIVE_LOOKUP_PROVIDER_CHAIN_LABEL,
                status: 'skipped',
                reason,
            },
        });
    }

    // 0287_resolveNativePlaceByIpapiCo_通过ipapi.co解析IP籍贯逻辑
    async resolveNativePlaceByIpapiCo(ip, timeoutMs = 3000) {
        const response = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
            signal: createAbortSignal(Math.max(500, Number(timeoutMs) || 3000)),
            headers: {
                'user-agent': 'ProxyHub/1.0',
                accept: 'application/json',
            },
        });
        if (!response.ok) {
            throw new Error(`ipapi.co-http-${response.status}`);
        }

        const rawJson = await response.text();
        let payload;
        try {
            payload = JSON.parse(rawJson);
        } catch {
            throw new Error('ipapi.co-invalid-json');
        }

        if (payload?.error === true) {
            const reason = normalizeNativeReason(payload?.reason || payload?.message);
            throw new Error(`ipapi.co-${reason}`);
        }

        const country = String(payload?.country_name || payload?.country || '').trim() || '未知';
        const city = String(payload?.city || '').trim() || '未知';
        const normalizedRawJson = normalizeNativeRawJson(rawJson, payload);
        return {
            provider: 'ipapi.co',
            country,
            city,
            place: `${country}-${city}`,
            rawJson: normalizedRawJson,
            readableText: buildNativeLookupReadableText(payload),
        };
    }

    // 0288_resolveNativePlaceByFreeipapi_通过freeipapi解析IP籍贯逻辑
    async resolveNativePlaceByFreeipapi(ip, timeoutMs = 3000) {
        const response = await fetch(`https://freeipapi.com/api/json/${encodeURIComponent(ip)}`, {
            signal: createAbortSignal(Math.max(500, Number(timeoutMs) || 3000)),
            headers: {
                'user-agent': 'ProxyHub/1.0',
                accept: 'application/json',
            },
        });
        if (!response.ok) {
            throw new Error(`freeipapi-http-${response.status}`);
        }

        const rawJson = await response.text();
        let payload;
        try {
            payload = JSON.parse(rawJson);
        } catch {
            throw new Error('freeipapi-invalid-json');
        }

        if (payload?.error === true) {
            const reason = normalizeNativeReason(payload?.reason || payload?.message);
            throw new Error(`freeipapi-${reason}`);
        }
        if (typeof payload?.error === 'string' && payload.error.trim().length > 0) {
            throw new Error(`freeipapi-${normalizeNativeReason(payload.error)}`);
        }

        const country = String(payload?.countryName || payload?.country_name || payload?.country || '').trim() || '未知';
        const city = String(payload?.cityName || payload?.city || '').trim() || '未知';
        const normalizedRawJson = normalizeNativeRawJson(rawJson, payload);
        return {
            provider: 'freeipapi',
            country,
            city,
            place: `${country}-${city}`,
            rawJson: normalizedRawJson,
            readableText: buildNativeLookupReadableText(payload),
        };
    }

    // 0289_resolveNativePlaceByIp_按provider链路解析IP籍贯逻辑
    async resolveNativePlaceByIp(ip, timeoutMs = 3000) {
        if (typeof fetch !== 'function') {
            throw new Error('native-fetch-unavailable');
        }

        const safeIp = String(ip || '').trim();
        if (safeIp.length === 0) {
            throw new Error('native-ip-missing');
        }

        const errors = [];
        try {
            return await this.resolveNativePlaceByIpapiCo(safeIp, timeoutMs);
        } catch (error) {
            errors.push(error?.message || 'ipapi.co-request-failed');
        }

        try {
            return await this.resolveNativePlaceByFreeipapi(safeIp, timeoutMs);
        } catch (error) {
            errors.push(error?.message || 'freeipapi-request-failed');
        }

        throw new Error(`native-all-providers-failed:${errors.join('|')}`);
    }

    // 0290_runNativeLookupTask_执行籍贯补全任务逻辑
    async runNativeLookupTask(proxyId, sourceName) {
        const startedAtIso = this.now().toISOString();
        const proxy = this.db.getProxyById(proxyId);
        if (!proxy) {
            return;
        }

        const decision = this.resolveNativeLookupDecision(proxy, startedAtIso);
        if (decision.action === 'skip') {
            this.markNativeLookupSkipped(proxy, sourceName, startedAtIso, decision.reason);
            return;
        }
        if (decision.action !== 'lookup') {
            return;
        }

        try {
            const resolved = await this.resolveNativePlaceByIp(proxy.ip, decision.policy.timeoutMs);
            const nowIso = this.now().toISOString();
            const latestProxy = this.db.getProxyById(proxyId) || proxy;
            const latestDecision = this.resolveNativeLookupDecision(latestProxy, nowIso);
            if (latestDecision.action !== 'lookup') {
                return;
            }
            this.db.updateProxyById(proxyId, {
                native_country: resolved.country,
                native_city: resolved.city,
                native_place: resolved.place,
                native_provider: resolved.provider,
                native_resolved_at: nowIso,
                native_lookup_status: 'resolved',
                native_next_retry_at: null,
                native_lookup_raw_json: resolved.rawJson,
                native_lookup_readable_text: resolved.readableText,
                updated_at: nowIso,
            });
            const updatedProxy = this.db.getProxyById(proxyId) || proxy;
            this.db.insertProxyEvent({
                timestamp: nowIso,
                proxy_id: proxyId,
                display_name: updatedProxy.display_name,
                event_type: 'native_lookup_resolved',
                level: EVENT_LEVEL.INFO,
                message: `籍贯解析成功：${updatedProxy.display_name} -> ${resolved.place}`,
                details: {
                    ip: updatedProxy.ip,
                    service_branch: updatedProxy.service_branch,
                    provider: resolved.provider,
                    status: 'resolved',
                    reason: `${resolved.provider}-success`,
                },
            });
            this.logger.write({
                event: '籍贯解析成功',
                proxyName: updatedProxy.display_name,
                ipSource: sourceName,
                stage: '籍贯',
                result: resolved.place,
                action: '已写入籍贯',
                details: {
                    ip: updatedProxy.ip,
                    service_branch: updatedProxy.service_branch,
                    provider: resolved.provider,
                    status: 'resolved',
                },
            });
        } catch (error) {
            const nowIso = this.now().toISOString();
            const latestProxy = this.db.getProxyById(proxyId) || proxy;
            const latestDecision = this.resolveNativeLookupDecision(latestProxy, nowIso);
            if (latestDecision.action !== 'lookup') {
                return;
            }
            const retryMs = Math.round((decision.policy.retryHours || 1) * 3_600_000);
            const retryAt = new Date(Date.parse(nowIso) + retryMs).toISOString();
            const reason = error?.message || 'native-lookup-failed';
            this.db.updateProxyById(proxyId, {
                native_lookup_status: 'failed',
                native_next_retry_at: retryAt,
                updated_at: nowIso,
            });
            const updatedProxy = this.db.getProxyById(proxyId) || proxy;
            this.db.insertProxyEvent({
                timestamp: nowIso,
                proxy_id: proxyId,
                display_name: updatedProxy.display_name,
                event_type: 'native_lookup_failed',
                level: EVENT_LEVEL.INFO,
                message: `籍贯解析失败：${updatedProxy.display_name}`,
                details: {
                    ip: updatedProxy.ip,
                    service_branch: updatedProxy.service_branch,
                    provider: NATIVE_LOOKUP_PROVIDER_CHAIN_LABEL,
                    status: 'failed',
                    reason,
                    retryAt,
                },
            });
            this.logger.write({
                event: '籍贯解析失败',
                proxyName: updatedProxy.display_name,
                ipSource: sourceName,
                stage: '籍贯',
                result: '失败',
                reason,
                action: `等待重试至 ${retryAt}`,
                details: {
                    ip: updatedProxy.ip,
                    service_branch: updatedProxy.service_branch,
                    provider: NATIVE_LOOKUP_PROVIDER_CHAIN_LABEL,
                    status: 'failed',
                    reason,
                    retryAt,
                },
            });
        }
    }

    // 0289_scheduleNativeLookup_调度籍贯补全逻辑
    scheduleNativeLookup(proxy, sourceName, nowIso) {
        const decision = this.resolveNativeLookupDecision(proxy, nowIso);
        if (decision.action === 'skip') {
            this.markNativeLookupSkipped(proxy, sourceName, nowIso, decision.reason);
            return;
        }
        if (decision.action !== 'lookup') {
            return;
        }
        if (this.nativeLookupInFlight.has(proxy.id)) {
            return;
        }

        this.nativeLookupInFlight.add(proxy.id);
        const task = this.runNativeLookupTask(proxy.id, sourceName)
            .catch((error) => {
                this.logger.write({
                    event: '籍贯解析失败',
                    proxyName: proxy.display_name,
                    ipSource: sourceName,
                    stage: '籍贯',
                    result: '异常',
                    reason: error?.message || 'native-lookup-task-failed',
                    action: '忽略异常，等待下一轮',
                    details: {
                        ip: proxy.ip,
                        service_branch: proxy.service_branch,
                        provider: NATIVE_LOOKUP_PROVIDER_CHAIN_LABEL,
                        status: 'failed',
                    },
                });
            })
            .finally(() => {
                this.nativeLookupInFlight.delete(proxy.id);
            });
        task.catch(() => {});
    }

    // 0028_start_启动逻辑
    async start() {
        if (this.started) {
            return;
        }

        this.started = true;

        await this.runSourceCycle();
        await this.runStateReviewCycle();
        await this.runCandidateSweepCycle();
        if (this.isBattleEnabled()) {
            await this.runBattleL1Cycle();
            await this.runBattleL2Cycle();
            if (this.isBattleL3Enabled()) {
                await this.runBattleL3Cycle();
            }
        }
        this.persistSnapshot();

        this.sourceSyncTimer = setInterval(() => {
            void this.runSourceCycle();
        }, this.config.scheduler.sourceSyncMs);

        this.stateReviewTimer = setInterval(() => {
            void this.runStateReviewCycle();
        }, this.config.scheduler.stateReviewMs);

        const candidateControl = readCandidateControl(this.config);
        this.candidateSweepTimer = setInterval(() => {
            void this.runCandidateSweepCycle();
        }, candidateControl.sweepMs);

        if (this.isBattleEnabled()) {
            this.battleL1Timer = setInterval(() => {
                void this.runBattleL1Cycle();
            }, this.config.battle.l1SyncMs);

            this.battleL2Timer = setInterval(() => {
                void this.runBattleL2Cycle();
            }, this.config.battle.l2SyncMs);
            if (this.isBattleL3Enabled()) {
                this.battleL3Timer = setInterval(() => {
                    void this.runBattleL3Cycle();
                }, this.config.battle.l3.syncMs);
            }
        }

        this.snapshotTimer = setInterval(() => {
            this.persistSnapshot();
        }, this.config.scheduler.snapshotPersistMs);

        this.logger.write({
            event: '等待下一轮',
            stage: '调度',
            result: 'ProxyHub 已启动',
            reason: `抓源间隔 ${Math.round(this.config.scheduler.sourceSyncMs / 1000)} 秒`,
            action: this.isBattleEnabled()
                ? `L1 ${Math.round(this.config.battle.l1SyncMs / 1000)} 秒, L2 ${Math.round(this.config.battle.l2SyncMs / 1000)} 秒${this.isBattleL3Enabled() ? `, L3 ${Math.round(this.config.battle.l3.syncMs / 1000)} 秒` : ''}`
                : '调度循环启动',
        });
    }

    // 0029_stop_停止逻辑
    async stop() {
        this.started = false;
        if (this.sourceSyncTimer) {
            clearInterval(this.sourceSyncTimer);
            this.sourceSyncTimer = null;
        }
        if (this.stateReviewTimer) {
            clearInterval(this.stateReviewTimer);
            this.stateReviewTimer = null;
        }
        if (this.snapshotTimer) {
            clearInterval(this.snapshotTimer);
            this.snapshotTimer = null;
        }
        if (this.battleL1Timer) {
            clearInterval(this.battleL1Timer);
            this.battleL1Timer = null;
        }
        if (this.battleL2Timer) {
            clearInterval(this.battleL2Timer);
            this.battleL2Timer = null;
        }
        if (this.battleL3Timer) {
            clearInterval(this.battleL3Timer);
            this.battleL3Timer = null;
        }
        if (this.candidateSweepTimer) {
            clearInterval(this.candidateSweepTimer);
            this.candidateSweepTimer = null;
        }
        this.candidateRefillWindowOpen = false;
    }

    // 0030_createRecruitName_创建新兵名称逻辑
    createRecruitName() {
        return generateRecruitName((name) => this.db.isDisplayNameAvailable(name));
    }

    // 0031_runSourceCycle_执行来源轮次逻辑
    async runSourceCycle() {
        if (!this.started || this.isSourceCycleRunning) {
            return;
        }

        this.sourceCycleCounter += 1;
        const throttleFactor = Math.max(1, Number(this.sourceCycleThrottleFactor) || 1);
        const shouldSkipByThrottle = throttleFactor > 1
            && ((this.sourceCycleCounter - 1) % throttleFactor !== 0);
        if (shouldSkipByThrottle) {
            this.logger.write({
                event: '等待下一轮',
                stage: '抓源',
                result: '限速跳过抓源轮次',
                reason: `source-throttle-x${throttleFactor}`,
                action: '等待下一个抓源窗口',
            });
            return;
        }

        const sourceFeeds = resolveSourceFeeds(this.config);
        if (sourceFeeds.length === 0) {
            return;
        }

        this.isSourceCycleRunning = true;
        const startedAt = Date.now();
        const summary = {
            feeds: sourceFeeds.length,
            fetched: 0,
            normalized: 0,
            inserted: 0,
            touched: 0,
            skipped: 0,
            failed: 0,
        };

        try {
            for (const sourceConfig of sourceFeeds) {
                const sourceName = sourceConfig.name;
                this.logger.write({
                    event: '开始抓源',
                    stage: '抓源',
                    ipSource: sourceName,
                    result: '开始',
                    action: '拉取代理来源',
                });

                try {
                    const fetchResult = await this.workerPool.runTask('fetch-source', {
                        url: sourceConfig.url,
                        timeoutMs: 20_000,
                        allowedProtocols: this.config.validation.allowedProtocols,
                        defaultProtocol: sourceConfig.defaultProtocol,
                        sourceFormat: sourceConfig.sourceFormat,
                    });

                    const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                    const nowIso = this.now().toISOString();
                    const candidateCount = Number(this.db.getLifecycleCount?.('candidate') || 0);
                    const gateState = buildCandidateGateState(
                        this.config,
                        candidateCount,
                        this.candidateRefillWindowOpen,
                    );
                    this.candidateRefillWindowOpen = gateState.refillWindowOpen;
                    const hasInsertCap = gateState.max > 0 && !gateState.gateOverride;
                    const remainingInsertSlots = hasInsertCap
                        ? (gateState.refillWindowOpen
                            ? Math.max(
                                0,
                                Math.min(
                                    gateState.max - gateState.candidateCount,
                                    gateState.refillStop - gateState.candidateCount,
                                ),
                            )
                            : 0)
                        : Number.POSITIVE_INFINITY;
                    const upsertOptions = {
                        allowInsert: !gateState.gateActive,
                    };
                    if (hasInsertCap) {
                        upsertOptions.maxInsert = remainingInsertSlots;
                    }
                    const upsertStats = this.db.upsertSourceBatch(
                        fetchResult.proxies,
                        () => this.createRecruitName(),
                        sourceName,
                        batchId,
                        nowIso,
                        upsertOptions,
                    );
                    const gateLimitedBySlots = !gateState.gateActive
                        && gateState.refillWindowOpen
                        && hasInsertCap
                        && Number(upsertStats.skipped || 0) > 0;
                    const sourceAction = gateState.gateActive
                        ? (gateState.gatedByThreshold
                            ? 'candidate闸门生效，仅更新存量代理'
                            : `candidate补给窗口关闭，等待降至低水位 ${gateState.low}`)
                        : (gateState.refillWindowOpen
                            ? (gateLimitedBySlots
                                ? `candidate补给窗口开启，本轮最多新增 ${Math.max(0, Math.floor(remainingInsertSlots))}`
                                : 'candidate补给窗口开启，进入校验队列')
                            : '进入校验队列');

                    summary.fetched += Number(fetchResult.fetched || 0);
                    summary.normalized += Number(fetchResult.normalized || 0);
                    summary.inserted += Number(upsertStats.inserted || 0);
                    summary.touched += Number(upsertStats.touched || 0);
                    summary.skipped += Number(upsertStats.skipped || 0);

                    this.logger.write({
                        event: '抓源成功',
                        stage: '抓源',
                        ipSource: sourceName,
                        result: `总 ${fetchResult.normalized}，新增 ${upsertStats.inserted}，更新 ${upsertStats.touched}，跳过 ${upsertStats.skipped || 0}`,
                        durationMs: Date.now() - startedAt,
                        action: sourceAction,
                    });

                    if (
                        gateState.gateActive
                        || (gateState.gatedByThreshold && gateState.gateOverride)
                        || gateLimitedBySlots
                        || gateState.refillWindowStateChanged
                    ) {
                        const gateMessage = gateState.gateActive
                            ? (gateState.gatedByThreshold
                                ? `candidate 闸门生效：当前 ${gateState.candidateCount}，上限 ${gateState.max}`
                                : `candidate 补给窗口关闭：当前 ${gateState.candidateCount}，低水位 ${gateState.low}`)
                            : (gateState.gatedByThreshold && gateState.gateOverride
                                ? `candidate 闸门已手工 override：当前 ${gateState.candidateCount}，上限 ${gateState.max}`
                                : (gateState.refillWindowStateChanged
                                    ? `candidate 补给窗口开启：当前 ${gateState.candidateCount}，补给至 ${gateState.refillStop}`
                                    : `candidate 补给窗口限量生效：当前 ${gateState.candidateCount}，补给目标 ${gateState.refillStop}`));
                        this.db.insertProxyEvent({
                            timestamp: nowIso,
                            proxy_id: null,
                            display_name: null,
                            event_type: 'candidate_gate',
                            level: EVENT_LEVEL.INFO,
                            message: gateMessage,
                            details: {
                                sourceName,
                                candidateCount: gateState.candidateCount,
                                candidateMax: gateState.max,
                                candidateLow: gateState.low,
                                candidateRefillStop: gateState.refillStop,
                                gateActive: gateState.gateActive,
                                gateOverride: gateState.gateOverride,
                                gatedByHysteresis: gateState.gatedByHysteresis,
                                refillWindowOpenBefore: gateState.refillWindowOpenBefore,
                                refillWindowOpen: gateState.refillWindowOpen,
                                refillWindowStateChanged: gateState.refillWindowStateChanged,
                                gateLimitedBySlots,
                                remainingInsertSlots: Number.isFinite(remainingInsertSlots)
                                    ? Math.max(0, Math.floor(remainingInsertSlots))
                                    : null,
                                inserted: upsertStats.inserted,
                                touched: upsertStats.touched,
                                skipped: upsertStats.skipped || 0,
                            },
                        });
                    }
                } catch (error) {
                    summary.failed += 1;
                    this.logger.write({
                        event: '抓源失败',
                        stage: '抓源',
                        ipSource: sourceName,
                        result: '失败',
                        reason: error?.message || 'unknown',
                        durationMs: Date.now() - startedAt,
                        action: '等待自动重试',
                    });
                }
            }

            if (summary.failed >= sourceFeeds.length) {
                return;
            }

            await this.runValidationCycle(this.config.source?.activeProfile || 'source-bundle');
            this.logger.write({
                event: '等待下一轮',
                stage: '抓源',
                ipSource: this.config.source?.activeProfile || 'source-bundle',
                result: `本轮完成：源 ${summary.feeds}，抓取 ${summary.fetched}，标准化 ${summary.normalized}，新增 ${summary.inserted}，更新 ${summary.touched}`,
                action: '等待调度器下次触发',
            });
        } finally {
            this.isSourceCycleRunning = false;
        }
    }

    // 0260_runCandidateSweepCycle_执行新兵清库存轮次逻辑
    async runCandidateSweepCycle() {
        if (!this.started || this.isCandidateSweepRunning) {
            return;
        }
        this.isCandidateSweepRunning = true;

        try {
            const control = readCandidateControl(this.config);
            const nowIso = this.now().toISOString();
            const candidates = this.db.listCandidatesForSweep({
                nowIso,
                staleHours: control.staleHours,
                staleMinSamples: control.staleMinSamples,
                timeoutHours: control.timeoutHours,
                limit: control.maxRetirePerCycle,
            });

            if (candidates.length === 0) {
                return;
            }

            const summary = {
                stale_candidate: 0,
                stale_timeout: 0,
            };

            for (const candidate of candidates) {
                const retiredType = String(candidate.sweep_reason || 'stale_candidate');
                summary[retiredType] = (summary[retiredType] || 0) + 1;

                this.db.updateProxyById(candidate.id, {
                    lifecycle: 'retired',
                    retired_type: retiredType,
                    lifecycle_changed_at: nowIso,
                    updated_at: nowIso,
                });
                this.db.insertRetirement({
                    proxy_id: candidate.id,
                    display_name: candidate.display_name,
                    retired_type: retiredType,
                    reason: `candidate_sweeper:${retiredType}`,
                    retired_at: nowIso,
                });
                this.db.insertProxyEvent({
                    timestamp: nowIso,
                    proxy_id: candidate.id,
                    display_name: candidate.display_name,
                    event_type: 'retirement',
                    level: EVENT_LEVEL.INFO,
                    message: `退伍：${candidate.display_name} (${retiredType})`,
                    details: {
                        trigger: 'candidate_sweeper',
                        reason: retiredType,
                        ageHours: candidate.sweep_age_hours,
                        totalSamples: candidate.total_samples || 0,
                    },
                });
            }

            this.logger.write({
                event: '自动恢复',
                stage: 'candidate-sweeper',
                result: `清库存完成，共退役 ${candidates.length}`,
                action: `stale_candidate=${summary.stale_candidate || 0}, stale_timeout=${summary.stale_timeout || 0}`,
            });
        } catch (error) {
            this.logger.write({
                event: '线程池告警',
                stage: 'candidate-sweeper',
                result: '清库存异常',
                reason: error?.message || 'candidate-sweeper-error',
                action: '等待自动恢复',
            });
        } finally {
            this.isCandidateSweepRunning = false;
        }
    }

    // 0032_runValidationCycle_执行校验轮次逻辑
    async runValidationCycle(sourceName) {
        const candidates = this.db.listProxiesForValidation(this.config.scheduler.maxValidationPerCycle);
        if (candidates.length === 0) {
            return;
        }

        const concurrency = Math.max(2, Math.min(this.config.threadPool.workers * 2, 20));
        await runWithConcurrency(candidates, concurrency, async (proxy) => {
            await this.processProxy(proxy, proxy.source || sourceName);
        });
    }

    // 0211_applyCombatOutcome_应用评分结果逻辑
    async applyCombatOutcome({
        proxyId,
        sourceName,
        outcome,
        latencyMs,
        nowIso,
        stage,
        combatStage = 'l1',
        branchingStage = combatStage,
        extraUpdates = {},
    }) {
        const currentProxy = this.db.getProxyById(proxyId);
        if (!currentProxy) {
            return;
        }

        const combat = evaluateCombat({
            proxy: currentProxy,
            outcome,
            latencyMs,
            nowIso,
            config: this.config,
            stage: combatStage,
        });
        const branchTransition = resolveBranchingTransition({
            proxy: currentProxy,
            stage: branchingStage,
            outcome,
            config: this.config,
        });

        this.db.updateProxyById(proxyId, {
            ...combat.updates,
            ...extraUpdates,
            ...branchTransition.updates,
            updated_at: nowIso,
        });

        let updatedProxy = this.db.getProxyById(proxyId);
        const backoff = resolveFailureBackoff({
            config: this.config,
            proxy: updatedProxy,
            nowIso,
            outcome,
            stage: combatStage,
        });
        if (backoff.shouldBackoff) {
            this.db.updateProxyById(proxyId, {
                backoff_until: backoff.untilIso,
                backoff_reason: `${combatStage}:${outcome}`,
                updated_at: nowIso,
            });
            updatedProxy = this.db.getProxyById(proxyId);
            this.db.insertProxyEvent({
                timestamp: nowIso,
                proxy_id: proxyId,
                display_name: updatedProxy.display_name,
                event_type: 'backoff',
                level: EVENT_LEVEL.INFO,
                message: `失败退避：${updatedProxy.display_name} 暂停至 ${backoff.untilIso}`,
                details: {
                    stage: combatStage,
                    outcome,
                    failStreak: backoff.failStreak,
                    delayMs: backoff.delayMs,
                    until: backoff.untilIso,
                },
            });
        } else if (outcome === 'success' && (updatedProxy.backoff_until || updatedProxy.backoff_reason)) {
            this.db.updateProxyById(proxyId, {
                backoff_until: null,
                backoff_reason: null,
                updated_at: nowIso,
            });
            updatedProxy = this.db.getProxyById(proxyId);
            this.db.insertProxyEvent({
                timestamp: nowIso,
                proxy_id: proxyId,
                display_name: updatedProxy.display_name,
                event_type: 'backoff_clear',
                level: EVENT_LEVEL.INFO,
                message: `退避解除：${updatedProxy.display_name}`,
                details: {
                    stage: combatStage,
                    outcome,
                },
            });
        }

        for (const event of branchTransition.events) {
            this.db.insertProxyEvent({
                timestamp: nowIso,
                proxy_id: proxyId,
                display_name: updatedProxy.display_name,
                event_type: event.event_type,
                level: EVENT_LEVEL.INFO,
                message: event.message,
                details: event.details,
            });

            this.logger.write({
                event: '编制流转',
                proxyName: updatedProxy.display_name,
                ipSource: sourceName,
                stage: '编制',
                result: event.message,
                reason: `${event.details.branchBefore} -> ${event.details.branchAfter}`,
                action: '按规则自动调整',
                details: event.details,
            });
        }

        this.scheduleNativeLookup(updatedProxy, sourceName, nowIso);

        const activeHonors = parseArrayJson(updatedProxy.honor_active_json);

        for (const award of combat.awards) {
            this.db.upsertHonor({
                proxy_id: proxyId,
                display_name: updatedProxy.display_name,
                honor_type: award.type,
                awarded_at: nowIso,
                reason: award.reason,
            });
        }

        this.db.refreshHonorActive(proxyId, activeHonors);

        if (currentProxy.lifecycle !== 'retired' && updatedProxy.lifecycle === 'retired') {
            this.db.insertRetirement({
                proxy_id: proxyId,
                display_name: updatedProxy.display_name,
                retired_type: updatedProxy.retired_type || '未知',
                reason: `系统自动判定：${updatedProxy.retired_type || '未知'}`,
                retired_at: nowIso,
            });
        }

        for (const event of combat.events) {
            this.db.insertProxyEvent({
                timestamp: nowIso,
                proxy_id: proxyId,
                display_name: updatedProxy.display_name,
                event_type: event.event_type,
                level: EVENT_LEVEL.INFO,
                message: event.message,
                details: event.details || {},
            });

            this.logger.write({
                event: mapEventTypeToChinese(event.event_type),
                proxyName: updatedProxy.display_name,
                ipSource: sourceName,
                stage,
                result: event.message,
                action: '状态已更新',
                details: event.details,
            });
        }

        this.logger.write({
            event: '写数据库成功',
            proxyName: updatedProxy.display_name,
            ipSource: sourceName,
            stage,
            result: outcomeLabel(outcome),
            reason: `${updatedProxy.rank}/${updatedProxy.lifecycle}`,
            action: '提交本轮结果',
        });
    }

    // 0033_processProxy_处理代理逻辑
    async processProxy(proxy, sourceName) {
        const cycleStart = Date.now();

        try {
            this.logger.write({
                event: '开始校验',
                proxyName: proxy.display_name,
                ipSource: sourceName,
                stage: '校验',
                result: `${proxy.ip}:${proxy.port}`,
                action: '验证连通性',
            });

            const validation = await this.workerPool.runTask('validate-proxy', {
                ip: proxy.ip,
                port: proxy.port,
                timeoutMs: this.config.validation.maxTimeoutMs,
            });

            const nowIso = this.now().toISOString();
            this.db.updateProxyById(proxy.id, {
                last_validation_at: nowIso,
                last_validation_ok: validation.ok ? 1 : 0,
                last_validation_reason: validation.reason,
                last_validation_latency_ms: validation.latencyMs || 0,
                source: sourceName,
                updated_at: nowIso,
            });

            this.logger.write({
                event: validation.ok ? '校验通过' : '校验淘汰',
                proxyName: proxy.display_name,
                ipSource: sourceName,
                stage: '校验',
                result: validation.ok ? '通过' : '失败',
                durationMs: validation.latencyMs,
                reason: validation.reason,
                action: validation.ok ? '等待战场测试' : '记录失败并评分',
            });

            if (validation.ok) {
                if (!this.isBattleEnabled()) {
                    await this.applyCombatOutcome({
                        proxyId: proxy.id,
                        sourceName,
                        outcome: 'success',
                        latencyMs: validation.latencyMs || 0,
                        nowIso,
                        stage: '评分(L0回退)',
                        combatStage: 'l0',
                    });

                    this.logger.write({
                        event: '写数据库成功',
                        proxyName: proxy.display_name,
                        ipSource: sourceName,
                        stage: '入库',
                        result: outcomeLabel('success'),
                        durationMs: Date.now() - cycleStart,
                        action: 'battle关闭，使用L0成功评分',
                    });
                }
                return;
            }

            const l0Outcome = pickValidationFailureOutcome(validation);
            await this.applyCombatOutcome({
                proxyId: proxy.id,
                sourceName,
                outcome: l0Outcome,
                latencyMs: validation.latencyMs || 0,
                nowIso,
                stage: '评分(L0)',
                combatStage: 'l0',
            });

            this.logger.write({
                event: '写数据库成功',
                proxyName: proxy.display_name,
                ipSource: sourceName,
                stage: '入库',
                result: outcomeLabel(l0Outcome),
                durationMs: Date.now() - cycleStart,
                action: '提交本轮结果',
            });
        } catch (error) {
            const nowIso = this.now().toISOString();
            const reason = error?.message || 'unknown';
            try {
                await this.applyCombatOutcome({
                    proxyId: proxy.id,
                    sourceName,
                    outcome: 'network_error',
                    latencyMs: 0,
                    nowIso,
                    stage: '评分(L0-异常)',
                    combatStage: 'l0',
                });
            } catch {}

            this.logger.write({
                event: '写数据库失败',
                proxyName: proxy.display_name,
                ipSource: sourceName,
                stage: '入库',
                result: '失败',
                durationMs: Date.now() - cycleStart,
                reason,
                action: '已触发失败退避，等待下轮重试',
            });
        }
    }

    // 0212_runBattleL1Cycle_执行战场L1轮次逻辑
    async runBattleL1Cycle() {
        if (!this.started || !this.isBattleEnabled() || this.isBattleL1Running) {
            return;
        }

        this.isBattleL1Running = true;
        const sourceName = 'battle-l1';

        try {
            const candidates = this.db.listProxiesForBattleL1(
                this.config.battle.maxBattleL1PerCycle,
                this.config.battle.l1LifecycleQuota || this.config.battle.candidateQuota,
            );
            if (candidates.length === 0) {
                return;
            }

            const concurrency = Math.max(2, Math.min(this.config.threadPool.workers, 10));
            await runWithConcurrency(candidates, concurrency, async (proxy) => {
                const nowIso = this.now().toISOString();
                try {
                    const result = await this.workerPool.runTask('battle-l1', {
                        proxy: {
                            ip: proxy.ip,
                            port: proxy.port,
                            protocol: proxy.protocol,
                        },
                        targets: this.config.battle.targets.l1,
                        timeoutMs: this.config.battle.timeoutMs.l1,
                        blockedStatusCodes: this.config.battle.blockedStatusCodes,
                        blockSignals: this.config.battle.blockSignals,
                    });

                    for (const run of result.runs || []) {
                        this.db.insertBattleTestRun({
                            timestamp: nowIso,
                            proxy_id: proxy.id,
                            stage: 'l1',
                            target: run.target,
                            outcome: run.outcome,
                            status_code: run.statusCode,
                            latency_ms: run.latencyMs,
                            reason: run.reason,
                            details: run.details,
                        });
                    }

                    const latest = this.db.getProxyById(proxy.id);
                    const battleUpdates = buildBattleCounterUpdates(latest || proxy, nowIso, result.outcome, 'l1');
                    await this.applyCombatOutcome({
                        proxyId: proxy.id,
                        sourceName,
                        outcome: result.outcome,
                        latencyMs: result.latencyMs || 0,
                        nowIso,
                        stage: '评分(L1)',
                        combatStage: 'l1',
                        extraUpdates: battleUpdates,
                    });
                } catch (error) {
                    const latest = this.db.getProxyById(proxy.id) || proxy;
                    const battleUpdates = buildBattleCounterUpdates(latest, nowIso, 'network_error', 'l1');
                    await this.applyCombatOutcome({
                        proxyId: proxy.id,
                        sourceName,
                        outcome: 'network_error',
                        latencyMs: 0,
                        nowIso,
                        stage: '评分(L1-异常)',
                        combatStage: 'l1',
                        extraUpdates: battleUpdates,
                    });

                    this.logger.write({
                        event: '战场测试L1失败',
                        proxyName: proxy.display_name,
                        ipSource: sourceName,
                        stage: '战场测试L1',
                        result: '异常',
                        reason: error?.message || 'battle-l1-task-error',
                        action: '已触发失败退避',
                    });
                }
            });
        } catch (error) {
            this.logger.write({
                event: '线程池告警',
                stage: '战场测试L1',
                result: '异常',
                reason: error?.message || 'battle-l1-error',
                action: '等待自动恢复',
            });
        } finally {
            this.isBattleL1Running = false;
        }
    }

    // 0213_runBattleL2Cycle_执行战场L2轮次逻辑
    async runBattleL2Cycle() {
        if (!this.started || !this.isBattleEnabled() || this.isBattleL2Running) {
            return;
        }

        this.isBattleL2Running = true;
        const sourceName = 'battle-l2';

        try {
            const candidates = this.db.listProxiesForBattleL2(
                this.config.battle.maxBattleL2PerCycle,
                this.config.battle.l2LookbackMinutes,
            );
            if (candidates.length === 0) {
                return;
            }

            const concurrency = Math.max(1, Math.min(this.config.threadPool.workers, 6));
            await runWithConcurrency(candidates, concurrency, async (proxy) => {
                const nowIso = this.now().toISOString();
                try {
                    const result = await this.workerPool.runTask('battle-l2', {
                        proxy: {
                            ip: proxy.ip,
                            port: proxy.port,
                            protocol: proxy.protocol,
                        },
                        primaryTargets: this.config.battle.targets.l2Primary,
                        fallbackTargets: this.config.battle.targets.l2Fallback,
                        timeoutMs: this.config.battle.timeoutMs.l2,
                        blockedStatusCodes: this.config.battle.blockedStatusCodes,
                        blockSignals: this.config.battle.blockSignals,
                    });

                    for (const run of result.runs || []) {
                        this.db.insertBattleTestRun({
                            timestamp: nowIso,
                            proxy_id: proxy.id,
                            stage: 'l2',
                            target: run.target,
                            outcome: run.outcome,
                            status_code: run.statusCode,
                            latency_ms: run.latencyMs,
                            reason: run.reason,
                            details: run.details,
                        });
                    }

                    const latest = this.db.getProxyById(proxy.id);
                    const battleUpdates = buildBattleCounterUpdates(latest || proxy, nowIso, result.outcome, 'l2');
                    await this.applyCombatOutcome({
                        proxyId: proxy.id,
                        sourceName,
                        outcome: result.outcome,
                        latencyMs: result.latencyMs || 0,
                        nowIso,
                        stage: '评分(L2)',
                        combatStage: 'l2',
                        extraUpdates: battleUpdates,
                    });
                } catch (error) {
                    const latest = this.db.getProxyById(proxy.id) || proxy;
                    const battleUpdates = buildBattleCounterUpdates(latest, nowIso, 'network_error', 'l2');
                    await this.applyCombatOutcome({
                        proxyId: proxy.id,
                        sourceName,
                        outcome: 'network_error',
                        latencyMs: 0,
                        nowIso,
                        stage: '评分(L2-异常)',
                        combatStage: 'l2',
                        extraUpdates: battleUpdates,
                    });

                    this.logger.write({
                        event: '战场测试L2失败',
                        proxyName: proxy.display_name,
                        ipSource: sourceName,
                        stage: '战场测试L2',
                        result: '异常',
                        reason: error?.message || 'battle-l2-task-error',
                        action: '已触发失败退避',
                    });
                }
            });
        } catch (error) {
            this.logger.write({
                event: '线程池告警',
                stage: '战场测试L2',
                result: '异常',
                reason: error?.message || 'battle-l2-error',
                action: '等待自动恢复',
            });
        } finally {
            this.isBattleL2Running = false;
        }
    }

    // 0279_runBattleL3Cycle_执行战场L3轮次逻辑
    async runBattleL3Cycle() {
        if (!this.started || !this.isBattleL3Enabled() || this.isBattleL3Running) {
            return;
        }

        this.isBattleL3Running = true;
        const sourceName = 'battle-l3-browser';
        const l3Config = this.config?.battle?.l3 || {};

        try {
            const candidates = this.db.listProxiesForBattleL3(
                l3Config.maxPerCycle,
                l3Config.lookbackMinutes,
                l3Config.allowedProtocols,
            );
            if (candidates.length === 0) {
                return;
            }

            const concurrency = Math.max(1, Math.min(Number(l3Config.concurrency) || 1, 6));
            await runWithConcurrency(candidates, concurrency, async (proxy) => {
                const nowIso = this.now().toISOString();
                try {
                    const result = await this.workerPool.runTask('battle-l3-browser', {
                        proxy: {
                            ip: proxy.ip,
                            port: proxy.port,
                            protocol: proxy.protocol,
                        },
                        targets: l3Config.targets,
                        timeoutMs: l3Config.timeoutMs,
                        blockedStatusCodes: this.config.battle.blockedStatusCodes,
                        blockSignals: this.config.battle.blockSignals,
                        allowedProtocols: l3Config.allowedProtocols,
                    });

                    for (const run of result.runs || []) {
                        this.db.insertBattleTestRun({
                            timestamp: nowIso,
                            proxy_id: proxy.id,
                            stage: 'l3',
                            target: run.target,
                            outcome: run.outcome,
                            status_code: run.statusCode,
                            latency_ms: run.latencyMs,
                            reason: run.reason,
                            details: run.details,
                        });
                    }

                    const latest = this.db.getProxyById(proxy.id);
                    const battleUpdates = buildBattleCounterUpdates(latest || proxy, nowIso, result.outcome, 'l2');
                    await this.applyCombatOutcome({
                        proxyId: proxy.id,
                        sourceName,
                        outcome: result.outcome,
                        latencyMs: result.latencyMs || 0,
                        nowIso,
                        stage: '评分(L3)',
                        combatStage: 'l2',
                        branchingStage: 'l3',
                        extraUpdates: battleUpdates,
                    });
                } catch (error) {
                    const latest = this.db.getProxyById(proxy.id) || proxy;
                    const battleUpdates = buildBattleCounterUpdates(latest, nowIso, 'network_error', 'l2');
                    await this.applyCombatOutcome({
                        proxyId: proxy.id,
                        sourceName,
                        outcome: 'network_error',
                        latencyMs: 0,
                        nowIso,
                        stage: '评分(L3-异常)',
                        combatStage: 'l2',
                        branchingStage: 'l3',
                        extraUpdates: battleUpdates,
                    });

                    this.logger.write({
                        event: '战场测试L3失败',
                        proxyName: proxy.display_name,
                        ipSource: sourceName,
                        stage: '战场测试L3',
                        result: '异常',
                        reason: error?.message || 'battle-l3-task-error',
                        action: '已触发失败退避',
                    });
                }
            });
        } catch (error) {
            this.logger.write({
                event: '线程池告警',
                stage: '战场测试L3',
                result: '异常',
                reason: error?.message || 'battle-l3-error',
                action: '等待自动恢复',
            });
        } finally {
            this.isBattleL3Running = false;
        }
    }

    // 0034_runStateReviewCycle_执行状态巡检轮次逻辑
    async runStateReviewCycle() {
        if (!this.started || this.isStateReviewRunning) {
            return;
        }
        this.isStateReviewRunning = true;

        try {
            const stateReviewLimit = Math.max(30, this.config.threadPool.workers * 20);
            const stateReviewQuota = this.config.scheduler?.stateReviewLifecycleQuota;
            const list = this.db.listProxiesForStateReview(stateReviewLimit, stateReviewQuota);
            const nowIso = this.now().toISOString();

            await runWithConcurrency(list, Math.max(2, this.config.threadPool.workers), async (proxy) => {
                await this.workerPool.runTask('state-transition', { proxyId: proxy.id });
                const result = evaluateStateTransition({
                    proxy,
                    nowIso,
                    config: this.config,
                });

                if (!result.change) {
                    return;
                }

                this.db.updateProxyById(proxy.id, {
                    ...result.updates,
                    updated_at: nowIso,
                });

                const refreshed = this.db.getProxyById(proxy.id);
                const msg = `状态迁移：${refreshed.display_name} -> ${refreshed.lifecycle}`;

                this.db.insertProxyEvent({
                    timestamp: nowIso,
                    proxy_id: proxy.id,
                    display_name: refreshed.display_name,
                    event_type: 'state_transition',
                    level: EVENT_LEVEL.INFO,
                    message: msg,
                    details: {
                        change: result.change,
                        ...(result.eventDetails || {}),
                    },
                });

                this.logger.write({
                    event: '开始评分',
                    proxyName: refreshed.display_name,
                    ipSource: refreshed.source,
                    stage: '状态迁移',
                    result: msg,
                    action: '维护生命周期状态',
                });
            });
        } catch (error) {
            this.logger.write({
                event: '线程池告警',
                stage: '状态迁移',
                result: '异常',
                reason: error?.message || 'state-review-error',
                action: '自动恢复重试',
            });
        } finally {
            this.isStateReviewRunning = false;
        }
    }

    // 0035_persistSnapshot_持久化快照逻辑
    persistSnapshot() {
        if (!this.started) {
            return;
        }

        const poolStatus = this.workerPool.getStatus();
        let sourceDistribution = [];
        let rankDistribution = [];
        let lifecycleDistribution = [];

        try {
            sourceDistribution = this.db.getSourceDistribution();
            rankDistribution = this.db.getRankBoard().map((item) => ({
                rank: item.rank,
                count: item.count,
            }));
            lifecycleDistribution = this.db.getLifecycleDistribution();

            this.db.insertPoolSnapshot({
                timestamp: this.now().toISOString(),
                workers_total: poolStatus.workersTotal,
                workers_busy: poolStatus.workersBusy,
                queue_size: poolStatus.queueSize,
                completed_tasks: poolStatus.completedTasks,
                failed_tasks: poolStatus.failedTasks,
                restarted_workers: poolStatus.restartedWorkers,
                source_distribution: sourceDistribution,
                rank_distribution: rankDistribution,
                lifecycle_distribution: lifecycleDistribution,
            });
        } catch (error) {
            this.logger.write({
                event: '线程池告警',
                stage: '快照',
                result: '持久化失败',
                reason: error?.message || 'snapshot-persist-error',
                action: '等待下一次快照',
            });
            return;
        }

        const highWaterMark = Math.max(20, poolStatus.workersTotal * 8);
        const recoverMark = Math.max(4, poolStatus.workersTotal * 2);

        if (!this.threadPoolAlerting && poolStatus.queueSize >= highWaterMark) {
            this.threadPoolAlerting = true;
            this.logger.write({
                event: '线程池告警',
                stage: '线程池',
                result: `队列积压 ${poolStatus.queueSize}`,
                reason: `忙碌线程 ${poolStatus.workersBusy}/${poolStatus.workersTotal}`,
                action: '系统持续消化队列',
            });
        } else if (this.threadPoolAlerting && poolStatus.queueSize <= recoverMark) {
            this.threadPoolAlerting = false;
            this.logger.write({
                event: '自动恢复',
                stage: '线程池',
                result: `队列回落 ${poolStatus.queueSize}`,
                action: '告警自动解除',
            });
        }

        this.emit('snapshot', {
            poolStatus,
            sourceDistribution,
            rankDistribution,
            lifecycleDistribution,
        });
    }
}

module.exports = {
    parseArrayJson,
    runWithConcurrency,
    outcomeLabel,
    mapEventTypeToChinese,
    pickValidationFailureOutcome,
    buildBattleCounterUpdates,
    readCandidateControl,
    buildCandidateGateState,
    readFailureBackoff,
    resolveFailureBackoff,
    resolveSourceFeeds,
    readBranchingConfig,
    resolveBranchingTransition,
    readNativeLookupConfig,
    isNativeRetryDue,
    normalizeNativeLookupStatus,
    stableSortJsonValue,
    normalizeNativeRawJson,
    buildNativeLookupReadableText,
    ProxyHubEngine,
};


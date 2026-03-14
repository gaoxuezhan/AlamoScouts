const { RANKS, RETIREMENT_TYPES, HONOR_TYPES } = require('./constants');

// 0081_clamp_限制逻辑
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

// 0082_safeParseJson_解析JSON逻辑
function safeParseJson(raw, fallback) {
    try {
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return Array.isArray(fallback) ? (Array.isArray(parsed) ? parsed : fallback) : parsed;
    } catch {
        return fallback;
    }
}

// 0083_rankIndex_军衔逻辑
function rankIndex(rank) {
    const idx = RANKS.indexOf(rank);
    return idx >= 0 ? idx : 0;
}

// 0084_computeRatios_执行computeRatios相关逻辑
function computeRatios(windowRecords, nowMs, regularWindowSize, severeWindowMs) {
    const recent = windowRecords.slice(-regularWindowSize);
    const regularSamples = recent.length;
    const regularBlocked = recent.filter((item) => item.o === 'blocked').length;
    const regularBlockedRatio = regularSamples > 0 ? regularBlocked / regularSamples : 0;

    const severe = windowRecords.filter((item) => nowMs - Date.parse(item.t) <= severeWindowMs);
    const severeSamples = severe.length;
    const severeBlocked = severe.filter((item) => item.o === 'blocked').length;
    const severeBlockedRatio = severeSamples > 0 ? severeBlocked / severeSamples : 0;

    const success = recent.filter((item) => item.o === 'success').length;
    const successRatio = regularSamples > 0 ? success / regularSamples : 0;

    return {
        regularSamples,
        regularBlockedRatio,
        severeSamples,
        severeBlockedRatio,
        successRatio,
    };
}

// 0085_scoreDelta_评分逻辑
function scoreDelta(outcome, latencyMs, scoring) {
    let delta = 0;
    if (outcome === 'success') {
        delta += scoring.success;
        if (latencyMs < 1200) {
            delta += scoring.successFastBonusLt1200;
        } else if (latencyMs < 2500) {
            delta += scoring.successFastBonusLt2500;
        }
    } else if (outcome === 'blocked') {
        delta += scoring.blocked;
    } else if (outcome === 'timeout') {
        delta += scoring.timeout;
    } else if (outcome === 'network_error') {
        delta += scoring.networkError;
    } else {
        delta += scoring.invalidFeedback;
    }
    return delta;
}

// 0086_evaluateCombat_执行evaluateCombat相关逻辑
function evaluateCombat({ proxy, outcome, latencyMs, nowIso, config }) {
    const nowMs = Date.parse(nowIso);
    const policy = config.policy;
    const scoring = policy.scoring;
    const demotion = policy.demotion;
    const retirement = policy.retirement;

    const updates = {};
    const events = [];
    const awards = [];

    const windowRecords = safeParseJson(proxy.recent_window_json, []);
    const honorHistory = safeParseJson(proxy.honor_history_json, []);

    windowRecords.push({ t: nowIso, o: outcome });
    const trimmedWindow = windowRecords.slice(-120);

    const ratios = computeRatios(trimmedWindow, nowMs, demotion.regularWindowSize, demotion.severeWindowMinutes * 60 * 1000);

    const previousCheckedMs = proxy.last_checked_at ? Date.parse(proxy.last_checked_at) : nowMs;
    const deltaHoursRaw = Math.max(0, (nowMs - previousCheckedMs) / 3_600_000);
    const deltaHours = deltaHoursRaw * policy.serviceHourScale;

    const nextServiceHours = (proxy.service_hours || 0) + deltaHours;
    const nextRankServiceHours = (proxy.rank_service_hours || 0) + deltaHours;

    const pointsDelta = scoreDelta(outcome, latencyMs, scoring);
    const nextCombatPoints = (proxy.combat_points || 0) + pointsDelta;

    let nextHealth = proxy.health_score ?? 60;
    let nextDiscipline = proxy.discipline_score ?? 100;

    if (outcome === 'success') {
        nextHealth += 1.2;
    } else if (outcome === 'blocked') {
        nextHealth -= 6;
    } else if (outcome === 'timeout') {
        nextHealth -= 5;
    } else if (outcome === 'network_error') {
        nextHealth -= 4;
    } else {
        nextHealth -= 8;
        nextDiscipline -= 10;
    }

    nextHealth = clamp(nextHealth, 0, 100);
    nextDiscipline = clamp(nextDiscipline, 0, 100);

    let nextSuccess = proxy.success_count || 0;
    let nextBlock = proxy.block_count || 0;
    let nextTimeout = proxy.timeout_count || 0;
    let nextNetworkError = proxy.network_error_count || 0;
    let nextInvalid = proxy.invalid_feedback_count || 0;
    let nextConsecutiveSuccess = proxy.consecutive_success || 0;
    let nextConsecutiveFail = proxy.consecutive_fail || 0;
    let nextRiskySuccess = proxy.risky_success_count || 0;

    if (outcome === 'success') {
        nextSuccess += 1;
        nextConsecutiveSuccess += 1;
        nextConsecutiveFail = 0;
        if (ratios.regularBlockedRatio >= 0.35) {
            nextRiskySuccess += 1;
        }
    } else {
        nextConsecutiveSuccess = 0;
        nextConsecutiveFail += 1;
        if (outcome === 'blocked') {
            nextBlock += 1;
        } else if (outcome === 'timeout') {
            nextTimeout += 1;
        } else if (outcome === 'network_error') {
            nextNetworkError += 1;
        } else {
            nextInvalid += 1;
        }
    }

    const nextTotalSamples = (proxy.total_samples || 0) + 1;

    let nextLifecycle = proxy.lifecycle || 'candidate';
    if (outcome === 'success' && (nextLifecycle === 'candidate' || nextLifecycle === 'reserve')) {
        nextLifecycle = 'active';
    } else if (outcome !== 'success' && nextLifecycle === 'active' && nextHealth < 55) {
        nextLifecycle = 'reserve';
    }

    let nextRank = proxy.rank || '新兵';
    let nextProtectUntil = proxy.promotion_protect_until || null;
    let demoted = false;
    let retiredType = proxy.retired_type || null;

    const currentRankIndex = rankIndex(nextRank);
    if (currentRankIndex < policy.ranks.length - 1) {
        const nextRankPolicy = policy.ranks[currentRankIndex + 1];
        if (
            nextRankServiceHours >= nextRankPolicy.minHours
            && nextCombatPoints >= nextRankPolicy.minPoints
            && nextTotalSamples >= nextRankPolicy.minSamples
            && nextLifecycle !== 'retired'
        ) {
            nextRank = nextRankPolicy.rank;
            nextProtectUntil = new Date(nowMs + policy.promotionProtectHours * 3_600_000).toISOString();
            updates.rank_service_hours = 0;
            events.push({
                event_type: 'promotion',
                message: `晋升：${proxy.display_name} 晋升为 ${nextRank}`,
                details: { from: proxy.rank, to: nextRank },
            });
        }
    }

    const protectedUntilMs = nextProtectUntil ? Date.parse(nextProtectUntil) : 0;
    const inProtectWindow = protectedUntilMs > nowMs;

    const severeDemotion = ratios.severeSamples >= demotion.severeMinSamples
        && ratios.severeBlockedRatio >= demotion.severeBlockedRatio;

    const regularDemotion = ratios.regularSamples >= demotion.regularMinSamples
        && (
            ratios.regularBlockedRatio >= demotion.regularBlockedRatio
            || nextHealth < demotion.healthThreshold
        );

    if (rankIndex(nextRank) > 0) {
        if (severeDemotion || (!inProtectWindow && regularDemotion)) {
            nextRank = policy.ranks[rankIndex(nextRank) - 1].rank;
            demoted = true;
            updates.rank_service_hours = 0;
            events.push({
                event_type: 'demotion',
                message: `降级：${proxy.display_name} 降为 ${nextRank}`,
                details: { severe: severeDemotion },
            });
        }
    }

    if (nextLifecycle !== 'retired') {
        if (nextDiscipline < retirement.disciplineThreshold || nextInvalid >= retirement.disciplineInvalidCount) {
            nextLifecycle = 'retired';
            retiredType = RETIREMENT_TYPES.DISCIPLINE;
        } else if (nextHealth < demotion.lowHealthRetireThreshold && ratios.regularBlockedRatio >= retirement.battleDamageBlockedRatio) {
            nextLifecycle = 'retired';
            retiredType = RETIREMENT_TYPES.BATTLE_DAMAGE;
        } else if (nextTotalSamples >= retirement.technicalMinSamples && ratios.successRatio < retirement.technicalSuccessRatio) {
            nextLifecycle = 'retired';
            retiredType = RETIREMENT_TYPES.TECHNICAL;
        } else if (
            nextServiceHours >= retirement.honorMinServiceHours
            && nextSuccess >= retirement.honorMinSuccess
            && ['尉官', '王牌'].includes(nextRank)
            && nextHealth >= 80
        ) {
            nextLifecycle = 'retired';
            retiredType = RETIREMENT_TYPES.HONOR;
        }
    }

    if (proxy.lifecycle !== 'retired' && nextLifecycle === 'retired') {
        events.push({
            event_type: 'retirement',
            message: `退伍：${proxy.display_name} (${retiredType})`,
            details: { type: retiredType },
        });
    }

    // 0087_hasHonor_荣誉逻辑
    const hasHonor = (name) => honorHistory.includes(name);

    if (nextConsecutiveSuccess >= policy.honors.steelStreak && !hasHonor(HONOR_TYPES.STEEL_STREAK)) {
        honorHistory.push(HONOR_TYPES.STEEL_STREAK);
        awards.push({ type: HONOR_TYPES.STEEL_STREAK, reason: '连续成功达到钢铁连胜标准' });
    }
    if (nextRiskySuccess >= policy.honors.riskyWarrior && !hasHonor(HONOR_TYPES.RISKY_WARRIOR)) {
        honorHistory.push(HONOR_TYPES.RISKY_WARRIOR);
        awards.push({ type: HONOR_TYPES.RISKY_WARRIOR, reason: '高风险环境成功次数达标' });
    }
    if (nextTotalSamples >= policy.honors.thousandService && !hasHonor(HONOR_TYPES.THOUSAND_SERVICE)) {
        honorHistory.push(HONOR_TYPES.THOUSAND_SERVICE);
        awards.push({ type: HONOR_TYPES.THOUSAND_SERVICE, reason: '累计服役实战达到千次' });
    }

    for (const award of awards) {
        events.push({
            event_type: 'honor',
            message: `授予荣誉：${proxy.display_name} 获得 ${award.type}`,
            details: { honorType: award.type, reason: award.reason },
        });
    }

    const activeHonors = [];
    if (honorHistory.includes(HONOR_TYPES.STEEL_STREAK) && nextConsecutiveSuccess >= policy.honors.steelStreak) {
        activeHonors.push(HONOR_TYPES.STEEL_STREAK);
    }
    if (honorHistory.includes(HONOR_TYPES.RISKY_WARRIOR) && nextRiskySuccess >= policy.honors.riskyWarrior) {
        activeHonors.push(HONOR_TYPES.RISKY_WARRIOR);
    }
    if (honorHistory.includes(HONOR_TYPES.THOUSAND_SERVICE)) {
        activeHonors.push(HONOR_TYPES.THOUSAND_SERVICE);
    }

    updates.service_hours = Number(nextServiceHours.toFixed(3));
    updates.rank_service_hours = updates.rank_service_hours ?? Number(nextRankServiceHours.toFixed(3));
    updates.combat_points = nextCombatPoints;
    updates.health_score = Number(nextHealth.toFixed(2));
    updates.discipline_score = Number(nextDiscipline.toFixed(2));
    updates.success_count = nextSuccess;
    updates.block_count = nextBlock;
    updates.timeout_count = nextTimeout;
    updates.network_error_count = nextNetworkError;
    updates.invalid_feedback_count = nextInvalid;
    updates.total_samples = nextTotalSamples;
    updates.consecutive_success = nextConsecutiveSuccess;
    updates.consecutive_fail = nextConsecutiveFail;
    updates.risky_success_count = nextRiskySuccess;
    updates.lifecycle = nextLifecycle;
    updates.rank = nextRank;
    updates.retired_type = retiredType;
    updates.promotion_protect_until = nextProtectUntil;
    updates.last_checked_at = nowIso;
    updates.last_outcome = outcome;
    updates.last_latency_ms = latencyMs;
    updates.recent_window_json = JSON.stringify(trimmedWindow);
    updates.honor_history_json = JSON.stringify(honorHistory);
    updates.honor_active_json = JSON.stringify(activeHonors);
    updates.is_applied = 1;

    return {
        updates,
        events,
        awards,
        demoted,
    };
}

// 0088_evaluateStateTransition_状态迁移逻辑
function evaluateStateTransition({ proxy, nowIso, config }) {
    const nowMs = Date.parse(nowIso);
    const demotion = config.policy.demotion;
    const retirement = config.policy.retirement;
    const windowRecords = safeParseJson(proxy.recent_window_json, []);
    const ratios = computeRatios(windowRecords, nowMs, demotion.regularWindowSize, demotion.severeWindowMinutes * 60 * 1000);

    let lifecycle = proxy.lifecycle;
    let retiredType = proxy.retired_type;
    let change = null;

    if (lifecycle === 'active' && (proxy.health_score < 55 || ratios.regularBlockedRatio >= 0.5)) {
        lifecycle = 'reserve';
        change = 'active_to_reserve';
    } else if (lifecycle === 'reserve' && proxy.health_score >= 65 && ratios.successRatio >= 0.5) {
        lifecycle = 'active';
        change = 'reserve_to_active';
    }

    if (lifecycle !== 'retired') {
        if (proxy.discipline_score < retirement.disciplineThreshold || proxy.invalid_feedback_count >= retirement.disciplineInvalidCount) {
            lifecycle = 'retired';
            retiredType = RETIREMENT_TYPES.DISCIPLINE;
            change = 'retire_discipline';
        }
    }

    return {
        updates: {
            lifecycle,
            retired_type: retiredType,
            updated_at: nowIso,
        },
        change,
    };
}

module.exports = {
    safeParseJson,
    evaluateCombat,
    evaluateStateTransition,
};

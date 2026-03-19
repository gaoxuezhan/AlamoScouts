const { RANKS, RETIREMENT_TYPES, HONOR_TYPES } = require('./constants');
const { computeProxyValue } = require('./value-model');

const EVENT_VERSION = 'v1.1';

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
function rankIndex(rank, rankPolicies = []) {
    if (Array.isArray(rankPolicies) && rankPolicies.length > 0) {
        const idx = rankPolicies.findIndex((item) => item && item.rank === rank);
        if (idx >= 0) return idx;
    }
    return RANKS.indexOf(rank);
}

// 0084_getFeatureFlags_获取开关逻辑
function getFeatureFlags(config = {}) {
    const flags = config.rollout?.features || {};
    return {
        stageWeighting: flags.stageWeighting === true,
        lifecycleHysteresis: flags.lifecycleHysteresis === true,
        honorPromotionTuning: flags.honorPromotionTuning === true,
    };
}

// 0085_selectThresholds_阈值选择逻辑
function selectThresholds(policy, features) {
    const selectedRanks = features.honorPromotionTuning
        ? (policy.ranks || policy.legacy?.ranks || [])
        : (policy.legacy?.ranks || policy.ranks || []);
    const selectedHonors = features.honorPromotionTuning
        ? (policy.honors || policy.legacy?.honors || {})
        : (policy.legacy?.honors || policy.honors || {});

    return {
        ranks: selectedRanks,
        honors: selectedHonors,
    };
}

// 0086_computeWindowStats_计算窗口指标逻辑
function computeWindowStats(windowRecords, nowMs, options) {
    const regularWindowSize = Math.max(1, Number(options.regularWindowSize || 50));
    const severeWindowMs = Math.max(1, Number(options.severeWindowMs || 60 * 60 * 1000));
    const transitionWindowSize = Math.max(1, Number(options.transitionWindowSize || 20));

    const regular = windowRecords.slice(-regularWindowSize);
    const severe = windowRecords.filter((item) => {
        const at = Date.parse(item.t);
        return Number.isFinite(at) && nowMs - at <= severeWindowMs;
    });
    const transition = windowRecords.slice(-transitionWindowSize);

    const build = (records) => {
        const samples = records.length;
        const successCount = records.filter((item) => item.o === 'success').length;
        const blockedCount = records.filter((item) => item.o === 'blocked').length;
        const failCount = samples - successCount;
        return {
            samples,
            successCount,
            blockedCount,
            failCount,
            successRatio: samples > 0 ? successCount / samples : 0,
            failRatio: samples > 0 ? failCount / samples : 0,
            blockedRatio: samples > 0 ? blockedCount / samples : 0,
        };
    };

    return {
        regular: build(regular),
        severe: build(severe),
        transition: build(transition),
    };
}

// 0087_scoreDelta_评分逻辑
function scoreDelta(outcome, latencyMs, scoring) {
    let delta = 0;
    if (outcome === 'success') {
        delta += scoring.success;
        if (Number.isFinite(latencyMs) && latencyMs > 0) {
            if (latencyMs < 1200) {
                delta += scoring.successFastBonusLt1200 || 0;
            } else if (latencyMs < 2500) {
                delta += scoring.successFastBonusLt2500 || 0;
            }
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

// 0088_healthDisciplineDelta_健康纪律变化逻辑
function healthDisciplineDelta(outcome) {
    if (outcome === 'success') return { health: 1.2, discipline: 0 };
    if (outcome === 'blocked') return { health: -6, discipline: 0 };
    if (outcome === 'timeout') return { health: -5, discipline: 0 };
    if (outcome === 'network_error') return { health: -4, discipline: 0 };
    return { health: -8, discipline: -10 };
}

// 0089_stageMultiplier_阶段系数逻辑
function stageMultiplier(scoring, stage, enabled, type) {
    if (!enabled) return 1;
    const map = scoring?.stageMultipliers?.[type] || {};
    const value = Number(map[stage]);
    return Number.isFinite(value) && value > 0 ? value : 1;
}

// 0090_minutesSince_距今分钟逻辑
function minutesSince(iso, nowMs) {
    if (!iso) return Number.POSITIVE_INFINITY;
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
    return Math.max(0, (nowMs - at) / 60_000);
}

// 0091_isStateStaySatisfied_状态停留满足逻辑
function isStateStaySatisfied(proxy, nowMs, minStateStayMinutes) {
    const minMinutes = Math.max(0, Number(minStateStayMinutes ?? 30));
    if (minMinutes <= 0) return true;
    const changedAt = proxy.lifecycle_changed_at || proxy.updated_at || proxy.last_checked_at;
    const stayedMinutes = minutesSince(changedAt, nowMs);
    return stayedMinutes >= minMinutes;
}

// 0092_buildEventDetails_构建事件详情逻辑
function buildEventDetails(trigger, metrics, extra = {}) {
    return {
        version: EVENT_VERSION,
        trigger,
        metrics,
        ...extra,
    };
}

// 0093_evaluateCombat_执行evaluateCombat相关逻辑
function evaluateCombat({ proxy, outcome, latencyMs, nowIso, config, stage = 'l1' }) {
    const nowMs = Date.parse(nowIso);
    const policy = config.policy;
    const scoring = policy.scoring || {};
    const demotion = policy.demotion || {};
    const retirement = policy.retirement || {};
    const lifecyclePolicy = policy.lifecycle || {};
    const features = getFeatureFlags(config);
    const preferReserveBeforeRetire = config?.rollout?.runtime?.preferReserveBeforeRetire === true;
    const selected = selectThresholds(policy, features);

    const updates = {};
    const events = [];
    const awards = [];

    const windowRecords = safeParseJson(proxy.recent_window_json, []);
    const honorHistory = safeParseJson(proxy.honor_history_json, []);

    windowRecords.push({ t: nowIso, o: outcome });
    const trimmedWindow = windowRecords.slice(-120);

    const ratios = computeWindowStats(trimmedWindow, nowMs, {
        regularWindowSize: demotion.regularWindowSize,
        severeWindowMs: Number(demotion.severeWindowMinutes || 60) * 60 * 1000,
        transitionWindowSize: lifecyclePolicy.transitionWindowSize,
    });

    const previousCheckedMs = proxy.last_checked_at ? Date.parse(proxy.last_checked_at) : nowMs;
    const deltaHoursRaw = Math.max(0, (nowMs - previousCheckedMs) / 3_600_000);
    const deltaHours = deltaHoursRaw * Number(policy.serviceHourScale || 1);

    const nextServiceHours = (proxy.service_hours || 0) + deltaHours;
    const nextRankServiceHours = (proxy.rank_service_hours || 0) + deltaHours;

    const rawPointsDelta = scoreDelta(outcome, latencyMs, scoring);
    const scoreMul = stageMultiplier(scoring, stage, features.stageWeighting, 'score');
    const pointsDelta = Math.round(rawPointsDelta * scoreMul);
    const nextCombatPoints = (proxy.combat_points || 0) + pointsDelta;

    let nextHealth = proxy.health_score ?? 60;
    let nextDiscipline = proxy.discipline_score ?? 100;
    const hdDelta = healthDisciplineDelta(outcome);
    const healthMul = stageMultiplier(scoring, stage, features.stageWeighting, 'health');
    nextHealth += hdDelta.health * healthMul;
    nextDiscipline += hdDelta.discipline;

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
    let nextBattleSuccess = proxy.battle_success_count || 0;
    let nextBattleFail = proxy.battle_fail_count || 0;
    const isBattleStage = stage === 'l1' || stage === 'l2';

    if (outcome === 'success') {
        nextSuccess += 1;
        nextConsecutiveSuccess += 1;
        nextConsecutiveFail = 0;
        if (isBattleStage) {
            nextBattleSuccess += 1;
        }
        const riskyFailRatioThreshold = Number(selected.honors?.riskyFailRatioThreshold ?? 0.65);
        if (ratios.regular.failRatio >= riskyFailRatioThreshold) {
            nextRiskySuccess += 1;
        }
    } else {
        nextConsecutiveSuccess = 0;
        nextConsecutiveFail += 1;
        if (isBattleStage) {
            nextBattleFail += 1;
        }
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
    let lifecycleChanged = false;

    if (features.lifecycleHysteresis) {
        if (outcome === 'success' && nextLifecycle === 'candidate') {
            nextLifecycle = 'active';
            lifecycleChanged = true;
        } else if (
            outcome !== 'success'
            && nextLifecycle === 'active'
            && (
                nextHealth < Number(lifecyclePolicy.activeToReserveHealthThreshold ?? 50)
                || (
                    ratios.transition.samples >= Number(lifecyclePolicy.minSamplesForTransition ?? 20)
                    && ratios.transition.failRatio >= Number(lifecyclePolicy.activeToReserveFailRatio ?? 0.8)
                    && nextConsecutiveFail >= Number(lifecyclePolicy.activeToReserveConsecutiveFail ?? 6)
                )
            )
        ) {
            nextLifecycle = 'reserve';
            lifecycleChanged = true;
        }
    } else if (outcome === 'success' && (nextLifecycle === 'candidate' || nextLifecycle === 'reserve')) {
        nextLifecycle = 'active';
        lifecycleChanged = true;
    } else if (outcome !== 'success' && nextLifecycle === 'active' && nextHealth < 55) {
        nextLifecycle = 'reserve';
        lifecycleChanged = true;
    }

    let nextRank = proxy.rank || '新兵';
    let nextProtectUntil = proxy.promotion_protect_until || null;
    let demoted = false;
    let retiredType = proxy.retired_type || null;

    const currentRankIdx = rankIndex(nextRank, selected.ranks);
    if (currentRankIdx >= 0 && currentRankIdx < selected.ranks.length - 1) {
        const nextRankPolicy = selected.ranks[currentRankIdx + 1];
        if (
            nextRankServiceHours >= nextRankPolicy.minHours
            && nextCombatPoints >= nextRankPolicy.minPoints
            && nextTotalSamples >= nextRankPolicy.minSamples
            && nextLifecycle !== 'retired'
        ) {
            nextRank = nextRankPolicy.rank;
            nextProtectUntil = new Date(nowMs + Number(policy.promotionProtectHours || 6) * 3_600_000).toISOString();
            updates.rank_service_hours = 0;
            events.push({
                event_type: 'promotion',
                message: `晋升：${proxy.display_name} 晋升为 ${nextRank}`,
                details: buildEventDetails('promotion_threshold_met', {
                    minHours: nextRankPolicy.minHours,
                    minPoints: nextRankPolicy.minPoints,
                    minSamples: nextRankPolicy.minSamples,
                    rankServiceHours: Number(nextRankServiceHours.toFixed(3)),
                    combatPoints: nextCombatPoints,
                    totalSamples: nextTotalSamples,
                }, {
                    from: proxy.rank,
                    to: nextRank,
                }),
            });
        }
    }

    const protectedUntilMs = nextProtectUntil ? Date.parse(nextProtectUntil) : 0;
    const inProtectWindow = protectedUntilMs > nowMs;

    const severeFailThreshold = Number(demotion.severeFailRatio ?? demotion.severeBlockedRatio ?? 0.9);
    const regularFailThreshold = Number(demotion.regularFailRatio ?? demotion.regularBlockedRatio ?? 0.72);
    const severeDemotion = ratios.severe.samples >= Number(demotion.severeMinSamples || 12)
        && ratios.severe.failRatio >= severeFailThreshold;

    const regularDemotion = ratios.regular.samples >= Number(demotion.regularMinSamples || 20)
        && (
            ratios.regular.failRatio >= regularFailThreshold
            || nextHealth < Number(demotion.healthThreshold ?? 40)
        );

    const currentRankForDemotion = rankIndex(nextRank, selected.ranks);
    if (currentRankForDemotion > 0 && currentRankForDemotion < selected.ranks.length) {
        if (severeDemotion || (!inProtectWindow && regularDemotion)) {
            nextRank = selected.ranks[currentRankForDemotion - 1].rank;
            demoted = true;
            updates.rank_service_hours = 0;
            events.push({
                event_type: 'demotion',
                message: `降级：${proxy.display_name} 降为 ${nextRank}`,
                details: buildEventDetails(
                    severeDemotion ? 'severe_fail_ratio' : 'regular_fail_ratio_or_low_health',
                    {
                        severeSamples: ratios.severe.samples,
                        severeFailRatio: Number(ratios.severe.failRatio.toFixed(4)),
                        regularSamples: ratios.regular.samples,
                        regularFailRatio: Number(ratios.regular.failRatio.toFixed(4)),
                        healthScore: Number(nextHealth.toFixed(2)),
                        inProtectWindow,
                    },
                    { severe: severeDemotion },
                ),
            });
        }
    }

    const technicalEligible = Array.isArray(retirement.technicalEligibleLifecycles)
        ? retirement.technicalEligibleLifecycles
        : ['active', 'reserve'];
    const overallSuccessRatio = nextTotalSamples > 0 ? nextSuccess / nextTotalSamples : 0;
    const applyReserveGuard = (retireType) => {
        if (preferReserveBeforeRetire && nextLifecycle === 'active') {
            nextLifecycle = 'reserve';
            retiredType = null;
            lifecycleChanged = true;
            events.push({
                event_type: 'state_transition',
                message: `状态迁移：${proxy.display_name} active -> reserve（retired_spike_guard）`,
                details: buildEventDetails('retired_spike_guard', {
                    from: 'active',
                    to: 'reserve',
                    intendedRetireType: retireType,
                }, {
                    guard: 'prefer_reserve_before_retire',
                }),
            });
            return false;
        }
        nextLifecycle = 'retired';
        retiredType = retireType;
        lifecycleChanged = true;
        return true;
    };

    if (nextLifecycle !== 'retired') {
        if (nextDiscipline < Number(retirement.disciplineThreshold || 40) || nextInvalid >= Number(retirement.disciplineInvalidCount || 5)) {
            applyReserveGuard(RETIREMENT_TYPES.DISCIPLINE);
        } else if (
            ratios.regular.samples >= Number(retirement.battleDamageMinSamples || 20)
            && nextHealth < Number(demotion.lowHealthRetireThreshold ?? 20)
            && ratios.regular.failRatio >= Number(retirement.battleDamageFailRatio ?? retirement.battleDamageBlockedRatio ?? 0.85)
        ) {
            applyReserveGuard(RETIREMENT_TYPES.BATTLE_DAMAGE);
        } else if (
            technicalEligible.includes(proxy.lifecycle || 'candidate')
            && nextTotalSamples >= Number(retirement.technicalMinSamples || 80)
            && overallSuccessRatio < Number(retirement.technicalSuccessRatio || 0.08)
        ) {
            applyReserveGuard(RETIREMENT_TYPES.TECHNICAL);
        } else if (
            nextServiceHours >= Number(retirement.honorMinServiceHours || 720)
            && nextSuccess >= Number(retirement.honorMinSuccess || 800)
            && ['尉官', '校官', '将官', '王牌'].includes(nextRank)
            && nextHealth >= 80
        ) {
            applyReserveGuard(RETIREMENT_TYPES.HONOR);
        }
    }

    if (proxy.lifecycle !== 'retired' && nextLifecycle === 'retired') {
        const trigger = retiredType === RETIREMENT_TYPES.DISCIPLINE
            ? 'retire_discipline'
            : retiredType === RETIREMENT_TYPES.BATTLE_DAMAGE
                ? 'retire_battle_damage'
                : retiredType === RETIREMENT_TYPES.TECHNICAL
                    ? 'retire_technical'
                    : 'retire_honor';
        events.push({
            event_type: 'retirement',
            message: `退伍：${proxy.display_name} (${retiredType})`,
            details: buildEventDetails(trigger, {
                disciplineScore: Number(nextDiscipline.toFixed(2)),
                invalidFeedbackCount: nextInvalid,
                regularSamples: ratios.regular.samples,
                regularFailRatio: Number(ratios.regular.failRatio.toFixed(4)),
                totalSamples: nextTotalSamples,
                overallSuccessRatio: Number(overallSuccessRatio.toFixed(4)),
                healthScore: Number(nextHealth.toFixed(2)),
            }, {
                type: retiredType,
            }),
        });
    }

    // 0094_hasHonor_荣誉逻辑
    const hasHonor = (name) => honorHistory.includes(name);

    if (nextConsecutiveSuccess >= Number(selected.honors.steelStreak || 999999) && !hasHonor(HONOR_TYPES.STEEL_STREAK)) {
        honorHistory.push(HONOR_TYPES.STEEL_STREAK);
        awards.push({ type: HONOR_TYPES.STEEL_STREAK, reason: '连续成功达到钢铁连胜标准' });
    }
    if (nextRiskySuccess >= Number(selected.honors.riskyWarrior || 999999) && !hasHonor(HONOR_TYPES.RISKY_WARRIOR)) {
        honorHistory.push(HONOR_TYPES.RISKY_WARRIOR);
        awards.push({ type: HONOR_TYPES.RISKY_WARRIOR, reason: '高风险环境成功次数达标' });
    }
    if (nextTotalSamples >= Number(selected.honors.thousandService || 999999) && !hasHonor(HONOR_TYPES.THOUSAND_SERVICE)) {
        honorHistory.push(HONOR_TYPES.THOUSAND_SERVICE);
        awards.push({ type: HONOR_TYPES.THOUSAND_SERVICE, reason: '累计服役实战达到千次' });
    }
    if (nextBattleSuccess >= Number(selected.honors.l2Mastery || 999999) && !hasHonor(HONOR_TYPES.L2_MASTERY)) {
        honorHistory.push(HONOR_TYPES.L2_MASTERY);
        awards.push({ type: HONOR_TYPES.L2_MASTERY, reason: 'L2 攻坚成功次数达标' });
    }
    if (
        nextDiscipline >= Number(selected.honors.disciplineGuardMinScore || 999999)
        && nextInvalid <= Number(selected.honors.disciplineGuardMaxInvalid ?? -1)
        && nextTotalSamples >= Number(selected.honors.disciplineGuardMinSamples || 999999)
        && !hasHonor(HONOR_TYPES.DISCIPLINE_GUARD)
    ) {
        honorHistory.push(HONOR_TYPES.DISCIPLINE_GUARD);
        awards.push({ type: HONOR_TYPES.DISCIPLINE_GUARD, reason: '纪律稳定且低误报，达到铁纪标兵标准' });
    }

    for (const award of awards) {
        events.push({
            event_type: 'honor',
            message: `授予荣誉：${proxy.display_name} 获得 ${award.type}`,
            details: buildEventDetails('honor_awarded', {
                honorType: award.type,
                consecutiveSuccess: nextConsecutiveSuccess,
                riskySuccessCount: nextRiskySuccess,
                totalSamples: nextTotalSamples,
                regularFailRatio: Number(ratios.regular.failRatio.toFixed(4)),
            }, {
                honorType: award.type,
                reason: award.reason,
            }),
        });
    }

    const activeHonors = [];
    if (honorHistory.includes(HONOR_TYPES.STEEL_STREAK) && nextConsecutiveSuccess >= Number(selected.honors.steelStreak || 999999)) {
        activeHonors.push(HONOR_TYPES.STEEL_STREAK);
    }
    if (honorHistory.includes(HONOR_TYPES.RISKY_WARRIOR) && nextRiskySuccess >= Number(selected.honors.riskyWarrior || 999999)) {
        activeHonors.push(HONOR_TYPES.RISKY_WARRIOR);
    }
    if (honorHistory.includes(HONOR_TYPES.THOUSAND_SERVICE)) {
        activeHonors.push(HONOR_TYPES.THOUSAND_SERVICE);
    }
    if (honorHistory.includes(HONOR_TYPES.L2_MASTERY) && nextBattleSuccess >= Number(selected.honors.l2Mastery || 999999)) {
        activeHonors.push(HONOR_TYPES.L2_MASTERY);
    }
    if (
        honorHistory.includes(HONOR_TYPES.DISCIPLINE_GUARD)
        && nextDiscipline >= Number(selected.honors.disciplineGuardMinScore || 999999)
        && nextInvalid <= Number(selected.honors.disciplineGuardMaxInvalid ?? -1)
        && nextTotalSamples >= Number(selected.honors.disciplineGuardMinSamples || 999999)
    ) {
        activeHonors.push(HONOR_TYPES.DISCIPLINE_GUARD);
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
    updates.battle_success_count = nextBattleSuccess;
    updates.battle_fail_count = nextBattleFail;
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
    if (lifecycleChanged) {
        updates.lifecycle_changed_at = nowIso;
    }
    const valuation = computeProxyValue({ ...proxy, ...updates }, policy);
    updates.ip_value_score = valuation.score;
    updates.ip_value_breakdown_json = JSON.stringify(valuation.breakdown);
    updates.is_applied = 1;

    return {
        updates,
        events,
        awards,
        demoted,
    };
}

// 0095_evaluateStateTransition_状态迁移逻辑
function evaluateStateTransition({ proxy, nowIso, config }) {
    const nowMs = Date.parse(nowIso);
    const policy = config.policy || {};
    const demotion = policy.demotion || {};
    const retirement = policy.retirement || {};
    const lifecyclePolicy = policy.lifecycle || {};
    const features = getFeatureFlags(config);
    const preferReserveBeforeRetire = config?.rollout?.runtime?.preferReserveBeforeRetire === true;

    const windowRecords = safeParseJson(proxy.recent_window_json, []);
    const ratios = computeWindowStats(windowRecords, nowMs, {
        regularWindowSize: demotion.regularWindowSize,
        severeWindowMs: Number(demotion.severeWindowMinutes || 60) * 60 * 1000,
        transitionWindowSize: lifecyclePolicy.transitionWindowSize,
    });

    let lifecycle = proxy.lifecycle;
    let retiredType = proxy.retired_type;
    let change = null;
    let trigger = null;

    if (features.lifecycleHysteresis) {
        const staySatisfied = isStateStaySatisfied(proxy, nowMs, lifecyclePolicy.minStateStayMinutes);
        const transitionSampleMin = Number(lifecyclePolicy.minSamplesForTransition || 20);
        if (
            lifecycle === 'active'
            && staySatisfied
            && (
                (proxy.health_score || 0) < Number(lifecyclePolicy.activeToReserveHealthThreshold ?? 50)
                || (
                    ratios.transition.samples >= transitionSampleMin
                    && ratios.transition.failRatio >= Number(lifecyclePolicy.activeToReserveFailRatio ?? 0.8)
                    && (proxy.consecutive_fail || 0) >= Number(lifecyclePolicy.activeToReserveConsecutiveFail ?? 6)
                )
            )
        ) {
            lifecycle = 'reserve';
            change = 'active_to_reserve';
            trigger = 'hysteresis_active_to_reserve';
        } else if (
            lifecycle === 'reserve'
            && staySatisfied
            && ratios.transition.samples >= transitionSampleMin
            && (proxy.health_score || 0) >= Number(lifecyclePolicy.reserveToActiveHealthThreshold ?? 60)
            && (
                ratios.transition.successRatio >= Number(lifecyclePolicy.reserveToActiveSuccessRatio ?? 0.35)
                || ratios.transition.successCount >= Number(lifecyclePolicy.reserveToActiveSuccessCount ?? 4)
            )
        ) {
            const recentL1Minutes = minutesSince(proxy.last_l1_success_at, nowMs);
            const l1Window = Number(lifecyclePolicy.reserveToActiveRecentL1SuccessWindowMin ?? 60);
            const bypassSuccessCount = Number(lifecyclePolicy.reserveToActiveRecentL1BypassSuccessCount ?? 6);
            if (recentL1Minutes <= l1Window || ratios.transition.successCount >= bypassSuccessCount) {
                lifecycle = 'active';
                change = 'reserve_to_active';
                trigger = 'hysteresis_reserve_to_active';
            }
        }
    } else if (lifecycle === 'active' && ((proxy.health_score || 0) < 55 || ratios.regular.blockedRatio >= 0.5)) {
        lifecycle = 'reserve';
        change = 'active_to_reserve';
        trigger = 'legacy_active_to_reserve';
    } else if (lifecycle === 'reserve' && (proxy.health_score || 0) >= 65 && ratios.regular.successRatio >= 0.5) {
        lifecycle = 'active';
        change = 'reserve_to_active';
        trigger = 'legacy_reserve_to_active';
    }

    if (lifecycle !== 'retired') {
        if ((proxy.discipline_score || 0) < Number(retirement.disciplineThreshold || 40)
            || (proxy.invalid_feedback_count || 0) >= Number(retirement.disciplineInvalidCount || 5)) {
            if (preferReserveBeforeRetire && lifecycle === 'active') {
                lifecycle = 'reserve';
                retiredType = null;
                change = 'active_to_reserve_guard';
                trigger = 'retired_spike_guard';
            } else {
                lifecycle = 'retired';
                retiredType = RETIREMENT_TYPES.DISCIPLINE;
                change = 'retire_discipline';
                trigger = 'discipline_threshold';
            }
        }
    }

    const valuation = computeProxyValue(
        {
            ...proxy,
            lifecycle,
            retired_type: retiredType,
        },
        policy,
    );

    const updates = {
        lifecycle,
        retired_type: retiredType,
        ip_value_score: valuation.score,
        ip_value_breakdown_json: JSON.stringify(valuation.breakdown),
        updated_at: nowIso,
    };
    if (change) {
        updates.lifecycle_changed_at = nowIso;
    }

    return {
        updates,
        change,
        eventDetails: change
            ? buildEventDetails(trigger, {
                regularSamples: ratios.regular.samples,
                regularFailRatio: Number(ratios.regular.failRatio.toFixed(4)),
                regularSuccessRatio: Number(ratios.regular.successRatio.toFixed(4)),
                transitionSamples: ratios.transition.samples,
                transitionFailRatio: Number(ratios.transition.failRatio.toFixed(4)),
                transitionSuccessRatio: Number(ratios.transition.successRatio.toFixed(4)),
                transitionSuccessCount: ratios.transition.successCount,
                healthScore: Number((proxy.health_score || 0).toFixed(2)),
                disciplineScore: Number((proxy.discipline_score || 0).toFixed(2)),
                consecutiveFail: proxy.consecutive_fail || 0,
                lastL1SuccessMinutes: Number(minutesSince(proxy.last_l1_success_at, nowMs).toFixed(2)),
            }, {
                from: proxy.lifecycle,
                to: lifecycle,
            })
            : null,
    };
}

module.exports = {
    safeParseJson,
    evaluateCombat,
    evaluateStateTransition,
};

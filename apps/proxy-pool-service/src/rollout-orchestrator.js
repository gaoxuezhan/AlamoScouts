const {
    ensureRolloutConfig,
    applyFeaturePatch,
    evaluateRolloutGuardrails,
} = require('./rollout-guardrails');

const SAFE_FEATURES = {
    stageWeighting: true,
    lifecycleHysteresis: true,
    honorPromotionTuning: false,
};

const FULL_FEATURES = {
    stageWeighting: true,
    lifecycleHysteresis: true,
    honorPromotionTuning: true,
};

// 0240_resolveFeaturePatch_计算开关补丁逻辑
function resolveFeaturePatch(current, target) {
    const patch = {};
    for (const key of Object.keys(target)) {
        if (Boolean(current?.[key]) !== Boolean(target[key])) {
            patch[key] = Boolean(target[key]);
        }
    }
    return patch;
}

// 0241_hoursBetween_计算小时差逻辑
function hoursBetween(fromIso, toIso) {
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
    return (to - from) / 3_600_000;
}

// 0242_pickCurrentMode_推断当前模式逻辑
function pickCurrentMode(state, features, nowIso) {
    const cooldownUntil = String(state?.cooldown_until || '');
    if (String(state?.mode || '') === 'COOLDOWN') {
        return 'COOLDOWN';
    }
    return features?.honorPromotionTuning ? 'FULL' : 'SAFE';
}

class RolloutOrchestrator {
    // 0243_constructor_初始化编排器逻辑
    constructor({ config, db, logger, now, instanceId }) {
        this.config = config;
        this.db = db;
        this.logger = logger;
        this.now = now || (() => new Date());
        this.instanceId = instanceId || `pid-${process.pid}`;

        this.started = false;
        this.timer = null;
        this.tickRunning = false;
    }

    // 0244_getConfig_读取编排配置逻辑
    getConfig() {
        const rollout = ensureRolloutConfig(this.config);
        return rollout.orchestrator;
    }

    // 0245_start_启动编排逻辑
    async start() {
        if (this.started) return;
        const orchestrator = this.getConfig();
        if (orchestrator.enabled !== true) {
            this.logger?.write?.({
                event: '策略调整',
                stage: 'rollout',
                result: '自动编排已关闭',
                action: '仅保留手动触发',
            });
            return;
        }

        this.started = true;
        await this.tick({ trigger: 'startup' });

        this.timer = setInterval(() => {
            void this.tick({ trigger: 'schedule' });
        }, orchestrator.intervalMs);
    }

    // 0246_stop_停止编排逻辑
    async stop() {
        this.started = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    // 0247_tick_执行单次编排逻辑
    async tick({ trigger = 'manual' } = {}) {
        const orchestrator = this.getConfig();
        const nowIso = this.now().toISOString();

        if (this.tickRunning) {
            return {
                ok: true,
                applied: false,
                skipped: 'inflight',
                at: nowIso,
            };
        }

        this.tickRunning = true;
        try {
            const leaseOk = this.db.acquireRolloutSwitchLease?.({
                owner: this.instanceId,
                nowIso,
                ttlMs: orchestrator.leaseTtlMs,
            }) ?? true;

            if (!leaseOk) {
                this.db.insertRolloutSwitchEvent?.({
                    timestamp: nowIso,
                    trigger,
                    action: 'skip_lease',
                    mode_before: null,
                    mode_after: null,
                    patch: {},
                    details: { owner: this.instanceId },
                });
                return {
                    ok: true,
                    applied: false,
                    skipped: 'lease',
                    at: nowIso,
                };
            }

            const rollout = ensureRolloutConfig(this.config);
            const state = this.db.getRolloutSwitchState?.(nowIso) || {
                mode: 'SAFE',
                stable_since: nowIso,
                cooldown_until: null,
                last_tick_at: null,
                last_error: null,
            };
            const currentFeatures = { ...rollout.features };
            const modeBefore = pickCurrentMode(state, currentFeatures, nowIso);
            const guardrails = evaluateRolloutGuardrails({
                db: this.db,
                config: this.config,
                nowIso,
            });
            const retiredSpikeObserved = Array.isArray(guardrails?.breaches)
                && guardrails.breaches.some((item) => item.code === 'retired_spike');
            if (!rollout.runtime || typeof rollout.runtime !== 'object') {
                rollout.runtime = {};
            }
            rollout.runtime.preferReserveBeforeRetire = retiredSpikeObserved;

            let modeAfter = modeBefore;
            let stableSince = state.stable_since || nowIso;
            let cooldownUntil = state.cooldown_until || null;
            let action = 'steady';
            let patch = {};

            if (modeBefore === 'COOLDOWN') {
                const cooldownMs = Date.parse(cooldownUntil || '');
                if (guardrails.shouldRollback) {
                    modeAfter = 'COOLDOWN';
                    stableSince = null;
                    action = 'cooldown_hold';
                } else if (!Number.isFinite(cooldownMs) || cooldownMs <= Date.parse(nowIso)) {
                    patch = resolveFeaturePatch(rollout.features, SAFE_FEATURES);
                    modeAfter = 'SAFE';
                    stableSince = nowIso;
                    cooldownUntil = null;
                    action = 'cooldown_recover';
                } else {
                    action = 'cooldown_hold';
                }
            } else if (guardrails.shouldRollback) {
                for (const key of guardrails.recommendedRollbackFeatures) {
                    patch[key] = false;
                }
                patch.honorPromotionTuning = false;
                modeAfter = 'COOLDOWN';
                stableSince = null;
                cooldownUntil = new Date(Date.parse(nowIso) + orchestrator.cooldownHours * 3_600_000).toISOString();
                action = 'rollback';
            } else if (modeBefore === 'FULL') {
                patch = resolveFeaturePatch(rollout.features, FULL_FEATURES);
                modeAfter = 'FULL';
                action = Object.keys(patch).length > 0 ? 'full_realign' : 'full_hold';
            } else {
                const safePatch = resolveFeaturePatch(rollout.features, SAFE_FEATURES);
                if (Object.keys(safePatch).length > 0) {
                    patch = safePatch;
                    stableSince = nowIso;
                    action = 'safe_realign';
                } else {
                    const stableHours = hoursBetween(stableSince, nowIso);
                    const l2Samples = Number(guardrails?.metrics?.l2?.total || 0);
                    if (stableHours >= orchestrator.stableHours && l2Samples >= orchestrator.minL2Samples) {
                        patch = resolveFeaturePatch(rollout.features, FULL_FEATURES);
                        modeAfter = 'FULL';
                        action = 'promote_full';
                    } else {
                        modeAfter = 'SAFE';
                        action = 'safe_hold';
                    }
                }
            }

            if (Object.keys(patch).length > 0) {
                applyFeaturePatch(this.config, patch);
            }

            const nextState = {
                mode: modeAfter,
                stable_since: stableSince,
                cooldown_until: cooldownUntil,
                last_tick_at: nowIso,
                last_error: null,
            };
            this.db.updateRolloutSwitchState?.(nextState);
            this.db.insertRolloutSwitchEvent?.({
                timestamp: nowIso,
                trigger,
                action,
                mode_before: modeBefore,
                mode_after: modeAfter,
                patch,
                details: {
                    guardrails: {
                        shouldRollback: guardrails.shouldRollback,
                        breaches: guardrails.breaches,
                        breachObserved: guardrails.shouldRollback,
                        retiredSpikeObserved,
                    },
                    features: {
                        before: currentFeatures,
                        after: { ...this.config.rollout.features },
                    },
                },
            });

            if (action !== 'safe_hold' && action !== 'full_hold' && action !== 'cooldown_hold') {
                this.logger?.write?.({
                    event: '策略调整',
                    stage: 'rollout',
                    result: `自动编排动作: ${action}`,
                    action: modeAfter,
                    details: {
                        trigger,
                        patch,
                    },
                });
            }

            return {
                ok: true,
                applied: Object.keys(patch).length > 0,
                patch,
                action,
                trigger,
                state: nextState,
                features: this.config.rollout?.features,
                guardrails,
            };
        } catch (error) {
            const message = error?.message || 'orchestrator-tick-failed';
            this.db.updateRolloutSwitchState?.({
                last_tick_at: nowIso,
                last_error: message,
            });
            this.db.insertRolloutSwitchEvent?.({
                timestamp: nowIso,
                trigger,
                action: 'error',
                mode_before: null,
                mode_after: null,
                patch: {},
                details: { reason: message },
            });

            this.logger?.write?.({
                event: '线程池告警',
                stage: 'rollout',
                result: '自动编排失败',
                reason: message,
                action: '等待下次周期重试',
            });

            return {
                ok: false,
                at: nowIso,
                error: message,
            };
        } finally {
            this.tickRunning = false;
        }
    }
}

module.exports = {
    SAFE_FEATURES,
    FULL_FEATURES,
    resolveFeaturePatch,
    hoursBetween,
    pickCurrentMode,
    RolloutOrchestrator,
};

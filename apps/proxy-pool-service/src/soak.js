const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const defaultConfig = require('./config');

// 0117_createSoakRuntime_创建运行时逻辑
function createSoakRuntime(options = {}) {
    const config = options.config || defaultConfig;
    const fsImpl = options.fsImpl || fs;
    const pathImpl = options.pathImpl || path;
    const spawnImpl = options.spawnImpl || spawn;
    const fetchImpl = options.fetchImpl || fetch;
    const now = options.now || (() => new Date());

    const baseUrl = options.baseUrl || `http://127.0.0.1:${config.service.port}`;
    const dataDir = pathImpl.resolve(process.cwd(), 'apps/proxy-pool-service/data');
    fsImpl.mkdirSync(dataDir, { recursive: true });

    const startedAt = now();
    const runId = startedAt.toISOString().replace(/[:.]/g, '-');
    const timelineFile = pathImpl.join(dataDir, `soak-timeline-${runId}.jsonl`);
    const reportFile = pathImpl.join(dataDir, `soak-report-${runId}.md`);

    const durationHours = Number(process.env.SOAK_HOURS || config.soak.durationHours);
    const pollMs = Number(process.env.SOAK_POLL_MS || 30_000);
    const summaryMs = Number(process.env.SOAK_SUMMARY_MS || config.soak.summaryIntervalMs);
    const policyActionsFile = String(process.env.SOAK_POLICY_ACTIONS_FILE || '').trim();

    const state = {
        child: null,
        childManaged: false,
        crashCount: 0,
        outageCount: 0,
        samples: 0,
        maxQueue: 0,
        maxBusy: 0,
        maxFailedTasks: 0,
        healthOkSamples: 0,
        startedBySoak: false,
        lastPool: null,
        lastValueBoard: [],
        policyActions: [],
        policyActionsPlanned: 0,
        policyActionsApplied: 0,
        policyActionFailures: 0,
        nextPolicyActionIndex: 0,
    };

    // 0118_appendTimeline_执行appendTimeline相关逻辑
    function appendTimeline(type, data) {
        const line = JSON.stringify({ timestamp: now().toISOString(), type, ...data });
        fsImpl.appendFileSync(timelineFile, `${line}\n`, 'utf8');
    }

    // 0119_httpGetJson_获取JSON逻辑
    async function httpGetJson(url) {
        const res = await fetchImpl(url, {
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            throw new Error(`http-${res.status}`);
        }
        return res.json();
    }

    // 0131_httpPostJson_提交JSON逻辑
    async function httpPostJson(url, payload) {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            throw new Error(`http-${res.status}`);
        }
        return res.json();
    }

    // 0132_defaultPolicyActions_默认策略动作逻辑
    function defaultPolicyActions() {
        if (durationHours < 10) {
            return [];
        }

        const policy = config.policy || {};
        return [
            {
                atMinute: 60,
                note: '调整晋升保护窗口',
                patch: {
                    promotionProtectHours: Math.max(1, Number(policy.promotionProtectHours || 6) - 2),
                },
            },
            {
                atMinute: 180,
                note: '提高技术退伍门槛',
                patch: {
                    retirement: {
                        technicalSuccessRatio: Number((Number(policy.retirement?.technicalSuccessRatio || 0.1) + 0.02).toFixed(2)),
                    },
                },
            },
            {
                atMinute: 300,
                note: '提高纪律退伍阈值',
                patch: {
                    retirement: {
                        disciplineThreshold: Math.min(90, Number(policy.retirement?.disciplineThreshold || 40) + 3),
                    },
                },
            },
            {
                atMinute: 420,
                note: '下调荣誉触发阈值',
                patch: {
                    honors: {
                        steelStreak: Math.max(5, Number(policy.honors?.steelStreak || 30) - 5),
                        riskyWarrior: Math.max(3, Number(policy.honors?.riskyWarrior || 20) - 3),
                        thousandService: Math.max(100, Number(policy.honors?.thousandService || 1000) - 100),
                    },
                },
            },
            {
                atMinute: 540,
                note: '加强价值评分中的实战权重',
                patch: {
                    valueModel: {
                        weights: {
                            combat: 26,
                            successRatio: 14,
                            battleRatio: 12,
                            honor: 9,
                        },
                    },
                },
            },
        ];
    }

    // 0133_normalizePolicyActions_规范化策略动作逻辑
    function normalizePolicyActions(rawActions) {
        if (!Array.isArray(rawActions)) return [];
        return rawActions
            .map((item) => {
                const atMinute = Number(item?.atMinute);
                if (!Number.isFinite(atMinute) || atMinute < 0 || typeof item?.patch !== 'object' || Array.isArray(item.patch) || !item.patch) {
                    return null;
                }
                return {
                    atMinute,
                    note: String(item.note || '策略调整'),
                    patch: item.patch,
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.atMinute - b.atMinute);
    }

    // 0134_loadPolicyActions_加载策略动作逻辑
    function loadPolicyActions() {
        let actions = [];

        if (policyActionsFile) {
            try {
                const raw = fsImpl.readFileSync(policyActionsFile, 'utf8');
                actions = normalizePolicyActions(JSON.parse(raw));
                appendTimeline('policy_actions_loaded', {
                    source: policyActionsFile,
                    count: actions.length,
                });
            } catch (error) {
                appendTimeline('policy_actions_load_failed', {
                    source: policyActionsFile,
                    reason: error?.message || 'load-policy-actions-failed',
                });
            }
        } else {
            actions = normalizePolicyActions(defaultPolicyActions());
        }

        state.policyActions = actions;
        state.policyActionsPlanned = actions.length;
        state.nextPolicyActionIndex = 0;
        return actions;
    }

    // 0135_applyPendingPolicyActions_应用待执行策略动作逻辑
    async function applyPendingPolicyActions(elapsedMs) {
        const elapsedMinutes = elapsedMs / 60_000;
        while (state.nextPolicyActionIndex < state.policyActions.length) {
            const action = state.policyActions[state.nextPolicyActionIndex];
            if (elapsedMinutes < action.atMinute) {
                break;
            }

            try {
                await httpPostJson(`${baseUrl}/v1/proxies/policy`, action.patch);
                state.policyActionsApplied += 1;
                appendTimeline('policy_action_applied', {
                    atMinute: action.atMinute,
                    note: action.note,
                });
            } catch (error) {
                state.policyActionFailures += 1;
                appendTimeline('policy_action_failed', {
                    atMinute: action.atMinute,
                    note: action.note,
                    reason: error?.message || 'policy-action-failed',
                });
            }

            state.nextPolicyActionIndex += 1;
        }
    }

    // 0120_ensureService_确保逻辑
    async function ensureService() {
        try {
            await httpGetJson(`${baseUrl}/health`);
            appendTimeline('service_detected', { message: '检测到已运行实例，复用现有服务' });
            return;
        } catch {
            // start child process
        }

        appendTimeline('service_start', { message: '未检测到服务，启动 proxyhub 进程' });
        state.child = spawnImpl(process.execPath, [pathImpl.join(__dirname, 'server.js')], {
            cwd: process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        state.childManaged = true;
        state.startedBySoak = true;

        state.child.stdout.on('data', (buf) => {
            appendTimeline('child_stdout', { text: String(buf).trim().slice(0, 400) });
        });
        state.child.stderr.on('data', (buf) => {
            appendTimeline('child_stderr', { text: String(buf).trim().slice(0, 400) });
        });
        state.child.on('exit', (code, signal) => {
            state.crashCount += 1;
            appendTimeline('child_exit', { code, signal });
        });

        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            try {
                await httpGetJson(`${baseUrl}/health`);
                appendTimeline('service_ready', { message: '服务已启动并可访问' });
                return;
            } catch {
                await new Promise((r) => setTimeout(r, 1000));
            }
        }

        throw new Error('soak-start-timeout');
    }

    // 0121_pollOnce_执行pollOnce相关逻辑
    async function pollOnce() {
        state.samples += 1;

        try {
            const [health, pool] = await Promise.all([
                httpGetJson(`${baseUrl}/health`),
                httpGetJson(`${baseUrl}/v1/proxies/pool-status`),
            ]);

            state.healthOkSamples += 1;
            state.lastPool = pool.poolStatus;
            state.maxQueue = Math.max(state.maxQueue, pool.poolStatus.queueSize);
            state.maxBusy = Math.max(state.maxBusy, pool.poolStatus.workersBusy);
            state.maxFailedTasks = Math.max(state.maxFailedTasks, pool.poolStatus.failedTasks);

            appendTimeline('sample', {
                ok: true,
                workersBusy: pool.poolStatus.workersBusy,
                workersTotal: pool.poolStatus.workersTotal,
                queueSize: pool.poolStatus.queueSize,
                completedTasks: pool.poolStatus.completedTasks,
                failedTasks: pool.poolStatus.failedTasks,
                restartedWorkers: pool.poolStatus.restartedWorkers,
                healthOk: health.ok,
            });
        } catch (error) {
            state.outageCount += 1;
            appendTimeline('sample', {
                ok: false,
                reason: error?.message || 'poll-failed',
            });
        }
    }

    // 0122_writeFinalReport_写入逻辑
    function writeFinalReport(endAt, valueBoard = []) {
        const uptimeRatio = state.samples > 0 ? (state.healthOkSamples / state.samples) * 100 : 0;
        const lines = [
            `# ProxyHub V1 ${durationHours}h Soak 报告`,
            '',
            `- 启动时间: ${startedAt.toISOString()}`,
            `- 结束时间: ${endAt.toISOString()}`,
            `- 计划时长: ${durationHours} 小时`,
            `- 采样间隔: ${pollMs} ms`,
            `- 样本数: ${state.samples}`,
            `- 健康样本数: ${state.healthOkSamples}`,
            `- 可用率: ${uptimeRatio.toFixed(2)}%`,
            `- 进程异常退出次数: ${state.crashCount}`,
            `- 轮询失败次数: ${state.outageCount}`,
            `- 最大队列长度: ${state.maxQueue}`,
            `- 最大忙碌线程: ${state.maxBusy}`,
            `- 最大失败任务计数: ${state.maxFailedTasks}`,
            `- 最后线程池状态: ${state.lastPool ? JSON.stringify(state.lastPool) : 'N/A'}`,
            `- 策略动作计划数: ${state.policyActionsPlanned}`,
            `- 策略动作成功: ${state.policyActionsApplied}`,
            `- 策略动作失败: ${state.policyActionFailures}`,
            '',
            '## IP价值榜 Top 10',
            ...(Array.isArray(valueBoard) && valueBoard.length > 0
                ? valueBoard.map((item, index) => `- ${index + 1}. ${item.display_name} | 价值分 ${Number(item.ip_value_score || 0).toFixed(2)} | 军衔 ${item.rank || '-'} | 生命周期 ${item.lifecycle || '-'}`)
                : ['- 无可用样本']),
            '',
            '## 异常修复时间线',
            `- 详见 ${timelineFile}`,
            '',
            '## 残留风险清单',
            '- 若代理来源波动较大，抓源可能出现短期失败。',
            '- 校验当前为 TCP 连通性，未做全协议端到端可用性验证。',
            '- V1 未对接抓取端 lease/feedback，实战画像依赖模拟评分。',
        ];

        fsImpl.writeFileSync(reportFile, lines.join('\n'), 'utf8');
    }

    // 0123_runSoak_执行逻辑
    async function runSoak() {
        loadPolicyActions();
        appendTimeline('soak_start', {
            durationHours,
            pollMs,
            summaryMs,
            baseUrl,
            policyActionsPlanned: state.policyActionsPlanned,
        });

        await ensureService();

        const loopStartedMs = Date.now();
        const endTime = Date.now() + durationHours * 3_600_000;
        let nextSummary = Date.now() + summaryMs;

        while (Date.now() < endTime) {
            await applyPendingPolicyActions(Date.now() - loopStartedMs);
            await pollOnce();

            if (Date.now() >= nextSummary) {
                appendTimeline('hourly_summary', {
                    samples: state.samples,
                    healthOkSamples: state.healthOkSamples,
                    maxQueue: state.maxQueue,
                    maxBusy: state.maxBusy,
                    maxFailedTasks: state.maxFailedTasks,
                    crashCount: state.crashCount,
                    outageCount: state.outageCount,
                });
                nextSummary += summaryMs;
            }

            await new Promise((r) => setTimeout(r, pollMs));
        }

        await applyPendingPolicyActions(Date.now() - loopStartedMs + 60_000);
        let valueBoard = [];
        try {
            const valuePayload = await httpGetJson(`${baseUrl}/v1/proxies/value-board?limit=10`);
            valueBoard = Array.isArray(valuePayload?.items) ? valuePayload.items : [];
        } catch (error) {
            appendTimeline('value_board_fetch_failed', {
                reason: error?.message || 'value-board-fetch-failed',
            });
        }
        state.lastValueBoard = valueBoard;

        const endAt = now();
        writeFinalReport(endAt, valueBoard);
        appendTimeline('soak_end', {
            reportFile,
            timelineFile,
        });

        if (state.childManaged && state.child && state.startedBySoak) {
            state.child.kill('SIGTERM');
        }

        return {
            reportFile,
            timelineFile,
            state,
        };
    }

    // 0124_runCli_执行命令行逻辑
    async function runCli(cliOptions = {}) {
        const processRef = cliOptions.processRef || process;
        const runSoakImpl = cliOptions.runSoakImpl || runSoak;
        try {
            const result = await runSoakImpl();
            console.log(`Soak finished. report=${result.reportFile}`);
        } catch (error) {
            appendTimeline('soak_error', { reason: error?.message || 'unknown' });
            if (state.childManaged && state.child) {
                state.child.kill('SIGTERM');
            }
            console.error(error);
            processRef.exit(1);
        }
    }

    return {
        config,
        state,
        baseUrl,
        dataDir,
        timelineFile,
        reportFile,
        durationHours,
        pollMs,
        summaryMs,
        appendTimeline,
        httpGetJson,
        httpPostJson,
        normalizePolicyActions,
        loadPolicyActions,
        applyPendingPolicyActions,
        ensureService,
        pollOnce,
        writeFinalReport,
        runSoak,
        runCli,
    };
}

if (require.main === module) {
    void createSoakRuntime().runCli();
}

module.exports = {
    createSoakRuntime,
};

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const defaultConfig = require('./config');

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
    };

    function appendTimeline(type, data) {
        const line = JSON.stringify({ timestamp: now().toISOString(), type, ...data });
        fsImpl.appendFileSync(timelineFile, `${line}\n`, 'utf8');
    }

    async function httpGetJson(url) {
        const res = await fetchImpl(url, {
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            throw new Error(`http-${res.status}`);
        }
        return res.json();
    }

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

    function writeFinalReport(endAt) {
        const uptimeRatio = state.samples > 0 ? (state.healthOkSamples / state.samples) * 100 : 0;
        const lines = [
            '# ProxyHub V1 24h Soak 报告',
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

    async function runSoak() {
        appendTimeline('soak_start', {
            durationHours,
            pollMs,
            summaryMs,
            baseUrl,
        });

        await ensureService();

        const endTime = Date.now() + durationHours * 3_600_000;
        let nextSummary = Date.now() + summaryMs;

        while (Date.now() < endTime) {
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

        const endAt = now();
        writeFinalReport(endAt);
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

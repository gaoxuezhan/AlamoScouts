const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createSoakRuntime } = require('./soak');

// 0125_withTempCwd_执行withTempCwd相关逻辑
async function withTempCwd(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyhub-soak-'));
    const prev = process.cwd();
    process.chdir(dir);
    try {
        return await fn(dir);
    } finally {
        process.chdir(prev);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// 0126_makeConfig_配置逻辑
function makeConfig() {
    return {
        service: { port: 5070 },
        soak: { durationHours: 24, summaryIntervalMs: 3600000 },
    };
}

// 0127_makeChild_执行makeChild相关逻辑
function makeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killSignal = null;
    child.kill = (signal) => {
        child.killSignal = signal;
    };
    return child;
}

test('soak runtime should detect existing service without spawning', async () => {
    await withTempCwd(async () => {
        let fetchCalls = 0;
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => {
                fetchCalls += 1;
                return { ok: true, status: 200, async json() { return { ok: true, poolStatus: { queueSize: 0, workersBusy: 0, workersTotal: 1, failedTasks: 0, restartedWorkers: 0, completedTasks: 0 } }; } };
            },
            spawnImpl: () => {
                throw new Error('should-not-spawn');
            },
            now: (() => {
                let n = 0;
                return () => new Date(1700000000000 + (n += 1000));
            })(),
        });

        await runtime.ensureService();
        assert.equal(fetchCalls >= 1, true);
    });
});

test('soak runtime should spawn service and mark ready', async () => {
    await withTempCwd(async () => {
        const child = makeChild();
        let fetchCalls = 0;
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => {
                fetchCalls += 1;
                if (fetchCalls < 2) {
                    throw new Error('down');
                }
                return { ok: true, status: 200, async json() { return { ok: true, poolStatus: { queueSize: 0, workersBusy: 0, workersTotal: 1, failedTasks: 0, restartedWorkers: 0, completedTasks: 0 } }; } };
            },
            spawnImpl: () => child,
        });

        await runtime.ensureService();
        child.stdout.emit('data', Buffer.from('hello'));
        child.stderr.emit('data', Buffer.from('oops'));
        child.emit('exit', 0, null);

        assert.equal(runtime.state.childManaged, true);
        assert.equal(runtime.state.crashCount, 1);
    });
});

test('ensureService should throw startup timeout when health never recovers', async () => {
    await withTempCwd(async () => {
        const child = makeChild();
        const oldNow = Date.now;
        let nowTick = oldNow();
        Date.now = () => {
            nowTick += 31_000;
            return nowTick;
        };

        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => {
                throw new Error('down');
            },
            spawnImpl: () => child,
        });

        await assert.rejects(() => runtime.ensureService(), /soak-start-timeout/);
        Date.now = oldNow;
    });
});

test('pollOnce should track success and failure samples', async () => {
    await withTempCwd(async () => {
        let mode = 'ok';
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async (url) => {
                if (mode === 'fail') {
                    throw new Error('network-down');
                }
                if (url.endsWith('/health')) {
                    return { ok: true, status: 200, async json() { return { ok: true }; } };
                }
                return {
                    ok: true,
                    status: 200,
                    // 0128_json_JSON逻辑
                    async json() {
                        return { poolStatus: { queueSize: 3, workersBusy: 2, workersTotal: 6, failedTasks: 1, restartedWorkers: 0, completedTasks: 10 } };
                    },
                };
            },
        });

        await runtime.pollOnce();
        mode = 'fail';
        await runtime.pollOnce();

        assert.equal(runtime.state.samples, 2);
        assert.equal(runtime.state.healthOkSamples, 1);
        assert.equal(runtime.state.outageCount, 1);
    });
});

test('httpGetJson should throw on non-ok status', async () => {
    await withTempCwd(async () => {
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => ({
                ok: false,
                status: 503,
                // 0129_json_JSON逻辑
                async json() {
                    return {};
                },
            }),
        });

        await assert.rejects(() => runtime.httpGetJson('http://x'), /http-503/);
    });
});

test('writeFinalReport should produce markdown file', async () => {
    await withTempCwd(async () => {
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } }),
        });

        runtime.state.samples = 10;
        runtime.state.healthOkSamples = 9;
        runtime.state.maxQueue = 2;
        runtime.state.maxBusy = 1;
        runtime.state.maxFailedTasks = 0;

        runtime.writeFinalReport(new Date('2026-03-14T00:00:00.000Z'));
        const content = fs.readFileSync(runtime.reportFile, 'utf8');
        assert.equal(content.includes('ProxyHub V1 24h Soak 报告'), true);
    });
});

test('writeFinalReport should handle zero samples uptime branch', async () => {
    await withTempCwd(async () => {
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } }),
        });
        runtime.writeFinalReport(new Date('2026-03-14T00:00:00.000Z'));
        const content = fs.readFileSync(runtime.reportFile, 'utf8');
        assert.equal(content.includes('可用率: 0.00%'), true);
    });
});

test('runSoak should complete loop, write report, and kill child when managed', async () => {
    await withTempCwd(async () => {
        const child = makeChild();
        let healthChecks = 0;
        const oldEnv = {
            SOAK_HOURS: process.env.SOAK_HOURS,
            SOAK_POLL_MS: process.env.SOAK_POLL_MS,
            SOAK_SUMMARY_MS: process.env.SOAK_SUMMARY_MS,
        };
        const oldNow = Date.now;
        let nowMs = 1700000000000;

        process.env.SOAK_HOURS = '0.0002';
        process.env.SOAK_POLL_MS = '1';
        process.env.SOAK_SUMMARY_MS = '1';

        Date.now = () => {
            nowMs += 100;
            return nowMs;
        };

        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async (url) => {
                if (url.endsWith('/health')) {
                    healthChecks += 1;
                    if (healthChecks === 1) {
                        throw new Error('down');
                    }
                    return { ok: true, status: 200, async json() { return { ok: true }; } };
                }
                return { ok: true, status: 200, async json() { return { poolStatus: { queueSize: 0, workersBusy: 0, workersTotal: 1, failedTasks: 0, restartedWorkers: 0, completedTasks: 0 } }; } };
            },
            spawnImpl: () => child,
        });

        const result = await runtime.runSoak();
        assert.equal(fs.existsSync(result.reportFile), true);
        assert.equal(fs.existsSync(result.timelineFile), true);
        assert.equal(child.killSignal, 'SIGTERM');

        Date.now = oldNow;
        process.env.SOAK_HOURS = oldEnv.SOAK_HOURS;
        process.env.SOAK_POLL_MS = oldEnv.SOAK_POLL_MS;
        process.env.SOAK_SUMMARY_MS = oldEnv.SOAK_SUMMARY_MS;
    });
});

test('runCli should call process exit on failure', async () => {
    await withTempCwd(async () => {
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } }),
        });
        const child = makeChild();
        runtime.state.childManaged = true;
        runtime.state.child = child;

        const processRef = {
            exitCode: null,
            // 0130_exit_退出逻辑
            exit(code) {
                this.exitCode = code;
            },
        };

        await runtime.runCli({
            processRef,
            runSoakImpl: async () => {
                throw new Error('run-failed');
            },
        });

        assert.equal(processRef.exitCode, 1);
        assert.equal(child.killSignal, 'SIGTERM');

        const runtime2 = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } }),
        });
        await runtime2.runCli({
            processRef,
            runSoakImpl: async () => {
                throw null;
            },
        });
        assert.equal(processRef.exitCode, 1);
    });
});

test('pollOnce should fallback reason text when thrown value has no message', async () => {
    await withTempCwd(async () => {
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => {
                throw null;
            },
        });

        await runtime.pollOnce();
        const content = fs.readFileSync(runtime.timelineFile, 'utf8');
        assert.equal(content.includes('"reason":"poll-failed"'), true);
    });
});

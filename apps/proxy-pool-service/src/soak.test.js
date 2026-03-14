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
        soak: { durationHours: 10, summaryIntervalMs: 3600000 },
        policy: {
            promotionProtectHours: 6,
            retirement: {
                technicalSuccessRatio: 0.1,
                disciplineThreshold: 40,
            },
            honors: {
                steelStreak: 30,
                riskyWarrior: 20,
                thousandService: 1000,
            },
        },
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

        runtime.writeFinalReport(new Date('2026-03-14T00:00:00.000Z'), [
            { display_name: '价值-1', ip_value_score: 77.3, rank: '士官', lifecycle: 'active' },
            { display_name: '价值-2' },
        ]);
        const content = fs.readFileSync(runtime.reportFile, 'utf8');
        assert.equal(content.includes('ProxyHub V1 10h Soak 报告'), true);
        assert.equal(content.includes('IP价值榜 Top 10'), true);
        assert.equal(content.includes('价值分 0.00'), true);
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
        assert.equal(content.includes('无可用样本'), true);
    });
});

test('normalize/load policy actions should cover file and invalid branches', async () => {
    await withTempCwd(async (cwd) => {
        const actionsFile = path.join(cwd, 'actions.json');
        fs.writeFileSync(actionsFile, JSON.stringify([
            { atMinute: 0, note: 'ok', patch: { promotionProtectHours: 4 } },
            { atMinute: -1, note: 'bad', patch: { promotionProtectHours: 3 } },
            { atMinute: 10, note: 'bad2', patch: [] },
        ]), 'utf8');

        const oldPath = process.env.SOAK_POLICY_ACTIONS_FILE;
        process.env.SOAK_POLICY_ACTIONS_FILE = actionsFile;
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } }),
        });

        const normalized = runtime.normalizePolicyActions([{ atMinute: 2, patch: { a: 1 } }, { atMinute: -1, patch: { b: 2 } }]);
        assert.equal(normalized.length, 1);
        assert.deepEqual(runtime.normalizePolicyActions(null), []);

        const loaded = runtime.loadPolicyActions();
        assert.equal(loaded.length, 1);
        assert.equal(runtime.state.policyActionsPlanned, 1);

        process.env.SOAK_POLICY_ACTIONS_FILE = path.join(cwd, 'missing.json');
        const runtime2 = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } }),
        });
        const loaded2 = runtime2.loadPolicyActions();
        assert.equal(Array.isArray(loaded2), true);

        process.env.SOAK_POLICY_ACTIONS_FILE = oldPath;
    });
});

test('loadPolicyActions should return default 10h action plan without env file', async () => {
    await withTempCwd(async () => {
        const oldPath = process.env.SOAK_POLICY_ACTIONS_FILE;
        process.env.SOAK_POLICY_ACTIONS_FILE = '';
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } }),
        });
        const loaded = runtime.loadPolicyActions();
        assert.equal(loaded.length > 0, true);
        assert.equal(runtime.state.policyActionsPlanned, loaded.length);
        process.env.SOAK_POLICY_ACTIONS_FILE = oldPath;
    });
});

test('loadPolicyActions should fallback when policy fields are missing', async () => {
    await withTempCwd(async () => {
        const oldPath = process.env.SOAK_POLICY_ACTIONS_FILE;
        process.env.SOAK_POLICY_ACTIONS_FILE = '';
        const runtime = createSoakRuntime({
            config: {
                service: { port: 5070 },
                soak: { durationHours: 10, summaryIntervalMs: 3600000 },
                policy: {},
            },
            fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } }),
        });
        const loaded = runtime.loadPolicyActions();
        assert.equal(loaded.length, 5);
        assert.equal(loaded[0].patch.promotionProtectHours >= 1, true);
        process.env.SOAK_POLICY_ACTIONS_FILE = oldPath;
    });
});

test('loadPolicyActions should write fallback reason when read throws null', async () => {
    await withTempCwd(async () => {
        const oldPath = process.env.SOAK_POLICY_ACTIONS_FILE;
        process.env.SOAK_POLICY_ACTIONS_FILE = 'x.json';
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fsImpl: { ...fs, readFileSync: () => { throw null; } },
            fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } }),
        });
        runtime.loadPolicyActions();
        const content = fs.readFileSync(runtime.timelineFile, 'utf8');
        assert.equal(content.includes('load-policy-actions-failed'), true);
        process.env.SOAK_POLICY_ACTIONS_FILE = oldPath;
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
            SOAK_POLICY_ACTIONS_FILE: process.env.SOAK_POLICY_ACTIONS_FILE,
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

        const actionsFile = path.join(process.cwd(), 'actions.json');
        fs.writeFileSync(actionsFile, JSON.stringify([
            { atMinute: 0, note: '调参', patch: { promotionProtectHours: 3 } },
        ]), 'utf8');

        process.env.SOAK_POLICY_ACTIONS_FILE = actionsFile;

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
                if (url.endsWith('/v1/proxies/policy')) {
                    return { ok: true, status: 200, async json() { return { ok: true }; } };
                }
                if (url.includes('/v1/proxies/value-board')) {
                    return { ok: true, status: 200, async json() { return { items: [{ display_name: 'V1', ip_value_score: 90, rank: '尉官', lifecycle: 'active' }] }; } };
                }
                return { ok: true, status: 200, async json() { return { poolStatus: { queueSize: 0, workersBusy: 0, workersTotal: 1, failedTasks: 0, restartedWorkers: 0, completedTasks: 0 } }; } };
            },
            spawnImpl: () => child,
        });

        const result = await runtime.runSoak();
        assert.equal(fs.existsSync(result.reportFile), true);
        assert.equal(fs.existsSync(result.timelineFile), true);
        assert.equal(child.killSignal, 'SIGTERM');
        assert.equal(runtime.state.policyActionsApplied, 1);
        assert.equal(runtime.state.lastValueBoard.length, 1);

        Date.now = oldNow;
        process.env.SOAK_HOURS = oldEnv.SOAK_HOURS;
        process.env.SOAK_POLL_MS = oldEnv.SOAK_POLL_MS;
        process.env.SOAK_SUMMARY_MS = oldEnv.SOAK_SUMMARY_MS;
        process.env.SOAK_POLICY_ACTIONS_FILE = oldEnv.SOAK_POLICY_ACTIONS_FILE;
    });
});

test('applyPendingPolicyActions should record failure and continue', async () => {
    await withTempCwd(async () => {
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async (url) => {
                if (url.endsWith('/v1/proxies/policy')) {
                    return { ok: false, status: 500, async json() { return {}; } };
                }
                return { ok: true, status: 200, async json() { return {}; } };
            },
        });
        runtime.state.policyActions = [{ atMinute: 0, note: 'bad', patch: { promotionProtectHours: 2 } }];
        runtime.state.policyActionsPlanned = 1;
        await runtime.applyPendingPolicyActions(0);
        assert.equal(runtime.state.policyActionFailures, 1);
        assert.equal(runtime.state.nextPolicyActionIndex, 1);

        const runtime2 = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } }),
        });
        runtime2.state.policyActions = [{ atMinute: 5, note: 'wait', patch: { promotionProtectHours: 2 } }];
        await runtime2.applyPendingPolicyActions(0);
        assert.equal(runtime2.state.nextPolicyActionIndex, 0);

        const runtime3 = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async (url) => {
                if (url.endsWith('/v1/proxies/policy')) {
                    throw null;
                }
                return { ok: true, status: 200, async json() { return {}; } };
            },
        });
        runtime3.state.policyActions = [{ atMinute: 0, note: 'nullerr', patch: { promotionProtectHours: 2 } }];
        await runtime3.applyPendingPolicyActions(0);
        const content = fs.readFileSync(runtime3.timelineFile, 'utf8');
        assert.equal(content.includes('policy-action-failed'), true);
    });
});

test('runSoak should record value-board fetch failure branch', async () => {
    await withTempCwd(async () => {
        const child = makeChild();
        const oldEnv = {
            SOAK_HOURS: process.env.SOAK_HOURS,
            SOAK_POLL_MS: process.env.SOAK_POLL_MS,
            SOAK_SUMMARY_MS: process.env.SOAK_SUMMARY_MS,
            SOAK_POLICY_ACTIONS_FILE: process.env.SOAK_POLICY_ACTIONS_FILE,
        };
        const oldNow = Date.now;
        let nowMs = 1700000000000;
        process.env.SOAK_HOURS = '0.0002';
        process.env.SOAK_POLL_MS = '1';
        process.env.SOAK_SUMMARY_MS = '1';
        process.env.SOAK_POLICY_ACTIONS_FILE = '';
        Date.now = () => {
            nowMs += 100;
            return nowMs;
        };

        let healthChecks = 0;
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
                if (url.includes('/v1/proxies/value-board')) {
                    throw null;
                }
                return { ok: true, status: 200, async json() { return { poolStatus: { queueSize: 0, workersBusy: 0, workersTotal: 1, failedTasks: 0, restartedWorkers: 0, completedTasks: 0 } }; } };
            },
            spawnImpl: () => child,
        });

        await runtime.runSoak();
        const timeline = fs.readFileSync(runtime.timelineFile, 'utf8');
        assert.equal(timeline.includes('value_board_fetch_failed'), true);

        Date.now = oldNow;
        process.env.SOAK_HOURS = oldEnv.SOAK_HOURS;
        process.env.SOAK_POLL_MS = oldEnv.SOAK_POLL_MS;
        process.env.SOAK_SUMMARY_MS = oldEnv.SOAK_SUMMARY_MS;
        process.env.SOAK_POLICY_ACTIONS_FILE = oldEnv.SOAK_POLICY_ACTIONS_FILE;
    });
});

test('runSoak should handle non-array value-board payload branch', async () => {
    await withTempCwd(async () => {
        const child = makeChild();
        const oldEnv = {
            SOAK_HOURS: process.env.SOAK_HOURS,
            SOAK_POLL_MS: process.env.SOAK_POLL_MS,
            SOAK_SUMMARY_MS: process.env.SOAK_SUMMARY_MS,
            SOAK_POLICY_ACTIONS_FILE: process.env.SOAK_POLICY_ACTIONS_FILE,
        };
        const oldNow = Date.now;
        let nowMs = 1700000000000;
        process.env.SOAK_HOURS = '0.0002';
        process.env.SOAK_POLL_MS = '1';
        process.env.SOAK_SUMMARY_MS = '1';
        process.env.SOAK_POLICY_ACTIONS_FILE = '';
        Date.now = () => {
            nowMs += 100;
            return nowMs;
        };

        let healthChecks = 0;
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async (url) => {
                if (url.endsWith('/health')) {
                    healthChecks += 1;
                    if (healthChecks === 1) throw new Error('down');
                    return { ok: true, status: 200, async json() { return { ok: true }; } };
                }
                if (url.includes('/v1/proxies/value-board')) {
                    return { ok: true, status: 200, async json() { return { items: {} }; } };
                }
                return { ok: true, status: 200, async json() { return { poolStatus: { queueSize: 0, workersBusy: 0, workersTotal: 1, failedTasks: 0, restartedWorkers: 0, completedTasks: 0 } }; } };
            },
            spawnImpl: () => child,
        });

        await runtime.runSoak();
        assert.equal(Array.isArray(runtime.state.lastValueBoard), true);
        assert.equal(runtime.state.lastValueBoard.length, 0);

        Date.now = oldNow;
        process.env.SOAK_HOURS = oldEnv.SOAK_HOURS;
        process.env.SOAK_POLL_MS = oldEnv.SOAK_POLL_MS;
        process.env.SOAK_SUMMARY_MS = oldEnv.SOAK_SUMMARY_MS;
        process.env.SOAK_POLICY_ACTIONS_FILE = oldEnv.SOAK_POLICY_ACTIONS_FILE;
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

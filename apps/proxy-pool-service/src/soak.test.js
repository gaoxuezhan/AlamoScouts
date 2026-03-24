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
        battle: {
            l1SyncMs: 300000,
            l2SyncMs: 1800000,
            l2SyncMsByProfile: {
                production: 1800000,
                soak: 600000,
            },
            l3: {
                syncMs: 2700000,
                syncMsByProfile: {
                    production: 2700000,
                    soak: 600000,
                },
            },
        },
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

// 0140_restoreEnvVar_恢复环境变量逻辑
function restoreEnvVar(key, value) {
    if (value == null) {
        delete process.env[key];
        return;
    }
    process.env[key] = value;
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
        let spawnOptions = null;
        const oldProfile = process.env.PROXY_HUB_POLICY_PROFILE;
        try {
            delete process.env.PROXY_HUB_POLICY_PROFILE;
            const runtime = createSoakRuntime({
                config: makeConfig(),
                fetchImpl: async () => {
                    fetchCalls += 1;
                    if (fetchCalls < 2) {
                        throw new Error('down');
                    }
                    return { ok: true, status: 200, async json() { return { ok: true, poolStatus: { queueSize: 0, workersBusy: 0, workersTotal: 1, failedTasks: 0, restartedWorkers: 0, completedTasks: 0 } }; } };
                },
                spawnImpl: (_cmd, _args, options) => {
                    spawnOptions = options;
                    return child;
                },
            });

            await runtime.ensureService();
            child.stdout.emit('data', Buffer.from('hello'));
            child.stderr.emit('data', Buffer.from('oops'));
            child.emit('exit', 0, null);

            assert.equal(runtime.state.childManaged, true);
            assert.equal(runtime.state.crashCount, 1);
            assert.equal(spawnOptions.env.PROXY_HUB_POLICY_PROFILE, 'soak');
        } finally {
            restoreEnvVar('PROXY_HUB_POLICY_PROFILE', oldProfile);
        }
    });
});

test('ensureService should keep explicit policy profile when spawning child process', async () => {
    await withTempCwd(async () => {
        const child = makeChild();
        let fetchCalls = 0;
        let spawnOptions = null;
        const oldProfile = process.env.PROXY_HUB_POLICY_PROFILE;
        try {
            process.env.PROXY_HUB_POLICY_PROFILE = 'production';
            const runtime = createSoakRuntime({
                config: makeConfig(),
                fetchImpl: async () => {
                    fetchCalls += 1;
                    if (fetchCalls < 2) {
                        throw new Error('down');
                    }
                    return { ok: true, status: 200, async json() { return { ok: true }; } };
                },
                spawnImpl: (_cmd, _args, options) => {
                    spawnOptions = options;
                    return child;
                },
            });
            await runtime.ensureService();
            assert.equal(spawnOptions.env.PROXY_HUB_POLICY_PROFILE, 'production');
        } finally {
            restoreEnvVar('PROXY_HUB_POLICY_PROFILE', oldProfile);
        }
    });
});

test('ensureService should prefer explicit L2/L3 sync env values in service_start timeline', async () => {
    await withTempCwd(async () => {
        const child = makeChild();
        let fetchCalls = 0;
        const oldProfile = process.env.PROXY_HUB_POLICY_PROFILE;
        const oldL2 = process.env.PROXY_HUB_BATTLE_L2_MS;
        const oldL3 = process.env.PROXY_HUB_BATTLE_L3_MS;
        try {
            delete process.env.PROXY_HUB_POLICY_PROFILE;
            process.env.PROXY_HUB_BATTLE_L2_MS = '321000';
            process.env.PROXY_HUB_BATTLE_L3_MS = '654000';
            const runtime = createSoakRuntime({
                config: makeConfig(),
                fetchImpl: async () => {
                    fetchCalls += 1;
                    if (fetchCalls < 2) {
                        throw new Error('down');
                    }
                    return { ok: true, status: 200, async json() { return { ok: true }; } };
                },
                spawnImpl: () => child,
            });

            await runtime.ensureService();
            const timeline = fs.readFileSync(runtime.timelineFile, 'utf8');
            assert.equal(timeline.includes('"battleL2SyncMs":321000'), true);
            assert.equal(timeline.includes('"battleL3SyncMs":654000'), true);
        } finally {
            restoreEnvVar('PROXY_HUB_POLICY_PROFILE', oldProfile);
            restoreEnvVar('PROXY_HUB_BATTLE_L2_MS', oldL2);
            restoreEnvVar('PROXY_HUB_BATTLE_L3_MS', oldL3);
        }
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
    assert.equal(content.includes('ProxyHub V2 10h Soak 报告'), true);
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

test('loadPolicyActions should support UTF-8 BOM json', async () => {
    await withTempCwd(async (cwd) => {
        const actionsFile = path.join(cwd, 'actions-bom.json');
        fs.writeFileSync(actionsFile, `\uFEFF${JSON.stringify([
            { atMinute: 0, note: 'bom', patch: { promotionProtectHours: 5 } },
        ])}`, 'utf8');

        const oldPath = process.env.SOAK_POLICY_ACTIONS_FILE;
        process.env.SOAK_POLICY_ACTIONS_FILE = actionsFile;
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } }),
        });

        assert.equal(runtime.stripUtf8Bom('\uFEFFabc'), 'abc');
        assert.equal(runtime.stripUtf8Bom(), '');
        const loaded = runtime.loadPolicyActions();
        assert.equal(loaded.length, 1);
        assert.equal(loaded[0].note, 'bom');
        process.env.SOAK_POLICY_ACTIONS_FILE = oldPath;
    });
});

test('loadPolicyActions should fallback to empty policy object when config.policy is missing', async () => {
    await withTempCwd(async () => {
        const oldPath = process.env.SOAK_POLICY_ACTIONS_FILE;
        process.env.SOAK_POLICY_ACTIONS_FILE = '';
        const runtime = createSoakRuntime({
            config: {
                service: { port: 5070 },
                soak: { durationHours: 10, summaryIntervalMs: 3600000 },
            },
            fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } }),
        });
        const loaded = runtime.loadPolicyActions();
        assert.equal(loaded.length, 5);
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
        const timeline = fs.readFileSync(result.timelineFile, 'utf8');
        assert.equal(timeline.includes('"type":"effective_schedule"'), true);
        assert.equal(timeline.includes('"battleL2SyncMs":600000'), true);
        assert.equal(timeline.includes('"battleL3SyncMs":600000'), true);

        Date.now = oldNow;
        process.env.SOAK_HOURS = oldEnv.SOAK_HOURS;
        process.env.SOAK_POLL_MS = oldEnv.SOAK_POLL_MS;
        process.env.SOAK_SUMMARY_MS = oldEnv.SOAK_SUMMARY_MS;
        process.env.SOAK_POLICY_ACTIONS_FILE = oldEnv.SOAK_POLICY_ACTIONS_FILE;
    });
});

test('runSoak should fallback L2/L3 schedule to config defaults when profile maps are missing', async () => {
    await withTempCwd(async () => {
        const oldHours = process.env.SOAK_HOURS;
        const oldPolicyFile = process.env.SOAK_POLICY_ACTIONS_FILE;
        const oldProfile = process.env.PROXY_HUB_POLICY_PROFILE;
        const oldL2 = process.env.PROXY_HUB_BATTLE_L2_MS;
        const oldL3 = process.env.PROXY_HUB_BATTLE_L3_MS;
        try {
            process.env.SOAK_HOURS = '0';
            process.env.SOAK_POLICY_ACTIONS_FILE = '';
            process.env.PROXY_HUB_POLICY_PROFILE = 'staging';
            delete process.env.PROXY_HUB_BATTLE_L2_MS;
            delete process.env.PROXY_HUB_BATTLE_L3_MS;
            const runtime = createSoakRuntime({
                config: {
                    ...makeConfig(),
                    battle: {
                        l1SyncMs: 300000,
                        l2SyncMs: 1110000,
                        l3: {
                            syncMs: 2220000,
                        },
                    },
                },
                fetchImpl: async (url) => {
                    if (url.endsWith('/health')) {
                        return { ok: true, status: 200, async json() { return { ok: true }; } };
                    }
                    if (url.includes('/v1/proxies/value-board')) {
                        return { ok: true, status: 200, async json() { return { items: [] }; } };
                    }
                    return {
                        ok: true,
                        status: 200,
                        async json() {
                            return { poolStatus: { queueSize: 0, workersBusy: 0, workersTotal: 1, failedTasks: 0, restartedWorkers: 0, completedTasks: 0 } };
                        },
                    };
                },
            });
            await runtime.runSoak();
            const timeline = fs.readFileSync(runtime.timelineFile, 'utf8');
            assert.equal(timeline.includes('"battleL2SyncMs":1110000'), true);
            assert.equal(timeline.includes('"battleL3SyncMs":2220000'), true);
        } finally {
            restoreEnvVar('SOAK_HOURS', oldHours);
            restoreEnvVar('SOAK_POLICY_ACTIONS_FILE', oldPolicyFile);
            restoreEnvVar('PROXY_HUB_POLICY_PROFILE', oldProfile);
            restoreEnvVar('PROXY_HUB_BATTLE_L2_MS', oldL2);
            restoreEnvVar('PROXY_HUB_BATTLE_L3_MS', oldL3);
        }
    });
});

test('runSoak should mark env schedule source and apply explicit L1/L2/L3 sync env values', async () => {
    await withTempCwd(async () => {
        const oldHours = process.env.SOAK_HOURS;
        const oldPolicyFile = process.env.SOAK_POLICY_ACTIONS_FILE;
        const oldProfile = process.env.PROXY_HUB_POLICY_PROFILE;
        const oldL1 = process.env.PROXY_HUB_BATTLE_L1_MS;
        const oldL2 = process.env.PROXY_HUB_BATTLE_L2_MS;
        const oldL3 = process.env.PROXY_HUB_BATTLE_L3_MS;
        try {
            process.env.SOAK_HOURS = '0';
            process.env.SOAK_POLICY_ACTIONS_FILE = '';
            delete process.env.PROXY_HUB_POLICY_PROFILE;
            process.env.PROXY_HUB_BATTLE_L1_MS = '123000';
            process.env.PROXY_HUB_BATTLE_L2_MS = '234000';
            process.env.PROXY_HUB_BATTLE_L3_MS = '345000';

            const runtime = createSoakRuntime({
                config: makeConfig(),
                fetchImpl: async (url) => {
                    if (url.endsWith('/health')) {
                        return { ok: true, status: 200, async json() { return { ok: true }; } };
                    }
                    if (url.includes('/v1/proxies/value-board')) {
                        return { ok: true, status: 200, async json() { return { items: [] }; } };
                    }
                    return {
                        ok: true,
                        status: 200,
                        async json() {
                            return { poolStatus: { queueSize: 0, workersBusy: 0, workersTotal: 1, failedTasks: 0, restartedWorkers: 0, completedTasks: 0 } };
                        },
                    };
                },
            });
            await runtime.runSoak();
            const timeline = fs.readFileSync(runtime.timelineFile, 'utf8');
            assert.equal(timeline.includes('"battleL1SyncMs":123000'), true);
            assert.equal(timeline.includes('"battleL2SyncMs":234000'), true);
            assert.equal(timeline.includes('"battleL3SyncMs":345000'), true);
            assert.equal(timeline.includes('"battleL3SyncSource":"env"'), true);
        } finally {
            restoreEnvVar('SOAK_HOURS', oldHours);
            restoreEnvVar('SOAK_POLICY_ACTIONS_FILE', oldPolicyFile);
            restoreEnvVar('PROXY_HUB_POLICY_PROFILE', oldProfile);
            restoreEnvVar('PROXY_HUB_BATTLE_L1_MS', oldL1);
            restoreEnvVar('PROXY_HUB_BATTLE_L2_MS', oldL2);
            restoreEnvVar('PROXY_HUB_BATTLE_L3_MS', oldL3);
        }
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

test('buildHourlySummary should include increment and trend fields', async () => {
    await withTempCwd(async () => {
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } }),
        });

        runtime.state.lastPool = {
            completedTasks: 210,
            failedTasks: 12,
            restartedWorkers: 8,
            restartReasonCounts: {
                timeout: 5,
                connect_error: 2,
                protocol_error: 1,
                unknown: 0,
            },
        };
        runtime.state.lastTotalsSnapshot = {
            timestampMs: 0,
            completedTasks: 200,
            failedTasks: 10,
            restartedWorkers: 7,
            restartReasonCounts: {
                timeout: 4,
                connect_error: 2,
                protocol_error: 1,
                unknown: 0,
            },
        };
        runtime.state.previousHourlyMetrics = {
            completed_delta: 8,
            failed_delta: 1,
            restarted_delta: 0,
            hourly_fail_ratio: 0.2,
            hourly_throughput: 8,
            restarted_per_hour: 0.5,
        };

        const summary = runtime.buildHourlySummary(3_600_000, 0);
        assert.equal(summary.completed_delta, 10);
        assert.equal(summary.failed_delta, 2);
        assert.equal(summary.restarted_delta, 1);
        assert.equal(summary.restart_reason_counts_delta.timeout, 1);
        assert.equal(summary.trend_vs_prev_hour.completed_delta, 'up');
        assert.equal(summary.trend_vs_prev_hour.failed_delta, 'up');
        assert.equal(summary.trend_vs_prev_hour.hourly_fail_ratio, 'down');
        assert.equal(summary.worsening_streak_hours >= 0, true);
    });
});

test('buildHourlySummary should fallback baseline when previous snapshot is missing', async () => {
    await withTempCwd(async () => {
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } }),
        });
        runtime.state.lastTotalsSnapshot = null;
        runtime.state.lastPool = {
            completedTasks: 5,
            failedTasks: 1,
            restartedWorkers: 2,
            restartReasonCounts: {
                timeout: 1,
                connect_error: 0,
                protocol_error: 0,
                unknown: 1,
            },
        };

        const summary = runtime.buildHourlySummary(3_600_000, 0);
        assert.equal(summary.completed_delta, 5);
        assert.equal(summary.failed_delta, 1);
        assert.equal(summary.restarted_delta, 2);
        assert.equal(summary.trend_vs_prev_hour.completed_delta, 'flat');
    });
});

test('buildHourlySummary should cover empty lastPool fallback and worsening streak increment', async () => {
    await withTempCwd(async () => {
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async () => ({ ok: true, status: 200, async json() { return {}; } }),
        });

        runtime.state.lastPool = null;
        runtime.state.lastTotalsSnapshot = null;
        const emptySummary = runtime.buildHourlySummary(3_600_000, 0);
        assert.equal(emptySummary.completed_delta, 0);
        assert.equal(emptySummary.failed_delta, 0);
        assert.equal(emptySummary.restarted_delta, 0);

        runtime.state.lastPool = {
            completedTasks: 10,
            failedTasks: 6,
            restartedWorkers: 5,
            restartReasonCounts: {
                timeout: 5,
                connect_error: 0,
                protocol_error: 0,
                unknown: 0,
            },
        };
        runtime.state.lastTotalsSnapshot = {
            timestampMs: 3_600_000,
            completedTasks: 0,
            failedTasks: 0,
            restartedWorkers: 0,
            restartReasonCounts: {
                timeout: 0,
                connect_error: 0,
                protocol_error: 0,
                unknown: 0,
            },
        };
        runtime.state.previousHourlyMetrics = {
            completed_delta: 1,
            failed_delta: 0,
            restarted_delta: 0,
            hourly_fail_ratio: 0.01,
            hourly_throughput: 1,
            restarted_per_hour: 0.2,
        };
        runtime.state.worseningStreakHours = 1;

        const worsenedSummary = runtime.buildHourlySummary(7_200_000, 3_600_000);
        assert.equal(worsenedSummary.worsening_streak_hours, 2);
    });
});

test('evaluateHourlyGuardrails should trigger and recover with timeline events', async () => {
    await withTempCwd(async () => {
        const calls = [];
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async (url, options = {}) => {
                if (url.endsWith('/v1/proxies/soak/guardrail')) {
                    calls.push({
                        url,
                        body: options?.body ? JSON.parse(options.body) : null,
                    });
                    return {
                        ok: true,
                        status: 200,
                        async json() {
                            return {
                                ok: true,
                                guardrail: {
                                    effective: {
                                        workers: 5,
                                        validationThrottleFactor: 2,
                                        sourceThrottleFactor: 2,
                                    },
                                },
                            };
                        },
                    };
                }
                return { ok: true, status: 200, async json() { return {}; } };
            },
        });

        await runtime.evaluateHourlyGuardrails({
            restarted_per_hour: 45,
            hourly_fail_ratio: 0.02,
            hourly_fail_ratio_pct: 2,
        });
        await runtime.evaluateHourlyGuardrails({
            restarted_per_hour: 46,
            hourly_fail_ratio: 0.03,
            hourly_fail_ratio_pct: 3,
        });

        assert.equal(runtime.state.restartGuardrailActive, true);
        assert.equal(runtime.state.failRatioGuardrailActive, true);

        await runtime.evaluateHourlyGuardrails({
            restarted_per_hour: 10,
            hourly_fail_ratio: 0.002,
            hourly_fail_ratio_pct: 0.2,
        });
        await runtime.evaluateHourlyGuardrails({
            restarted_per_hour: 9,
            hourly_fail_ratio: 0.001,
            hourly_fail_ratio_pct: 0.1,
        });

        assert.equal(runtime.state.restartGuardrailActive, false);
        assert.equal(runtime.state.failRatioGuardrailActive, false);
        assert.equal(calls.length >= 4, true);

        const timeline = fs.readFileSync(runtime.timelineFile, 'utf8');
        assert.equal(timeline.includes('"type":"guardrail_triggered"'), true);
        assert.equal(timeline.includes('"type":"guardrail_recovered"'), true);
    });
});

test('evaluateHourlyGuardrails should record null effective payload when guardrail response omits details', async () => {
    await withTempCwd(async () => {
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async (url) => {
                if (url.endsWith('/v1/proxies/soak/guardrail')) {
                    return {
                        ok: true,
                        status: 200,
                        async json() {
                            return { ok: true };
                        },
                    };
                }
                return { ok: true, status: 200, async json() { return {}; } };
            },
        });

        await runtime.evaluateHourlyGuardrails({
            restarted_per_hour: 45,
            hourly_fail_ratio: 0.03,
            hourly_fail_ratio_pct: 3,
        });
        await runtime.evaluateHourlyGuardrails({
            restarted_per_hour: 46,
            hourly_fail_ratio: 0.04,
            hourly_fail_ratio_pct: 4,
        });
        await runtime.evaluateHourlyGuardrails({
            restarted_per_hour: 10,
            hourly_fail_ratio: 0.002,
            hourly_fail_ratio_pct: 0.2,
        });
        await runtime.evaluateHourlyGuardrails({
            restarted_per_hour: 9,
            hourly_fail_ratio: 0.001,
            hourly_fail_ratio_pct: 0.1,
        });

        const timeline = fs.readFileSync(runtime.timelineFile, 'utf8');
        assert.equal(timeline.includes('"type":"guardrail_triggered"'), true);
        assert.equal(timeline.includes('"type":"guardrail_recovered"'), true);
        assert.equal(timeline.includes('"effective":null'), true);
    });
});

test('evaluateHourlyGuardrails should record guardrail_action_failed when guardrail request fails', async () => {
    await withTempCwd(async () => {
        const runtime = createSoakRuntime({
            config: makeConfig(),
            fetchImpl: async (url) => {
                if (url.endsWith('/v1/proxies/soak/guardrail')) {
                    throw new Error('guardrail-post-failed');
                }
                return { ok: true, status: 200, async json() { return {}; } };
            },
        });

        await runtime.evaluateHourlyGuardrails({
            restarted_per_hour: 45,
            hourly_fail_ratio: 0.03,
            hourly_fail_ratio_pct: 3,
        });
        await runtime.evaluateHourlyGuardrails({
            restarted_per_hour: 46,
            hourly_fail_ratio: 0.04,
            hourly_fail_ratio_pct: 4,
        });

        const timeline = fs.readFileSync(runtime.timelineFile, 'utf8');
        assert.equal(timeline.includes('"type":"guardrail_action_failed"'), true);
        assert.equal(timeline.includes('guardrail-post-failed'), true);
    });
});

test('runSoak should initialize hourly baseline from empty pool state when duration is zero', async () => {
    await withTempCwd(async () => {
        const child = makeChild();
        const oldEnv = {
            SOAK_HOURS: process.env.SOAK_HOURS,
            SOAK_POLL_MS: process.env.SOAK_POLL_MS,
            SOAK_SUMMARY_MS: process.env.SOAK_SUMMARY_MS,
            SOAK_POLICY_ACTIONS_FILE: process.env.SOAK_POLICY_ACTIONS_FILE,
        };
        try {
            process.env.SOAK_HOURS = '0';
            process.env.SOAK_POLL_MS = '1';
            process.env.SOAK_SUMMARY_MS = '1';
            process.env.SOAK_POLICY_ACTIONS_FILE = '';

            const runtime = createSoakRuntime({
                config: makeConfig(),
                fetchImpl: async (url) => {
                    if (url.endsWith('/health')) {
                        return { ok: true, status: 200, async json() { return { ok: true }; } };
                    }
                    if (url.includes('/v1/proxies/value-board')) {
                        return { ok: true, status: 200, async json() { return { items: [] }; } };
                    }
                    return { ok: true, status: 200, async json() { return { poolStatus: { queueSize: 0, workersBusy: 0, workersTotal: 0, failedTasks: 0, restartedWorkers: 0, completedTasks: 0 } }; } };
                },
                spawnImpl: () => child,
            });

            await runtime.runSoak();
            assert.equal(runtime.state.lastTotalsSnapshot.completedTasks, 0);
            assert.equal(runtime.state.lastTotalsSnapshot.failedTasks, 0);
            assert.equal(runtime.state.lastTotalsSnapshot.restartedWorkers, 0);
            assert.equal(runtime.state.lastTotalsSnapshot.restartReasonCounts.timeout, 0);
        } finally {
            process.env.SOAK_HOURS = oldEnv.SOAK_HOURS;
            process.env.SOAK_POLL_MS = oldEnv.SOAK_POLL_MS;
            process.env.SOAK_SUMMARY_MS = oldEnv.SOAK_SUMMARY_MS;
            process.env.SOAK_POLICY_ACTIONS_FILE = oldEnv.SOAK_POLICY_ACTIONS_FILE;
        }
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

test('runSoak should fallback value-board failure reason when thrown value has no message', async () => {
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
                    throw {};
                }
                return { ok: true, status: 200, async json() { return { poolStatus: { queueSize: 0, workersBusy: 0, workersTotal: 1, failedTasks: 0, restartedWorkers: 0, completedTasks: 0 } }; } };
            },
            spawnImpl: () => child,
        });

        await runtime.runSoak();
        const timeline = fs.readFileSync(runtime.timelineFile, 'utf8');
        assert.equal(timeline.includes('value-board-fetch-failed'), true);

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

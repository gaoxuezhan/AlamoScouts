
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../../..');
const dataDir = path.resolve(__dirname, '../data');
const metaFile = path.join(dataDir, 'soak-live.meta.json');
const heartbeatFile = path.join(dataDir, 'soak-live.heartbeat.json');
const stateFile = path.join(dataDir, 'soak-watchdog.state.json');
const logFile = path.join(dataDir, 'soak-watchdog.log');
const defaultPolicyFile = path.join(dataDir, 'soak-policy-actions-issue26-stable.json');

const intervalMs = Number(process.env.SOAK_WATCHDOG_INTERVAL_MS || 900_000);
const healthUrl = String(process.env.SOAK_WATCHDOG_HEALTH_URL || 'http://127.0.0.1:5070/health');

function nowIso() {
    return new Date().toISOString();
}

function writeLog(level, message, details = {}) {
    const line = JSON.stringify({
        timestamp: nowIso(),
        level,
        message,
        ...details,
    });
    fs.appendFileSync(logFile, `${line}\n`, 'utf8');
}

function readJson(file, fallback = null) {
    try {
        const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function writeJson(file, payload) {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
}

function processAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function healthOk(url) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) return false;
        const payload = await res.json();
        return payload?.ok === true;
    } catch {
        return false;
    }
}

async function waitForHealth(url, timeoutMs = 20_000, stepMs = 1_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await healthOk(url)) return true;
        await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
    return false;
}
function latestTimelineFile() {
    const files = fs.readdirSync(dataDir)
        .filter((name) => /^soak-timeline-.*\.jsonl$/.test(name))
        .map((name) => {
            const full = path.join(dataDir, name);
            return { name, full, mtimeMs: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files[0] || null;
}

function lastSampleFromTimeline(timelinePath) {
    if (!timelinePath || !fs.existsSync(timelinePath)) return null;
    const raw = fs.readFileSync(timelinePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
            const row = JSON.parse(lines[i]);
            if (row.type === 'sample') return row;
        } catch {
            // ignore broken lines
        }
    }
    return null;
}

function stopProcess(pid) {
    if (!processAlive(pid)) return;
    try {
        process.kill(pid, 'SIGTERM');
    } catch (error) {
        writeLog('warn', 'failed_to_stop_process', {
            pid,
            reason: error?.message || 'kill-failed',
        });
    }
}

function normalizeSoakEnv(envFromMeta = {}, envFromState = {}) {
    const merged = { ...envFromState, ...envFromMeta };
    return {
        SOAK_HOURS: String(merged.SOAK_HOURS || '10'),
        SOAK_POLICY_ACTIONS_FILE: String(merged.SOAK_POLICY_ACTIONS_FILE || defaultPolicyFile),
        SOAK_POLL_MS: String(merged.SOAK_POLL_MS || '30000'),
        SOAK_SUMMARY_MS: String(merged.SOAK_SUMMARY_MS || '3600000'),
    };
}

function startSoak(envFromMeta = {}, envFromState = {}) {
    const soakEnv = normalizeSoakEnv(envFromMeta, envFromState);
    const env = { ...process.env, ...soakEnv };
    const child = spawn(process.execPath, ['apps/proxy-pool-service/src/soak.js'], {
        cwd: repoRoot,
        env,
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
    return { pid: child.pid, env: soakEnv };
}

function startServer() {
    const child = spawn(process.execPath, ['apps/proxy-pool-service/src/server.js'], {
        cwd: repoRoot,
        env: process.env,
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
    return child.pid;
}
function summarizeLastSample(lastSample) {
    if (!lastSample) {
        return {
            stale: true,
            lagMs: Number.POSITIVE_INFINITY,
        };
    }
    const sampleAt = new Date(lastSample.timestamp).getTime();
    const lagMs = Date.now() - sampleAt;
    const staleThresholdMs = Math.max(5 * 60_000, 6 * 30_000);
    return {
        stale: lagMs > staleThresholdMs,
        lagMs,
    };
}

async function runCheck() {
    fs.mkdirSync(dataDir, { recursive: true });

    const state = readJson(stateFile, {
        consecutiveHealthFailures: 0,
        restarts: 0,
        lastRestartAt: null,
        lastKnownEnv: {},
    });

    const meta = readJson(metaFile, {});
    const soakPid = Number(meta?.pid || 0);
    const soakIsAlive = processAlive(soakPid);
    const timeline = latestTimelineFile();
    const lastSample = lastSampleFromTimeline(timeline?.full);
    const sampleInfo = summarizeLastSample(lastSample);

    const health = await healthOk(healthUrl);
    state.consecutiveHealthFailures = health ? 0 : state.consecutiveHealthFailures + 1;

    const startedAtMs = Date.parse(meta?.startedAt || '');
    const withinGrace = Number.isFinite(startedAtMs) && (Date.now() - startedAtMs) < 120_000;
    const shouldRestart = !soakIsAlive || (!withinGrace && (sampleInfo.stale || state.consecutiveHealthFailures >= 2));

    let action = 'none';
    let nextPid = soakPid;
    let nextEnv = normalizeSoakEnv(meta?.env || {}, state.lastKnownEnv || {});

    if (shouldRestart) {
        action = 'restart_soak';
        stopProcess(soakPid);

        if (!health) {
            try {
                const serverPid = startServer();
                const recovered = await waitForHealth(healthUrl);
                writeLog('info', 'server_bootstrap', {
                    serverPid,
                    recovered,
                });
            } catch (error) {
                writeLog('warn', 'server_bootstrap_failed', {
                    reason: error?.message || 'server-bootstrap-failed',
                });
            }
        }

        const started = startSoak(meta?.env || {}, state.lastKnownEnv || {});
        nextPid = started.pid;
        nextEnv = started.env;
        state.restarts += 1;
        state.lastRestartAt = nowIso();
        state.consecutiveHealthFailures = 0;

        writeJson(metaFile, {
            env: nextEnv,
            cmd: 'node apps/proxy-pool-service/src/soak.js',
            pid: nextPid,
            startedAt: new Date().toISOString(),
        });
    }

    state.lastKnownEnv = nextEnv;

    const heartbeat = {
        timestamp: nowIso(),
        health,
        action,
        soakPid: nextPid,
        soakIsAlive,
        timeline: timeline?.name || null,
        lastSampleAt: lastSample?.timestamp || null,
        lastSampleOk: lastSample?.ok ?? null,
        sampleLagMs: Number.isFinite(sampleInfo.lagMs) ? sampleInfo.lagMs : null,
        sampleStale: sampleInfo.stale,
        consecutiveHealthFailures: state.consecutiveHealthFailures,
        restartCount: state.restarts,
        lastRestartAt: state.lastRestartAt,
    };

    writeJson(heartbeatFile, heartbeat);
    writeJson(stateFile, state);
    writeLog('info', 'watchdog_check', heartbeat);
}
async function main() {
    writeLog('info', 'watchdog_start', {
        intervalMs,
        healthUrl,
    });

    await runCheck();
    setInterval(() => {
        void runCheck().catch((error) => {
            writeLog('error', 'watchdog_check_failed', {
                reason: error?.message || 'unknown',
            });
        });
    }, intervalMs);
}

void main().catch((error) => {
    writeLog('error', 'watchdog_fatal', {
        reason: error?.message || 'unknown',
    });
    process.exit(1);
});




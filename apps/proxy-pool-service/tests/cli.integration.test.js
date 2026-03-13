const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function waitFor(predicate, timeoutMs = 15000, intervalMs = 200) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = async () => {
            try {
                const ok = await predicate();
                if (ok) {
                    resolve(true);
                    return;
                }
            } catch {
                // keep waiting
            }

            if (Date.now() > deadline) {
                reject(new Error('timeout'));
                return;
            }
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}

test('integration: server CLI should boot and shutdown via SIGTERM', async () => {
    const port = 5092;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyhub-cli-'));
    const dbPath = path.join(tmpDir, 'cli-server.db');

    const child = spawn(process.execPath, ['apps/proxy-pool-service/src/server.js'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            PROXY_HUB_PORT: String(port),
            PROXY_HUB_DB_PATH: dbPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (d) => {
        stderr += String(d);
    });

    await waitFor(async () => {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
        return res.ok;
    }, 20000, 300);

    child.kill('SIGTERM');

    const exit = await new Promise((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
    });

    assert.equal(exit.code === 0 || exit.signal === 'SIGTERM', true);
    assert.equal(stderr.includes('Error'), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('integration: soak CLI should finish with tiny duration', async () => {
    const port = 5093;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyhub-soak-cli-'));
    const dbPath = path.join(tmpDir, 'cli-soak.db');

    const child = spawn(process.execPath, ['apps/proxy-pool-service/src/soak.js'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            PROXY_HUB_PORT: String(port),
            PROXY_HUB_DB_PATH: dbPath,
            SOAK_HOURS: '0.0002',
            SOAK_POLL_MS: '100',
            SOAK_SUMMARY_MS: '100',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
        stdout += String(d);
    });
    child.stderr.on('data', (d) => {
        stderr += String(d);
    });

    const exit = await new Promise((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
    });

    assert.equal(exit.code, 0);
    assert.equal(stdout.includes('Soak finished. report='), true);
    assert.equal(stderr.includes('Error'), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

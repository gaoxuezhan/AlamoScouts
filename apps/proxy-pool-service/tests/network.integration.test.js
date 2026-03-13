const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('integration: monosans source should be reachable with retry and snapshot on failure', async () => {
    const url = config.source.monosans.url;
    const maxRetries = 2;
    const snapshotsDir = path.resolve(process.cwd(), 'apps/proxy-pool-service/data/test-failures');
    fs.mkdirSync(snapshotsDir, { recursive: true });

    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
        try {
            const res = await fetch(url, {
                signal: AbortSignal.timeout(20000),
                headers: {
                    'user-agent': 'ProxyHub-IntegrationTest/1.0',
                    accept: 'application/json,text/plain,*/*',
                },
            });

            if (!res.ok) {
                throw new Error(`http-${res.status}`);
            }

            const body = await res.json();
            assert.equal(Array.isArray(body), true);
            assert.equal(body.length > 0, true);
            return;
        } catch (error) {
            lastError = error;
            if (attempt <= maxRetries) {
                await sleep(500 * attempt);
            }
        }
    }

    const snapshotFile = path.join(
        snapshotsDir,
        `monosans-failure-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    fs.writeFileSync(snapshotFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        url,
        retries: maxRetries,
        error: lastError?.message || String(lastError),
    }, null, 2), 'utf8');

    assert.fail(`monosans source unavailable after retries. snapshot=${snapshotFile}`);
});

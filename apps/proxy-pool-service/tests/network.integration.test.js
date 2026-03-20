const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');

// 0166_sleep_执行sleep相关逻辑
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('integration: speedx feeds should be reachable with retry and snapshot on failure', async () => {
    const urls = (config.source.profiles?.speedx_bundle?.feeds || []).map((feed) => feed.url);
    const maxRetries = 2;
    const snapshotsDir = path.resolve(process.cwd(), 'apps/proxy-pool-service/data/test-failures');
    fs.mkdirSync(snapshotsDir, { recursive: true });

    assert.equal(urls.length, 3);

    for (const url of urls) {
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

                const body = await res.text();
                const lines = String(body)
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('//'));
                assert.equal(lines.length > 0, true);
                lastError = null;
                break;
            } catch (error) {
                lastError = error;
                if (attempt <= maxRetries) {
                    await sleep(500 * attempt);
                }
            }
        }

        if (!lastError) {
            continue;
        }

        const snapshotFile = path.join(
            snapshotsDir,
            `speedx-failure-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
        );
        fs.writeFileSync(snapshotFile, JSON.stringify({
            timestamp: new Date().toISOString(),
            url,
            retries: maxRetries,
            error: lastError?.message || String(lastError),
        }, null, 2), 'utf8');

        assert.fail(`speedx source unavailable after retries. snapshot=${snapshotFile}`);
    }
});

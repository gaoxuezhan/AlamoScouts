const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const {
    createAbortSignal,
    normalizeProxyPayload,
    fetchSourceTask,
    checkTcpConnectivity,
    validateProxyTask,
    seededRandom,
    normalizeValidationOutcome,
    scoreProxyTask,
    stateTransitionTask,
    safeParseJson,
    extractIpFromPayload,
    hasBlockSignal,
    buildProxyUrl,
    createRequestAgent,
    classifyRequestError,
    requestThroughProxy,
    runBattleL1Task,
    isL2ContentValid,
    isFallbackContentValid,
    runBattleL2Task,
    handleTask,
    attachWorkerListener,
} = require('./worker');

test('createAbortSignal should support both available and unavailable timeout API', () => {
    const sig = createAbortSignal(10);
    assert.equal(sig == null || typeof sig.aborted === 'boolean', true);

    const original = global.AbortSignal;
    global.AbortSignal = undefined;
    const fallback = createAbortSignal(10);
    assert.equal(fallback, undefined);
    global.AbortSignal = original;
});

test('normalizeProxyPayload should deduplicate and filter invalid protocols', () => {
    const normalized = normalizeProxyPayload([
        { ip: '1.1.1.1', port: '80', protocols: ['HTTP', 'https'] },
        { host: '1.1.1.1', port: 80, protocol: 'http' },
        { ip: '1.1.1.2', port: 81 },
        { ip: '2.2.2.2', port: 0, protocol: 'http' },
        { ip: '', port: 8080, protocol: 'http' },
        { ip: '3.3.3.3', port: 1080, protocol: 'socks4' },
        { ip: '3.3.3.3', port: 1080, protocol: 'socks5' },
    ], ['http', 'https', 'socks4', 'socks5']);

    assert.equal(normalized.length, 4);
    assert.equal(normalized.some((x) => x.protocol === 'http'), true);
    assert.equal(normalized.some((x) => x.protocol === 'https'), true);
    assert.equal(normalized.some((x) => x.protocol === 'socks4'), true);
    assert.equal(normalized.some((x) => x.protocol === 'socks5'), true);
});

test('fetchSourceTask should parse proxies and throw on non-ok response', async () => {
    const payload = {
        url: 'https://example.com/proxies',
        allowedProtocols: ['http', 'https'],
    };

    const okResult = await fetchSourceTask(payload, {
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            async json() {
                return [{ ip: '8.8.8.8', port: 8080, protocols: ['http', 'ftp'] }];
            },
        }),
    });

    assert.equal(okResult.normalized, 1);

    await assert.rejects(
        () => fetchSourceTask(payload, {
            fetchImpl: async () => ({ ok: false, status: 503, async json() { return []; } }),
        }),
        /source-http-503/,
    );
});

test('fetchSourceTask should support line-based source format and protocol fallback', async () => {
    const payload = {
        url: 'https://example.com/socks5.txt',
        allowedProtocols: ['http', 'socks5'],
        sourceFormat: 'line',
        defaultProtocol: 'socks5',
    };

    const result = await fetchSourceTask(payload, {
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            async text() {
                return [
                    '66.42.59.155:443',
                    'socks5://1.1.1.1:1080',
                    'http://%%:8080',
                    '10.0.0.1:abc',
                    'bad-line',
                    '# comment',
                ].join('\n');
            },
        }),
    });

    assert.equal(result.fetched, 5);
    assert.equal(result.normalized, 2);
    assert.equal(result.proxies.some((x) => x.ip === '66.42.59.155' && x.protocol === 'socks5'), true);
    assert.equal(result.proxies.some((x) => x.ip === '1.1.1.1' && x.protocol === 'socks5'), true);
});

test('fetchSourceTask should accept socks4 protocol when allowed', async () => {
    const result = await fetchSourceTask({
        url: 'https://example.com/socks4.txt',
        allowedProtocols: ['socks4'],
        sourceFormat: 'line',
        defaultProtocol: 'socks4',
    }, {
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            async text() {
                return '4.4.4.4:4145\n5.5.5.5:1080';
            },
        }),
    });

    assert.equal(result.normalized, 2);
    assert.equal(result.proxies.every((item) => item.protocol === 'socks4'), true);
});

test('fetchSourceTask should fallback to line parsing in auto mode and reject invalid json mode', async () => {
    const autoResult = await fetchSourceTask({
        url: 'https://example.com/http.txt',
        allowedProtocols: ['http'],
        sourceFormat: 'auto',
        defaultProtocol: 'http',
    }, {
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            async text() {
                return '8.8.8.8:8080\n9.9.9.9:9090';
            },
        }),
    });
    assert.equal(autoResult.normalized, 2);

    await assert.rejects(
        () => fetchSourceTask({
            url: 'https://example.com/not-json',
            sourceFormat: 'json',
        }, {
            fetchImpl: async () => ({
                ok: true,
                status: 200,
                async text() {
                    return 'not-json';
                },
            }),
        }),
        /source-json-invalid/,
    );
});

function createFakeSocket() {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.timeoutCb = null;
    socket.setTimeout = (_ms, cb) => {
        socket.timeoutCb = cb;
    };
    socket.destroy = () => {
        socket.destroyed = true;
    };
    return socket;
}

test('checkTcpConnectivity should resolve connect/timeout/error branches', async () => {
    const socketConnect = createFakeSocket();
    const p1 = checkTcpConnectivity('a', 1, 10, {
        createConnection: () => socketConnect,
    });
    socketConnect.emit('connect');
    const r1 = await p1;
    assert.equal(r1.ok, true);

    const socketTimeout = createFakeSocket();
    const p2 = checkTcpConnectivity('a', 1, 10, {
        createConnection: () => socketTimeout,
    });
    socketTimeout.timeoutCb();
    const r2 = await p2;
    assert.equal(r2.reason, 'timeout');

    const socketError = createFakeSocket();
    const p3 = checkTcpConnectivity('a', 1, 10, {
        createConnection: () => socketError,
    });
    socketError.emit('error', { code: 'ECONNRESET' });
    const r3 = await p3;
    assert.equal(r3.reason, 'ECONNRESET');

    const socketNoCode = createFakeSocket();
    const p4 = checkTcpConnectivity('a', 1, 10, {
        createConnection: () => socketNoCode,
    });
    socketNoCode.emit('error', {});
    const r4 = await p4;
    assert.equal(r4.reason, 'network_error');

    const socketFinished = createFakeSocket();
    const p5 = checkTcpConnectivity('a', 1, 10, {
        createConnection: () => socketFinished,
    });
    socketFinished.emit('connect');
    socketFinished.emit('error', { code: 'ECONNRESET' });
    const r5 = await p5;
    assert.equal(r5.ok, true);
});

test('validateProxyTask should call connectivity helper path', async () => {
    const socket = createFakeSocket();
    const promise = validateProxyTask({ ip: '1.1.1.1', port: 80, timeoutMs: 5 }, {
        createConnection: () => socket,
    });
    socket.emit('connect');
    const result = await promise;
    assert.equal(result.ok, true);

    const socketDefaultTimeout = createFakeSocket();
    const promiseDefault = validateProxyTask({ ip: '1.1.1.1', port: 80 }, {
        createConnection: () => socketDefaultTimeout,
    });
    socketDefaultTimeout.emit('connect');
    const defaultResult = await promiseDefault;
    assert.equal(defaultResult.ok, true);
});

test('seededRandom should be deterministic', () => {
    assert.equal(seededRandom('abc'), seededRandom('abc'));
    assert.notEqual(seededRandom('abc'), seededRandom('def'));
});

test('scoreProxyTask should become deterministic by validation or explicit outcome', () => {
    assert.equal(normalizeValidationOutcome({ ok: false, reason: 'timeout' }), 'timeout');
    assert.equal(normalizeValidationOutcome({ ok: false, reason: 'blocked-by-signal' }), 'blocked');
    assert.equal(normalizeValidationOutcome({ ok: false, reason: 'ECONNRESET' }), 'network_error');
    assert.equal(normalizeValidationOutcome({ ok: true, reason: 'connect_ok' }), 'success');

    assert.deepEqual(scoreProxyTask({ validation: { ok: false, reason: 'timeout', latencyMs: 7 } }), {
        outcome: 'timeout',
        latencyMs: 7,
    });
    assert.deepEqual(scoreProxyTask({ validation: { ok: true, latencyMs: 9 } }), {
        outcome: 'success',
        latencyMs: 9,
    });
    assert.deepEqual(scoreProxyTask({ outcome: 'blocked', latencyMs: 11 }), {
        outcome: 'blocked',
        latencyMs: 11,
    });
    assert.deepEqual(scoreProxyTask({ outcome: 'success', validation: { latencyMs: 4 } }), {
        outcome: 'success',
        latencyMs: 4,
    });
    assert.deepEqual(scoreProxyTask({}), {
        outcome: 'network_error',
        latencyMs: 0,
    });
    assert.deepEqual(scoreProxyTask({ validation: { ok: true }, latencyMs: 6 }), {
        outcome: 'success',
        latencyMs: 6,
    });
    assert.equal(normalizeValidationOutcome({ ok: false }), 'network_error');
});

test('utility helpers should work', () => {
    assert.deepEqual(safeParseJson('{bad'), null);
    assert.equal(extractIpFromPayload(null), null);
    assert.equal(extractIpFromPayload({ ip: '1.1.1.1' }), '1.1.1.1');
    assert.equal(extractIpFromPayload({ origin: '2.2.2.2, 3.3.3.3' }), '2.2.2.2');
    assert.equal(extractIpFromPayload({ origin: ',3.3.3.3' }), null);
    assert.equal(extractIpFromPayload({ origin: '   ' }), null);
    assert.equal(extractIpFromPayload({}), null);

    assert.equal(hasBlockSignal('Access denied please verify', ['captcha', 'access denied']), true);
    assert.equal(hasBlockSignal('Access denied please verify'), false);
    assert.equal(hasBlockSignal('hello world', ['captcha']), false);

    assert.equal(buildProxyUrl({ protocol: 'http', ip: '1.1.1.1', port: 80 }), 'http://1.1.1.1:80');
    assert.equal(buildProxyUrl({ ip: '1.1.1.1', port: 80 }), 'http://1.1.1.1:80');

    assert.deepEqual(classifyRequestError({ code: 'ETIMEDOUT' }), { outcome: 'timeout', reason: 'ETIMEDOUT' });
    assert.equal(classifyRequestError({ code: 'ECONNRESET' }).outcome, 'network_error');
    assert.deepEqual(classifyRequestError({}), { outcome: 'network_error', reason: 'network_error' });

    assert.equal(isL2ContentValid('ly.com 航班列表'), true);
    assert.equal(isL2ContentValid(), false);
    assert.equal(isL2ContentValid('random text'), false);
    assert.equal(isFallbackContentValid('x'.repeat(21)), true);
    assert.equal(isFallbackContentValid(), false);
    assert.equal(isFallbackContentValid('short'), false);
});

test('createRequestAgent should choose socks and https agent classes', () => {
    class FakeSocks {
        constructor(url) {
            this.url = url;
            this.kind = 'socks';
        }
    }
    class FakeHttps {
        constructor(url) {
            this.url = url;
            this.kind = 'https';
        }
    }

    const socks = createRequestAgent({ protocol: 'socks5', ip: '1.1.1.1', port: 1080 }, { SocksProxyAgentClass: FakeSocks });
    const httpsAgent = createRequestAgent({ protocol: 'http', ip: '1.1.1.1', port: 8080 }, { HttpsProxyAgentClass: FakeHttps });
    const httpsDefaultProtocol = createRequestAgent({ ip: '1.1.1.1', port: 8080 }, { HttpsProxyAgentClass: FakeHttps });
    const socksFallback = createRequestAgent({ protocol: 'socks5', ip: '1.1.1.1', port: 1080 });
    assert.equal(socks.kind, 'socks');
    assert.equal(socks.url, 'socks5://1.1.1.1:1080');
    assert.equal(httpsAgent.kind, 'https');
    assert.equal(httpsAgent.url, 'http://1.1.1.1:8080');
    assert.equal(httpsDefaultProtocol.kind, 'https');
    assert.equal(socksFallback != null, true);
});

function createFakeRequestLib(steps) {
    const seq = [...steps];
    return {
        request(_url, _options, cb) {
            const req = new EventEmitter();
            req.destroy = (err) => {
                setImmediate(() => req.emit('error', err || new Error('destroyed')));
            };
            req.end = () => {
                const step = seq.shift();
                if (!step) {
                    setImmediate(() => req.emit('error', Object.assign(new Error('unexpected-call'), { code: 'EUNEXPECTED' })));
                    return;
                }

                if (step.type === 'error') {
                    setImmediate(() => req.emit('error', step.error || Object.assign(new Error('e'), { code: 'ECONNRESET' })));
                    return;
                }

                if (step.type === 'timeout') {
                    setImmediate(() => req.emit('timeout'));
                    return;
                }

                const res = new EventEmitter();
                res.statusCode = step.statusCode;
                setImmediate(() => {
                    cb(res);
                    if (step.body != null) {
                        res.emit('data', Buffer.from(step.body));
                    }
                    res.emit('end');
                });
            };
            return req;
        },
    };
}

test('requestThroughProxy should return success and error branches', async () => {
    const okResult = await requestThroughProxy({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        targetUrl: 'https://api.ipify.org?format=json',
        timeoutMs: 50,
    }, {
        httpsImpl: createFakeRequestLib([
            { type: 'response', statusCode: 200, body: '{"ip":"1.1.1.1"}' },
        ]),
    });
    assert.equal(okResult.ok, true);
    assert.equal(okResult.statusCode, 200);

    const timeoutResult = await requestThroughProxy({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        targetUrl: 'http://example.com',
        timeoutMs: 50,
    }, {
        httpImpl: createFakeRequestLib([{ type: 'timeout' }]),
    });
    assert.equal(timeoutResult.ok, false);
    assert.equal(timeoutResult.outcome, 'timeout');

    const errResult = await requestThroughProxy({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        targetUrl: 'http://example.com',
        timeoutMs: 50,
    }, {
        httpImpl: createFakeRequestLib([{ type: 'error', error: { code: 'ECONNRESET' } }]),
    });
    assert.equal(errResult.ok, false);
    assert.equal(errResult.outcome, 'network_error');

    const statusFallback = await requestThroughProxy({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        targetUrl: 'https://api.ipify.org?format=json',
        timeoutMs: 50,
    }, {
        httpsImpl: createFakeRequestLib([
            { type: 'response', body: '{"ip":"1.1.1.1"}' },
        ]),
    });
    assert.equal(statusFallback.statusCode, 0);
});

test('battle L1 task should classify outcomes and succeed when one target succeeds', async () => {
    const result = await runBattleL1Task({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        targets: [
            { name: 'httpbin/ip', url: 'https://httpbin.org/ip' },
            { name: 'ipify', url: 'https://api.ipify.org?format=json' },
        ],
        timeoutMs: 50,
        blockedStatusCodes: [401, 403],
        blockSignals: ['captcha'],
    }, {
        httpsImpl: createFakeRequestLib([
            { type: 'response', statusCode: 500, body: 'oops' },
            { type: 'response', statusCode: 200, body: '{"ip":"5.5.5.5"}' },
        ]),
    });

    assert.equal(result.outcome, 'success');
    assert.equal(result.runs.length, 2);

    const blocked = await runBattleL1Task({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        targets: [{ name: 'x', url: 'https://x.test' }],
        timeoutMs: 50,
        blockedStatusCodes: [403],
        blockSignals: [],
    }, {
        httpsImpl: createFakeRequestLib([
            { type: 'response', statusCode: 403, body: 'denied' },
        ]),
    });
    assert.equal(blocked.outcome, 'blocked');

    const timeout = await runBattleL1Task({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        targets: [{ url: 'https://x.test' }],
        timeoutMs: 50,
        blockedStatusCodes: [],
        blockSignals: [],
    }, {
        httpsImpl: createFakeRequestLib([{ type: 'timeout' }]),
    });
    assert.equal(timeout.outcome, 'timeout');
    assert.equal(timeout.reason, 'all_targets_failed');

    const invalidBody = await runBattleL1Task({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        targets: [{ url: 'https://x.test' }],
        timeoutMs: 50,
        blockedStatusCodes: [],
        blockSignals: [],
    }, {
        httpsImpl: createFakeRequestLib([{ type: 'response', statusCode: 200, body: '{"x":1}' }]),
    });
    assert.equal(invalidBody.outcome, 'invalid_feedback');

    const noTargets = await runBattleL1Task({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        targets: null,
        timeoutMs: 50,
    }, {
        httpsImpl: createFakeRequestLib([]),
    });
    assert.equal(noTargets.outcome, 'network_error');
    assert.equal(noTargets.latencyMs, 0);

    const noNameSuccess = await runBattleL1Task({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        targets: [{ url: 'https://x.test' }],
        timeoutMs: 50,
    }, {
        httpsImpl: createFakeRequestLib([{ type: 'response', statusCode: 200, body: '{"ip":"7.7.7.7"}' }]),
    });
    assert.equal(noNameSuccess.runs[0].target, 'https://x.test');
});

test('battle L2 task should classify blocked/network_error/success branches', async () => {
    const blocked = await runBattleL2Task({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        primaryTargets: [{ name: 'ly', url: 'https://www.ly.com/flights' }],
        fallbackTargets: [{ name: 'baidu', url: 'https://www.baidu.com' }],
        timeoutMs: 50,
        blockedStatusCodes: [403],
        blockSignals: ['captcha'],
    }, {
        httpsImpl: createFakeRequestLib([
            { type: 'response', statusCode: 403, body: 'forbidden' },
            { type: 'response', statusCode: 200, body: 'baidu ok content long enough' },
        ]),
    });
    assert.equal(blocked.outcome, 'blocked');

    const network = await runBattleL2Task({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        primaryTargets: [{ name: 'ly', url: 'https://www.ly.com/flights' }],
        fallbackTargets: [{ name: 'baidu', url: 'https://www.baidu.com' }],
        timeoutMs: 50,
        blockedStatusCodes: [403],
        blockSignals: [],
    }, {
        httpsImpl: createFakeRequestLib([
            { type: 'error', error: { code: 'ECONNRESET' } },
            { type: 'response', statusCode: 200, body: 'baidu ok content long enough' },
        ]),
    });
    assert.equal(network.outcome, 'network_error');
    assert.equal(network.runs[1].outcome, 'success');
    assert.equal(network.runs[1].reason, 'fallback_ok');

    const success = await runBattleL2Task({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        primaryTargets: [{ name: 'ly', url: 'https://www.ly.com/flights' }],
        fallbackTargets: [{ name: 'baidu', url: 'https://www.baidu.com' }],
        timeoutMs: 50,
        blockedStatusCodes: [403],
        blockSignals: [],
    }, {
        httpsImpl: createFakeRequestLib([
            { type: 'response', statusCode: 200, body: 'ly.com 航班 flight list' },
            { type: 'response', statusCode: 200, body: 'baidu ok content long enough' },
        ]),
    });
    assert.equal(success.outcome, 'success');

    const missingPrimary = await runBattleL2Task({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        primaryTargets: [],
        fallbackTargets: [],
    }, {
        httpsImpl: createFakeRequestLib([]),
    });
    assert.equal(missingPrimary.reason, 'missing_primary_target');
    assert.equal(missingPrimary.outcome, 'invalid_feedback');

    const non2xx = await runBattleL2Task({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        primaryTargets: [{ url: 'https://ly.test' }],
        fallbackTargets: [],
        blockedStatusCodes: [],
        blockSignals: [],
    }, {
        httpsImpl: createFakeRequestLib([{ type: 'response', statusCode: 500, body: 'server error' }]),
    });
    assert.equal(non2xx.outcome, 'invalid_feedback');

    const contentInvalid = await runBattleL2Task({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        primaryTargets: [{ url: 'https://ly.test' }],
        fallbackTargets: [],
        blockedStatusCodes: [],
        blockSignals: [],
    }, {
        httpsImpl: createFakeRequestLib([{ type: 'response', statusCode: 200, body: 'hello world' }]),
    });
    assert.equal(contentInvalid.outcome, 'invalid_feedback');
    assert.equal(contentInvalid.reason, 'content_assert_failed');

    const fallbackError = await runBattleL2Task({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        primaryTargets: [{ url: 'https://ly.test' }],
        fallbackTargets: [{ url: 'https://fb.test' }],
        blockedStatusCodes: [],
        blockSignals: [],
    }, {
        httpsImpl: createFakeRequestLib([
            { type: 'error', error: { code: 'ECONNRESET' } },
            { type: 'error', error: { code: 'ECONNREFUSED' } },
        ]),
    });
    assert.equal(fallbackError.runs.length, 2);
    assert.equal(fallbackError.runs[1].reason, 'ECONNREFUSED');

    const defaultTargets = await runBattleL2Task({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
    }, {
        httpsImpl: createFakeRequestLib([]),
    });
    assert.equal(defaultTargets.outcome, 'invalid_feedback');

    const blockedNoName = await runBattleL2Task({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        primaryTargets: [{ url: 'https://ly.test' }],
        fallbackTargets: [],
        blockedStatusCodes: [403],
        blockSignals: [],
    }, {
        httpsImpl: createFakeRequestLib([{ type: 'response', statusCode: 403, body: 'blocked' }]),
    });
    assert.equal(blockedNoName.runs[0].target, 'https://ly.test');

    const fallbackInvalid = await runBattleL2Task({
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        primaryTargets: [{ url: 'https://ly.test' }],
        fallbackTargets: [{ url: 'https://fb.test' }],
        blockedStatusCodes: [],
        blockSignals: [],
    }, {
        httpsImpl: createFakeRequestLib([
            { type: 'error', error: { code: 'ECONNRESET' } },
            { type: 'response', statusCode: 200, body: 'short' },
        ]),
    });
    assert.equal(fallbackInvalid.runs[1].outcome, 'invalid_feedback');
    assert.equal(fallbackInvalid.runs[1].reason, 'fallback_assert_failed');
});

test('stateTransitionTask should return ok', () => {
    assert.deepEqual(stateTransitionTask(), { ok: true });
});

test('handleTask should dispatch all task types and throw on unknown type', async () => {
    const fetchResult = await handleTask('fetch-source', {
        url: 'https://example.com',
        allowedProtocols: ['http'],
    }, {
        fetchImpl: async () => ({ ok: true, status: 200, async json() { return [{ ip: '1.1.1.1', port: 80, protocol: 'http' }]; } }),
    });
    assert.equal(fetchResult.normalized, 1);

    const socket = createFakeSocket();
    const validatePromise = handleTask('validate-proxy', { ip: '1', port: 1, timeoutMs: 5 }, {
        createConnection: () => socket,
    });
    socket.emit('connect');
    const validateResult = await validatePromise;
    assert.equal(validateResult.ok, true);

    const scoreResult = await handleTask('score-proxy', { validation: { ok: false, reason: 'timeout', latencyMs: 3 } });
    assert.equal(scoreResult.outcome, 'timeout');

    const l1Result = await handleTask('battle-l1', {
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        targets: [{ name: 'ipify', url: 'https://api.ipify.org?format=json' }],
    }, {
        httpsImpl: createFakeRequestLib([{ type: 'response', statusCode: 200, body: '{"ip":"8.8.8.8"}' }]),
    });
    assert.equal(l1Result.stage, 'l1');

    const l2Result = await handleTask('battle-l2', {
        proxy: { protocol: 'http', ip: '1.1.1.1', port: 80 },
        primaryTargets: [{ name: 'ly', url: 'https://www.ly.com' }],
        fallbackTargets: [{ name: 'baidu', url: 'https://www.baidu.com' }],
    }, {
        httpsImpl: createFakeRequestLib([
            { type: 'response', statusCode: 200, body: 'ly.com flight' },
            { type: 'response', statusCode: 200, body: 'baidu ok content long enough' },
        ]),
    });
    assert.equal(l2Result.stage, 'l2');

    const transResult = await handleTask('state-transition', {});
    assert.equal(transResult.ok, true);

    await assert.rejects(() => handleTask('unknown-task', {}), /unknown-task-type/);
});

test('attachWorkerListener should post success and error payloads', async () => {
    const port = new EventEmitter();
    const posted = [];
    port.postMessage = (payload) => posted.push(payload);

    attachWorkerListener(port, {
        fetchImpl: async () => ({ ok: true, status: 200, async json() { return []; } }),
    });

    port.emit('message', { taskId: 1, type: 'fetch-source', payload: { url: 'https://ok' } });
    port.emit('message', { taskId: 2, type: 'unknown', payload: {} });
    port.emit('message', { taskId: 3, type: 'state-transition' });

    await new Promise((r) => setTimeout(r, 20));

    assert.equal(posted.some((x) => x.taskId === 1 && x.ok === true), true);
    assert.equal(posted.some((x) => x.taskId === 2 && x.ok === false), true);
    assert.equal(posted.some((x) => x.taskId === 3 && x.ok === true), true);
});

test('attachWorkerListener should use fallback error text when thrown value has no message', async () => {
    const port = new EventEmitter();
    const posted = [];
    port.postMessage = (payload) => posted.push(payload);

    attachWorkerListener(port, {
        fetchImpl: async () => {
            throw null;
        },
    });
    port.emit('message', { taskId: 4, type: 'fetch-source', payload: { url: 'https://x' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(posted.some((x) => x.taskId === 4 && x.error === 'worker-task-error'), true);
});

test('worker module should run under worker_threads parentPort listener', async () => {
    const worker = new Worker(path.join(__dirname, 'worker.js'));

    const message = await new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.postMessage({ taskId: 11, type: 'state-transition', payload: {} });
    });

    assert.equal(message.taskId, 11);
    assert.equal(message.ok, true);

    await worker.terminate();
});

test('fetchSourceTask should use global fetch fallback and object payload count branch', async () => {
    const oldFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        status: 200,
        async json() {
            return { ip: 'x' };
        },
    });
    const result = await fetchSourceTask({
        url: 'https://example.com/object',
        allowedProtocols: ['http'],
    });
    assert.equal(result.fetched, 0);
    global.fetch = oldFetch;
});

test('checkTcpConnectivity should use net.createConnection fallback', async () => {
    const oldCreate = net.createConnection;
    const socket = createFakeSocket();
    net.createConnection = () => socket;
    const promise = checkTcpConnectivity('x', 1, 10);
    socket.emit('connect');
    const result = await promise;
    assert.equal(result.ok, true);
    net.createConnection = oldCreate;
});

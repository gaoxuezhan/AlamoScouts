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
    scoreProxyTask,
    stateTransitionTask,
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
        { ip: '2.2.2.2', port: 0, protocol: 'http' },
        { ip: '', port: 8080, protocol: 'http' },
        { ip: '3.3.3.3', port: 1080, protocol: 'socks5' },
    ], ['http', 'https', 'socks5']);

    assert.equal(normalized.length, 3);
    assert.equal(normalized.some((x) => x.protocol === 'http'), true);
    assert.equal(normalized.some((x) => x.protocol === 'https'), true);
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
            // 0160_json_JSON逻辑
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

// 0161_createFakeSocket_创建逻辑
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
});

test('checkTcpConnectivity should ignore duplicate completion signals', async () => {
    const socket = createFakeSocket();
    const p = checkTcpConnectivity('a', 1, 10, {
        createConnection: () => socket,
    });

    socket.emit('connect');
    socket.emit('error', { code: 'late-error' });
    socket.timeoutCb();

    const result = await p;
    assert.equal(result.reason, 'connect_ok');
});

test('validateProxyTask should call connectivity helper path', async () => {
    const socket = createFakeSocket();
    const promise = validateProxyTask({ ip: '1.1.1.1', port: 80, timeoutMs: 5 }, {
        createConnection: () => socket,
    });
    socket.emit('connect');
    const result = await promise;
    assert.equal(result.ok, true);

    const socket2 = createFakeSocket();
    const promise2 = validateProxyTask({ ip: '1.1.1.1', port: 80 }, {
        createConnection: () => socket2,
    });
    socket2.timeoutCb();
    const result2 = await promise2;
    assert.equal(result2.reason, 'timeout');
});

test('seededRandom should be deterministic', () => {
    assert.equal(seededRandom('abc'), seededRandom('abc'));
    assert.notEqual(seededRandom('abc'), seededRandom('def'));
});

test('scoreProxyTask should cover key outcome branches', () => {
    const oldIso = Date.prototype.toISOString;
    Date.prototype.toISOString = () => '2026-03-14T12:34:56.000Z';

    const noValidation = scoreProxyTask({ validation: { ok: false, reason: 'timeout', latencyMs: 10 } });
    assert.equal(noValidation.outcome, 'timeout');

    const noValidationErr = scoreProxyTask({ validation: { ok: false, reason: 'err', latencyMs: 10 } });
    assert.equal(noValidationErr.outcome, 'network_error');
    const noValidationDefault1 = scoreProxyTask({ validation: { ok: false, reason: 'timeout' } });
    assert.equal(noValidationDefault1.latencyMs, 2500);
    const noValidationDefault2 = scoreProxyTask({ validation: { ok: false, reason: 'err' } });
    assert.equal(noValidationDefault2.latencyMs, 2500);

    // 0162_findSeed_执行findSeed相关逻辑
    const findSeed = (predicate) => {
        const bucket = '2026-03-14T12:34';
        for (let i = 0; i < 200000; i += 1) {
            const seed = `seed-${i}`;
            const r = seededRandom(`${seed}:${bucket}`);
            if (predicate(r)) return seed;
        }
        throw new Error('seed-not-found');
    };

    const blockedSeed = findSeed((r) => r >= 0.72 && r < 0.87);
    assert.equal(scoreProxyTask({ validation: { ok: true, latencyMs: 50 }, seed: blockedSeed }).outcome, 'blocked');

    const successSeed = findSeed((r) => r < 0.72);
    assert.equal(scoreProxyTask({ validation: { ok: true, latencyMs: 50 }, seed: successSeed }).outcome, 'success');

    const timeoutSeed = findSeed((r) => r >= 0.87 && r < 0.94);
    assert.equal(scoreProxyTask({ validation: { ok: true, latencyMs: 50 }, seed: timeoutSeed }).outcome, 'timeout');

    const networkSeed = findSeed((r) => r >= 0.94);
    assert.equal(scoreProxyTask({ validation: { ok: true, latencyMs: 50 }, seed: networkSeed }).outcome, 'network_error');

    const slowTimeoutSeed = findSeed((r) => r < 0.35);
    assert.equal(scoreProxyTask({ validation: { ok: true, latencyMs: 2501 }, seed: slowTimeoutSeed }).outcome, 'timeout');
    assert.equal(scoreProxyTask({ validation: { ok: true } }).outcome.length > 0, true);
    assert.equal(scoreProxyTask({ validation: { ok: true } }).latencyMs, 0);

    Date.prototype.toISOString = oldIso;
});

test('stateTransitionTask should return ok', () => {
    assert.deepEqual(stateTransitionTask(), { ok: true });
});

test('handleTask should dispatch and throw on unknown type', async () => {
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

test('normalizeProxyPayload should handle non-array payload and missing protocols', () => {
    assert.deepEqual(normalizeProxyPayload(null, ['http']), []);
    const out = normalizeProxyPayload([{ ip: '4.4.4.4', port: 80 }], ['http']);
    assert.deepEqual(out, []);
});

test('fetchSourceTask should use global fetch fallback and object payload count branch', async () => {
    const oldFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        status: 200,
        // 0163_json_JSON逻辑
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

test('scoreProxyTask should fallback validation when payload has no validation', () => {
    const result = scoreProxyTask({});
    assert.equal(result.outcome, 'network_error');
});

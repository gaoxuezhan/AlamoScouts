const { parentPort } = require('node:worker_threads');
const crypto = require('node:crypto');
const net = require('node:net');

// 0149_createAbortSignal_创建中止信号逻辑
function createAbortSignal(timeoutMs) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(timeoutMs);
    }
    return undefined;
}

// 0150_normalizeProxyPayload_规范化代理载荷逻辑
function normalizeProxyPayload(payload, allowedProtocols) {
    const items = Array.isArray(payload) ? payload : [];
    const out = [];
    const seen = new Set();

    for (const item of items) {
        const ip = item.ip || item.host;
        const port = Number(item.port);
        const protocolsRaw = Array.isArray(item.protocols)
            ? item.protocols
            : item.protocol
                ? [item.protocol]
                : [];

        if (!ip || !Number.isInteger(port) || port <= 0) {
            continue;
        }

        const protocols = protocolsRaw
            .map((p) => String(p).toLowerCase())
            .filter((p) => allowedProtocols.includes(p));

        for (const protocol of protocols) {
            const key = `${ip}:${port}:${protocol}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            out.push({
                ip,
                port,
                protocol,
            });
        }
    }

    return out;
}

// 0151_fetchSourceTask_抓取来源任务逻辑
async function fetchSourceTask(payload, deps = {}) {
    const start = Date.now();
    const timeoutMs = payload.timeoutMs || 15_000;
    const fetchImpl = deps.fetchImpl || fetch;

    const res = await fetchImpl(payload.url, {
        signal: createAbortSignal(timeoutMs),
        headers: {
            'user-agent': 'ProxyHub/1.0',
            'accept': 'application/json,text/plain,*/*',
        },
    });

    if (!res.ok) {
        throw new Error(`source-http-${res.status}`);
    }

    const body = await res.json();
    const proxies = normalizeProxyPayload(body, payload.allowedProtocols || ['http', 'https', 'socks5']);

    return {
        fetched: Array.isArray(body) ? body.length : 0,
        normalized: proxies.length,
        proxies,
        durationMs: Date.now() - start,
    };
}

// 0152_checkTcpConnectivity_检查TCP连通性逻辑
function checkTcpConnectivity(host, port, timeoutMs, deps = {}) {
    const createConnection = deps.createConnection || net.createConnection;

    return new Promise((resolve) => {
        const started = Date.now();
        const socket = createConnection({ host, port });
        let finished = false;

        // 0153_complete_执行complete相关逻辑
        const complete = (ok, reason) => {
            if (finished) {
                return;
            }
            finished = true;
            socket.destroy();
            resolve({
                ok,
                reason,
                latencyMs: Date.now() - started,
            });
        };

        socket.setTimeout(timeoutMs, () => complete(false, 'timeout'));
        socket.on('connect', () => complete(true, 'connect_ok'));
        socket.on('error', (err) => {
            const code = err?.code || 'network_error';
            complete(false, String(code));
        });
    });
}

// 0154_validateProxyTask_校验代理任务逻辑
async function validateProxyTask(payload, deps = {}) {
    const timeoutMs = payload.timeoutMs || 2_500;
    return checkTcpConnectivity(payload.ip, payload.port, timeoutMs, deps);
}

// 0155_seededRandom_种子随机逻辑
function seededRandom(seed) {
    const hex = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 8);
    const num = Number.parseInt(hex, 16);
    return num / 0xffffffff;
}

// 0156_scoreProxyTask_评分代理任务逻辑
function scoreProxyTask(payload) {
    const validation = payload.validation || { ok: false, reason: 'missing_validation', latencyMs: 0 };

    if (!validation.ok) {
        if (validation.reason === 'timeout') {
            return { outcome: 'timeout', latencyMs: validation.latencyMs || 2500 };
        }
        return { outcome: 'network_error', latencyMs: validation.latencyMs || 2500 };
    }

    const bucket = new Date().toISOString().slice(0, 16);
    const r = seededRandom(`${payload.seed || 'proxy'}:${bucket}`);
    const latencyMs = validation.latencyMs || 0;

    if (latencyMs > 2200 && r < 0.35) {
        return { outcome: 'timeout', latencyMs };
    }

    if (r < 0.72) {
        return { outcome: 'success', latencyMs };
    }
    if (r < 0.87) {
        return { outcome: 'blocked', latencyMs };
    }
    if (r < 0.94) {
        return { outcome: 'timeout', latencyMs };
    }
    return { outcome: 'network_error', latencyMs };
}

// 0157_stateTransitionTask_状态迁移任务逻辑
function stateTransitionTask() {
    return {
        ok: true,
    };
}

// 0158_handleTask_处理任务逻辑
async function handleTask(type, payload, deps = {}) {
    if (type === 'fetch-source') {
        return fetchSourceTask(payload, deps);
    }
    if (type === 'validate-proxy') {
        return validateProxyTask(payload, deps);
    }
    if (type === 'score-proxy') {
        return scoreProxyTask(payload, deps);
    }
    if (type === 'state-transition') {
        return stateTransitionTask(payload, deps);
    }

    throw new Error(`unknown-task-type:${type}`);
}

// 0159_attachWorkerListener_绑定工作线程监听器逻辑
function attachWorkerListener(portLike, deps = {}) {
    portLike.on('message', async (message) => {
        const { taskId, type, payload } = message;
        try {
            const result = await handleTask(type, payload || {}, deps);
            portLike.postMessage({ taskId, ok: true, result });
        } catch (error) {
            portLike.postMessage({
                taskId,
                ok: false,
                error: error?.message || 'worker-task-error',
            });
        }
    });
}

if (parentPort) {
    attachWorkerListener(parentPort);
}

module.exports = {
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
};

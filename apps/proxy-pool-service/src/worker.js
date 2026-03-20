const { parentPort } = require('node:worker_threads');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

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

// 0265_parseLineProxyPayload_解析文本代理列表逻辑
function parseLineProxyPayload(rawText, defaultProtocol = 'http') {
    const text = String(rawText || '');
    const lines = text.split(/\r?\n/);
    const items = [];
    let fetched = 0;

    for (const rawLine of lines) {
        const line = String(rawLine || '').trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) {
            continue;
        }

        fetched += 1;
        let protocol = String(defaultProtocol || 'http').toLowerCase();
        let hostPort = line;

        if (line.includes('://')) {
            try {
                const parsed = new URL(line);
                protocol = String(parsed.protocol || '').replace(/:$/, '').toLowerCase();
                hostPort = parsed.host;
            } catch {
                continue;
            }
        }

        const sep = hostPort.lastIndexOf(':');
        if (sep <= 0 || sep >= hostPort.length - 1) {
            continue;
        }

        const host = hostPort.slice(0, sep).trim();
        const port = Number(hostPort.slice(sep + 1));
        if (!host || !Number.isInteger(port) || port <= 0) {
            continue;
        }

        items.push({
            ip: host,
            port,
            protocol,
        });
    }

    return {
        fetched,
        items,
    };
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
            accept: 'application/json,text/plain,*/*',
        },
    });

    if (!res.ok) {
        throw new Error(`source-http-${res.status}`);
    }

    const sourceFormat = String(payload.sourceFormat || 'auto').toLowerCase();
    const defaultProtocol = String(payload.defaultProtocol || 'http').toLowerCase();
    const allowedProtocols = payload.allowedProtocols || ['http', 'https', 'socks4', 'socks5'];

    let rawText = '';
    if (typeof res.text === 'function') {
        rawText = await res.text();
    }
    if (!rawText && typeof res.json === 'function') {
        rawText = JSON.stringify(await res.json());
    }

    let fetched = 0;
    let proxies = [];
    if (sourceFormat === 'line') {
        const parsed = parseLineProxyPayload(rawText, defaultProtocol);
        fetched = parsed.fetched;
        proxies = normalizeProxyPayload(parsed.items, allowedProtocols);
    } else {
        const parsedJson = safeParseJson(rawText);
        if (sourceFormat === 'json' && parsedJson == null) {
            throw new Error('source-json-invalid');
        }

        if (parsedJson != null) {
            fetched = Array.isArray(parsedJson) ? parsedJson.length : 0;
            proxies = normalizeProxyPayload(parsedJson, allowedProtocols);
        } else {
            const parsed = parseLineProxyPayload(rawText, defaultProtocol);
            fetched = parsed.fetched;
            proxies = normalizeProxyPayload(parsed.items, allowedProtocols);
        }
    }

    return {
        fetched,
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

// 0196_normalizeValidationOutcome_规范化校验结果逻辑
function normalizeValidationOutcome(validation) {
    if (!validation?.ok) {
        const reason = String(validation?.reason || '').toLowerCase();
        if (reason.includes('timeout')) {
            return 'timeout';
        }
        if (reason.includes('blocked')) {
            return 'blocked';
        }
        return 'network_error';
    }
    return 'success';
}

// 0156_scoreProxyTask_评分代理任务逻辑
function scoreProxyTask(payload) {
    if (typeof payload?.outcome === 'string' && payload.outcome.length > 0) {
        return {
            outcome: payload.outcome,
            latencyMs: Number(payload.latencyMs || payload.validation?.latencyMs || 0),
        };
    }

    const validation = payload.validation || { ok: false, reason: 'missing_validation', latencyMs: 0 };
    return {
        outcome: normalizeValidationOutcome(validation),
        latencyMs: Number(validation.latencyMs || payload.latencyMs || 0),
    };
}

// 0157_stateTransitionTask_状态迁移任务逻辑
function stateTransitionTask() {
    return {
        ok: true,
    };
}

// 0197_safeParseJson_安全解析JSON逻辑
function safeParseJson(raw) {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

// 0198_extractIpFromPayload_提取IP字段逻辑
function extractIpFromPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const direct = payload.ip;
    if (typeof direct === 'string' && direct.trim()) {
        return direct.trim();
    }

    const origin = payload.origin;
    if (typeof origin === 'string' && origin.trim()) {
        const first = origin.split(',')[0]?.trim();
        return first || null;
    }

    return null;
}

// 0199_hasBlockSignal_命中拦截信号逻辑
function hasBlockSignal(text, blockSignals) {
    const haystack = String(text || '').toLowerCase();
    return (blockSignals || []).some((signal) => haystack.includes(String(signal).toLowerCase()));
}

// 0200_buildProxyUrl_构建代理URL逻辑
function buildProxyUrl(proxy) {
    const protocol = String(proxy?.protocol || 'http').toLowerCase();
    return `${protocol}://${proxy.ip}:${proxy.port}`;
}

// 0201_createRequestAgent_创建请求代理逻辑
function createRequestAgent(proxy, deps = {}) {
    const proxyUrl = buildProxyUrl(proxy);
    const protocol = String(proxy?.protocol || 'http').toLowerCase();
    if (protocol.startsWith('socks')) {
        const AgentClass = deps.SocksProxyAgentClass || SocksProxyAgent;
        return new AgentClass(proxyUrl);
    }
    const AgentClass = deps.HttpsProxyAgentClass || HttpsProxyAgent;
    return new AgentClass(proxyUrl);
}

// 0202_classifyRequestError_分类请求错误逻辑
function classifyRequestError(error) {
    const code = String(error?.code || '').toLowerCase();
    const message = String(error?.message || '').toLowerCase();
    if (code.includes('timedout') || message.includes('timeout')) {
        return { outcome: 'timeout', reason: error?.code || 'timeout' };
    }
    return { outcome: 'network_error', reason: error?.code || error?.message || 'network_error' };
}

// 0203_requestThroughProxy_通过代理请求逻辑
function requestThroughProxy({ proxy, targetUrl, timeoutMs, headers }, deps = {}) {
    const started = Date.now();
    const requestLib = targetUrl.startsWith('https://') ? (deps.httpsImpl || https) : (deps.httpImpl || http);
    const agent = createRequestAgent(proxy, deps);

    return new Promise((resolve) => {
        const req = requestLib.request(targetUrl, {
            method: 'GET',
            agent,
            headers: {
                'user-agent': 'ProxyHub-Battle/1.0',
                accept: 'application/json,text/plain,*/*',
                ...headers,
            },
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            let total = 0;
            res.on('data', (chunk) => {
                total += chunk.length;
                if (total <= 512_000) {
                    chunks.push(chunk);
                }
            });
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve({
                    ok: true,
                    statusCode: res.statusCode || 0,
                    latencyMs: Date.now() - started,
                    body,
                });
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error('timeout'));
        });

        req.on('error', (error) => {
            const classified = classifyRequestError(error);
            resolve({
                ok: false,
                statusCode: 0,
                latencyMs: Date.now() - started,
                body: '',
                outcome: classified.outcome,
                reason: classified.reason,
            });
        });

        req.end();
    });
}

// 0204_runBattleL1Task_执行战场L1逻辑
async function runBattleL1Task(payload, deps = {}) {
    const targets = Array.isArray(payload.targets) ? payload.targets : [];
    const timeoutMs = Number(payload.timeoutMs || 5000);
    const blockedStatusCodes = payload.blockedStatusCodes || [];
    const blockSignals = payload.blockSignals || [];
    const runs = [];

    for (const target of targets) {
        const requestResult = await requestThroughProxy({
            proxy: payload.proxy,
            targetUrl: target.url,
            timeoutMs,
            headers: target.headers || {},
        }, deps);

        if (!requestResult.ok) {
            runs.push({
                target: target.name || target.url,
                outcome: requestResult.outcome || 'network_error',
                statusCode: requestResult.statusCode || null,
                latencyMs: requestResult.latencyMs,
                reason: requestResult.reason || 'request_error',
                details: {},
            });
            continue;
        }

        const isBlocked = blockedStatusCodes.includes(requestResult.statusCode)
            || hasBlockSignal(requestResult.body, blockSignals);
        if (isBlocked) {
            runs.push({
                target: target.name || target.url,
                outcome: 'blocked',
                statusCode: requestResult.statusCode,
                latencyMs: requestResult.latencyMs,
                reason: 'blocked_signal',
                details: {},
            });
            continue;
        }

        if (requestResult.statusCode < 200 || requestResult.statusCode >= 300) {
            runs.push({
                target: target.name || target.url,
                outcome: 'invalid_feedback',
                statusCode: requestResult.statusCode,
                latencyMs: requestResult.latencyMs,
                reason: 'non_2xx',
                details: {},
            });
            continue;
        }

        const parsed = safeParseJson(requestResult.body);
        const ip = extractIpFromPayload(parsed);
        if (!ip) {
            runs.push({
                target: target.name || target.url,
                outcome: 'invalid_feedback',
                statusCode: requestResult.statusCode,
                latencyMs: requestResult.latencyMs,
                reason: 'ip_field_missing',
                details: {},
            });
            continue;
        }

        runs.push({
            target: target.name || target.url,
            outcome: 'success',
            statusCode: requestResult.statusCode,
            latencyMs: requestResult.latencyMs,
            reason: 'ip_parsed',
            details: { ip },
        });
    }

    const hasSuccess = runs.some((item) => item.outcome === 'success');
    let outcome = 'network_error';
    if (hasSuccess) {
        outcome = 'success';
    } else if (runs.some((item) => item.outcome === 'blocked')) {
        outcome = 'blocked';
    } else if (runs.some((item) => item.outcome === 'timeout')) {
        outcome = 'timeout';
    } else if (runs.some((item) => item.outcome === 'invalid_feedback')) {
        outcome = 'invalid_feedback';
    }

    const avgLatency = runs.length > 0
        ? Math.round(runs.reduce((sum, item) => sum + (item.latencyMs || 0), 0) / runs.length)
        : 0;

    return {
        stage: 'l1',
        outcome,
        latencyMs: avgLatency,
        reason: hasSuccess ? 'at_least_one_target_success' : 'all_targets_failed',
        runs,
    };
}

// 0205_isL2ContentValid_判断L2内容有效逻辑
function isL2ContentValid(body) {
    const text = String(body || '').toLowerCase();
    return text.includes('ly.com') || text.includes('flight') || text.includes('航班') || text.includes('机票');
}

// 0206_isFallbackContentValid_判断兜底内容有效逻辑
function isFallbackContentValid(body) {
    return String(body || '').trim().length > 20;
}

// 0207_runBattleL2Task_执行战场L2逻辑
async function runBattleL2Task(payload, deps = {}) {
    const timeoutMs = Number(payload.timeoutMs || 8000);
    const blockedStatusCodes = payload.blockedStatusCodes || [];
    const blockSignals = payload.blockSignals || [];
    const primary = (payload.primaryTargets || [])[0];
    const fallback = (payload.fallbackTargets || [])[0];
    const runs = [];

    if (!primary) {
        return {
            stage: 'l2',
            outcome: 'invalid_feedback',
            latencyMs: 0,
            reason: 'missing_primary_target',
            runs,
        };
    }

    const primaryResult = await requestThroughProxy({
        proxy: payload.proxy,
        targetUrl: primary.url,
        timeoutMs,
        headers: primary.headers || {},
    }, deps);

    if (!primaryResult.ok) {
        runs.push({
            target: primary.name || primary.url,
            outcome: primaryResult.outcome || 'network_error',
            statusCode: primaryResult.statusCode || null,
            latencyMs: primaryResult.latencyMs,
            reason: primaryResult.reason || 'primary_failed',
            details: {},
        });
    } else {
        const blockedBySignal = blockedStatusCodes.includes(primaryResult.statusCode)
            || hasBlockSignal(primaryResult.body, blockSignals);
        if (blockedBySignal) {
            runs.push({
                target: primary.name || primary.url,
                outcome: 'blocked',
                statusCode: primaryResult.statusCode,
                latencyMs: primaryResult.latencyMs,
                reason: 'blocked_signal',
                details: {},
            });
        } else if (primaryResult.statusCode < 200 || primaryResult.statusCode >= 300) {
            runs.push({
                target: primary.name || primary.url,
                outcome: 'invalid_feedback',
                statusCode: primaryResult.statusCode,
                latencyMs: primaryResult.latencyMs,
                reason: 'non_2xx',
                details: {},
            });
        } else if (!isL2ContentValid(primaryResult.body)) {
            runs.push({
                target: primary.name || primary.url,
                outcome: 'invalid_feedback',
                statusCode: primaryResult.statusCode,
                latencyMs: primaryResult.latencyMs,
                reason: 'content_assert_failed',
                details: {},
            });
        } else {
            runs.push({
                target: primary.name || primary.url,
                outcome: 'success',
                statusCode: primaryResult.statusCode,
                latencyMs: primaryResult.latencyMs,
                reason: 'content_assert_ok',
                details: {},
            });
        }
    }

    let fallbackSuccess = false;
    if (fallback) {
        const fallbackResult = await requestThroughProxy({
            proxy: payload.proxy,
            targetUrl: fallback.url,
            timeoutMs,
            headers: fallback.headers || {},
        }, deps);

        if (!fallbackResult.ok) {
            runs.push({
                target: fallback.name || fallback.url,
                outcome: fallbackResult.outcome || 'network_error',
                statusCode: fallbackResult.statusCode || null,
                latencyMs: fallbackResult.latencyMs,
                reason: fallbackResult.reason || 'fallback_failed',
                details: {},
            });
        } else {
            fallbackSuccess = fallbackResult.statusCode >= 200
                && fallbackResult.statusCode < 300
                && isFallbackContentValid(fallbackResult.body);
            runs.push({
                target: fallback.name || fallback.url,
                outcome: fallbackSuccess ? 'success' : 'invalid_feedback',
                statusCode: fallbackResult.statusCode,
                latencyMs: fallbackResult.latencyMs,
                reason: fallbackSuccess ? 'fallback_ok' : 'fallback_assert_failed',
                details: {},
            });
        }
    }

    const primaryRun = runs[0];
    let outcome = primaryRun?.outcome || 'network_error';
    if ((primaryRun?.outcome === 'timeout' || primaryRun?.outcome === 'network_error') && fallbackSuccess) {
        outcome = 'network_error';
    }

    const avgLatency = runs.length > 0
        ? Math.round(runs.reduce((sum, item) => sum + (item.latencyMs || 0), 0) / runs.length)
        : 0;

    return {
        stage: 'l2',
        outcome,
        latencyMs: avgLatency,
        reason: primaryRun?.reason || 'l2_done',
        runs,
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
    if (type === 'battle-l1') {
        return runBattleL1Task(payload, deps);
    }
    if (type === 'battle-l2') {
        return runBattleL2Task(payload, deps);
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
};

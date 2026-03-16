const { EventEmitter } = require('node:events');

const EXACT_TRANSLATIONS = {
    success: '成功',
    blocked: '封禁',
    timeout: '超时',
    network_error: '网络错误',
    networkerror: '网络错误',
    invalid_feedback: '反馈无效',
    invalidfeedback: '反馈无效',
    candidate: '候选',
    active: '现役',
    reserve: '预备',
    retired: '退役',
};

const TOKEN_TRANSLATIONS = {
    invalid_feedback: '反馈无效',
    invalidFeedback: '反馈无效',
    network_error: '网络错误',
    networkError: '网络错误',
    success: '成功',
    blocked: '封禁',
    timeout: '超时',
    candidate: '候选',
    active: '现役',
    reserve: '预备',
    retired: '退役',
};

// 0218_escapeRegExp_转义正则字符逻辑
function escapeRegExp(input) {
    return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 0219_localizeRuntimeText_本地化运行时文本逻辑
function localizeRuntimeText(value) {
    if (value == null) {
        return '-';
    }

    const raw = String(value).trim();
    if (!raw) {
        return '-';
    }

    const exactKey = raw.toLowerCase().replace(/\s+/g, '');
    if (Object.prototype.hasOwnProperty.call(EXACT_TRANSLATIONS, exactKey)) {
        return EXACT_TRANSLATIONS[exactKey];
    }

    let localized = raw;
    for (const [token, replacement] of Object.entries(TOKEN_TRANSLATIONS)) {
        const pattern = new RegExp(`\\b${escapeRegExp(token)}\\b`, 'gi');
        localized = localized.replace(pattern, replacement);
    }
    return localized;
}

// 0220_normalizeRuntimeDetails_归一化日志详情逻辑
function normalizeRuntimeDetails(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return { ...value };
}

// 0221_localizeRuntimeRecord_本地化运行时日志记录逻辑
function localizeRuntimeRecord(record) {
    const details = normalizeRuntimeDetails(record?.details);

    const rawResult = record?.result || '-';
    const rawReason = record?.reason || '-';
    const rawAction = record?.action || '-';

    const result = localizeRuntimeText(rawResult);
    const reason = localizeRuntimeText(rawReason);
    const action = localizeRuntimeText(rawAction);

    if (result !== rawResult && !Object.prototype.hasOwnProperty.call(details, 'raw_result')) {
        details.raw_result = rawResult;
    }
    if (reason !== rawReason && !Object.prototype.hasOwnProperty.call(details, 'raw_reason')) {
        details.raw_reason = rawReason;
    }
    if (action !== rawAction && !Object.prototype.hasOwnProperty.call(details, 'raw_action')) {
        details.raw_action = rawAction;
    }

    return { result, reason, action, details };
}

class RuntimeLogger extends EventEmitter {
    // 0190_constructor_初始化实例逻辑
    constructor({ db, retention = 2000 }) {
        super();
        this.db = db;
        this.retention = retention;
        this.logs = [];
    }

    // 0071_write_写入逻辑
    write(record) {
        const localized = localizeRuntimeRecord(record);
        const entry = {
            timestamp: record.timestamp || new Date().toISOString(),
            event: record.event || '系统事件',
            proxy_name: record.proxyName || '-',
            ip_source: record.ipSource || '-',
            stage: record.stage || '-',
            result: localized.result,
            duration_ms: Number.isFinite(record.durationMs) ? Math.round(record.durationMs) : null,
            reason: localized.reason,
            action: localized.action,
            details: localized.details,
        };

        this.logs.push(entry);
        if (this.logs.length > this.retention) {
            this.logs.splice(0, this.logs.length - this.retention);
        }

        try {
            this.db.insertRuntimeLog(entry);
        } catch {
            // ignore storage errors in logger hot path
        }

        this.emit('log', entry);
        return entry;
    }

    // 0191_getRecent_获取近期日志逻辑
    getRecent(limit = 200) {
        const normalized = Math.max(1, Math.min(limit, this.retention));
        return this.logs.slice(-normalized).reverse();
    }

    // 0072_subscribe_订阅逻辑
    subscribe(handler) {
        this.on('log', handler);
        return () => this.off('log', handler);
    }
}

module.exports = {
    RuntimeLogger,
    localizeRuntimeText,
    localizeRuntimeRecord,
};

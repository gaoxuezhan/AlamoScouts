const { EventEmitter } = require('node:events');

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
        const entry = {
            timestamp: record.timestamp || new Date().toISOString(),
            event: record.event || '系统事件',
            proxy_name: record.proxyName || '-',
            ip_source: record.ipSource || '-',
            stage: record.stage || '-',
            result: record.result || '-',
            duration_ms: Number.isFinite(record.durationMs) ? Math.round(record.durationMs) : null,
            reason: record.reason || '-',
            action: record.action || '-',
            details: record.details || {},
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
};

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function ensureDirForFile(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

class ProxyHubDb {
    constructor(config) {
        this.config = config;
        this.dbPath = path.resolve(process.cwd(), config.storage.dbPath);
        ensureDirForFile(this.dbPath);
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.init();
    }

    init() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS proxies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                unique_key TEXT NOT NULL UNIQUE,
                ip TEXT NOT NULL,
                port INTEGER NOT NULL,
                protocol TEXT NOT NULL,
                source TEXT NOT NULL,
                batch_id TEXT,
                display_name TEXT NOT NULL UNIQUE,
                lifecycle TEXT NOT NULL DEFAULT 'candidate',
                rank TEXT NOT NULL DEFAULT '新兵',
                service_hours REAL NOT NULL DEFAULT 0,
                rank_service_hours REAL NOT NULL DEFAULT 0,
                combat_points INTEGER NOT NULL DEFAULT 0,
                health_score REAL NOT NULL DEFAULT 60,
                discipline_score REAL NOT NULL DEFAULT 100,
                success_count INTEGER NOT NULL DEFAULT 0,
                block_count INTEGER NOT NULL DEFAULT 0,
                timeout_count INTEGER NOT NULL DEFAULT 0,
                network_error_count INTEGER NOT NULL DEFAULT 0,
                invalid_feedback_count INTEGER NOT NULL DEFAULT 0,
                total_samples INTEGER NOT NULL DEFAULT 0,
                consecutive_success INTEGER NOT NULL DEFAULT 0,
                consecutive_fail INTEGER NOT NULL DEFAULT 0,
                risky_success_count INTEGER NOT NULL DEFAULT 0,
                is_applied INTEGER NOT NULL DEFAULT 0,
                last_checked_at TEXT,
                last_outcome TEXT,
                last_latency_ms INTEGER,
                retired_type TEXT,
                promotion_protect_until TEXT,
                recent_window_json TEXT NOT NULL DEFAULT '[]',
                honor_history_json TEXT NOT NULL DEFAULT '[]',
                honor_active_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_proxies_lifecycle_rank
            ON proxies(lifecycle, rank);

            CREATE INDEX IF NOT EXISTS idx_proxies_last_checked
            ON proxies(last_checked_at);

            CREATE TABLE IF NOT EXISTS proxy_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                proxy_id INTEGER,
                display_name TEXT,
                event_type TEXT NOT NULL,
                level TEXT NOT NULL,
                message TEXT NOT NULL,
                details_json TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY(proxy_id) REFERENCES proxies(id)
            );

            CREATE INDEX IF NOT EXISTS idx_proxy_events_time
            ON proxy_events(timestamp DESC);

            CREATE TABLE IF NOT EXISTS runtime_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                event TEXT NOT NULL,
                proxy_name TEXT,
                ip_source TEXT,
                stage TEXT,
                result TEXT,
                duration_ms INTEGER,
                reason TEXT,
                action TEXT,
                details_json TEXT NOT NULL DEFAULT '{}'
            );

            CREATE INDEX IF NOT EXISTS idx_runtime_logs_time
            ON runtime_logs(timestamp DESC);

            CREATE TABLE IF NOT EXISTS honors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                proxy_id INTEGER NOT NULL,
                display_name TEXT NOT NULL,
                honor_type TEXT NOT NULL,
                reason TEXT,
                awarded_at TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                UNIQUE(proxy_id, honor_type),
                FOREIGN KEY(proxy_id) REFERENCES proxies(id)
            );

            CREATE TABLE IF NOT EXISTS retirements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                proxy_id INTEGER NOT NULL,
                display_name TEXT NOT NULL,
                retired_type TEXT NOT NULL,
                reason TEXT,
                retired_at TEXT NOT NULL,
                FOREIGN KEY(proxy_id) REFERENCES proxies(id)
            );

            CREATE INDEX IF NOT EXISTS idx_retirements_time
            ON retirements(retired_at DESC);

            CREATE TABLE IF NOT EXISTS pool_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                workers_total INTEGER NOT NULL,
                workers_busy INTEGER NOT NULL,
                queue_size INTEGER NOT NULL,
                completed_tasks INTEGER NOT NULL,
                failed_tasks INTEGER NOT NULL,
                restarted_workers INTEGER NOT NULL,
                source_distribution_json TEXT NOT NULL,
                rank_distribution_json TEXT NOT NULL,
                lifecycle_distribution_json TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_pool_snapshots_time
            ON pool_snapshots(timestamp DESC);
        `);

        this.insertRuntimeLogStmt = this.db.prepare(`
            INSERT INTO runtime_logs (
                timestamp, event, proxy_name, ip_source, stage, result, duration_ms, reason, action, details_json
            ) VALUES (
                @timestamp, @event, @proxy_name, @ip_source, @stage, @result, @duration_ms, @reason, @action, @details_json
            )
        `);

        this.insertEventStmt = this.db.prepare(`
            INSERT INTO proxy_events (timestamp, proxy_id, display_name, event_type, level, message, details_json)
            VALUES (@timestamp, @proxy_id, @display_name, @event_type, @level, @message, @details_json)
        `);

        this.insertProxyStmt = this.db.prepare(`
            INSERT INTO proxies (
                unique_key, ip, port, protocol, source, batch_id, display_name,
                lifecycle, rank, created_at, updated_at, last_seen_at
            ) VALUES (
                @unique_key, @ip, @port, @protocol, @source, @batch_id, @display_name,
                'candidate', '新兵', @now, @now, @now
            )
        `);

        this.touchProxyStmt = this.db.prepare(`
            UPDATE proxies SET
                source = @source,
                batch_id = @batch_id,
                updated_at = @now,
                last_seen_at = @now
            WHERE id = @id
        `);
    }

    close() {
        this.db.close();
    }

    isDisplayNameAvailable(displayName) {
        const row = this.db.prepare('SELECT id FROM proxies WHERE display_name = ?').get(displayName);
        return !row;
    }

    getProxyByKey(uniqueKey) {
        return this.db.prepare('SELECT * FROM proxies WHERE unique_key = ?').get(uniqueKey);
    }

    getProxyById(id) {
        return this.db.prepare('SELECT * FROM proxies WHERE id = ?').get(id);
    }

    upsertSourceBatch(normalizedProxies, createName, source, batchId, nowIso) {
        const tx = this.db.transaction((items) => {
            let inserted = 0;
            let touched = 0;
            for (const item of items) {
                const uniqueKey = `${item.ip}:${item.port}:${item.protocol}`;
                const existing = this.getProxyByKey(uniqueKey);
                if (existing) {
                    this.touchProxyStmt.run({
                        id: existing.id,
                        source,
                        batch_id: batchId,
                        now: nowIso,
                    });
                    touched += 1;
                    continue;
                }

                this.insertProxyStmt.run({
                    unique_key: uniqueKey,
                    ip: item.ip,
                    port: item.port,
                    protocol: item.protocol,
                    source,
                    batch_id: batchId,
                    display_name: createName(),
                    now: nowIso,
                });
                inserted += 1;
            }
            return { inserted, touched };
        });

        return tx(normalizedProxies);
    }

    listProxiesForValidation(limit) {
        return this.db.prepare(`
            SELECT * FROM proxies
            WHERE lifecycle != 'retired'
            ORDER BY COALESCE(last_checked_at, '1970-01-01T00:00:00.000Z') ASC, updated_at ASC
            LIMIT ?
        `).all(limit);
    }

    listProxiesForStateReview(limit) {
        return this.db.prepare(`
            SELECT * FROM proxies
            WHERE lifecycle IN ('active', 'reserve', 'candidate')
            ORDER BY updated_at ASC
            LIMIT ?
        `).all(limit);
    }

    updateProxyById(id, updates) {
        const keys = Object.keys(updates);
        if (keys.length === 0) return;

        const clauses = keys.map((key) => `${key} = @${key}`).join(', ');
        const stmt = this.db.prepare(`UPDATE proxies SET ${clauses}, updated_at = @updated_at WHERE id = @id`);
        stmt.run({ id, updated_at: updates.updated_at || new Date().toISOString(), ...updates });
    }

    insertProxyEvent(record) {
        this.insertEventStmt.run({
            timestamp: record.timestamp,
            proxy_id: record.proxy_id ?? null,
            display_name: record.display_name ?? null,
            event_type: record.event_type,
            level: record.level || 'info',
            message: record.message,
            details_json: JSON.stringify(record.details || {}),
        });
    }

    insertRuntimeLog(record) {
        this.insertRuntimeLogStmt.run({
            timestamp: record.timestamp,
            event: record.event,
            proxy_name: record.proxy_name || '-',
            ip_source: record.ip_source || '-',
            stage: record.stage || '-',
            result: record.result || '-',
            duration_ms: Number.isFinite(record.duration_ms) ? record.duration_ms : null,
            reason: record.reason || '-',
            action: record.action || '-',
            details_json: JSON.stringify(record.details || {}),
        });
    }

    upsertHonor(record) {
        this.db.prepare(`
            INSERT INTO honors (proxy_id, display_name, honor_type, reason, awarded_at, active)
            VALUES (@proxy_id, @display_name, @honor_type, @reason, @awarded_at, 1)
            ON CONFLICT(proxy_id, honor_type) DO UPDATE SET
                display_name = excluded.display_name,
                reason = excluded.reason,
                active = 1
        `).run({
            proxy_id: record.proxy_id,
            display_name: record.display_name,
            honor_type: record.honor_type,
            reason: record.reason || '',
            awarded_at: record.awarded_at,
        });
    }

    refreshHonorActive(proxyId, activeTypes) {
        const tx = this.db.transaction(() => {
            this.db.prepare('UPDATE honors SET active = 0 WHERE proxy_id = ?').run(proxyId);
            if (activeTypes.length > 0) {
                const stmt = this.db.prepare('UPDATE honors SET active = 1 WHERE proxy_id = ? AND honor_type = ?');
                for (const honorType of activeTypes) {
                    stmt.run(proxyId, honorType);
                }
            }
        });
        tx();
    }

    insertRetirement(record) {
        this.db.prepare(`
            INSERT INTO retirements (proxy_id, display_name, retired_type, reason, retired_at)
            VALUES (@proxy_id, @display_name, @retired_type, @reason, @retired_at)
        `).run({
            proxy_id: record.proxy_id,
            display_name: record.display_name,
            retired_type: record.retired_type,
            reason: record.reason || '',
            retired_at: record.retired_at,
        });
    }

    insertPoolSnapshot(snapshot) {
        this.db.prepare(`
            INSERT INTO pool_snapshots (
                timestamp, workers_total, workers_busy, queue_size, completed_tasks, failed_tasks, restarted_workers,
                source_distribution_json, rank_distribution_json, lifecycle_distribution_json
            ) VALUES (
                @timestamp, @workers_total, @workers_busy, @queue_size, @completed_tasks, @failed_tasks, @restarted_workers,
                @source_distribution_json, @rank_distribution_json, @lifecycle_distribution_json
            )
        `).run({
            timestamp: snapshot.timestamp,
            workers_total: snapshot.workers_total,
            workers_busy: snapshot.workers_busy,
            queue_size: snapshot.queue_size,
            completed_tasks: snapshot.completed_tasks,
            failed_tasks: snapshot.failed_tasks,
            restarted_workers: snapshot.restarted_workers,
            source_distribution_json: JSON.stringify(snapshot.source_distribution || []),
            rank_distribution_json: JSON.stringify(snapshot.rank_distribution || []),
            lifecycle_distribution_json: JSON.stringify(snapshot.lifecycle_distribution || []),
        });

        const retentionMs = this.config.storage.snapshotRetentionDays * 24 * 3600 * 1000;
        if (retentionMs <= 0) {
            // Keep at least the latest snapshot to avoid empty status panels.
            this.db.prepare(`
                DELETE FROM pool_snapshots
                WHERE id != (SELECT id FROM pool_snapshots ORDER BY id DESC LIMIT 1)
            `).run();
            return;
        }

        const cutoffIso = new Date(Date.now() - retentionMs).toISOString();
        this.db.prepare('DELETE FROM pool_snapshots WHERE timestamp < ?').run(cutoffIso);
    }

    getRuntimeLogs(limit = 200) {
        return this.db.prepare(`
            SELECT id, timestamp, event, proxy_name, ip_source, stage, result, duration_ms, reason, action
            FROM runtime_logs
            ORDER BY id DESC
            LIMIT ?
        `).all(limit);
    }

    getEvents(limit = 200) {
        return this.db.prepare(`
            SELECT id, timestamp, display_name, event_type, level, message, details_json
            FROM proxy_events
            ORDER BY id DESC
            LIMIT ?
        `).all(limit);
    }

    getProxyList({ limit = 200, rank, lifecycle } = {}) {
        const clauses = [];
        const params = {};

        if (rank) {
            clauses.push('rank = @rank');
            params.rank = rank;
        }
        if (lifecycle) {
            clauses.push('lifecycle = @lifecycle');
            params.lifecycle = lifecycle;
        }

        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        return this.db.prepare(`
            SELECT id, display_name, ip, port, protocol, source, lifecycle, rank,
                service_hours, rank_service_hours, combat_points, health_score, discipline_score,
                success_count, block_count, timeout_count, network_error_count,
                total_samples, retired_type, is_applied, updated_at, last_checked_at
            FROM proxies
            ${where}
            ORDER BY updated_at DESC
            LIMIT @limit
        `).all({ ...params, limit });
    }

    getRankBoard() {
        return this.db.prepare(`
            SELECT rank, COUNT(*) AS count,
                ROUND(AVG(health_score), 2) AS avgHealth,
                ROUND(AVG(combat_points), 2) AS avgCombat
            FROM proxies
            GROUP BY rank
            ORDER BY CASE rank
                WHEN '新兵' THEN 1
                WHEN '列兵' THEN 2
                WHEN '士官' THEN 3
                WHEN '尉官' THEN 4
                WHEN '王牌' THEN 5
                ELSE 6 END
        `).all();
    }

    getHonors(limit = 100) {
        return this.db.prepare(`
            SELECT id, display_name, honor_type, reason, awarded_at, active
            FROM honors
            ORDER BY awarded_at DESC
            LIMIT ?
        `).all(limit);
    }

    getRetirements(limit = 100) {
        return this.db.prepare(`
            SELECT id, display_name, retired_type, reason, retired_at
            FROM retirements
            ORDER BY retired_at DESC
            LIMIT ?
        `).all(limit);
    }

    getSourceDistribution() {
        return this.db.prepare(`
            SELECT source, COUNT(*) AS count
            FROM proxies
            GROUP BY source
            ORDER BY count DESC
        `).all();
    }

    getLifecycleDistribution() {
        return this.db.prepare(`
            SELECT lifecycle, COUNT(*) AS count
            FROM proxies
            GROUP BY lifecycle
        `).all();
    }

    getLatestSnapshot() {
        const row = this.db.prepare('SELECT * FROM pool_snapshots ORDER BY id DESC LIMIT 1').get();
        if (!row) return null;
        return {
            ...row,
            source_distribution: JSON.parse(row.source_distribution_json || '[]'),
            rank_distribution: JSON.parse(row.rank_distribution_json || '[]'),
            lifecycle_distribution: JSON.parse(row.lifecycle_distribution_json || '[]'),
        };
    }
}

module.exports = {
    ProxyHubDb,
};

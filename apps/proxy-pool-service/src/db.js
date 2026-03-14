const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

// 0000_ensureDirForFile_确保目录文件逻辑
function ensureDirForFile(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

// 0190_parseJsonArray_解析JSON数组逻辑
function parseJsonArray(raw) {
    try {
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

class ProxyHubDb {
    // 0001_constructor_初始化实例逻辑
    constructor(config) {
        this.config = config;
        this.dbPath = path.resolve(process.cwd(), config.storage.dbPath);
        ensureDirForFile(this.dbPath);
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.init();
    }

    // 0002_init_初始化逻辑
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
                last_validation_at TEXT,
                last_validation_ok INTEGER,
                last_validation_reason TEXT,
                last_validation_latency_ms INTEGER,
                last_battle_checked_at TEXT,
                last_battle_outcome TEXT,
                battle_success_count INTEGER NOT NULL DEFAULT 0,
                battle_fail_count INTEGER NOT NULL DEFAULT 0,
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

            CREATE TABLE IF NOT EXISTS battle_test_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                proxy_id INTEGER NOT NULL,
                stage TEXT NOT NULL,
                target TEXT NOT NULL,
                outcome TEXT NOT NULL,
                status_code INTEGER,
                latency_ms INTEGER,
                reason TEXT,
                details_json TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY(proxy_id) REFERENCES proxies(id)
            );

            CREATE INDEX IF NOT EXISTS idx_battle_test_runs_time
            ON battle_test_runs(timestamp DESC);

            CREATE INDEX IF NOT EXISTS idx_battle_test_runs_proxy_stage
            ON battle_test_runs(proxy_id, stage, timestamp DESC);
        `);

        this.ensureProxyColumns();
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_proxies_last_validation
            ON proxies(last_validation_at);

            CREATE INDEX IF NOT EXISTS idx_proxies_last_battle
            ON proxies(last_battle_checked_at);
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

        this.insertBattleTestRunStmt = this.db.prepare(`
            INSERT INTO battle_test_runs (
                timestamp, proxy_id, stage, target, outcome, status_code, latency_ms, reason, details_json
            ) VALUES (
                @timestamp, @proxy_id, @stage, @target, @outcome, @status_code, @latency_ms, @reason, @details_json
            )
        `);
    }

    // 0191_ensureProxyColumns_确保代理列逻辑
    ensureProxyColumns() {
        const rows = this.db.prepare('PRAGMA table_info(proxies)').all();
        const columns = new Set(rows.map((row) => row.name));
        const requiredColumns = [
            { name: 'last_validation_at', sql: 'TEXT' },
            { name: 'last_validation_ok', sql: 'INTEGER' },
            { name: 'last_validation_reason', sql: 'TEXT' },
            { name: 'last_validation_latency_ms', sql: 'INTEGER' },
            { name: 'last_battle_checked_at', sql: 'TEXT' },
            { name: 'last_battle_outcome', sql: 'TEXT' },
            { name: 'battle_success_count', sql: 'INTEGER NOT NULL DEFAULT 0' },
            { name: 'battle_fail_count', sql: 'INTEGER NOT NULL DEFAULT 0' },
        ];

        for (const column of requiredColumns) {
            if (!columns.has(column.name)) {
                this.db.exec(`ALTER TABLE proxies ADD COLUMN ${column.name} ${column.sql}`);
            }
        }
    }

    // 0003_close_关闭逻辑
    close() {
        this.db.close();
    }

    // 0004_isDisplayNameAvailable_判断名称可用逻辑
    isDisplayNameAvailable(displayName) {
        const row = this.db.prepare('SELECT id FROM proxies WHERE display_name = ?').get(displayName);
        return !row;
    }

    // 0005_getProxyByKey_获取代理逻辑
    getProxyByKey(uniqueKey) {
        return this.db.prepare('SELECT * FROM proxies WHERE unique_key = ?').get(uniqueKey);
    }

    // 0006_getProxyById_获取代理标识逻辑
    getProxyById(id) {
        return this.db.prepare('SELECT * FROM proxies WHERE id = ?').get(id);
    }

    // 0007_upsertSourceBatch_插入更新来源批次逻辑
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

    // 0008_listProxiesForValidation_列出校验逻辑
    listProxiesForValidation(limit) {
        return this.db.prepare(`
            SELECT * FROM proxies
            WHERE lifecycle != 'retired'
            ORDER BY COALESCE(last_validation_at, '1970-01-01T00:00:00.000Z') ASC, updated_at ASC
            LIMIT ?
        `).all(limit);
    }

    // 0192_listProxiesForBattleL1_列出战场L1候选逻辑
    listProxiesForBattleL1(limit, candidateQuota = 0.15) {
        const safeLimit = Math.max(0, Number(limit) || 0);
        if (safeLimit === 0) return [];

        const normalizedQuota = Math.max(0, Math.min(1, Number(candidateQuota) || 0));
        const candidateLimit = Math.min(safeLimit, Math.max(0, Math.floor(safeLimit * normalizedQuota)));
        const coreLimit = Math.max(0, safeLimit - candidateLimit);

        const nonCandidate = this.db.prepare(`
            SELECT * FROM proxies
            WHERE lifecycle IN ('active', 'reserve')
            ORDER BY
                COALESCE(last_battle_checked_at, '1970-01-01T00:00:00.000Z') ASC,
                CASE lifecycle WHEN 'active' THEN 0 WHEN 'reserve' THEN 1 ELSE 2 END ASC,
                updated_at ASC
            LIMIT ?
        `).all(coreLimit);

        const candidates = this.db.prepare(`
            SELECT * FROM proxies
            WHERE lifecycle = 'candidate'
            ORDER BY COALESCE(last_battle_checked_at, '1970-01-01T00:00:00.000Z') ASC, updated_at ASC
            LIMIT ?
        `).all(candidateLimit);

        const merged = [...nonCandidate, ...candidates];
        if (merged.length >= safeLimit) {
            return merged.slice(0, safeLimit);
        }

        const filled = this.db.prepare(`
            SELECT * FROM proxies
            WHERE lifecycle != 'retired'
              AND id NOT IN (${merged.length > 0 ? merged.map(() => '?').join(',') : '-1'})
            ORDER BY
                COALESCE(last_battle_checked_at, '1970-01-01T00:00:00.000Z') ASC,
                CASE lifecycle WHEN 'active' THEN 0 WHEN 'reserve' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END ASC,
                updated_at ASC
            LIMIT ?
        `).all(...merged.map((item) => item.id), safeLimit - merged.length);

        return [...merged, ...filled];
    }

    // 0193_listProxiesForBattleL2_列出战场L2候选逻辑
    listProxiesForBattleL2(limit, lookbackMinutes = 10) {
        const safeLimit = Math.max(0, Number(limit) || 0);
        if (safeLimit === 0) return [];

        const cutoffIso = new Date(Date.now() - Math.max(1, lookbackMinutes) * 60_000).toISOString();
        return this.db.prepare(`
            SELECT p.*
            FROM proxies p
            INNER JOIN (
                SELECT proxy_id, MAX(timestamp) AS latest_l1_success_at
                FROM battle_test_runs
                WHERE stage = 'l1' AND outcome = 'success' AND timestamp >= ?
                GROUP BY proxy_id
            ) l1 ON l1.proxy_id = p.id
            WHERE p.lifecycle != 'retired'
            ORDER BY
                COALESCE(p.last_battle_checked_at, '1970-01-01T00:00:00.000Z') ASC,
                CASE p.lifecycle WHEN 'active' THEN 0 WHEN 'reserve' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END ASC,
                l1.latest_l1_success_at DESC
            LIMIT ?
        `).all(cutoffIso, safeLimit);
    }

    // 0009_listProxiesForStateReview_列出状态巡检逻辑
    listProxiesForStateReview(limit) {
        return this.db.prepare(`
            SELECT * FROM proxies
            WHERE lifecycle IN ('active', 'reserve', 'candidate')
            ORDER BY updated_at ASC
            LIMIT ?
        `).all(limit);
    }

    // 0010_updateProxyById_更新代理标识逻辑
    updateProxyById(id, updates) {
        const keys = Object.keys(updates);
        if (keys.length === 0) return;

        const clauses = keys.map((key) => `${key} = @${key}`).join(', ');
        const stmt = this.db.prepare(`UPDATE proxies SET ${clauses}, updated_at = @updated_at WHERE id = @id`);
        stmt.run({ id, updated_at: updates.updated_at || new Date().toISOString(), ...updates });
    }

    // 0011_insertProxyEvent_写入代理事件逻辑
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

    // 0012_insertRuntimeLog_写入运行时日志逻辑
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

    // 0013_upsertHonor_插入更新荣誉逻辑
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

    // 0014_refreshHonorActive_刷新荣誉激活逻辑
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

    // 0015_insertRetirement_写入退伍逻辑
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

    // 0016_insertPoolSnapshot_写入线程池快照逻辑
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

    // 0194_insertBattleTestRun_写入战场测试逻辑
    insertBattleTestRun(record) {
        this.insertBattleTestRunStmt.run({
            timestamp: record.timestamp,
            proxy_id: record.proxy_id,
            stage: record.stage,
            target: record.target,
            outcome: record.outcome,
            status_code: Number.isFinite(record.status_code) ? record.status_code : null,
            latency_ms: Number.isFinite(record.latency_ms) ? record.latency_ms : null,
            reason: record.reason || '',
            details_json: JSON.stringify(record.details || {}),
        });
    }

    // 0185_getRuntimeLogs_获取运行时日志逻辑
    getRuntimeLogs(limit = 200) {
        return this.db.prepare(`
            SELECT id, timestamp, event, proxy_name, ip_source, stage, result, duration_ms, reason, action
            FROM runtime_logs
            ORDER BY id DESC
            LIMIT ?
        `).all(limit);
    }

    // 0186_getEvents_获取事件逻辑
    getEvents(limit = 200) {
        return this.db.prepare(`
            SELECT id, timestamp, display_name, event_type, level, message, details_json
            FROM proxy_events
            ORDER BY id DESC
            LIMIT ?
        `).all(limit);
    }

    // 0187_getProxyList_获取代理列表逻辑
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
                total_samples, retired_type, is_applied, updated_at, last_checked_at,
                last_validation_at, last_validation_ok, last_validation_reason, last_validation_latency_ms,
                last_battle_checked_at, last_battle_outcome, battle_success_count, battle_fail_count
            FROM proxies
            ${where}
            ORDER BY updated_at DESC
            LIMIT @limit
        `).all({ ...params, limit });
    }

    // 0017_getRankBoard_获取军衔看板逻辑
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

    // 0188_getHonors_获取荣誉逻辑
    getHonors(limit = 100) {
        return this.db.prepare(`
            SELECT id, display_name, honor_type, reason, awarded_at, active
            FROM honors
            ORDER BY awarded_at DESC
            LIMIT ?
        `).all(limit);
    }

    // 0189_getRetirements_获取退伍记录逻辑
    getRetirements(limit = 100) {
        return this.db.prepare(`
            SELECT id, display_name, retired_type, reason, retired_at
            FROM retirements
            ORDER BY retired_at DESC
            LIMIT ?
        `).all(limit);
    }

    // 0018_getSourceDistribution_获取来源分布逻辑
    getSourceDistribution() {
        return this.db.prepare(`
            SELECT source, COUNT(*) AS count
            FROM proxies
            GROUP BY source
            ORDER BY count DESC
        `).all();
    }

    // 0019_getLifecycleDistribution_获取分布逻辑
    getLifecycleDistribution() {
        return this.db.prepare(`
            SELECT lifecycle, COUNT(*) AS count
            FROM proxies
            GROUP BY lifecycle
        `).all();
    }

    // 0020_getLatestSnapshot_获取最新快照逻辑
    getLatestSnapshot() {
        const row = this.db.prepare('SELECT * FROM pool_snapshots ORDER BY id DESC LIMIT 1').get();
        if (!row) return null;
        return {
            ...row,
            source_distribution: parseJsonArray(row.source_distribution_json),
            rank_distribution: parseJsonArray(row.rank_distribution_json),
            lifecycle_distribution: parseJsonArray(row.lifecycle_distribution_json),
        };
    }

    // 0195_getBattleTestRuns_获取战场测试逻辑
    getBattleTestRuns(limit = 200) {
        return this.db.prepare(`
            SELECT id, timestamp, proxy_id, stage, target, outcome, status_code, latency_ms, reason, details_json
            FROM battle_test_runs
            ORDER BY id DESC
            LIMIT ?
        `).all(limit);
    }
}

module.exports = {
    ProxyHubDb,
};

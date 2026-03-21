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

// 0196_parseJsonObject_解析JSON对象逻辑
function parseJsonObject(raw) {
    try {
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

// 0262_normalizeIso_规范化时间戳逻辑
function normalizeIso(value, fallback = new Date().toISOString()) {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
        return fallback;
    }
    return new Date(ms).toISOString();
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
                service_branch TEXT NOT NULL DEFAULT '陆军',
                branch_fail_streak INTEGER NOT NULL DEFAULT 0,
                native_place TEXT NOT NULL DEFAULT '未知',
                native_country TEXT,
                native_city TEXT,
                native_provider TEXT,
                native_resolved_at TEXT,
                native_lookup_status TEXT NOT NULL DEFAULT 'pending',
                native_next_retry_at TEXT,
                native_lookup_raw_json TEXT,
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
                ip_value_score REAL NOT NULL DEFAULT 0,
                ip_value_breakdown_json TEXT NOT NULL DEFAULT '{}',
                retired_type TEXT,
                promotion_protect_until TEXT,
                recent_window_json TEXT NOT NULL DEFAULT '[]',
                honor_history_json TEXT NOT NULL DEFAULT '[]',
                honor_active_json TEXT NOT NULL DEFAULT '[]',
                lifecycle_changed_at TEXT,
                last_l1_success_at TEXT,
                backoff_until TEXT,
                backoff_reason TEXT,
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

            CREATE TABLE IF NOT EXISTS rollout_switch_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                mode TEXT NOT NULL DEFAULT 'SAFE',
                stable_since TEXT,
                cooldown_until TEXT,
                last_tick_at TEXT,
                last_error TEXT,
                lease_owner TEXT,
                lease_until TEXT,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS rollout_switch_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                trigger TEXT NOT NULL,
                action TEXT NOT NULL,
                mode_before TEXT,
                mode_after TEXT,
                patch_json TEXT NOT NULL DEFAULT '{}',
                details_json TEXT NOT NULL DEFAULT '{}'
            );

            CREATE INDEX IF NOT EXISTS idx_rollout_switch_events_time
            ON rollout_switch_events(timestamp DESC);
        `);

        this.ensureProxyColumns();
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_proxies_last_validation
            ON proxies(last_validation_at);

            CREATE INDEX IF NOT EXISTS idx_proxies_last_battle
            ON proxies(last_battle_checked_at);

            CREATE INDEX IF NOT EXISTS idx_proxies_backoff_until
            ON proxies(backoff_until);
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
                lifecycle, rank, lifecycle_changed_at, created_at, updated_at, last_seen_at
            ) VALUES (
                @unique_key, @ip, @port, @protocol, @source, @batch_id, @display_name,
                'candidate', '新兵', @now, @now, @now, @now
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

        this.insertRolloutSwitchEventStmt = this.db.prepare(`
            INSERT INTO rollout_switch_events (
                timestamp, trigger, action, mode_before, mode_after, patch_json, details_json
            ) VALUES (
                @timestamp, @trigger, @action, @mode_before, @mode_after, @patch_json, @details_json
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
            { name: 'ip_value_score', sql: 'REAL NOT NULL DEFAULT 0' },
            { name: 'ip_value_breakdown_json', sql: "TEXT NOT NULL DEFAULT '{}'" },
            { name: 'lifecycle_changed_at', sql: 'TEXT' },
            { name: 'last_l1_success_at', sql: 'TEXT' },
            { name: 'backoff_until', sql: 'TEXT' },
            { name: 'backoff_reason', sql: 'TEXT' },
            { name: 'service_branch', sql: "TEXT NOT NULL DEFAULT '陆军'" },
            { name: 'branch_fail_streak', sql: 'INTEGER NOT NULL DEFAULT 0' },
            { name: 'native_place', sql: "TEXT NOT NULL DEFAULT '未知'" },
            { name: 'native_country', sql: 'TEXT' },
            { name: 'native_city', sql: 'TEXT' },
            { name: 'native_provider', sql: 'TEXT' },
            { name: 'native_resolved_at', sql: 'TEXT' },
            { name: 'native_lookup_status', sql: "TEXT NOT NULL DEFAULT 'pending'" },
            { name: 'native_next_retry_at', sql: 'TEXT' },
            { name: 'native_lookup_raw_json', sql: 'TEXT' },
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
    upsertSourceBatch(normalizedProxies, createName, source, batchId, nowIso, options = {}) {
        const allowInsert = options.allowInsert !== false;
        const tx = this.db.transaction((items) => {
            let inserted = 0;
            let touched = 0;
            let skipped = 0;
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

                if (!allowInsert) {
                    skipped += 1;
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
            return { inserted, touched, skipped };
        });

        return tx(normalizedProxies);
    }

    // 0214_renameAllDisplayNames_全量重命名逻辑
    renameAllDisplayNames(options = {}) {
        const dryRun = options.dryRun !== false;
        const sample = Math.max(1, Math.min(200, Number(options.sample) || 20));
        const nowIso = options.nowIso || new Date().toISOString();
        const generateName = options.generateName;
        const debugFailAfterProxyUpdate = options.debugFailAfterProxyUpdate === true;

        if (typeof generateName !== 'function') {
            throw new Error('rename-generate-name-required');
        }

        const startedAt = Date.now();
        const proxies = this.db.prepare(`
            SELECT id, display_name
            FROM proxies
            ORDER BY id ASC
        `).all();

        const usedNames = new Set();
        const mappings = [];
        for (const proxy of proxies) {
            const newName = generateName((candidate) => !usedNames.has(candidate));
            if (typeof newName !== 'string' || newName.trim().length === 0) {
                throw new Error('rename-generated-name-invalid');
            }
            usedNames.add(newName);
            mappings.push({
                id: proxy.id,
                oldName: proxy.display_name,
                newName,
            });
        }

        const changedMappings = mappings.filter((item) => item.oldName !== item.newName);
        const summary = {
            total: mappings.length,
            changed: changedMappings.length,
            unchanged: mappings.length - changedMappings.length,
        };

        if (dryRun) {
            return {
                dryRun: true,
                applied: false,
                rolledBack: false,
                summary,
                sampleMappings: changedMappings.slice(0, sample),
                tableUpdates: {
                    proxies: 0,
                    proxy_events: 0,
                    honors: 0,
                    retirements: 0,
                    runtime_logs: 0,
                },
                durationMs: Date.now() - startedAt,
            };
        }

        const tx = this.db.transaction((rows) => {
            const tableUpdates = {
                proxies: 0,
                proxy_events: 0,
                honors: 0,
                retirements: 0,
                runtime_logs: 0,
            };

            const updateProxyStmt = this.db.prepare(`
                UPDATE proxies
                SET display_name = @new_name, updated_at = @now
                WHERE id = @id
            `);
            const updateEventsStmt = this.db.prepare(`
                UPDATE proxy_events
                SET display_name = @new_name
                WHERE proxy_id = @id
                   OR (proxy_id IS NULL AND display_name = @old_name)
            `);
            const updateHonorsStmt = this.db.prepare(`
                UPDATE honors
                SET display_name = @new_name
                WHERE proxy_id = @id
            `);
            const updateRetirementsStmt = this.db.prepare(`
                UPDATE retirements
                SET display_name = @new_name
                WHERE proxy_id = @id
            `);
            const updateRuntimeLogsStmt = this.db.prepare(`
                UPDATE runtime_logs
                SET proxy_name = @new_name
                WHERE proxy_name = @old_name
            `);

            for (const row of rows) {
                tableUpdates.proxies += updateProxyStmt.run({
                    id: row.id,
                    new_name: row.newName,
                    now: nowIso,
                }).changes;
                if (debugFailAfterProxyUpdate) {
                    throw new Error('rename-debug-failure-after-proxy-update');
                }
                tableUpdates.proxy_events += updateEventsStmt.run({
                    id: row.id,
                    new_name: row.newName,
                    old_name: row.oldName,
                }).changes;
                tableUpdates.honors += updateHonorsStmt.run({
                    id: row.id,
                    new_name: row.newName,
                }).changes;
                tableUpdates.retirements += updateRetirementsStmt.run({
                    id: row.id,
                    new_name: row.newName,
                }).changes;
                tableUpdates.runtime_logs += updateRuntimeLogsStmt.run({
                    old_name: row.oldName,
                    new_name: row.newName,
                }).changes;
            }

            const uniqueness = this.db.prepare(`
                SELECT COUNT(*) AS total, COUNT(DISTINCT display_name) AS unique_total
                FROM proxies
            `).get();
            if (uniqueness.total !== uniqueness.unique_total) {
                throw new Error('rename-uniqueness-check-failed');
            }

            const oldPatternCounts = {
                proxies: this.db.prepare(`
                    SELECT COUNT(*) AS c
                    FROM proxies
                    WHERE display_name GLOB '*-*'
                       OR display_name GLOB '*[0-9]*'
                `).get().c,
                proxy_events: this.db.prepare(`
                    SELECT COUNT(*) AS c
                    FROM proxy_events
                    WHERE display_name IS NOT NULL
                      AND (display_name GLOB '*-*' OR display_name GLOB '*[0-9]*')
                `).get().c,
                honors: this.db.prepare(`
                    SELECT COUNT(*) AS c
                    FROM honors
                    WHERE display_name GLOB '*-*'
                       OR display_name GLOB '*[0-9]*'
                `).get().c,
                retirements: this.db.prepare(`
                    SELECT COUNT(*) AS c
                    FROM retirements
                    WHERE display_name GLOB '*-*'
                       OR display_name GLOB '*[0-9]*'
                `).get().c,
                runtime_logs: this.db.prepare(`
                    SELECT COUNT(*) AS c
                    FROM runtime_logs
                    WHERE proxy_name != '-'
                      AND (proxy_name GLOB '*-*' OR proxy_name GLOB '*[0-9]*')
                `).get().c,
            };

            for (const key of Object.keys(oldPatternCounts)) {
                if (oldPatternCounts[key] > 0) {
                    throw new Error(`rename-old-pattern-remains:${key}:${oldPatternCounts[key]}`);
                }
            }

            return {
                tableUpdates,
                oldPatternCounts,
            };
        });

        const applied = tx(changedMappings);
        return {
            dryRun: false,
            applied: true,
            rolledBack: false,
            summary,
            sampleMappings: changedMappings.slice(0, sample),
            tableUpdates: applied.tableUpdates,
            oldPatternCounts: applied.oldPatternCounts,
            durationMs: Date.now() - startedAt,
        };
    }

    // 0008_listProxiesForValidation_列出校验逻辑
    listProxiesForValidation(limit, nowIso = new Date().toISOString()) {
        const safeNowIso = normalizeIso(nowIso);
        return this.db.prepare(`
            SELECT * FROM proxies
            WHERE lifecycle != 'retired'
              AND (backoff_until IS NULL OR backoff_until <= ?)
            ORDER BY COALESCE(last_validation_at, '1970-01-01T00:00:00.000Z') ASC, updated_at ASC
            LIMIT ?
        `).all(safeNowIso, limit);
    }

    // 0192_normalizeLifecycleQuota_规范化战场配额逻辑
    normalizeLifecycleQuota(quota) {
        if (quota != null && typeof quota === 'object' && !Array.isArray(quota)) {
            const active = Math.max(0, Number(quota.active) || 0);
            const reserve = Math.max(0, Number(quota.reserve) || 0);
            const candidate = Math.max(0, Number(quota.candidate) || 0);
            const sum = active + reserve + candidate;
            if (sum > 0) {
                return {
                    active: active / sum,
                    reserve: reserve / sum,
                    candidate: candidate / sum,
                };
            }
        }

        const normalizedCandidate = Math.max(0, Math.min(1, Number(quota) || 0));
        const nonCandidate = 1 - normalizedCandidate;
        return {
            active: nonCandidate * 0.65,
            reserve: nonCandidate * 0.35,
            candidate: normalizedCandidate,
        };
    }

    // 0193_pickQuotaCounts_分配候选数量逻辑
    pickQuotaCounts(limit, quota) {
        const keys = ['active', 'reserve', 'candidate'];
        const raw = keys.map((key) => ({
            key,
            exact: quota[key] * limit,
        }));
        const counts = {};
        let used = 0;

        for (const item of raw) {
            const floor = Math.floor(item.exact);
            counts[item.key] = floor;
            used += floor;
        }

        let remain = Math.max(0, limit - used);
        const byFraction = raw
            .map((item) => ({ key: item.key, fraction: item.exact - Math.floor(item.exact) }))
            .sort((a, b) => b.fraction - a.fraction);
        let idx = 0;
        while (remain > 0 && byFraction.length > 0) {
            counts[byFraction[idx % byFraction.length].key] += 1;
            remain -= 1;
            idx += 1;
        }

        return counts;
    }

    // 0194_listProxiesForBattleL1_列出战场L1候选逻辑
    listProxiesForBattleL1(limit, candidateQuota = 0.15, nowIso = new Date().toISOString()) {
        const safeLimit = Math.max(0, Number(limit) || 0);
        if (safeLimit === 0) return [];
        const safeNowIso = normalizeIso(nowIso);

        const normalizedQuota = this.normalizeLifecycleQuota(candidateQuota);
        const quotaCounts = this.pickQuotaCounts(safeLimit, normalizedQuota);

        const actives = this.db.prepare(`
            SELECT * FROM proxies
            WHERE lifecycle = 'active'
              AND (backoff_until IS NULL OR backoff_until <= ?)
            ORDER BY
                COALESCE(last_battle_checked_at, '1970-01-01T00:00:00.000Z') ASC,
                updated_at ASC
            LIMIT ?
        `).all(safeNowIso, quotaCounts.active);

        const reserves = this.db.prepare(`
            SELECT * FROM proxies
            WHERE lifecycle = 'reserve'
              AND (backoff_until IS NULL OR backoff_until <= ?)
            ORDER BY
                COALESCE(last_battle_checked_at, '1970-01-01T00:00:00.000Z') ASC,
                updated_at ASC
            LIMIT ?
        `).all(safeNowIso, quotaCounts.reserve);

        const candidates = this.db.prepare(`
            SELECT * FROM proxies
            WHERE lifecycle = 'candidate'
              AND (backoff_until IS NULL OR backoff_until <= ?)
            ORDER BY COALESCE(last_battle_checked_at, '1970-01-01T00:00:00.000Z') ASC, updated_at ASC
            LIMIT ?
        `).all(safeNowIso, quotaCounts.candidate);

        const merged = [...actives, ...reserves, ...candidates];
        if (merged.length >= safeLimit) {
            return merged.slice(0, safeLimit);
        }

        const filled = this.db.prepare(`
            SELECT * FROM proxies
            WHERE lifecycle != 'retired'
              AND (backoff_until IS NULL OR backoff_until <= ?)
              AND id NOT IN (${merged.length > 0 ? merged.map(() => '?').join(',') : '-1'})
            ORDER BY
                COALESCE(last_battle_checked_at, '1970-01-01T00:00:00.000Z') ASC,
                CASE lifecycle WHEN 'active' THEN 0 WHEN 'reserve' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END ASC,
                updated_at ASC
            LIMIT ?
        `).all(safeNowIso, ...merged.map((item) => item.id), safeLimit - merged.length);

        return [...merged, ...filled];
    }

    // 0195_listProxiesForBattleL2_列出战场L2候选逻辑
    listProxiesForBattleL2(limit, lookbackMinutes = 10, nowIso = new Date().toISOString()) {
        const safeLimit = Math.max(0, Number(limit) || 0);
        if (safeLimit === 0) return [];
        const safeNowIso = normalizeIso(nowIso);

        const cutoffIso = new Date(Date.parse(safeNowIso) - Math.max(1, lookbackMinutes) * 60_000).toISOString();
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
              AND (p.backoff_until IS NULL OR p.backoff_until <= ?)
            ORDER BY
                COALESCE(p.last_battle_checked_at, '1970-01-01T00:00:00.000Z') ASC,
                CASE p.lifecycle WHEN 'active' THEN 0 WHEN 'reserve' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END ASC,
                l1.latest_l1_success_at DESC
            LIMIT ?
        `).all(cutoffIso, safeNowIso, safeLimit);
    }

    // 0276_listProxiesForBattleL3_列出战场L3候选逻辑
    listProxiesForBattleL3(limit, lookbackMinutes = 20, allowedProtocols = [], nowIso = new Date().toISOString()) {
        const safeLimit = Math.max(0, Number(limit) || 0);
        if (safeLimit === 0) return [];
        const safeNowIso = normalizeIso(nowIso);

        const cutoffIso = new Date(Date.parse(safeNowIso) - Math.max(1, Number(lookbackMinutes) || 1) * 60_000).toISOString();
        const protocolList = Array.isArray(allowedProtocols)
            ? allowedProtocols
                .map((item) => String(item || '').trim().toLowerCase())
                .filter((item) => item.length > 0)
            : [];
        const protocolFilterSql = protocolList.length > 0
            ? ` AND p.protocol IN (${protocolList.map(() => '?').join(',')})`
            : '';

        return this.db.prepare(`
            SELECT p.*
            FROM proxies p
            INNER JOIN (
                SELECT proxy_id, MAX(timestamp) AS latest_l2_success_at
                FROM battle_test_runs
                WHERE stage = 'l2' AND outcome = 'success' AND timestamp >= ?
                GROUP BY proxy_id
            ) l2 ON l2.proxy_id = p.id
            WHERE p.lifecycle != 'retired'
              AND (p.backoff_until IS NULL OR p.backoff_until <= ?)
              ${protocolFilterSql}
            ORDER BY
                COALESCE(p.last_battle_checked_at, '1970-01-01T00:00:00.000Z') ASC,
                CASE p.lifecycle WHEN 'active' THEN 0 WHEN 'reserve' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END ASC,
                l2.latest_l2_success_at DESC
            LIMIT ?
        `).all(cutoffIso, safeNowIso, ...protocolList, safeLimit);
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

        const snapshotTs = Date.parse(snapshot.timestamp);
        const retentionBaseMs = Number.isFinite(snapshotTs) ? snapshotTs : Date.now();
        const cutoffIso = new Date(retentionBaseMs - retentionMs).toISOString();
        this.db.prepare('DELETE FROM pool_snapshots WHERE timestamp < ?').run(cutoffIso);
    }

    // 0196_insertBattleTestRun_写入战场测试逻辑
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

    // 0197_getActiveCount_获取active数量逻辑
    getActiveCount() {
        const row = this.db.prepare(`
            SELECT COUNT(*) AS c
            FROM proxies
            WHERE lifecycle = 'active'
        `).get();
        return row?.c || 0;
    }

    // 0254_getLifecycleCount_获取生命周期数量逻辑
    getLifecycleCount(lifecycle) {
        const row = this.db.prepare(`
            SELECT COUNT(*) AS c
            FROM proxies
            WHERE lifecycle = ?
        `).get(String(lifecycle || ''));
        return row?.c || 0;
    }

    // 0198_getBattleSuccessRateSince_获取阶段成功率逻辑
    getBattleSuccessRateSince(stage, sinceIso) {
        const row = this.db.prepare(`
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success
            FROM battle_test_runs
            WHERE stage = ?
              AND timestamp >= ?
        `).get(stage, sinceIso);

        const total = row?.total || 0;
        const success = row?.success || 0;
        return {
            stage,
            total,
            success,
            successRate: total > 0 ? success / total : 0,
        };
    }

    // 0255_getBattleDailySuccessRates_获取按日成功率逻辑
    getBattleDailySuccessRates(stage, days = 7, endIso = new Date().toISOString()) {
        const safeDays = Math.max(1, Number(days) || 7);
        const endAt = Date.parse(endIso);
        const startIso = new Date(endAt - safeDays * 24 * 60 * 60 * 1000).toISOString();
        const rows = this.db.prepare(`
            SELECT
                substr(timestamp, 1, 10) AS day,
                COUNT(*) AS total,
                SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success
            FROM battle_test_runs
            WHERE stage = ?
              AND timestamp >= ?
              AND timestamp <= ?
            GROUP BY day
            ORDER BY day ASC
        `).all(String(stage || ''), startIso, endIso);

        return rows.map((row) => {
            const total = Number(row.total) || 0;
            const success = Number(row.success) || 0;
            return {
                day: row.day,
                total,
                success,
                successRate: total > 0 ? success / total : 0,
            };
        });
    }

    // 0199_getRetirementsCountSince_获取区间退役数逻辑
    getRetirementsCountSince(sinceIso) {
        const row = this.db.prepare(`
            SELECT COUNT(*) AS c
            FROM retirements
            WHERE retired_at >= ?
        `).get(sinceIso);
        return row?.c || 0;
    }

    // 0200_getRetirementDailyCounts_获取按日退役分布逻辑
    getRetirementDailyCounts(days = 7, endIso = new Date().toISOString()) {
        const safeDays = Math.max(1, Number(days) || 7);
        const endAt = Date.parse(endIso);
        const startIso = new Date(endAt - safeDays * 24 * 60 * 60 * 1000).toISOString();
        return this.db.prepare(`
            SELECT substr(retired_at, 1, 10) AS day, COUNT(*) AS count
            FROM retirements
            WHERE retired_at >= ?
              AND retired_at <= ?
            GROUP BY day
            ORDER BY day ASC
        `).all(startIso, endIso);
    }

    // 0256_getLifecycleSnapshotMedian_获取生命周期快照中位数逻辑
    getLifecycleSnapshotMedian(lifecycle, days = 7, endIso = new Date().toISOString()) {
        const safeDays = Math.max(1, Number(days) || 7);
        const endAt = Date.parse(endIso);
        const startIso = new Date(endAt - safeDays * 24 * 60 * 60 * 1000).toISOString();
        const rows = this.db.prepare(`
            SELECT lifecycle_distribution_json
            FROM pool_snapshots
            WHERE timestamp >= ?
              AND timestamp <= ?
            ORDER BY timestamp ASC
        `).all(startIso, endIso);

        const lifecycleKey = String(lifecycle || '');
        const values = rows
            .map((row) => parseJsonArray(row.lifecycle_distribution_json))
            .map((items) => items.find((item) => String(item.lifecycle) === lifecycleKey))
            .map((item) => Number(item?.count))
            .filter((num) => Number.isFinite(num))
            .sort((a, b) => a - b);

        if (values.length === 0) return null;
        const mid = Math.floor(values.length / 2);
        if (values.length % 2 === 1) return values[mid];
        return (values[mid - 1] + values[mid]) / 2;
    }

    // 0257_listCandidatesForSweep_列出新兵清库存候选逻辑
    listCandidatesForSweep({
        nowIso = new Date().toISOString(),
        staleHours = 24,
        staleMinSamples = 3,
        timeoutHours = 72,
        limit = 2000,
    } = {}) {
        const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 2000));
        const safeStaleHours = Math.max(1, Number(staleHours) || 24);
        const safeTimeoutHours = Math.max(safeStaleHours, Number(timeoutHours) || 72);
        const safeMinSamples = Math.max(0, Number(staleMinSamples) || 3);

        const staleBeforeIso = new Date(Date.parse(nowIso) - safeStaleHours * 3_600_000).toISOString();
        const timeoutBeforeIso = new Date(Date.parse(nowIso) - safeTimeoutHours * 3_600_000).toISOString();

        const rows = this.db.prepare(`
            SELECT *
            FROM proxies
            WHERE lifecycle = 'candidate'
              AND (
                (created_at <= @stale_before AND total_samples < @stale_min_samples)
                OR created_at <= @timeout_before
              )
            ORDER BY created_at ASC
            LIMIT @limit
        `).all({
            stale_before: staleBeforeIso,
            stale_min_samples: safeMinSamples,
            timeout_before: timeoutBeforeIso,
            limit: safeLimit,
        });

        return rows.map((row) => {
            const createdAtMs = Date.parse(row.created_at);
            const ageHours = Number.isFinite(createdAtMs)
                ? (Date.parse(nowIso) - createdAtMs) / 3_600_000
                : Number.NaN;
            const isTimeout = Number.isFinite(ageHours) && ageHours >= safeTimeoutHours;
            return {
                ...row,
                sweep_reason: isTimeout ? 'stale_timeout' : 'stale_candidate',
                sweep_age_hours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(3)) : null,
            };
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
    getProxyList({ limit = 200, rank, lifecycle, serviceBranch, excludeRetired = false } = {}) {
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
        if (serviceBranch) {
            clauses.push('service_branch = @service_branch');
            params.service_branch = serviceBranch;
        }
        if (excludeRetired) {
            clauses.push("lifecycle != 'retired'");
        }

        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        return this.db.prepare(`
            SELECT id, display_name, ip, port, protocol, source, lifecycle, rank,
                service_branch, branch_fail_streak,
                native_place, native_country, native_city, native_provider, native_resolved_at,
                native_lookup_status, native_next_retry_at, native_lookup_raw_json,
                service_hours, rank_service_hours, combat_points, health_score, discipline_score,
                success_count, block_count, timeout_count, network_error_count,
                total_samples, retired_type, is_applied, updated_at, last_checked_at,
                last_validation_at, last_validation_ok, last_validation_reason, last_validation_latency_ms,
                last_battle_checked_at, last_battle_outcome, battle_success_count, battle_fail_count,
                lifecycle_changed_at, last_l1_success_at,
                ip_value_score, ip_value_breakdown_json
            FROM proxies
            ${where}
            ORDER BY updated_at DESC
            LIMIT @limit
        `).all({ ...params, limit });
    }

    // 0017_getRankBoard_获取军衔看板逻辑
    getRankBoard(options = {}) {
        const excludeRetired = options.excludeRetired === true;
        const where = excludeRetired ? "WHERE lifecycle != 'retired'" : '';
        return this.db.prepare(`
            SELECT rank, COUNT(*) AS count,
                ROUND(AVG(health_score), 2) AS avgHealth,
                ROUND(AVG(combat_points), 2) AS avgCombat,
                ROUND(AVG(ip_value_score), 2) AS avgValue
            FROM proxies
            ${where}
            GROUP BY rank
            ORDER BY CASE rank
                WHEN '新兵' THEN 1
                WHEN '列兵' THEN 2
                WHEN '士官' THEN 3
                WHEN '尉官' THEN 4
                WHEN '校官' THEN 5
                WHEN '将官' THEN 6
                WHEN '王牌' THEN 7
                ELSE 8 END
        `).all();
    }

    // 0197_getValueBoard_获取价值榜逻辑
    getValueBoard(limit = 100, lifecycle, options = {}) {
        const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
        const clauses = [];
        const params = { limit: safeLimit };
        const excludeRetired = options.excludeRetired === true;
        const serviceBranch = options.serviceBranch ? String(options.serviceBranch) : undefined;
        if (lifecycle) {
            clauses.push('lifecycle = @lifecycle');
            params.lifecycle = String(lifecycle);
        }
        if (serviceBranch) {
            clauses.push('service_branch = @service_branch');
            params.service_branch = serviceBranch;
        }
        if (excludeRetired) {
            clauses.push("lifecycle != 'retired'");
        }

        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = this.db.prepare(`
            SELECT
                p.id, p.display_name, p.ip, p.port, p.protocol, p.source, p.lifecycle, p.rank,
                p.service_branch,
                p.native_place, p.native_country, p.native_city, p.native_provider,
                p.native_resolved_at, p.native_lookup_status, p.native_next_retry_at,
                p.native_lookup_raw_json,
                p.ip_value_score, p.ip_value_breakdown_json,
                p.combat_points, p.health_score, p.discipline_score,
                p.success_count, p.total_samples, p.battle_success_count, p.battle_fail_count,
                p.honor_active_json, p.retired_type, p.updated_at,
                p.success_count AS l0_success_count,
                (
                    p.block_count
                    + p.timeout_count
                    + p.network_error_count
                    + p.invalid_feedback_count
                ) AS l0_fail_count,
                COALESCE(stage_stats.l1_success_count, 0) AS l1_success_count,
                COALESCE(stage_stats.l1_fail_count, 0) AS l1_fail_count,
                COALESCE(stage_stats.l2_success_count, 0) AS l2_success_count,
                COALESCE(stage_stats.l2_fail_count, 0) AS l2_fail_count,
                COALESCE(stage_stats.l3_success_count, 0) AS l3_success_count,
                COALESCE(stage_stats.l3_fail_count, 0) AS l3_fail_count
            FROM proxies
            AS p
            LEFT JOIN (
                SELECT
                    proxy_id,
                    SUM(CASE WHEN stage = 'l1' AND outcome = 'success' THEN 1 ELSE 0 END) AS l1_success_count,
                    SUM(CASE WHEN stage = 'l1' AND outcome IN ('blocked', 'timeout', 'network_error', 'invalid_feedback') THEN 1 ELSE 0 END) AS l1_fail_count,
                    SUM(CASE WHEN stage = 'l2' AND outcome = 'success' THEN 1 ELSE 0 END) AS l2_success_count,
                    SUM(CASE WHEN stage = 'l2' AND outcome IN ('blocked', 'timeout', 'network_error', 'invalid_feedback') THEN 1 ELSE 0 END) AS l2_fail_count,
                    SUM(CASE WHEN stage = 'l3' AND outcome = 'success' THEN 1 ELSE 0 END) AS l3_success_count,
                    SUM(CASE WHEN stage = 'l3' AND outcome IN ('blocked', 'timeout', 'network_error', 'invalid_feedback') THEN 1 ELSE 0 END) AS l3_fail_count
                FROM battle_test_runs
                GROUP BY proxy_id
            ) AS stage_stats
            ON stage_stats.proxy_id = p.id
            ${where}
            ORDER BY p.ip_value_score DESC, p.combat_points DESC, p.updated_at DESC
            LIMIT @limit
        `).all(params);

        return rows.map((row) => {
            const battleTotal = (row.battle_success_count || 0) + (row.battle_fail_count || 0);
            return {
                ...row,
                ip_value_breakdown: parseJsonObject(row.ip_value_breakdown_json),
                honor_active: parseJsonArray(row.honor_active_json),
                success_ratio: row.total_samples > 0
                    ? Number((row.success_count / row.total_samples).toFixed(4))
                    : 0,
                battle_ratio: battleTotal > 0
                    ? Number((row.battle_success_count / battleTotal).toFixed(4))
                    : 0,
            };
        });
    }

    // 0268_getRecruitCampBoard_获取新兵训练营分布逻辑
    getRecruitCampBoard() {
        const rows = this.db.prepare(`
            SELECT lifecycle, COUNT(*) AS count
            FROM proxies
            WHERE (rank = '新兵' AND lifecycle IN ('active', 'reserve', 'candidate'))
               OR lifecycle = 'retired'
            GROUP BY lifecycle
        `).all();

        const counters = {
            active: 0,
            reserve: 0,
            candidate: 0,
            retired: 0,
        };
        for (const row of rows) {
            counters[row.lifecycle] = Number(row.count) || 0;
        }

        return [
            { lifecycle: 'active', label: '新兵连', count: counters.active },
            { lifecycle: 'reserve', label: '医务室', count: counters.reserve },
            { lifecycle: 'candidate', label: '预备队', count: counters.candidate },
            { lifecycle: 'retired', label: '已退役', count: counters.retired },
        ];
    }

    // 0270_purgeSocks4Data_清理socks4来源数据逻辑
    purgeSocks4Data(options = {}) {
        const sourceName = options.sourceName || 'TheSpeedX/socks4';
        const protocol = options.protocol || 'socks4';

        const beforeSource = Number(this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM proxies
            WHERE source = ?
        `).get(sourceName)?.count || 0);
        const beforeProtocol = Number(this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM proxies
            WHERE protocol = ?
        `).get(protocol)?.count || 0);

        const deleted = Number(this.db.prepare(`
            DELETE FROM proxies
            WHERE source = @sourceName
               OR protocol = @protocol
        `).run({ sourceName, protocol }).changes || 0);

        const afterSource = Number(this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM proxies
            WHERE source = ?
        `).get(sourceName)?.count || 0);
        const afterProtocol = Number(this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM proxies
            WHERE protocol = ?
        `).get(protocol)?.count || 0);

        return {
            sourceName,
            protocol,
            deleted,
            beforeSource,
            beforeProtocol,
            afterSource,
            afterProtocol,
        };
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

    // 0248_getRolloutSwitchState_读取编排状态逻辑
    getRolloutSwitchState(nowIso = new Date().toISOString()) {
        this.db.prepare(`
            INSERT INTO rollout_switch_state (
                id, mode, stable_since, cooldown_until, last_tick_at, last_error, lease_owner, lease_until, updated_at
            ) VALUES (
                1, 'SAFE', @now, NULL, NULL, NULL, NULL, NULL, @now
            )
            ON CONFLICT(id) DO NOTHING
        `).run({ now: nowIso });

        return this.db.prepare(`
            SELECT id, mode, stable_since, cooldown_until, last_tick_at, last_error, lease_owner, lease_until, updated_at
            FROM rollout_switch_state
            WHERE id = 1
        `).get();
    }

    // 0249_acquireRolloutSwitchLease_获取编排租约逻辑
    acquireRolloutSwitchLease({ owner, nowIso = new Date().toISOString(), ttlMs = 120_000 } = {}) {
        const leaseOwner = String(owner || `pid-${process.pid}`);
        const safeTtlMs = Math.max(1_000, Number(ttlMs) || 120_000);
        const leaseUntil = new Date(Date.parse(nowIso) + safeTtlMs).toISOString();

        const tx = this.db.transaction((params) => {
            this.getRolloutSwitchState(params.nowIso);
            const outcome = this.db.prepare(`
                UPDATE rollout_switch_state
                SET lease_owner = @owner,
                    lease_until = @lease_until,
                    updated_at = @nowIso
                WHERE id = 1
                  AND (
                    lease_until IS NULL
                    OR lease_until < @nowIso
                    OR lease_owner = @owner
                  )
            `).run(params);
            return outcome.changes === 1;
        });

        return tx({
            owner: leaseOwner,
            nowIso,
            lease_until: leaseUntil,
        });
    }

    // 0250_updateRolloutSwitchState_更新编排状态逻辑
    updateRolloutSwitchState(payload = {}) {
        const {
            mode,
            stable_since,
            cooldown_until,
            last_tick_at,
            last_error,
            nowIso = new Date().toISOString(),
        } = payload;
        this.getRolloutSwitchState(nowIso);
        this.db.prepare(`
            UPDATE rollout_switch_state
            SET mode = COALESCE(@mode, mode),
                stable_since = CASE WHEN @stable_since_set = 1 THEN @stable_since ELSE stable_since END,
                cooldown_until = CASE WHEN @cooldown_until_set = 1 THEN @cooldown_until ELSE cooldown_until END,
                last_tick_at = CASE WHEN @last_tick_at_set = 1 THEN @last_tick_at ELSE last_tick_at END,
                last_error = CASE WHEN @last_error_set = 1 THEN @last_error ELSE last_error END,
                updated_at = @nowIso
            WHERE id = 1
        `).run({
            mode: mode == null ? null : String(mode),
            stable_since_set: Object.prototype.hasOwnProperty.call(payload, 'stable_since') ? 1 : 0,
            stable_since: stable_since == null ? null : String(stable_since),
            cooldown_until_set: Object.prototype.hasOwnProperty.call(payload, 'cooldown_until') ? 1 : 0,
            cooldown_until: cooldown_until == null ? null : String(cooldown_until),
            last_tick_at_set: Object.prototype.hasOwnProperty.call(payload, 'last_tick_at') ? 1 : 0,
            last_tick_at: last_tick_at == null ? null : String(last_tick_at),
            last_error_set: Object.prototype.hasOwnProperty.call(payload, 'last_error') ? 1 : 0,
            last_error: last_error == null ? null : String(last_error),
            nowIso,
        });

        return this.getRolloutSwitchState(nowIso);
    }

    // 0251_insertRolloutSwitchEvent_写入编排事件逻辑
    insertRolloutSwitchEvent(event) {
        this.insertRolloutSwitchEventStmt.run({
            timestamp: event.timestamp,
            trigger: String(event.trigger || 'manual'),
            action: String(event.action || 'steady'),
            mode_before: event.mode_before == null ? null : String(event.mode_before),
            mode_after: event.mode_after == null ? null : String(event.mode_after),
            patch_json: JSON.stringify(event.patch || {}),
            details_json: JSON.stringify(event.details || {}),
        });
    }

    // 0252_getRolloutSwitchEvents_获取编排事件逻辑
    getRolloutSwitchEvents(limit = 200) {
        const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
        const rows = this.db.prepare(`
            SELECT id, timestamp, trigger, action, mode_before, mode_after, patch_json, details_json
            FROM rollout_switch_events
            ORDER BY id DESC
            LIMIT ?
        `).all(safeLimit);

        return rows.map((row) => ({
            ...row,
            patch: parseJsonObject(row.patch_json),
            details: parseJsonObject(row.details_json),
        }));
    }

    // 0018_getSourceDistribution_获取来源分布逻辑
    getSourceDistribution(options = {}) {
        const excludeRetired = options.excludeRetired === true;
        const where = excludeRetired ? "WHERE lifecycle != 'retired'" : '';
        return this.db.prepare(`
            SELECT source, COUNT(*) AS count
            FROM proxies
            ${where}
            GROUP BY source
            ORDER BY count DESC
        `).all();
    }

    // 0019_getLifecycleDistribution_获取分布逻辑
    getLifecycleDistribution(options = {}) {
        const excludeRetired = options.excludeRetired === true;
        const where = excludeRetired ? "WHERE lifecycle != 'retired'" : '';
        return this.db.prepare(`
            SELECT lifecycle, COUNT(*) AS count
            FROM proxies
            ${where}
            GROUP BY lifecycle
        `).all();
    }

    // 0272_getServiceBranchDistribution_获取编制分布逻辑
    getServiceBranchDistribution(options = {}) {
        const excludeRetired = options.excludeRetired === true;
        const where = excludeRetired ? "WHERE lifecycle != 'retired'" : '';
        return this.db.prepare(`
            SELECT service_branch, COUNT(*) AS count
            FROM proxies
            ${where}
            GROUP BY service_branch
            ORDER BY count DESC, service_branch ASC
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

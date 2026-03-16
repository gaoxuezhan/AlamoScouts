const config = require('./config');
const { ProxyHubDb } = require('./db');
const { localizeRuntimeText } = require('./logger');

// 0222_parseArgs_解析命令参数逻辑
function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv : [];
    let dryRun = true;
    let sample = 20;
    let limit = 0;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--apply') {
            dryRun = false;
            continue;
        }
        if (arg === '--dry-run') {
            dryRun = true;
            continue;
        }
        if (arg === '--sample') {
            const value = Number(args[i + 1]);
            if (!Number.isFinite(value) || value <= 0) {
                throw new Error('invalid-sample-value');
            }
            sample = Math.max(1, Math.min(200, Math.floor(value)));
            i += 1;
            continue;
        }
        if (arg === '--limit') {
            const value = Number(args[i + 1]);
            if (!Number.isFinite(value) || value < 0) {
                throw new Error('invalid-limit-value');
            }
            limit = Math.floor(value);
            i += 1;
            continue;
        }
        throw new Error(`unknown-arg:${arg}`);
    }

    return { dryRun, sample, limit };
}

// 0223_parseDetailsJson_解析日志详情JSON逻辑
function parseDetailsJson(raw) {
    try {
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        return parsed;
    } catch {
        return {};
    }
}

// 0224_buildLocalizedRow_构建本地化行数据逻辑
function buildLocalizedRow(row) {
    const rawResult = row.result || '-';
    const rawReason = row.reason || '-';
    const rawAction = row.action || '-';

    const result = localizeRuntimeText(rawResult);
    const reason = localizeRuntimeText(rawReason);
    const action = localizeRuntimeText(rawAction);

    const changed = result !== rawResult || reason !== rawReason || action !== rawAction;
    if (!changed) {
        return null;
    }

    const details = parseDetailsJson(row.details_json);
    if (result !== rawResult && !Object.prototype.hasOwnProperty.call(details, 'raw_result')) {
        details.raw_result = rawResult;
    }
    if (reason !== rawReason && !Object.prototype.hasOwnProperty.call(details, 'raw_reason')) {
        details.raw_reason = rawReason;
    }
    if (action !== rawAction && !Object.prototype.hasOwnProperty.call(details, 'raw_action')) {
        details.raw_action = rawAction;
    }

    return {
        id: row.id,
        result,
        reason,
        action,
        details_json: JSON.stringify(details),
        before: { result: rawResult, reason: rawReason, action: rawAction },
        after: { result, reason, action },
    };
}

// 0225_runMigration_执行日志本地化迁移逻辑
function runMigration(options = {}) {
    const db = options.db || new ProxyHubDb(config);
    const parsed = parseArgs(options.argv || process.argv.slice(2));
    const startedAt = Date.now();

    try {
        const rows = parsed.limit > 0
            ? db.db.prepare(`
                SELECT id, result, reason, action, details_json
                FROM runtime_logs
                ORDER BY id ASC
                LIMIT ?
            `).all(parsed.limit)
            : db.db.prepare(`
                SELECT id, result, reason, action, details_json
                FROM runtime_logs
                ORDER BY id ASC
            `).all();

        const changedRows = [];
        for (const row of rows) {
            const localized = buildLocalizedRow(row);
            if (localized) {
                changedRows.push(localized);
            }
        }

        if (!parsed.dryRun && changedRows.length > 0) {
            const updateStmt = db.db.prepare(`
                UPDATE runtime_logs
                SET result = @result, reason = @reason, action = @action, details_json = @details_json
                WHERE id = @id
            `);
            const tx = db.db.transaction((items) => {
                for (const item of items) {
                    updateStmt.run(item);
                }
            });
            tx(changedRows);
        }

        return {
            ok: true,
            result: {
                dryRun: parsed.dryRun,
                limit: parsed.limit,
                total: rows.length,
                changed: changedRows.length,
                updated: parsed.dryRun ? 0 : changedRows.length,
                sample: changedRows.slice(0, parsed.sample).map((item) => ({
                    id: item.id,
                    before: item.before,
                    after: item.after,
                })),
                durationMs: Date.now() - startedAt,
            },
        };
    } catch (error) {
        return {
            ok: false,
            error: error?.message || String(error),
        };
    } finally {
        if (!options.db) {
            db.close();
        }
    }
}

/* c8 ignore next 7 */
if (require.main === module) {
    const outcome = runMigration();
    console.log(JSON.stringify(outcome, null, 2));
    if (!outcome.ok) {
        process.exit(1);
    }
}

module.exports = {
    parseArgs,
    parseDetailsJson,
    buildLocalizedRow,
    runMigration,
};

const config = require('./config');
const { ProxyHubDb } = require('./db');
const {
    normalizeNativeRawJson,
    buildNativeLookupReadableText,
} = require('./engine');

// 0296_parseArgs_parse migration args
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

// 0297_tryParseJson_try parse raw json text
function tryParseJson(rawJson) {
    const text = String(rawJson == null ? '' : rawJson).trim();
    if (text.length === 0) {
        return {
            ok: false,
            reason: 'empty',
            value: undefined,
            text,
        };
    }
    try {
        return {
            ok: true,
            reason: 'parsed',
            value: JSON.parse(text),
            text,
        };
    } catch {
        return {
            ok: false,
            reason: 'invalid-json',
            value: undefined,
            text,
        };
    }
}

// 0298_buildMigrationRow_build migrated row payload
function buildMigrationRow(row) {
    const id = Number(row?.id);
    const rawBefore = String(row?.native_lookup_raw_json == null ? '' : row.native_lookup_raw_json);
    const readableBefore = String(row?.native_lookup_readable_text == null ? '' : row.native_lookup_readable_text);
    const parsed = tryParseJson(rawBefore);
    if (parsed.reason === 'empty') {
        return null;
    }

    if (parsed.ok) {
        const rawAfter = normalizeNativeRawJson(parsed.text, parsed.value);
        const readableAfter = buildNativeLookupReadableText(parsed.value);
        return {
            id,
            parseStatus: 'parsed',
            changed: rawAfter !== rawBefore || readableAfter !== readableBefore,
            before: {
                rawJson: rawBefore,
                readableText: readableBefore,
            },
            after: {
                rawJson: rawAfter,
                readableText: readableAfter,
            },
        };
    }

    const readableAfter = `原文不可解析\n原文(raw): ${rawBefore}`;
    return {
        id,
        parseStatus: 'invalid-json',
        changed: readableAfter !== readableBefore,
        before: {
            rawJson: rawBefore,
            readableText: readableBefore,
        },
        after: {
            rawJson: rawBefore,
            readableText: readableAfter,
        },
    };
}

// 0299_runMigration_run native lookup json migration
function runMigration(options = {}) {
    const db = options.db || new ProxyHubDb(config);
    const startedAt = Date.now();

    try {
        const parsedArgs = parseArgs(options.argv || process.argv.slice(2));
        const rows = parsedArgs.limit > 0
            ? db.db.prepare(`
                SELECT id, native_lookup_raw_json, native_lookup_readable_text
                FROM proxies
                WHERE TRIM(COALESCE(native_lookup_raw_json, '')) <> ''
                ORDER BY id ASC
                LIMIT ?
            `).all(parsedArgs.limit)
            : db.db.prepare(`
                SELECT id, native_lookup_raw_json, native_lookup_readable_text
                FROM proxies
                WHERE TRIM(COALESCE(native_lookup_raw_json, '')) <> ''
                ORDER BY id ASC
            `).all();

        const preparedRows = rows
            .map((row) => buildMigrationRow(row))
            .filter(Boolean);
        const changedRows = preparedRows.filter((row) => row.changed);
        const parsedCount = preparedRows.filter((row) => row.parseStatus === 'parsed').length;
        const invalidCount = preparedRows.filter((row) => row.parseStatus === 'invalid-json').length;

        if (!parsedArgs.dryRun && changedRows.length > 0) {
            const nowIso = new Date().toISOString();
            const updateStmt = db.db.prepare(`
                UPDATE proxies
                SET native_lookup_raw_json = @native_lookup_raw_json,
                    native_lookup_readable_text = @native_lookup_readable_text,
                    updated_at = @updated_at
                WHERE id = @id
            `);
            const tx = db.db.transaction((items) => {
                for (const item of items) {
                    updateStmt.run({
                        id: item.id,
                        native_lookup_raw_json: item.after.rawJson,
                        native_lookup_readable_text: item.after.readableText,
                        updated_at: nowIso,
                    });
                }
            });
            tx(changedRows);
        }

        return {
            ok: true,
            result: {
                dryRun: parsedArgs.dryRun,
                limit: parsedArgs.limit,
                total: rows.length,
                prepared: preparedRows.length,
                parsed: parsedCount,
                invalid: invalidCount,
                changed: changedRows.length,
                updated: parsedArgs.dryRun ? 0 : changedRows.length,
                sample: changedRows.slice(0, parsedArgs.sample).map((row) => ({
                    id: row.id,
                    parseStatus: row.parseStatus,
                    before: row.before,
                    after: row.after,
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
    tryParseJson,
    buildMigrationRow,
    runMigration,
};

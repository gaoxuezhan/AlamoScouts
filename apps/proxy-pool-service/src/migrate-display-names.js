const config = require('./config');
const { ProxyHubDb } = require('./db');
const { generateRecruitName } = require('./naming');

// 0215_parseArgs_解析命令行参数逻辑
function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv : [];
    let dryRun = true;
    let sample = 20;

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
        throw new Error(`unknown-arg:${arg}`);
    }

    return { dryRun, sample };
}

// 0216_runMigration_执行重命名迁移逻辑
function runMigration(options = {}) {
    const db = options.db || new ProxyHubDb(config);
    const parsed = parseArgs(options.argv || process.argv.slice(2));
    const dbPath = db.dbPath;

    try {
        console.log(`[rename-display-names] dbPath=${dbPath}`);
        console.log(`[rename-display-names] mode=${parsed.dryRun ? 'dry-run' : 'apply'} sample=${parsed.sample}`);

        const result = db.renameAllDisplayNames({
            dryRun: parsed.dryRun,
            sample: parsed.sample,
            generateName: (isUnique) => generateRecruitName(isUnique),
        });

        console.log(JSON.stringify(result, null, 2));
        return { ok: true, result };
    } catch (error) {
        console.error('[rename-display-names] failed:', error?.message || String(error));
        return { ok: false, error: error?.message || String(error) };
    } finally {
        if (!options.db) {
            db.close();
        }
    }
}

if (require.main === module) {
    const outcome = runMigration();
    if (!outcome.ok) {
        process.exit(1);
    }
}

module.exports = {
    parseArgs,
    runMigration,
};

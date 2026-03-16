const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');
const { ProxyHubDb } = require('./db');
const {
    parseArgs,
    parseDetailsJson,
    buildLocalizedRow,
    runMigration,
} = require('./migrate-runtime-log-localization');

// 0226_createDb_创建运行时日志迁移测试数据库逻辑
function createDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyhub-log-localize-'));
    const dbPath = path.join(dir, 'runtime-log-localize.db');
    const db = new ProxyHubDb({
        storage: {
            dbPath,
            snapshotRetentionDays: 7,
        },
    });
    return { dir, db, dbPath };
}

// 0227_cleanup_清理运行时日志迁移测试数据库逻辑
function cleanup(handle) {
    handle.db.close();
    fs.rmSync(handle.dir, { recursive: true, force: true });
}

test('parseArgs should parse apply dry-run sample and limit flags', () => {
    assert.deepEqual(parseArgs([]), { dryRun: true, sample: 20, limit: 0 });
    assert.deepEqual(parseArgs('not-array'), { dryRun: true, sample: 20, limit: 0 });
    assert.deepEqual(parseArgs(['--apply']), { dryRun: false, sample: 20, limit: 0 });
    assert.deepEqual(parseArgs(['--apply', '--sample', '8', '--limit', '99']), { dryRun: false, sample: 8, limit: 99 });
    assert.deepEqual(parseArgs(['--sample', '999']), { dryRun: true, sample: 200, limit: 0 });
    assert.throws(() => parseArgs(['--sample', '0']), /invalid-sample-value/);
    assert.throws(() => parseArgs(['--limit', '-1']), /invalid-limit-value/);
    assert.throws(() => parseArgs(['--unknown']), /unknown-arg/);
});

test('parseDetailsJson should parse object and fallback for invalid values', () => {
    assert.deepEqual(parseDetailsJson(null), {});
    assert.deepEqual(parseDetailsJson(''), {});
    assert.deepEqual(parseDetailsJson('{"a":1}'), { a: 1 });
    assert.deepEqual(parseDetailsJson('[]'), {});
    assert.deepEqual(parseDetailsJson('{bad'), {});
});

test('buildLocalizedRow should return null when no localization is needed', () => {
    const localized = buildLocalizedRow({
        id: 1,
        result: '成功',
        reason: '正常',
        action: '继续',
        details_json: '{}',
    });
    assert.equal(localized, null);
});

test('buildLocalizedRow should localize fields and preserve original values in details', () => {
    const localized = buildLocalizedRow({
        id: 2,
        result: 'network_error',
        reason: '列兵/active',
        action: 'wait for timeout',
        details_json: '{"trace":"x","raw_reason":"old"}',
    });

    assert.equal(localized.id, 2);
    assert.equal(localized.result, '网络错误');
    assert.equal(localized.reason, '列兵/现役');
    assert.equal(localized.action, 'wait for 超时');
    const details = JSON.parse(localized.details_json);
    assert.equal(details.trace, 'x');
    assert.equal(details.raw_result, 'network_error');
    assert.equal(details.raw_reason, 'old');
    assert.equal(details.raw_action, 'wait for timeout');
});

test('buildLocalizedRow should fallback empty fields to dash and only record changed raw fields', () => {
    const localized = buildLocalizedRow({
        id: 3,
        result: 'blocked',
        reason: '',
        action: null,
        details_json: '{}',
    });

    assert.equal(localized.result, '封禁');
    assert.equal(localized.reason, '-');
    assert.equal(localized.action, '-');
    const details = JSON.parse(localized.details_json);
    assert.equal(details.raw_result, 'blocked');
    assert.equal(Object.prototype.hasOwnProperty.call(details, 'raw_reason'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(details, 'raw_action'), false);
});

test('runMigration should support dry-run and apply modes', () => {
    const h = createDb();
    const now = new Date().toISOString();
    h.db.insertRuntimeLog({
        timestamp: now,
        event: '测试一',
        proxy_name: 'A',
        ip_source: 'src',
        stage: '评分',
        result: 'timeout',
        reason: '列兵/active',
        action: 'wait for timeout',
        details: { traceId: 't-1' },
    });
    h.db.insertRuntimeLog({
        timestamp: now,
        event: '测试二',
        proxy_name: 'B',
        ip_source: 'src',
        stage: '评分',
        result: '成功',
        reason: '-',
        action: '-',
        details: {},
    });

    const preview = runMigration({
        db: h.db,
        argv: ['--dry-run', '--sample', '2', '--limit', '10'],
    });
    assert.equal(preview.ok, true);
    assert.equal(preview.result.dryRun, true);
    assert.equal(preview.result.total, 2);
    assert.equal(preview.result.changed, 1);
    assert.equal(preview.result.updated, 0);
    assert.equal(preview.result.sample.length, 1);

    const applied = runMigration({
        db: h.db,
        argv: ['--apply', '--sample', '1'],
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.result.dryRun, false);
    assert.equal(applied.result.changed, 1);
    assert.equal(applied.result.updated, 1);
    assert.equal(applied.result.sample.length, 1);

    const row = h.db.db.prepare('SELECT result, reason, action, details_json FROM runtime_logs WHERE event = ?').get('测试一');
    const details = JSON.parse(row.details_json);
    assert.equal(row.result, '超时');
    assert.equal(row.reason, '列兵/现役');
    assert.equal(row.action, 'wait for 超时');
    assert.equal(details.raw_result, 'timeout');
    assert.equal(details.raw_reason, '列兵/active');
    assert.equal(details.raw_action, 'wait for timeout');

    cleanup(h);
});

test('runMigration should return failure payload when database throws without message', () => {
    const fakeDb = {
        db: {
            prepare() {
                throw null;
            },
        },
    };

    const result = runMigration({
        db: fakeDb,
        argv: ['--apply'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'null');
});

test('runMigration should return failure payload with error message', () => {
    const fakeDb = {
        db: {
            prepare() {
                throw new Error('db-boom');
            },
        },
    };

    const result = runMigration({
        db: fakeDb,
        argv: ['--apply'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'db-boom');
});

test('runMigration should parse arguments from process argv when argv is not provided', () => {
    const h = createDb();
    const now = new Date().toISOString();
    h.db.insertRuntimeLog({
        timestamp: now,
        event: 'process-argv',
        proxy_name: 'P',
        ip_source: 'src',
        stage: '评分',
        result: 'timeout',
        reason: '-',
        action: '-',
        details: {},
    });

    const originalArgv = process.argv;
    process.argv = [process.execPath, 'migrate-runtime-log-localization.js', '--dry-run', '--limit', '1'];
    try {
        const result = runMigration({ db: h.db });
        assert.equal(result.ok, true);
        assert.equal(result.result.total, 1);
        assert.equal(result.result.limit, 1);
    } finally {
        process.argv = originalArgv;
        cleanup(h);
    }
});

test('runMigration apply should skip updates when there is no changed row', () => {
    const h = createDb();
    const now = new Date().toISOString();
    h.db.insertRuntimeLog({
        timestamp: now,
        event: 'already-cn',
        proxy_name: 'C',
        ip_source: 'src',
        stage: '评分',
        result: '成功',
        reason: '正常',
        action: '继续',
        details: {},
    });

    const result = runMigration({
        db: h.db,
        argv: ['--apply'],
    });
    assert.equal(result.ok, true);
    assert.equal(result.result.changed, 0);
    assert.equal(result.result.updated, 0);

    cleanup(h);
});

test('runMigration should close internally created db when db is not injected', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyhub-log-localize-run-'));
    const dbPath = path.join(tempDir, 'runtime-log-localize-run.db');
    const previousDbPath = config.storage.dbPath;
    config.storage.dbPath = dbPath;

    try {
        const result = runMigration({
            argv: ['--dry-run', '--limit', '0'],
        });
        assert.equal(result.ok, true);
        assert.equal(result.result.dryRun, true);
        assert.equal(fs.existsSync(dbPath), true);
    } finally {
        config.storage.dbPath = previousDbPath;
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
            // ignore windows sqlite lock cleanup races
        }
    }
});

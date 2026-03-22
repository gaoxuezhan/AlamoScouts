const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('./config');
const { ProxyHubDb } = require('./db');
const {
    parseArgs,
    tryParseJson,
    buildMigrationRow,
    runMigration,
} = require('./migrate-native-lookup-json-format');

// 0300_createDbHandle_create sqlite handle for migration tests
function createDbHandle() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyhub-native-json-migrate-'));
    const dbPath = path.join(dir, 'proxyhub-native-json.db');
    const db = new ProxyHubDb({
        storage: {
            dbPath,
            snapshotRetentionDays: 7,
        },
    });
    return { dir, dbPath, db };
}

// 0301_cleanup_cleanup sqlite handle for migration tests
function cleanup(handle) {
    handle.db.close();
    fs.rmSync(handle.dir, { recursive: true, force: true });
}

test('parseArgs should parse apply/dry-run/sample/limit flags', () => {
    assert.deepEqual(parseArgs([]), { dryRun: true, sample: 20, limit: 0 });
    assert.deepEqual(parseArgs('bad-argv'), { dryRun: true, sample: 20, limit: 0 });
    assert.deepEqual(parseArgs(['--apply']), { dryRun: false, sample: 20, limit: 0 });
    assert.deepEqual(parseArgs(['--apply', '--sample', '8', '--limit', '99']), { dryRun: false, sample: 8, limit: 99 });
    assert.deepEqual(parseArgs(['--sample', '999']), { dryRun: true, sample: 200, limit: 0 });
    assert.throws(() => parseArgs(['--sample', '0']), /invalid-sample-value/);
    assert.throws(() => parseArgs(['--limit', '-1']), /invalid-limit-value/);
    assert.throws(() => parseArgs(['--unknown']), /unknown-arg/);
});

test('tryParseJson should cover parsed invalid and empty branches', () => {
    assert.deepEqual(tryParseJson('{"a":1}'), {
        ok: true,
        reason: 'parsed',
        value: { a: 1 },
        text: '{"a":1}',
    });
    assert.deepEqual(tryParseJson('{bad-json'), {
        ok: false,
        reason: 'invalid-json',
        value: undefined,
        text: '{bad-json',
    });
    assert.deepEqual(tryParseJson('  '), {
        ok: false,
        reason: 'empty',
        value: undefined,
        text: '',
    });
    assert.deepEqual(tryParseJson(null), {
        ok: false,
        reason: 'empty',
        value: undefined,
        text: '',
    });
});

test('buildMigrationRow should build parsed/invalid/empty row payloads', () => {
    const parsedRow = buildMigrationRow({
        id: 1,
        native_lookup_raw_json: '{"z":2,"a":1}',
        native_lookup_readable_text: '',
    });
    assert.equal(parsedRow.parseStatus, 'parsed');
    assert.equal(parsedRow.changed, true);
    assert.equal(parsedRow.after.rawJson, '{\n  "a": 1,\n  "z": 2\n}');
    assert.equal(parsedRow.after.readableText.includes('原键名(a): 1'), true);

    const invalidRow = buildMigrationRow({
        id: 2,
        native_lookup_raw_json: '{bad-json',
        native_lookup_readable_text: '',
    });
    assert.equal(invalidRow.parseStatus, 'invalid-json');
    assert.equal(invalidRow.after.rawJson, '{bad-json');
    assert.equal(invalidRow.after.readableText.startsWith('原文不可解析'), true);

    const emptyRow = buildMigrationRow({
        id: 3,
        native_lookup_raw_json: '   ',
        native_lookup_readable_text: '',
    });
    assert.equal(emptyRow, null);

    const nullishFieldsRow = buildMigrationRow({
        id: 4,
    });
    assert.equal(nullishFieldsRow, null);

    const unchangedRow = buildMigrationRow({
        id: 5,
        native_lookup_raw_json: '{\n  "a": 1\n}',
        native_lookup_readable_text: '原键名(a): 1',
    });
    assert.equal(unchangedRow.parseStatus, 'parsed');
    assert.equal(unchangedRow.changed, false);
});

test('runMigration should report and apply parsed/invalid native rows', () => {
    const h = createDbHandle();
    const now = new Date().toISOString();

    h.db.upsertSourceBatch(
        [
            { ip: '99.0.0.1', port: 80, protocol: 'http' },
            { ip: '99.0.0.2', port: 80, protocol: 'http' },
            { ip: '99.0.0.3', port: 80, protocol: 'http' },
        ],
        (() => {
            let i = 0;
            return () => `籍贯迁移-${++i}`;
        })(),
        'src-native-migrate',
        'batch-native-migrate',
        now,
    );
    const rows = h.db.getProxyList({ limit: 10 });
    h.db.updateProxyById(rows[0].id, {
        native_lookup_raw_json: '{"z":2,"a":1}',
        native_lookup_readable_text: '',
        updated_at: now,
    });
    h.db.updateProxyById(rows[1].id, {
        native_lookup_raw_json: '{bad-json',
        native_lookup_readable_text: '',
        updated_at: now,
    });
    h.db.updateProxyById(rows[2].id, {
        native_lookup_raw_json: '',
        native_lookup_readable_text: '',
        updated_at: now,
    });

    const dryRun = runMigration({
        db: h.db,
        argv: ['--dry-run', '--sample', '5'],
    });
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.result.total, 2);
    assert.equal(dryRun.result.prepared, 2);
    assert.equal(dryRun.result.parsed, 1);
    assert.equal(dryRun.result.invalid, 1);
    assert.equal(dryRun.result.changed, 2);
    assert.equal(dryRun.result.updated, 0);

    const beforeApply = h.db.getProxyById(rows[0].id);
    assert.equal(beforeApply.native_lookup_raw_json, '{"z":2,"a":1}');

    const apply = runMigration({
        db: h.db,
        argv: ['--apply', '--limit', '2'],
    });
    assert.equal(apply.ok, true);
    assert.equal(apply.result.total, 2);
    assert.equal(apply.result.updated, 2);

    const parsedAfter = h.db.getProxyById(rows[0].id);
    const invalidAfter = h.db.getProxyById(rows[1].id);
    assert.equal(parsedAfter.native_lookup_raw_json, '{\n  "a": 1,\n  "z": 2\n}');
    assert.equal(parsedAfter.native_lookup_readable_text.includes('原键名(a): 1'), true);
    assert.equal(invalidAfter.native_lookup_raw_json, '{bad-json');
    assert.equal(invalidAfter.native_lookup_readable_text.startsWith('原文不可解析'), true);

    cleanup(h);
});

test('runMigration should return failure payload when args are invalid', () => {
    const h = createDbHandle();
    const failed = runMigration({
        db: h.db,
        argv: ['--sample', '0'],
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'invalid-sample-value');
    cleanup(h);
});

test('runMigration should fallback error text when thrown value has no message', () => {
    const fakeDb = {
        db: {
            prepare() {
                throw null;
            },
        },
    };
    const result = runMigration({
        db: fakeDb,
        argv: ['--dry-run'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'null');
});

test('runMigration should close internally created db when db is not injected', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyhub-native-json-run-'));
    const dbPath = path.join(tempDir, 'proxyhub-native-json-run.db');
    const previousDbPath = config.storage.dbPath;
    config.storage.dbPath = dbPath;

    try {
        const result = runMigration({
            argv: ['--dry-run', '--sample', '1'],
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

test('cli main should return non-zero and close db on failure', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyhub-native-json-cli-'));
    const dbPath = path.join(tempDir, 'proxyhub-native-json-cli.db');
    const scriptPath = path.join(__dirname, 'migrate-native-lookup-json-format.js');
    const proc = spawnSync(
        process.execPath,
        [scriptPath, '--sample', '0'],
        {
            cwd: path.resolve(__dirname, '..', '..', '..'),
            env: {
                ...process.env,
                PROXY_HUB_DB_PATH: dbPath,
            },
            encoding: 'utf8',
        },
    );

    assert.equal(proc.status, 1);
    assert.match((proc.stderr || '') + (proc.stdout || ''), /invalid-sample-value/);
    assert.equal(fs.existsSync(dbPath), true);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

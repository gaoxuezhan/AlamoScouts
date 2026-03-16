const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('./config');
const { parseArgs, runMigration } = require('./migrate-display-names');

test('parseArgs should parse dry-run apply and sample flags', () => {
    assert.deepEqual(parseArgs([]), { dryRun: true, sample: 20 });
    assert.deepEqual(parseArgs('not-array'), { dryRun: true, sample: 20 });
    assert.deepEqual(parseArgs(['--apply']), { dryRun: false, sample: 20 });
    assert.deepEqual(parseArgs(['--apply', '--sample', '8']), { dryRun: false, sample: 8 });
    assert.deepEqual(parseArgs(['--sample', '999']), { dryRun: true, sample: 200 });
    assert.throws(() => parseArgs(['--sample', '0']), /invalid-sample-value/);
    assert.throws(() => parseArgs(['--unknown']), /unknown-arg/);
});

test('runMigration should call db and return success payload', () => {
    let closed = false;
    let payload = null;
    const fakeDb = {
        dbPath: '/tmp/fake.db',
        renameAllDisplayNames(input) {
            payload = input;
            input.generateName(() => true);
            return { ok: true, dryRun: input.dryRun, summary: { total: 2 } };
        },
        close() {
            closed = true;
        },
    };

    const result = runMigration({
        argv: ['--dry-run', '--sample', '5'],
        db: fakeDb,
    });
    assert.equal(result.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.sample, 5);
    assert.equal(typeof payload.generateName, 'function');
    assert.equal(closed, false);
});

test('runMigration should return failure payload on db errors', () => {
    const fakeDb = {
        dbPath: '/tmp/fake.db',
        renameAllDisplayNames() {
            throw new Error('boom');
        },
    };

    const result = runMigration({
        argv: ['--apply'],
        db: fakeDb,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'boom');
});

test('runMigration should fallback error text when thrown value has no message', () => {
    const fakeDb = {
        dbPath: '/tmp/fake.db',
        renameAllDisplayNames() {
            throw null;
        },
    };

    const result = runMigration({
        argv: ['--apply'],
        db: fakeDb,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'null');
});

test('runMigration should close internally created db when db is not injected', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyhub-rename-run-'));
    const dbPath = path.join(tempDir, 'proxyhub-run.db');
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyhub-rename-cli-'));
    const dbPath = path.join(tempDir, 'proxyhub-cli.db');
    const scriptPath = path.join(__dirname, 'migrate-display-names.js');
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

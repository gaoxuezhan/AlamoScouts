const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, runMigration } = require('./migrate-display-names');

test('parseArgs should parse dry-run apply and sample flags', () => {
    assert.deepEqual(parseArgs([]), { dryRun: true, sample: 20 });
    assert.deepEqual(parseArgs(['--apply']), { dryRun: false, sample: 20 });
    assert.deepEqual(parseArgs(['--apply', '--sample', '8']), { dryRun: false, sample: 8 });
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

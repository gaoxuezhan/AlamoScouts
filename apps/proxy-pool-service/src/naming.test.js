const test = require('node:test');
const assert = require('node:assert/strict');
const { generateRecruitName } = require('./naming');

test('generateRecruitName should create unique names with retry', () => {
    const used = new Set();
    const isUnique = (name) => !used.has(name);

    for (let i = 0; i < 200; i += 1) {
        const name = generateRecruitName(isUnique);
        assert.equal(used.has(name), false);
        used.add(name);
    }

    assert.equal(used.size, 200);
});

test('generateRecruitName should fallback with checksum when collisions happen', () => {
    let callCount = 0;
    const seen = new Set();

    const name = generateRecruitName((candidate) => {
        callCount += 1;
        if (callCount <= 10) {
            return false;
        }
        if (seen.has(candidate)) {
            return false;
        }
        seen.add(candidate);
        return true;
    });

    assert.ok(name.split('-').length >= 4);
});

test('generateRecruitName should throw when uniqueness never satisfied', () => {
    assert.throws(
        () => generateRecruitName(() => false),
        /无法生成唯一的新兵昵称/,
    );
});

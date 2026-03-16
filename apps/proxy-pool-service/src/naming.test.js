const test = require('node:test');
const assert = require('node:assert/strict');
const {
    extractChineseChars,
    isValidChineseName,
    generateRecruitName,
} = require('./naming');

test('name helpers should keep only Chinese chars and validate 2/3-char names', () => {
    assert.equal(extractChineseChars('A\u5f20\u4e091'), '\u5f20\u4e09');
    assert.equal(extractChineseChars(undefined), '');
    assert.equal(extractChineseChars('abc123'), '');

    assert.equal(isValidChineseName('\u5f20\u4e09'), true);
    assert.equal(isValidChineseName('\u53f8\u9a6c\u61ff'), true);
    assert.equal(isValidChineseName('\u6b27\u9633\u5a1c\u5a1c'), false);
    assert.equal(isValidChineseName('A\u5f20\u4e09'), false);
    assert.equal(isValidChineseName(undefined), false);
});

test('generateRecruitName should create unique Chinese names with retry', () => {
    const used = new Set();
    for (let i = 0; i < 200; i += 1) {
        const name = generateRecruitName((candidate) => !used.has(candidate));
        assert.equal(used.has(name), false);
        assert.equal(/^[\u3400-\u9fff]{2,3}$/.test(name), true);
        used.add(name);
    }
    assert.equal(used.size, 200);
});

test('generateRecruitName should continue retrying when collisions happen', () => {
    let blocked = 20;
    const seen = new Set();
    const name = generateRecruitName((candidate) => {
        if (blocked > 0) {
            blocked -= 1;
            return false;
        }
        if (seen.has(candidate)) {
            return false;
        }
        seen.add(candidate);
        return true;
    });

    assert.equal(/^[\u3400-\u9fff]{2,3}$/.test(name), true);
});

test('generateRecruitName should throw when uniqueness never satisfied', () => {
    assert.throws(
        () => generateRecruitName(() => false),
        /\u65e0\u6cd5\u751f\u6210\u552f\u4e00\u4e2d\u6587\u59d3\u540d/,
    );
});

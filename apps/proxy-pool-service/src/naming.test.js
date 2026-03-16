const test = require('node:test');
const assert = require('node:assert/strict');
const {
    extractChineseChars,
    isValidChineseName,
    generateRecruitName,
} = require('./naming');

test('name helpers should keep only Chinese chars and validate 2/3-char names', () => {
    assert.equal(extractChineseChars('A张-三01'), '张三');
    assert.equal(isValidChineseName('张三'), true);
    assert.equal(isValidChineseName('欧阳明'), true);
    assert.equal(isValidChineseName('王小小明'), false);
    assert.equal(isValidChineseName('A张三'), false);
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
        /无法生成唯一中文姓名/,
    );
});

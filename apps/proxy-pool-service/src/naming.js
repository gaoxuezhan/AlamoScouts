const { fakerZH_CN } = require('@faker-js/faker');

const CHINESE_CHAR_PATTERN = /[\u3400-\u9fff]/g;
const VALID_CHINESE_NAME_PATTERN = /^[\u3400-\u9fff]{2,3}$/;

// 0075_extractChineseChars_提取中文字符逻辑
function extractChineseChars(text) {
    return String(text || '').match(CHINESE_CHAR_PATTERN)?.join('') || '';
}

// 0076_buildName_构建中文姓名逻辑
function buildName() {
    const lastName = extractChineseChars(fakerZH_CN.person.lastName());
    const firstName = extractChineseChars(fakerZH_CN.person.firstName());
    return `${lastName}${firstName}`;
}

// 0077_isValidChineseName_校验中文姓名逻辑
function isValidChineseName(name) {
    return VALID_CHINESE_NAME_PATTERN.test(String(name || ''));
}

// 0079_generateRecruitName_新兵名称逻辑
function generateRecruitName(isUniqueName) {
    for (let i = 0; i < 300; i += 1) {
        const candidate = buildName();
        if (!isValidChineseName(candidate)) {
            continue;
        }
        if (isUniqueName(candidate)) {
            return candidate;
        }
    }

    throw new Error('无法生成唯一中文姓名');
}

module.exports = {
    extractChineseChars,
    isValidChineseName,
    generateRecruitName,
};

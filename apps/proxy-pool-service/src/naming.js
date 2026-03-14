const crypto = require('node:crypto');

const PREFIXES = [
    '苍隼', '铁卫', '长弓', '霆锋', '玄甲', '凌云', '烈风', '破晓', '雷霄', '雪豹',
    '赤焰', '飞隼', '劲旅', '锋刃', '青锋', '虎贲', '骁骑', '龙卫', '孤鹰', '远征',
];

const CODENAMES = [
    '北辰', '天枢', '赤霄', '龙门', '昆仑', '云海', '天穹', '长空', '瀚海', '玄武',
    '青龙', '白虎', '朱雀', '苍狼', '星河', '曜石', '寒星', '惊雷', '飞廉', '凌霜',
];

// 0075_randomPick_随机逻辑
function randomPick(list) {
    return list[crypto.randomInt(0, list.length)];
}

// 0076_randomSerial_随机逻辑
function randomSerial() {
    return String(crypto.randomInt(1, 100)).padStart(2, '0');
}

// 0077_shortCode_执行shortCode相关逻辑
function shortCode(seed) {
    return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 2).toUpperCase();
}

// 0078_buildName_名称逻辑
function buildName() {
    return `${randomPick(PREFIXES)}-${randomPick(CODENAMES)}-${randomSerial()}`;
}

// 0079_generateRecruitName_新兵名称逻辑
function generateRecruitName(isUniqueName) {
    for (let i = 0; i < 10; i += 1) {
        const candidate = buildName();
        if (isUniqueName(candidate)) {
            return candidate;
        }
    }

    for (let i = 0; i < 20; i += 1) {
        const base = buildName();
        const candidate = `${base}-${shortCode(`${Date.now()}-${i}-${Math.random()}`)}`;
        if (isUniqueName(candidate)) {
            return candidate;
        }
    }

    throw new Error('无法生成唯一的新兵昵称');
}

module.exports = {
    generateRecruitName,
};

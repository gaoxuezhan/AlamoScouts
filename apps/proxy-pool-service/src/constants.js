const RANKS = ['新兵', '列兵', '士官', '尉官', '校官', '将官', '王牌'];
const LIFECYCLE = ['candidate', 'active', 'reserve', 'retired'];

const RETIREMENT_TYPES = {
    HONOR: '荣誉退伍',
    BATTLE_DAMAGE: '战损退伍',
    DISCIPLINE: '纪律退伍',
    TECHNICAL: '技术退伍',
    L3_FAIL_FAST: '筛选退伍',
};

const HONOR_TYPES = {
    STEEL_STREAK: '钢铁连胜',
    RISKY_WARRIOR: '逆风勇士',
    THOUSAND_SERVICE: '千次服役',
    L2_MASTERY: '攻坚大师',
    DISCIPLINE_GUARD: '铁纪标兵',
};

const EVENT_LEVEL = {
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error',
};

module.exports = {
    RANKS,
    LIFECYCLE,
    RETIREMENT_TYPES,
    HONOR_TYPES,
    EVENT_LEVEL,
};

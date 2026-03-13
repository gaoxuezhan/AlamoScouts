const test = require('node:test');
const assert = require('node:assert/strict');
const { RuntimeLogger } = require('./logger');

function createDbStub(throwOnInsert = false) {
    const logs = [];
    return {
        logs,
        insertRuntimeLog(entry) {
            if (throwOnInsert) {
                throw new Error('db-write-failed');
            }
            logs.push(entry);
        },
    };
}

test('logger should write and emit runtime log', async () => {
    const db = createDbStub(false);
    const logger = new RuntimeLogger({ db, retention: 3 });

    let emitted = null;
    const unsub = logger.subscribe((entry) => {
        emitted = entry;
    });

    const entry = logger.write({
        event: '开始抓源',
        proxyName: '苍隼-北辰-01',
        ipSource: 'monosans',
        stage: '抓源',
        result: '开始',
        durationMs: 12.6,
        reason: 'ok',
        action: 'next',
    });

    assert.equal(db.logs.length, 1);
    assert.equal(entry.duration_ms, 13);
    assert.equal(emitted.event, '开始抓源');

    unsub();
    logger.write({ event: '不会再订阅' });
    assert.equal(logger.getRecent(2).length, 2);
});

test('logger should cap retention and normalize limit', () => {
    const db = createDbStub(false);
    const logger = new RuntimeLogger({ db, retention: 2 });

    logger.write({ event: 'a' });
    logger.write({ event: 'b' });
    logger.write({ event: 'c' });

    const all = logger.getRecent(999);
    assert.equal(all.length, 2);
    assert.equal(all[0].event, 'c');
    assert.equal(all[1].event, 'b');

    const minOne = logger.getRecent(0);
    assert.equal(minOne.length, 1);
});

test('logger should continue when db insert throws', () => {
    const db = createDbStub(true);
    const logger = new RuntimeLogger({ db, retention: 2 });

    const entry = logger.write({ event: '写数据库失败测试' });
    assert.equal(entry.event, '写数据库失败测试');
    assert.equal(logger.getRecent(1).length, 1);
});

test('logger should fallback to default event name when absent', () => {
    const db = createDbStub(false);
    const logger = new RuntimeLogger({ db, retention: 2 });
    const entry = logger.write({});
    assert.equal(entry.event, '系统事件');
});

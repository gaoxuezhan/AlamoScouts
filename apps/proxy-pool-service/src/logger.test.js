const test = require('node:test');
const assert = require('node:assert/strict');
const { RuntimeLogger, localizeRuntimeText, localizeRuntimeRecord } = require('./logger');

// 0073_createDbStub_创建逻辑
function createDbStub(throwOnInsert = false) {
    const logs = [];
    return {
        logs,
        // 0074_insertRuntimeLog_写入运行时日志逻辑
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

test('localizeRuntimeText should map known tokens and lifecycle labels', () => {
    assert.equal(localizeRuntimeText('success'), '成功');
    assert.equal(localizeRuntimeText('blocked'), '封禁');
    assert.equal(localizeRuntimeText('timeout'), '超时');
    assert.equal(localizeRuntimeText('network_error'), '网络错误');
    assert.equal(localizeRuntimeText('networkError'), '网络错误');
    assert.equal(localizeRuntimeText('invalid_feedback'), '反馈无效');
    assert.equal(localizeRuntimeText('invalidFeedback'), '反馈无效');
    assert.equal(localizeRuntimeText('active'), '现役');
    assert.equal(localizeRuntimeText('新兵/active'), '新兵/现役');
    assert.equal(localizeRuntimeText(' candidate '), '候选');
    assert.equal(localizeRuntimeText(null), '-');
    assert.equal(localizeRuntimeText(''), '-');
});

test('localizeRuntimeRecord should inject raw fields into details when localized', () => {
    const localized = localizeRuntimeRecord({
        result: 'network_error',
        reason: '新兵/active',
        action: 'wait for timeout',
        details: { traceId: 'x-1' },
    });

    assert.equal(localized.result, '网络错误');
    assert.equal(localized.reason, '新兵/现役');
    assert.equal(localized.action, 'wait for 超时');
    assert.equal(localized.details.traceId, 'x-1');
    assert.equal(localized.details.raw_result, 'network_error');
    assert.equal(localized.details.raw_reason, '新兵/active');
    assert.equal(localized.details.raw_action, 'wait for timeout');
});

test('logger should normalize record fields to chinese and preserve raw values in details', () => {
    const db = createDbStub(false);
    const logger = new RuntimeLogger({ db, retention: 2 });

    const entry = logger.write({
        event: '写数据库成功',
        result: 'blocked',
        reason: '列兵/reserve',
        action: 'retry after timeout',
        details: 'not-object',
    });

    assert.equal(entry.result, '封禁');
    assert.equal(entry.reason, '列兵/预备');
    assert.equal(entry.action, 'retry after 超时');
    assert.equal(entry.details.raw_result, 'blocked');
    assert.equal(entry.details.raw_reason, '列兵/reserve');
    assert.equal(entry.details.raw_action, 'retry after timeout');
    assert.equal(db.logs[0].details.raw_result, 'blocked');
});

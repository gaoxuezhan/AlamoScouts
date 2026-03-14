const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProxyHubDb } = require('./db');

// 0021_createDb_创建逻辑
function createDb({ snapshotRetentionDays = 7 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyhub-db-'));
    const dbPath = path.join(dir, 'proxyhub-test.db');
    const config = {
        storage: {
            dbPath,
            snapshotRetentionDays,
        },
    };

    const db = new ProxyHubDb(config);
    return { db, dir, dbPath };
}

// 0022_cleanup_执行cleanup相关逻辑
function cleanup(handle) {
    handle.db.close();
    fs.rmSync(handle.dir, { recursive: true, force: true });
}

test('db should create tables and return null latest snapshot initially', () => {
    const h = createDb();
    assert.equal(h.db.getLatestSnapshot(), null);
    cleanup(h);
});

test('upsertSourceBatch should insert and touch existing records', () => {
    const h = createDb();
    const now = new Date().toISOString();

    const first = h.db.upsertSourceBatch(
        [{ ip: '1.1.1.1', port: 80, protocol: 'http' }],
        () => '苍隼-北辰-01',
        'srcA',
        'batchA',
        now,
    );
    assert.deepEqual(first, { inserted: 1, touched: 0 });

    const second = h.db.upsertSourceBatch(
        [{ ip: '1.1.1.1', port: 80, protocol: 'http' }],
        () => '不会用到',
        'srcB',
        'batchB',
        now,
    );
    assert.deepEqual(second, { inserted: 0, touched: 1 });

    const proxy = h.db.getProxyByKey('1.1.1.1:80:http');
    assert.equal(proxy.source, 'srcB');
    assert.equal(h.db.isDisplayNameAvailable('苍隼-北辰-01'), false);
    assert.equal(h.db.isDisplayNameAvailable('不存在'), true);

    cleanup(h);
});

test('updateProxyById should support empty updates and normal updates', () => {
    const h = createDb();
    const now = new Date().toISOString();
    h.db.upsertSourceBatch(
        [{ ip: '2.2.2.2', port: 8080, protocol: 'https' }],
        () => '龙卫-玄武-02',
        'src',
        'batch',
        now,
    );

    const proxy = h.db.getProxyByKey('2.2.2.2:8080:https');
    h.db.updateProxyById(proxy.id, {});
    h.db.updateProxyById(proxy.id, {
        lifecycle: 'active',
        rank: '列兵',
        updated_at: new Date().toISOString(),
    });
    h.db.updateProxyById(proxy.id, {
        lifecycle: 'reserve',
    });

    const refreshed = h.db.getProxyById(proxy.id);
    assert.equal(refreshed.lifecycle, 'reserve');
    assert.equal(refreshed.rank, '列兵');

    cleanup(h);
});

test('log and event APIs should work', () => {
    const h = createDb();
    const now = new Date().toISOString();

    h.db.insertRuntimeLog({
        timestamp: now,
        event: '开始抓源',
        proxy_name: 'A',
        ip_source: 'src',
        stage: '抓源',
        result: 'ok',
        duration_ms: 12,
        reason: 'none',
        action: 'next',
        details: { a: 1 },
    });

    h.db.insertProxyEvent({
        timestamp: now,
        proxy_id: null,
        display_name: 'A',
        event_type: 'promotion',
        level: 'info',
        message: '晋升',
        details: { to: '列兵' },
    });

    const logs = h.db.getRuntimeLogs(10);
    const events = h.db.getEvents(10);
    assert.equal(logs.length, 1);
    assert.equal(events.length, 1);

    cleanup(h);
});

test('db should apply default field fallbacks for nullable inserts', () => {
    const h = createDb();
    const now = new Date().toISOString();

    h.db.insertRuntimeLog({
        timestamp: now,
        event: '默认字段测试',
    });

    h.db.insertProxyEvent({
        timestamp: now,
        event_type: 'generic',
        message: 'x',
    });

    h.db.upsertSourceBatch(
        [{ ip: '9.9.9.9', port: 9000, protocol: 'http' }],
        () => '骁骑-星河-09',
        'src',
        'batch',
        now,
    );
    const proxy = h.db.getProxyByKey('9.9.9.9:9000:http');

    h.db.upsertHonor({
        proxy_id: proxy.id,
        display_name: proxy.display_name,
        honor_type: '千次服役',
        awarded_at: now,
    });

    h.db.insertRetirement({
        proxy_id: proxy.id,
        display_name: proxy.display_name,
        retired_type: '技术退伍',
        retired_at: now,
    });

    h.db.insertPoolSnapshot({
        timestamp: now,
        workers_total: 1,
        workers_busy: 0,
        queue_size: 0,
        completed_tasks: 0,
        failed_tasks: 0,
        restarted_workers: 0,
    });

    h.db.db.prepare(`
        UPDATE pool_snapshots
        SET source_distribution_json = '', rank_distribution_json = '', lifecycle_distribution_json = ''
        WHERE id = (SELECT id FROM pool_snapshots ORDER BY id DESC LIMIT 1)
    `).run();

    const latest = h.db.getLatestSnapshot();
    assert.deepEqual(latest.source_distribution, []);
    assert.deepEqual(latest.rank_distribution, []);
    assert.deepEqual(latest.lifecycle_distribution, []);

    h.db.updateProxyById(proxy.id, { rank: '神秘军衔', updated_at: now });
    const board = h.db.getRankBoard();
    assert.equal(board.some((x) => x.rank === '神秘军衔'), true);

    cleanup(h);
});

test('honor and retirement APIs should work', () => {
    const h = createDb();
    const now = new Date().toISOString();

    h.db.upsertSourceBatch(
        [{ ip: '3.3.3.3', port: 1080, protocol: 'socks5' }],
        () => '雪豹-惊雷-03',
        'src',
        'batch',
        now,
    );
    const proxy = h.db.getProxyByKey('3.3.3.3:1080:socks5');

    h.db.upsertHonor({
        proxy_id: proxy.id,
        display_name: proxy.display_name,
        honor_type: '钢铁连胜',
        reason: '连续成功',
        awarded_at: now,
    });
    h.db.refreshHonorActive(proxy.id, []);
    h.db.refreshHonorActive(proxy.id, ['钢铁连胜']);

    h.db.insertRetirement({
        proxy_id: proxy.id,
        display_name: proxy.display_name,
        retired_type: '荣誉退伍',
        reason: '长期稳定',
        retired_at: now,
    });

    const honors = h.db.getHonors(10);
    const retires = h.db.getRetirements(10);

    assert.equal(honors.length, 1);
    assert.equal(honors[0].active, 1);
    assert.equal(retires.length, 1);

    cleanup(h);
});

test('query list APIs should support filters and distributions', () => {
    const h = createDb();
    const now = new Date().toISOString();

    h.db.upsertSourceBatch(
        [
            { ip: '4.4.4.4', port: 80, protocol: 'http' },
            { ip: '4.4.4.5', port: 443, protocol: 'https' },
        ],
        (() => {
            let i = 0;
            return () => {
                i += 1;
                return `远征-北辰-0${i}`;
            };
        })(),
        'src-dist',
        'batch',
        now,
    );

    const all = h.db.getProxyList({ limit: 50 });
    assert.equal(all.length, 2);
    assert.equal(Object.prototype.hasOwnProperty.call(all[0], 'last_battle_outcome'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(all[0], 'battle_success_count'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(all[0], 'last_validation_ok'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(all[0], 'ip_value_score'), true);

    h.db.updateProxyById(all[0].id, { rank: '士官', lifecycle: 'active', updated_at: now });

    const filtered = h.db.getProxyList({ limit: 10, rank: '士官', lifecycle: 'active' });
    assert.equal(filtered.length, 1);

    assert.equal(h.db.getSourceDistribution().length, 1);
    assert.equal(h.db.getLifecycleDistribution().length >= 1, true);
    assert.equal(h.db.getRankBoard().length >= 1, true);

    cleanup(h);
});

test('value board API should sort by value and parse breakdown and honor fields', () => {
    const h = createDb();
    const now = new Date().toISOString();

    h.db.upsertSourceBatch(
        [
            { ip: '6.6.6.1', port: 80, protocol: 'http' },
            { ip: '6.6.6.2', port: 80, protocol: 'http' },
        ],
        (() => {
            let i = 0;
            return () => `价值-${++i}`;
        })(),
        'src-value',
        'batch-value',
        now,
    );

    const all = h.db.getProxyList({ limit: 10 });
    h.db.updateProxyById(all[0].id, {
        lifecycle: 'active',
        ip_value_score: 88.3,
        ip_value_breakdown_json: JSON.stringify({ grade: 'A' }),
        honor_active_json: JSON.stringify(['钢铁连胜']),
        success_count: 8,
        total_samples: 10,
        battle_success_count: 3,
        battle_fail_count: 1,
        updated_at: now,
    });
    h.db.updateProxyById(all[1].id, {
        lifecycle: 'reserve',
        ip_value_score: 40,
        ip_value_breakdown_json: '[]',
        honor_active_json: '',
        updated_at: now,
    });

    const board = h.db.getValueBoard(10);
    assert.equal(board.length, 2);
    assert.equal(board[0].ip_value_score >= board[1].ip_value_score, true);
    assert.equal(board[0].ip_value_breakdown.grade, 'A');
    assert.deepEqual(board[1].ip_value_breakdown, {});
    assert.deepEqual(board[1].honor_active, []);
    assert.equal(board[0].success_ratio, 0.8);
    assert.equal(board[0].battle_ratio, 0.75);

    const filtered = h.db.getValueBoard(10, 'active');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].lifecycle, 'active');

    h.db.updateProxyById(all[1].id, {
        ip_value_breakdown_json: '',
        updated_at: now,
    });
    const emptyBreakdown = h.db.getValueBoard(10);
    assert.deepEqual(emptyBreakdown[1].ip_value_breakdown, {});

    h.db.updateProxyById(all[1].id, {
        ip_value_breakdown_json: '{bad',
        updated_at: now,
    });
    const badBreakdown = h.db.getValueBoard(10);
    assert.deepEqual(badBreakdown[1].ip_value_breakdown, {});

    const fallbackLimit = h.db.getValueBoard('bad');
    assert.equal(fallbackLimit.length >= 1, true);
    const clampedLimit = h.db.getValueBoard(0);
    assert.equal(clampedLimit.length >= 1, true);

    cleanup(h);
});

test('battle APIs should persist run details and support L1/L2 candidate selection', () => {
    const h = createDb();
    const now = new Date().toISOString();

    h.db.upsertSourceBatch(
        [
            { ip: '7.7.7.1', port: 80, protocol: 'http' },
            { ip: '7.7.7.2', port: 80, protocol: 'http' },
            { ip: '7.7.7.3', port: 80, protocol: 'http' },
        ],
        (() => {
            let i = 0;
            return () => `战场-${++i}`;
        })(),
        'src-battle',
        'batch-battle',
        now,
    );

    const all = h.db.getProxyList({ limit: 10 });
    h.db.updateProxyById(all[0].id, { lifecycle: 'active', updated_at: now });
    h.db.updateProxyById(all[1].id, { lifecycle: 'reserve', updated_at: now });
    h.db.updateProxyById(all[2].id, { lifecycle: 'candidate', updated_at: now });

    const l1Candidates = h.db.listProxiesForBattleL1(3, 0.34);
    assert.equal(l1Candidates.length, 3);

    h.db.insertBattleTestRun({
        timestamp: now,
        proxy_id: all[0].id,
        stage: 'l1',
        target: 'httpbin/ip',
        outcome: 'success',
        status_code: 200,
        latency_ms: 50,
        reason: 'ok',
        details: { ip: '1.2.3.4' },
    });

    const l2Candidates = h.db.listProxiesForBattleL2(2, 10);
    assert.equal(l2Candidates.some((item) => item.id === all[0].id), true);

    const runs = h.db.getBattleTestRuns(5);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].stage, 'l1');

    cleanup(h);
});

test('snapshot APIs should persist and apply retention cleanup', () => {
    const h = createDb({ snapshotRetentionDays: 0 });

    const oldTs = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    h.db.insertPoolSnapshot({
        timestamp: oldTs,
        workers_total: 6,
        workers_busy: 1,
        queue_size: 0,
        completed_tasks: 10,
        failed_tasks: 0,
        restarted_workers: 0,
        source_distribution: [{ source: 'old', count: 1 }],
        rank_distribution: [{ rank: '新兵', count: 1 }],
        lifecycle_distribution: [{ lifecycle: 'candidate', count: 1 }],
    });

    const latestTs = new Date(Date.now() + 2000).toISOString();
    h.db.insertPoolSnapshot({
        timestamp: latestTs,
        workers_total: 6,
        workers_busy: 2,
        queue_size: 3,
        completed_tasks: 20,
        failed_tasks: 1,
        restarted_workers: 0,
        source_distribution: [{ source: 'new', count: 2 }],
        rank_distribution: [{ rank: '列兵', count: 2 }],
        lifecycle_distribution: [{ lifecycle: 'active', count: 2 }],
    });

    const latest = h.db.getLatestSnapshot();
    assert.equal(latest.workers_busy, 2);
    assert.equal(Array.isArray(latest.source_distribution), true);
    const count = h.db.db.prepare('SELECT COUNT(*) AS c FROM pool_snapshots').get().c;
    assert.equal(count, 1);

    cleanup(h);
});

test('snapshot retention should cleanup by timestamp when retentionDays is positive', () => {
    const h = createDb({ snapshotRetentionDays: 1 });
    const now = Date.now();

    h.db.insertPoolSnapshot({
        timestamp: new Date(now - 2 * 24 * 3600 * 1000).toISOString(),
        workers_total: 6,
        workers_busy: 0,
        queue_size: 0,
        completed_tasks: 1,
        failed_tasks: 0,
        restarted_workers: 0,
        source_distribution: [{ source: 'old', count: 1 }],
        rank_distribution: [{ rank: '新兵', count: 1 }],
        lifecycle_distribution: [{ lifecycle: 'candidate', count: 1 }],
    });
    h.db.insertPoolSnapshot({
        timestamp: new Date(now).toISOString(),
        workers_total: 6,
        workers_busy: 1,
        queue_size: 0,
        completed_tasks: 2,
        failed_tasks: 0,
        restarted_workers: 0,
        source_distribution: [{ source: 'new', count: 1 }],
        rank_distribution: [{ rank: '列兵', count: 1 }],
        lifecycle_distribution: [{ lifecycle: 'active', count: 1 }],
    });

    const count = h.db.db.prepare('SELECT COUNT(*) AS c FROM pool_snapshots').get().c;
    const latest = h.db.getLatestSnapshot();
    assert.equal(count, 1);
    assert.equal(latest.workers_busy, 1);

    cleanup(h);
});

test('db branch helpers should cover migration and battle edge branches', () => {
    const h = createDb();

    // parseJsonArray catch path
    h.db.insertPoolSnapshot({
        timestamp: new Date().toISOString(),
        workers_total: 1,
        workers_busy: 0,
        queue_size: 0,
        completed_tasks: 0,
        failed_tasks: 0,
        restarted_workers: 0,
        source_distribution: [],
        rank_distribution: [],
        lifecycle_distribution: [],
    });
    h.db.db.prepare(`
        UPDATE pool_snapshots
        SET source_distribution_json = '{bad',
            rank_distribution_json = '{bad',
            lifecycle_distribution_json = '{bad'
        WHERE id = (SELECT id FROM pool_snapshots ORDER BY id DESC LIMIT 1)
    `).run();
    const latest = h.db.getLatestSnapshot();
    assert.deepEqual(latest.source_distribution, []);
    assert.deepEqual(latest.rank_distribution, []);
    assert.deepEqual(latest.lifecycle_distribution, []);
    h.db.db.prepare(`
        UPDATE pool_snapshots
        SET source_distribution_json = '{}'
        WHERE id = (SELECT id FROM pool_snapshots ORDER BY id DESC LIMIT 1)
    `).run();
    const latestObj = h.db.getLatestSnapshot();
    assert.deepEqual(latestObj.source_distribution, []);

    // safeLimit=0 guard branches
    assert.deepEqual(h.db.listProxiesForBattleL1(0, 0.5), []);
    assert.deepEqual(h.db.listProxiesForBattleL2(0, 10), []);
    assert.deepEqual(h.db.listProxiesForBattleL1(3, 'not-a-number'), []);

    // merged.length === 0 branch in L1 filler query
    assert.deepEqual(h.db.listProxiesForBattleL1(3, 0.2), []);

    // insertBattleTestRun fallbacks for nullable numeric fields
    h.db.upsertSourceBatch(
        [{ ip: '8.8.8.8', port: 8080, protocol: 'http' }],
        () => '覆盖-边界-01',
        'src',
        'batch',
        new Date().toISOString(),
    );
    const proxy = h.db.getProxyByKey('8.8.8.8:8080:http');
    h.db.insertBattleTestRun({
        timestamp: new Date().toISOString(),
        proxy_id: proxy.id,
        stage: 'l1',
        target: 'x',
        outcome: 'network_error',
        status_code: Number.NaN,
        latency_ms: Number.NaN,
        details: null,
    });
    const runs = h.db.getBattleTestRuns(5);
    assert.equal(runs[0].status_code, null);
    assert.equal(runs[0].latency_ms, null);

    cleanup(h);
});

test('ensureProxyColumns should add missing columns in legacy schema', () => {
    const execCalls = [];
    const fake = {
        db: {
            prepare(sql) {
                assert.equal(sql, 'PRAGMA table_info(proxies)');
                return {
                    all() {
                        return [{ name: 'id' }, { name: 'source' }];
                    },
                };
            },
            exec(sql) {
                execCalls.push(sql);
            },
        },
    };

    ProxyHubDb.prototype.ensureProxyColumns.call(fake);
    assert.equal(execCalls.length > 0, true);
    assert.equal(execCalls.every((sql) => sql.includes('ALTER TABLE proxies ADD COLUMN')), true);
});

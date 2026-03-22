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
    assert.deepEqual(first, { inserted: 1, touched: 0, skipped: 0 });

    const second = h.db.upsertSourceBatch(
        [{ ip: '1.1.1.1', port: 80, protocol: 'http' }],
        () => '不会用到',
        'srcB',
        'batchB',
        now,
    );
    assert.deepEqual(second, { inserted: 0, touched: 1, skipped: 0 });

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
    assert.equal(Object.prototype.hasOwnProperty.call(all[0], 'service_branch'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(all[0], 'branch_fail_streak'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(all[0], 'native_place'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(all[0], 'native_lookup_status'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(all[0], 'native_lookup_raw_json'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(all[0], 'native_lookup_readable_text'), true);
    assert.equal(all[0].service_branch, '陆军');
    assert.equal(all[0].branch_fail_streak, 0);
    assert.equal(all[0].native_place, '未知');
    assert.equal(all[0].native_lookup_status, 'pending');

    h.db.updateProxyById(all[0].id, {
        rank: '士官',
        lifecycle: 'active',
        service_branch: '海军',
        branch_fail_streak: 2,
        ip_value_score: 88,
        updated_at: now,
    });

    const filtered = h.db.getProxyList({ limit: 10, rank: '士官', lifecycle: 'active' });
    assert.equal(filtered.length, 1);
    const branchFiltered = h.db.getProxyList({ limit: 10, serviceBranch: '海军' });
    assert.equal(branchFiltered.length, 1);
    assert.equal(branchFiltered[0].service_branch, '海军');
    const valueBoardByBranch = h.db.getValueBoard(10, undefined, { serviceBranch: '海军' });
    assert.equal(valueBoardByBranch.length, 1);
    assert.equal(valueBoardByBranch[0].service_branch, '海军');

    assert.equal(h.db.getSourceDistribution().length, 1);
    assert.equal(h.db.getLifecycleDistribution().length >= 1, true);
    assert.equal(h.db.getRankBoard().length >= 1, true);
    assert.equal(h.db.getServiceBranchDistribution().some((item) => item.service_branch === '海军'), true);
    assert.equal(h.db.getServiceBranchDistribution({ excludeRetired: true }).some((item) => item.service_branch === '海军'), true);

    cleanup(h);
});

test('getRankBoard should keep 校官 and 将官 in canonical order', () => {
    const h = createDb();
    const now = new Date().toISOString();
    const rankOrder = ['新兵', '列兵', '士官', '尉官', '校官', '将官', '王牌'];

    h.db.upsertSourceBatch(
        rankOrder.map((_, index) => ({
            ip: `15.15.15.${index + 1}`,
            port: 80,
            protocol: 'http',
        })),
        (() => {
            let i = 0;
            return () => `军衔序-${++i}`;
        })(),
        'src-rank-board',
        'batch-rank-board',
        now,
    );

    const proxies = h.db.getProxyList({ limit: 20 });
    for (let i = 0; i < rankOrder.length; i += 1) {
        h.db.updateProxyById(proxies[i].id, {
            rank: rankOrder[i],
            updated_at: new Date(Date.parse(now) + i * 1000).toISOString(),
        });
    }

    const board = h.db.getRankBoard();
    const filtered = board
        .map((item) => item.rank)
        .filter((rank) => rankOrder.includes(rank));
    assert.deepEqual(filtered, rankOrder);

    cleanup(h);
});

test('excludeRetired filters should apply to boards, lists and distributions; recruit camp should split new recruits', () => {
    const h = createDb();
    const now = new Date().toISOString();

    h.db.upsertSourceBatch(
        [
            { ip: '31.0.0.1', port: 80, protocol: 'http' },
            { ip: '31.0.0.2', port: 80, protocol: 'http' },
            { ip: '31.0.0.3', port: 80, protocol: 'http' },
            { ip: '31.0.0.4', port: 80, protocol: 'http' },
            { ip: '31.0.0.5', port: 80, protocol: 'http' },
        ],
        (() => {
            let i = 0;
            return () => `训练营-${++i}`;
        })(),
        'src-camp',
        'batch-camp',
        now,
    );

    const proxies = h.db.getProxyList({ limit: 20 });
    h.db.updateProxyById(proxies[0].id, { rank: '新兵', lifecycle: 'active', updated_at: now });
    h.db.updateProxyById(proxies[1].id, { rank: '新兵', lifecycle: 'reserve', updated_at: now });
    h.db.updateProxyById(proxies[2].id, { rank: '新兵', lifecycle: 'candidate', updated_at: now });
    h.db.updateProxyById(proxies[3].id, { rank: '新兵', lifecycle: 'retired', updated_at: now });
    h.db.updateProxyById(proxies[4].id, { rank: '士官', lifecycle: 'retired', updated_at: now });

    const rankBoardAll = h.db.getRankBoard();
    const rankBoardFiltered = h.db.getRankBoard({ excludeRetired: true });
    const rankAllNewbie = rankBoardAll.find((x) => x.rank === '新兵')?.count || 0;
    const rankFilteredNewbie = rankBoardFiltered.find((x) => x.rank === '新兵')?.count || 0;
    assert.equal(rankAllNewbie, 4);
    assert.equal(rankFilteredNewbie, 3);
    assert.equal(rankBoardFiltered.some((x) => x.rank === '士官'), false);

    const lifecycleFiltered = h.db.getLifecycleDistribution({ excludeRetired: true });
    assert.equal(lifecycleFiltered.some((x) => x.lifecycle === 'retired'), false);

    const sourceFiltered = h.db.getSourceDistribution({ excludeRetired: true });
    assert.equal(sourceFiltered.length >= 1, true);

    const listFiltered = h.db.getProxyList({ limit: 20, excludeRetired: true });
    assert.equal(listFiltered.some((x) => x.lifecycle === 'retired'), false);

    const valueFiltered = h.db.getValueBoard(20, undefined, { excludeRetired: true });
    assert.equal(valueFiltered.some((x) => x.lifecycle === 'retired'), false);

    const camp = h.db.getRecruitCampBoard();
    assert.equal(camp.find((x) => x.lifecycle === 'active')?.count, 1);
    assert.equal(camp.find((x) => x.lifecycle === 'reserve')?.count, 1);
    assert.equal(camp.find((x) => x.lifecycle === 'candidate')?.count, 1);
    assert.equal(camp.find((x) => x.lifecycle === 'retired')?.count, 2);

    cleanup(h);
});

test('purgeSocks4Data should delete socks4 source/protocol rows and keep others', () => {
    const h = createDb();
    const now = new Date().toISOString();
    let seq = 0;
    const nextName = () => `清理-${++seq}`;

    h.db.upsertSourceBatch(
        [{ ip: '41.0.0.1', port: 80, protocol: 'http' }],
        nextName,
        'TheSpeedX/http',
        'batch-clean-1',
        now,
    );
    h.db.upsertSourceBatch(
        [{ ip: '41.0.0.2', port: 1080, protocol: 'socks4' }],
        nextName,
        'TheSpeedX/socks4',
        'batch-clean-2',
        now,
    );
    h.db.upsertSourceBatch(
        [{ ip: '41.0.0.3', port: 1080, protocol: 'socks4' }],
        nextName,
        'legacy-socks4-feed',
        'batch-clean-3',
        now,
    );
    h.db.upsertSourceBatch(
        [{ ip: '41.0.0.4', port: 80, protocol: 'http' }],
        nextName,
        'TheSpeedX/socks4',
        'batch-clean-4',
        now,
    );

    const summary = h.db.purgeSocks4Data({
        sourceName: 'TheSpeedX/socks4',
        protocol: 'socks4',
    });

    assert.equal(summary.beforeSource, 2);
    assert.equal(summary.beforeProtocol, 2);
    assert.equal(summary.deleted, 3);
    assert.equal(summary.afterSource, 0);
    assert.equal(summary.afterProtocol, 0);

    const remaining = h.db.getProxyList({ limit: 20 });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].source, 'TheSpeedX/http');

    cleanup(h);
});

test('purgeSocks4Data should support default source/protocol options', () => {
    const h = createDb();
    const now = new Date().toISOString();
    let seq = 0;
    const nextName = () => `默认清理-${++seq}`;

    h.db.upsertSourceBatch(
        [{ ip: '42.0.0.1', port: 1080, protocol: 'socks4' }],
        nextName,
        'TheSpeedX/socks4',
        'batch-default-clean-1',
        now,
    );
    h.db.upsertSourceBatch(
        [{ ip: '42.0.0.2', port: 1080, protocol: 'socks4' }],
        nextName,
        'legacy-socks4-feed',
        'batch-default-clean-2',
        now,
    );
    h.db.upsertSourceBatch(
        [{ ip: '42.0.0.3', port: 80, protocol: 'http' }],
        nextName,
        'TheSpeedX/http',
        'batch-default-clean-3',
        now,
    );

    const summary = h.db.purgeSocks4Data();
    assert.equal(summary.sourceName, 'TheSpeedX/socks4');
    assert.equal(summary.protocol, 'socks4');
    assert.equal(summary.deleted, 2);
    assert.equal(summary.afterSource, 0);
    assert.equal(summary.afterProtocol, 0);

    const remaining = h.db.getProxyList({ limit: 20 });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].source, 'TheSpeedX/http');

    cleanup(h);
});

test('getRecruitCampBoard should fallback invalid lifecycle counts to zero', () => {
    const h = createDb();
    const originalPrepare = h.db.db.prepare.bind(h.db.db);

    h.db.db.prepare = (sql) => {
        if (String(sql).includes('GROUP BY lifecycle')) {
            return {
                all() {
                    return [
                        { lifecycle: 'active', count: 'invalid' },
                        { lifecycle: 'reserve', count: 2 },
                        { lifecycle: 'unknown', count: 7 },
                    ];
                },
            };
        }
        return originalPrepare(sql);
    };

    try {
        const camp = h.db.getRecruitCampBoard();
        assert.equal(camp.find((item) => item.lifecycle === 'active')?.count, 0);
        assert.equal(camp.find((item) => item.lifecycle === 'reserve')?.count, 2);
        assert.equal(camp.find((item) => item.lifecycle === 'candidate')?.count, 0);
        assert.equal(camp.find((item) => item.lifecycle === 'retired')?.count, 0);
    } finally {
        h.db.db.prepare = originalPrepare;
        cleanup(h);
    }
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
        block_count: 1,
        timeout_count: 2,
        network_error_count: 3,
        invalid_feedback_count: 4,
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
        native_place: '中国-北京',
        native_country: '中国',
        native_city: '北京',
        native_provider: 'ipapi.co',
        native_lookup_status: 'resolved',
        native_lookup_raw_json: '{"status":"success","country":"中国","city":"北京"}',
        native_lookup_readable_text: '国家(country): "中国"\n城市(city): "北京"',
        updated_at: now,
    });

    h.db.insertBattleTestRun({
        timestamp: now,
        proxy_id: all[0].id,
        stage: 'l1',
        target: 'l1-a',
        outcome: 'success',
        status_code: 200,
        latency_ms: 20,
        reason: 'ok',
        details: {},
    });
    h.db.insertBattleTestRun({
        timestamp: now,
        proxy_id: all[0].id,
        stage: 'l1',
        target: 'l1-b',
        outcome: 'blocked',
        status_code: 403,
        latency_ms: 30,
        reason: 'blocked',
        details: {},
    });
    h.db.insertBattleTestRun({
        timestamp: now,
        proxy_id: all[0].id,
        stage: 'l1',
        target: 'l1-c',
        outcome: 'timeout',
        status_code: null,
        latency_ms: 35,
        reason: 'timeout',
        details: {},
    });
    h.db.insertBattleTestRun({
        timestamp: now,
        proxy_id: all[0].id,
        stage: 'l2',
        target: 'l2-a',
        outcome: 'success',
        status_code: 200,
        latency_ms: 40,
        reason: 'ok',
        details: {},
    });
    h.db.insertBattleTestRun({
        timestamp: now,
        proxy_id: all[0].id,
        stage: 'l2',
        target: 'l2-b',
        outcome: 'invalid_feedback',
        status_code: 200,
        latency_ms: 45,
        reason: 'bad',
        details: {},
    });
    h.db.insertBattleTestRun({
        timestamp: now,
        proxy_id: all[0].id,
        stage: 'l3',
        target: 'l3-a',
        outcome: 'network_error',
        status_code: null,
        latency_ms: 50,
        reason: 'err',
        details: {},
    });

    const board = h.db.getValueBoard(10);
    assert.equal(board.length, 2);
    assert.equal(board[0].ip_value_score >= board[1].ip_value_score, true);
    assert.equal(board[0].ip_value_breakdown.grade, 'A');
    assert.deepEqual(board[1].ip_value_breakdown, {});
    assert.deepEqual(board[1].honor_active, []);
    assert.equal(board[0].success_ratio, 0.8);
    assert.equal(board[0].battle_ratio, 0.75);
    assert.equal(board[0].l0_success_count, 8);
    assert.equal(board[0].l0_fail_count, 10);
    assert.equal(board[0].l1_success_count, 1);
    assert.equal(board[0].l1_fail_count, 2);
    assert.equal(board[0].l2_success_count, 1);
    assert.equal(board[0].l2_fail_count, 1);
    assert.equal(board[0].l3_success_count, 0);
    assert.equal(board[0].l3_fail_count, 1);
    assert.equal(board[0].native_place, '未知');
    assert.equal(board[0].native_lookup_status, 'pending');
    assert.equal(board[1].l0_success_count, 0);
    assert.equal(board[1].l0_fail_count, 0);
    assert.equal(board[1].l1_success_count, 0);
    assert.equal(board[1].l1_fail_count, 0);
    assert.equal(board[1].l2_success_count, 0);
    assert.equal(board[1].l2_fail_count, 0);
    assert.equal(board[1].l3_success_count, 0);
    assert.equal(board[1].l3_fail_count, 0);
    assert.equal(board[1].native_place, '中国-北京');
    assert.equal(board[1].native_lookup_status, 'resolved');
    assert.equal(board[1].native_lookup_raw_json.includes('"country":"中国"'), true);
    assert.equal(board[1].native_lookup_readable_text.includes('国家(country)'), true);

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

test('battle APIs should persist run details and support L1/L2/L3 candidate selection', () => {
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

    h.db.insertBattleTestRun({
        timestamp: now,
        proxy_id: all[1].id,
        stage: 'l2',
        target: 'ly-browser',
        outcome: 'success',
        status_code: 200,
        latency_ms: 60,
        reason: 'ok',
        details: { mode: 'browser' },
    });
    h.db.insertBattleTestRun({
        timestamp: now,
        proxy_id: all[2].id,
        stage: 'l2',
        target: 'ly-browser',
        outcome: 'success',
        status_code: 200,
        latency_ms: 65,
        reason: 'ok',
        details: { mode: 'browser' },
    });
    h.db.updateProxyById(all[2].id, { protocol: 'socks4', updated_at: now });

    const l3HttpCandidates = h.db.listProxiesForBattleL3(5, 10, ['http']);
    assert.equal(l3HttpCandidates.some((item) => item.id === all[1].id), true);
    assert.equal(l3HttpCandidates.some((item) => item.id === all[2].id), false);
    const l3WithNullableProtocol = h.db.listProxiesForBattleL3(5, 10, ['http', null]);
    assert.equal(l3WithNullableProtocol.some((item) => item.id === all[1].id), true);
    const l3AllCandidates = h.db.listProxiesForBattleL3(5, 10, []);
    assert.equal(l3AllCandidates.some((item) => item.id === all[2].id), true);
    const l3FallbackArgs = h.db.listProxiesForBattleL3(5, 'bad', null, 'invalid-now');
    assert.equal(Array.isArray(l3FallbackArgs), true);
    assert.deepEqual(h.db.listProxiesForBattleL3(0, 10, ['http']), []);

    const runs = h.db.getBattleTestRuns(5);
    assert.equal(runs.length, 3);
    assert.equal(runs.some((run) => run.stage === 'l1'), true);
    assert.equal(runs.some((run) => run.stage === 'l2'), true);

    cleanup(h);
});

test('candidate selectors should skip proxies in failure backoff window', () => {
    const h = createDb();
    const now = '2026-03-16T12:00:00.000Z';
    const future = '2026-03-16T13:00:00.000Z';

    h.db.upsertSourceBatch(
        [
            { ip: '17.7.7.1', port: 80, protocol: 'http' },
            { ip: '17.7.7.2', port: 80, protocol: 'http' },
            { ip: '17.7.7.3', port: 80, protocol: 'http' },
        ],
        (() => {
            let i = 0;
            return () => `退避-${++i}`;
        })(),
        'src-backoff',
        'batch-backoff',
        now,
    );

    const all = h.db.getProxyList({ limit: 10 });
    h.db.updateProxyById(all[0].id, { lifecycle: 'active', backoff_until: future, backoff_reason: 'l1:network_error', updated_at: now });
    h.db.updateProxyById(all[1].id, { lifecycle: 'reserve', updated_at: now });
    h.db.updateProxyById(all[2].id, { lifecycle: 'candidate', updated_at: now });

    const validationCandidates = h.db.listProxiesForValidation(10, now);
    assert.equal(validationCandidates.some((item) => item.id === all[0].id), false);

    const l1Candidates = h.db.listProxiesForBattleL1(3, { active: 0.5, reserve: 0.3, candidate: 0.2 }, now);
    assert.equal(l1Candidates.some((item) => item.id === all[0].id), false);

    h.db.insertBattleTestRun({
        timestamp: now,
        proxy_id: all[1].id,
        stage: 'l1',
        target: 'httpbin/ip',
        outcome: 'success',
        status_code: 200,
        latency_ms: 50,
        reason: 'ok',
        details: {},
    });
    h.db.updateProxyById(all[1].id, {
        backoff_until: future,
        backoff_reason: 'l2:network_error',
        updated_at: now,
    });

    const l2Candidates = h.db.listProxiesForBattleL2(3, 120, now);
    assert.equal(l2Candidates.some((item) => item.id === all[1].id), false);

    h.db.insertBattleTestRun({
        timestamp: now,
        proxy_id: all[2].id,
        stage: 'l2',
        target: 'ly',
        outcome: 'success',
        status_code: 200,
        latency_ms: 50,
        reason: 'ok',
        details: {},
    });
    h.db.updateProxyById(all[2].id, {
        backoff_until: future,
        backoff_reason: 'l3:network_error',
        updated_at: now,
    });
    const l3Candidates = h.db.listProxiesForBattleL3(3, 120, ['http'], now);
    assert.equal(l3Candidates.some((item) => item.id === all[2].id), false);

    cleanup(h);
});

test('retirement stats APIs should return count and daily series', () => {
    const h = createDb();
    const now = '2026-03-16T12:00:00.000Z';
    h.db.upsertSourceBatch(
        [{ ip: '8.8.4.4', port: 80, protocol: 'http' }],
        () => '统计-退役-01',
        'src-stats',
        'batch-stats',
        now,
    );
    const proxy = h.db.getProxyByKey('8.8.4.4:80:http');
    h.db.insertRetirement({
        proxy_id: proxy.id,
        display_name: proxy.display_name,
        retired_type: '技术退伍',
        reason: 'x',
        retired_at: '2026-03-15T01:00:00.000Z',
    });
    h.db.insertRetirement({
        proxy_id: proxy.id,
        display_name: proxy.display_name,
        retired_type: '纪律退伍',
        reason: 'x',
        retired_at: '2026-03-16T02:00:00.000Z',
    });

    assert.equal(h.db.getRetirementsCountSince('2026-03-15T00:00:00.000Z'), 2);
    const daily = h.db.getRetirementDailyCounts(7, now);
    assert.equal(Array.isArray(daily), true);
    assert.equal(daily.some((item) => item.day === '2026-03-16' && item.count >= 1), true);

    cleanup(h);
});

test('battle stats APIs should return active count and stage success rate', () => {
    const h = createDb();
    const now = '2026-03-16T12:00:00.000Z';
    h.db.upsertSourceBatch(
        [{ ip: '1.2.3.4', port: 80, protocol: 'http' }],
        () => '统计-战场-01',
        'src-battle-stats',
        'batch-battle-stats',
        now,
    );
    const proxy = h.db.getProxyByKey('1.2.3.4:80:http');
    h.db.updateProxyById(proxy.id, {
        lifecycle: 'active',
        updated_at: now,
    });

    h.db.insertBattleTestRun({
        timestamp: '2026-03-16T10:00:00.000Z',
        proxy_id: proxy.id,
        stage: 'l2',
        target: 'ly',
        outcome: 'success',
        status_code: 200,
        latency_ms: 100,
        reason: 'ok',
        details: {},
    });
    h.db.insertBattleTestRun({
        timestamp: '2026-03-16T10:10:00.000Z',
        proxy_id: proxy.id,
        stage: 'l2',
        target: 'ly',
        outcome: 'blocked',
        status_code: 403,
        latency_ms: 100,
        reason: 'blocked',
        details: {},
    });

    assert.equal(h.db.getActiveCount(), 1);
    assert.equal(h.db.getLifecycleCount('active'), 1);
    const l2 = h.db.getBattleSuccessRateSince('l2', '2026-03-16T09:00:00.000Z');
    assert.equal(l2.total, 2);
    assert.equal(l2.success, 1);
    assert.equal(l2.successRate, 0.5);

    const noData = h.db.getBattleSuccessRateSince('l1', '2099-01-01T00:00:00.000Z');
    assert.equal(noData.total, 0);
    assert.equal(noData.successRate, 0);

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

test('snapshot retention should fallback to Date.now when snapshot timestamp is invalid', () => {
    const h = createDb({ snapshotRetentionDays: 1 });
    const now = Date.parse('2026-03-20T12:00:00.000Z');
    const oldNow = Date.now;
    Date.now = () => now;

    try {
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
            timestamp: 'invalid-timestamp',
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
    } finally {
        Date.now = oldNow;
    }

    const count = h.db.db.prepare('SELECT COUNT(*) AS c FROM pool_snapshots').get().c;
    const latest = h.db.getLatestSnapshot();
    assert.equal(count, 1);
    assert.equal(latest.timestamp, 'invalid-timestamp');

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

test('candidate selectors should accept invalid nowIso fallback path', () => {
    const h = createDb();
    const now = '2026-03-16T12:00:00.000Z';
    h.db.upsertSourceBatch(
        [{ ip: '18.8.8.8', port: 8080, protocol: 'http' }],
        () => '覆盖-时间回退-01',
        'src',
        'batch',
        now,
    );
    const proxy = h.db.getProxyByKey('18.8.8.8:8080:http');
    h.db.updateProxyById(proxy.id, {
        lifecycle: 'active',
        updated_at: now,
    });
    h.db.insertBattleTestRun({
        timestamp: now,
        proxy_id: proxy.id,
        stage: 'l1',
        target: 'ipify',
        outcome: 'success',
        status_code: 200,
        latency_ms: 20,
        reason: 'ok',
        details: {},
    });

    assert.equal(Array.isArray(h.db.listProxiesForValidation(5, 'invalid-now')), true);
    assert.equal(Array.isArray(h.db.listProxiesForBattleL1(5, 0.2, 'invalid-now')), true);
    assert.equal(Array.isArray(h.db.listProxiesForBattleL2(5, 30, 'invalid-now')), true);
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
    assert.equal(execCalls.some((sql) => sql.includes('native_lookup_readable_text')), true);
});

// 0217_createNameGenerator_创建迁移姓名生成器逻辑
function createNameGenerator(pool) {
    const names = [...pool];
    let index = 0;
    return (isUnique) => {
        while (index < names.length) {
            const candidate = names[index];
            index += 1;
            if (isUnique(candidate)) {
                return candidate;
            }
        }
        throw new Error('name-pool-exhausted');
    };
}

test('renameAllDisplayNames dry-run should return mappings without changing data', () => {
    const h = createDb();
    const now = new Date().toISOString();

    h.db.upsertSourceBatch(
        [
            { ip: '10.1.1.1', port: 80, protocol: 'http' },
            { ip: '10.1.1.2', port: 80, protocol: 'http' },
        ],
        (() => {
            const old = ['苍隼-北辰-01', '雷霄-玄武-08'];
            let i = 0;
            return () => old[i++];
        })(),
        'src-rename',
        'batch-rename',
        now,
    );

    const before = h.db.getProxyList({ limit: 10 }).map((item) => item.display_name);
    const preview = h.db.renameAllDisplayNames({
        dryRun: true,
        sample: 2,
        generateName: createNameGenerator(['张三', '李四']),
    });

    const after = h.db.getProxyList({ limit: 10 }).map((item) => item.display_name);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.applied, false);
    assert.equal(preview.summary.total, 2);
    assert.equal(preview.sampleMappings.length, 2);
    assert.deepEqual(after.sort(), before.sort());

    cleanup(h);
});

test('renameAllDisplayNames apply should sync all display-name tables', () => {
    const h = createDb();
    const now = new Date().toISOString();

    h.db.upsertSourceBatch(
        [
            { ip: '10.2.2.1', port: 80, protocol: 'http' },
            { ip: '10.2.2.2', port: 80, protocol: 'http' },
        ],
        (() => {
            const old = ['苍隼-北辰-01', '雷霄-玄武-08'];
            let i = 0;
            return () => old[i++];
        })(),
        'src-rename-apply',
        'batch-rename-apply',
        now,
    );

    const proxies = h.db.getProxyList({ limit: 10 }).sort((a, b) => a.id - b.id);
    for (const proxy of proxies) {
        h.db.insertProxyEvent({
            timestamp: now,
            proxy_id: proxy.id,
            display_name: proxy.display_name,
            event_type: 'promotion',
            level: 'info',
            message: `晋升：${proxy.display_name}`,
            details: {},
        });
        h.db.upsertHonor({
            proxy_id: proxy.id,
            display_name: proxy.display_name,
            honor_type: `荣誉-${proxy.id}`,
            reason: 'x',
            awarded_at: now,
        });
        h.db.insertRetirement({
            proxy_id: proxy.id,
            display_name: proxy.display_name,
            retired_type: '技术退伍',
            reason: 'x',
            retired_at: now,
        });
        h.db.insertRuntimeLog({
            timestamp: now,
            event: '开始评分',
            proxy_name: proxy.display_name,
            ip_source: 'src',
            stage: '评分',
            result: 'ok',
            reason: 'x',
            action: 'x',
        });
    }
    h.db.insertRuntimeLog({
        timestamp: now,
        event: '系统事件',
        proxy_name: '-',
        ip_source: 'src',
        stage: '系统',
        result: 'ok',
        reason: 'x',
        action: 'x',
    });

    const outcome = h.db.renameAllDisplayNames({
        dryRun: false,
        sample: 5,
        generateName: createNameGenerator(['张三', '张三', '李四']),
    });

    assert.equal(outcome.applied, true);
    assert.equal(outcome.summary.changed, 2);
    assert.equal(outcome.tableUpdates.proxies, 2);
    assert.equal(outcome.tableUpdates.proxy_events >= 2, true);
    assert.equal(outcome.tableUpdates.honors >= 2, true);
    assert.equal(outcome.tableUpdates.retirements >= 2, true);
    assert.equal(outcome.tableUpdates.runtime_logs >= 2, true);
    assert.equal(outcome.oldPatternCounts.proxies, 0);
    assert.equal(outcome.oldPatternCounts.proxy_events, 0);
    assert.equal(outcome.oldPatternCounts.honors, 0);
    assert.equal(outcome.oldPatternCounts.retirements, 0);
    assert.equal(outcome.oldPatternCounts.runtime_logs, 0);

    const names = h.db.getProxyList({ limit: 10 }).map((item) => item.display_name).sort();
    assert.deepEqual(names, ['张三', '李四']);
    assert.equal(h.db.getEvents(10).every((item) => ['张三', '李四'].includes(item.display_name)), true);
    assert.equal(h.db.getHonors(10).every((item) => ['张三', '李四'].includes(item.display_name)), true);
    assert.equal(h.db.getRetirements(10).every((item) => ['张三', '李四'].includes(item.display_name)), true);
    assert.equal(h.db.getRuntimeLogs(20).some((item) => item.proxy_name === '-'), true);

    cleanup(h);
});

test('renameAllDisplayNames should update legacy proxy_events rows with null proxy_id by old name', () => {
    const h = createDb();
    const now = new Date().toISOString();

    h.db.upsertSourceBatch(
        [{ ip: '10.2.3.1', port: 80, protocol: 'http' }],
        () => '苍隼-北辰-01',
        'src-rename-legacy-null',
        'batch-rename-legacy-null',
        now,
    );

    const proxy = h.db.getProxyList({ limit: 10 })[0];
    h.db.insertProxyEvent({
        timestamp: now,
        proxy_id: null,
        display_name: proxy.display_name,
        event_type: 'legacy',
        level: 'info',
        message: 'legacy null proxy id',
        details: {},
    });

    const outcome = h.db.renameAllDisplayNames({
        dryRun: false,
        generateName: createNameGenerator(['张三']),
    });

    assert.equal(outcome.applied, true);
    assert.equal(outcome.oldPatternCounts.proxy_events, 0);
    assert.equal(h.db.getEvents(10).every((item) => item.display_name === '张三'), true);
    cleanup(h);
});

test('renameAllDisplayNames should rollback when transaction throws', () => {
    const h = createDb();
    const now = new Date().toISOString();

    h.db.upsertSourceBatch(
        [{ ip: '10.3.3.1', port: 80, protocol: 'http' }],
        () => '苍隼-北辰-01',
        'src-rename-rollback',
        'batch-rename-rollback',
        now,
    );

    const before = h.db.getProxyList({ limit: 10 })[0].display_name;
    assert.throws(
        () => h.db.renameAllDisplayNames({
            dryRun: false,
            generateName: createNameGenerator(['张三']),
            debugFailAfterProxyUpdate: true,
        }),
        /rename-debug-failure-after-proxy-update/,
    );
    const after = h.db.getProxyList({ limit: 10 })[0].display_name;
    assert.equal(after, before);

    cleanup(h);
});

test('renameAllDisplayNames should throw when generated name is invalid', () => {
    const h = createDb();
    const now = new Date().toISOString();

    h.db.upsertSourceBatch(
        [{ ip: '10.4.4.1', port: 80, protocol: 'http' }],
        () => '苍隼-北辰-01',
        'src-rename-invalid',
        'batch-rename-invalid',
        now,
    );

    assert.throws(
        () => h.db.renameAllDisplayNames({
            dryRun: true,
            generateName: () => '   ',
        }),
        /rename-generated-name-invalid/,
    );

    cleanup(h);
});

test('renameAllDisplayNames should require generateName callback', () => {
    const h = createDb();
    assert.throws(
        () => h.db.renameAllDisplayNames({
            dryRun: true,
        }),
        /rename-generate-name-required/,
    );
    cleanup(h);
});

test('renameAllDisplayNames should throw when uniqueness check fails', () => {
    const h = createDb();
    const now = new Date().toISOString();
    h.db.upsertSourceBatch(
        [{ ip: '10.5.5.1', port: 80, protocol: 'http' }],
        () => '苍隼-北辰-01',
        'src-rename-uniq',
        'batch-rename-uniq',
        now,
    );

    const originalPrepare = h.db.db.prepare.bind(h.db.db);
    h.db.db.prepare = (sql) => {
        if (String(sql).includes('COUNT(*) AS total, COUNT(DISTINCT display_name) AS unique_total')) {
            return {
                get() {
                    return { total: 2, unique_total: 1 };
                },
            };
        }
        return originalPrepare(sql);
    };

    try {
        assert.throws(
            () => h.db.renameAllDisplayNames({
                dryRun: false,
                generateName: createNameGenerator(['张三']),
            }),
            /rename-uniqueness-check-failed/,
        );
    } finally {
        h.db.db.prepare = originalPrepare;
    }

    cleanup(h);
});

test('renameAllDisplayNames should throw when old-style names remain in runtime logs', () => {
    const h = createDb();
    const now = new Date().toISOString();

    h.db.upsertSourceBatch(
        [{ ip: '10.6.6.1', port: 80, protocol: 'http' }],
        () => '苍隼-北辰-01',
        'src-rename-old-pattern',
        'batch-rename-old-pattern',
        now,
    );
    h.db.insertRuntimeLog({
        timestamp: now,
        event: 'system',
        proxy_name: '残留-1',
        ip_source: 'src',
        stage: 'system',
        result: 'ok',
        reason: '-',
        action: '-',
    });

    const before = h.db.getProxyList({ limit: 10 })[0].display_name;
    assert.throws(
        () => h.db.renameAllDisplayNames({
            dryRun: false,
            generateName: createNameGenerator(['张三']),
        }),
        /rename-old-pattern-remains:runtime_logs:1/,
    );
    const after = h.db.getProxyList({ limit: 10 })[0].display_name;
    assert.equal(after, before);

    cleanup(h);
});

test('battle daily success and snapshot median APIs should work', () => {
    const h = createDb();
    const now = '2026-03-16T12:00:00.000Z';

    h.db.upsertSourceBatch(
        [{ ip: '11.11.11.11', port: 80, protocol: 'http' }],
        () => '统计-滚动-01',
        'src',
        'batch',
        now,
    );
    const proxy = h.db.getProxyByKey('11.11.11.11:80:http');

    h.db.insertBattleTestRun({
        timestamp: '2026-03-15T10:00:00.000Z',
        proxy_id: proxy.id,
        stage: 'l2',
        target: 'ly',
        outcome: 'success',
        status_code: 200,
        latency_ms: 100,
        reason: 'ok',
        details: {},
    });
    h.db.insertBattleTestRun({
        timestamp: '2026-03-15T11:00:00.000Z',
        proxy_id: proxy.id,
        stage: 'l2',
        target: 'ly',
        outcome: 'blocked',
        status_code: 403,
        latency_ms: 100,
        reason: 'blocked',
        details: {},
    });
    h.db.insertBattleTestRun({
        timestamp: '2026-03-16T10:00:00.000Z',
        proxy_id: proxy.id,
        stage: 'l2',
        target: 'ly',
        outcome: 'success',
        status_code: 200,
        latency_ms: 100,
        reason: 'ok',
        details: {},
    });

    h.db.insertPoolSnapshot({
        timestamp: '2026-03-15T10:00:00.000Z',
        workers_total: 2,
        workers_busy: 0,
        queue_size: 0,
        completed_tasks: 1,
        failed_tasks: 0,
        restarted_workers: 0,
        lifecycle_distribution: [{ lifecycle: 'active', count: 30 }],
    });
    h.db.insertPoolSnapshot({
        timestamp: '2026-03-16T10:00:00.000Z',
        workers_total: 2,
        workers_busy: 0,
        queue_size: 0,
        completed_tasks: 1,
        failed_tasks: 0,
        restarted_workers: 0,
        lifecycle_distribution: [{ lifecycle: 'active', count: 50 }],
    });

    const l2Daily = h.db.getBattleDailySuccessRates('l2', 7, now);
    assert.equal(l2Daily.length >= 2, true);
    assert.equal(l2Daily.some((item) => item.day === '2026-03-15' && item.successRate === 0.5), true);

    const activeMedian = h.db.getLifecycleSnapshotMedian('active', 7, now);
    assert.equal(activeMedian, 40);

    h.db.insertPoolSnapshot({
        timestamp: '2026-03-16T11:00:00.000Z',
        workers_total: 2,
        workers_busy: 0,
        queue_size: 0,
        completed_tasks: 1,
        failed_tasks: 0,
        restarted_workers: 0,
        lifecycle_distribution: [{ lifecycle: 'active', count: 70 }],
    });
    const activeMedianOdd = h.db.getLifecycleSnapshotMedian('active', 7, now);
    assert.equal(activeMedianOdd, 50);

    cleanup(h);
});

test('battle daily and snapshot median helpers should cover fallback branches', () => {
    const h = createDb();

    const originalPrepare = h.db.db.prepare.bind(h.db.db);
    h.db.db.prepare = (sql) => {
        if (String(sql).includes('substr(timestamp, 1, 10) AS day')) {
            return {
                all() {
                    return [{ day: '2026-03-16', total: 0, success: null }];
                },
            };
        }
        return originalPrepare(sql);
    };

    try {
        const daily = h.db.getBattleDailySuccessRates(undefined, 'bad', '2026-03-16T12:00:00.000Z');
        assert.equal(daily.length, 1);
        assert.equal(daily[0].total, 0);
        assert.equal(daily[0].success, 0);
        assert.equal(daily[0].successRate, 0);
    } finally {
        h.db.db.prepare = originalPrepare;
    }

    assert.equal(h.db.getLifecycleSnapshotMedian(undefined, 'bad', '2026-03-16T12:00:00.000Z'), null);
    assert.equal(h.db.getLifecycleCount(), 0);
    cleanup(h);
});

test('candidate sweeper query should return stale candidate reasons', () => {
    const h = createDb();
    const nowIso = '2026-03-16T12:00:00.000Z';
    h.db.upsertSourceBatch(
        [
            { ip: '12.12.12.1', port: 80, protocol: 'http' },
            { ip: '12.12.12.2', port: 81, protocol: 'http' },
        ],
        (() => {
            let i = 0;
            return () => `清库存-${++i}`;
        })(),
        'src',
        'batch',
        nowIso,
    );

    const all = h.db.getProxyList({ limit: 10 });
    h.db.updateProxyById(all[0].id, {
        created_at: '2026-03-15T10:00:00.000Z',
        total_samples: 1,
        updated_at: nowIso,
    });
    h.db.updateProxyById(all[1].id, {
        created_at: '2026-03-12T10:00:00.000Z',
        total_samples: 10,
        updated_at: nowIso,
    });

    const sweepList = h.db.listCandidatesForSweep({
        nowIso,
        staleHours: 'bad',
        staleMinSamples: 'bad',
        timeoutHours: 'bad',
        limit: 'bad',
    });
    assert.equal(sweepList.length, 2);
    assert.equal(sweepList.some((item) => item.sweep_reason === 'stale_candidate'), true);
    assert.equal(sweepList.some((item) => item.sweep_reason === 'stale_timeout'), true);

    cleanup(h);
});

test('candidate sweeper should handle invalid created_at age fallback', () => {
    const h = createDb();
    const originalPrepare = h.db.db.prepare.bind(h.db.db);
    h.db.db.prepare = (sql) => {
        if (String(sql).includes("WHERE lifecycle = 'candidate'")) {
            return {
                all() {
                    return [{
                        id: 1,
                        display_name: '清库存-异常时间',
                        lifecycle: 'candidate',
                        created_at: 'invalid-date',
                        total_samples: 0,
                    }];
                },
            };
        }
        return originalPrepare(sql);
    };

    try {
        const rows = h.db.listCandidatesForSweep({
            nowIso: '2026-03-16T12:00:00.000Z',
            staleHours: 24,
            staleMinSamples: 3,
            timeoutHours: 72,
            limit: 10,
        });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].sweep_reason, 'stale_candidate');
        assert.equal(rows[0].sweep_age_hours, null);
    } finally {
        h.db.db.prepare = originalPrepare;
    }

    cleanup(h);
});

test('upsertSourceBatch should support gate mode that only touches existing rows', () => {
    const h = createDb();
    const now = new Date().toISOString();

    h.db.upsertSourceBatch(
        [{ ip: '1.1.1.1', port: 80, protocol: 'http' }],
        () => '苍隼-北辰-01',
        'srcA',
        'batchA',
        now,
    );

    const gated = h.db.upsertSourceBatch(
        [
            { ip: '1.1.1.1', port: 80, protocol: 'http' },
            { ip: '2.2.2.2', port: 81, protocol: 'http' },
        ],
        () => '不会新增',
        'srcB',
        'batchB',
        now,
        { allowInsert: false },
    );

    assert.deepEqual(gated, { inserted: 0, touched: 1, skipped: 1 });
    assert.equal(h.db.getProxyByKey('2.2.2.2:81:http'), undefined);
    cleanup(h);
});

test('rollout switch state and events APIs should work', () => {
    const h = createDb();
    const nowIso = '2026-03-16T12:00:00.000Z';

    const state0 = h.db.getRolloutSwitchState(nowIso);
    assert.equal(state0.mode, 'SAFE');
    assert.equal(typeof state0.stable_since, 'string');

    const leaseA = h.db.acquireRolloutSwitchLease({
        owner: 'owner-a',
        nowIso,
        ttlMs: 120000,
    });
    assert.equal(leaseA, true);

    const leaseB = h.db.acquireRolloutSwitchLease({
        owner: 'owner-b',
        nowIso,
        ttlMs: 120000,
    });
    assert.equal(leaseB, false);

    h.db.updateRolloutSwitchState({
        mode: 'COOLDOWN',
        stable_since: null,
        cooldown_until: '2026-03-17T12:00:00.000Z',
        last_tick_at: nowIso,
        last_error: null,
        nowIso,
    });
    const state1 = h.db.getRolloutSwitchState(nowIso);
    assert.equal(state1.mode, 'COOLDOWN');
    assert.equal(state1.cooldown_until, '2026-03-17T12:00:00.000Z');

    h.db.insertRolloutSwitchEvent({
        timestamp: nowIso,
        trigger: 'manual',
        action: 'rollback',
        mode_before: 'FULL',
        mode_after: 'COOLDOWN',
        patch: { honorPromotionTuning: false },
        details: { breaches: ['l2_drop'] },
    });
    const events = h.db.getRolloutSwitchEvents(10);
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'rollback');
    assert.equal(events[0].patch.honorPromotionTuning, false);

    cleanup(h);
});

test('rollout helpers should cover fallback branches for defaults and normalization', () => {
    const h = createDb();
    const nowIso = '2026-03-16T12:00:00.000Z';

    const normalized = h.db.normalizeLifecycleQuota({
        active: 'bad',
        reserve: undefined,
        candidate: null,
    });
    assert.equal(normalized.candidate, 0);
    assert.equal(normalized.active > 0, true);

    const lease = h.db.acquireRolloutSwitchLease({
        nowIso,
        ttlMs: 'bad',
    });
    assert.equal(lease, true);

    h.db.updateRolloutSwitchState({
        mode: null,
        stable_since: null,
        cooldown_until: null,
        last_tick_at: null,
        last_error: null,
        nowIso,
    });
    h.db.updateRolloutSwitchState({
        mode: 'SAFE',
        stable_since: '2026-03-16T11:00:00.000Z',
        cooldown_until: '2026-03-17T11:00:00.000Z',
        last_tick_at: '2026-03-16T12:00:00.000Z',
        last_error: 'none',
        nowIso: '2026-03-16T12:05:00.000Z',
    });
    h.db.updateRolloutSwitchState({
        mode: 'SAFE',
        nowIso: '2026-03-16T12:10:00.000Z',
    });

    h.db.insertRolloutSwitchEvent({
        timestamp: nowIso,
    });
    const events = h.db.getRolloutSwitchEvents('bad');
    assert.equal(events.length >= 1, true);
    assert.equal(events[0].trigger, 'manual');
    assert.equal(events[0].action, 'steady');
    assert.deepEqual(events[0].patch, {});
    assert.deepEqual(events[0].details, {});

    const retirementDaily = h.db.getRetirementDailyCounts('bad', nowIso);
    assert.equal(Array.isArray(retirementDaily), true);

    cleanup(h);
});

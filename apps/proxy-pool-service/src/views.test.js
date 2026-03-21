const test = require('node:test');
const assert = require('node:assert/strict');
const { renderProxyAdminPage } = require('./views/proxy-admin');
const { renderRuntimeLogsPage } = require('./views/runtime-logs');

test('renderProxyAdminPage should inject refresh interval', () => {
    const html = renderProxyAdminPage({ ui: { refreshMs: 4321 } });
    assert.equal(html.includes('4321ms'), true);
    assert.equal(html.includes('__REFRESH_MS__'), false);
    assert.equal(html.includes('IP价值榜（前100）'), true);
    assert.equal(html.includes('IP价值榜（前30）'), false);
    assert.equal(html.includes('/v1/proxies/value-board?limit=100'), true);
    assert.equal(html.includes('/v1/proxies/policy'), true);
    assert.equal(html.includes('/v1/proxies/recruit-camp'), true);
    assert.equal(html.includes('已退役：'), true);
    assert.equal(html.includes('active(新兵连)'), false);
    assert.equal(html.includes('退伍台账'), false);
    assert.equal(html.includes('代理明细（前50）'), false);
    assert.equal(html.includes('按价值分从高到低排的名次，1就是当前最有价值的IP。'), true);
    assert.equal(html.includes('系统一共'), true);
    assert.equal(html.includes("label: '编制'"), true);
    assert.equal(html.includes("const displayNameWithBranch ="), false);
    assert.equal(html.includes(" + ' [' + serviceBranch + ']'"), false);
    assert.equal(html.includes("esc(displayName) + '</td>'"), true);
    assert.equal(html.includes("esc(serviceBranch) + '</td>'"), true);
});

test('renderRuntimeLogsPage should return static html', () => {
    const html = renderRuntimeLogsPage();
    assert.equal(typeof html, 'string');
    assert.equal(html.includes('ProxyHub 中文实时日志'), true);
});

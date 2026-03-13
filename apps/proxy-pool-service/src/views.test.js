const test = require('node:test');
const assert = require('node:assert/strict');
const { renderProxyAdminPage } = require('./views/proxy-admin');
const { renderRuntimeLogsPage } = require('./views/runtime-logs');

test('renderProxyAdminPage should inject refresh interval', () => {
    const html = renderProxyAdminPage({ ui: { refreshMs: 4321 } });
    assert.equal(html.includes('4321ms'), true);
    assert.equal(html.includes('__REFRESH_MS__'), false);
});

test('renderRuntimeLogsPage should return static html', () => {
    const html = renderRuntimeLogsPage();
    assert.equal(typeof html, 'string');
    assert.equal(html.includes('ProxyHub 中文实时日志'), true);
});

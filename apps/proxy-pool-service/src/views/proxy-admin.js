const fs = require('node:fs');
const path = require('node:path');

const templatePath = path.join(__dirname, 'proxy-admin.html');

// 0131_renderProxyAdminPage_渲染代理管理页面逻辑
function renderProxyAdminPage(config) {
    const template = fs.readFileSync(templatePath, 'utf8');
    return template.replaceAll('__REFRESH_MS__', String(config.ui.refreshMs));
}

module.exports = {
    renderProxyAdminPage,
};

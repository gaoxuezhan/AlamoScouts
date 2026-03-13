const fs = require('node:fs');
const path = require('node:path');

const templatePath = path.join(__dirname, 'proxy-admin.html');
const template = fs.readFileSync(templatePath, 'utf8');

function renderProxyAdminPage(config) {
    return template.replaceAll('__REFRESH_MS__', String(config.ui.refreshMs));
}

module.exports = {
    renderProxyAdminPage,
};

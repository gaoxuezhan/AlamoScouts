const fs = require('node:fs');
const path = require('node:path');

const templatePath = path.join(__dirname, 'runtime-logs.html');
const template = fs.readFileSync(templatePath, 'utf8');

// 0132_renderRuntimeLogsPage_渲染运行时日志页面逻辑
function renderRuntimeLogsPage() {
    return template;
}

module.exports = {
    renderRuntimeLogsPage,
};

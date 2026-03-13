const fs = require('node:fs');
const path = require('node:path');

const templatePath = path.join(__dirname, 'runtime-logs.html');
const template = fs.readFileSync(templatePath, 'utf8');

function renderRuntimeLogsPage() {
    return template;
}

module.exports = {
    renderRuntimeLogsPage,
};

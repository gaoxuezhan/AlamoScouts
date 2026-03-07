# Crawlee + Camoufox 航班价格轮询服务

该服务使用以下能力执行 `ly.com` 机票监控：
- Crawlee `BasicCrawler`
- 代理轮换（`ProxyConfiguration` + `config.proxy.urls`）
- Session Pool 管理（`useSessionPool`）
- 反封禁处理（状态码/页面特征检测 + session 轮换 + 重试）
- Camoufox（隐形 Firefox）
- Web Server 持续运行（Express）

默认任务（可在配置文件改）：查询 `2026-04-01` 北京(`BJS`) -> 三亚(`SYX`) 航班 `CA1345`，每 5 分钟执行一次。

## 安装

```bash
npm install
```

## 运行

1. 修改配置文件：

- `src/config.js`

2. 启动服务：

```bash
npm start
```

默认是可视模式（`headless: false`），抓取时会弹出浏览器窗口。  
可在 `src/config.js -> browser.visibleHoldMs` 调整停留时长（毫秒）。

## API

- `GET /health`：服务健康状态
- `GET /latest`：最新一次结果
- `GET /history?limit=20`：历史结果
- `POST /trigger`：手动触发一次
- `GET /stream`：SSE 实时推送结果

## 结果存储

轮询结果会写入：

- `output/flight-price-results.ndjson`

每行一个 JSON 记录。

## 说明

`ly.com` 对历史日期通常会自动跳转到当天/可售日期。代码会在结果中标记：
- `redirectedFromExpectedDate`
- `finalDate`

如果页面中找不到 `CA1345`，会返回 `status = flight-not-found`。

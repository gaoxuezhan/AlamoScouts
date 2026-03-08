# 新人上手指南（myCrawleeLy）

## 1. 这个项目是做什么的
这是一个「航班价格轮询服务」：
- 使用 Crawlee + Camoufox 定时访问同程（ly.com）机票页面。
- 按配置的航班号（默认 `CZ6714`）抓取价格。
- 结果会写入本地 ndjson 文件，并通过 HTTP API / SSE 对外提供。

## 2. 目录结构速览
- `src/server.js`：主程序入口，包含抓取、解析、持久化、API 与调度。
- `src/config.js`：唯一配置入口（日期、航班、轮询周期、代理、反封禁、提取参数等）。
- `README.md`：安装、运行、接口说明。
- `HANDOVER_REQUIREMENTS_AND_FLOW.md`：交接背景、能力要求与函数地图。
- `流程图_mermaid.md` / `流程图.jpg`：流程图。
- `output/`：运行后生成抓取结果（`flight-price-results.ndjson`）。

## 3. 核心运行链路（建议先理解）
1. `main()` 启动 monitor 和 Express 服务。
2. `startMonitor()` 初始化代理、队列、Crawler 并首轮入队。
3. `enqueueCheck()` 负责把一次检查任务投递到队列。
4. `runSingleCheck()` 执行单次抓取：打开页面、滚动采集、反封禁检测、价格提取。
5. `persistAndBroadcast()` 把结果更新到内存、写入 ndjson 并推送 SSE。
6. Express 暴露 `/health`、`/latest`、`/history`、`/trigger`、`/stream`。

## 4. 必须先熟悉的关键点
- **统一配置思想**：业务参数都应来自 `src/config.js`，避免在逻辑中写死。
- **两阶段提取策略**：先可见文本提取（应对懒加载），再 HTML 正则兜底。
- **抗风控机制**：状态码 + 页面关键词判断，命中后轮换 session 与重试。
- **可观测性**：抓取结果同时保存在内存和 ndjson，便于接口查询和历史追溯。
- **服务化运行**：这是常驻服务，不是“一次性脚本”。

## 5. 新人建议学习路径（按顺序）
1. 阅读 `README.md`，先跑起来并调用 `/health`、`/latest`。
2. 阅读 `src/config.js`，理解每组参数对应的运行行为。
3. 阅读 `src/server.js` 的函数顺序：
   - URL/解析工具函数
   - 文本采集与提取函数
   - `runSingleCheck` 主流程
   - 调度与 API
4. 用 `POST /trigger` 手动触发，对照 `output/flight-price-results.ndjson` 理解结果字段。
5. 再修改一个小配置（例如轮询间隔或航班号），验证配置驱动是否生效。

## 6. 常见改动建议
- 想改抓取目标：改 `config.task`（日期/出发到达/航班号）。
- 想提稳定性：优先调 `antiBlocking` 与 `extraction`（滚动轮次、等待时间、窗口大小）。
- 想控制资源：调 `crawler` 并发、重试与 session 池参数。
- 想接入外部系统：优先消费 `/latest`、`/history` 或 `/stream`，避免直接读内部变量。

## 7. 协作约定（建议）
- 新增功能时，先补配置，再补逻辑，最后补 README/交接文档。
- 尽量保持注释中文且解释“为什么”，不只写“做了什么”。
- 任何结果结构字段调整，都要同步检查 `/latest`、`/history`、SSE 与落盘格式兼容性。

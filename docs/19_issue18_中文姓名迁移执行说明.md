# Issue #18 中文姓名迁移执行说明（2026-03-16）

## 1. 目标
1. 新兵命名改为仅中文姓名（2/3 字混合），不带编号和短码后缀。
2. 历史数据全量重命名，避免 UI/API 出现同一代理新旧名称混用。
3. 代理追踪主键统一使用 `proxies.id`，`display_name` 仅用于可读展示。

## 2. 迁移入口
1. 命令：`npm run migrate:proxyhub:names`
2. 默认模式：`dry-run`（不写库）
3. 落库模式：`npm run migrate:proxyhub:names -- --apply`
4. 预览样例条数：`npm run migrate:proxyhub:names -- --dry-run --sample 30`

## 3. 执行顺序
1. 停服务。
2. 执行 dry-run，审阅映射样例与统计。
3. 执行 apply。
4. 运行单测：`npm.cmd run test:proxyhub:unit`。
5. 启服务并抽样验证页面/API。

## 4. 回滚原则
1. apply 使用单事务执行。
2. 任一更新或校验失败，事务自动回滚，不允许半更新。
3. 回滚后应保持迁移前状态（名称不变）。

## 5. 更新范围
1. `proxies.display_name`
2. `proxy_events.display_name`
3. `honors.display_name`
4. `retirements.display_name`
5. `runtime_logs.proxy_name`（仅真实代理名，`-` 不替换）

## 6. 验收 SQL 清单
```sql
-- A. display_name 唯一性
SELECT COUNT(*) AS total, COUNT(DISTINCT display_name) AS unique_total
FROM proxies;

-- B. 新格式校验：不得包含 '-' 或数字
SELECT COUNT(*) AS invalid_count
FROM proxies
WHERE display_name GLOB '*-*' OR display_name GLOB '*[0-9]*';

-- C. 历史表旧格式残留检查
SELECT COUNT(*) AS c FROM proxy_events
WHERE display_name IS NOT NULL
  AND (display_name GLOB '*-*' OR display_name GLOB '*[0-9]*');

SELECT COUNT(*) AS c FROM honors
WHERE display_name GLOB '*-*' OR display_name GLOB '*[0-9]*';

SELECT COUNT(*) AS c FROM retirements
WHERE display_name GLOB '*-*' OR display_name GLOB '*[0-9]*';

SELECT COUNT(*) AS c FROM runtime_logs
WHERE proxy_name != '-'
  AND (proxy_name GLOB '*-*' OR proxy_name GLOB '*[0-9]*');

-- D. 抽样比对：按 proxy_id 对齐
SELECT p.id, p.display_name, e.display_name AS event_name
FROM proxies p
JOIN proxy_events e ON e.proxy_id = p.id
ORDER BY e.id DESC
LIMIT 20;
```

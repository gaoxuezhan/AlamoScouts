# Issue #99：candidate 闸门硬上限修复记录（2026-03-23）

关联 issue：[#99](https://github.com/gaoxuezhan/AlamoScouts/issues/99)

## 1. 问题现象
- 已配置 `PROXY_HUB_CANDIDATE_MAX=1500`，但 soak 运行数小时后 `candidateCount` 回升到 `3000+`。
- `/v1/proxies/candidate-control` 显示配置已生效（`max=1500`），说明不是配置未加载问题。

## 2. 根因
- 旧逻辑仅用 `allowInsert` 控制是否允许新增。
- 当轮次开始时 `candidateCount < max`，`upsertSourceBatch` 会整批插入，单轮即可冲破阈值。
- 结论：`max` 在旧实现里是“闸门阈值”，不是“硬上限”。

## 3. 代码修复
- `apps/proxy-pool-service/src/engine.js`
1. 计算 `remainingInsertSlots = max - candidateCount`。
2. 传递到 `upsertSourceBatch(..., { maxInsert })`。
3. 审计事件补充 `gateLimitedBySlots` 与 `remainingInsertSlots`。

- `apps/proxy-pool-service/src/db.js`
1. `upsertSourceBatch` 新增 `maxInsert` 参数。
2. 插入前判断 `remainingInsert <= 0`，超限时仅 `skip`，不再新增。

## 4. 测试覆盖
- `apps/proxy-pool-service/src/db.test.js`
1. 新增 `maxInsert` 回归用例，验证“可触达存量 + 限量新增 + 超额跳过”。

- `apps/proxy-pool-service/src/engine.test.js`
1. 新增“remaining gate slots”场景，验证单轮抓源不再超过上限。

## 5. 运行态处置（已执行）
- 由于历史存量超限，执行一次性删除将 `candidate` 从 `2770` 降到 `1500`。
- 删除策略：优先删除 `total_samples=0`，再按低训练/低成功优先。
- 删除不走退役流程，直接物理删除并同步清理外键依赖表：
1. `battle_test_runs`
2. `honors`
3. `proxy_events`
4. `retirements`
5. `proxies`

## 6. 验收结果
- `/v1/proxies/candidate-control` 已回读到 `candidateCount=1500`。
- 在 `gateOverride=false` 场景下，新增已受 `maxInsert` 限制，不再出现批量冲穿阈值。

# 图16：模块15_外部实战接入设计（Lease + Feedback + Watch）

## 1. 目标
为其他程序调用 ProxyHub 战力提供生产级闭环：
1. 可租用（Lease）：避免并发重复使用同一代理。
2. 可续租/释放：显式生命周期管理。
3. 可回传（Feedback）：把外部真实战果回流评分体系。
4. 可订阅（Watch）：外部系统及时感知战力变化。

## 2. 核心设计
### 2.1 接口分层
1. 查询层（现有）：`/v1/proxies/list`、`/v1/proxies/value-board` 等。
2. 调用层（新增）：`/v1/proxies/lease`、`/v1/proxies/leases/{id}/renew`、`/v1/proxies/leases/{id}/release`。
3. 回传层（新增）：`/v1/proxies/feedback`。
4. 订阅层（新增）：`/v1/proxies/snapshot` + `/api/proxies/watch?since=...`。

### 2.2 设计原则
1. `lease_id` 是外部调用与回传的强关联主键。
2. `report_id` 幂等去重（同一个实战回报只记一次）。
3. 评分异步化（回传先入库，再由 worker 聚合评分）。
4. 内测分与外战分分层（防止单一来源污染总评分）。

## 3. 新增接口契约（V1.5）
### 3.1 `POST /v1/proxies/lease`
用途：按策略发放可用代理。

请求示例：
```json
{
  "consumer": "ly-crawler-prod-a",
  "scene": "ly_booking",
  "count": 3,
  "ttlSec": 300,
  "filters": {
    "lifecycle": ["active"],
    "minValueScore": 55,
    "minBattleRatio": 0.5
  }
}
```

响应示例：
```json
{
  "leases": [
    {
      "leaseId": "lease_01J...A",
      "expiresAt": "2026-03-15T13:05:00.000Z",
      "proxy": {
        "id": 123,
        "protocol": "http",
        "ip": "1.2.3.4",
        "port": 8080
      },
      "snapshot": {
        "rank": "列兵",
        "lifecycle": "active",
        "ipValueScore": 61.4,
        "battleRatio": 0.78
      }
    }
  ]
}
```

### 3.2 `POST /v1/proxies/leases/{leaseId}/renew`
用途：延长租约，避免长任务中断。

请求：
```json
{ "ttlSec": 300 }
```

### 3.3 `POST /v1/proxies/leases/{leaseId}/release`
用途：任务结束后主动释放，提升池利用率。

请求：
```json
{ "reason": "done" }
```

### 3.4 `POST /v1/proxies/feedback`
用途：回传外部真实战果。

请求示例：
```json
{
  "reportId": "rpt_20260315_000001",
  "leaseId": "lease_01J...A",
  "consumer": "ly-crawler-prod-a",
  "scene": "ly_booking",
  "target": "https://www.ly.com/flights/...",
  "outcome": "success",
  "statusCode": 200,
  "latencyMs": 1320,
  "errorCode": null,
  "details": {
    "orderStep": "search_result"
  },
  "occurredAt": "2026-03-15T12:58:00.000Z"
}
```

约束：
1. `reportId` 全局唯一（幂等）。
2. `leaseId` 必须存在且归属同一 `consumer`。
3. `outcome` 枚举：`success|blocked|timeout|network_error|invalid_feedback`。

### 3.5 `GET /v1/proxies/snapshot`
用途：首帧全量快照，返回 `resourceVersion`。

### 3.6 `GET /api/proxies/watch?since={resourceVersion}`
用途：SSE 增量订阅，事件类型：
1. `proxy_updated`
2. `lease_expired`
3. `policy_changed`
4. `bookmark`

## 4. 数据模型新增
### 4.1 `proxy_leases`
字段建议：
1. `id`（lease_id）
2. `proxy_id`
3. `consumer`
4. `scene`
5. `status`（active/released/expired/revoked）
6. `leased_at`
7. `expires_at`
8. `released_at`
9. `meta_json`

索引建议：
1. `(proxy_id, status, expires_at)`
2. `(consumer, status, leased_at desc)`

### 4.2 `external_battle_runs`
字段建议：
1. `id`
2. `report_id`（unique）
3. `lease_id`
4. `proxy_id`
5. `consumer`
6. `scene`
7. `target`
8. `outcome`
9. `status_code`
10. `latency_ms`
11. `error_code`
12. `details_json`
13. `occurred_at`
14. `ingested_at`

索引建议：
1. `(proxy_id, occurred_at desc)`
2. `(scene, outcome, occurred_at desc)`
3. `(lease_id, occurred_at desc)`

## 5. 评分接线（建议）
### 5.1 外战权重
新增策略项：
1. `policy.externalScoring.weight = 0.35`（外战占比）
2. `policy.externalScoring.sceneWeights`（按场景加权）

### 5.2 合成方式
1. 内测分（L0/L1/L2）与外战分分别计算。
2. 总分 = `internalScore * (1 - w) + externalScore * w`。
3. 当外战样本不足时，`w` 自动衰减（如 `<20` 条时线性衰减）。

## 6. 安全与抗滥用
1. 接口鉴权：`X-API-Key` 或 HMAC 签名。
2. 速率限制：按 `consumer` 做 QPS 与并发限制。
3. 租约防滥用：同一 `consumer` 的活跃 lease 上限。
4. 回传校验：`lease` 所属校验 + 时间窗口校验 + 幂等。

## 7. 运行保障
1. 定时回收过期 lease（每 5-15 秒）。
2. 回传处理失败进入重试队列（带死信）。
3. 关键监控：
1. `lease_granted/renewed/released/expired`
2. `feedback_ingested/duplicated/rejected`
3. `external_success_ratio`、`external_timeout_ratio`
4. `active_lease_count`、`lease_conflict_count`

## 8. 分阶段落地
1. Phase 1：仅实现 `lease/release/feedback` + 入库，不改评分。
2. Phase 2：接入外战分到 `ip_value_score`（灰度 consumer）。
3. Phase 3：上线 `snapshot/watch`，改为 list+watch 模式。

## 9. 与现有代码的衔接点
1. 路由：`apps/proxy-pool-service/src/server.js`
2. 存储：`apps/proxy-pool-service/src/db.js`
3. 评分：`apps/proxy-pool-service/src/rank.js`、`apps/proxy-pool-service/src/value-model.js`
4. 策略校验：`apps/proxy-pool-service/src/policy.js`


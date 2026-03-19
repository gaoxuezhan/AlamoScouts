# #39 内置程序化切换 - 72h Soak 追踪

## 本轮目标
- 验证 #39 的内置编排器在长时运行下是否稳定。
- 观测 `SAFE/FULL/COOLDOWN` 状态机、租约、回滚与恢复行为。
- 在 72h 结束后评估是否需要参数/策略改进。

## 已实现范围（对应 #39）
- 服务内 `RolloutOrchestrator`（启动即 tick + 15 分钟周期）
- DB 表
  - `rollout_switch_state`
  - `rollout_switch_events`
- API
  - `GET /v1/proxies/rollout/orchestrator/state`
  - `GET /v1/proxies/rollout/orchestrator/events`
  - `POST /v1/proxies/rollout/orchestrator/tick`
- 租约单主：`lease_owner/lease_until` 控制单实例执行 tick
- 冷却恢复与放量：`cooldownHours=24`，`stableHours=48`，`minL2Samples=20`

## 启动参数
- 启动时间（UTC）: `2026-03-16T15:57:00.994Z`
- 计划时长: `72h`
- 采样间隔: `30s`
- 汇总间隔: `10h` (`SOAK_SUMMARY_MS=36000000`)
- 策略动作: 关闭（`policyActionsPlanned=0`）
- timeline: `apps/proxy-pool-service/data/soak-timeline-2026-03-16T15-57-00-991Z.jsonl`

## 首份手动进度（T+0h）
- 样本总数: `4`
- 健康样本: `4`
- 可用率: `100%`
- 最新样本: `queue=0, busy=6, failedTasks=0`
- 编排器状态:
  - `mode=SAFE`
  - `stable_since=2026-03-16T15:57:01.712Z`
  - `last_error=null`
  - `lease_owner=pid-7220`
- 编排事件: 启动 tick 1 条，`action=safe_hold`，无 breach

## 10h 检查表
| 检查点 | 时间(UTC) | 样本数 | 可用率 | active/reserve/candidate/retired | mode | breach数 | 回滚动作 | 结论 |
|---|---|---:|---:|---|---|---:|---|---|
| T+0h | 2026-03-16T15:58Z | 4 | 100% | 38/341/2917/5 | SAFE | 0 | 无 | 初始稳定 |
| T+10h | 2026-03-17T02:03Z | 1214 | 100% | 75/149/3950/918 | COOLDOWN | 40 | rollback x40 | Stable availability, but sustained rollback needs tuning |
| T+16h | 2026-03-17T07:48Z | 1903 | 100% | 81/178/5112/1071 | COOLDOWN | 63 | rollback x63 | Availability stable; sustained COOLDOWN/rollback continues |
| T+20h | 待更新 |  |  |  |  |  |  |  |
| T+30h | 待更新 |  |  |  |  |  |  |  |
| T+40h | 待更新 |  |  |  |  |  |  |  |
| T+50h | 待更新 |  |  |  |  |  |  |  |
| T+60h | 待更新 |  |  |  |  |  |  |  |
| T+70h | 待更新 |  |  |  |  |  |  |  |
| T+72h 终点 | 2026-03-19T15:57Z | 8629 | 100% | 34/782/13378/4046 | COOLDOWN | 345 | rollback x288 | Soak completed; availability stable but orchestrator remained in rollback loop |

## Initial Assessment (T+10h)
- 72h soak is still running (about `T+10.11h`); latest sample at `2026-03-17T02:03:52.479Z`; `soak_end` not found.
- Availability remains stable: `1214/1214` healthy samples, `100%` uptime.
- Queue pressure exists: `queue>0` ratio `76.11%`, max `queue=24`, latest `failedTasks=936`.
- Orchestrator entered `COOLDOWN` at `2026-03-16T16:12:01.722Z` and has accumulated `rollback=40` so far, mainly due to `retired_spike` breaches.
- Judgment: improvement is needed. Prioritize guardrail calibration (especially `retired_spike` and `active_drop`) and add protection against repeated identical breaches during long COOLDOWN windows.

## T+10h Details
- Sample volume / availability: `1214` / `100%` (failed samples `0`).
- Queue and failed tasks: latest `queue=24, busy=6/6, failedTasks=936, completedTasks=93085`; max queue `24`.
- Lifecycle distribution: `active=75, reserve=149, candidate=3950, retired=918`.
- Rollout Orchestrator state:
  - `mode=COOLDOWN`
  - `cooldown_until=2026-03-18T01:57:01.981Z`
  - `last_tick_at=2026-03-17T01:57:01.981Z`
  - `last_error=null`
  - `lease_owner=pid-7220`
- Recent events (latest 10): all are `action=rollback` with `trigger=schedule`; each includes `retired_spike`; newest at `2026-03-17T01:57:01.981Z`.
## Interim Assessment (T+16h)
- 72h soak is still running (about `T+15.86h`); latest sample at `2026-03-17T07:48:34.630Z`; `soak_end` not found.
- Availability remains stable: `1903/1903` healthy samples, `100%` uptime.
- Queue pressure remains high: `queue>0` ratio `77.40%`, max `queue=24`, latest `queue=18`.
- Failed tasks continue to rise with load (`maxFailedTasks=1347`; latest `failedTasks=1347`).
- Orchestrator is still in `COOLDOWN`; cumulative actions now `rollback=63`, `safe_hold=1`.
- Judgment: improvement still needed. The system is stable on availability but stuck in prolonged rollback loop.

## T+16h Details
- Sample volume / availability: `1903` / `100%` (failed samples `0`).
- Queue and failed tasks: latest `queue=18, busy=6/6, failedTasks=1347, completedTasks=148730`; max queue `24`.
- Lifecycle distribution: `active=81, reserve=178, candidate=5112, retired=1071`.
- Rollout Orchestrator state:
  - `mode=COOLDOWN`
  - `cooldown_until=2026-03-18T07:42:02.180Z`
  - `last_tick_at=2026-03-17T07:42:02.180Z`
  - `last_error=null`
  - `lease_owner=pid-7220`
- Recent events (latest 10): all are `action=rollback` with `trigger=schedule`; newest at `2026-03-17T07:42:02.180Z`.
- Breach distribution (all rollback events): `retired_spike=63`, `active_drop=28`.

## Final Assessment (T+72h / 已结束)
- 72h soak 已结束：`start=2026-03-16T15:57:00.994Z`，`end=2026-03-19T15:57:28.360Z`，总时长约 `72.01h`，timeline 中已记录 `soak_end`。
- 样本与可用率：`8629/8629` 健康样本，`100%` 可用率（failed samples `0`）。
- 队列与失败任务：`queue>0` 占比 `77.55%`，`maxQueue=24`；最终样本 `queue=0, busy=0/6, completedTasks=695030, failedTasks=5003`。
- 生命周期终态分布：`active=34, reserve=782, candidate=13378, retired=4046`（active 显著偏低）。
- Rollout Orchestrator 终态：
  - `mode=COOLDOWN`
  - `cooldown_until=2026-03-20T15:57:03.632Z`
  - `last_tick_at=2026-03-19T15:57:03.632Z`
  - `last_error=null`
  - `lease_owner=pid-7220`
- Rollout 事件汇总：累计 `safe_hold=1`, `rollback=288`；breach 分布 `retired_spike=269`, `active_drop=76`。最近 10 条均为 `schedule -> rollback`，且 breach 全为 `active_drop`。

## 终报告结论与改进建议
- 结论：可用性目标达成（`100%` uptime），但编排器有效性目标未达成。系统几乎全程停留在 `COOLDOWN` 且持续回滚，说明 guardrail 与生命周期行为存在长期不匹配，仍需改进后再进入下一轮放量验证。
- 建议 1：为重复 breach 增加抑制机制（同类 breach 在 cooldown 窗口内降频记账/去重），避免每个 tick 都触发 rollback 事件噪音。
- 建议 2：重标定 `active_drop` 与 `retired_spike` 阈值，使用相对变化+最小样本门槛（例如按窗口基线百分比且要求 N 个连续窗口）以降低误触发。
- 建议 3：在 orchestrator 中加入 `COOLDOWN` 期间的“观测态”动作（仅记录不回滚），并增加恢复前验证门槛（active 回升、retired 增速收敛）。
- 建议 4：补充面向 72h soak 的验收指标：除 uptime 外，增加 `rollback_rate/hour`、`mode_dwell_time`、`active_floor` 作为 release gate。

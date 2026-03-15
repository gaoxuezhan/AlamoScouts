# Issue #27 对策落地说明（2026-03-16）

## 锁定策略
1. L2 主目标改为稳定业务入口：`https://www.ly.com/flights/home`。
2. 保留目标名称：`ly-flight-main`（保持历史报表口径连续）。
3. 保留 fallback：`baidu-home`，仅用于兜底诊断，不覆盖主目标判定。

## 为什么不用 `https://www.ly.com/`
1. L2 目标是验证机票业务可用性，不是门户首页可达性。
2. 根域首页可能可访问，但机票业务链路异常，容易形成假阳性。
3. `flights/home` 不依赖固定日期参数，长期稳定性和可比性更好。
4. 现有 L2 断言关键词（`flight/航班/机票`）与机票频道入口更匹配。

## 配置与兼容
1. 默认 L2 主目标：`https://www.ly.com/flights/home`。
2. 支持环境变量覆盖：`PROXY_HUB_BATTLE_L2_PRIMARY_URL`。
3. `fallback` 成功不会把主目标失败改判为 `success`。

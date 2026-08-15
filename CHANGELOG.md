# 变更记录 / Changelog

## [1.0.0] - 2026-08-15

### Added
- 文本级死循环检测（周期扫描 8-256 / n-gram 64 块×3 / 大段锚段 512 扩展），监听 `assistant/chunk`（text-delta + reasoning-delta）。
- 工具调用意图级重复检测：监听 `tools/execute` 的 `web_search`，新词占比 <25% 连续 2 次判定"换措辞重搜同一主题"，steer/cancel 硬中断。
- 硬中断机制：`agent.steer()` 自动重试（`maxRetries` 可配置），耗尽后 `agent.cancel()` 强制中止；`turn/end` 自动重置计数。
- 双语文档（README.md / README.zh.md），MIT 协议。

### Published
- **v1.0.0 发布到 npm registry**（`dsh plugin --profile web add dsh-loop-detector` 可直接安装）。
- 推送到 GitHub：https://github.com/viego-qiin/dsh-loop-detector

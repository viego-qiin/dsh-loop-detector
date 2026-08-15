# dsh-loop-detector

**DeepSeek Harness (dsh) 的死循环 / 重复输出检测插件。**

[![npm](https://img.shields.io/npm/v/dsh-loop-detector)](https://www.npmjs.com/package/dsh-loop-detector)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

本地大模型（尤其是量化版 / RL 微调的思考模型）有时会卡死：要么无限重复同一句话，
要么用换措辞的 query 反复搜索同一个主题却毫无新信息。本插件实时监听 agent 的输出流，
检测这两类循环，并**硬中断**——不是模型可以无视的软提醒。

English docs: [README.md](README.md)

## 功能

- **文本级重复检测** —— 监听 `assistant/chunk`（`text-delta` + 可选 `reasoning-delta`），三层检测：
  1. **周期扫描**：尾部按固定周期（8–256 字符）重复
  2. **n-gram**：最近窗口内 64 字符块出现 ≥3 次
  3. **大段锚段**：尾部 512 字符在更早文本再次出现并向前扩展（抓"整段重复"，
     例如模型把同一段规划输出两遍）
- **工具调用意图级重复检测** —— 监听 `tools/execute` 的 `web_search`：提取 query 关键词，
  维护"主题词集"（最近 3 个 query 的并集），若新 query 的**新词占比 <25% 且连续 2 次**，
  判定为"换措辞重搜同一主题"（字符串检测看不到的意图级循环）。
- **硬中断**：命中后 `agent.steer()` 注入引导消息（自动重试，可配置）；重试耗尽则
  `agent.cancel()` 强制中止回合。计数在 `turn/end` 自动重置。

为什么需要硬中断？dsh 自带的 `repeat-tool-reminder` 只是**软提醒**。实测本地模型
（如关思考的 Qwen/Ornith 35B MoE）会无视提醒继续循环——这正是本插件存在的意义。

## 快速开始

前置：已运行的 dsh profile（见 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 文档）。

**方式一（推荐）：npm 安装（已发布到 npm registry）**

```powershell
dsh plugin --profile web add dsh-loop-detector
dsh web   # 重启生效
```

**方式二：本地复制安装**

```powershell
# 复制到 profile 的 node_modules
cp -r dsh-loop-detector $env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-loop-detector
```

**两种方式都需要：挂载配置**（`$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml`）：

```yaml
- insert:
    - id: loop-detector
      name: 'dsh-loop-detector'
      config:
        minLen: 512          # 输出 >= 512 字符才开始检测（防短文本误判）
        maxRetries: 1        # steer 自动重试 1 次，再犯则强制取消
        checkReasoning: true # 同时检测思考内容（reasoning-delta）
```

**然后重启验证：**

```powershell
dsh web
```

检测到循环时日志会出现：

```
[loop-detector] session xxx 检测到死循环（1/1）: large-scale repeat: ...；steer 引导重试
[loop-detector] session xxx 连续 2 次搜索同一主题（无新信息）: "..."；steer 引导停止搜索
```

仓库内附可直接使用的 `cordis.patch.yml` 示例。

## 配置项

| 字段 | 默认 | 含义 |
|---|---|---|
| `minLen` | `512` | 输出达到多少字符后才开始检测（防短文本误判）|
| `maxRetries` | `1` | steer 自动重试次数，耗尽后强制取消 |
| `checkReasoning` | `true` | 是否也检测思考内容（reasoning-delta）|

## 检测原理

### 文本级（`detectRepetition`）

```
1) 周期扫描    尾部 4 个周期逐字符一致，周期 T ∈ [8..256]       -> 循环
2) n-gram      最近 2048 字符内 64 字符块出现 >= 3 次           -> 循环
3) 大段锚段    尾部 512 字符在更早文本再现，向前扩展 >= 512      -> 循环
```

### 工具调用意图级

```
主题词集 = 最近 3 个 web_search query 的关键词并集
新 query   -> 新词占比 = (不在主题词集中的 token 数) / 总 token 数
新词占比 < 25% 且连续 2 次  -> 意图级重复 -> steer / cancel
```

已用真实案例验证：Qwen3.5-9B 卡在 82 字符单句（period=132 命中）、2120 字符规划段
重复两遍（大段锚段命中）、11 连发同主题搜索（第 8 个命中，前 7 个各带新维度不误伤）。

## 局限

- 意图级检测目前针对 `web_search`，其他工具可通过扩展 `exec.name` 过滤加入；
- 检测器是启发式的——请按你的模型调 `minLen` / 阈值；
- 检测按 session 独立，`turn/end` 自动重置，不跨回合累积。

## License

MIT — 见 [LICENSE](LICENSE)。

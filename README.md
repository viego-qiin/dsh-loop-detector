# dsh-loop-detector

**Dead-loop / repetition detector plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).**

[![npm](https://img.shields.io/npm/v/dsh-loop-detector)](https://www.npmjs.com/package/dsh-loop-detector)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Local LLMs (especially quantized / RL-tuned reasoning models) sometimes get stuck:
repeating the same sentence forever, or re-running `web_search` with reworded queries
for the same topic without gaining any new information. This plugin watches the
agent's stream in real time, detects both kinds of loops, and **interrupts them
hard** — not a soft reminder the model can ignore.

> 中文文档见 [README.zh.md](README.zh.md).

## Features

- **Text-level repetition detection** — watches `assistant/chunk` (`text-delta` +
  optional `reasoning-delta`) with three layered detectors:
  1. **Period scan**: tail repeats with a fixed period (8–256 chars)
  2. **n-gram**: a 64-char block seen ≥3 times in the recent window
  3. **Large-scale anchor**: a 512-char tail block reappearing earlier (catches
     whole-paragraph repetition, e.g. a model re-planning the same answer twice)
- **Tool-call intent-level repetition detection** — watches `tools/execute` for
  `web_search`: extracts query keywords, keeps a "topic set" (union of the last 3
  queries), and if a new query brings **<25% novel tokens twice in a row**, it
  judges the model is re-searching the same topic with different wording
  (intent-level loop, invisible to plain string matching).
- **Hard interrupt**: on hit, `agent.steer()` injects a guidance message (auto
  retry, configurable); when retries are exhausted, `agent.cancel()` forcibly
  aborts the turn. Counters reset on `turn/end`.

Why hard interrupt? dsh's built-in `repeat-tool-reminder` only *reminds* the model.
We observed local models (e.g. Qwen/Ornith 35B MoE with thinking off) ignore the
reminder and keep looping — that's what this plugin exists for.

## Quick start

Prereqs: a running dsh profile (see [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) docs).

**Option A (recommended): install from npm (published to npm registry)**

```powershell
dsh plugin --profile web add dsh-loop-detector
dsh web   # restart to activate
```

**Option B: install from a local copy**

```powershell
cp -r dsh-loop-detector $env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-loop-detector
```

**Then, in both cases, mount it** via your profile's permanent patch layer
(`$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml`):

```yaml
- insert:
    - id: loop-detector
      name: 'dsh-loop-detector'
      config:
        minLen: 512          # only check output >= 512 chars (avoid short-text false positives)
        maxRetries: 1        # auto-retry 1x via steer; cancel when exhausted
        checkReasoning: true # also check reasoning-delta (thinking content)
```

**Restart and verify:**

```powershell
dsh web
```

You should see the plugin loaded; when a loop is caught, the log shows:

```
[loop-detector] session xxx 检测到死循环（1/1）: large-scale repeat: ...；steer 引导重试
[loop-detector] session xxx 连续 2 次搜索同一主题（无新信息）: "..."；steer 引导停止搜索
```

A ready-to-use `cordis.patch.yml` example is included in this repo.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `minLen` | `512` | Start text detection only after this many characters (avoid false positives on short replies) |
| `maxRetries` | `1` | Times to auto-retry via `steer` before hard `cancel` |
| `checkReasoning` | `true` | Also scan reasoning (thinking) content for repetition |

## How the detectors work

### Text-level (`detectRepetition`)

```
1) period scan     tail 4 periods identical, period T in [8..256]        -> loop
2) n-gram          64-char block seen >= 3x in last 2048 chars           -> loop
3) large anchor    512-char tail block reappears earlier, extends >=512  -> loop
```

### Tool-call intent-level

```
topic set = union of keywords of the last 3 web_search queries
new query  -> novel ratio = (# tokens not in topic set) / total tokens
novel ratio < 25% twice in a row  -> intent-level repetition -> steer/cancel
```

Verified against real cases: a Qwen3.5-9B stuck on an 82-char sentence
(period=132 caught), a 2120-char duplicated planning block caught, and an
11-query same-topic search streak caught at query #8 (no false positive on the
first 7 queries that each introduced new dimensions).

## Scope & limitations

- Intent-level detection currently targets `web_search`; other tools can be
  added by extending the `exec.name` filter.
- The detectors are heuristic — tune `minLen` / thresholds for your model.
- Detection is per-session and resets on `turn/end` (no cross-turn carryover).

## License

MIT — see [LICENSE](LICENSE).

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * dsh-loop-detector — 流式输出死循环检测插件
 *
 * 监听 `session/event` 的 `assistant/chunk`（text-delta 正文 + reasoning-delta 思考），
 * 实时累积文本并跑三层重复检测：
 *   1. 周期扫描（尾部 4 个周期逐字符一致，周期 8..256）
 *   2. n-gram（最近 2048 字符内 64 字符块出现 >=3 次）
 *   3. 大周期锚段（尾部 512 字符在更早文本再次出现，向前扩展 >=512 字符 => 整段重复）
 *
 * 命中后行为（可配置）：
 *   - 重试次数未耗尽：`agent.steer()` 注入引导消息，打断当前生成并让模型重新回答；
 *   - 重试耗尽：`agent.cancel({ kind: 'hook', reason })` 强制中止。
 * 计数在 `turn/end` 自动重置，避免跨回合累积误判。
 */

export const name = 'loop-detector'
export const inject = ['agents'] as const

export interface Config {
  /** 输出达到多少字符后才开始检测（防短文本误判）。默认 512 */
  minLen?: number
  /** 死循环自动重试次数（steer 引导重试），耗尽后强制取消。默认 1 */
  maxRetries?: number
  /** 是否也检测思考内容（reasoning-delta）。默认 true */
  checkReasoning?: boolean
}

/** 检测 text 是否存在重复/死循环。返回 (is_loop, reason) */
function detectRepetition(text: string): [boolean, string] {
  const window = 2048
  const bigWindow = 8192
  if (text.length < 128) return [false, '']

  const tail = text.slice(-window)

  // 1) 周期扫描：尾部最后 4 个周期逐字符一致 => 死循环
  for (let T = 8; T <= 256; T++) {
    const need = T * 4
    if (tail.length < need) break
    const last = tail.slice(-need)
    const first = last.slice(0, T)
    let ok = true
    for (let r = 1; r < 4; r++) {
      if (last.slice(r * T, (r + 1) * T) !== first) {
        ok = false
        break
      }
    }
    if (ok) return [true, `periodic repeat: period=${T}`]
  }

  // 2) n-gram：最近 window 内 64 字符块出现 >=3 次
  const seen = new Map<string, number>()
  for (let i = 0; i + 64 <= tail.length; i += 64) {
    const seg = tail.slice(i, i + 64)
    const n = (seen.get(seg) ?? 0) + 1
    if (n >= 3) return [true, `n-gram repeat: 64-char block seen ${n}x`]
    seen.set(seg, n)
  }

  // 3) 大周期锚段：尾部 512 字符在更早文本再次出现，向前扩展 >=512 => 整段重复
  const big = text.slice(-bigWindow)
  if (big.length >= 1024) {
    const anchor = big.slice(-512)
    const head = big.slice(0, -512)
    const idx = head.lastIndexOf(anchor)
    if (idx !== -1) {
      let match = 512
      let i = idx - 1
      let j = big.length - 513
      while (i >= 0 && j >= 0 && big[i] === big[j]) {
        match++
        i--
        j--
      }
      if (match >= 512) return [true, `large-scale repeat: ${match} chars repeated 2x+`]
    }
  }

  return [false, '']
}

export function apply(ctx: Context, config: Config = {}): void {
  const minLen = config.minLen ?? 512
  const maxRetries = config.maxRetries ?? 1
  const checkReasoning = config.checkReasoning ?? true

  const buffers = new Map<string, string>()
  const retries = new Map<string, number>()
  // 工具调用意图级重复检测状态
  const searchHistories = new Map<string, string[]>() // session -> 最近 search query 列表
  const stallCounts = new Map<string, number>()       // session -> 连续"无新信息"搜索次数

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (event.type === 'turn/end') {
      const sid = String(session.id)
      buffers.delete(sid)
      retries.delete(sid)
      searchHistories.delete(sid)
      stallCounts.delete(sid)
      return
    }

    if (event.type !== 'assistant/chunk') return
    const chunk = event.data.chunk
    if (chunk.type !== 'text-delta' && !(checkReasoning && chunk.type === 'reasoning-delta')) return

    const sid = String(session.id)
    const buf = (buffers.get(sid) ?? '') + chunk.text
    buffers.set(sid, buf)
    if (buf.length < minLen) return

    const [isLoop, why] = detectRepetition(buf)
    if (!isLoop) return

    const agent = ctx.agents.get(session.id)
    buffers.set(sid, '') // 清缓冲，防止同一段重复触发
    if (!agent) return

    const tries = retries.get(sid) ?? 0
    if (tries < maxRetries) {
      retries.set(sid, tries + 1)
      ctx.logger.warn(
        `[loop-detector] session ${sid} 检测到死循环（${tries + 1}/${maxRetries}）: ${why}；steer 引导重试`,
      )
      agent.steer(createUserMessage({
        content: [{
          type: 'text',
          text: '[loop-detector] 检测到你正在重复输出同一段内容（死循环）。请立即停止当前思路并重新组织回答：不要重复任何已经输出的文字，直接给出简洁、完整、不重复的最终回答。',
        }],
        source: { kind: 'user' },
      }))
    } else {
      retries.delete(sid)
      ctx.logger.error(
        `[loop-detector] session ${sid} 重试 ${maxRetries} 次仍死循环，强制取消: ${why}`,
      )
      agent.cancel({ kind: 'hook', reason: `loop-detected: ${why}` })
    }
  })

  // ── 工具调用意图级重复检测 ──────────────────────────────────────────────
  // 监听 web_search 分发：提取 query 关键词，维护"主题词集"（最近 3 个 query 的
  // token 并集）。若新 query 的新词占比 < 25%（换措辞但没带新信息），连续 2 次
  // 即判定"意图级重复"（不同字符串、同一主题打转），走 steer/cancel 硬中断。
  // 这补上了纯文本检测抓不到的"换说法说同样的话"场景。

  /** 提取 query 的关键词 token（中英文混合，去短 token） */
  function extractTokens(q: string): Set<string> {
    return new Set(
      q.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((t) => t.length >= 2),
    )
  }

  ctx.on('tools/execute', (exec: any, next: any) => {
    if (exec?.name !== 'web_search') return next()
    const sid = exec.agent?.id as string | undefined
    if (!sid) return next()
    const args = exec.arguments as { query?: string } | undefined
    const query = typeof args?.query === 'string' ? args.query : ''
    if (!query) return next()

    const tokens = extractTokens(query)
    if (tokens.size === 0) return next()

    const hist = searchHistories.get(sid) ?? []
    // 主题词集 = 最近 3 个 query 的 token 并集
    const topic = new Set<string>()
    for (const q of hist.slice(-3)) {
      for (const t of extractTokens(q)) topic.add(t)
    }
    let novelRatio = 1
    if (topic.size > 0) {
      const novel = [...tokens].filter((t) => !topic.has(t)).length
      novelRatio = novel / tokens.size
    }
    hist.push(query)
    searchHistories.set(sid, hist.slice(-6))

    if (novelRatio < 0.25) {
      const n = (stallCounts.get(sid) ?? 0) + 1
      stallCounts.set(sid, n)
      if (n >= 2) {
        stallCounts.delete(sid)
        const agent = ctx.agents.get(sid)
        if (agent) {
          const tries = retries.get(sid) ?? 0
          if (tries < maxRetries) {
            retries.set(sid, tries + 1)
            ctx.logger.warn(
              `[loop-detector] session ${sid} 连续 ${n} 次搜索同一主题（无新信息）: "${query}"；steer 引导停止搜索`,
            )
            agent.steer(createUserMessage({
              content: [{
                type: 'text',
                text: '[loop-detector] 检测到你连续多次使用 web_search 搜索同一主题（换了关键词但没有新信息）。请立即停止搜索，基于已有信息直接回答；不要再调用 web_search。',
              }],
              source: { kind: 'user' },
            }))
          } else {
            retries.delete(sid)
            ctx.logger.error(
              `[loop-detector] session ${sid} 搜索主题重复重试 ${maxRetries} 次仍不停止，强制取消`,
            )
            agent.cancel({ kind: 'hook', reason: 'repeated-search-same-topic' })
          }
        }
      }
    } else {
      stallCounts.delete(sid)
    }
    return next()
  })
}

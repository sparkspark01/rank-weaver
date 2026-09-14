/**
 * 发布执行器：唯一的发布入口（dsh-cron 定时会话、看门狗、手动按钮都汇聚到这里）。
 * 幂等闸门：以「今天是否已触发」+「章节状态」双重防重，
 * 番茄侧发布经 tomato-writer-mcp（dist/tomato/service.js）。
 * @module lib/publish
 */

import { state } from './state.mjs'
import * as tomato from './tomato.mjs'

let firing = null

function todayKey(timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

/**
 * 触发一次发布。
 * @param {object} opts { trigger: 'cron'|'watchdog'|'manual', limit?: number }
 *   cron/watchdog：每天至多一次、最多 chaptersPerDay 章；manual：发布全部已确认章节。
 */
export async function firePublish(opts = {}) {
  const trigger = opts.trigger ?? 'manual'
  if (firing) {
    const previous = firing
    return previous
      .then(() => ({ skipped: true, message: '已有发布任务在执行，本次跳过' }))
      .catch(() => ({ skipped: true, message: '已有发布任务在执行，本次跳过' }))
  }
  firing = (async () => {
    const [app, ms, auth] = await Promise.all([state.app(), state.manuscript(), state.auth()])
    if (!app.plan) return { published: 0, message: '还没有发布计划，请先创建定时发布计划' }
    if (!app.selectedBook) return { published: 0, message: '还没有选择要发布的小说（在「番茄鉴权」弹窗里选择）' }
    if (!auth.cookie || !auth.csrfToken) return { published: 0, message: '番茄作家后台鉴权未配置' }

    const plan = app.plan
    const today = todayKey(plan.timeZone)

    if (trigger !== 'manual') {
      if (plan.lastFireAt === today) {
        return { published: 0, alreadyFired: true, message: `今天（${today}）已发布过，跳过` }
      }
      // 时间闸门：cron 会话即触发；watchdog 要求已过 fireTime + 宽限
      if (trigger === 'watchdog') {
        const now = new Date()
        const [h, m] = plan.time.split(':').map(Number)
        const fireAt = new Date()
        fireAt.setHours(h, m, 0, 0)
        if (now.getTime() < fireAt.getTime() + 5 * 60_000) {
          return { published: 0, waiting: true, message: `还没到 ${plan.time}（+5 分钟宽限），看门狗等待中` }
        }
      }
    }

    const limit = trigger === 'manual' ? undefined : (plan.chaptersPerDay ?? 1)
    const queue = ms.chapters
      .filter(c => c.status === 'confirmed')
      .sort((a, b) => a.no - b.no)
    const batch = limit === undefined ? queue : queue.slice(0, limit)
    if (batch.length === 0) {
      return { published: 0, empty: true, message: '没有已确认、待发布的章节。请先生成章节并确认。' }
    }

    const results = []
    let lastError = null
    for (const chapter of batch) {
      try {
        const outcome = await tomato.publishChapter(auth, {
          bookId: app.selectedBook.book_id,
          title: chapter.title,
          content: chapter.content,
        })
        chapter.status = 'published'
        chapter.publishedAt = new Date().toISOString()
        chapter.itemId = outcome.itemId
        await state.setManuscript(ms)
        results.push({ no: chapter.no, title: chapter.title, ok: true, itemId: outcome.itemId })
        await state.log('info', `已发布：${chapter.title}（${app.selectedBook.book_name}）`)
      } catch (error) {
        lastError = error
        results.push({ no: chapter.no, title: chapter.title, ok: false, error: error?.message ?? String(error) })
        await state.log('error', `发布失败：${chapter.title} — ${error?.message ?? error}`)
        break // 失败即停，避免连环脏数据
      }
    }

    if (trigger !== 'manual') {
      await state.updateApp(app => {
        app.plan = { ...app.plan, lastFireAt: today, lastFireAtIso: new Date().toISOString() }
        return app
      })
    }
    const okCount = results.filter(r => r.ok).length
    return {
      published: okCount,
      results,
      message: lastError
        ? `发布了 ${okCount}/${batch.length} 章后失败：${lastError?.message ?? lastError}`
        : `已发布 ${okCount} 章`,
    }
  })().finally(() => { firing = null })
  return firing
}

/** 看门狗：兜底 dsh-cron 定时会话未能触达本服务的情况（幂等，不会重复发布）。 */
export function startWatchdog(intervalMs = 60_000) {
  const timer = setInterval(() => {
    void (async () => {
      const app = await state.app()
      if (!app.plan?.active) return
      const result = await firePublish({ trigger: 'watchdog' }).catch(error => ({ published: 0, error: error?.message ?? String(error) }))
      if (result.published > 0) {
        await state.log('info', `看门狗触发发布：${result.message}`)
      } else if (result.error && !result.waiting && !result.alreadyFired && !result.empty) {
        await state.log('warn', `看门狗发布失败：${result.message ?? result.error}`)
      }
    })()
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

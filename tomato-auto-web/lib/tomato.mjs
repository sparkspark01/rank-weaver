/**
 * tomato-writer-mcp 的运行时桥：直接复用其编译产物（dist/tomato/*），
 * 鉴权来自网页弹窗保存的 state/auth.json，每次调用前注入 process.env
 * （tomato-writer-mcp 的 loadAuth 在每次 createService 时读 env，天然支持热更新）。
 * @module lib/tomato
 */

import { fileURLToPath, pathToFileURL } from 'node:url'

const TOMATO_ROOT = process.env.TOMATO_WRITER_MCP_ROOT
  || (fileURLToPath(new URL('../../tomato-writer-mcp/', import.meta.url)).replace(/\/?$/, '/'))

let cached = null

async function loadModules() {
  if (cached) return cached
  const serviceUrl = pathToFileURL(`${TOMATO_ROOT}dist/tomato/service.js`).href
  const contentUrl = pathToFileURL(`${TOMATO_ROOT}dist/tomato/content.js`).href
  const service = await import(serviceUrl)
  const content = await import(contentUrl)
  cached = { service, content }
  return cached
}

export class TomatoAuthError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TomatoAuthError'
  }
}

/** 注入鉴权并创建 NovelService。 */
export async function createServiceWithAuth(auth) {
  if (!auth?.cookie || !auth?.csrfToken) {
    throw new TomatoAuthError('尚未配置番茄作家后台鉴权（Cookie + CSRF Token）')
  }
  process.env.TOMATO_COOKIE = auth.cookie
  process.env.TOMATO_CSRF_TOKEN = auth.csrfToken
  const { service } = await loadModules()
  return service.createService()
}

export async function listNovels(auth) {
  const svc = await createServiceWithAuth(auth)
  const list = await svc.listNovels()
  return list.map(b => ({
    book_id: String(b.book_id),
    book_name: b.book_name,
    word_count: b.word_count ?? null,
    read_count: b.read_count ?? null,
    creation_status: b.creation_status ?? b.status ?? null,
  }))
}

/**
 * 发布一章（tomato-writer-mcp: 建草稿 + publish_article）。
 * @param {object} auth
 * @param {object} opts { bookId, title, content(纯文本或<p>HTML), timerTime? }
 */
export async function publishChapter(auth, opts) {
  const svc = await createServiceWithAuth(auth)
  const { content } = await loadModules()
  const html = content.toChapterHtml(opts.content)
  const result = await svc.publishChapter({
    bookId: opts.bookId,
    title: opts.title,
    content: html,
    ...(opts.timerTime === undefined ? {} : { timerTime: opts.timerTime }),
  })
  return { itemId: result.itemId, timed: result.timed, timerTime: result.timerTime }
}

/** 列出章节（用于发布后对账）。 */
export async function listChapters(auth, bookId) {
  const svc = await createServiceWithAuth(auth)
  const volumesRaw = await svc.listVolumes(bookId)
  const vlist = Array.isArray(volumesRaw) ? volumesRaw : (volumesRaw?.volume_list ?? volumesRaw?.list ?? [])
  const volumes = []
  for (const v of vlist) {
    const vid = String(v.volume_id ?? v.id ?? '')
    if (!vid) continue
    try {
      const chapters = await svc.listChapters(bookId, vid)
      volumes.push({ volume_id: vid, volume_name: v.volume_name, chapters })
    } catch {
      volumes.push({ volume_id: vid, volume_name: v.volume_name, error: 'chapters unavailable' })
    }
  }
  return volumes
}

/** 正文转 <p> HTML（复用 tomato-writer-mcp 的 content.ts）。 */
export async function toChapterHtml(text) {
  const { content } = await loadModules()
  return content.toChapterHtml(text)
}

/**
 * 应用状态存储：JSON 文件 + 进程内互斥（单进程服务，串行读改写即可）。
 * state/app.json        业务状态（大纲、计划、选中书籍、日志）
 * state/auth.json       番茄鉴权（敏感，绝不通过 API 全量返回）
 * state/config.json     Agent API 配置（敏感，apiKey 掩码返回）
 * state/manuscript.json 章节手稿
 * state/reports/        推荐/大纲报告
 * @module lib/state
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STATE_DIR = process.env.TOMATO_AUTO_STATE_DIR
  || join(fileURLToPath(new URL('../state/', import.meta.url)))

let chain = Promise.resolve()

/** 互斥执行一段读改写。 */
function withLock(fn) {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

function readJson(file, fallback) {
  try {
    // 容忍外部编辑器写入的 UTF-8 BOM，否则手工编辑过的配置会被静默忽略
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify(value, null, 2))
  renameSync(temporary, file)
}

const APP_FILE = join(STATE_DIR, 'app.json')
const AUTH_FILE = join(STATE_DIR, 'auth.json')
const CONFIG_FILE = join(STATE_DIR, 'config.json')
const MANUSCRIPT_FILE = join(STATE_DIR, 'manuscript.json')
const REPORTS_DIR = join(STATE_DIR, 'reports')

const EMPTY_APP = () => ({
  outline: null,             // { matched, level, report, outline, questions, plot, source }
  outlineConfirmedAt: null,
  plan: null,                // { time, chaptersPerDay, timeZone, expression, cronJobId, nextFires, createdAt, lastFireAt, active }
  selectedBook: null,        // { book_id, book_name }
  log: [],                   // [{ at, level, message }]
})

export const state = {
  app: () => withLock(() => readJson(APP_FILE, EMPTY_APP())),
  updateApp: (patch) => withLock(() => {
    const app = readJson(APP_FILE, EMPTY_APP())
    const next = typeof patch === 'function' ? patch(app) : { ...app, ...patch }
    writeJson(APP_FILE, next)
    return next
  }),
  auth: () => withLock(() => readJson(AUTH_FILE, {})),
  setAuth: (auth) => withLock(() => {
    writeJson(AUTH_FILE, { ...auth, savedAt: new Date().toISOString() })
    return readJson(AUTH_FILE, {})
  }),
  config: () => withLock(() => readJson(CONFIG_FILE, { agentApi: null })),
  setConfig: (patch) => withLock(() => {
    const config = readJson(CONFIG_FILE, { agentApi: null })
    const next = { ...config, ...patch }
    writeJson(CONFIG_FILE, next)
    return next
  }),
  manuscript: () => withLock(() => readJson(MANUSCRIPT_FILE, { chapters: [] })),
  setManuscript: (patch) => withLock(() => {
    const ms = readJson(MANUSCRIPT_FILE, { chapters: [] })
    const next = typeof patch === 'function' ? patch(ms) : patch
    writeJson(MANUSCRIPT_FILE, next)
    return next
  }),
  saveReport: (name, report) => withLock(() => {
    mkdirSync(REPORTS_DIR, { recursive: true })
    const file = join(REPORTS_DIR, `${Date.now()}-${name}.json`)
    writeJson(file, { ...report, savedAt: new Date().toISOString() })
    return file
  }),
  listReports: (name) => withLock(() => {
    if (!existsSync(REPORTS_DIR)) return []
    return readdirSync(REPORTS_DIR)
      .filter(f => f.endsWith(`-${name}.json`))
      .sort()
      .reverse()
      .map(f => join(REPORTS_DIR, f))
  }),
  log: (level, message) => state.updateApp((app) => {
    app.log = [{ at: new Date().toISOString(), level, message }, ...(app.log ?? [])].slice(0, 200)
    return app
  }),
}

/** 对外可见状态（脱敏）。 */
export async function publicState() {
  const [app, auth, config, ms] = await Promise.all([
    state.app(), state.auth(), state.config(), state.manuscript(),
  ])
  const agentApi = config.agentApi
  return {
    tomato: {
      configured: Boolean(auth.cookie && auth.csrfToken),
      cookieMasked: auth.cookie ? mask(auth.cookie) : null,
      savedAt: auth.savedAt ?? null,
    },
    agentApi: agentApi
      ? { baseUrl: agentApi.baseUrl, model: agentApi.model, apiKeyMasked: mask(agentApi.apiKey) }
      : null,
    selectedBook: app.selectedBook,
    outline: app.outline ? {
      matched: app.outline.matched,
      level: app.outline.level,
      plot: app.outline.plot,
      questions: app.outline.questions ?? null,
      outline: app.outline.outline ?? null,
      report: app.outline.report ?? null,
      source: app.outline.source ?? null,
    } : null,
    outlineConfirmed: Boolean(app.outlineConfirmedAt),
    plan: app.plan ? { ...app.plan } : null,
    manuscript: {
      chapters: ms.chapters.map(c => ({ ...c })),
      confirmedCount: ms.chapters.filter(c => c.status === 'confirmed').length,
      publishedCount: ms.chapters.filter(c => c.status === 'published').length,
      draftCount: ms.chapters.filter(c => c.status === 'draft').length,
    },
    log: (app.log ?? []).slice(0, 50),
  }
}

function mask(value) {
  const s = String(value)
  if (s.length <= 12) return '••••••••'
  return `${s.slice(0, 8)}••••••••${s.slice(-4)}`
}

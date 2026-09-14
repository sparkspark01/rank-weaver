/**
 * 番茄自动化 Web 控制台后端。
 * - 零运行时依赖（node:http + fetch），Node 18+（推荐 24）
 * - 推荐/大纲/章节生成 → Agent API（OpenAI 兼容，弹窗配置）+ 内置 fenxi/du-nai skill 指令
 * - 定时发布 → dsh-cron store（jobs.json 直写，插件热重载）→ 每日触发 → tomato-writer-mcp 发布
 * @module server
 */

import { createServer } from 'node:http'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chat, testConfig } from './lib/agent.mjs'
import { fetchHotList } from './lib/fanqie.mjs'
import { CronStoreFile, defaultCronDataDir } from './lib/cron-store.mjs'
import { dailyExpression, previewOccurrences, hostTimeZone } from './lib/cron-next.mjs'
import { state, publicState } from './lib/state.mjs'
import { createTask, enqueue, getTask, taskJson } from './lib/tasks.mjs'
import { firePublish, startWatchdog } from './lib/publish.mjs'
import { buildRecommendMessages, buildOutlineMessages, buildChapterMessages, parseChapter, parseOutlineJson } from './lib/prompts.mjs'
import { listNovels } from './lib/tomato.mjs'

const APP_DIR = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC_DIR = join(APP_DIR, 'public')
const PORT = Number(process.env.PORT || 3210)
const HOST = process.env.HOST || '127.0.0.1'
const TOMATO_MCP_DIR = process.env.TOMATO_WRITER_MCP_ROOT
  || fileURLToPath(new URL('../tomato-writer-mcp/', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}
const bad = (res, message, status = 400) => json(res, status, { error: message })

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

async function requireAgentConfig() {
  const config = await state.config()
  if (!config.agentApi?.apiKey) throw new Error('尚未配置 Agent API，请先点击右上角「Agent API」填写')
  return config.agentApi
}

/** 推荐与大纲用的榜单数据：优先现抓，失败回退最近一次推荐报告里缓存的数据。 */
async function hotListWithFallback() {
  try {
    return await fetchHotList()
  } catch (error) {
    const files = state.listReports('recommend')
    for (const file of files) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8'))
        if (saved?.hotList?.books?.length) {
          return { ...saved.hotList, cached: true, fetchError: error?.message ?? String(error) }
        }
      } catch { /* 继续找 */ }
    }
    throw error
  }
}

function outlineMarkdown(app) {
  return app.outline?.outline ?? `大纲缺失`
}

function publishedSummary(ms) {
  const published = ms.chapters.filter(c => c.status === 'published').sort((a, b) => a.no - b.no)
  const confirmed = ms.chapters.filter(c => c.status === 'confirmed').sort((a, b) => a.no - b.no)
  if (published.length === 0 && confirmed.length === 0) return null
  const lines = []
  for (const c of published) lines.push(`第${c.no}章 ${c.title.replace(/^第\d+章\s*/, '')}（已发布）`)
  for (const c of confirmed) lines.push(`第${c.no}章 ${c.title.replace(/^第\d+章\s*/, '')}（已确认待发布）`)
  return lines.join('\n')
}

/** dsh-cron job prompt：定时会话只负责触发本服务，由本服务执行发布。 */
function cronJobPrompt() {
  return [
    '[SCHEDULED TASK] 番茄小说定时发布',
    '本任务由「番茄自动化」控制台创建。请在本次 fresh Session 中完成一步操作：',
    `1. 向本地控制台发送 HTTP 请求触发发布：POST http://127.0.0.1:${PORT}/api/publish/fire`,
    '   请求体 JSON：{"trigger":"cron"}（用 pwsh Invoke-RestMethod 或任意 HTTP 方式）。',
    '2. 汇报返回的 JSON 结果（published、results、message）。',
    '3. 若本地控制台未启动（连接被拒绝），直接汇报「控制台未运行，本次发布未执行」，不要尝试其他发布方式。',
    '任务结束。',
  ].join('\n')
}

// ---------------------------------------------------------------- routes

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  const route = async () => {
    // 静态资源
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] })
      return res.end(readFileSync(join(PUBLIC_DIR, 'index.html')))
    }
    if (method === 'GET' && /^\/(app\.js|style\.css)$/.test(path)) {
      const file = join(PUBLIC_DIR, path.slice(1))
      if (!existsSync(file)) return bad(res, 'not found', 404)
      const ext = path.slice(path.lastIndexOf('.'))
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
      return res.end(readFileSync(file))
    }

    // 状态
    if (method === 'GET' && path === '/api/state') return json(res, 200, await publicState())
    if (method === 'GET' && path === '/api/log') {
      const app = await state.app()
      return json(res, 200, { log: app.log ?? [] })
    }

    // 任务轮询
    if (method === 'GET' && path.startsWith('/api/tasks/')) {
      const task = getTask(path.slice('/api/tasks/'.length))
      if (!task) return bad(res, 'task not found', 404)
      return json(res, 200, taskJson(task))
    }

    // ---------- Agent API 配置 ----------
    if (method === 'POST' && path === '/api/agent-api') {
      try {
        const body = await readBody(req)
        const existing = (await state.config()).agentApi
        const candidate = {
          baseUrl: String(body.baseUrl ?? '').trim(),
          apiKey: String(body.apiKey ?? '').trim() || existing?.apiKey || '',
          model: String(body.model ?? '').trim(),
        }
        if (!candidate.baseUrl || !candidate.apiKey || !candidate.model) {
          return bad(res, 'baseUrl / apiKey / model 均必填')
        }
        const test = await testConfig(candidate)
        await state.setConfig({ agentApi: candidate })
        await state.log('info', `Agent API 已配置（${candidate.baseUrl} / ${candidate.model}）并验证通过`)
        return json(res, 200, { ok: true, test })
      } catch (error) {
        return bad(res, `验证失败：${error?.message ?? error}`, 502)
      }
    }
    if (method === 'POST' && path === '/api/agent-api/test') {
      try {
        const body = await readBody(req)
        const test = await testConfig({
          baseUrl: String(body.baseUrl ?? '').trim(),
          apiKey: String(body.apiKey ?? '').trim(),
          model: String(body.model ?? '').trim(),
        })
        return json(res, 200, { ok: true, test })
      } catch (error) {
        return bad(res, `验证失败：${error?.message ?? error}`, 502)
      }
    }
    if (method === 'DELETE' && path === '/api/agent-api') {
      await state.setConfig({ agentApi: null })
      await state.log('info', 'Agent API 配置已清除')
      return json(res, 200, { ok: true })
    }

    // ---------- 番茄鉴权 ----------
    if (method === 'POST' && path === '/api/tomato-auth') {
      try {
        const body = await readBody(req)
        const cookie = String(body.cookie ?? '').trim()
        const csrfToken = String(body.csrfToken ?? '').trim()
        if (!cookie || !csrfToken) return bad(res, 'Cookie 与 X-Secsdk-Csrf-Token 均必填')
        // 先验证再保存
        let novels = []
        try {
          novels = await listNovels({ cookie, csrfToken })
        } catch (error) {
          return bad(res, `鉴权验证失败（未写入）：${error?.message ?? error}`, 502)
        }
        await state.setAuth({ cookie, csrfToken })
        await mirrorTomatoEnv({ cookie, csrfToken })
        await state.log('info', `番茄鉴权已保存并验证通过（${novels.length} 本书）`)
        return json(res, 200, { ok: true, novels })
      } catch (error) {
        return bad(res, error?.message ?? String(error), 400)
      }
    }
    if (method === 'GET' && path === '/api/novels') {
      try {
        const auth = await state.auth()
        if (!auth.cookie) return bad(res, '尚未配置番茄鉴权', 401)
        return json(res, 200, { novels: await listNovels(auth) })
      } catch (error) {
        return bad(res, `获取书单失败：${error?.message ?? error}`, 502)
      }
    }
    if (method === 'POST' && path === '/api/novels/select') {
      try {
        const body = await readBody(req)
        const bookId = String(body.bookId ?? '').trim()
        if (!bookId) return bad(res, '缺少 bookId')
        const auth = await state.auth()
        const novels = await listNovels(auth)
        const novel = novels.find(b => String(b.book_id) === bookId)
        if (!novel) return bad(res, `书单中找不到 book_id=${bookId}`)
        await state.updateApp(app => ({ ...app, selectedBook: { book_id: novel.book_id, book_name: novel.book_name } }))
        await state.log('info', `目标小说：${novel.book_name}`)
        return json(res, 200, { ok: true, selected: { book_id: novel.book_id, book_name: novel.book_name } })
      } catch (error) {
        return bad(res, error?.message ?? String(error), 502)
      }
    }

    // ---------- 推荐功能 ----------
    if (method === 'POST' && path === '/api/recommend') {
      const config = await requireAgentConfig().catch(error => { bad(res, error.message, 428); return null })
      if (config === null) return
      const task = createTask('recommend', '番茄热门题材分析 + 新书指南')
      enqueue(task, async () => {
        const hotList = await hotListWithFallback()
        const messages = buildRecommendMessages(hotList)
        const report = await chat(config, messages, { temperature: 0.6, maxTokens: 6000, timeoutMs: 300_000 })
        await state.saveReport('recommend', { report, hotList })
        await state.log('info', `推荐报告生成完成（来源：${hotList.cached ? '缓存榜单' : '实时榜单'}）`)
        return { report, hotList, generatedAt: new Date().toISOString() }
      })
      return json(res, 202, taskJson(task))
    }
    if (method === 'GET' && path === '/api/recommend/latest') {
      const files = state.listReports('recommend')
      if (files.length === 0) return json(res, 200, { latest: null })
      try {
        const latest = JSON.parse(readFileSync(files[0], 'utf8'))
        return json(res, 200, { latest: { report: latest.report, hotList: latest.hotList, savedAt: latest.savedAt } })
      } catch {
        return json(res, 200, { latest: null })
      }
    }

    // ---------- 生成功能 ----------
    if (method === 'POST' && path === '/api/outline') {
      const config = await requireAgentConfig().catch(error => { bad(res, error.message, 428); return null })
      if (config === null) return
      try {
        const body = await readBody(req)
        const plot = String(body.plot ?? '').trim()
        if (plot.length < 10) return bad(res, '剧情描述太短（至少 10 字）')
        const task = createTask('outline', '剧情匹配评估 + 大纲生成')
        enqueue(task, async () => {
          const hotList = await hotListWithFallback()
          const messages = buildOutlineMessages(plot, hotList)
          const raw = await chat(config, messages, { temperature: 0.6, maxTokens: 6000, json: true, timeoutMs: 300_000 })
          const parsed = parseOutlineJson(raw)
          const record = { ...parsed, plot, source: { date: hotList.date, url: hotList.source?.url, cached: Boolean(hotList.cached) } }
          await state.updateApp(app => ({ ...app, outline: record, outlineConfirmedAt: null }))
          await state.saveReport('outline', { record, hotList })
          await state.log('info', `大纲生成完成：${record.matched ? `匹配 ${record.level}` : '未匹配，输出疑问清单'}`)
          return record
        })
        return json(res, 202, taskJson(task))
      } catch (error) {
        return bad(res, error?.message ?? String(error), 400)
      }
    }
    if (method === 'POST' && path === '/api/outline/confirm') {
      const app = await state.app()
      if (!app.outline?.outline) return bad(res, '没有可确认的大纲（匹配成功才会生成大纲）')
      await state.updateApp(a => ({ ...a, outlineConfirmedAt: new Date().toISOString() }))
      await state.log('info', '大纲已确认，可以开始生成章节与定时发布')
      return json(res, 200, { ok: true })
    }
    if (method === 'POST' && path === '/api/outline/reset') {
      await state.updateApp(a => ({ ...a, outline: null, outlineConfirmedAt: null }))
      await state.setManuscript({ chapters: [] })
      await state.log('info', '大纲与章节手稿已清空')
      return json(res, 200, { ok: true })
    }

    // ---------- 章节生成（du-nai） ----------
    if (method === 'POST' && path === '/api/chapters/generate') {
      const config = await requireAgentConfig().catch(error => { bad(res, error.message, 428); return null })
      if (config === null) return
      try {
        const body = await readBody(req)
        const count = Math.min(Math.max(Number(body.count ?? 1) || 1, 1), 5)
        const app = await state.app()
        if (!app.outlineConfirmedAt) return bad(res, '请先确认大纲（在「生成」卡片里确认）')
        const task = createTask('chapters', `du-nai 生成 ${count} 章`)
        enqueue(task, async (progress) => {
          const generated = []
          for (let index = 0; index < count; index++) {
            const ms = await state.manuscript()
            const nextNo = ms.chapters.reduce((max, c) => Math.max(max, c.no), 0) + 1
            const previous = [...ms.chapters].sort((a, b) => b.no - a.no)[0] ?? null
            progress(`正在生成第 ${nextNo} 章（${index + 1}/${count}）`)
            const messages = buildChapterMessages({
              outline: outlineMarkdown(app),
              nextNo,
              previousChapter: previous ? { no: previous.no, content: previous.content } : null,
              publishedSummary: publishedSummary(ms),
            })
            const raw = await chat(config, messages, { temperature: 0.9, maxTokens: 5000, timeoutMs: 300_000 })
            const chapter = parseChapter(raw, nextNo)
            chapter.status = 'draft'
            chapter.createdAt = new Date().toISOString()
            await state.setManuscript(ms2 => {
              ms2.chapters.push(chapter)
              return ms2
            })
            generated.push({ no: chapter.no, title: chapter.title, status: chapter.status })
          }
          await state.log('info', `du-nai 生成了 ${generated.length} 章（待确认）`)
          return { generated }
        })
        return json(res, 202, taskJson(task))
      } catch (error) {
        return bad(res, error?.message ?? String(error), 400)
      }
    }
    if (method === 'POST' && path === '/api/chapters/confirm') {
      const body = await readBody(req)
      const no = Number(body.no)
      const result = await state.setManuscript((ms) => {
        let count = 0
        for (const c of ms.chapters) {
          if ((Number.isFinite(no) && c.no === no) || (!Number.isFinite(no))) {
            if (c.status === 'draft') {
              c.status = 'confirmed'
              count += 1
            }
          }
        }
        return ms
      })
      await state.log('info', `已确认 ${result.chapters.filter(c => c.status === 'confirmed').length} 章待发布`)
      return json(res, 200, { ok: true })
    }
    if (method === 'POST' && path === '/api/chapters/regenerate') {
      const config = await requireAgentConfig().catch(error => { bad(res, error.message, 428); return null })
      if (config === null) return
      const body = await readBody(req)
      const no = Number(body.no)
      if (!Number.isFinite(no)) return bad(res, '缺少章节号')
      const task = createTask('chapters', `重写第 ${no} 章`)
      enqueue(task, async () => {
        const [app, ms] = await Promise.all([state.app(), state.manuscript()])
        const target = ms.chapters.find(c => c.no === no)
        if (!target) throw new Error(`没有第 ${no} 章`)
        if (target.status === 'published') throw new Error('已发布的章节不能重写')
        const previous = [...ms.chapters].filter(c => c.no < no).sort((a, b) => b.no - a.no)[0] ?? null
        const messages = buildChapterMessages({
          outline: outlineMarkdown(app),
          nextNo: no,
          previousChapter: previous ? { no: previous.no, content: previous.content } : null,
          publishedSummary: publishedSummary(ms),
        })
        const raw = await chat(config, messages, { temperature: 0.9, maxTokens: 5000, timeoutMs: 300_000 })
        const chapter = parseChapter(raw, no)
        await state.setManuscript((m) => {
          const t = m.chapters.find(c => c.no === no)
          if (t) {
            t.title = chapter.title
            t.content = chapter.content
            t.status = 'draft'
            t.updatedAt = new Date().toISOString()
          }
          return m
        })
        await state.log('info', `第 ${no} 章已重写（待重新确认）`)
        return { no, title: chapter.title }
      })
      return json(res, 202, taskJson(task))
    }
    if (method === 'POST' && path === '/api/chapters/edit') {
      const body = await readBody(req)
      const no = Number(body.no)
      const title = String(body.title ?? '').trim()
      const content = String(body.content ?? '').trim()
      if (!Number.isFinite(no) || !content) return bad(res, '缺少章节号或正文')
      const ms = await state.manuscript()
      const target = ms.chapters.find(c => c.no === no)
      if (!target) return bad(res, `没有第 ${no} 章`, 404)
      if (target.status === 'published') return bad(res, '已发布的章节不能编辑')
      target.content = content
      if (title) target.title = title
      if (target.status === 'confirmed') target.status = 'draft'
      target.updatedAt = new Date().toISOString()
      await state.setManuscript(ms)
      await state.log('info', `第 ${no} 章已手动编辑（待确认）`)
      return json(res, 200, { ok: true })
    }
    if (method === 'DELETE' && path === '/api/chapters') {
      const body = await readBody(req)
      const no = Number(body.no)
      await state.setManuscript((ms) => {
        const target = ms.chapters.find(c => c.no === no)
        if (target && target.status !== 'published') ms.chapters = ms.chapters.filter(c => c.no !== no)
        return ms
      })
      return json(res, 200, { ok: true })
    }

    // ---------- 定时发布计划（dsh-cron） ----------
    if (method === 'POST' && path === '/api/schedule') {
      try {
        const body = await readBody(req)
        const time = String(body.time ?? '').trim()
        const chaptersPerDay = Math.min(Math.max(Number(body.chaptersPerDay ?? 1) || 1, 1), 20)
        const timeZone = String(body.timeZone ?? '').trim() || hostTimeZone()
        const app = await state.app()
        if (!app.outlineConfirmedAt) return bad(res, '请先确认大纲')
        if (!app.selectedBook) return bad(res, '请先在「番茄鉴权」弹窗里选择目标小说')
        if (app.plan?.active) return bad(res, '已有生效中的发布计划，先取消再重建')

        const expression = dailyExpression(time, timeZone)
        const store = new CronStoreFile(join(defaultCronDataDir(), 'jobs.json'))
        const { job } = await store.addJob({
          prompt: cronJobPrompt(),
          schedule: { kind: 'cron', expression },
          target: { kind: 'fresh', cwd: APP_DIR },
          createdBy: 'tomato-auto-web',
          concurrencyLimit: 1,
          timeZone,
        })
        const nextFires = previewOccurrences(expression, timeZone, Date.now(), 5)
        const plan = {
          time,
          chaptersPerDay,
          timeZone,
          expression,
          cronJobId: job.id,
          nextFires,
          createdAt: new Date().toISOString(),
          lastFireAt: null,
          active: true,
          storeFile: join(defaultCronDataDir(), 'jobs.json'),
        }
        await state.updateApp(a => ({ ...a, plan }))
        await state.log('info', `发布计划已创建：每天 ${time}（${timeZone}）发布 ${chaptersPerDay} 章，cron job=${job.id}`)
        return json(res, 200, { ok: true, plan })
      } catch (error) {
        return bad(res, `创建计划失败：${error?.message ?? error}`)
      }
    }
    if (method === 'POST' && path === '/api/schedule/cancel') {
      try {
        const app = await state.app()
        if (!app.plan) return bad(res, '当前没有发布计划')
        const store = new CronStoreFile(join(defaultCronDataDir(), 'jobs.json'))
        if (app.plan.cronJobId) await store.removeJob(app.plan.cronJobId)
        await state.updateApp(a => ({ ...a, plan: null }))
        await state.log('info', `发布计划已取消（cron job=${app.plan.cronJobId} 已从 store 移除）`)
        return json(res, 200, { ok: true })
      } catch (error) {
        return bad(res, `取消失败：${error?.message ?? error}`)
      }
    }
    if (method === 'GET' && path === '/api/schedule') {
      const app = await state.app()
      if (!app.plan) return json(res, 200, { plan: null })
      const store = new CronStoreFile(join(defaultCronDataDir(), 'jobs.json'))
      let jobs = []
      try {
        jobs = store.list().filter(j => j.createdBy === 'tomato-auto-web' || j.id === app.plan.cronJobId)
      } catch { /* store 不可读时仅展示计划 */ }
      const preview = app.plan.expression
        ? previewOccurrences(app.plan.expression, app.plan.timeZone, Date.now(), 5)
        : []
      return json(res, 200, { plan: { ...app.plan, nextFires: preview }, storeJobs: jobs })
    }

    // ---------- 发布触发 ----------
    if (method === 'POST' && path === '/api/publish/fire') {
      const body = await readBody(req).catch(() => ({}))
      const trigger = body.trigger === 'manual' ? 'manual' : 'cron'
      const result = await firePublish({ trigger }).catch(error => ({ published: 0, error: error?.message ?? String(error) }))
      return json(res, result.error ? 502 : 200, result)
    }
    if (method === 'POST' && path === '/api/publish/now') {
      const result = await firePublish({ trigger: 'manual' }).catch(error => ({ published: 0, error: error?.message ?? String(error) }))
      return json(res, result.error ? 502 : 200, result)
    }

    return bad(res, `未知接口：${method} ${path}`, 404)
  }

  route().catch((error) => {
    console.error('[tomato-auto-web]', error)
    if (!res.headersSent) bad(res, error?.message ?? String(error), 500)
    else res.end()
  })
})

/** 把鉴权镜像到 tomato-writer-mcp/.env，独立 MCP server 也能用。 */
function mirrorTomatoEnv(auth) {
  const envFile = join(TOMATO_MCP_DIR, '.env')
  const existing = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
  const kept = existing.split(/\r?\n/).filter(line => line.trim() && !/^(TOMATO_COOKIE|TOMATO_CSRF_TOKEN)=/.test(line))
  const content = [
    ...kept,
    `TOMATO_COOKIE=${auth.cookie}`,
    `TOMATO_CSRF_TOKEN=${auth.csrfToken}`,
    '',
  ].join('\n')
  writeFileSync(envFile, content)
  return envFile
}

startWatchdog()

server.listen(PORT, HOST, () => {
  console.log(`番茄自动化控制台：http://${HOST}:${PORT}`)
  console.log(`- Agent API 在页面右上角配置（OpenAI 兼容 /chat/completions）`)
  console.log(`- dsh-cron store：${join(defaultCronDataDir(), 'jobs.json')}`)
  console.log(`- tomato-writer-mcp：${TOMATO_MCP_DIR}`)
})

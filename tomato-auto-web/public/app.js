/* 番茄自动化控制台前端逻辑
   本次优化重点：
   1. 弹窗改为 .open 类控制（旧版 display:flex 覆盖了 [hidden]，导致首屏三个全屏遮罩同时展开、"卡死"）
   2. 弹窗按步骤顺序引导：Agent API(1) → 番茄鉴权+选书(2) → 生成(3-5) → 定时发布(6)
   3. 用页内 toast / 确认框替代阻塞式 alert/confirm，不再冻结页面渲染
   4. 状态渲染去重，5 秒轮询不再整页重建 DOM
   5. 断连提示 + 长任务流动进度条 + 任务超时保护
*/
'use strict'

const $ = (id) => document.getElementById(id)

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  })
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
const del = (path, body) => api(path, { method: 'DELETE', body: JSON.stringify(body ?? {}) })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------- Toast（替代 alert）

function toast(message, type = 'info', ms = 4200) {
  const box = $('toasts')
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.textContent = message
  box.appendChild(el)
  setTimeout(() => {
    el.classList.add('hide')
    setTimeout(() => el.remove(), 300)
  }, ms)
  while (box.children.length > 4) box.firstChild.remove()
}

// ---------------------------------------------------------------- 弹窗管理器

const MODAL_IDS = ['modal-agent', 'modal-tomato', 'modal-chapter', 'modal-confirm']
const modalHooks = {}   // id -> { onOpen, onClose }

function openModal(id, opts = {}) {
  for (const other of MODAL_IDS) {
    if (other !== id) closeModal(other, { silent: true })
  }
  const el = $(id)
  el.classList.add('open')
  el.removeAttribute('hidden')
  document.body.classList.add('modal-open')
  modalHooks[id]?.onOpen?.(opts)
  const target = opts.focus ? $(opts.focus) : el.querySelector('input:not([type=hidden]), textarea, select, button')
  if (target) setTimeout(() => target.focus(), 30)
}

function closeModal(id, opts = {}) {
  const el = $(id)
  if (!el.classList.contains('open')) return
  el.classList.remove('open')
  if (!MODAL_IDS.some(m => $(m).classList.contains('open'))) document.body.classList.remove('modal-open')
  if (!opts.silent) modalHooks[id]?.onClose?.()
}

function closeAllModals() { for (const id of MODAL_IDS) closeModal(id) }

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  const open = MODAL_IDS.filter(id => $(id).classList.contains('open'))
  if (open.length > 0) closeModal(open[open.length - 1])
})

for (const id of MODAL_IDS) {
  const el = $(id)
  el.addEventListener('mousedown', (e) => { if (e.target === el) closeModal(id) })
  el.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(id)))
}

// ---------------------------------------------------------------- 确认框（替代 confirm）

let confirmResolver = null
function askConfirm(text, title = '确认操作') {
  $('confirm-title').textContent = title
  $('confirm-text').textContent = text
  openModal('modal-confirm', { focus: 'confirm-ok' })
  return new Promise((resolve) => { confirmResolver = resolve })
}
modalHooks['modal-confirm'] = {
  onClose: () => { if (confirmResolver) { confirmResolver(false); confirmResolver = null } },
}
$('confirm-ok').addEventListener('click', () => {
  closeModal('modal-confirm', { silent: true })
  if (confirmResolver) { confirmResolver(true); confirmResolver = null }
})
$('confirm-cancel').addEventListener('click', () => closeModal('modal-confirm'))

// ---------------------------------------------------------------- 状态

let state = null
let lastSig = ''
let connFailures = 0
let firstLoadDone = false

async function refreshState({ force = false } = {}) {
  let next
  try {
    next = await api('/api/state')
  } catch (error) {
    connFailures += 1
    if (connFailures >= 2) {
      setConn(false, `无法连接控制台后端服务（${error.message}）。请确认启动窗口仍在运行；若已关闭，双击 启动控制台.bat 重新启动。`)
    }
    return
  }
  connFailures = 0
  setConn(true)
  state = next
  const sig = stateSig(next)
  if (!force && sig === lastSig) return
  lastSig = sig
  renderState()
}

function setConn(ok, message) {
  const el = $('conn-banner')
  if (ok) {
    if (!el.hidden) el.hidden = true
    return
  }
  el.hidden = false
  el.className = 'banner err'
  el.textContent = message
}

/** 只取渲染真正依赖的字段，避免 5 秒轮询整页重建。 */
function stateSig(s) {
  return JSON.stringify([
    s.tomato?.configured, s.tomato?.cookieMasked, s.agentApi?.model, s.agentApi?.baseUrl,
    s.selectedBook?.book_id, s.outline?.level, s.outline?.outline ? s.outline.outline.length : 0,
    s.outline?.questions?.length ?? 0, s.outlineConfirmed,
    s.plan?.cronJobId, s.plan?.active, s.plan?.time, s.plan?.chaptersPerDay, s.plan?.lastFireAt,
    (s.manuscript?.chapters ?? []).map(c => `${c.no}|${c.status}|${c.content.length}|${c.updatedAt ?? ''}|${c.title}`),
    (s.log ?? []).length, s.log?.[0]?.at ?? '',
  ])
}

// ---------------------------------------------------------------- 引导顺序

/** 依「配置 → 内容 → 发布」的真实依赖顺序计算当前步骤。 */
function currentStep() {
  if (!state?.agentApi) return 1
  if (!state.tomato?.configured || !state.selectedBook) return 2
  if (!state.outline && (state.manuscript?.chapters?.length ?? 0) === 0) return 3
  if (!state.outlineConfirmed) return 4
  if ((state.manuscript?.confirmedCount ?? 0) + (state.manuscript?.publishedCount ?? 0) === 0) return 5
  if (!state.plan?.active) return 6
  return 0
}

function renderSteps() {
  const done = {
    1: Boolean(state?.agentApi),
    2: Boolean(state?.tomato?.configured && state?.selectedBook),
    3: Boolean(state?.outline) || (state?.manuscript?.chapters?.length ?? 0) > 0,
    4: Boolean(state?.outlineConfirmed),
    5: (state?.manuscript?.confirmedCount ?? 0) + (state?.manuscript?.publishedCount ?? 0) > 0,
    6: Boolean(state?.plan?.active),
  }
  const now = currentStep()
  for (let i = 1; i <= 6; i++) {
    const el = $(`step-${i}`)
    el.classList.toggle('done', done[i] && now !== i)
    el.classList.toggle('current', now === i)
  }
  $('steps').hidden = now === 0
}

function focusCard(id) {
  const el = $(id)
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.remove('flash')
  void el.offsetWidth
  el.classList.add('flash')
  setTimeout(() => el.classList.remove('flash'), 2600)
}

/** 需要 Agent API 的功能统一入口；缺失时按顺序弹出「第 1 步」弹窗。 */
function requireAgentApi() {
  if (state?.agentApi) return true
  toast('请先配置 Agent API（第 1 步），推荐 / 大纲 / 章节生成都依赖它', 'warn', 5000)
  openModal('modal-agent', { focus: 'agent-base' })
  return false
}

/** 定时发布的前置检查，按依赖顺序打开对应弹窗。 */
function requirePublishReady() {
  if (!state?.outlineConfirmed) {
    toast('请先在「生成」卡片确认大纲（第 4 步）', 'warn', 5000)
    focusCard('card-outline')
    return false
  }
  if (!state?.tomato?.configured) {
    toast('请先配置番茄作家后台鉴权（第 2 步）', 'warn', 5000)
    openModal('modal-tomato', { focus: 'tomato-cookie' })
    return false
  }
  if (!state?.selectedBook) {
    toast('请选择要发布的目标小说（第 2 步）', 'warn', 5000)
    openModal('modal-tomato', { focus: 'book-select' })
    void loadBooks()
    return false
  }
  return true
}

/** 首次打开页面：按 1 → 2 的顺序引导，不叠加弹窗。 */
function firstRunGuide() {
  if (sessionStorage.getItem('guide-shown') === '1') return
  const step = currentStep()
  if (step !== 1 && step !== 2) return
  sessionStorage.setItem('guide-shown', '1')
  if (step === 1) {
    toast('首次使用：按步骤条顺序配置，先填 Agent API（第 1 步）', 'info', 6000)
    openModal('modal-agent', { focus: 'agent-base' })
  } else {
    toast('Agent API 已就绪，接着配置番茄鉴权并选书（第 2 步）', 'info', 6000)
    openModal('modal-tomato', { focus: 'tomato-cookie' })
  }
}

// ---------------------------------------------------------------- 渲染

function renderState() {
  if (!state) return
  const agentChip = $('chip-agent')
  if (state.agentApi) {
    agentChip.textContent = `🤖 Agent API：${state.agentApi.model}`
    agentChip.classList.add('ok')
  } else {
    agentChip.textContent = '🤖 Agent API：未配置'
    agentChip.classList.remove('ok')
  }
  const tomatoChip = $('chip-tomato')
  if (state.tomato.configured) {
    tomatoChip.textContent = '🔑 番茄鉴权：已配置'
    tomatoChip.classList.add('ok')
  } else {
    tomatoChip.textContent = '🔑 番茄鉴权：未配置'
    tomatoChip.classList.remove('ok')
  }
  $('chip-book').textContent = state.selectedBook
    ? `📖 目标小说：${state.selectedBook.book_name}`
    : '📖 目标小说：未选择'

  renderSteps()
  renderOutline()
  renderPlan()
  renderChapters()
  renderLog()
}

function renderOutline() {
  const outline = state.outline
  const confirmed = state.outlineConfirmed
  if (!outline) {
    $('outline-result').hidden = true
    $('outline-confirmed-banner').hidden = true
    renderPublishGate()
    return
  }
  $('outline-result').hidden = false
  const match = $('outline-match')
  const level = outline.level || (outline.matched ? '中匹配' : '不匹配')
  match.innerHTML = ''
  const badge = document.createElement('span')
  badge.className = `badge ${outline.matched ? 'matched' : 'unmatched'}`
  badge.textContent = `${outline.matched ? '✅' : '⚠️'} 匹配等级：${level}`
  match.appendChild(badge)
  if (outline.genres?.length) match.appendChild(text(`　命中题材：${outline.genres.join('、')}`))
  if (outline.evidence) match.appendChild(md(`**匹配证据**：${outline.evidence}`))
  if (outline.gaps) match.appendChild(md(`**缺口**：${outline.gaps}`))
  if (outline.source?.date) match.appendChild(text(`　榜单数据：${new Date(outline.source.date).toLocaleString()}${outline.source.cached ? '（缓存）' : ''}`))

  const questions = $('outline-questions')
  const body = $('outline-body')
  if (outline.outline) {
    questions.hidden = true
    body.hidden = false
    body.innerHTML = ''
    body.appendChild(md(outline.outline))
  } else {
    body.hidden = true
    questions.hidden = false
    questions.innerHTML = ''
    const list = document.createElement('ul')
    for (const q of outline.questions ?? ['（无具体疑问）']) {
      const li = document.createElement('li')
      li.textContent = q
      list.appendChild(li)
    }
    questions.appendChild(list)
    if (outline.note) questions.appendChild(md(outline.note))
  }

  $('outline-confirmed').textContent = confirmed ? `（已确认于 ${new Date(state.outlineConfirmedAt ?? '').toLocaleString()}）` : ''
  $('outline-confirmed-banner').hidden = !confirmed
  const confirmBtn = $('btn-outline-confirm')
  confirmBtn.textContent = confirmed ? '✅ 已确认大纲' : '✅ 确认这份大纲'
  confirmBtn.disabled = confirmed || !outline.outline
  renderPublishGate()
}

function renderPublishGate() {
  const gate = $('publish-gate')
  if (state.plan?.active) {
    gate.className = 'banner ok'
    gate.innerHTML = ''
    gate.appendChild(text(`✅ 发布计划生效中：每天 ${state.plan.time}（${state.plan.timeZone}）发布 ${state.plan.chaptersPerDay} 章，cron job ${state.plan.cronJobId}`))
    return
  }
  const missing = []
  if (!state.outlineConfirmed) missing.push('确认大纲')
  if (!state.tomato.configured) missing.push('配置番茄鉴权')
  if (!state.selectedBook) missing.push('选择目标小说')
  if (missing.length > 0) {
    gate.className = 'banner info'
    gate.textContent = `请按顺序完成：${missing.join(' → ')}（完成后方可创建定时发布计划）`
  } else {
    gate.className = 'banner ok'
    gate.textContent = '✅ 前置条件已满足：设置每天发布时间与章数，即可创建 dsh-cron 发布计划'
  }
}

function renderPlan() {
  const plan = state.plan
  $('btn-plan-cancel').disabled = !plan?.active
  $('plan-status').hidden = !plan
  if (!plan) return
  const el = $('plan-status')
  el.innerHTML = ''
  const lines = [
    `🕐 每天 ${plan.time}（${plan.timeZone}）发布 ${plan.chaptersPerDay} 章`,
    `cron 表达式：${plan.expression}　job：${plan.cronJobId}`,
    `接下来 5 次触发：${(plan.nextFires ?? []).map(t => new Date(t).toLocaleString()).join('；')}`,
    plan.lastFireAt ? `今天已触发：${plan.lastFireAt}（${new Date(plan.lastFireAtIso ?? '').toLocaleString()}）` : '今天尚未触发',
  ]
  for (const line of lines) {
    const p = document.createElement('div')
    p.textContent = line
    el.appendChild(p)
  }
}

function renderChapters() {
  const ms = state.manuscript
  const tbody = $('chapter-tbody')
  tbody.innerHTML = ''
  const chapters = [...ms.chapters].sort((a, b) => a.no - b.no)
  $('chapter-empty').hidden = chapters.length > 0
  for (const c of chapters) {
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td>第${c.no}章</td>
      <td class="chapter-title" title="${escapeAttr(c.title)}">${escapeHtml(c.title)}</td>
      <td><span class="badge ${c.status}">${statusLabel(c.status)}</span></td>
      <td>${c.content.length} 字</td>
      <td class="actions"></td>`
    const actions = tr.querySelector('.actions')
    actions.appendChild(btn('查看', 'secondary', () => openChapter(c)))
    if (c.status === 'draft') {
      actions.appendChild(btn('确认', '', async () => {
        await post('/api/chapters/confirm', { no: c.no })
        toast(`第 ${c.no} 章已确认待发布`, 'ok')
        await refreshState({ force: true })
      }))
    }
    if (c.status !== 'published') {
      actions.appendChild(btn('重写', 'secondary', () => regenerateChapter(c.no)))
      actions.appendChild(btn('删除', 'danger', async () => {
        if (!await askConfirm(`删除第 ${c.no} 章？此操作不可撤销。`, '删除章节')) return
        await del('/api/chapters', { no: c.no })
        await refreshState({ force: true })
      }))
    }
    if (c.status === 'published' && c.publishedAt) {
      actions.appendChild(span(`发布于 ${new Date(c.publishedAt).toLocaleString()}`))
    }
    tbody.appendChild(tr)
  }
  $('btn-confirm-all').disabled = ms.draftCount === 0
}

function statusLabel(status) {
  return { draft: '待确认', confirmed: '已确认待发布', published: '已发布' }[status] ?? status
}

function renderLog() {
  const log = $('log')
  log.innerHTML = ''
  const entries = state.log ?? []
  if (entries.length === 0) {
    const div = document.createElement('div')
    div.textContent = '（暂无日志）'
    log.appendChild(div)
    return
  }
  for (const entry of entries) {
    const div = document.createElement('div')
    div.className = `log-${entry.level}`
    div.textContent = `[${new Date(entry.at).toLocaleString()}] ${entry.message}`
    log.appendChild(div)
  }
}

// ---------------------------------------------------------------- 小工具

function btn(label, cls, onClick) {
  const b = document.createElement('button')
  b.textContent = label
  if (cls) b.className = cls
  b.addEventListener('click', () => { void onClick() })
  return b
}
function span(text) {
  const s = document.createElement('span')
  s.className = 'muted small'
  s.textContent = text
  return s
}
function text(str) {
  const s = document.createElement('span')
  s.textContent = str
  return s
}
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

/** 长任务进度条：hidden 控制显隐，indeterminate 提供流动动画。 */
function busy(progressId, on) {
  const el = $(progressId)
  el.hidden = !on
  el.classList.toggle('indeterminate', on)
}

/** 轻量 Markdown 渲染（标题/表格/列表/加粗/代码/引用）。 */
function md(source) {
  const wrap = document.createElement('div')
  const lines = String(source ?? '').split(/\r?\n/)
  let html = ''
  let inCode = false
  let table = null
  let openList = null
  const closeList = () => {
    if (openList) { html += `</${openList}>`; openList = null }
  }
  const flushTable = () => {
    if (!table) return
    const rows = table.rows
    let t = '<table><thead><tr>'
    for (const cell of rows[0]) t += `<th>${inlineMd(cell)}</th>`
    t += '</tr></thead><tbody>'
    for (const row of rows.slice(1)) {
      t += '<tr>'
      for (const cell of row) t += `<td>${inlineMd(cell)}</td>`
      t += '</tr>'
    }
    t += '</tbody></table>'
    html += t
    table = null
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      if (inCode) { html += '</pre>'; inCode = false } else { closeList(); flushTable(); html += '<pre>'; inCode = true }
      continue
    }
    if (inCode) { html += `${escapeHtml(line)}\n`; continue }
    if (trimmed === '') continue
    if (trimmed.includes('|') && /^\|.*\|$/.test(trimmed)) {
      if (/^\|[\s:|-]+\|$/.test(trimmed)) continue
      closeList()
      flushTable()
      table = table || { rows: [] }
      table.rows.push(trimmed.split('|').slice(1, -1).map(c => c.trim()))
      continue
    }
    flushTable()
    const h = trimmed.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      closeList()
      const level = Math.min(h[1].length + 2, 4)
      html += `<h${level}>${inlineMd(h[2])}</h${level}>`
      continue
    }
    const li = trimmed.match(/^[-*]\s+(.*)$/)
    if (li) {
      if (openList !== 'ul') { closeList(); html += '<ul>'; openList = 'ul' }
      html += `<li>${inlineMd(li[1])}</li>`
      continue
    }
    const ol = trimmed.match(/^\d+[.)]\s+(.*)$/)
    if (ol) {
      if (openList !== 'ol') { closeList(); html += '<ol>'; openList = 'ol' }
      html += `<li>${inlineMd(ol[1])}</li>`
      continue
    }
    closeList()
    const q = trimmed.match(/^>\s?(.*)$/)
    if (q) { html += `<blockquote>${inlineMd(q[1])}</blockquote>`; continue }
    html += `<p>${inlineMd(trimmed)}</p>`
  }
  closeList()
  flushTable()
  if (inCode) html += '</pre>'
  wrap.innerHTML = html
  return wrap
}

function inlineMd(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
}

// ---------------------------------------------------------------- 任务轮询

async function pollTask(taskId, { onProgress, timeoutMs = 20 * 60 * 1000 } = {}) {
  const startedAt = Date.now()
  let misses = 0
  for (;;) {
    await sleep(2000)
    if (Date.now() - startedAt > timeoutMs) throw new Error('任务超时（超过 20 分钟未完成），可稍后重试')
    let task
    try {
      task = await api(`/api/tasks/${taskId}`)
      misses = 0
    } catch (error) {
      misses += 1
      if (misses >= 15) throw new Error(`无法获取任务状态：${error.message}`)
      continue
    }
    if (task.progress) onProgress?.(task.progress)
    if (task.status === 'done') return task.result
    if (task.status === 'failed') throw new Error(task.error || '任务失败')
  }
}

// ---------------------------------------------------------------- 推荐

$('btn-recommend').addEventListener('click', async () => {
  if (!requireAgentApi()) return
  const btnEl = $('btn-recommend')
  const status = $('recommend-status')
  btnEl.disabled = true
  busy('recommend-progress', true)
  status.textContent = '排队中…'
  try {
    const { id } = await post('/api/recommend')
    status.textContent = '抓取榜单 + 分析中（约 1-2 分钟）…'
    const result = await pollTask(id, { onProgress: (p) => { status.textContent = p } })
    renderReport(result)
    status.textContent = `完成于 ${new Date(result.generatedAt).toLocaleString()}`
    toast('推荐报告已生成，可参考下方题材分析与新书指南', 'ok')
  } catch (error) {
    status.textContent = ''
    toast(`推荐分析失败：${error.message}`, 'err', 8000)
  } finally {
    btnEl.disabled = false
    busy('recommend-progress', false)
    await refreshState({ force: true })
  }
})

function renderReport(result) {
  const box = $('recommend-report')
  box.hidden = false
  box.innerHTML = ''
  const source = result.hotList
  if (source?.source) {
    const meta = document.createElement('p')
    meta.className = 'muted small'
    meta.textContent = `数据来源：${source.source.url}（${source.source.method}，${new Date(source.date).toLocaleString()}${source.cached ? '，缓存数据' : ''}）`
    box.appendChild(meta)
  }
  box.appendChild(md(result.report))
}

async function loadLatestReport() {
  try {
    const { latest } = await api('/api/recommend/latest')
    if (latest?.report) renderReport({ report: latest.report, hotList: latest.hotList, generatedAt: latest.savedAt })
  } catch { /* 无历史报告时忽略 */ }
}

// ---------------------------------------------------------------- 生成

$('btn-outline').addEventListener('click', async () => {
  if (!requireAgentApi()) return
  const plot = $('plot-input').value.trim()
  if (plot.length < 10) {
    toast('请先输入剧情描述（至少 10 字）', 'warn')
    $('plot-input').focus()
    return
  }
  const btnEl = $('btn-outline')
  const status = $('outline-status')
  btnEl.disabled = true
  busy('outline-progress', true)
  status.textContent = '排队中…'
  try {
    const { id } = await post('/api/outline', { plot })
    status.textContent = '抓取榜单 + 匹配评估 + 大纲生成中（约 1-2 分钟）…'
    await pollTask(id, { onProgress: (p) => { status.textContent = p } })
    status.textContent = '完成'
    toast('大纲已生成，请确认后进入定时发布（第 4 步）', 'ok')
    await refreshState({ force: true })
  } catch (error) {
    status.textContent = ''
    toast(`大纲生成失败：${error.message}`, 'err', 8000)
  } finally {
    btnEl.disabled = false
    busy('outline-progress', false)
  }
})

$('btn-outline-confirm').addEventListener('click', async () => {
  try {
    await post('/api/outline/confirm')
    toast('大纲已确认 ✅ 下一步：生成章节（第 5 步），然后创建发布计划（第 6 步）', 'ok', 6000)
    focusCard('card-publish')
    await refreshState({ force: true })
  } catch (error) {
    toast(error.message, 'err')
  }
})

$('btn-outline-reset').addEventListener('click', async () => {
  if (!await askConfirm('清空大纲与全部章节手稿？已发布的章节不受影响，但本地手稿会一并清除。', '清空重来')) return
  try {
    await post('/api/outline/reset')
    $('plot-input').value = ''
    toast('已清空', 'ok')
    await refreshState({ force: true })
  } catch (error) {
    toast(error.message, 'err')
  }
})

// ---------------------------------------------------------------- 章节

$('btn-generate').addEventListener('click', async () => {
  if (!requireAgentApi()) return
  if (!state?.outlineConfirmed) {
    toast('请先在「生成」卡片确认大纲（第 4 步）', 'warn', 5000)
    focusCard('card-outline')
    return
  }
  const count = Number($('gen-count').value) || 1
  const status = $('chapter-status')
  busy('chapter-progress', true)
  $('btn-generate').disabled = true
  try {
    const { id } = await post('/api/chapters/generate', { count })
    status.textContent = 'du-nai 生成中（每章约 1-3 分钟）…'
    const result = await pollTask(id, { onProgress: (p) => { status.textContent = p } })
    status.textContent = `已生成 ${result.generated.length} 章，请点「查看」确认`
    toast(`已生成 ${result.generated.length} 章，确认后即可安排发布`, 'ok', 6000)
  } catch (error) {
    status.textContent = ''
    toast(`章节生成失败：${error.message}`, 'err', 8000)
  } finally {
    busy('chapter-progress', false)
    $('btn-generate').disabled = false
    await refreshState({ force: true })
  }
})

$('btn-confirm-all').addEventListener('click', async () => {
  try {
    await post('/api/chapters/confirm', {})
    toast('已把全部待确认章节标记为「已确认待发布」', 'ok')
    await refreshState({ force: true })
  } catch (error) {
    toast(error.message, 'err')
  }
})

async function regenerateChapter(no) {
  if (!requireAgentApi()) return
  if (!await askConfirm(`用 du-nai 重写第 ${no} 章？原内容将被替换，且需要重新确认。`, '重写章节')) return
  const status = $('chapter-status')
  busy('chapter-progress', true)
  try {
    const { id } = await post('/api/chapters/regenerate', { no })
    status.textContent = `重写第 ${no} 章中…`
    await pollTask(id, { onProgress: (p) => { status.textContent = p } })
    status.textContent = `第 ${no} 章已重写（待确认）`
    toast(`第 ${no} 章已重写`, 'ok')
  } catch (error) {
    status.textContent = ''
    toast(error.message, 'err', 8000)
  } finally {
    busy('chapter-progress', false)
    await refreshState({ force: true })
  }
}

let viewingChapter = null
function openChapter(chapter) {
  viewingChapter = chapter.no
  const editable = chapter.status !== 'published'
  $('chapter-modal-title').textContent = `第 ${chapter.no} 章 · ${statusLabel(chapter.status)}`
  $('chapter-edit-title').value = chapter.title
  $('chapter-edit-content').value = chapter.content
  $('chapter-edit-title').disabled = !editable
  $('chapter-edit-content').disabled = !editable
  $('btn-chapter-save').disabled = !editable
  $('btn-chapter-confirm-one').disabled = chapter.status === 'published'
  openModal('modal-chapter', { focus: editable ? 'chapter-edit-content' : 'btn-chapter-save' })
}

$('btn-chapter-save').addEventListener('click', async () => {
  if (!viewingChapter) return
  try {
    await post('/api/chapters/edit', {
      no: viewingChapter,
      title: $('chapter-edit-title').value.trim(),
      content: $('chapter-edit-content').value,
    })
    closeModal('modal-chapter')
    toast('已保存（状态回到待确认，请重新确认）', 'ok')
    await refreshState({ force: true })
  } catch (error) {
    toast(error.message, 'err')
  }
})

$('btn-chapter-confirm-one').addEventListener('click', async () => {
  if (!viewingChapter) return
  try {
    await post('/api/chapters/confirm', { no: viewingChapter })
    closeModal('modal-chapter')
    toast(`第 ${viewingChapter} 章已确认待发布`, 'ok')
    await refreshState({ force: true })
  } catch (error) {
    toast(error.message, 'err')
  }
})

// ---------------------------------------------------------------- 计划

$('btn-plan-create').addEventListener('click', async () => {
  if (!requirePublishReady()) return
  const btn = $('btn-plan-create')
  btn.disabled = true
  try {
    const result = await post('/api/schedule', {
      time: $('plan-time').value || '18:00',
      chaptersPerDay: Number($('plan-count').value) || 1,
      timeZone: $('plan-tz').value.trim() || undefined,
    })
    if (result.ok) {
      toast(`发布计划已创建：每天 ${result.plan.time}（${result.plan.timeZone}）发布 ${result.plan.chaptersPerDay} 章`, 'ok', 7000)
    }
    await refreshState({ force: true })
  } catch (error) {
    toast(error.message, 'err', 8000)
  } finally {
    btn.disabled = false
  }
})

$('btn-plan-cancel').addEventListener('click', async () => {
  if (!await askConfirm('取消发布计划，并从 dsh-cron 中移除该定时任务？', '取消计划')) return
  try {
    await post('/api/schedule/cancel')
    toast('发布计划已取消', 'ok')
    await refreshState({ force: true })
  } catch (error) {
    toast(error.message, 'err')
  }
})

$('btn-publish-now').addEventListener('click', async () => {
  if (!state?.tomato?.configured || !state?.selectedBook) {
    toast('请先完成「番茄鉴权」并选择目标小说（第 2 步）', 'warn', 5000)
    openModal('modal-tomato')
    return
  }
  const ms = state.manuscript
  if ((ms?.confirmedCount ?? 0) === 0) {
    toast('没有「已确认待发布」的章节，先生成并确认章节（第 5 步）', 'warn', 5000)
    focusCard('card-publish')
    return
  }
  if (!await askConfirm(`立即把 ${ms.confirmedCount} 章「已确认待发布」的章节发布到《${state.selectedBook.book_name}》？`, '立即发布')) return
  const status = $('chapter-status')
  status.textContent = '发布中…'
  try {
    const result = await post('/api/publish/now')
    status.textContent = result.message
    toast(result.message, result.published > 0 ? 'ok' : 'warn', 7000)
    await refreshState({ force: true })
  } catch (error) {
    status.textContent = ''
    toast(`发布失败：${error.message}`, 'err', 8000)
  }
})

// ---------------------------------------------------------------- Agent API 弹窗

function fillAgentModal() {
  const cfg = state?.agentApi
  $('agent-base').value = cfg?.baseUrl ?? $('agent-base').value ?? ''
  $('agent-key').value = ''
  $('agent-model').value = cfg?.model ?? ($('agent-model').value || 'deepseek-chat')
  $('agent-key').placeholder = cfg ? `已保存（${cfg.apiKeyMasked}），留空表示不修改` : 'sk-...'
  $('agent-feedback').hidden = true
}
modalHooks['modal-agent'] = {
  onOpen: () => { fillAgentModal(); sessionStorage.setItem('guide-shown', '1') },
}

$('btn-agent-save').addEventListener('click', async () => {
  const body = {
    baseUrl: $('agent-base').value.trim(),
    apiKey: $('agent-key').value.trim(),
    model: $('agent-model').value.trim(),
  }
  const fb = $('agent-feedback')
  const btnEl = $('btn-agent-save')
  fb.hidden = false
  fb.className = 'banner info'
  fb.textContent = '验证中…'
  btnEl.disabled = true
  try {
    const result = await post('/api/agent-api', body)
    fb.className = 'banner ok'
    fb.textContent = `✅ 验证通过（${result.test.tookMs}ms）：${result.test.reply}`
    toast('第 1 步完成 ✅', 'ok')
    await refreshState({ force: true })
    // 按顺序推进到第 2 步，不叠加弹窗
    if (!state.tomato?.configured) {
      closeModal('modal-agent')
      toast('继续第 2 步：配置番茄作家后台鉴权', 'info', 6000)
      openModal('modal-tomato', { focus: 'tomato-cookie' })
    }
  } catch (error) {
    fb.className = 'banner err'
    fb.textContent = error.message
  } finally {
    btnEl.disabled = false
  }
})

$('btn-agent-clear').addEventListener('click', async () => {
  if (!await askConfirm('清除 Agent API 配置？清除后推荐 / 大纲 / 章节生成将不可用。', '清除配置')) return
  await del('/api/agent-api')
  closeModal('modal-agent')
  toast('Agent API 配置已清除', 'ok')
  await refreshState({ force: true })
})

// ---------------------------------------------------------------- 番茄鉴权弹窗

function fillTomatoModal() {
  $('tomato-cookie').value = ''
  $('tomato-csrf').value = ''
  $('tomato-cookie').placeholder = state?.tomato.configured ? '已保存，留空=不修改；要更新请粘贴新的完整 Cookie' : 'sessionid=...; passport_csrf_token=...; ...'
  $('tomato-feedback').hidden = true
  $('book-select').innerHTML = state?.tomato.configured
    ? '<option value="">加载中…</option>'
    : '<option value="">（保存鉴权后自动加载书单）</option>'
  if (state?.tomato.configured) void loadBooks()
}
modalHooks['modal-tomato'] = {
  onOpen: () => { fillTomatoModal(); sessionStorage.setItem('guide-shown', '1') },
}

async function loadBooks() {
  try {
    const { novels } = await api('/api/novels')
    const select = $('book-select')
    select.innerHTML = '<option value="">请选择</option>'
    for (const b of novels) {
      const opt = document.createElement('option')
      opt.value = b.book_id
      opt.textContent = `${b.book_name}（${b.word_count ?? 0} 字 / 阅读 ${b.read_count ?? '-'}）`
      if (state?.selectedBook && String(state.selectedBook.book_id) === b.book_id) opt.selected = true
      select.appendChild(opt)
    }
    return novels
  } catch (error) {
    const fb = $('tomato-feedback')
    fb.hidden = false
    fb.className = 'banner err'
    fb.textContent = `书单加载失败：${error.message}`
    return []
  }
}

$('btn-tomato-save').addEventListener('click', async () => {
  const fb = $('tomato-feedback')
  const btnEl = $('btn-tomato-save')
  const body = {
    cookie: $('tomato-cookie').value.trim(),
    csrfToken: $('tomato-csrf').value.trim(),
  }
  // 已配置且留空：视为「不修改」，只刷新书单
  if (!body.cookie && !body.csrfToken && state?.tomato.configured) {
    fb.hidden = false
    fb.className = 'banner info'
    fb.textContent = '已保存的鉴权保持不变，正在刷新书单…'
    await loadBooks()
    return
  }
  if (!body.cookie || !body.csrfToken) {
    fb.hidden = false
    fb.className = 'banner err'
    fb.textContent = 'Cookie 与 X-Secsdk-Csrf-Token 需要同时填写'
    return
  }
  fb.hidden = false
  fb.className = 'banner info'
  fb.textContent = '验证中…'
  btnEl.disabled = true
  try {
    const result = await post('/api/tomato-auth', body)
    fb.className = 'banner ok'
    fb.textContent = `✅ 验证通过：账号下共 ${result.novels.length} 本书`
    toast('第 2 步鉴权已保存 ✅', 'ok')
    await refreshState({ force: true })
    renderBookOptions(result.novels)
    // 只有一本书时自动选中，少一步点击
    if (result.novels.length === 1) {
      await selectBook(result.novels[0].book_id, { silent: true })
      toast(`已自动选择唯一的小说《${result.novels[0].book_name}》`, 'ok', 6000)
    } else {
      toast('请在下方选择要发布的目标小说', 'info', 6000)
    }
  } catch (error) {
    fb.className = 'banner err'
    fb.textContent = error.message
  } finally {
    btnEl.disabled = false
  }
})

function renderBookOptions(novels) {
  const select = $('book-select')
  select.innerHTML = '<option value="">请选择</option>'
  for (const b of novels) {
    const opt = document.createElement('option')
    opt.value = b.book_id
    opt.textContent = `${b.book_name}（${b.word_count ?? 0} 字 / 阅读 ${b.read_count ?? '-'}）`
    select.appendChild(opt)
  }
}

async function selectBook(bookId, opts = {}) {
  await post('/api/novels/select', { bookId })
  closeModal('modal-tomato')
  if (!opts.silent) toast('目标小说已选定 ✅ 前置配置完成，开始创作吧', 'ok', 6000)
  await refreshState({ force: true })
}

$('btn-book-select').addEventListener('click', async () => {
  const bookId = $('book-select').value
  if (!bookId) {
    toast('请先在下拉框选择一本书', 'warn')
    return
  }
  try {
    await selectBook(bookId)
  } catch (error) {
    toast(error.message, 'err')
  }
})

// ---------------------------------------------------------------- 启动

$('plan-tz').value = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Asia/Shanghai'
$('chip-agent').addEventListener('click', () => openModal('modal-agent', { focus: 'agent-base' }))
$('chip-tomato').addEventListener('click', () => openModal('modal-tomato', { focus: 'tomato-cookie' }))

async function boot() {
  const banner = $('conn-banner')
  banner.hidden = false
  banner.className = 'banner info'
  banner.textContent = '正在连接控制台后端服务…'
  await refreshState({ force: true })
  if (state) {
    firstLoadDone = true
    firstRunGuide()
  } else {
    banner.className = 'banner err'
    banner.textContent = '无法连接控制台后端服务。请确认启动窗口仍在运行；若已关闭，双击 启动控制台.bat 重新启动。'
  }
  void loadLatestReport()
}

void boot()
setInterval(() => { void refreshState() }, 5000)

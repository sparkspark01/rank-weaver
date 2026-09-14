/**
 * 冒烟测试：不依赖真实 LLM/番茄鉴权，验证状态与调度链路。
 * 前置：server.mjs 已启动；本脚本结束后清理测试状态。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3210'
const STATE_DIR = join(process.cwd(), 'state')

const api = async (path, options = {}) => {
  const res = await fetch(BASE + path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  console.log(`  ${options.method ?? 'GET'} ${path} → ${res.status}`)
  return { status: res.status, data }
}

const readApp = () => {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, 'app.json'), 'utf8'))
  } catch {
    return {}
  }
}

const app = readApp()

// 模拟前置条件
app.outlineConfirmedAt = new Date().toISOString()
app.outline = app.outline ?? { matched: true, level: '中匹配', outline: '## 测试大纲\n一句话卖点：测试。' }
app.selectedBook = { book_id: '999999', book_name: '冒烟测试书' }
writeFileSync(join(STATE_DIR, 'app.json'), JSON.stringify(app, null, 2))

console.log('1) 创建发布计划')
const created = await api('/api/schedule', { method: 'POST', body: JSON.stringify({ time: '18:00', chaptersPerDay: 1, timeZone: 'Asia/Shanghai' }) })
console.log('   →', JSON.stringify(created.data))

console.log('2) 查看计划与 store')
const plan = await api('/api/schedule')
console.log('   →', JSON.stringify(plan.data).slice(0, 600))

console.log('3) 手动触发发布（番茄鉴权为假，应报番茄侧错误）')
const fired = await api('/api/publish/fire', { method: 'POST', body: JSON.stringify({ trigger: 'cron' }) })
console.log('   →', JSON.stringify(fired.data).slice(0, 400))

console.log('4) 取消计划')
const cancelled = await api('/api/schedule/cancel', { method: 'POST', body: '{}' })
console.log('   →', JSON.stringify(cancelled.data))

console.log('5) 清理测试状态')
app.outlineConfirmedAt = null
app.outline = null
app.selectedBook = null
writeFileSync(join(STATE_DIR, 'app.json'), JSON.stringify(app, null, 2))
console.log('   done')

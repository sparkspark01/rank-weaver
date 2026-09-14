/**
 * 渲染后 DOM 验收：分析无头浏览器 dump 出来的真实 DOM。
 * 验证点（针对本次修复）：
 * 1. 首屏是否有弹窗遮罩处于打开状态（只允许"新手引导"那一个）
 * 2. 引导顺序是否符合 1 → 2（未配置 Agent API 时只开 Agent 弹窗）
 * 3. 页面是否真正渲染完成（连接提示消失、步骤条就位、卡片存在）
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const html = readFileSync(file, 'utf8')
let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => { failures += 1; console.log(`  ✗ ${m}`) }

// 弹窗容器及其 class
const masks = [...html.matchAll(/<div class="([^"]*modal-mask[^"]*)"([^>]*)>/g)].map(m => ({
  cls: m[1],
  attrs: m[2],
}))
console.log(`1) 弹窗渲染状态（共 ${masks.length} 个）`)
const opened = []
for (const m of masks) {
  const idm = m.attrs.match(/id="([^"]+)"/)
  const id = idm ? idm[1] : '?'
  const isOpen = /\bopen\b/.test(m.cls)
  const hasHidden = /\bhidden\b/.test(m.attrs)
  console.log(`     ${id.padEnd(16)} open=${isOpen ? '是' : '否'}  hidden属性=${hasHidden ? '有' : '无'}`)
  if (isOpen) opened.push(id)
}
if (masks.length === 4) ok('四个弹窗容器都在（agent / tomato / chapter / confirm）')
else bad(`弹窗容器数量异常：${masks.length}`)
// 依据渲染出来的芯片文案推断"当前应该处在第几步"，再核对弹窗与步骤条是否一致
const chipMatch = html.match(/<button class="chip[^"]*" id="chip-agent"[^>]*>([^<]*)</)
const agentChipText = chipMatch ? chipMatch[1].trim() : ''
const agentConfigured = /Agent API：(?!未配置)/.test(agentChipText)
const expectModal = agentConfigured ? 'modal-tomato' : 'modal-agent'
const expectStep = agentConfigured ? 'step-2' : 'step-1'

if (opened.length <= 1) ok(`首屏最多一个弹窗打开（实际：${opened.length === 0 ? '无' : opened.join(', ')}）`)
else bad(`首屏同时打开了多个弹窗：${opened.join(', ')}`)
if (opened.length === 0 || opened[0] === expectModal) {
  ok(`引导顺序正确：${agentConfigured ? '已配置 Agent API，先弹番茄鉴权（第 2 步）' : '未配置 Agent API，先弹 Agent API（第 1 步）'}`)
} else {
  bad(`引导顺序不对：期望 ${expectModal}，实际先弹 ${opened[0]}`)
}

// 页面是否渲染完成
console.log('2) 渲染完成度')
const connHidden = /<div id="conn-banner"[^>]*hidden/.test(html)
if (connHidden) ok('连接提示已收起（说明 /api/state 请求成功、JS 跑通）')
else bad('连接提示仍未收起：可能后端未连接或 JS 报错')

const steps = [...html.matchAll(/<span class="(step[^"]*)" id="(step-\d)">/g)].map(m => ({ cls: m[1], id: m[2] }))
if (steps.length === 6) ok('步骤条渲染 6 步')
else bad(`步骤条异常：找到 ${steps.length} 步`)
const current = steps.filter(s => /current/.test(s.cls)).map(s => s.id)
if (current.length === 1 && current[0] === expectStep) ok(`当前步骤高亮正确：${expectStep}`)
else bad(`当前步骤高亮异常：${current.join(', ') || '无'}（期望 ${expectStep}）`)

const cards = [...html.matchAll(/<section class="card[^"]*"([^>]*)>/g)].map(m => {
  const idm = m[1].match(/id="([^"]+)"/)
  return idm ? idm[1] : '(无 id)'
})
if (cards.length >= 4) ok(`三张功能卡 + 日志卡都在（${cards.join(', ')}）`)
else bad(`功能卡缺失：${cards.join(', ') || '无'}`)

if (/番茄自动化控制台/.test(html)) ok('页面标题正常')
else bad('页面标题缺失')

// 芯片文案（代理/番茄状态渲染）
const chip = html.match(/<button class="chip[^"]*" id="chip-agent"[^>]*>([^<]*)</)
console.log(`3) 状态芯片：${chip ? chip[1].trim() : '（未找到）'}`)

console.log(failures === 0 ? '\n首屏验收通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)

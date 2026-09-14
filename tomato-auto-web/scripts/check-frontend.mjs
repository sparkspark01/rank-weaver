/**
 * 前端静态校验（无浏览器环境下的替代验收）：
 * 1. app.js 引用的 DOM id 是否都存在于 index.html
 * 2. 是否残留阻塞式 alert()/confirm()
 * 3. 弹窗 CSS 机制是否正确（默认 display:none，仅 .open 显示）
 * 4. 弹窗元素是否误带 hidden 属性
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8')
const js = readFileSync(join(root, 'public', 'app.js'), 'utf8')
const css = readFileSync(join(root, 'public', 'style.css'), 'utf8')

let failures = 0
const ok = (label) => console.log(`  ✓ ${label}`)
const fail = (label, detail) => { failures += 1; console.log(`  ✗ ${label}\n      ${detail}`) }

// 1) id 交叉核对
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]))
const jsIds = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))
const dynamicIds = new Set([...js.matchAll(/\$\(`(step-\$\{i\}|[^`]*\$\{[^`]*)`\)/g)].map(m => m[1]))
const missing = [...jsIds].filter(id => !htmlIds.has(id))
console.log(`1) DOM id 核对：HTML ${htmlIds.size} 个，JS 引用 ${jsIds.size} 个`)
if (missing.length === 0) ok('app.js 引用的 id 全部存在于 index.html')
else fail('存在 JS 引用但 HTML 缺失的 id', missing.join(', '))
// step-1..6 由模板字符串拼接，单独核对
const stepMissing = [1, 2, 3, 4, 5, 6].filter(i => !htmlIds.has(`step-${i}`))
if (stepMissing.length === 0) ok('引导步骤条 step-1..6 齐全')
else fail('引导步骤条缺失', stepMissing.join(', '))
if (dynamicIds.size > 0) ok(`模板 id 引用：${[...dynamicIds].join(', ')}`)

// 2) 阻塞式 API 残留
console.log('2) 阻塞式 API 残留检查')
const alertCalls = [...js.matchAll(/(?<![\w.])alert\(/g)].length
const confirmCalls = [...js.matchAll(/(?<![\w.])confirm\(/g)].length
if (alertCalls === 0 && confirmCalls === 0) ok('未残留 alert() / confirm()（已换成 toast / 页内确认框）')
else fail('仍存在阻塞式调用', `alert=${alertCalls}, confirm=${confirmCalls}`)

// 3) 弹窗 CSS 机制
console.log('3) 弹窗显示机制')
const maskRule = css.match(/\.modal-mask\s*\{[^}]*\}/)
if (maskRule && /display:\s*none/.test(maskRule[0])) ok('.modal-mask 默认 display:none')
else fail('.modal-mask 默认不是 display:none', maskRule ? maskRule[0].replace(/\s+/g, ' ') : '未找到规则')
if (/\.modal-mask\.open\s*\{[^}]*display:\s*flex/.test(css)) ok('.modal-mask.open 才 display:flex')
else fail('缺少 .modal-mask.open { display:flex }', '弹窗无法打开')
if (/\.modal-mask\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css)) ok('保留 [hidden] 兜底规则')
else fail('缺少 [hidden] 兜底规则', '')

// 4) 弹窗元素不应带 hidden 属性（改由 class 控制）
console.log('4) 弹窗元素属性')
const modalTags = [...html.matchAll(/<div class="modal-mask"[^>]*>/g)].map(m => m[0])
const withHidden = modalTags.filter(t => /\bhidden\b/.test(t))
if (modalTags.length === 0) fail('未找到弹窗容器', '')
else if (withHidden.length === 0) ok(`${modalTags.length} 个弹窗容器均不带 hidden 属性`)
else fail('弹窗容器仍带 hidden（会与 class 控制冲突）', withHidden.join(' | '))

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)

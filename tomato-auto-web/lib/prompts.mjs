/**
 * 把随应用分发的 fenxi / du-nai skill 指令组装成 Agent API 请求。
 * skills/fenxi.md、skills/du-nai.md、skills/du-nai-style-profile.md
 * 复制自用户 skill 目录（C:\Users\10545\.agents\skills\...），内容与 skill 一致。
 * @module lib/prompts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILLS_DIR = join(fileURLToPath(new URL('../skills/', import.meta.url)))

const cache = new Map()
function skillFile(name) {
  if (!cache.has(name)) cache.set(name, readFileSync(join(SKILLS_DIR, name), 'utf8'))
  return cache.get(name)
}

export function fenxiSkillText() {
  return skillFile('fenxi.md')
}

export function duNaiSkillText() {
  return skillFile('du-nai.md')
}

export function duNaiStyleProfile() {
  return skillFile('du-nai-style-profile.md')
}

/** 推荐功能：番茄热门题材分析 + 新书指南。 */
export function buildRecommendMessages(hotList) {
  const system = [
    '你是一名资深网文题材分析师，正在执行「fenxi」技能（番茄榜单分析）。以下是该技能的完整工作指令：',
    '',
    fenxiSkillText(),
    '',
    '【执行边界】上面的工作指令中提到的 web_search / pwsh / browser-cdp 工具不可用；',
    '所需榜单数据已经由调用方抓取好并在用户消息中提供，你直接基于它完成分析，',
    '不要声称自己无法联网。数据缺口必须如实写入报告。',
  ].join('\n')
  const user = [
    `请对下面这份「番茄小说连载中热门榜」数据执行 fenxi 技能的分析流程，`,
    `输出两大块内容：`,
    ``,
    `## 一、番茄热门题材分析`,
    `严格按技能要求的输出格式：`,
    `1. 数据来源与时间；`,
    `2. 连载中前二十榜单概览（表格：排名/书名/作者/简介要点/标签题材/可见热度指标）；`,
    `3. 热门题材排名（按综合热度从高到低：题材、代表作品、样本数量、排名依据）；`,
    `4. 剧情主线与爽点（每个热门题材：主要剧情主线、开局钩子、升级/变强路径、关系线、反派或压力源、爽点机制、读者期待）；`,
    `5. 综合结论（当前连载榜的叙事趋势，区分「榜单显示」与「推断」）。`,
    ``,
    `## 二、新书指南`,
    `基于上面的题材排名，给出可直接用于开新书的创作指南：`,
    `1. 推荐选题方向（3-5 个，每个说明题材定位、目标读者、核心卖点）；`,
    `2. 每个方向的一句话说卖点 + 前三章开局设计建议；`,
    `3. 避坑提示（与热门题材机制冲突的常见写法）。`,
    ``,
    `用 Markdown 输出，数据只来自下面提供的榜单，不要凭记忆补榜单数据。`,
    ``,
    `【榜单数据（JSON）】`,
    '```json',
    JSON.stringify(hotList, null, 2),
    '```',
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** 生成功能：剧情 → 匹配评估 → 大纲（或疑问清单）。 */
export function buildOutlineMessages(plot, hotList) {
  const system = [
    '你是一名资深网文题材分析师，正在执行「fenxi」技能的「剧情匹配评估」与「参考榜单生成大纲」流程。以下是该技能的完整工作指令：',
    '',
    fenxiSkillText(),
    '',
    '【执行边界】工作指令中提到的联网工具不可用；最新连载榜数据已由调用方抓取好并在用户消息中提供。',
    '必须先用 JSON 输出，便于程序解析。',
  ].join('\n')
  const user = [
    `用户提供的小说剧情如下（用户消息中的剧情）：`,
    `<剧情>`,
    plot,
    `</剧情>`,
    ``,
    `请按 fenxi 技能执行：`,
    `1. 剧情匹配评估：从剧情中提取主题材、副元素、主角初始困境、核心金手指、长期目标、主要矛盾、关系线、预期爽点；`,
    `   对照榜单题材排名判断落在哪些热门题材上，给出匹配等级（高匹配/中匹配/弱匹配/不匹配）与理由、缺口。`,
    `2. 大纲生成：仅当匹配等级为「高匹配」或「中匹配」时，选择题材排名中最接近的 1-3 个代表作品作为结构参照`,
    `   （只借鉴题材机制、主线节奏、爽点分布与读者期待，不复刻书名、角色名、设定、桥段、台词或专有名词），`,
    `   生成原创大纲，至少包含：一句话卖点、题材定位、主角设定、核心矛盾、金手指或推进机制、前三章开局、`,
    `   阶段主线（按 开篇10章 → 第一卷 → 中期升级/扩张 → 后期大冲突 的层级）、主要反派/压力源、爽点安排、阶段性钩子。`,
    `   若为「弱匹配」或「不匹配」，不要强行套榜单生成大纲，而是输出 2-4 个关键疑问清单`,
    `   （是否保留原主题、向哪个热门题材靠拢、主角推进机制、爽点落点）。`,
    ``,
    `输出严格 JSON：`,
    `{"matched": true/false, "level": "高匹配|中匹配|弱匹配|不匹配", "genres": ["命中的题材"], "evidence": "匹配证据", "gaps": "缺口", "outline": "完整大纲(仅匹配时, Markdown)"|null, "questions": ["疑问"]|null, "note": "补充说明"}`,
    ``,
    `【榜单数据（JSON）】`,
    '```json',
    JSON.stringify(hotList, null, 2),
    '```',
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/**
 * du-nai 章节生成（一次一章，保证连续性与质量）。
 * @param {object} ctx { outline, nextNo, previousChapter?, publishedSummary, plan }
 */
export function buildChapterMessages(ctx) {
  const { outline, nextNo, previousChapter, publishedSummary } = ctx
  const system = [
    '你是一名网文写手，正在执行「du-nai」（毒奶）技能：轻松吐槽向都市异能/玄幻升级流网络小说创作。',
    '以下是该技能的完整工作指令，必须遵守：',
    '',
    duNaiSkillText(),
    '',
    '【文风参考】以下是最新的文风画像，按章型取用（本章属于：日常/训练/战斗/过渡由你按剧情判断）：',
    '',
    duNaiStyleProfile(),
    '',
    '【输出铁律】',
    '- 只输出本章正文，不要任何创作说明、不要大纲复述、不要“以下是第X章”这类前缀。',
    `- 第一行必须是章节标题行：## 第${nextNo}章 标题（标题要有网文卖点感，参照文风画像里的命名习惯）。`,
    '- 正文约 1800-2500 字，空行分段，纯文本（不要 Markdown 加粗/列表，不要 <p> 标签）。',
    '- 严格遵守文风画像：贴近主角的弹性有限视角、叙述和心理活动主导、问句式认知推进、能力与资源账本、辅助技能反常运用、轻松日常和危险实战交替、克制温情、低 AI 味。',
    '- 交稿前执行文风画像与技能指令中的复核清单（连续性、因果、并段、对白口气、爽点落点）。',
  ].join('\n')

  const userParts = [
    `【本书大纲】`,
    outline,
  ]
  if (publishedSummary) {
    userParts.push(``, `【已发布进度】`, publishedSummary)
  }
  if (previousChapter) {
    userParts.push(
      ``,
      `【上一章正文（第 ${previousChapter.no} 章，用于保证连续性，不要复述其内容）】`,
      `<上一章>`,
      previousChapter.content.slice(-2400),
      `</上一章>`,
    )
  }
  userParts.push(
    ``,
    `【本次任务】`,
    `写第 ${nextNo} 章。先建立内部状态账本（时间地点、在场人物、当前目标、未解冲突、关系温度、伤势体力、能力等级、资源数量、秘密承诺、上一章钩子），`,
    `再确定本章章核（谁想完成什么、什么压力阻止、主角怎么处理、章末产生什么可见变化），然后直接进入场景写作。`,
    `章末要留下承接下一章的钩子。`,
  )
  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n') },
  ]
}

/** 解析大纲任务返回的 JSON（对模型的小幅偏离做容错）。 */
export function parseOutlineJson(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('大纲任务返回的不是 JSON，请重试')
    parsed = JSON.parse(match[0])
  }
  const level = String(parsed?.level ?? '')
  const matched = parsed?.matched === true || level === '高匹配' || level === '中匹配'
  return {
    matched,
    level: level || (parsed?.outline ? '中匹配' : '不匹配'),
    genres: Array.isArray(parsed?.genres) ? parsed.genres : [],
    evidence: parsed?.evidence ?? '',
    gaps: parsed?.gaps ?? '',
    outline: typeof parsed?.outline === 'string' ? parsed.outline : null,
    questions: Array.isArray(parsed?.questions) ? parsed.questions : null,
    note: parsed?.note ?? '',
  }
}

/** 解析 LLM 输出 → 章节对象；找不到标题行则失败。 */
export function parseChapter(text, fallbackNo) {
  const t = String(text).trim()
  const m = t.match(/^##\s*(第\d+章)\s*(.*)$/m)
  if (!m) throw new Error('生成结果中没有找到「## 第N章 标题」，无法解析章节')
  const no = Number(m[1].replace(/[^0-9]/g, '')) || fallbackNo
  const title = m[2].trim() ? `第${no}章 ${m[2].trim()}` : m[1]
  const body = t.replace(/^##\s*第\d+章.*$/m, '').trim()
  if (body.length < 300) throw new Error('生成章节过短（不足 300 字），请重新生成')
  return { no, title, content: body }
}

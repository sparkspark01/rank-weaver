import { buildChapterMessages, parseChapter, parseOutlineJson, buildRecommendMessages, buildOutlineMessages } from '../lib/prompts.mjs'

const msgs = buildChapterMessages({ outline: '测试大纲', nextNo: 1, previousChapter: null, publishedSummary: null })
console.log('chapter prompts: sys', msgs[0].content.length, 'chars / user', msgs[1].content.length, 'chars')

const body = '正文第一段。\n\n正文第二段，很长。' + '字'.repeat(400)
const c = parseChapter(`## 第5章 一炉好丹\n\n${body}`, 5)
console.log('parseChapter: no=', c.no, 'title=', c.title, 'len=', c.content.length)

const ok = parseOutlineJson('{"matched":true,"level":"高匹配","genres":["都市异能"],"evidence":"e","outline":"## 大纲正文"}')
console.log('parseOutlineJson ok:', ok.matched, ok.level, ok.genres.join('/'), ok.outline)

const qs = parseOutlineJson('{"matched":false,"level":"弱匹配","questions":["是否保留原主题？","向哪个题材靠拢？"]}')
console.log('parseOutlineJson qs:', qs.matched, qs.questions.length)

const hotList = { date: new Date().toISOString(), source: { url: 'x', method: 'api' }, books: [{ rank: 1, book_id: '1', book_name: '测试书', author: '作者', abstract: '简介', tags: [], hot: 1 }], gaps: [] }
const r = buildRecommendMessages(hotList)
const o = buildOutlineMessages('都市异能主角觉醒辅助能力', hotList)
console.log('recommend prompts:', r[0].content.length, r[1].content.length, 'chars')
console.log('outline prompts:', o[0].content.length, o[1].content.length, 'chars')
console.log('ALL OK')

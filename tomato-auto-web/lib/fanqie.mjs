/**
 * 番茄热门榜取数（fenxi skill 工作流的第 1-6 步）：
 * 1. 优先请求公开 book_list 接口（对应 sort=hottes / 连载中）
 * 2. 失败则抓榜单 HTML 页尝试提取内嵌 JSON
 * 3. 书名出现字体混淆（私有区字符）时逐本打开 /page/{book_id} 还原
 * @module lib/fanqie
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

const API_URL =
  'https://fanqienovel.com/api/author/library/book_list/v0/?page_count=20&page_index=0&gender=-1&category_id=-1&creation_status=1&word_count=-1&book_type=-1&sort=0'

const HTML_URL = 'https://fanqienovel.com/library/stat1/page_1?sort=hottes'

/** 私有使用区（字体混淆后的字形映射区）。 */
const PUA_RE = /[\uE000-\uF8FF]/

export async function fetchHotList() {
  const gaps = []
  const source = { url: API_URL, method: 'api', date: new Date().toISOString() }

  let books = []
  try {
    books = await fetchViaApi()
  } catch (apiError) {
    gaps.push(`接口读取失败（${apiError?.message ?? apiError}），降级抓取榜单 HTML`)
    source.url = HTML_URL
    source.method = 'html'
    try {
      books = await fetchViaHtml()
    } catch (htmlError) {
      throw new Error(`番茄热门榜不可读：接口与页面均失败。${gaps.join('；')}`)
    }
  }

  books = books.filter(Boolean).slice(0, 20)
  if (books.length === 0) throw new Error('榜单解析结果为空，可能被反爬拦截')
  source.count = books.length

  // 字体混淆还原：串行、只在必要时访问书籍页
  let recovered = 0
  for (const book of books) {
    const garbled = [book.book_name, book.author, book.abstract].filter(v => typeof v === 'string' && PUA_RE.test(v))
    if (garbled.length === 0) continue
    try {
      const fixed = await fetchBookPage(book.book_id)
      if (fixed.title) book.book_name = fixed.title
      if (fixed.author) book.author = fixed.author
      if (fixed.abstract) book.abstract = fixed.abstract
      recovered += 1
    } catch { /* 保留混淆值，报告中注明缺口 */ }
  }
  if (recovered > 0) source.recovered = recovered

  return { date: source.date, source, books, gaps }
}

async function fetchViaApi() {
  const res = await fetch(API_URL, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://fanqienovel.com/library/',
    },
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`接口返回非 JSON（HTTP ${res.status}）`)
  }
  if (json?.code !== 0) throw new Error(`接口 code=${json?.code} ${json?.message ?? ''}`)
  const list = Array.isArray(json?.data) ? json.data : (json?.data?.book_list ?? json?.data?.list ?? [])
  return normalize(list)
}

async function fetchViaHtml() {
  const res = await fetch(HTML_URL, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', Referer: 'https://fanqienovel.com/' },
    signal: AbortSignal.timeout(20_000),
  })
  const html = await res.text()
  if (html.length < 2000) throw new Error(`页面过短（${html.length} 字节），疑似反爬壳`)
  // 常见形态：window.__INITIAL_STATE__ / window.__NUXT__ / 内嵌 <script> JSON
  let json = extractJson(html, /(?:__INITIAL_STATE__|__NUXT__|window\.__BOOKS__)\s*=\s*(\{[\s\S]*?\})\s*(?:;|<\/script>)/)
  if (json === null) json = extractJson(html, /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/)
  if (json === null) throw new Error('HTML 中未找到内嵌榜单数据')
  const list = pickBookList(json) ?? []
  return normalize(list)
}

function extractJson(html, re) {
  const m = html.match(re)
  if (!m) return null
  try { return JSON.parse(m[1]) } catch { return null }
}

/** 在任意内嵌 JSON 里递归找一个元素含 book_id/book_name 的数组。 */
function pickBookList(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 6) return null
  if (Array.isArray(node) && node.length > 0 && node.some(it => it && typeof it === 'object' && 'book_id' in it)) {
    return node
  }
  for (const key of Object.keys(node)) {
    const found = pickBookList(node[key], depth + 1)
    if (found) return found
  }
  return null
}

/** 把任意条目形状压成统一字段。 */
function normalize(list) {
  return (Array.isArray(list) ? list : []).map((item, index) => {
    const info = item?.book_info ?? item?.bookInfo ?? item ?? {}
    return {
      rank: index + 1,
      book_id: String(info.book_id ?? item?.book_id ?? ''),
      book_name: String(info.book_name ?? info.bookName ?? item?.book_name ?? ''),
      author: String(info.author ?? item?.author ?? ''),
      abstract: String(info.abstract ?? info.intro ?? info.description ?? item?.abstract ?? ''),
      tags: Array.isArray(info.tags) ? info.tags.map(String) : (info.tags ? String(info.tags).split(/[,，]/) : []),
      category: String(info.category ?? info.category_name ?? item?.category ?? ''),
      hot: pickHot(item, info),
    }
  }).filter(b => b.book_id !== '')
}

function pickHot(item, info) {
  const candidates = [
    info.read_count, info.readCount, info.hot_score, info.hotScore,
    item.read_count, item.readCount, item.hot_score, item.hotScore,
    item.extra_info?.hot_score, info.extra_info?.hot_score,
  ]
  for (const value of candidates) {
    if (typeof value === 'number' || (typeof value === 'string' && value !== '')) return value
  }
  return null
}

/** 书籍页还原：<title> + meta description + JSON-LD。 */
async function fetchBookPage(bookId) {
  const res = await fetch(`https://fanqienovel.com/page/${bookId}`, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(15_000),
  })
  const html = await res.text()
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1]?.trim() ?? ''
  const meta = html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/)?.[1] ?? ''
  const ld = extractJson(html, /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)
  const name = ld?.name ?? title.split(/[-_|]/)[0].trim()
  const author = ld?.author?.name ?? meta.match(/作者[:：]\s*([^\s，,<]+)/)?.[1] ?? ''
  return { title: name || undefined, author: author || undefined, abstract: (ld?.description || meta || undefined)?.slice(0, 500) }
}

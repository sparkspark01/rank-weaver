/**
 * 五段 cron 解析 + IANA 时区下一次触发计算。
 * 与 dsh-cron/src/cron.ts 语义对齐（数值字段、Vixie 规则、DST gap/overlap），
 * 用于写入 dsh-cron store 前计算 nextAt 与展示后续触发时间。
 * @module lib/cron-next
 */

const DIGITS = /^\d+$/
const RANGE = /^(\d+)-(\d+)$/
const WHITESPACE = /\s+/

export class CronParseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CronParseError'
  }
}

function parseField(text, field, min, max, normalize) {
  const values = new Set()
  let unrestricted = false
  for (const item of text.split(',')) {
    const slash = item.indexOf('/')
    const rangeText = slash === -1 ? item : item.slice(0, slash)
    const stepText = slash === -1 ? undefined : item.slice(slash + 1)
    if (stepText !== undefined && (!DIGITS.test(stepText) || Number(stepText) < 1)) {
      throw new CronParseError(`${field}: invalid step "${stepText}"`)
    }
    const step = stepText === undefined ? 1 : Number(stepText)
    let lo
    let hi
    if (rangeText === '*') {
      lo = min
      hi = max
      if (step === 1) unrestricted = true
    } else if (DIGITS.test(rangeText)) {
      lo = Number(rangeText)
      hi = stepText === undefined ? lo : max
    } else {
      const range = RANGE.exec(rangeText)
      if (range === null) throw new CronParseError(`${field}: invalid term "${item}"`)
      lo = Number(range[1])
      hi = Number(range[2])
      if (lo > hi) throw new CronParseError(`${field}: inverted range "${rangeText}"`)
    }
    for (let value = lo; value <= hi; value += step) {
      const mapped = normalize === undefined ? value : normalize(value)
      if (mapped < min || mapped > max) throw new CronParseError(`${field}: value ${value} out of range ${min}-${max}`)
      values.add(mapped)
    }
  }
  if (values.size === 0) throw new CronParseError(`${field}: empty field`)
  return { values: [...values].sort((a, b) => a - b), unrestricted }
}

/** 解析五段 cron：分 时 日 月 周（0 和 7 都表示周日）。 */
export function parseCronExpression(expression) {
  const fields = expression.trim().split(WHITESPACE)
  if (fields.length !== 5) {
    throw new CronParseError(`expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`)
  }
  const [minuteText, hourText, domText, monthText, dowText] = fields
  const minutes = parseField(minuteText, 'minute', 0, 59)
  const hours = parseField(hourText, 'hour', 0, 23)
  const doms = parseField(domText, 'day-of-month', 1, 31)
  const months = parseField(monthText, 'month', 1, 12)
  const dows = parseField(dowText, 'day-of-week', 0, 7, value => (value === 7 ? 0 : value))
  return {
    minutes: minutes.values, hours: hours.values, months: months.values,
    doms: doms.values, dows: dows.values,
    domUnrestricted: doms.unrestricted, dowUnrestricted: dows.unrestricted,
    source: expression.trim(),
  }
}

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

export function hostTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const formatters = new Map()

function zonedFormatter(timeZone) {
  const cached = formatters.get(timeZone)
  if (cached !== undefined) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23', weekday: 'short',
  })
  formatters.set(timeZone, formatter)
  return formatter
}

function zonedParts(timeZone, utcMs) {
  const parts = {}
  for (const part of zonedFormatter(timeZone).formatToParts(utcMs)) parts[part.type] = part.value
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? ''] ?? 0,
  }
}

function offsetMs(timeZone, utcMs) {
  const parts = zonedParts(timeZone, utcMs)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - Math.floor(utcMs / 60000) * 60000
}

/** 时区墙上时间 → UTC 瞬时；DST gap 返回 null，overlap 取较早瞬时。 */
function zonedToUtc(timeZone, year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const first = guess - offsetMs(timeZone, guess)
  const candidates = [first]
  const secondOffset = offsetMs(timeZone, first)
  if (guess - secondOffset !== first) candidates.push(guess - secondOffset)
  const valid = candidates.filter((instant) => {
    const parts = zonedParts(timeZone, instant)
    return parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute
  })
  if (valid.length === 0) return null
  return Math.min(...valid)
}

const MAX_SEARCH_DAYS = 366 * 4 + 2

function matchesDay(spec, month, dom, weekday) {
  if (!spec.months.includes(month)) return false
  const domMatch = spec.doms.includes(dom)
  const dowMatch = spec.dows.includes(weekday)
  if (!spec.domUnrestricted && !spec.dowUnrestricted) return domMatch || dowMatch
  return domMatch && dowMatch
}

/** 严格晚于 afterMs 的第一次触发（epoch ms），四年内无则返回 null。 */
export function nextOccurrence(spec, afterMs, timeZone) {
  const start = zonedParts(timeZone, afterMs)
  for (let dayOffset = 0; dayOffset < MAX_SEARCH_DAYS; dayOffset++) {
    const dayDate = new Date(Date.UTC(start.year, start.month - 1, start.day + dayOffset))
    const year = dayDate.getUTCFullYear()
    const month = dayDate.getUTCMonth() + 1
    const day = dayDate.getUTCDate()
    const noon = zonedToUtc(timeZone, year, month, day, 12, 0)
    if (noon === null) continue
    const weekday = zonedParts(timeZone, noon).weekday
    if (!matchesDay(spec, month, day, weekday)) continue
    for (const hour of spec.hours) {
      if (dayOffset === 0 && hour < start.hour) continue
      for (const minute of spec.minutes) {
        if (dayOffset === 0 && hour === start.hour && minute <= start.minute) continue
        const instant = zonedToUtc(timeZone, year, month, day, hour, minute)
        if (instant !== null && instant > afterMs) return instant
      }
    }
  }
  return null
}

/** 预览接下来 count 次触发（ISO 字符串）。 */
export function previewOccurrences(expression, timeZone, nowMs, count = 5) {
  const spec = parseCronExpression(expression)
  if (!isValidTimeZone(timeZone)) throw new CronParseError(`invalid_time_zone: ${timeZone}`)
  const times = []
  let cursor = nowMs
  for (let index = 0; index < count; index++) {
    const next = nextOccurrence(spec, cursor, timeZone)
    if (next === null) break
    times.push(new Date(next).toISOString())
    cursor = next
  }
  return times
}

/** 由「每天 HH:MM」构造表达式：`m H * * *`。 */
export function dailyExpression(hhmm, timeZone) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
  if (!m) throw new CronParseError(`invalid daily time "${hhmm}"，需要 HH:MM`)
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) throw new CronParseError(`invalid daily time "${hhmm}"`)
  const expression = `${minute} ${hour} * * *`
  // 校验 + 确保时区可用
  previewOccurrences(expression, timeZone, Date.now(), 1)
  return expression
}

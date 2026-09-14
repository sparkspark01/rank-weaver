/**
 * dsh-cron 持久化 store 的外部写入器。
 * 与 @cofy-x/dsh-cron/src/store.ts 的 v2 文件格式、seq sidecar、写锁协议对齐：
 * - 文件：<dataDir>/jobs.json（{version:2, seq, eventCursor, jobs[]}）
 * - sidecar：jobs.json.seq（跨进程唯一 id 分配）
 * - 写锁：jobs.json.lock 目录（mkdir+pid，stale 接管）
 * 运行中的 dsh-cron 插件通过 500ms 轮询热重载外部变更，并按三方合并接纳本进程新增/删除。
 * @module lib/cron-store
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export function defaultCronDataDir() {
  if (process.env.CRON_DATA_DIR) return process.env.CRON_DATA_DIR
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'cron')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function acquireWriteLock(filePath) {
  const lockDir = `${filePath}.lock`
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      mkdirSync(lockDir)
      writeFileSync(join(lockDir, 'pid'), String(process.pid))
      let held = true
      return {
        release() {
          if (!held) return
          held = false
          rmSync(lockDir, { recursive: true, force: true })
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let pid = null
      try {
        const text = readFileSync(join(lockDir, 'pid'), 'utf8').trim()
        const value = Number(text)
        if (Number.isSafeInteger(value) && value > 0) pid = value
      } catch { /* 锁目录在竞争中被释放 */ }
      if (pid !== null && pidAlive(pid)) {
        await sleep(5)
        continue
      }
      rmSync(lockDir, { recursive: true, force: true })
    }
  }
  throw new Error(`dsh-cron store 写锁超时：${lockDir}`)
}

export class CronStoreFile {
  constructor(filePath) {
    this.filePath = filePath
    this.seqFile = `${filePath}.seq`
  }

  /** 读当前 jobs（不存在 → 空）。 */
  read() {
    let raw
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 2, seq: 0, eventCursor: 0, jobs: [] }
      throw error
    }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.jobs)) {
      throw new Error(`dsh-cron store 格式不受支持：${this.filePath}`)
    }
    return parsed
  }

  list() {
    return this.read().jobs
  }

  seqSidecar() {
    try {
      const value = Number(readFileSync(this.seqFile, 'utf8').trim())
      return Number.isSafeInteger(value) && value > 0 ? value : null
    } catch {
      return null
    }
  }

  writeSeq(value) {
    mkdirSync(dirname(this.seqFile), { recursive: true })
    writeFileSync(this.seqFile, `${value}\n`)
  }

  /** 在写锁内执行一次读-改-写。 */
  async mutate(mutator) {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const lock = await acquireWriteLock(this.filePath)
    try {
      const current = this.read()
      const next = mutator(current) ?? current
      const sidecar = this.seqSidecar()
      next.seq = Math.max(next.seq ?? 0, sidecar ?? 0)
      // 与 dsh-cron maxSeq 一致：id 尾号也参与下限
      for (const job of next.jobs ?? []) {
        const value = Number(String(job.id).slice(String(job.id).lastIndexOf('-') + 1))
        if (Number.isSafeInteger(value) && value > next.seq) next.seq = value
      }
      const payload = `${JSON.stringify({ version: 2, seq: next.seq, eventCursor: next.eventCursor ?? 0, jobs: next.jobs }, null, 2)}\n`
      const temporary = `${this.filePath}.tmp-${process.pid}`
      writeFileSync(temporary, payload)
      renameSync(temporary, this.filePath)
      this.writeSeq(next.seq)
      return next
    } finally {
      lock.release()
    }
  }

  async addJob({ prompt, schedule, createdBy = null, target, concurrencyLimit = 1, timeZone }) {
    if (!target || target.kind !== 'fresh' || !target.cwd) {
      throw new Error('cron job 需要一个 fresh Session target（绝对 cwd）')
    }
    const { nextOccurrence, parseCronExpression, isValidTimeZone } = await import('./cron-next.mjs')
    const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    if (!isValidTimeZone(zone)) throw new Error(`invalid_time_zone: ${zone}`)
    const spec = parseCronExpression(schedule.expression)
    const now = Date.now()
    const nextMs = nextOccurrence(spec, now, zone)
    if (nextMs === null) throw new Error('schedule_unreachable: 四年内没有下一次触发')
    let allocated = null
    const result = await this.mutate((current) => {
      allocated = (current.seq ?? 0) + 1
      const job = {
        id: `cron-${allocated}`,
        prompt,
        schedule: { kind: 'cron', expression: schedule.expression, timeZone: zone },
        createdBy,
        target,
        concurrencyLimit,
        createdAt: new Date(now).toISOString(),
        nextAt: new Date(nextMs).toISOString(),
        lastFiredAt: null,
        fireCount: 0,
        state: 'active',
        paused: false,
        lastRun: null,
        runs: [],
      }
      current.jobs.push(job)
      return current
    })
    return { job: result.jobs.find(j => j.id === `cron-${allocated}`), nextOccurrences: [result.jobs.find(j => j.id === `cron-${allocated}`)?.nextAt].filter(Boolean) }
  }

  async removeJob(id) {
    let removed = false
    await this.mutate((current) => {
      const before = current.jobs.length
      current.jobs = current.jobs.filter(j => j.id !== id)
      removed = current.jobs.length < before
      return current
    })
    return removed
  }

  async pauseJob(id, paused) {
    let updated = false
    await this.mutate((current) => {
      const job = current.jobs.find(j => j.id === id)
      if (job) {
        job.paused = paused
        updated = true
      }
      return current
    })
    return updated
  }
}

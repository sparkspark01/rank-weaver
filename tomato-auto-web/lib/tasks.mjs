/**
 * 异步任务队列：推荐分析 / 大纲生成 / 章节生成等耗时 LLM 操作，
 * 前端 POST 后拿 taskId 轮询 GET /api/tasks/:id。
 * @module lib/tasks
 */

import { randomUUID } from 'node:crypto'

const tasks = new Map()

export function createTask(kind, label) {
  const id = randomUUID()
  const task = { id, kind, label, status: 'queued', createdAt: Date.now(), result: null, error: null, startedAt: null, finishedAt: null }
  tasks.set(id, task)
  if (tasks.size > 200) {
    const oldest = [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt).slice(0, 50)
    for (const t of oldest) tasks.delete(t.id)
  }
  return task
}

export function getTask(id) {
  return tasks.get(id) ?? null
}

/** 串行执行器：LLM 任务逐个跑，避免并发抢配额。 */
let queue = Promise.resolve()

export function enqueue(task, fn) {
  queue = queue.then(async () => {
    if (task.status === 'cancelled') return
    task.status = 'running'
    task.startedAt = Date.now()
    try {
      task.result = await fn((partial) => { task.progress = partial })
      task.status = 'done'
    } catch (error) {
      task.status = 'failed'
      task.error = error?.message ?? String(error)
    } finally {
      task.finishedAt = Date.now()
    }
  }).catch((error) => {
    task.status = 'failed'
    task.error = error?.message ?? String(error)
    task.finishedAt = Date.now()
  })
  return queue
}

export function taskJson(task) {
  return {
    id: task.id,
    kind: task.kind,
    label: task.label,
    status: task.status,
    result: task.result,
    error: task.error,
    progress: task.progress,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  }
}

/**
 * Agent API 适配器：调用用户在弹窗里配置的 OpenAI 兼容 Agent API
 * （DeepSeek / OpenAI / 各类中转都走 /chat/completions）。
 * @module lib/agent
 */

export class AgentApiError extends Error {
  constructor(message, status = null) {
    super(message)
    this.name = 'AgentApiError'
    this.status = status
  }
}

/** 规范化 baseUrl → 完整 chat/completions 地址。 */
export function normalizeBaseUrl(base) {
  const b = String(base || '').trim().replace(/\/+$/, '')
  if (!b) throw new AgentApiError('Agent API 地址不能为空')
  if (/\/chat\/completions$/.test(b)) return b
  if (/\/v\d+$/.test(b)) return `${b}/chat/completions`
  return `${b}/v1/chat/completions`
}

/**
 * 调用 chat/completions。
 * @param {object} config { baseUrl, apiKey, model }
 * @param {Array<{role:string, content:string}>} messages
 * @param {object} [opts] { temperature, maxTokens, json, timeoutMs }
 * @returns {Promise<string>} 回复文本（json 模式下已剥离代码围栏）
 */
export async function chat(config, messages, opts = {}) {
  const { temperature, maxTokens, json = false, timeoutMs = 240_000 } = opts
  if (!config || !config.apiKey || !config.baseUrl || !config.model) {
    throw new AgentApiError('尚未配置 Agent API，请先点击右上角「Agent API」填写')
  }
  const url = normalizeBaseUrl(config.baseUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const body = {
      model: config.model,
      messages,
      stream: false,
      ...(temperature === undefined ? {} : { temperature }),
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new AgentApiError(`Agent API 请求超时（${Math.round(timeoutMs / 1000)} 秒），可更换模型或稍后重试`)
      }
      throw new AgentApiError(`无法连接 Agent API（${url}）：${error?.message ?? error}`)
    }
    const text = await res.text()
    if (!res.ok) {
      let detail = text.slice(0, 300)
      try {
        const parsed = JSON.parse(text)
        detail = parsed?.error?.message || parsed?.message || detail
      } catch { /* 保留原文 */ }
      throw new AgentApiError(`Agent API 返回 HTTP ${res.status}：${detail}`, res.status)
    }
    const data = JSON.parse(text)
    let content = data?.choices?.[0]?.message?.content ?? ''
    if (typeof content !== 'string' || content.trim() === '') {
      throw new AgentApiError('Agent API 返回内容为空')
    }
    if (json) content = stripCodeFence(content)
    return content
  } finally {
    clearTimeout(timer)
  }
}

/** 剥离 ```json ... ``` 围栏。 */
export function stripCodeFence(text) {
  const t = text.trim()
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return m ? m[1] : t
}

/** 用一次小请求验证配置是否可用。 */
export async function testConfig(config) {
  const started = Date.now()
  const reply = await chat(
    config,
    [{ role: 'user', content: '请只回复两个字：正常' }],
    { temperature: 0, maxTokens: 16, timeoutMs: 30_000 },
  )
  return { ok: true, reply: reply.slice(0, 32), tookMs: Date.now() - started }
}

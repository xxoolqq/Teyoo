// 文档助手的大模型调用（OpenAI 兼容的 /chat/completions）。
//
// 为什么放在主进程：
//   1. 渲染端 CSP 是 default-src 'self'，外部 HTTP 请求只能在主进程发；
//   2. API Key 只应该待在主进程 —— 渲染端拿不到它，也就不可能出现在页面的任何
//      状态里（与 mineru.token 同一套约定，见 user-setting.ts）。
//
// 为什么用 net.fetch 而不是 node 的 fetch：net.fetch 走 Chromium 网络栈，系统代理
// /DNS 与窗口行为一致（Node 的 undici 会绕开系统代理设置）。同 http/mineru.ts 的
// 理由。
//
// 流式的部分（P1）会复用这里的 completionsUrl / 错误映射，只换读取 response.body
// 的方式，所以请求构造与错误码都收在本文件里。

import { net } from 'electron'

/**
 * OpenAI 兼容的多模态内容分片。目前只有"图片转公式"会用它：把图片作为
 * image_url 递给**用户自己配置的那个模型**（视觉模型直传；文本模型会拒，调用方
 * 据此降级到本地/服务识别）。
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  /**
   * 二进制图片分片：渲染端把 base64 解成字节递进来（几万字符的 base64 在提示词和
   * IPC 里来回搬没有意义）。**发出去之前**由 toWireMessages 转成 image_url data URL
   * —— 供应商的线上格式只有 data URL / http(s)，这个转换只在这里做一次。
   */
  | { type: 'image'; mime: string; data: Uint8Array }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  /** 纯文本；或分片数组（多模态） */
  content: string | ChatContentPart[]
}

export interface ChatRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  /** 超时（毫秒）。大模型首字可能很慢，默认给足两分钟。 */
  timeoutMs?: number
  /**
   * 采样温度。不给就整个字段不发，用服务端默认。
   * 拆题要 0.2（同输入尽量同输出），对话则通常留默认。
   */
  temperature?: number
  /** 输出上限（OpenAI 的 max_tokens）。拆题要长输出，得显式给。 */
  maxTokens?: number
  /** 要求服务端返回 JSON 对象（OpenAI 兼容的 response_format） */
  responseFormat?: 'json_object'
  /**
   * 思考开关（DeepSeek 官方扩展字段）。**拆题必须关**：
   * deepseek-flash 默认开启思考，同一份 21 题试卷实测 193s / 31,395 个
   * reasoning token；关掉后 24.7s / 0，正文长度几乎不变（16.6k vs 17.0k 字符）。
   * 只有 api.deepseek.com + deepseek-flash/v4 系列认这个字段，其余端点不能发。
   */
  thinking?: 'enabled' | 'disabled'
}

export interface ChatUsage {
  promptTokens?: number
  completionTokens?: number
  /**
   * 思考型模型（deepseek-flash 这类）花在 reasoning 上的 token，**已计入**
   * completionTokens。拆题慢的时候先看这个值 —— 实测一份 21 题的卷子
   * 31k/39k 都在 reasoning 上，跟本地代码没有任何关系。
   */
  reasoningTokens?: number
}

export type ChatResult =
  | { ok: true; text: string; usage?: ChatUsage }
  | { ok: false; error: string }

const DEFAULT_TIMEOUT_MS = 120_000

/** 流式的空闲超时：这么久没有新的分片就认为卡住了（生成本身可以很长） */
const DEFAULT_STREAM_IDLE_MS = 60_000

/**
 * 把用户填的 Base URL 归一成 chat/completions 端点。
 * 允许两种填法：`https://api.deepseek.com/v1`（推荐）或直接填到
 * `.../chat/completions`（有些网关不是 /v1 前缀）。非法返回 null。
 */
export function completionsUrl(baseUrl: string): string | null {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (/\/chat\/completions$/.test(url.pathname)) return url.toString()
  return `${trimmed}/chat/completions`
}

function extractText(payload: unknown): string {
  const choices = (payload as { choices?: unknown })?.choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const message = (choices[0] as { message?: { content?: unknown } })?.message
  const content = message?.content
  if (typeof content === 'string') return content
  // 有些端点给的是分片数组：[{ type: 'text', text: '…' }]
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : ((part as { text?: string })?.text ?? '')))
      .join('')
  }
  return ''
}

function extractUsage(payload: unknown): ChatUsage | undefined {
  const usage = (
    payload as {
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        completion_tokens_details?: { reasoning_tokens?: number }
      }
    }
  )?.usage
  if (!usage) return undefined
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens
  }
}

/** 结束原因：stop / length / content_filter / tool_calls… */
function readFinishReason(payload: unknown): string {
  const choices = (payload as { choices?: { finish_reason?: unknown }[] })?.choices
  const reason = Array.isArray(choices) ? choices[0]?.finish_reason : undefined
  return typeof reason === 'string' ? reason : ''
}

/**
 * 空内容时的诊断串。
 *
 * 光说 EMPTY_RESPONSE 没法判断病因：finish=length + reasoning_tokens 接近
 * max_tokens = 预算被思考吃光（换非思考模型）；finish=stop 且 token 很少 =
 * 偶发空返回（重试即可）。这两种处置完全相反，所以必须带上证据。
 */
function emptyResponseDetail(payload: unknown): string {
  const usage = extractUsage(payload)
  const parts: string[] = []
  const finish = readFinishReason(payload)
  if (finish) parts.push(`finish=${finish}`)
  if (usage?.completionTokens != null) parts.push(`completion_tokens=${usage.completionTokens}`)
  if (usage?.reasoningTokens != null) parts.push(`reasoning_tokens=${usage.reasoningTokens}`)
  return parts.length > 0 ? `EMPTY_RESPONSE: ${parts.join(', ')}` : 'EMPTY_RESPONSE'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 读错误响应体（可能不是 JSON，比如代理返回的 HTML） */
async function errorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 300)
  } catch {
    return ''
  }
}

/**
 * 发送前的最后一道加工：二进制图片分片 → `image_url` 的 data URL。
 * 其余分片原样透传。线上格式的知识只留在这里。
 */
function toWireMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (typeof message.content === 'string') return message
    const parts: ChatContentPart[] = message.content.map((part) =>
      part.type === 'image'
        ? {
            type: 'image_url' as const,
            image_url: { url: `data:${part.mime};base64,${Buffer.from(part.data).toString('base64')}` }
          }
        : part
    )
    return { ...message, content: parts }
  })
}

/**
 * 拼请求体。三个可选参数只在**给了**的时候才写进 body —— 有些兼容端点对
 * `max_tokens: null` / `response_format` 会直接 400，留空比塞默认值安全。
 */
function buildBody(request: ChatRequest, stream: boolean): string {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toWireMessages(request.messages),
    stream
  }
  if (typeof request.temperature === 'number') body.temperature = request.temperature
  if (typeof request.maxTokens === 'number') body.max_tokens = request.maxTokens
  if (request.responseFormat) body.response_format = { type: request.responseFormat }
  // DeepSeek 的思考开关是 `{"thinking": {"type": "enabled" | "disabled"}}`
  if (request.thinking) body.thinking = { type: request.thinking }
  return JSON.stringify(body)
}

/** 流式调用：边收边把增量交给 onDelta，返回值与 completeChat 同形（text = 全文）。 */
export async function streamChat(
  request: ChatRequest,
  onDelta: (chunk: string) => void,
  signal?: AbortSignal
): Promise<ChatResult> {
  const url = completionsUrl(request.baseUrl)
  if (!url) return { ok: false, error: 'BAD_BASE_URL' }
  if (!request.apiKey) return { ok: false, error: 'NO_API_KEY' }
  if (!request.model.trim()) return { ok: false, error: 'NO_MODEL' }
  if (request.messages.length === 0) return { ok: false, error: 'NO_MESSAGES' }

  const controller = new AbortController()
  // 流式不能用"整段超时"（生成可以很长）：改成**空闲超时** —— 每收到一块就重置，
  // 卡住不动（首字迟迟不来、或中途断流）才中止。
  let timedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, request.timeoutMs ?? DEFAULT_STREAM_IDLE_MS)
  }
  const forwardAbort = (): void => controller.abort()
  signal?.addEventListener('abort', forwardAbort, { once: true })
  armIdle()

  try {
    const response = await net.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${request.apiKey}`
      },
      body: buildBody(request, true),
      signal: controller.signal
    })
    if (!response.ok) {
      const detail = await errorBody(response)
      return { ok: false, error: `HTTP_${response.status}${detail ? `: ${detail}` : ''}` }
    }
    if (!response.body) return { ok: false, error: 'NO_STREAM' }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    let finished = false
    // 有没有收到过任何 SSE 事件：用来区分"流压根没通"与"通了但模型就是回了空"
    let sawEvent = false
    while (!finished) {
      const { done, value } = await reader.read()
      if (done) break
      armIdle()
      buffer += decoder.decode(value, { stream: true })
      // SSE：一行一个 `data: …`，事件之间空行分隔。只认 data 行，其余（心跳注释等）跳过。
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) {
          sawEvent = true
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            finished = true
            break
          }
          try {
            const parsed = JSON.parse(payload) as {
              choices?: { delta?: { content?: unknown } }[]
            }
            const delta = parsed.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta) {
              full += delta
              onDelta(delta)
            }
          } catch {
            /* 半行/非 JSON：忽略这一段，下一块会补齐 */
          }
        }
        newline = buffer.indexOf('\n')
      }
    }
    // 空内容也可能是**正确答案**：用户说"把这段删掉"时，模型就该回空的。
    // 所以只在"一个 SSE 事件都没收到"（流压根没通）时才当失败；
    // 流正常跑过但内容是空 → 交给上层按"清空这段"处理（见 assistant.ts）。
    if (!full.trim()) {
      return sawEvent ? { ok: true, text: '' } : { ok: false, error: 'EMPTY_RESPONSE' }
    }
    return { ok: true, text: full }
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, error: timedOut ? 'TIMEOUT' : signal?.aborted ? 'CANCELED' : 'ABORTED' }
    }
    return { ok: false, error: errorMessage(error) }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

/** 非流式调用：一次拿完整回答。 */
export async function completeChat(request: ChatRequest): Promise<ChatResult> {
  const url = completionsUrl(request.baseUrl)
  if (!url) return { ok: false, error: 'BAD_BASE_URL' }
  if (!request.apiKey) return { ok: false, error: 'NO_API_KEY' }
  if (!request.model.trim()) return { ok: false, error: 'NO_MODEL' }
  if (request.messages.length === 0) return { ok: false, error: 'NO_MESSAGES' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await net.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`
      },
      // 密钥只在请求头里，不写日志、不回给渲染端。
      body: buildBody(request, false),
      signal: controller.signal
    })
    if (!response.ok) {
      const detail = await errorBody(response)
      return { ok: false, error: `HTTP_${response.status}${detail ? `: ${detail}` : ''}` }
    }
    const payload = (await response.json()) as unknown
    const text = extractText(payload)
    if (!text.trim()) return { ok: false, error: emptyResponseDetail(payload) }
    return { ok: true, text, usage: extractUsage(payload) }
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, error: 'TIMEOUT' }
    return { ok: false, error: errorMessage(error) }
  } finally {
    clearTimeout(timer)
  }
}

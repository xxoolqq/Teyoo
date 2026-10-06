// MinerU 在线解析（精准解析 API）—— 「PDF转md」窗口里的「在线解析」按钮走这里。
//
// 为什么必须放主进程：
//   1. 渲染端是 file:// 页面，index.html 的 CSP 是 default-src 'self'（没有
//      connect-src），fetch 外部域名直接被拦；
//   2. 上传链接是带签名的临时凭证，不该离开主进程（不落盘、不进日志、不发 IPC）；
//   3. net.fetch 走 Chromium 网络栈，系统代理/DNS 与窗口网络行为一致，不像 Node
//      的 undici 那样绕开代理设置。
//
// 接口（https://mineru.net/apiManage/docs，v4 精准解析）：
//   1. POST /api/v4/file-urls/batch        申请 PUT 上传链接 → batch_id + file_urls
//   2. PUT  <file_url>                     直接传本地字节（不带 Content-Type）
//   3. GET  /api/v4/extract-results/batch/{batch_id}   轮询，done 时给 full_zip_url
//   4. GET  <full_zip_url>                 下载结果压缩包
//
//   注意 /api/v4/extract/task 那条要公网 URL（github/aws 还会超时），桌面端手里
//   只有本地文件，所以只能走 file-urls/batch 这条"签名上传"的路。
//
// 结果落盘的形状（关键约束）：结果包**原样解压**到 PDF 同目录的
//   <pdf 名>.mineru/ —— 不改名、不挑文件、不往 PDF 目录里散图片，压缩包本身也不留。
//   目录里是什么，界面上就用什么：
//     右侧 Markdown ← <pdf 名>.mineru/full.md
//     右侧 JSON     ← <pdf 名>.mineru/layout.json
//   两份都由渲染端按路径直接读（readTextFile），主进程不再做 json→md 的转换。

import { net } from 'electron'
import { request as httpsRequest } from 'node:https'
import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const API_BASE = 'https://mineru.net/api/v4'

// 服务端限制：单文件 ≤ 200MB / ≤ 200 页（页数由服务端判定，超了报 -60006）。
const MAX_FILE_BYTES = 200 * 1024 * 1024
// 逐个请求的超时。普通请求 20s；上传放宽到 10 分钟（大文件 + 弱网）；
// 结果包下载 5 分钟。net.fetch 不像浏览器有默认超时，不设就是无限等。
const REQUEST_TIMEOUT_MS = 20_000
const UPLOAD_TIMEOUT_MS = 10 * 60_000
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000
// 轮询总预算：排队 + 解析 + 转换。实测 200 页 vlm + 公式可以到十分钟以上，
// 所以给 15 分钟；超了不是"失败"，任务还在服务端跑（见 index.ts 的提示文案）。
const POLL_TOTAL_MS = 15 * 60_000
const POLL_FIRST_MS = 3_000
const POLL_MAX_MS = 10_000
const POLL_FACTOR = 1.25

export interface MineruProgress {
  stage: 'applying' | 'uploading' | 'waiting' | 'running' | 'converting' | 'downloading' | 'done' | 'failed'
  /** 已解析页数 / 总页数（state=running 时才有） */
  extracted?: number
  total?: number
  /** 展示给用户的补充文案（错误原因、排队提示等） */
  detail?: string
  /** batch_id：任务已在服务端受理后才有，用于"超时后还能续取" */
  batchId?: string
}

export interface MineruParseResult {
  ok: boolean
  /** 失败原因（中文，直接给用户看）；ok=true 时为空 */
  error?: string
  /** 结果包解压出来的目录（<pdf 目录>/<pdf 名>.mineru） */
  extractDir?: string
  /** 目录里的 full.md —— 右侧 Markdown 面板直接读它 */
  markdownPath?: string
  /**
   * 目录里的中间结果 json —— 右侧 JSON 面板直接读它。
   * 实测包里就叫 layout.json（文档写成 middle.json），_middle.json 是另一版命名。
   */
  jsonPath?: string
  /** 目录里 images/ 下的图片张数（只用于界面上那句「N 张图」） */
  imageCount: number
  batchId?: string
}

interface ApplyResponse {
  code?: number
  msg?: string
  data?: { batch_id?: string; file_urls?: string[] }
}

interface BatchResponse {
  code?: number
  msg?: string
  data?: {
    batch_id?: string
    extract_result?: Array<{
      file_name?: string
      state?: string
      err_msg?: string
      full_zip_url?: string
      extract_progress?: { extracted_pages?: number; total_pages?: number }
    }>
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 服务端错误码 → 中文。文档只给了码和一句英文，直接把英文 msg 丢给用户
 * 对不上号（比如 -60018 是"今天的额度用完了"，却会被读成"解析失败"）。
 */
function describeApiError(code: number | undefined, msg: string | undefined): string {
  const detail = msg ? `（${msg}）` : ''
  switch (code) {
    case -60005:
      return `文件超过 200MB${detail}`
    case -60006:
      return `文件超过 200 页，请先拆分成小份${detail}`
    case -60009:
      return `服务端解析队列已满，请稍后再试${detail}`
    case -60011:
      return `文件没有上传成功，请重试${detail}`
    case -60018:
      return `今天的解析额度已用完（明天再来）${detail}`
    case -60007:
      return `模型服务暂时不可用，请稍后再试${detail}`
    case -60002:
    case -60015:
      return `文件格式不支持${detail}`
    case -60003:
      return `文件读取失败，请检查文件是否损坏${detail}`
    case -60004:
      return `文件是空的${detail}`
    case -60010:
      return `解析失败，请稍后重试${detail}`
    case -60017:
      return `重试次数已达上限${detail}`
    default:
      return msg ? `${msg}（code ${String(code)}）` : `请求失败（code ${String(code)}）`
  }
}

/** Token 问题单独识别：这类错误提示要引导用户去改设置，而不是重试。 */
export function isTokenError(message: string): boolean {
  return /A0202|A0211/.test(message)
}

/**
 * 一次带超时的 JSON 请求。net.fetch 抛的是网络错（DNS/连接/被 abort），
 * HTTP 4xx/5xx 要自己判 —— 服务端把业务错误码放在 body 的 code 里。
 */
async function fetchJson<T>(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await net.fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
    } as RequestInit)
    const text = await resp.text()
    if (!resp.ok) {
      // 只带前 200 字符：MinerU 的错误体可能有签名串，不整段往外抛。
      throw new Error(`HTTP ${resp.status} ${text.slice(0, 200)}`)
    }
    return JSON.parse(text) as T
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 重试：只对"重做一次不会有副作用"的请求用。
 * 提交任务没有副作用（上传同一个签名 URL 是幂等覆盖），所以这三步都能重试；
 * 反过来，已经拿到 batch_id 之后的轮询失败也只是重读状态，同样安全。
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown = null
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (i < attempts - 1) await sleep(Math.min(2_000 * 2 ** i, 15_000))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 申请上传链接。单文件也走 batch 接口 —— 精准解析只有这一条能收本地文件。 */
async function applyUploadUrl(fileName: string, token: string): Promise<{ batchId: string; uploadUrl: string }> {
  const body = JSON.stringify({
    files: [{ name: fileName }],
    model_version: 'vlm',
    // 单文件精确解析：OCR 与公式识别都开（扫描件/公式密集的论文靠这两个）
    is_ocr: true,
    enable_formula: true,
    enable_table: true,
    language: 'ch',
  })
  const json = await withRetry(() =>
    fetchJson<ApplyResponse>(
      `${API_BASE}/file-urls/batch`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body,
      },
      REQUEST_TIMEOUT_MS,
    ),
  )
  if (json.code !== 0 || !json.data?.batch_id) {
    throw new Error(describeApiError(json.code, json.msg) || json.msg || '申请上传链接失败')
  }
  const uploadUrl = json.data.file_urls?.[0]
  if (!uploadUrl) throw new Error('没有拿到上传链接')
  // 注意：file_urls 是签名 URL，不打印、不落盘、不发给渲染端。
  return { batchId: json.data.batch_id, uploadUrl }
}

/** 把本地字节 PUT 到签名 URL。文档明确要求这一步不带 Content-Type。 */
async function uploadBytes(uploadUrl: string, bytes: Buffer): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
  try {
    const resp = await withRetry(async () => {
      const res = await net.fetch(uploadUrl, {
        method: 'PUT',
        body: new Uint8Array(bytes),
        signal: controller.signal,
      } as RequestInit)
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
      return res
    }, 3)
    void resp
  } finally {
    clearTimeout(timer)
  }
}

async function fetchBinary(url: string, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await net.fetch(url, { method: 'GET', signal: controller.signal } as RequestInit)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return Buffer.from(await resp.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 下载结果包。
 *
 * 逃生开关：MinerU 的结果 CDN（cdn-mineru.openxlab.org.cn，证书 *.openxlab.org.cn）
 * 在 2026-10-02 过期，此后所有结果下载都会 ERR_CERT_DATE_INVALID —— 这是服务端
 * 没续期，不是本机问题（同一时刻 mineru.net 的 API 一切正常）。默认仍严格校验，
 * 用户在「偏好设置 → 在线解析（MinerU）」里勾上「忽略结果 CDN 的证书错误」才放行，
 * 即便放行也只对 openxlab.org.cn 这一个域名生效、只影响这一次下载。
 *
 * 为什么不用 session.setCertificateVerifyProc：实测它管不到 net.fetch —— 回调压根
 * 不会被调用（net.fetch 不走 session 的网络上下文），所以这条路看着精巧但不生效。
 * 改成放行时这条下载走 node:https + rejectUnauthorized:false：范围同样限定在
 * 单次请求 + 单个域名，不削弱进程里其它 HTTPS 流量。
 * 对方续期后就该把这个开关（连同本函数）删掉。
 */
async function downloadResult(url: string, insecure: boolean): Promise<Buffer> {
  const allowed = insecure && isCdnHost(url)
  try {
    return allowed
      ? await downloadIgnoringCert(url)
      : await fetchBinary(url, DOWNLOAD_TIMEOUT_MS)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 证书类失败单说一句：不然用户只会看到"fetch failed"，不知道是对方证书过期。
    if (/cert/i.test(message)) {
      throw new Error(
        allowed
          ? `结果下载失败：${message}`
          : `结果下载失败：${message}（MinerU 结果 CDN 的证书可能已过期；急着要的话，可在「偏好设置 → 在线解析（MinerU）」里临时勾上「忽略结果 CDN 的证书错误」再试一次）`
      )
    }
    throw new Error(`结果下载失败：${message}`)
  }
}

/** MinerU 结果包的域名（线路变了就往这里加，别放宽成"任何域名"）。 */
const RESULT_CDN_HOSTS = ['openxlab.org.cn']

function isCdnHost(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return RESULT_CDN_HOSTS.some((base) => host === base || host.endsWith(`.${base}`))
  } catch {
    return false
  }
}

/** 单次 GET 收成 Buffer：证书过期时这是唯一还能把 zip 拉回来的路。 */
function downloadIgnoringCert(url: string, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { rejectUnauthorized: false, timeout: DOWNLOAD_TIMEOUT_MS },
      (res) => {
        // 签名 URL 可能 302 到专线/custom domain，跟着走一层但要防循环。
        const location = res.headers.location
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
          res.resume()
          if (redirects >= 5) {
            reject(new Error('重定向过多'))
            return
          }
          downloadIgnoringCert(new URL(location, url).toString(), redirects + 1).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      }
    )
    req.on('timeout', () => req.destroy(new Error(`timeout ${DOWNLOAD_TIMEOUT_MS}ms`)))
    req.on('error', reject)
    req.end()
  })
}

interface PollOutcome {
  state: 'done' | 'failed'
  zipUrl?: string
  error?: string
  extracted?: number
  total?: number
}

async function pollBatch(
  batchId: string,
  token: string,
  onProgress?: (p: MineruProgress) => void,
): Promise<PollOutcome> {
  const started = Date.now()
  let interval = POLL_FIRST_MS
  while (Date.now() - started < POLL_TOTAL_MS) {
    await sleep(interval)
    interval = Math.min(interval * POLL_FACTOR, POLL_MAX_MS)
    let json: BatchResponse
    try {
      json = await withRetry(
        () =>
          fetchJson<BatchResponse>(
            `${API_BASE}/extract-results/batch/${batchId}`,
            { method: 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
            REQUEST_TIMEOUT_MS,
          ),
        2,
      )
    } catch (error) {
      // 轮询失败不致命（网络抖一下），继续等下一轮；只有连续失败到超时才算完。
      onProgress?.({ stage: 'running', batchId, detail: '查询进度失败，正在重试' })
      continue
    }
    if (json.code !== 0) {
      return { state: 'failed', error: describeApiError(json.code, json.msg) }
    }
    const item = json.data?.extract_result?.[0]
    const state = item?.state ?? 'pending'
    const extracted = item?.extract_progress?.extracted_pages
    const total = item?.extract_progress?.total_pages
    if (state === 'done') {
      onProgress?.({ stage: 'done', batchId, extracted, total })
      if (!item?.full_zip_url) return { state: 'failed', error: '解析完成但没有结果包' }
      return { state: 'done', zipUrl: item.full_zip_url }
    }
    if (state === 'failed' || state === 'converting_failed') {
      return { state: 'failed', error: item?.err_msg ? describeApiError(undefined, item.err_msg) : '解析失败' }
    }
    // pending/waiting-file 是排队，running 是解析中，converting 是格式转换
    const stage: MineruProgress['stage'] =
      state === 'running' ? 'running' : state === 'converting' ? 'converting' : 'waiting'
    onProgress?.({ stage, batchId, extracted, total })
  }
  return { state: 'failed', error: 'TIMEOUT' }
}

// 结果包内三样东西的匹配规则（路径里可能带一层根目录，所以前后都认）
const FULL_MD_RE = /(^|\/)full\.md$/i
const LAYOUT_JSON_RE = /(^|\/)layout\.json$/i
const MIDDLE_JSON_RE = /_middle\.json$/i
const IMAGE_RE = /^images\/.+/i

/** 结果包解压到哪：PDF 同目录的 <pdf 名>.mineru。 */
export function extractDirFor(pdfPath: string): string {
  return pdfPath.replace(/\.pdf$/i, '.mineru')
}

/** 包内路径必须是相对路径：挡掉 zip slip（../ 与绝对路径）写穿到目录外面。 */
function isSafeEntryName(name: string): boolean {
  if (!name) return false
  if (name.startsWith('/') || name.startsWith('\\')) return false
  if (/^[a-zA-Z]:/.test(name)) return false
  return !/(^|\/)\.\.(\/|$)/.test(name) && !/(^|\\)..(\/|$)/.test(name)
}

/**
 * 把结果包**原样**解压到 dir：不改名、不挑文件、不往 PDF 目录里散图片 ——
 * 包里是什么样，目录里就是什么样（full.md / layout.json / images/ …）。
 * 只额外记下两份界面直接要读的文件路径 + 图片张数。
 */
function extractZip(
  zipBytes: Buffer,
  dir: string,
): { markdownPath?: string; jsonPath?: string; imageCount: number } {
  // 同一份 PDF 重复解析：先清掉上一次的目录，免得残留文件混进这一轮的结果。
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const zip = new AdmZip(zipBytes)
  let markdownPath: string | undefined
  let jsonPath: string | undefined
  let imageCount = 0
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = entry.entryName
    if (!isSafeEntryName(name)) continue
    const target = join(dir, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.getData())
    if (FULL_MD_RE.test(name)) markdownPath = target
    if (!jsonPath && (LAYOUT_JSON_RE.test(name) || MIDDLE_JSON_RE.test(name))) jsonPath = target
    if (IMAGE_RE.test(name)) imageCount += 1
  }
  return { markdownPath, jsonPath, imageCount }
}

/** 在已解压的目录里找那两份界面要读的文件（最多往下找几层）。 */
function findInExtractDir(dir: string): { markdownPath?: string; jsonPath?: string } {
  let markdownPath: string | undefined
  let jsonPath: string | undefined
  const walk = (current: string, depth: number): void => {
    if (depth > 3) return
    let listed: Array<{ name: string; isDirectory: boolean }>
    try {
      listed = readdirSync(current, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }))
    } catch {
      return
    }
    for (const entry of listed) {
      const full = join(current, entry.name)
      if (entry.isDirectory) {
        walk(full, depth + 1)
      } else if (FULL_MD_RE.test(entry.name)) {
        markdownPath ??= full
      } else if (!jsonPath && (LAYOUT_JSON_RE.test(entry.name) || MIDDLE_JSON_RE.test(entry.name))) {
        jsonPath = full
      }
    }
  }
  walk(dir, 0)
  return { markdownPath, jsonPath }
}

/**
 * 上一次解析留下的东西（窗口打开 PDF 时把结果再带出来一次）。
 *
 * 两处可能：
 *   1. PDF 旁的 <pdf 名>.mineru/ —— 本机自己解析出来的都是这个形状；
 *   2. PDF 自己就躺在结果包里 —— MinerU 会把上传的原件改名成 <任务id>_origin.pdf
 *      塞回结果包，这时 full.md / layout.json 就在它旁边，而「同名 .mineru 目录」
 *      根本不存在。
 * 两处都没有就返回空对象 —— 没解析过是常态，不是错误。
 */
export function findExtractedResult(pdfPath: string): { markdownPath?: string; jsonPath?: string } {
  const dir = extractDirFor(pdfPath)
  if (existsSync(dir)) {
    const found = findInExtractDir(dir)
    if (found.markdownPath || found.jsonPath) return found
  }
  // 第二种情况要限个范围：只有「看起来就是结果目录」才认（目录名带 .mineru，
  // 或同级直接放着 full.md）。不然随便一份 PDF 都可能被它所在目录树深处某个
  // 无关 json 认上去。
  const ownDir = dirname(pdfPath)
  if (!/\.mineru$/i.test(ownDir) && !existsSync(join(ownDir, 'full.md'))) return {}
  return findInExtractDir(ownDir)
}

/**
 * 全流程：申请链接 → 上传 → 轮询 → 下载结果包 → 解压到目录。
 *
 * 压缩包本身不落盘（下载到内存里直接解开），只留下解压后的目录。
 */
export async function parsePdfOnline(input: {
  filePath: string
  token: string
  /** 偏好设置 mineru.insecureDownload：放行结果 CDN 的过期证书（见 downloadResult）。 */
  insecureDownload?: boolean
  onProgress?: (p: MineruProgress) => void
}): Promise<MineruParseResult> {
  const emit = input.onProgress
  let bytes: Buffer
  try {
    bytes = readFileSync(input.filePath)
  } catch (error) {
    return { ok: false, error: `读不到 PDF：${error instanceof Error ? error.message : String(error)}`, imageCount: 0 }
  }
  if (bytes.byteLength === 0) return { ok: false, error: '文件是空的', imageCount: 0 }
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return { ok: false, error: '文件超过 200MB，请先拆分成小份', imageCount: 0 }
  }

  let batchId: string | undefined
  try {
    emit?.({ stage: 'applying' })
    const applied = await applyUploadUrl(basename(input.filePath), input.token)
    batchId = applied.batchId

    emit?.({ stage: 'uploading', batchId })
    await uploadBytes(applied.uploadUrl, bytes)

    emit?.({ stage: 'waiting', batchId })
    const outcome = await pollBatch(batchId, input.token, emit)
    if (outcome.state === 'failed') {
      // TIMEOUT 是本地等太久，任务本身还在服务端跑 —— 保留 batch_id 让用户能续取。
      emit?.({ stage: 'failed', batchId, detail: outcome.error })
      return { ok: false, error: outcome.error ?? '解析失败', imageCount: 0, batchId }
    }

    emit?.({ stage: 'downloading', batchId })
    const zipBytes = await downloadResult(outcome.zipUrl as string, input.insecureDownload === true)
    // 压缩包不留盘：整包解压到 <pdf 名>.mineru/ 就完事（见 extractZip）。
    const extractDir = extractDirFor(input.filePath)
    const extracted = extractZip(zipBytes, extractDir)
    emit?.({ stage: 'done', batchId })
    return { ok: true, extractDir, ...extracted, batchId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit?.({ stage: 'failed', batchId, detail: message })
    return { ok: false, error: message, imageCount: 0, batchId }
  }
}



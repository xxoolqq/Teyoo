// ColaMD 图片公式识别模拟 HTTP 服务（对齐 SimpleTex /api/latex_ocr 契约）
//
// 零依赖，仅使用 Node.js 内置模块。启动方式：
//   node http/server.mjs
// 可配置环境变量：
//   PORT        监听端口，默认 8787
//   MOCK_TOKEN  合法 token，默认 test-token
//
// 对应官方接口：POST https://server.simpletex.cn/api/latex_ocr
//   请求头：token: <UAT>（SimpleTex UAT 鉴权，字段名固定为 token）
//   请求体：multipart/form-data，文件字段 file（image/*）
//   成功响应：
//     {
//       "code": 200, "show_code": 200, "lastShowTime": 1000,
//       "data": {
//         "latex": "\\frac{1}{2\\sqrt{x}}",
//         "confidence": 0.89952207,
//         "position": "<...>",
//         "request_id": "20251210151151914719101820499153437"
//       }
//     }
//   mock 专用扩展（官方无此参数）：表单加 latex 字段可指定返回内容，便于联调。
//   同一张图片（按内容哈希）始终返回同一条公式，保证联调结果可复现。

import http from 'node:http'

const PORT = Number(process.env.PORT) || 8787
const VALID_TOKEN = process.env.MOCK_TOKEN || 'test-token'
const MAX_BODY_SIZE = 10 * 1024 * 1024 // 10 MB

// 模拟识别结果池（数学 + 化学，化学式沿用 ColaMD 的 _{} / ^{} 语法）
const SAMPLE_LATEX = [
  'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
  '\\tan \\alpha = \\frac{4}{3}',
  'E = mc^2',
  '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
  '\\int_{0}^{1} x^2 \\, dx = \\frac{1}{3}',
  '\\sqrt{x^2 + y^2}',
  '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1',
  'H_{2}O',
  'CO_{2} + H_{2}O',
  'SO_{4}^{2-}',
  'CH_{3}COOH',
  '\\begin{cases} x + y = 3 \\\\ x - y = 1 \\end{cases}'
]

/** FNV-1a 哈希：同一张图片 → 同一个下标，结果稳定可复现 */
function fnv1a(buf) {
  let hash = 0x811c9dc5
  for (const byte of buf) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** 生成与官方同形态的 request_id：14 位日期时间 + 21 位随机数字 */
function makeRequestId(now = new Date()) {
  const p = (n, len = 2) => String(n).padStart(len, '0')
  const ts =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  let rand = ''
  for (let i = 0; i < 21; i++) rand += Math.floor(Math.random() * 10)
  return ts + rand
}

/** 解析 multipart/form-data，返回 { fields: {name: string}, files: {name: {filename, contentType, size, data}} } */
function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`)
  const fields = {}
  const files = {}

  let pos = buffer.indexOf(delimiter)
  if (pos === -1) return { fields, files }
  pos += delimiter.length

  while (pos < buffer.length) {
    // 结束标记 "--boundary--"
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break
    // 跳过 delimiter 后的 CRLF
    if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2

    const next = buffer.indexOf(delimiter, pos)
    if (next === -1) break

    let part = buffer.subarray(pos, next)
    // 去掉 part 末尾紧邻下一个 delimiter 的 CRLF
    if (part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) {
      part = part.subarray(0, part.length - 2)
    }

    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd !== -1) {
      const headers = {}
      for (const line of part.subarray(0, headerEnd).toString('utf8').split('\r\n')) {
        const idx = line.indexOf(':')
        if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
      }
      const content = part.subarray(headerEnd + 4)
      const disposition = headers['content-disposition'] || ''
      const nameMatch = /name="([^"]*)"/.exec(disposition)
      const fileMatch = /filename="([^"]*)"/.exec(disposition)
      const name = nameMatch ? nameMatch[1] : ''
      if (fileMatch && name) {
        files[name] = {
          filename: fileMatch[1],
          contentType: headers['content-type'] || 'application/octet-stream',
          size: content.length,
          data: content
        }
      } else if (name) {
        fields[name] = content.toString('utf8')
      }
    }

    pos = next + delimiter.length
  }

  return { fields, files }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS })
  res.end(JSON.stringify(payload))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const log = (status) => console.log(`${req.method} ${url.pathname} -> ${status}`)

  try {
    // CORS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    // mock 辅助：健康检查（官方无此路径）
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { code: 200, msg: 'ok' })
      return
    }

    if (req.method !== 'POST' || url.pathname !== '/api/latex_ocr') {
      sendJson(res, 404, { code: 404, msg: 'not found' })
      log(404)
      return
    }

    // SimpleTex UAT 鉴权：请求头字段名 token
    const token = req.headers.token
    if (!token) {
      sendJson(res, 401, { code: 401, show_code: 401, msg: '缺少 token（请求头 token）', data: null })
      log(401)
      return
    }
    if (token !== VALID_TOKEN) {
      sendJson(res, 401, { code: 401, show_code: 401, msg: 'token 无效', data: null })
      log(401)
      return
    }

    const contentType = req.headers['content-type'] || ''
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
    if (!/multipart\/form-data/i.test(contentType) || !boundaryMatch) {
      sendJson(res, 400, {
        code: 400, show_code: 400, msg: 'Content-Type 必须是 multipart/form-data', data: null
      })
      log(400)
      return
    }

    // 读取请求体并限制大小
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_SIZE) {
        sendJson(res, 413, { code: 413, show_code: 413, msg: '图片过大，上限 10MB', data: null })
        log(413)
        req.destroy()
        return
      }
      chunks.push(chunk)
    }

    const { fields, files } = parseMultipart(Buffer.concat(chunks), boundaryMatch[1] || boundaryMatch[2])

    const file = files.file || files.image || Object.values(files)[0]
    if (!file) {
      sendJson(res, 400, { code: 400, show_code: 400, msg: '缺少图片文件（字段名 file）', data: null })
      log(400)
      return
    }
    if (!/^image\//i.test(file.contentType)) {
      sendJson(res, 400, {
        code: 400, show_code: 400, msg: `file 不是图片：${file.contentType}`, data: null
      })
      log(400)
      return
    }

    // 显式传入 latex 字段时原样返回（mock 专用），否则按图片内容哈希稳定取一条
    const hash = fnv1a(file.data)
    const latex = fields.latex?.trim() || SAMPLE_LATEX[hash % SAMPLE_LATEX.length]
    const confidence = Number((0.85 + (hash % 10000) / 100000).toFixed(8))
    const lastShowTime = 600 + (hash % 900) // mock 识别耗时（毫秒）
    const position = `<position x1="0" y1="0" x2="${320 + (hash % 480)}" y2="${60 + (hash % 120)}"/>`

    sendJson(res, 200, {
      code: 200,
      show_code: 200,
      lastShowTime,
      data: {
        latex,
        confidence,
        position,
        request_id: makeRequestId()
      }
    })
    log(200)
  } catch (err) {
    sendJson(res, 500, {
      code: 500, show_code: 500, msg: '服务器内部错误',
      error: String(err?.message || err), data: null
    })
    log(500)
  }
})

server.listen(PORT, () => {
  console.log(`ColaMD 图片公式识别模拟服务（SimpleTex 契约）：http://127.0.0.1:${PORT}`)
  console.log('接口：POST /api/latex_ocr，请求头 token，表单字段 file')
  console.log(`鉴权 token：${VALID_TOKEN}（可用 MOCK_TOKEN 环境变量覆盖）`)
})

// converter-service.js — Electron 主进程集成层（合并自 converter-service.js）
// 将 doc2pdf.exe 与 pdf2png.exe 封装为带进度回调的服务：
//   docx --(doc2pdf.exe)--> pdf --(pdf2png.exe)--> png
//
// 这里是简化整改版：两个 exe 各有自己的清晰契约，逐个文件调用，
// 避免上一版 pdf 输入目录聚合时多个 PDF 输出文件名冲突的问题。

const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

function resolveBinDir() {
  if (process.env.CONVERTER_BIN_DIR) return process.env.CONVERTER_BIN_DIR // 手动指定
  if (process.env.ELECTRON_DEV === '1') return path.join(__dirname, '..', 'bin')
  if (process.resourcesPath) return path.join(process.resourcesPath, 'bin') // electron 打包后
  return path.join(__dirname, '..', 'bin') // 纯 node 调试回退
}

function resolveExe(name) {
  const p = path.join(resolveBinDir(), name)
  if (!fs.existsSync(p)) throw new Error(`转换器未随应用打包: ${p}`)
  return p
}

/** 解析 stdout/stderr 一行文本为事件对象 */
function parseLine(line) {
  if (line.includes('失败')) {
    const m = line.match(/^(?:.*失败)\s+(.+?)\s*:\s*(.*)$/)
    if (m) return { type: 'error', file: m[1], message: m[2] }
    return { type: 'error', message: line }
  }
  if (line.includes('->')) {
    // "[2/3] OK  a.docx -> a.pdf" 或 "  页 3/5 -> a_003.png" 或 docx 完成 "a.docx："
    const m = line.match(/^(.+?)\s*->\s*(.+)$/)
    if (m) return { type: 'item', src: m[1].replace(/^\[(\d+\/\d+)\]\s*(OK|完成)?\s*/, ''), dest: m[2] }
    return { type: 'item', src: '', dest: '' }
  }
  return { type: 'log', message: line }
}

/**
 * 运行单个 exe
 * @returns {Promise<{ code: number, items: Array<{src,dest}>, errors: Array<object> }>}
 */
function runExe(exe, args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const items = []
    const errors = []

    const attach = (stream) => {
      let buf = ''
      stream.setEncoding('utf16le')
      stream.on('data', (d) => {
        buf += (d || '').replace(/\u0000/g, '')
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          let line = buf.slice(0, idx).replace(/\r$/, '').trim()
          buf = buf.slice(idx + 1)
          if (!line) continue
          const info = parseLine(line)
          if (info.type === 'item') items.push(info)
          else if (info.type === 'error') errors.push(info)
          if (onProgress) onProgress(info)
        }
      })
    }
    attach(child.stdout)
    attach(child.stderr)

    child.on('error', reject)
    child.on('close', (code) => resolve({ code, items, errors }))
  })
}

/**
 * docx -> pdf
 * @returns {Promise<{ ok, pdfPaths, errors }>}  pdfPaths 为生成的 PDF 文件绝对路径
 */
async function docxToPdf(input, { outDir, onProgress, sender } = {}) {
  const emit = (info) => {
    if (info) info.stage = 'doc2pdf'
    if (onProgress) onProgress(info)
    if (sender && !sender.isDestroyed()) sender.send('convert:progress', info)
  }
  const args = [input]
  if (outDir) args.push(outDir)
  const r = await runExe(resolveExe('doc2pdf.exe'), args, emit)
  // doc2pdf 成功时 stdout 会打印 "src -> dest.pdf"，从 items 收集 dest
  const pdfPaths = r.items
    .map((i) => i.dest)
    .filter((p) => /\.pdf$/i.test(p.trim()))
    .map((p) => p.trim())
  return {
    ok: r.code === 0 && pdfPaths.length > 0,
    pdfPaths,
    errors: r.errors,
    exitCode: r.code,
  }
}

/**
 * pdf -> png. 一个 PDF 产出若干 png；目录内有 docx 也能走 pdf2png，但应由
 * docxToPdf 先产出 PDF 再调用本函数,避免与 docx 命名冲突。
 * @returns {Promise<{ ok, pngPaths, errors }>}
 */
async function pdfToPng(pdfOrDir, { outDir, dpi = 150, onProgress, sender } = {}) {
  const emit = (info) => {
    if (info) info.stage = 'pdf2png'
    if (onProgress) onProgress(info)
    if (sender && !sender.isDestroyed()) sender.send('convert:progress', info)
  }
  // exe 不接受多文件，目录内的 PDF 交由目录模式处理；
  // 逐文件调用可以精确对应每张 png 所属的 PDF
  const stat = fs.statSync(pdfOrDir)
  const targets = stat.isDirectory()
    ? fs.readdirSync(pdfOrDir).filter((f) => /\.pdf$/i.test(f)).map((f) => path.join(pdfOrDir, f))
    : [pdfOrDir]

  const pngPaths = []
  const errors = []
  let okAll = true
  for (const pdf of targets) {
    const args = [pdf]
    if (outDir) args.push(outDir)
    args.push('-r', String(dpi))
    emit({ type: 'stage', stage: 'pdf2png', file: pdf })
    const r = await runExe(resolveExe('pdf2png.exe'), args, emit)
    pngPaths.push(...r.items.map((i) => i.dest).filter((p) => /\.png$/i.test(p.trim())))
    errors.push(...r.errors)
    if (r.code !== 0) {
      okAll = false
      errors.push({ type: 'error', file: pdf, message: `pdf2png 退出码 ${r.code}` })
    }
  }
  return { ok: okAll, pngPaths, errors }
}

/**
 * 一键管线: docx (文件或目录) -> pdf -> png
 * @param {string} input  .docx 文件/目录
 * @param {{
 *   workDir?: string,               // 中间 pdf 与最终 png 的输出目录；缺省 inp 原
 *   dpi?: number,                   // 默认 150
 *   onProgress?: (info) => void,    // 进度回调（同时可经 sender 推 IPC）
 *   sender?: Electron.WebContents,
 * }} [opts]
 * @returns {Promise<{ ok, pdfPaths, pngPaths, errors }>}
 */
async function convert(input, opts = {}) {
  const { workDir, dpi = 150, onProgress, sender } = opts
  const stage = workDir || path.dirname(path.resolve(input))
  fs.mkdirSync(stage, { recursive: true })

  onProgress && onProgress({ type: 'stage', stage: 'doc2pdf', input })
  const p1 = await docxToPdf(input, { outDir: stage, onProgress: undefined, sender })
  if (!p1.ok) return { ok: false, pdfPaths: p1.pdfPaths, pngPaths: [], errors: p1.errors }

  const p2 = await pdfToPng(stage, { outDir: workDir, dpi, onProgress, sender })
  return {
    ok: p2.ok,
    pdfPaths: p1.pdfPaths,
    pngPaths: p2.pngPaths,
    errors: [...p1.errors, ...p2.errors],
  }
}

module.exports = { convert, docxToPdf, pdfToPng, runExe, resolveExe, resolveBinDir }

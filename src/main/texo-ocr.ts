// 主进程 LaTeX 公式识别 —— 本地 Texo 模型（onnxruntime-node 后端）
//
// 为什么放主进程而不是渲染端：Texo-web 用 transformers.js 的 onnxruntime-web
// wasm 后端，但那个 threaded wasm 需要 SharedArrayBuffer（crossOriginIsolated），
// 而 Electron 的 file:// 页面两者都没有（实测 SAB 未定义）。主进程是 Node 环境，
// transformers.js 自动走 onnxruntime-node 原生后端，模型文件直接 fs 读，没有
// wasm / pthread / COI 那一堆问题。渲染端只经 IPC 传 data URL、收 LaTeX。

import { join } from 'path'
import { app } from 'electron'
import { createCanvas, loadImage } from '@napi-rs/canvas'

const UNIMERNET_MEAN = 0.7931
const UNIMERNET_STD = 0.1738

interface Loaded {
  model: import('@huggingface/transformers').VisionEncoderDecoderModel
  tokenizer: import('@huggingface/transformers').PreTrainedTokenizer
}

function modelDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'texo') : join(__dirname, '../../resources/texo')
}

let loadedPromise: Promise<Loaded> | null = null

async function load(): Promise<Loaded> {
  if (loadedPromise) return loadedPromise
  loadedPromise = (async () => {
    const { VisionEncoderDecoderModel, PreTrainedTokenizer, env } = await import('@huggingface/transformers')
    env.allowLocalModels = true
    const model = await VisionEncoderDecoderModel.from_pretrained(modelDir(), { dtype: 'fp32' })
    const tokenizer = await PreTrainedTokenizer.from_pretrained(modelDir())
    return { model, tokenizer }
  })()
  try {
    return await loadedPromise
  } catch (error) {
    loadedPromise = null
    throw error
  }
}

/** data URL → 灰度 → 反转 → 去边距 → 等比缩放 384×384 + 居中 → 归一化 */
async function preprocessImage(dataUrl: string): Promise<Float32Array> {
  const match = /^data:image\/[^;]+;base64,(.+)$/.exec(dataUrl.trim())
  if (!match) throw new Error('不是 base64 图片')
  const img = await loadImage(Buffer.from(match[1], 'base64'))
  const W = img.width
  const H = img.height

  // 1. 原尺寸画到白底 canvas（透明 PNG 补白）
  const c1 = createCanvas(W, H)
  const ctx1 = c1.getContext('2d')
  ctx1.fillStyle = '#ffffff'
  ctx1.fillRect(0, 0, W, H)
  ctx1.drawImage(img as never, 0, 0)

  // 2. 灰度
  const id1 = ctx1.getImageData(0, 0, W, H).data
  const grey = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i += 1) {
    grey[i] = (id1[i * 4] * 299 + id1[i * 4 + 1] * 587 + id1[i * 4 + 2] * 114) / 1000
  }

  // 3. 黑底白字检测：暗像素居多则反转成白底黑字
  let black = 0
  let white = 0
  for (let i = 0; i < grey.length; i += 1) {
    if (grey[i] < 200) black += 1
    else white += 1
  }
  if (black >= white) for (let i = 0; i < grey.length; i += 1) grey[i] = 255 - grey[i]

  // 4. 去边距（阈值 200，找 <200 的"墨迹"边界）
  let minX = W
  let minY = H
  let maxX = 0
  let maxY = 0
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (grey[y * W + x] < 200) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    minX = 0
    minY = 0
    maxX = W
    maxY = H
  }
  const cw = maxX - minX
  const ch = maxY - minY

  // 5. 等比缩放 384×384 + 居中 padding（padding 填 0 = 黑）
  const target = 384
  const scale = Math.min(target / cw, target / ch)
  const newW = Math.max(1, Math.round(cw * scale))
  const newH = Math.max(1, Math.round(ch * scale))
  const padW = Math.floor((target - newW) / 2)
  const padH = Math.floor((target - newH) / 2)

  // 从 crop 区域双线性采样到 384×384
  const out = new Float32Array(target * target)
  const sample = (sx: number, sy: number): number => {
    const fx = Math.min(Math.max(sx, 0), W - 1)
    const fy = Math.min(Math.max(sy, 0), H - 1)
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const x1 = Math.min(x0 + 1, W - 1)
    const y1 = Math.min(y0 + 1, H - 1)
    const dx = fx - x0
    const dy = fy - y0
    const a = grey[y0 * W + x0]
    const b = grey[y0 * W + x1]
    const c = grey[y1 * W + x0]
    const d = grey[y1 * W + x1]
    return a * (1 - dx) * (1 - dy) + b * dx * (1 - dy) + c * (1 - dx) * dy + d * dx * dy
  }
  for (let y = 0; y < target; y += 1) {
    for (let x = 0; x < target; x += 1) {
      let g: number
      if (x < padW || y < padH || x >= padW + newW || y >= padH + newH) {
        g = 0
      } else {
        const sx = minX + ((x - padW) / newW) * cw
        const sy = minY + ((y - padH) / newH) * ch
        g = sample(sx, sy)
      }
      out[y * target + x] = (g / 255 - UNIMERNET_MEAN) / UNIMERNET_STD
    }
  }
  return out
}

/** 图片 data URL → LaTeX（懒加载模型，识别失败返回 null） */
export async function recognizeTexoFormula(dataUrl: string): Promise<string | null> {
  const { model, tokenizer } = await load()
  const array = await preprocessImage(dataUrl)
  const { Tensor, cat } = await import('@huggingface/transformers')
  const tensor = new Tensor('float32', array, [1, 1, 384, 384])
  const pixelValues = cat([tensor, tensor, tensor], 1)
  const outputs = await model.generate({ inputs: pixelValues })
  const text = tokenizer.batch_decode(outputs as unknown as import('@huggingface/transformers').Tensor, { skip_special_tokens: true })[0]
  return text ?? null
}

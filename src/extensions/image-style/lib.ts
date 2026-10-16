// 图片样式扩展（cherry 语法第一阶段）—— 纯逻辑层
//
// 语法：![描述#宽度#高度#对齐#样式...](url)
// 在标准图片 alt 文本之后追加 # 分隔的参数串：
//   - 前两个位置为尺寸：auto / 100px / 50%
//   - 之后为对齐与样式修饰符（顺序任意）：
//       left / center / right          块级对齐
//       border(B) / shadow(S) / radius(R)  边框/阴影/圆角
//   - float-left / float-right 属第二阶段，本阶段解析但渲染用普通对齐
//
// 不满足尺寸/对齐/样式关键字的 token 忽略；无 # 时退化为标准图片。

// 当前编辑文件的绝对路径，用于粘贴场景下本地路径 ↔ file:// URL 的双向转换。
// main 进程的 resolveImagePaths/restoreImagePaths 只在文件打开/保存时运行，
// 粘贴场景不经过它们，因此 renderer 侧需要自行转换。
let currentFilePath: string | null = null

export function setCurrentImageFilePath(path: string | null): void {
  currentFilePath = path
}

/** 本地路径 → file:// URL（用于渲染）。已带协议头的原样返回；相对路径基于当前文件目录解析。 */
export function toFileUrl(src: string): string {
  if (/^(https?:|file:|data:|blob:)/i.test(src)) return src
  // Windows 绝对路径 D:\ 或 D:/
  if (/^[a-zA-Z]:[\\/]/.test(src)) {
    return 'file:///' + src.replace(/\\/g, '/')
  }
  // Unix 绝对路径
  if (src.startsWith('/')) return 'file://' + src
  // 相对路径：基于当前文件目录
  if (currentFilePath) {
    const dir = currentFilePath.replace(/[\\/][^\\/]*$/, '')
    const abs = dir + '/' + src
    return 'file:///' + abs.replace(/\\/g, '/').replace(/^\/+/, '')
  }
  return src
}

/** file:// URL → 本地绝对路径（用于序列化源码）。保持绝对路径，不转相对。 */
export function fromFileUrl(url: string): string {
  if (!url.startsWith('file://')) return url
  let p = decodeURIComponent(url.slice(7))
  // Windows: /D:/... → D:/...
  if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1)
  return p.replace(/\//g, '\\')
}

export type ImageAlign = 'left' | 'center' | 'right' | 'float-left' | 'float-right'

export interface ImageParams {
  width?: string
  height?: string
  align?: ImageAlign
  border: boolean
  shadow: boolean
  radius: boolean
}

const DEFAULT_PARAMS: ImageParams = { border: false, shadow: false, radius: false }

/** 尺寸值：auto / 数字px / 数字%（允许小数） */
const RE_SIZE = /^(auto|\d+(?:\.\d+)?px|\d+(?:\.\d+)?%)$/

const ALIGN_MAP: Record<string, ImageAlign> = {
  left: 'left',
  center: 'center',
  right: 'right',
  'float-left': 'float-left',
  'float-right': 'float-right',
}

/**
 * 对齐下拉的条目。与 ALIGN_MAP 放在同一处维护：下拉里多一项而解析认不出来（或
 * 反过来）都是同一份清单的事，不该由两处各写一遍。
 * 后台面板的「插入图片」也用这一份（那边不能 import image-modal.ts —— 它顶层
 * new ImageModal()，一 import 就往 document.body 挂 DOM）。
 */
export const ALIGN_OPTIONS: { value: ImageAlign | ''; zh: string; en: string }[] = [
  { value: '', zh: '默认', en: 'Default' },
  { value: 'left', zh: '左对齐', en: 'Left' },
  { value: 'center', zh: '居中', en: 'Center' },
  { value: 'right', zh: '右对齐', en: 'Right' },
  { value: 'float-left', zh: '浮动左', en: 'Float left' },
  { value: 'float-right', zh: '浮动右', en: 'Float right' },
]

/**
 * 从 alt 文本中拆分出纯描述和参数对象。
 * 无 # 时返回原 alt + 默认参数。
 */
export function parseImageAlt(alt: string): { alt: string; params: ImageParams } {
  const hashIdx = alt.indexOf('#')
  if (hashIdx < 0) return { alt, params: { ...DEFAULT_PARAMS } }

  const pureAlt = alt.slice(0, hashIdx)
  const tokens = alt
    .slice(hashIdx + 1)
    .split('#')
    .filter((t) => t.length > 0)

  const params: ImageParams = { ...DEFAULT_PARAMS }
  let sizeCount = 0
  for (const token of tokens) {
    if (RE_SIZE.test(token)) {
      if (sizeCount === 0) params.width = token
      else if (sizeCount === 1) params.height = token
      sizeCount += 1
    } else if (token in ALIGN_MAP) {
      params.align = ALIGN_MAP[token]
    } else if (token === 'border' || token === 'B') {
      params.border = true
    } else if (token === 'shadow' || token === 'S') {
      params.shadow = true
    } else if (token === 'radius' || token === 'R') {
      params.radius = true
    }
    // 未知 token 静默忽略
  }
  return { alt: pureAlt, params }
}

/**
 * 把纯描述和参数拼回 cherry 语法的 alt 字段。
 * 无任何参数时返回纯 alt（标准语法，无损）。
 * 参数顺序：宽 → 高 → 对齐 → B → S → R（固定，便于人读和往返）。
 */
export function stringifyImageAlt(alt: string, params: Partial<ImageParams>): string {
  const parts: string[] = [alt]
  if (params.width) parts.push(params.width)
  if (params.height) parts.push(params.height)
  if (params.align) parts.push(params.align)
  if (params.border) parts.push('B')
  if (params.shadow) parts.push('S')
  if (params.radius) parts.push('R')
  if (parts.length === 1) return alt
  return parts.join('#')
}

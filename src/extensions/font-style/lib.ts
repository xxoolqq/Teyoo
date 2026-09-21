// 规约H：字体大小规约 —— 属性解析与序列化共用模块
//
// 块级容器（font_block）与行内标记（font_span）共用同一套属性语法：
//   family=字体名  size=字号pt  align=left|center|right|justify
// 属性之间用空格分隔；字体名含空格时用英文双引号包裹；字号必须带 pt 单位。
//
// 示例：
//   family=SimSun size=14pt align=justify
//   family="Microsoft YaHei" size=12pt
//
// 所有属性均可选；至少有一个属性才视为合法。

export interface FontAttrs {
  /** 字体名（原样保存，含空格时不带引号） */
  family?: string
  /** 字号（含 pt 单位，原样保存，如 "14pt" / "12.5pt"） */
  size?: string
  /** 对齐方式；行内 mark 仅做标记透传，最终由外层块/段落生效 */
  align?: 'left' | 'center' | 'right' | 'justify'
}

// 属性正则：key=value，value 可双引号/单引号/裸值
// 捕获组编号（非捕获组 (?:...) 不占编号，按左括号实际顺序）：
//   group1 = key
//   group2 = 双引号值  family="Microsoft YaHei"
//   group3 = 单引号值  family='Microsoft YaHei'
//   group4 = 裸值       family=SimSun / size=14pt
const RE_ATTRS = /(\w+)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g

/**
 * 解析属性字符串为 FontAttrs。
 * 任何属性值不合法（如 size 不带 pt、align 非法）→ 整个返回 null。
 * 无任何已知属性 → null。
 */
export function parseFontAttrs(str: string): FontAttrs | null {
  const attrs: FontAttrs = {}
  let hit = false
  RE_ATTRS.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RE_ATTRS.exec(str)) !== null) {
    const key = m[1]
    // 双引号值 m[2] / 单引号值 m[3] / 裸值 m[4]
    const value = m[2] ?? m[3] ?? m[4] ?? ''
    if (key === 'family') {
      if (!value) return null
      // 字体名前禁止英文句号（规约 6.3.6）
      if (value.startsWith('.')) return null
      attrs.family = value
    } else if (key === 'size') {
      // 字号必须带 pt 单位，支持小数
      if (!/^\d+(\.\d+)?pt$/.test(value)) return null
      attrs.size = value
    } else if (key === 'align') {
      if (!['left', 'center', 'right', 'justify'].includes(value)) return null
      attrs.align = value as FontAttrs['align']
    } else {
      // 未知属性：扩展预留，忽略
      continue
    }
    hit = true
  }
  return hit ? attrs : null
}

/**
 * 序列化 FontAttrs 回属性字符串（用于输出 Markdown 源码）。
 * 字体名含空格时自动加双引号。
 */
export function serializeAttrs(attrs: FontAttrs): string {
  const parts: string[] = []
  if (attrs.family) {
    if (/\s/.test(attrs.family)) {
      parts.push(`family="${attrs.family}"`)
    } else {
      parts.push(`family=${attrs.family}`)
    }
  }
  if (attrs.size) {
    parts.push(`size=${attrs.size}`)
  }
  if (attrs.align) {
    parts.push(`align=${attrs.align}`)
  }
  return parts.join(' ')
}

/**
 * CSS font-family 值：含空格或特殊字符时加双引号。
 *   SimSun           → SimSun
 *   Microsoft YaHei  → "Microsoft YaHei"
 */
function cssFontFamily(name: string): string {
  if (/^[\w-]+$/.test(name)) return name
  return `"${name}"`
}

/**
 * 构建块级容器的 inline style 字符串。
 * 包含 font-family、font-size、text-align。
 */
export function buildBlockStyle(attrs: FontAttrs): string {
  const parts: string[] = []
  if (attrs.family) parts.push(`font-family:${cssFontFamily(attrs.family)}`)
  if (attrs.size) parts.push(`font-size:${attrs.size}`)
  if (attrs.align) parts.push(`text-align:${attrs.align}`)
  return parts.join(';')
}

/**
 * 构建行内 mark 的 inline style 字符串。
 * 不包含 text-align（行内 align 仅标记透传，由外层块生效）。
 */
export function buildInlineStyle(attrs: FontAttrs): string {
  const parts: string[] = []
  if (attrs.family) parts.push(`font-family:${cssFontFamily(attrs.family)}`)
  if (attrs.size) parts.push(`font-size:${attrs.size}`)
  return parts.join(';')
}

/**
 * 从 HTML style 属性解析回 FontAttrs（用于 parseDOM）。
 */
export function parseStyleFromDOM(style: string): FontAttrs {
  const attrs: FontAttrs = {}
  const map = new Map<string, string>()
  for (const part of style.split(';')) {
    const idx = part.indexOf(':')
    if (idx < 0) continue
    const key = part.slice(0, idx).trim().toLowerCase()
    const val = part.slice(idx + 1).trim()
    if (key) map.set(key, val)
  }
  const family = map.get('font-family')
  if (family) {
    // 去掉 CSS 引号
    attrs.family = family.replace(/^["']|["']$/g, '')
  }
  const size = map.get('font-size')
  if (size && /^\d+(\.\d+)?pt$/.test(size)) {
    attrs.size = size
  }
  const align = map.get('text-align')
  if (align && ['left', 'center', 'right', 'justify'].includes(align)) {
    attrs.align = align as FontAttrs['align']
  }
  return attrs
}

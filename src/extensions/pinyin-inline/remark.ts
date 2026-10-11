// 规约B2：同行平级拼音 —— remark 插件
//
// 语法：<汉字或文本>[<数字声调拼音>]
// 拼音与汉字同一行并列（拼音在汉字右侧）。示例：
//   姑娘[xiuhua4]
//   三晋大地[san1 jin4 da4 di4]
//
// 括号内仅小写字母 + 数字声调（1/2/3/4），轻声不带数字。
// 含汉字或非法字符 → 不解析，原样保留（正则不匹配即跳过）。
// 代码块内不解析：mdast 中 code 节点 value 是字面量，不会被当作 text 遍历。
//
// 与规约B（pinyin-ruby）的区别仅是定界符 [...] 和渲染位置（右侧 vs 上方）。
// 本插件在 mdast 的 text 节点中扫描上述语法，把命中的子串拆成自定义
// `pinyinInline` mdast 节点（attrs: text 汉字、pinyin 拼音串）。

/* eslint-disable @typescript-eslint/no-explicit-any */
import { visit, SKIP } from 'unist-util-visit'

import { trimHanziToSyllables } from '../pinyin-ruby/pinyin'

// 匹配 <汉字>[<拼音>] 的统一正则：
//   组1 = 汉字串（[\u4e00-\u9fa5] 基本 CJK 区，不含 \n）。**允许为空**：
//         工具栏插入的"纯拼音"节点（text=''）序列化为 `[拼音]`，解析端必须
//         同样接受空汉字，否则源码往返一次该节点就退化成普通文本。
//   组2 = 完整拼音串（小写字母 + 数字声调，可多音节）
// 注意：组1 是贪婪匹配，会吃掉紧贴括号之前的整段连续汉字，
// 命中后须用 trimHanziToSyllables 按音节数裁剪基串（见 pinyin-ruby/pinyin.ts）。
// 组2 允许音节段之间以单个空格分隔，如三晋大地[san1 jin4 da4 di4]；
// 不允许多空格或首尾空格。
const RE_PINYIN_INLINE = /([\u4e00-\u9fa5]*)\[((?:[a-z]+[1-4]?)+(?: (?:[a-z]+[1-4]?)+)*)\]/g

// 把一个 text 节点的 value 切成 [text?, pinyinInline, text?, ...]
// 若没有任何匹配，返回 null 表示调用方无需替换原节点。
function splitPinyinInline(value: string): any[] | null {
  const parts: any[] = []
  let last = 0
  let hit = false
  let m: RegExpExecArray | null
  RE_PINYIN_INLINE.lastIndex = 0
  while ((m = RE_PINYIN_INLINE.exec(value)) !== null) {
    hit = true
    if (m.index > last) {
      parts.push({ type: 'text', value: value.slice(last, m.index) })
    }
    // 多音节拼音按音节数裁剪汉字基串；被裁掉的前导汉字保留为普通文本
    const hanzi = trimHanziToSyllables(m[1], m[2])
    const trimmed = m[1].length - hanzi.length
    if (trimmed > 0) {
      // 组1 从整个匹配起点开始，前导被裁汉字即 [m.index, m.index + trimmed)
      parts.push({ type: 'text', value: value.slice(m.index, m.index + trimmed) })
    }
    parts.push({
      type: 'pinyinInline',
      text: hanzi,
      pinyin: m[2],
    })
    last = m.index + m[0].length
  }
  if (!hit) return null
  if (last < value.length) {
    parts.push({ type: 'text', value: value.slice(last) })
  }
  return parts
}

// unified 插件工厂：返回 transformer。
export function remarkPinyinInline(): (tree: unknown) => void {
  return (tree) => {
    visit(tree as any, 'text', (node: any, index: any, parent: any) => {
      if (!parent || index === undefined || index === null) return undefined
      const parts = splitPinyinInline(String(node.value ?? ''))
      if (!parts) return undefined
      parent.children.splice(index, 1, ...parts)
      return [SKIP, index + parts.length]
    })
  }
}

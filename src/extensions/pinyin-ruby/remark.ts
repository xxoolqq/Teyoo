// 规约B：ruby 上方汉字拼音 —— remark 插件
//
// 语法：<汉字>(<数字声调拼音>)
// 紧贴汉字，拼音在汉字上方。示例：
//   姑娘(xiuhua4)
//   天气(tian1qi4)很好
//
// 括号内仅小写字母 + 数字声调（1/2/3/4），轻声不带数字。
// 含汉字或非法字符 → 不解析，原样保留（正则不匹配即跳过）。
// 代码块内不解析：mdast 中 code 节点 value 是字面量，不会被当作 text 遍历。
//
// 本插件在 mdast 的 text 节点中扫描上述语法，把命中的子串拆成自定义
// `pinyinRuby` mdast 节点（attrs: text 汉字、pinyin 拼音串）。
// 与 schema.ts 的 atom 节点对应：text 作为属性而非 children。

/* eslint-disable @typescript-eslint/no-explicit-any */
import { visit, SKIP } from 'unist-util-visit'

import { trimHanziToSyllables } from './pinyin'

// 匹配 <汉字>(<拼音>) 的统一正则：
//   组1 = 汉字串（[\u4e00-\u9fa5] 基本 CJK 区，不含 \n）
//   组2 = 完整拼音串（小写字母 + 数字声调，可多音节）
// 拼音部分 (?:[a-z]+[1-4]?)+ 允许多个 (字母+可选声调) 组合，
// 单个 [1-4]? 允许轻声（不带数字）。
// (?: (?:[a-z]+[1-4]?)+)* 允许音节段之间以单个空格分隔，
// 如 tian1 qi4 / san1 jin4 da4 di4；不允许多空格或首尾空格。
// 注意：组1 是贪婪匹配，会吃掉紧贴括号之前的整段连续汉字，
// 命中后须用 trimHanziToSyllables 按音节数裁剪基串（见 pinyin.ts）。
const RE_PINYIN_RUBY = /([\u4e00-\u9fa5]+)\(((?:[a-z]+[1-4]?)+(?: (?:[a-z]+[1-4]?)+)*)\)/g

// 把一个 text 节点的 value 切成 [text?, pinyinRuby, text?, ...]
// 若没有任何匹配，返回 null 表示调用方无需替换原节点。
function splitPinyinRuby(value: string): any[] | null {
  const parts: any[] = []
  let last = 0
  let hit = false
  let m: RegExpExecArray | null
  RE_PINYIN_RUBY.lastIndex = 0
  while ((m = RE_PINYIN_RUBY.exec(value)) !== null) {
    hit = true
    if (m.index > last) {
      parts.push({ type: 'text', value: value.slice(last, m.index) })
    }
    // 多音节拼音按音节数裁剪汉字基串；被裁掉的前导汉字保留为普通文本，
    // 保证「……再说一遍我是艾海涛(wo2shi4ai4hai3tao3)」中 wǒ 对齐「我」
    // 而不是渲染到前面「故」字的上方。
    const hanzi = trimHanziToSyllables(m[1], m[2])
    const trimmed = m[1].length - hanzi.length
    if (trimmed > 0) {
      // 组1 从整个匹配起点开始，前导被裁汉字即 [m.index, m.index + trimmed)
      parts.push({ type: 'text', value: value.slice(m.index, m.index + trimmed) })
    }
    parts.push({
      type: 'pinyinRuby',
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
export function remarkPinyinRuby(): (tree: unknown) => void {
  return (tree) => {
    visit(tree as any, 'text', (node: any, index: any, parent: any) => {
      if (!parent || index === undefined || index === null) return undefined
      const parts = splitPinyinRuby(String(node.value ?? ''))
      if (!parts) return undefined
      parent.children.splice(index, 1, ...parts)
      return [SKIP, index + parts.length]
    })
  }
}

// 规约G：汉字田字格 —— 纯逻辑层（与 milkdown / remark / DOM 均无依赖）
//
// 语法（++ 之间的内容记为 inner）：
//   ++你好++        inner='你好'        纯汉字 → 每字一格（有字）
//   ++(3)++         inner='(3)'         括号内纯数字 → N 个空白格
//   ++()++          inner='()'          括号内空 → 1 个空白格
//   ++(tian1qi4)++  inner='(tian1qi4)'  括号内拼音 → 按音节拆格，格上方带调拼音
//
// 三种形态互斥；不满足任一形态（如 ++abc++、++你(3)++、++3++）一律非法，
// remark / input rule 均不识别，原样保留为普通文本。
//
// 节点协议（remark/schema/stringify 三方闭环）：
//   一个 ++...++ token = 一个 tianziGrid 节点，attr raw 保存 ++ 之间的
//   完整 inner（含括号），序列化时直接拼 ++${raw}++，天然无损。
//   渲染时由 parseCells(raw) 展开为若干格子。

import { convertPinyin } from '../pinyin-ruby/pinyin'

// ─── 词法 ───────────────────────────────────────────────────────────────────

/** 匹配 ++...++（内容不含 + 与换行，允许空内容 ++()++） */
export const RE_TIANZI = /\+\+([^+\n]*?)\+\+/g

/** input rule 用：锚定光标前 */
export const RE_TIANZI_INPUT = /\+\+([^+\n]*?)\+\+$/

// 汉字基本区
const RE_HAN = /^[\u4e00-\u9fa5]+$/
// 数字
const RE_DIGITS = /^\d+$/
// 拼音音节串：一个或多个（小写字母 + 可选 1-4 声调），如 tian1qi4 / xiu / qing2
const RE_PINYIN = /^(?:[a-z]+[1-4]?)+$/

// ─── 格子模型 ───────────────────────────────────────────────────────────────

/** 一个田字格：char 有值=有字格；pinyin 有值=格上方带拼音（均为空=空白格） */
export interface TianziCell {
  char?: string
  pinyin?: string
}

export type TianziKind = 'chars' | 'blank' | 'pinyin'

export interface TianziModel {
  kind: TianziKind
  cells: TianziCell[]
}

/**
 * 把 ++ 之间的 inner 分类并展开为格子数组；非法输入返回 null。
 */
export function parseCells(inner: string): TianziModel | null {
  // 1) 纯汉字：每字一格
  if (RE_HAN.test(inner)) {
    return {
      kind: 'chars',
      cells: Array.from(inner, (ch) => ({ char: ch })),
    }
  }
  // 2) 括号形态：(N) / () / (拼音)
  const m = /^\((.*)\)$/.exec(inner)
  if (m) {
    const p = m[1]
    // 2a) 空括号：一个空白格
    if (p === '') {
      return { kind: 'blank', cells: [{}] }
    }
    // 2b) 纯数字：N 个空白格（N > 0）
    if (RE_DIGITS.test(p)) {
      const n = Number(p)
      if (n <= 0) return null
      return { kind: 'blank', cells: Array.from({ length: n }, () => ({})) }
    }
    // 2c) 拼音：按音节拆格，每格上方一个带调拼音
    if (RE_PINYIN.test(p)) {
      // convertPinyin 输出以空格分隔音节（见 pinyin-ruby/pinyin.ts），
      // 输入切几个音节就输出几个，轻声也保留
      const syllables = convertPinyin(p).split(/\s+/).filter(Boolean)
      if (syllables.length === 0) return null
      return {
        kind: 'pinyin',
        cells: syllables.map((s) => ({ pinyin: s })),
      }
    }
    return null
  }
  // 其它（裸数字、字母、混合）一律非法
  return null
}

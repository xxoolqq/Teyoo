// 规约B：拼音引擎封装 —— 调用 pinyin-pro 的 convert 函数
//
// 输入：原始拼音串（小写字母 + 数字声调），如 'tian1qi4' / 'xiuhua4'
// 输出：带 Unicode 声调的拼音（音节以空格分隔），如 'tiān qì' / 'xiuhuà'
//
// 关键：pinyin-pro 的 convert 函数不会自动切音节，需用空格分隔输入。
// 本模块用「数字声调作为音节终止符」的启发式先切分原始串：
//   'tian1qi4' → ['tian1', 'qi4'] → 'tian1 qi4' → convert → 'tiān qì'
//   'tian1qi'  → ['tian1', 'qi']  → 'tian1 qi'  → convert → 'tiān qi'（轻声）
//   'xiuhua4'  → ['xiuhua4']      → 'xiuhua4'   → convert → 'xiuhuà'（单音节）
// 注：用户若希望 'xiuhua4' 切成 'xiū huà'，应写作 'xiu1hua4' 显式给每音节加声调。

import { convert } from 'pinyin-pro'

// 用数字声调或空格作为音节终止符切分原始串。
// 每遇到 1-4 数字，结束当前音节（含该数字）并开始下一个；
// 空格同样结束当前音节（支持 tian1 qi4 / san1 jin4 da4 di4 写法，
// 多空格/首尾空格容错）。末尾无数字的字母串单独成为轻声音节。
function splitSyllables(raw: string): string[] {
  const syllables: string[] = []
  let current = ''
  for (const ch of raw) {
    if (ch === ' ') {
      if (current) {
        syllables.push(current)
        current = ''
      }
      continue
    }
    current += ch
    if (ch >= '1' && ch <= '4') {
      syllables.push(current)
      current = ''
    }
  }
  if (current) syllables.push(current)
  return syllables
}

// 把原始拼音串转成带 Unicode 声调的拼音。
// 失败时返回原串，避免渲染崩溃。
export function convertPinyin(raw: string): string {
  if (!raw) return ''
  try {
    const syllables = splitSyllables(raw)
    return convert(syllables.join(' '))
  } catch {
    return raw
  }
}

// 计算拼音串的音节数：以数字声调（1-4）作为音节终止符，末尾无数字的
// 字母串为一个轻声音节（与 splitSyllables 的切分规则一致）。
//   'wo2shi4ai4hai3tao3' → 5
//   'tian1qi4'           → 2
//   'xiuhua4'            → 1
//   'tian1qi'            → 2（末尾轻声）
export function countSyllables(pinyin: string): number {
  let n = 0
  for (const ch of pinyin) {
    if (ch >= '1' && ch <= '4') n += 1
  }
  if (!/[1-4]$/.test(pinyin)) n += 1
  return n
}

// 汉字基串对齐裁剪：多音节拼音（n ≥ 2）时，基串只取紧贴括号的末尾 n 个
// 汉字，与音节 1:1 对齐。否则贪婪的 CJK 匹配会把前面无关的汉字吞进基串，
// 导致拼音渲染错位——如「……的故事再说一遍我是艾海涛(wo2shi4ai4hai3tao3)」
// 基串会包含「的故事再说一遍」共 12 字，wǒ 被渲染到「故」上方。
// 单音节不裁剪：规约示例 `姑娘(xiuhua4)` 允许多个汉字共占一个音节。
export function trimHanziToSyllables(hanzi: string, pinyin: string): string {
  const n = countSyllables(pinyin)
  if (n >= 2 && hanzi.length > n) {
    return hanzi.slice(hanzi.length - n)
  }
  return hanzi
}

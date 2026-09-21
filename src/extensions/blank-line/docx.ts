// 规约C：行内填空线 —— docx 映射
//
// blank=false（带线）：N 个全角空格 + 下划线
// blank=true （纯空白）：N 个全角空格，无下划线
//
// 调用方：src/main/docx-export.ts 的 inlineRuns() 在遇到 mdast blankLine
// 节点时调用本函数，把节点转成 docx 的 TextRun 列表。
// 使用 U+2003 全角空格与 renderer 端 toDOM 保持一致，保证两端等宽。

import { TextRun, type ParagraphChild } from 'docx'

export function blankLineToDocxRuns(
  node: { chars?: number; blank?: boolean }
): ParagraphChild[] {
  const chars = Math.max(1, Math.ceil(Number(node.chars ?? 1)))
  const filler = '\u2003'.repeat(chars) // 全角空格占位
  if (node.blank) {
    return [new TextRun({ text: filler })]
  }
  return [new TextRun({ text: filler, underline: { type: 'single' } })]
}

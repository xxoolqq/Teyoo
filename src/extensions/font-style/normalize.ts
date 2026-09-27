// 规约H：字体块定界符行隔离 —— 原始文本规整化
//
// 在 remark-parse 之前把「字体块定界符行」（:::font {…} / :::）与其紧邻的
// 非空行之间补上空行，使定界符成为独立段落。
//
// 为什么需要：定界符与相邻内容仅隔单换行时，CommonMark 会把它们并入同一段落；
// 若定界符序列中混入 ASCII 列表（1. / -）等可中断段落的结构，列表项还会通过
// 「懒延续」把后续所有行吞进列表项段落内部，导致 remarkFontBlock 的栈式配对
// 错位（首个 ::: 无栈可配、末尾 ::: 被外层 stripTrailingEndMarker 剥离给错误
// 的块），定界符退化为字面文本。补空行后定界符走既有的段落级配对路径，
// 天然正确。
//
// 触发场景：从纯文本环境（聊天工具中转、外部编辑器折叠空行后）粘贴的
// markdown、手写漏空行等。规约要求的书写形态（定界符前后空行）不受影响
//（幂等，已隔离的文本原样返回）。
//
// 集成点：remarkColumns 是解析链中第一个基于原始文本工作的插件，规整化在
// 其区域扫描前执行（见 columns/remark.ts），保证 lexer 与后续所有解析看到
// 同一份文本。

import { FenceTracker } from '../columns/lexer'

/** 完整一行的字体块定界符：:::font {attrs}（开）或 :::（闭）。
 *  不允许前导缩进，与 remark.ts 的 RE_BLOCK_START / RE_BLOCK_END 口径一致。 */
const RE_MARKER_LINE = /^(?:::{3,}font[ \t]*\{[^}]*\}[ \t]*|:{3,}[ \t]*)$/

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function isBlankLine(line: string): boolean {
  return line.trim() === ''
}

/**
 * 把定界符行与紧邻的非空行之间补空行。幂等：已隔离的文本原样返回。
 * 代码围栏内的 ::: 不视为定界符（FenceTracker，CommonMark 口径，
 * 与 columns/lexer.ts 共用同一状态机）。不含 ::: 时零开销快速返回。
 * 保留原有行尾风格（\r\n 文本中插入的空行为纯空行，CommonMark 视作空行）。
 */
export function normalizeFontMarkerLines(raw: string): string {
  if (!raw.includes(':::')) return raw
  const lines = raw.split('\n')
  const out: string[] = []
  const fence = new FenceTracker()
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const text = stripCr(line)
    if (fence.skipLine(text) || !RE_MARKER_LINE.test(text)) {
      out.push(line)
      continue
    }
    // 定界符行：与前后紧邻的非空行之间补空行
    const prev = out[out.length - 1]
    if (prev !== undefined && !isBlankLine(stripCr(prev))) {
      out.push('')
      changed = true
    }
    out.push(line)
    const next = lines[i + 1]
    if (next !== undefined && !isBlankLine(stripCr(next))) {
      out.push('')
      changed = true
    }
  }
  return changed ? out.join('\n') : raw
}

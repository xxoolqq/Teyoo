// 把模型原始返回落盘，方便事后对着失败原因回看。
//
// 为什么需要它：拆题的失败几乎都不是 HTTP 错，而是「内容不对」——JSON 被截断、
// 公式漏抄、字段缺失。这些只有把原始文本留下来才看得出来；而日志是流式的，
// 关掉窗口就没了，几十 KB 的 JSON 也没人会一行行翻控制台。
//
// 落盘位置跟着「工作目录」走（默认 D:/TeyooData/math-parse-raw）：
//   <工作目录>/math-parse-raw/2026-11-01T10-23-45-123Z_0001_12345c.md   原文
//   <工作目录>/math-parse-raw/index.log                                 每次一行摘要
//
// 写盘失败一律静默：这是诊断辅助，不能因为它让解析失败。
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_WORK_DIR, getUserSettingByPath } from '../user-setting'

export interface RawResponseMeta {
  model: string
  subjectCode: string
  title?: string
  /** 是否是修复轮之后的内容（文件名加 -repaired 区分） */
  repaired: boolean
  chars: number
}

/** 原始返回目录：工作目录下 math-parse-raw（默认 D:/TeyooData/math-parse-raw） */
export function resolveRawLogDir(workDir?: string): string {
  const base = workDir || getUserSettingByPath<string>('image.workDir') || DEFAULT_WORK_DIR
  return path.join(base, 'math-parse-raw')
}

/** ISO 时间戳转成 Windows 可用的文件名（去掉冒号与毫秒） */
function fileStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/**
 * 落盘一次原始返回，返回文件路径；失败返回 null（调用方只打日志，不做处理）。
 *
 * 超过 8MB 会截断并加一行说明：一份试卷的返回正常在 100KB 以内，
 * 真到这个量级说明模型失控了，全文留着也读不动。
 */
export async function dumpRawResponse(
  raw: string,
  meta: RawResponseMeta
): Promise<string | null> {
  if (!raw) return null
  const LIMIT = 8 * 1024 * 1024
  const text =
    raw.length > LIMIT
      ? `${raw.slice(0, LIMIT)}\n\n[TRUNCATED] 原始返回 ${raw.length} 字符，仅保留前 ${LIMIT}`
      : raw
  try {
    const dir = resolveRawLogDir()
    await mkdir(dir, { recursive: true })
    const name = `${fileStamp(new Date())}_${meta.subjectCode || 'unknown'}${
      meta.repaired ? '-repaired' : ''
    }_${meta.chars}c.md`
    const file = path.join(dir, name)
    await writeFile(file, text, 'utf8')
    const line = [
      new Date().toLocaleString('zh-CN'),
      `model=${meta.model}`,
      `subject=${meta.subjectCode}`,
      `chars=${meta.chars}`,
      `repaired=${meta.repaired}`,
      `title=${meta.title || ''}`,
      file
    ].join('\t')
    await appendFile(path.join(dir, 'index.log'), `${line}\n`, 'utf8')
    return file
  } catch {
    return null
  }
}

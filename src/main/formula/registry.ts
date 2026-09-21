// 公式转换器注册表
//
// 内置方案在本目录 index.ts 中注册；未来新增方案（如 MathJax、docx 原生
// Math 组件等）只需：新建 converters/ 下的实现文件 → index.ts 注册一行。
// 设置面板枚举（listFormulaConverters）与导出选取（getFormulaConverter）
// 都只依赖本注册表，不感知具体方案。

import type { FormulaConverter, FormulaConverterInfo } from './types'

const registry = new Map<string, FormulaConverter>()

/** 默认转换器 id（未显式指定 makeDefault 时，首个注册的方案为默认） */
let defaultId: string | null = null

export type { FormulaConverterInfo }

/**
 * 注册一个转换器。重复注册同 id 覆盖（便于热更新/测试）。
 * options.makeDefault：将其设为默认方案（设置面板「默认」项）。
 */
export function registerFormulaConverter(
  converter: FormulaConverter,
  options: { makeDefault?: boolean } = {},
): void {
  registry.set(converter.id, converter)
  if (options.makeDefault || defaultId === null) {
    defaultId = converter.id
  }
}

/** 按 id 取转换器；id 为空或未注册时回退默认方案；注册表为空返回 null */
export function getFormulaConverter(id?: string | null): FormulaConverter | null {
  if (id) {
    const hit = registry.get(id)
    if (hit) return hit
  }
  return defaultId ? registry.get(defaultId) ?? null : null
}

/** 全部已注册方案（设置面板下拉选项） */
export function listFormulaConverters(): FormulaConverterInfo[] {
  return Array.from(registry.values(), (c) => ({ id: c.id, label: c.label }))
}

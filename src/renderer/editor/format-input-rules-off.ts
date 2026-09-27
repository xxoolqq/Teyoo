// 格式类输入规则禁用（case1 PM 层修复：转义被吞 + intraword 提前触发）
// ─────────────────────────────────────────────────────────────────────────────
//
// 用户规约：wysiwyg 模式下所有格式操作不允许通过手动输入格式符号触发，
// 必须通过工具栏按钮、快捷键或源码模式。据此移除 markRule 类格式输入规则：
//
// 1. markRule 不检查匹配区间内的 escaped_literal mark——用户转义的定界符
//    （如 \_\_nihao__sdsdfsd 的前缀）会被连同定界符一起吞掉、捕获文本被
//    强加格式 mark（case1 BUG A，私自丢掉转义）；
// 2. 输入规则在击键时刻只有光标前文本，无法预知后续输入——敲完
//    __nihao__ 的第二个 _ 瞬间即触发 strong，而 CommonMark 规定 intraword
//    __ 不可闭合，__nihao__sdsdfsd 整体应保持字面（case1 BUG B，输入规则
//    机制上无解，只能移除规则）。
//
// 项目源码内的自定义规则（highlight / sub-sup / emph-dot）已在各自的
// plugin 装配数组中直接移除注册；preset-commonmark / preset-gfm 的内置
// 规则（strong / emphasis×2 / inlineCode / strikethrough）无法从源头移除，
// 参照 strike-through-fix.ts 的先例：post-create 后在 inputRulesCtx 中按
// match.source 精确定位、原地致瘫其 match 正则。customInputRules 闭包持有
// 同一批规则对象、每次按键读取 rule.match，enterSplitGuardPlugin 亦每次
// 按键从 inputRulesCtx 现读规则，原地改写即全部生效。
//
// 保留：linkInputRule（link-fix.ts 已有 hasEscapedInRange 转义守卫，且为
// 明确需求）、图片 / 拼音 / 田字格 / 分栏 / 带圈序号等内容类输入规则。
// 格式 mark 的工具栏按钮与快捷键（Ctrl+B/I/E/U…）不受影响。

import { inputRulesCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'

/** preset 内置格式规则的 match.source 精确清单（防误伤其他规则） */
const FORMAT_RULE_SOURCES = new Set([
  // preset-commonmark 7.19.2 strong
  '(?<![\\w:/])(?:\\*\\*|__)([^*_]+?)(?:\\*\\*|__)(?![\\w/])$',
  // preset-commonmark emphasis（星号）
  '(?:^|[^*])\\*([^*]+)\\*$',
  // preset-commonmark emphasis（下划线）
  '\\b_(?![_\\s])(.*?[^_\\s])_\\b',
  // preset-commonmark inlineCode
  '(?:`)([^`]+)(?:`)$',
  // preset-gfm 7.19.2 strikethrough（原始缺陷正则，见 strike-through-fix.ts）
  '(?<![\\w:/])(~{1,2})(.+?)\\1(?!\\w|\\/)',
  // strike-through-fix.ts 替换后的修正正则
  '(?<![\\w:/~])(~{1,2})(?![~])(.+?)\\1(?!~)(?!\\w|\\/)',
])

/** 永不匹配的正则（字面 a 后跟行首锚点，任何字符串都无法命中） */
const NEVER_MATCH = /a^/

export function disableFormatInputRules(ctx: Ctx): void {
  const rules = ctx.get(inputRulesCtx) as unknown as { match?: RegExp }[]
  let disabled = 0
  for (const rule of rules) {
    if (!rule.match || !FORMAT_RULE_SOURCES.has(rule.match.source)) continue
    rule.match = NEVER_MATCH
    disabled += 1
  }
  // preset 升级可能改变正则 → 精确匹配落空、规则静默复活，须显式告警
  if (disabled < FORMAT_RULE_SOURCES.size - 1) {
    console.warn(
      `[format-input-rules-off] 仅致瘫 ${disabled}/${FORMAT_RULE_SOURCES.size} 条格式规则，` +
        'preset 正则可能已随版本变化，请核对 FORMAT_RULE_SOURCES',
    )
  }
}

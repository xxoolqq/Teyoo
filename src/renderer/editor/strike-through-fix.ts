// GFM 删除线输入规则错配修复（wysiwyg 敲 ~~hao~ 被“拆散配对”的根因）
// ─────────────────────────────────────────────────────────────────────────────
//
// 上游问题（node_modules/@milkdown/preset-gfm src/mark/strike-through.ts）：
//   删除线输入规则正则 /(?<![\w:/])(~{1,2})(.+?)\1(?!\w|\/)/ 中 (~{1,2})
//   允许回退到单个 ~。敲 `你~~hao~`（开栏两根、闭栏一根）时，规则把开头
//   的 `~~` 拆散：取第一根 ~ 当定界符、第二根 ~ 归入内容，与结尾单根 ~
//   配对，生成 strike(`~hao`)——而 GFM 要求定界符根数一致，本应整串保持
//   字面。误生成的 mark 随后被 syntax-reveal 揭示回源码 `~~~hao~~`，
//   光标被困在揭示节点内（用户所见：`你~~~hao~~`）。
//
// 修复：替换为「定界符必须是完整 ~ run」的等价形式——
//   /(?<![\w:/~])(~{1,2})(?![~])(.+?)\1(?!~)(?!\w|\/)/
//   开栏：前不贴 ~（run 起点）、后不贴 ~（不得截取 run 的一部分）；
//   闭栏：后不贴 ~（run 终点）。
//   `~~hao~~`、`~hao~`（GFM 单波浪线删除线）照常匹配；
//   `~~hao~`（根数不匹配）、`~~~hao~~~`（3 根以上非法定界符）保持字面。
//
// 实现方式：post-create 后在 inputRulesCtx 中按 match.source 精确定位
// 该规则，原地替换其 match 正则。customInputRules 闭包持有同一批规则
// 对象、每次按键运行时读取 rule.match，原地改写即生效，无需重建视图。
// （enterSplitGuardPlugin 每次按键也从 inputRulesCtx 现读规则，同样
// 自动获得修正后的行为。）

import { inputRulesCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'

/** preset-gfm 7.19.2 删除线输入规则的缺陷正则（按 source 精确匹配，防误伤） */
const DEFECTIVE_SOURCE = '(?<![\\w:/])(~{1,2})(.+?)\\1(?!\\w|\\/)'

export function fixStrikeThroughInputRule(ctx: Ctx): void {
  const rules = ctx.get(inputRulesCtx) as unknown as { match?: RegExp }[]
  for (const rule of rules) {
    if (rule.match?.source !== DEFECTIVE_SOURCE) continue
    rule.match = /(?<![\w:/~])(~{1,2})(?![~])(.+?)\1(?!~)(?!\w|\/)/
  }
}

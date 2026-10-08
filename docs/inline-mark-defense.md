# 行内强调标记（粗体 / 斜体 / 着重号）防卫代码归档

记录「粗体、斜体、字下着重号（以及删除线 / 下划线 / 转义）在同一段落混合使用」这个场景下，
为解决解析、序列化、输入规则三个层面的 bug 而累积的**防卫代码**。本文说明每一处为什么存在、
针对哪个上游缺陷，以及 2026-10 核对到上游 7.22.2 仍未修复的结论。

- 相关代码：`src/renderer/editor/`（`residual-emphasis.ts`、`serializer-fix.ts`、`escaped-literal.ts`、
  `format-input-rules-off.ts`、`strike-through-fix.ts`、`link-fix.ts`）与 `src/extensions/emph-dot/`
- 上游版本：`@milkdown/kit@7.19.2`（核对时最新 `7.22.2`）、`remark-parse@11`、`micromark@4`、
  `mdast-util-to-markdown@2`、`remark-gfm@4`

---

## 1. 规模总览

直接为「行内标记混合」引入的代码约 **1000 行、6 个文件**（含注释约 250 行，净代码约 750 行）。
注释占比高（`residual-emphasis` ~31%、`escaped-literal` ~51%），是反复踩坑后的防御性写法。

| 文件 | 行数 | 性质 |
|---|---|---|
| `residual-emphasis.ts` | 512 | 纯防卫：把 CommonMark 解析出的 emphasis/strong/delete 展开回 text，再按正确侧翼重配对 |
| `serializer-fix.ts` | ~187 | `fixMilkdownMarkSplits`（~107）+ `fixMarkerEscapes`（~80）。另有 5 行 `ensureRootChildren` 是空文档崩溃，与本主题无关 |
| `escaped-literal.ts` | 188 | 转义保真体系（`\*` 不被吞、不加），与强调转义同一条链 |
| `format-input-rules-off.ts` | 60 | 禁用 6 条 preset 格式输入规则 |
| `strike-through-fix.ts` | 33 | 删除线输入规则正则缺陷 |
| `link-fix.ts`（转义协同段） | ~40 | 链接输入规则与转义协同 |

功能本体内还有一块为「混合」而写：`emph-dot/remark.ts` 的**第二遍跨节点扫描**（处理
`@.首先**加粗**什么.@` 这类内容夹粗体/下划线的情形，约 120 行）—— 属于功能必需，但同样是混合催生的复杂度。

---

## 2. 为什么累积这么多：三个独立的上游缺陷

这 ~1000 行不是一处 bug，而是三个**不同层**的缺陷，每处都要单独打补丁：

1. **CommonMark 侧翼规则**（`residual-emphasis.ts` + `escaped-literal.ts` + `fixMarkerEscapes`）
   自定义标记 `@.`/`.`/`<u>`/`{=}` 与标准 `* _ ~` 在同一文本域里，定界符紧邻标点就不满足
   left/right-flanking，导致 `**@.内容.@**` 不被识别为粗体、甚至 `**` 被拆散与远处 `*` 错配。
2. **milkdown 序列化器 moveSpaces**（`fixMilkdownMarkSplits`）
   序列化时把 mark 首尾空格移出（为满足定界符侧翼规则），空格 text 恰好插在两个相邻同型
   mark 之间，阻断 `#maybeMergeChildren` 的合并 → 输出多出 `**`，往返后源码变形。
3. **milkdown 输入规则**（`format-input-rules-off.ts` + `strike-through-fix.ts` + `link-fix.ts`）
   markRule 不检查 `escaped_literal` mark（吞转义）、输入规则在击键瞬间触发无法预知后续输入
   （intraword 提前触发）、strikethrough 正则 `(~{1,2})` 允许回退导致根数错配、link 无
   `inclusive:false` 且缺输入规则。

---

## 3. 上游修复核对（7.19.2 → 7.22.2，逐条）

方法：`npm pack @milkdown/{transformer,preset-gfm,preset-commonmark}@7.22.2`，与 node_modules
里锁定的 7.19.2 源码逐文件对比。结论：**全部补丁仍需保留，上游一个都没修。**

| 补丁 | 上游 7.22.2 状态 | 结论 |
|---|---|---|
| `residual-emphasis.ts` | 针对 CommonMark 侧翼规则（规范行为，非 bug） | 永久需要，除非换解析器 |
| `escaped-literal.ts` | 针对 CommonMark 转义消耗（mdast 不留转义痕迹，规范行为） | 永久需要 |
| `fixMilkdownMarkSplits` | `#moveSpaces` / `#maybeMergeChildren` 与 7.19.2 同构，空格仍阻断合并 | 需保留，未修 |
| `fixMarkerEscapes` | mdast-util-to-markdown 2.x 对 `* ~ _` 无条件转义机制未变 | 需保留 |
| `format-input-rules-off.ts` | markRule 机制（吞转义 + intraword 提前触发）未改 | 需保留（⚠️ 见下） |
| `strike-through-fix.ts` | 正则只加了 `$` 锚点，`(~{1,2})` 拆散配对缺陷仍在 | 需保留（⚠️ 见下） |
| `link-fix.ts` | `linkSchema` 仍无 `inclusive:false`、仍无链接输入规则（仅加了 `sanitizeLinkHref`，与本缺陷无关） | 需保留，两处都没修 |

---

## 4. 升级风险：`match.source` 精确匹配会静默失效

三个输入规则补丁都靠**精确字符串匹配 `match.source`** 定位上游规则对象，而 7.22.2 动过正则：

| 补丁里记录的正则 source | 7.22.2 实际 | 结果 |
|---|---|---|
| `format-input-rules-off` 里 emphasis 下划线 `\b_(?![_\s])(.*?[^_\s])_\b` | 变为 `…_$`（`\b`→`$`） | 匹配**落空** |
| `strike-through-fix` 的 `DEFECTIVE_SOURCE` `…(?!\w|\/)` | 变为 `…(?!\w|\/)$`（加 `$`） | 匹配**落空** |
| 其余 5 条（strong / emphasis 星号 / inlineCode / 两条 strike 修正后正则） | 一致 | 仍命中 |

`format-input-rules-off` 有告警（`disabled < size-1` 时 `console.warn`），但 `strike-through-fix`
**没有告警**——升级后它会静默失效，`~~hao~` 的错配又回来。

---

## 5. 维护建议

1. **不要删**：这些补丁对抗的是 CommonMark 规范行为 + milkdown 长期缺陷，升 milkdown 等不到修复。
2. **升级 milkdown 前**：先核对第 4 节的 source 字符串，更新 2 处落空的正则；并给
   `strike-through-fix` 补一个「匹配失败即告警」（现在它是裸匹配）。
3. **要真正删掉大半**，只有 `residual-emphasis` + `serializer-fix` 有戏，根因是规范 + 上游缺陷，
   代价是换解析层或改「逐字保真」需求，收益需单独评估。

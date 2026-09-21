---
name: milkdown-extension
description: 在 ColaMD 中实现新的 Markdown 扩展语法（规约 A-G 类自定义语法，含行内节点、mark、块级容器）。当用户给出 .trae/规约*.txt 或要求新增 milkdown/markdown 自定义语法、渲染+源码往返时使用。不用于普通 bug 修复或 docx 导出逻辑。
---

# ColaMD milkdown 扩展开发

ColaMD = Electron + milkdown（@milkdown/kit + commonmark/gfm preset）。所有规约扩展源码放在 `src/extensions/<kebab-name>/`，注释用中文，且必须同时支持：所见即所得即时渲染、源码模式原样语法、两者无损往返。

## 0. 动手前先定协议（最重要）

先读规约 txt，**一次定死 mdast 节点协议**再写代码，禁止边写边改字段：

- 节点 type 名（camelCase，如 `blankLine`、`pinyinRuby`、`subBlock`）
- attrs 字段名/类型/默认值
- 节点形态（见下方决策表）
- 合法/非法输入边界（非法一律不识别，保留普通文本）

字段必须让 remark（生成端）→ schema（消费端）→ stringify（回写端）三方一次闭环。

## 1. 形态决策

| 场景 | 形态 | 参考现有实现 |
|------|------|-------------|
| 占位符/填空/无内部可编辑文本（`--(N)`、`++你好++`、拼音标签） | inline + **atom** node，content:''，数据全放 attrs | `extensions/blank-line`、`tianzi-grid`、`pinyin-ruby` |
| 可编辑文本+样式（`==高亮==`、`@.着重号.@`） | **mark**（$markSchema + markRule） | `renderer/editor/highlight.ts`、`extensions/emph-dot` |
| 跨行块级容器（@box、@@cols） | block node，**原文行级扫描**，见 references/pitfalls.md §块级容器 | `extensions/columns` |

经验：能 atom 就 atom。非 atom + content 的内联节点，input rule 后连续输入会落入节点内部（拼音 bug 的根因）。

## 2. 行内 atom 扩展七件套

在 `src/extensions/<dir>/` 下创建（模板见 references/inline-atom-template.md，直接复制替换占位符）：

1. `remark.ts` — mdast text 节点扫描正则，拆出自定义 mdast 节点；用 `unist-util-visit` + `SKIP`
2. `schema.ts` — `$nodeSchema`：group:'inline'、inline:true、atom:true、content:''；toDOM/parseDOM/parseMarkdown/toMarkdown 四件套
3. `input-rule.ts` — **必须三步** `tr.delete → tr.insert(node) → tr.setSelection(TextSelection)`，禁止 replaceRangeWith（atom slice 静默失败）
4. `stringify.ts` — remark-stringify handler：`state.enter(type)` + `createTracker` + `tracker.move(...)`
5. `style.css`
6. `plugin.ts` — 数组 `as unknown as MilkdownPlugin[]`
7. `index.ts` — 桶文件 re-export

正则放 remark.ts 顶部常量，`/g` 用前 `lastIndex = 0`；input rule 正则 `$` 锚定。纯逻辑分类（如田字格三态）抽到独立 `lib.ts`，与 milkdown 无依赖，方便 esbuild 打包单测。

## 3. editor.ts 五点接入（一个都不能少）

文件：`src/renderer/editor/editor.ts`

1. import 插件/remark/stringify handler
2. `import '../../extensions/<dir>/style.css'`
3. remark 插件加入 `remarkPluginsCtx` 数组
   - 跨行 mark（着重号）必须在 `remarkBreaks` **之前**
   - 不跨行的行内扩展位置随意
   - 块级容器放**第一个**
4. handler 加入 `remarkStringifyOptionsCtx` 的 handlers 对象
5. `.use(<plugin>)` 链式注册

同时把 `"src/extensions/<dir>/**/*"` 加入 `tsconfig.renderer.json` 的 include；若 main 进程（docx 导出）也要解析，同步加 `tsconfig.main.json`。

## 4. 验证流程

1. `npx tsc -b tsconfig.json --force` 必须零输出
2. schema 有变更必须**整体重启** dev（HMR 不重建 ProseMirror schema）：先 StopCommand 旧 job，tasklist 确认 electron 退出，再 `npm run dev`（Shell 必须 `dangerouslyDisableSandbox: true`，否则 electron 读用户目录被沙箱拦截；后台运行，约 12-14s 后检查日志出现 start electron app）
3. 用户测试三个动作：键入即时渲染 → 切源码无多余转义、语法原样 → 切回保持渲染
4. 复杂逻辑先写临时 `_xxx-test.ts`，用 `npx esbuild --bundle --platform=node --format=esm` 打包成 .mjs 跑 node 验证，**测完立即删除**（文件名下划线开头但仍会被 tsc include 扫到，不能留在最终提交里）

## 5. 已有可复用资产

- 拼音：`extensions/pinyin-ruby/pinyin.ts` 的 `convertPinyin(raw)`（数字声调→带调 Unicode，按声调数字切音节）
- 七件套标准范例：`extensions/tianzi-grid`（含 lib.ts 纯逻辑分层，最新最规范）
- mark 范例：`extensions/emph-dot`
- 块级容器范例：`extensions/columns`（lexer + 原文切片 + VFile 嵌套保护）

## 6. 必须遵守的硬约束（项目记忆）

- 行内标记不得跨行嵌套；块级容器不得嵌套分栏（解析端拒绝）
- 序列化必须无损往返，数字/对齐/比例等参数原样保留，不导出 HTML
- docx 导出未要求时不做；要做时在 `src/main/.../docx-export.ts` 复用同一 remark 解析器
- 不要在 main/index.ts 留 openDevTools 之类的临时代码

详细踩坑记录（openNode 参数位次、toDOM content hole、parse/runSync 差异等）见 `references/pitfalls.md`。

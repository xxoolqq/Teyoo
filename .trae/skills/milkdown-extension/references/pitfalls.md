# 踩坑记录（均为本项目实测）

## ProseMirror / milkdown API

1. **atom 节点 input rule 禁止 `tr.replaceRangeWith`**：它对 atom slice 做"智能"拟合，openStart/openEnd=0 与周围文本不匹配时静默失败，节点不插入。固定三步：`tr.delete(start,end)` → `tr.insert(start,node)` → `tr.setSelection(TextSelection.create(tr.doc, start+node.nodeSize))`。TextSelection 从 `@milkdown/kit/prose/state` 导入。

2. **非 atom + content 内联节点的光标陷阱**：input rule 把光标设到节点后，连续输入的字符仍会落入节点 content（拼音渲染到后续汉字上的 bug）。无内部编辑需求时一律 atom + attrs。

3. **toDOM 的 content hole（0）必须是其父节点唯一子节点**：`['ruby', {...}, 0, ['rt',...]]` 会抛 `Content hole must be the only child of its parent node`。需要兄弟元素时把 0 套进内层 `['span', {}, 0]`。

4. **SerializerState 签名**：`openNode(type, value?, props?)`——mdast 属性走**第 3 参** props（展开到 mdast 节点），第 2 参是字符串 value；atom 节点用 `addNode(type, children, value, props)` 属性走**第 4 参**。

5. **parseDOM.contentElement** 函数签名是 `(node: HTMLElement) => HTMLElement`，不接受 string；需要剔除子元素（如 rt）时 cloneNode 后 remove 再返回。

6. **$markSchema/$nodeSchema 是 tuple+helpers 形态**，导出 plugin 数组要 `as unknown as MilkdownPlugin[]`。

7. **mark 的跨行支持**：正则允许 `\n`，且 remark 插件必须注册在 `remarkBreaks` **之前**——remark-breaks 会把段落内换行切成 break 节点，之后 mark 无法跨节点匹配。

## 块级容器（@box / @@cols 类，见 extensions/columns）

8. **不能在 mdast 上扫描块语法**：容器跨多行且内含空行，remark-parse 已把内容切成多个平级块节点，无法重组。正确做法：transformer 里读 `vfile.value` 原始文本，行级栈扫描（开始/结束正则严格按行首行尾，0~3 空格缩进），按偏移切片重组 tree.children。

9. **内部内容必须 parse + runSync 两步**：milkdown 解析管线是 `remark.runSync(remark.parse(md), md)`。直接调 `processor.parse(inner)` 只走 micromark，所有「树 transformer」型插件（着重号、拼音、填空线、高亮……）在容器内部全部失效。要调 `processor.runSync(ast, vfile)`。

10. **嵌套保护**：内层 runSync 会再次经过自己的 transformer。用 `new VFile({ value, data: { __inside: true } })` 传标记，transformer 开头检测标记直接 return。

11. **词法扫描要点**：代码围栏（``` / ~~~，0~3 空格+至少3个符号）成对跟踪，围栏内不识别标记；`\@` 用「@ 前一字符是否反斜杠」判断；未配对/嵌套分栏/分栏内出现非空白非子块行 → 整个区域作废按普通文本；内容行做**公共缩进 dedent**（tab 按 4 列），否则 4 空格缩进会变代码块。

12. **容器序列化防御性转义**：内部内容可能恰好含长得像标记的行（诗以 `@box` 开头、行尾 @）。stringify handler 对这些行输出 `\@`（CommonMark 解析回字面 @），保证再解析时边界不被破坏。handler 内用 `state.containerFlow(node, tracker.current())` 取内部 flow markdown。

13. **空容器注入空段落**：`@box\n@` 解析后 children 为空，ProseMirror 光标无法进入，parseMarkdown runner 里补 `[{type:'paragraph',children:[]}]`。

14. **交互创建用块级 input rule**：正则以 `\n$` 结尾匹配「只含开始标记的段落 + 回车」，用 `$pos.before($pos.depth)` 取整块范围 replaceWith；创建后光标位置要算对节点 open 深度（sub_block+空段落 = start+2；cols+sub_block+空段落 = start+3）。容器内最后一个空段落按 Enter 用 handleKeyDown 插件跳出容器。

## CSS

15. **每字符着重号用 `text-emphasis: filled dot; text-emphasis-position: under;`**，不要用 `text-decoration: underline dotted`（那是连续点线，且负 underline-offset 会把点推到字中间）。`filled circle` 比 `dot` 大一档。

16. grid 项要 `min-width: 0` 防长内容撑破轨道；无框空容器可用 `:has(> p:only-child:empty)` 显示虚线编辑区。

## 工程流程

17. **schema 改动必须整体重启 dev**：HMR 不重建 ProseMirror schema，热更新后行为是旧的。重启顺序：StopCommand 旧 job → `tasklist /FI "IMAGENAME eq electron.exe"` 确认退出 → 重新 `npm run dev`（后台）→ 12-14s 后看日志。

18. **`npm run dev` 的 Shell 必须 `dangerouslyDisableSandbox: true`**，否则 electron dev 模式访问用户文件（测试 md）被沙箱拦截。

19. **临时单测文件会被 tsc 扫到**：tsconfig.renderer.json include 了 extensions 全部文件，`_test.ts` 里 import 写 `.ts` 后缀会报 TS5097。用 esbuild bundle 成临时 .mjs 跑：`npx esbuild x.ts --bundle --platform=node --format=esm --outfile=.tmp.mjs` → `node .tmp.mjs`，测完删除临时文件。

20. **tsc 验证**：`npx tsc -b tsconfig.json --force`，零输出即通过。state.next 等参数类型用 `any[]` 而非 `unknown[]`（milkdown 的 MarkdownNode 类型不收 unknown）。

21. 新扩展目录必须同步加进 `tsconfig.renderer.json` include，否则构建不包含但 IDE 可能不报错。

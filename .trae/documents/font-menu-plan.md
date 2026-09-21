# 菜单栏增加"字体"菜单 — 实施计划

## Context

用户要求在菜单栏增加"字体"菜单，仿照 Word 设计，列出初高中常用字体和字号。选中文字后点击即可应用字体/字号样式。

项目已有 `font_span` mark（`src/extensions/font-style/schema.ts`），携带 `family`、`size`、`align` 属性。当前只能通过源码手写 `{= family=SimSun : 文字}` 语法，没有 UI 入口。

## 方案

在原生菜单和 HTML 菜单栏中增加"字体"顶级菜单（位于"格式"和"视图"之间），内含两个子菜单（字体名 / 字号）+ 清除字体。点击后通过 IPC 发送 `editor:font` 事件，renderer 调用 `applyFont()` 在选区上 toggle `font_span` mark。

### 菜单结构

```
字体 (Font)
├─ 字体名 (Font Family)
│   ├─ 宋体 SimSun
│   ├─ 黑体 SimHei
│   ├─ 楷体 KaiTi
│   ├─ 仿宋 FangSong
│   ├─ 微软雅黑 Microsoft YaHei
│   ├─ Times New Roman
│   ├─ Arial
│   └─ Courier New
├─ ────
├─ 字号 (Font Size)
│   ├─ 小初 36pt
│   ├─ 一号 26pt
│   ├─ 小一 24pt
│   ├─ 二号 22pt
│   ├─ 小二 18pt
│   ├─ 三号 16pt
│   ├─ 小三 15pt
│   ├─ 四号 14pt
│   ├─ 小四 12pt
│   ├─ 五号 10.5pt
│   └─ 小五 9pt
├─ ────
└─ 清除字体 (Clear Font)
```

### 修改文件

**1. `src/main/index.ts`** — 原生菜单
- `MenubarKey` 类型加 `'font'`
- `labels` 对象加 `font: '字体' / 'Font'`
- 在"格式"和"视图"之间插入 `font` 菜单（含两个子菜单 + 清除字体）
- 字体名菜单项 click → `sendToFocused('editor:font', { family: 'SimSun' })`
- 字号菜单项 click → `sendToFocused('editor:font', { size: '14pt' })`
- 清除字体 click → `sendToFocused('editor:font', { clear: true })`
- `menubarItems` 加 `font` 查找

**2. `src/preload/index.ts`** — IPC 桥
- 类型定义加 `onFontCommand: (callback: (attrs: { family?: string; size?: string; clear?: boolean }) => void) => void`
- 实现加 `ipcRenderer.on('editor:font', (_event, attrs) => callback(attrs))`

**3. `src/preload/index.js`** — 编译产物同步

**4. `src/preload/index.d.ts`** — 类型声明同步

**5. `src/renderer/index.html`** — HTML 菜单栏
- 在"格式"和"视图"之间加 `<button class="menubar-item" data-menu="font">字体</button>`

**6. `src/renderer/editor/editor.ts`** — `applyFont()` 函数
- 新增 `applyFont(attrs: { family?: string; size?: string; clear?: boolean }): void`
- `clear: true` → 移除选区上所有 `font_span` mark
- `family` 或 `size` → 在选区上添加/更新 `font_span` mark，合并已有 attrs（先读已有 attrs，再覆盖新值，确保可分别设置 family 和 size）
- 空选区时操作 `storedMarks`（设后续输入的 mark）

**7. `src/renderer/main.ts`** — IPC 监听
- 加 `api.onFontCommand((attrs) => applyFont(attrs))`

### `applyFont` 实现要点

```typescript
export function applyFont(attrs: { family?: string; size?: string; clear?: boolean }): void {
  if (!editorInstance) return
  editorInstance.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    if (!view.hasFocus()) return
    const { from, to, empty } = view.state.selection
    const markType = view.state.schema.marks['font_span']
    if (!markType) return

    if (attrs.clear) {
      view.dispatch(view.state.tr.removeMark(from, to, markType))
      return
    }

    if (empty) {
      // 空选区：更新 storedMarks
      const existing = view.state.storedMarks ?? []
      const current = existing.find((m) => m.type === markType)
      const newAttrs = {
        family: attrs.family ?? current?.attrs.family ?? '',
        size: attrs.size ?? current?.attrs.size ?? '',
      }
      view.dispatch(view.state.tr.removeStoredMark(markType).addStoredMark(markType.create(newAttrs)))
      return
    }

    // 有选区：合并已有 mark attrs，再设置
    const existing = view.state.doc.resolve(from).marks(type => type === markType)
    // 先移除旧 mark，再添加合并后的新 mark
    view.dispatch(view.state.tr.removeMark(from, to, markType).addMark(from, to, markType.create({
      family: attrs.family ?? existing?.family ?? '',
      size: attrs.size ?? existing?.size ?? '',
    })))
  })
}
```

## 验证

1. `npx tsc --noEmit -p tsconfig.main.json && npx tsc --noEmit -p tsconfig.renderer.json` — 编译通过
2. `npm run dev` 启动应用
3. 在编辑器中选中文字 → 菜单栏"字体" → "字体名" → "楷体" → 选中文字变为楷体
4. 继续选中同一段文字 → "字号" → "小四 12pt" → 文字同时变为楷体+12pt
5. 选中文字 → "清除字体" → 恢复默认
6. 源码模式确认生成的标记为 `{= family=KaiTi size=12pt : 文字}`
7. 切回 WYSIWYG 确认样式保持

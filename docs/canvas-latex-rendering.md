# 画布 LaTeX 渲染改造：踩坑与最终解法

记录把 canvas-editor 画布里的公式渲染从「自带 Hershey 描边字体」换成项目自己的
MathJax 引擎的全过程，重点是**为什么前两次改完看起来没变化**，以及最后怎么验证的。

- 相关代码：`src/renderer/canvas-editor/latex-renderer.ts`
- 相关补丁：`patches/@hufe921+canvas-editor+1.0.4.patch`
- 上游版本：`@hufe921/canvas-editor@1.0.4`

---

## 1. 现象与目标

画布里的公式（从 Markdown 导入）渲染质量差：

- 字是**单线描边**（Hershey 字体），不是真正的数学字体
- `\begin{cases}` / 分数 / 矩阵这类结构，括号不拉伸、上下标偏移
- 公式**整块浮在文字上方**（垂直位置不对）

目标：只换渲染器，**不动用户写的 LaTeX 源码**（`[\begin{matrix}...]` 这种裸括号写法
要保持原样），元素类型仍然是 `latex`，导出 Markdown、复制、选中、编辑交互不受影响。

---

## 2. canvas 内部机制

公式渲染在 `@hufe921/canvas-editor/dist/canvas-editor.js` 里只有**一个收口**：

```js
// 排版时：对每个 latex 元素
const { svg, width, height } = LaTexParticle.convertLaTextToSVG(value)
element.width ||= width
element.height ||= height
element.laTexSVG = svg

// 绘制时：把 laTexSVG（data URL）当图片画出来
LaTexParticle.render(ctx, element, x, y)
//  → ctx.drawImage(image, x, y, element.width * scale, element.height * scale)
```

悬浮预览（resizer / `mime=svg`）取的也是同一个 `laTexSVG`。所以换掉这一个静态方法，
**宽度、描图、预览整条链路就都换了**。

---

## 3. 踩过的坑

### 坑 1：靠反射找 `Draw` —— 补丁从没装上过

第一版的思路是：从 `editor` 实例出发遍历对象图找到 `Draw`，再取 `draw.getLaTexParticle()`
替换掉实例上的 particle。看起来合理，**实际完全没生效**。

在真实 Electron + Chromium 里跑探针，从 `editor` 出发做 8 层 DFS（跳过 Node/HTMLElement）：

```
[canvas-latex] 未找到 LaTexParticle，画布公式仍用 canvas 自带渲染
registerKeys: [contextMenuList, getContextMenuList, shortcutList, langMap]
foundPath: null
```

原因（读 dist 源码确认）：

- `Draw` 在 `Editor` 构造函数里是**局部变量**，只被 `command` 的闭包引用
- `Editor` 上挂的 `register` 只**拷贝了列表**（`{contextMenuList, getContextMenuList,
  shortcutList, langMap}`），不持有任何管理器实例
- `command` 上的方法是从 `CommandAdapt` **拷贝**过来的，`CommandAdapt` 实例本身没留下引用

**结论：`editor → Draw` 整条路径不可达，反射方案从设计上就不成立。**

教训：改第三方库之前，**先证明目标对象真的够得到**，别先写替换逻辑。

---

### 坑 2：`LaTexParticle` 上游没导出，静态方法够不到

`convertLaTextToSVG` 是**静态方法**，只能从类本身改。但上游没导出这个类
（类名在产物里被压成 `mt`），`import { LaTexParticle } from '@hufe921/canvas-editor'`
拿不到。

排查过所有公开口子，都没有：

- `IEditorOption` 里没有 latex 相关配置
- `Override` / `EventBus` 里没有渲染钩子
- `Register` 只有那 4 个列表

**解法**：项目本来就有 `patch-package` 通道，用它在 dist 的导出表里**补一行导出**
（补丁一共只改 3 行）：

```diff
-export { to as AreaMode, Pt as BackgroundRepeat, ...
+export { mt as LaTexParticle, to as AreaMode, Pt as BackgroundRepeat, ...
```

同时给 `dist/src/editor/index.d.ts` 补 import + export，让 TS 也能解析到。

---

### 坑 3：ESM / UMD 两个入口，只有 ESM 那个打了补丁

`package.json` 里：`main: dist/canvas-editor.umd.cjs`、`module: dist/canvas-editor.js`。

验证用的探针一开始用 `packages: 'external'` + `require()`，走的是 **main 字段（UMD）**，
那里没打补丁 → `LaTexParticle` 是 `undefined` → 运行时直接抛错，探针超时。

而 Vite / esbuild 打包 renderer 走的是 **module 字段（ESM）**，补丁在那里。

**解法**：探针改用 `mainFields: ['module', 'main']` 把 canvas-editor **打进 bundle**，
与 Vite 的实际解析行为一致；构建产物里也确认了用的是 `mt.convertLaTextToSVG`（ESM 分支）。

教训：验证环境和生产环境必须走**同一条模块解析路径**，否则验证的是假象。

---

### 坑 4：元素自带 `width/height` 时不会被覆盖 → 公式被拉伸变形

排版代码是 `element.width ||= width`（原文 `n.width = n.width || t`）：
**元素原本有尺寸就沿用旧值**。

于是同一个公式、两种元素：

| 元素来源 | 结果 |
|---|---|
| Markdown 导入 / 工具栏插入（不带尺寸） | 用我们的新尺寸，正常 |
| 带旧尺寸的元素（如以前导出的 JSON 再导入） | 沿用旧尺寸，把新图**拉伸变形** |

这是实测出来的：同一页面两行同样的公式，第一行元素带 `width:82,height:45`，
MathJax 的字被压扁；第二行不带尺寸，完全正常。

**解法**：不去改 canvas 的布局规则（那属于动排版引擎），而是把这个行为**写进注释当成已知边界**：
带旧尺寸的文件需要重新导入 Markdown 才能得到正确比例。

---

### 坑 5：删掉 `vertical-align` 把基线信息一起丢了 → 公式上浮

这是用户反馈的第二个问题：「字体正常了，但公式还是底部与文字底部对齐」。

第一版代码里有这么一行：

```ts
clone.removeAttribute('style')   // vertical-align 是给行内排版用的，画成图片没有意义
```

**这句是错的。** `vertical-align` 里装的正是**基线位置**（`vertical-align: -2.148ex`），
不是什么行内排版装饰。

用 hook 抓 canvas 的实际绘制调用，数据很干净：

```
文字基线   fillText  y = 216
公式图片   drawImage y = 132，高 82.5  →  底边 214.5
```

**公式图片的底边正好压在文字基线上**（差 1.5px 是取整误差）。这是 canvas 把 latex
当图片排的规则：图片底边贴基线。矮公式勉强能看，`cases` / 分数 / 矩阵这类高公式就整块浮上去。

而 MathJax 的 SVG 自带真实基线：

```
style="vertical-align: -2.148ex"          ← 基线在图片底部之上 2.148ex
viewBox="0 -1449.5 5138.6 2399"           ← 原点 y=0 就是数学基线
```

**解法**：从 viewBox 换算出 depth（未缩放的 px），绘制时把元素整体下移这么多，
让**公式的数学基线落在文字基线上**——这也是 LaTeX 行内公式的标准做法
（公式底边本来就该低于基线：下标、分号、行列式的下半截都在那）。

下移后实测 `drawImage y = 165.25`，公式底边 249.2，减掉 depth 33.2 → **图内基线 = 216.0，
与文字基线完全重合**。

---

### 坑 6：SVG 尺寸必须真参与布局才量得出来

MathJax 输出的 `width` / `height` 属性是 **ex 单位**（`width="11.626ex"`），
不能靠解析属性字符串换算——ex 依赖当前字体度量，实测 `1ex = 7.6px`（font-size 14px 下）。

**解法**：把 SVG 塞进一个离屏但**参与布局**的宿主里（`position:absolute; visibility:hidden`，
`display:none` 不行，那样不布局），用 `getBoundingClientRect()` 量真实 px。

---

## 4. 最终解法

### 架构

```
installMathJaxLatexRenderer()               ← 在 createEntry 里、导入内容之前调用一次
  ├─ 补丁 A：替换 LaTexParticle.convertLaTextToSVG（静态方法）
  │     LaTeX → MathJax SVG data URL + 真实 px 宽高
  └─ 补丁 B：包裹 LaTexParticle.prototype.render
        绘制时把 y 下移 depth × scale，让数学基线对齐文字基线
```

### 补丁 A：换渲染器

```145:160:src/renderer/canvas-editor/latex-renderer.ts
export function installMathJaxLatexRenderer(): void {
  if (patched) return
  if (!LaTexParticle || typeof LaTexParticle.convertLaTextToSVG !== 'function') {
    console.warn('[canvas-latex] LaTexParticle 不可用，画布公式仍用自带渲染')
    return
  }
  const original = LaTexParticle.convertLaTextToSVG.bind(LaTexParticle)
  LaTexParticle.convertLaTextToSVG = (latex: string): CanvasLaTexSVG => {
    try {
      const rendered = renderLatex(latex)
      if (rendered) return rendered
    } catch (error) {
      console.warn('[canvas-latex] MathJax 渲染失败，本次回退自带渲染：', error)
    }
    return original(latex)
  }
```

渲染流程（`renderLatex`）：

1. 缓存命中直接返回
2. `mathjaxEngine.render()` 出 SVG，塞进离屏宿主量 `getBoundingClientRect()`
3. 从 viewBox 算 depth：`(viewBox.y + viewBox.height) × (height / viewBox.height)`
4. clone 一份，补 `xmlns`、写死 px 宽高、**保留** `vertical-align`（基线信息）
5. `XMLSerializer` → `data:image/svg+xml` data URL

### 补丁 B：修正垂直位置

```172:188:src/renderer/canvas-editor/latex-renderer.ts
  const originalRender = LaTexParticle.prototype.render
  LaTexParticle.prototype.render = function (
    ctx: CanvasRenderingContext2D,
    element: IElement,
    x: number,
    y: number
  ): void {
    const svg = (element as { laTexSVG?: string }).laTexSVG
    const depth = svg ? DEPTH_BY_SVG.get(svg) : undefined
    if (!depth) {
      originalRender.call(this, ctx, element, x, y)
      return
    }
    // 绘制坐标是缩放后的，element.height 是缩放前的，depth 跟着前者走
    const scale = (this as unknown as { options?: { scale?: number } }).options?.scale ?? 1
    originalRender.call(this, ctx, element, x, y + depth * scale)
  }
```

depth 按 **SVG data URL 索引**（`DEPTH_BY_SVG`），因为 `render()` 拿得到 `element.laTexSVG`，
这是最可靠的对应键。

---

## 5. 怎么验证的

光看代码不算数，这套改动全部在**真实 Electron + Chromium** 里跑通才算数：

1. **绘制调用 hook** —— 包住 `CanvasRenderingContext2D.prototype.drawImage` / `fillText`，
   记录真实坐标，用数字证明「公式底边 = 文字基线」，再证明修正后「公式基线 = 文字基线」
2. **页面截图** —— `win.webContents.capturePage()` 直接看图，跟用户截图对比
3. **产物核对** —— 在 `dist/renderer/assets/*.js` 里确认用的是 `mt.convertLaTextToSVG`
   （即打了补丁的 ESM 分支，而不是没打补丁的 UMD）
4. `npm run typecheck` + `npm run build`

探针用 esbuild 打包，参数必须跟 Vite 一致（`mainFields: ['module', 'main']`），
见坑 3。

---

## 6. 已知边界与代价

| 项 | 说明 |
|---|---|
| 裸括号不拉伸 | `[\begin{matrix}...]` 是用户源码写法，按要求不动。`\begin{bmatrix}` / `\left[` 现在正常拉伸 |
| 带旧尺寸的元素会变形 | `element.width \|\|= width` 的规则，见坑 4。重新导入 Markdown 即正常 |
| 公式字号固定 | `convertLaTextToSVG` 只拿到 latex 字符串，拿不到元素 `size`。自带实现也是固定 `SCALE_X/Y`，行为一致 |
| 点击区域略高于视觉位置 | 只挪了绘制位置，没动元素坐标；命中测试/光标/悬浮预览仍走 canvas 原逻辑 |
| 依赖 patch 存在 | 补丁没应用时静默降级回自带渲染（打 warn 日志），标签页照常可用 |

---

## 7. 维护提醒

- **升级 `@hufe921/canvas-editor` 要重做 patch**：`postinstall` 会应用 `patches/`，
  应用失败时会报错，按提示处理（`mt` 这个压缩名可能变）
- **改了 `node_modules` 要重启 dev**：Vite 的依赖预打包缓存（`.vite/deps`）不会自动失效

# LaTeX 公式识别（Texo）接入：遇到的问题与解决

记录把本地 Texo 公式识别模型接进 Teyoo 的全过程：推理放哪、原生依赖怎么打包、
图片怎么预处理、以及几个看起来无关但会直接卡住的小坑（wasm 跨源隔离、SVG 单位、
灰度转三通道）。每个问题都给出**现象 → 根因 → 解法**。

- 相关代码：`src/main/texo-ocr.ts`（主进程推理）、`src/texo/view.ts`（渲染端标签页）、
  `src/preload/index.ts`（IPC 桥）
- 相关配置：`electron.vite.config.ts`、`electron-builder.yml`
- 模型文件：`resources/texo/`（2 个 ONNX + tokenizer/config，约 80MB）
- 依赖：`@huggingface/transformers@4.3.x`、`onnxruntime-node`、`@napi-rs/canvas`

---

## 1. 架构总览

```
渲染端「LaTeX公式」标签页（src/texo/view.ts）
  拖拽 / 粘贴 / 选择 / 示例图 → data URL
        │  IPC: texo-recognize（src/preload/index.ts）
        ▼
主进程 src/main/texo-ocr.ts
  懒加载 FormulaNet（transformers.js + onnxruntime-node）
  图片预处理（UniMERNet 规范）→ generate → tokenizer 解码
        │
        ▼  LaTeX 字符串
渲染端：编辑区实时渲染 KaTeX 预览 + 复制（latex / typst / mathml）
```

模型是 `vision-encoder-decoder`（`FormulaNet`）：视觉编码器是 UniMERNet 的 HGNetV2
（`encoder.model_type: my_hgnetv2`），解码器是 mBART 结构（`d_model: 384`、
`vocab_size: 687` 的 BPE tokenizer）。模型文件拆成 `encoder_model.onnx` +
`decoder_model_merged.onnx` 两份。

---

## 2. 踩过的坑

### 坑 1：推理放渲染端走不通 —— wasm 需要 SharedArrayBuffer / COI

**现象**：Texo 官方是 web 版，用 transformers.js 的 `onnxruntime-web` wasm 后端。
照搬到 Electron 渲染端，一加载就报错 / 拿不到 `SharedArrayBuffer`。

**根因**：threaded wasm 依赖 `SharedArrayBuffer`，它只有在 `crossOriginIsolated`
的页面里才有。Electron 的 `file://` 页面两者都没有（实测 `SharedArrayBuffer` 未定义）。

**解法**：把推理挪到**主进程**。主进程是 Node 环境，transformers.js 自动走
`onnxruntime-node` 原生后端，模型文件直接 `fs` 读，没有 wasm / pthread / COI 这一
整层问题。渲染端只经 IPC 传 data URL、收 LaTeX。

```1:7:src/main/texo-ocr.ts
// 主进程 LaTeX 公式识别 —— 本地 Texo 模型（onnxruntime-node 后端）
//
// 为什么放主进程而不是渲染端：Texo-web 用 transformers.js 的 onnxruntime-web
// wasm 后端，但那个 threaded wasm 需要 SharedArrayBuffer（crossOriginIsolated），
// 而 Electron 的 file:// 页面两者都没有（实测 SAB 未定义）。主进程是 Node 环境，
// transformers.js 自动走 onnxruntime-node 原生后端，模型文件直接 fs 读，没有
// wasm / pthread / COI 那一堆问题。渲染端只经 IPC 传 data URL、收 LaTeX。
```

---

### 坑 2：原生模块 + transformers.js 的打包与加载

**现象**：功能在 dev 下正常，打包后主进程直接崩 / 找不到 `.node`。

**根因**：三类东西不能交给 rollup 打进 bundle：

- `@napi-rs/canvas`、`onnxruntime-node` 是**原生模块**（`.node` 二进制），打包会
  破坏其二进制 `require` 路径；
- `@huggingface/transformers` 是 ESM 大包，且内部**按环境** `require('onnxruntime-node')`，
  必须保留原包让运行时自己解析。

**解法**（两处配合）：

1. `electron.vite.config.ts` 把这三样 `external`，运行时动态 `import` 原包：

```16:20:electron.vite.config.ts
        // @napi-rs/canvas、onnxruntime-node 是原生模块（.node 二进制），必须
        // 运行时从 node_modules 加载，交给 rollup 打包会破坏二进制 require 路径。
        // @huggingface/transformers 是 ESM 大包且内部按环境 require onnxruntime-node，
        // 一并 external（运行时动态 import 原包，见 texo-ocr.ts）。
        external: ['@napi-rs/canvas', '@huggingface/transformers', 'onnxruntime-node'],
```

2. `electron-builder.yml` 把这些原生依赖**从 asar 里 unpack**出来，并把模型文件当
   `extraResources` 拷贝到 `resources/`（asar 里不能 `dlopen` `.node`）：

```20:28:electron-builder.yml
  # (@napi-rs/canvas-win32-x64-msvc / -darwin-arm64 / -linux-x64-gnu …) that
  # @napi-rs/canvas loads internally. ~37 MB unpacked, mostly Skia.
  - 'node_modules/@napi-rs/**/*'
  # LaTeX公式（本地 Texo 模型）主进程推理：transformers.js 走 onnxruntime-node
  # 原生后端（electron.vite 里 external），运行时从 node_modules 加载。
  - 'node_modules/@huggingface/**/*'
  - 'node_modules/onnxruntime-node/**/*'
  - 'node_modules/onnxruntime-common/**/*'
  - 'node_modules/global-agent/**/*'
```

注意 `global-agent`：它是 transformers.js 的间接依赖（做环境代理检测），external
后也必须一并 unpack，否则打包后加载 transformers.js 会找不到它。

判断「还有没有别的包要在打包时放出来」的方法见 `docs/packaging.md`：看
`dist/main/index.js` 里除了 Node 内置模块和 `electron`，还有没有裸 `require('包名')`。

---

### 坑 3：模型文件路径要区分开发 / 打包

**现象**：打包后读不到模型。

**根因**：开发时模型在仓库 `resources/texo`，打包后 `extraResources` 把它拷到了
安装目录的 `resources/texo`（`process.resourcesPath`），两个位置完全不同。

**解法**：用 `app.isPackaged` 分支：

```21:23:src/main/texo-ocr.ts
function modelDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'texo') : join(__dirname, '../../resources/texo')
}
```

---

### 坑 4：UniMERNet 的图片预处理不是「缩放就完事」

**现象**：直接把图片缩放成 384×384 喂给模型，识别结果明显差、甚至乱码。

**根因**：视觉编码器是 UniMERNet 的 HGNetV2，训练时的预处理有固定规范，缺一步就
退化。代码里 `preprocessImage` 按顺序做了五件事：

```44:138:src/main/texo-ocr.ts
/** data URL → 灰度 → 反转 → 去边距 → 等比缩放 384×384 + 居中 → 归一化 */
async function preprocessImage(dataUrl: string): Promise<Float32Array> {
```

1. **原尺寸画到白底 canvas** —— 透明 PNG 先补白，否则 alpha 会当黑边处理；
2. **灰度**（`R*299 + G*587 + B*114) / 1000`）；
3. **黑底白字检测反转** —— 暗像素 ≥ 亮像素就整体 `255 - v` 反转成白底黑字
   （截图/深色主题里抠出来的公式常见黑底白字）；
4. **去边距** —— 阈值 200 找「墨迹」边界，把公式裁出来；
5. **等比缩放 384×384 + 居中 padding** —— padding 填 0（黑），不拉伸变形；
6. 最后按 UniMERNet 均值/标准差归一化：`(g/255 - 0.7931) / 0.1738`。

这些常量（`0.7931` / `0.1738`）是 UniMERNet 的 ImageNet 统计值，写死在
`UNIMERNET_MEAN` / `UNIMERNET_STD`，不能随便改。

---

### 坑 5：灰度图为什么要复制成三通道

**现象**：预处理出的是单通道灰度 `[1,1,384,384]`，但直接喂 `generate` 会因通道数
对不上报错。

**根因**：UniMERNet 训练输入是单通道灰度，但 HGNetV2 的 stem 第一层声明的是
**3 通道**输入（`config.json` 里 `stem_channels: [3, 32, 48]`）。模型文件按 3 通道
导出的，运行时就得给 3 通道。

**解法**：把灰度单通道 `cat` 复制成三通道再喂：

```144:147:src/main/texo-ocr.ts
  const { Tensor, cat } = await import('@huggingface/transformers')
  const tensor = new Tensor('float32', array, [1, 1, 384, 384])
  const pixelValues = cat([tensor, tensor, tensor], 1)
  const outputs = await model.generate({ inputs: pixelValues })
```

---

### 坑 6：示例图生成 —— MathJax 的 SVG 不被 resvg 接受

**现象**：想内置一张「示例图片」让用户一键走完整识别链。用 MathJax 渲染公式 →
SVG → `@napi-rs/canvas` 转 PNG，结果 `loadImage` 抛 `Error: Invalid SVG image`。

**根因**（两处叠加）：

1. MathJax 的 `LiteAdaptor.outerHTML()` 输出根元素是 `<mjx-container>`，`<svg>`
   **包在里面**，而 resvg 要求根节点就是 `<svg>`；
2. SVG 的 `width` / `height` 属性是 **ex 单位**（`width="2.282ex"`），resvg 不认
   相对字体单位。

**解法**：先提取纯 `<svg>…</svg>`，再按 `viewBox` 把 ex 换算成显式 px 宽高
（`height = width × viewBoxHeight / viewBoxWidth`），resvg 就能正常栅格化。

生成脚本是临时的一次性工具，产物 `src/texo/example-formula.png` 随源码提交，
`view.ts` 里以 `?inline` 导入成 data URL。示例用柯西积分公式，实测识别逐符号全对。

> 同类教训在 `docs/canvas-latex-rendering.md` 坑 6 也出现过：MathJax 的 ex 单位
> 不能靠解析属性字符串换算，那里用的是「塞进参与布局的宿主量真实 px」。

---

### 坑 7：复制为 Typst / MathML 需要单独的转换器

**现象**：参考界面有「复制为 Typst」「复制为 MathML」，但项目里只有 LaTeX 渲染，
没有这两个格式的导出。

**解法**：

- **Typst**：新增依赖 `tex2typst@0.6.x`，`tex2typst(latex)` 直接转（`\frac{a}{b}` →
  `a/b`，`\int_{-\infty}^{\infty}` → `integral_(-infinity)^infinity`）。它是纯 JS，
  直接打进渲染端 bundle 即可，不涉及原生模块。
- **MathML**：复用已有的 `katex@0.16.x`，`katex.renderToString(latex, { output: 'mathml', throwOnError: false })`。

---

### 坑 8：模型懒加载 + 失败要重置缓存

**现象**：第一次识别触发模型加载，之后复用；但如果加载失败，后续识别会一直失败。

**根因**：用 `loadedPromise` 缓存加载过程，失败时如果不清空，缓存的是个 rejected
Promise，之后再调 `load()` 直接复用失败结果。

**解法**：失败时置回 `null`，下次重来：

```25:42:src/main/texo-ocr.ts
let loadedPromise: Promise<Loaded> | null = null

async function load(): Promise<Loaded> {
  if (loadedPromise) return loadedPromise
  loadedPromise = (async () => {
    const { VisionEncoderDecoderModel, PreTrainedTokenizer, env } = await import('@huggingface/transformers')
    env.allowLocalModels = true
    const model = await VisionEncoderDecoderModel.from_pretrained(modelDir(), { dtype: 'fp32' })
    const tokenizer = await PreTrainedTokenizer.from_pretrained(modelDir())
    return { model, tokenizer }
  })()
  try {
    return await loadedPromise
  } catch (error) {
    loadedPromise = null
    throw error
  }
}
```

`env.allowLocalModels = true` 是必须的：默认 transformers.js 会尝试联网去
HuggingFace 拉模型，本地模型目录要显式放行。

---

## 3. 关键文件

| 文件 | 作用 |
|---|---|
| `src/main/texo-ocr.ts` | 主进程推理：模型懒加载、UniMERNet 预处理、generate + 解码 |
| `src/main/index.ts` | `texo-recognize` IPC handler（错误以 `{error}` 对象返回，不抛） |
| `src/preload/index.ts` | `recognizeTexoFormula(dataUrl)` 桥 + `onMenuTexoTab` 菜单事件 |
| `src/texo/view.ts` | 标签页 UI：拖拽/粘贴/选择/示例图 → 识别 → 预览 + 复制 |
| `src/texo/assets.d.ts` | `*.png?inline` 的 Vite 资产类型声明（tsconfig 未引 vite/client） |
| `resources/texo/` | 模型：`onnx/encoder_model.onnx`、`onnx/decoder_model_merged.onnx`、tokenizer、config |
| `electron.vite.config.ts` | `external` 原生模块与 transformers.js |
| `electron-builder.yml` | `asarUnpack` + `extraResources` 模型文件 |

---

## 4. 已知边界与代价

| 项 | 说明 |
|---|---|
| 首次识别慢 | 模型懒加载 + `fp32` 推理（未量化），第一次触发要等模型读入内存，之后复用同一实例 |
| 模型体积 | 2 个 ONNX 约 80MB，`extraResources` 随安装包分发，不进 asar |
| 原生依赖体积 | `@napi-rs/canvas`（Skia）unpack 约 37MB，为图片预处理而生 |
| 平台差异 | `.node` 二进制按平台选（`@napi-rs/canvas-{win32,darwin,linux}-…`），`@napi-rs/**/*` 全量 unpack 覆盖 |
| 单图单公式 | 一次识别一张图、返回一条 LaTeX；多公式/多行请分别上传 |
| 离线 | 模型完全本地，识别过程不联网（`env.allowLocalModels`），但 transformers.js 加载时若环境有代理会经 `global-agent` |

---

## 5. 维护提醒

- **升级 `@huggingface/transformers` 要重验打包**：它内部按环境 require
  `onnxruntime-node`，版本变化可能引入新的间接原生依赖，需重新走一遍
  `docs/packaging.md` 的「看 dist 里还有没有裸 require」检查。
- **模型文件不参与热更新**：改动 `resources/texo/` 后要重新 `dist:win/mac/linux`
  才生效（`extraResources` 只在打包时拷贝）。
- **预处理常量别动**：`UNIMERNET_MEAN/STD`、阈值 200、384 尺寸都对齐 UniMERNet
  训练规范，改了只会让识别变差。

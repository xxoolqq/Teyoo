// docx-import.ts — 将 .docx 文件转换为 Markdown（支持 ColaMD 扩展语法）
//
// 三阶段管线：
//   阶段 1 — OOXML 预处理
//     用 JSZip 解压 .docx，从 word/document.xml 中提取 ColaMD 扩展对应的
//     OOXML 元素（OMML 公式、EQ 域公式、MathType OLE 公式、ruby 拼音、
//     着重号、下划线、田字格、带圈序号），替换为占位符文本。
//     另有 zip 级媒体修复：WMF/EMF 图片（MathType 转图片型公式）经
//     wmf-emf-renderer（纯 JS）+ @napi-rs/canvas（Skia）栅格化为 PNG
//     回写，浏览器不渲染 WMF。
//     然后检测字体变化（整段换字体→fontBlock、段内部分换→fontSpan），
//     最后检测 2+ 连续居中段落注入 @#center / @ 子块标记。
//     mammoth 不识别这些元素/不保留对齐/不保留字体信息，必须在预处理阶段抢救。
//
//   阶段 2 — mammoth 转换
//     将修改后的 .docx 交给 mammoth.convertToMarkdown 处理标准格式
//     （标题、列表、表格、加粗/斜体/删除线、图片等）。占位符作为纯文本
//     原样通过 mammoth，不会被转义。
//
//   阶段 3 — 占位符回填
//     将 mammoth 输出中的占位符替换为 ColaMD 扩展语法：
//       公式   $…$ / $$…$$      （OMML 由 dwml-ts 转换；EQ 域由
//                                  eq-field/eq-to-latex 转换；MathType
//                                  OLE 由 mtef/oleToLatex 转换）
//       拼音   汉字(pinyin)     （w:ruby → ColaMD ruby 语法）
//       着重号 @.内容.@         （w:em w:val="dot" → ColaMD emphDot 语法）
//
// 对应 docx-export.ts 的逆向映射（完整可逆）。

// 【浏览器可运行】本模块同时被两处使用：桌面版主进程（Node）与 WebView2
// 任务窗格页（浏览器）。因此不得出现 fs / process.env / Buffer 等 Node 专属
// 设施：文件读取由调用方完成，这里只吃字节。
import JSZip from 'jszip'
// mammoth 的 .d.ts 用 export = 语法，ambient 接口不在 namespace 中，
// 无法用 mammoth.Input 引用类型。直接 import 值并用内联类型。
import mammoth from 'mammoth'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { parseMetafile, renderToContext } from 'wmf-emf-renderer'
import { ommlToLatex } from 'dwml-ts'
import { eqToLatex } from './eq-field/eq-to-latex'
import { oleToLatex } from './mtef'

// Cambria Math（Word 原生公式字体）藏在 Windows 的 TTC 集合文件里，
// @napi-rs/canvas 的系统扫描不含 TTC → 手动注册一次供 WMF 渲染使用。
// 失败静默：下方字体回退链自动降级（Times New Roman / Segoe UI Symbol）。
// 浏览器里没有 process（也没有本地字体注册能力），跳过即可：那边由 canvas
// 替身的 GlobalFonts 用 document.fonts.check 探测本机字体。
if (typeof process !== 'undefined' && process.platform === 'win32') {
  try {
    GlobalFonts.registerFromPath('C:/Windows/Fonts/cambria.ttc')
  } catch {
    /* 字体缺失/注册失败不阻断导入 */
  }
}

// mammoth convertToMarkdown 在运行时存在但 .d.ts 未声明
interface MammothMessage {
  type: string
  message: string
}
// 两个 key 都给：Node 版 unzip 认 `buffer`，浏览器版 unzip 只认 `arrayBuffer`
// （各自最终都交给 JSZip.loadAsync，Uint8Array / ArrayBuffer 都能吃）。
const mammothAny = mammoth as unknown as {
  convertToMarkdown: (
    input: { path: string } | { buffer: Uint8Array; arrayBuffer: Uint8Array },
    options?: {
      convertImage?: unknown
      styleMap?: string | string[]
      ignoreEmptyParagraphs?: boolean
    },
  ) => Promise<{ value: string; messages: MammothMessage[] }>
  images: {
    dataUri: unknown
  }
}

export interface DocxImportResult {
  markdown: string
  warnings: string[]
}

export interface DocxImportOptions {
  /** 行内公式图片 OCR：true 时把行内图片提交识别，用返回的 LaTeX 替换图片 */
  imageFormulaOcr?: boolean
  /** 公式 OCR 地址（SimpleTex 契约）；缺省走环境变量 COLAMD_OCR_URL 或默认本地端点 */
  formulaOcrUrl?: string
  /**
   * 本地识别器（图片 data URL → LaTeX）：提供时取代 formulaOcrUrl 的 HTTP 端点，
   * 即「使用内置大模型」。Electron 主进程注入 Texo 模型；WebView2 宿主没有该模型、
   * 也不该把 onnxruntime 打进它的 bundle，所以那边留空继续走 HTTP。
   */
  recognizeFormula?: (dataUrl: string) => Promise<string | null>
}

// ─── 占位符 ────────────────────────────────────────────────────────────
//
// 使用 U+27E6/U+27E7（数学白方括号 ⟦⟧）作为定界符，绝不会出现在正常文档
// 文本中，且不是 Markdown 特殊字符，mammoth 不会转义。
const PH_L = '\u27E6' // ⟦
const PH_R = '\u27E7' // ⟧

// 占位符类型标识
const T_FI = 'FI' // Formula Inline  $…$
const T_FB = 'FB' // Formula Block    $$…$$
const T_RU = 'RU' // Ruby pinyin      汉字(pi)
const T_EM = 'EM' // Emphasis mark    @.text.@
const T_TZ = 'TZ' // Tianzi grid cell（田字格单格，阶段 3 按连续序列重组）
const T_CS = 'CS' // Circled Superscript ^{n}（带圈序号上标）
const T_SUP = 'SUP' // Superscript  ^{x}（通用上标，化学式等）
const T_SUB = 'SUB' // Subscript    _{x}（通用下标）
const T_TBL = 'TBL' // Table（GFM 管道表格，阶段 3 回填多行文本）
const T_FS = 'FS' // Font Span {= family=… : text}（行内字体覆盖）
const T_FBS = 'FBS' // Font Block Start :::font{…}
const T_FBE = 'FBE' // Font Block End :::
const T_SBS = 'SBS' // SubBlock Start @#center / @#left / @#right / @box…
const T_SBE = 'SBE' // SubBlock End   @

interface Extracted {
  type: string
  replacement: string
  // 田字格专用：单格内容（char=格中字 / pinyin=格上方拼音，均空=空白格）
  cell?: { char?: string; pinyin?: string }
}

/**
 * 将 .docx 的字节转换为 Markdown 字符串。
 *
 * 入参是字节而不是路径：浏览器里没有 fs，读文件的活儿交给调用方
 * （桌面版在主进程里 readFile，WebView2 在页面里 fetch / 收 postMessage），
 * 这样本模块两侧通用。
 *
 * @param docx      .docx 文件字节（Uint8Array / ArrayBuffer 均可）
 * @returns         转换后的 Markdown（含 ColaMD 扩展语法）+ warnings
 * @throws          文件无法解析时抛出 Error
 */
export async function docxToMarkdown(
  docx: Uint8Array | ArrayBuffer,
  options?: DocxImportOptions,
): Promise<DocxImportResult> {
  // ── 阶段 1：OOXML 预处理 ───────────────────────────────────────────
  const fileBuffer = docx instanceof Uint8Array ? docx : new Uint8Array(docx)
  const zip = await JSZip.loadAsync(fileBuffer)
  const docFile = zip.file('word/document.xml')
  if (!docFile) {
    throw new Error('docx-import: 文件中未找到 word/document.xml')
  }

  const docXml = await docFile.async('string')
  const extracted: Extracted[] = []
  const warnings: string[] = []

  // WMF/EMF 图片 → PNG（MathType 转图片型公式等）：zip 级字节替换
  // （media / rels / [Content_Types]）+ document.xml alt 注入显示尺寸，
  // 必须在交给 mammoth 前完成
  const wmfPatchedXml = await convertWmfEmfImages(zip, docXml, warnings)

  // 按顺序提取 ColaMD 扩展元素（顺序重要：oMathPara 先于 oMath）
  let processedXml = wmfPatchedXml
  processedXml = extractOmmlBlock(processedXml, extracted, warnings)
  processedXml = extractOmmlInline(processedXml, extracted, warnings)
  // MathType / 公式编辑器 OLE 公式（word/embeddings/oleObject*.bin）：
  // 在 EQ 域之前（同为公式提取，互不干扰）、run 级提取器之前（对象连同
  // fallback 图片整体消失，不参与后续 vertAlign 等扫描）。唯一需要异步
  // 加载 zip 内 OLE 字节的提取器，rels 先行解析 rId → 文件路径
  const relsFile = zip.file('word/_rels/document.xml.rels')
  const relsXml = relsFile ? await relsFile.async('string') : ''
  processedXml = await extractMathTypeObjects(
    processedXml, zip, relsXml, extracted, warnings,
  )
  // EQ 域公式（老版 Word 公式，域代码存于 w:instrText / w:fldSimple）：
  // 在所有 run 级提取器之前——整个域 span（begin…end，含缓存结果 run）
  // 一次性替换为公式占位符，域内缓存文本不进入后续提取
  processedXml = extractEqFields(processedXml, extracted, warnings)
  processedXml = extractTianziGrid(processedXml, extracted)
  processedXml = extractCircledSup(processedXml, extracted)
  processedXml = extractRuby(processedXml, extracted)
  // 下划线（w:u）：在着重号之前——只改写 w:t 文本、保留整段 run，
  // 着重号 run 再提取时 extractAllText 会解出 <u>…</u>，输出 @.<u>…</u>.@
  // （同一 run 同时有下划线与着重号时两者都保留）
  processedXml = extractUnderline(processedXml)
  processedXml = extractEmphasis(processedXml, extracted)
  // 通用上下标（vertAlign run）：在 circledSup 之后（带圈序号优先消费上标
  // run）、ruby/emphasis 之后（避免误提取这些容器内的 run）
  processedXml = extractVertAlign(processedXml, extracted)
  // 表格自解析（w:tbl → GFM 管道表格）：在行内扩展提取之后——单元格文本
  // 中的公式/带圈序号/上下标等占位符随表格一起提取，由多轮回填还原
  processedXml = extractTables(processedXml, extracted, warnings)
  // 子块居中标记注入（先执行：标记段落无字体信息，天然打断 fontBlock 序列，
  // 确保 fontBlock 不跨越 subBlock 边界，避免嵌套重叠）。
  // 标记文本经占位符回填（阶段 3）：mammoth 会无条件转义 # 等字符
  // （@#center → @\#center），直接写字面标记会导致 ColaMD 词法层无法识别。
  processedXml = injectSubBlockMarkers(processedXml, extracted)
  // 字体解析（fontBlock 整段换字体 + fontSpan 段内部分换字体）
  // 在子块标记注入之后执行：subBlock 标记段落（@#center/@）无 w:rFonts，
  // dominantFont=null，天然打断连续同字体序列
  processedXml = injectFontMarkers(processedXml, extracted)

  // 将修改后的 XML 写回 zip，生成新的 .docx buffer
  zip.file('word/document.xml', processedXml)
  const modifiedBuffer = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
  })

  // ── 阶段 2：mammoth 转换标准格式 ──────────────────────────────────
  const mammothResult = await mammothAny.convertToMarkdown(
    { buffer: modifiedBuffer, arrayBuffer: modifiedBuffer },
    { convertImage: mammothAny.images.dataUri },
  )

  // ── 阶段 3：占位符 → ColaMD 扩展语法 ──────────────────────────────
  let markdown = mammothResult.value
  // 3-0) mammoth strong 语法归一：mammoth 的 markdown writer 用 __ 包裹
  // 加粗（node_modules/mammoth/lib/writers/markdown-writer.js），有两类问题：
  //   a) 加粗内容首尾带空格（典型：Word 中加粗的前导空格 run，如「  2017」
  //      整体加粗）→「__  2017__」开启侧紧跟空格，不满足 CommonMark 左侧翼
  //      规则，无法解析为加粗；
  //   b) 「__2017__年」——下划线有词内限制（intraword emphasis 禁止），
  //      关闭侧后跟 CJK 字符时无法闭合 → 字面 __ 残留。
  // 统一转换为 **…**（无词内限制，亦是 ColaMD stringify 的标准形式），
  // 同时把 span 首尾空格移到标记外；纯空格加粗（不可见格式）丢弃标记。
  markdown = normalizeMammothStrong(markdown)
  // 3a) 田字格：先按连续占位符序列重组为 ++…++ 语法单元
  markdown = rebuildTianziSequences(markdown, extracted)
  // 表格单元格中的田字格占位符藏在 ⟦TBL:n⟧ 的回填文本里，正文扫描看不到，
  // 同步对表格回填文本做序列重组
  for (const item of extracted) {
    if (item.type === T_TBL) {
      item.replacement = rebuildTianziSequences(item.replacement, extracted)
    }
  }
  // 3b) 占位符逐一回填（多轮：表格 ⟦TBL:n⟧ 等容器占位符的回填文本内部
  // 还嵌着行内占位符（单元格中的上下标/带圈序号等），需再次回填；
  // 正常文档 1–2 轮完成，轮数上限防御病态嵌套）
  for (let round = 0; round <= extracted.length; round++) {
    for (let i = 0; i < extracted.length; i++) {
      const placeholder = `${PH_L}${extracted[i].type}:${i}${PH_R}`
      markdown = markdown.split(placeholder).join(extracted[i].replacement)
    }
    if (!markdown.includes(PH_L)) break
  }

  // 行内公式图片 OCR（偏好 markdown.imageFormula === 'ocr'）：
  // 行内位置的图片提交识别接口，替换为 $latex$；独占一行的图片保留。
  // 识别失败（服务不可达/超时/返回异常）时静默退回保留图片方案，不产生 warning
  if (options?.imageFormulaOcr) {
    const url = resolveOcrUrl(options.formulaOcrUrl)
    const local = options.recognizeFormula
    markdown = await ocrInlineFormulaImages(
      markdown,
      local
        ? (item) => {
            const dataUrl = `data:image/${item.ext};base64,${item.b64}`
            return Promise.resolve().then(() => local(dataUrl)).catch(() => null)
          }
        : (item) => recognizeFormulaImage(item, url),
      local ? '内置大模型' : `OCR 服务 ${url}`,
      // 内置模型是单个 ONNX 会话，并发只会抢内存不加速，串行跑
      local ? 1 : OCR_CONCURRENCY,
    )
  }

  // 合并 mammoth 告警和预处理告警
  const mammothWarnings = mammothResult.messages
    .filter((m: MammothMessage) => m.type === 'warning')
    .map((m: MammothMessage) => m.message)

  return {
    markdown,
    warnings: [...warnings, ...mammothWarnings],
  }
}

// ─── WMF/EMF 图片转 PNG（wmf-emf-renderer + @napi-rs/canvas/Skia）──────
//
// MathType 公式「转为图片」的文档（OLE 数据被剥离，公式仅剩 WMF/EMF 图片）
// 由 mammoth 原样输出为 data:image/x-wmf 数据 URI——浏览器无法渲染 WMF
// （mammoth 自身亦有 "unlikely to display" warning）→ 编辑器中全部裂图。
//
// 修复：wmf-emf-renderer（github.com/congduan/WmfEmfViewer 的引擎，MIT，
// 零依赖纯 JS）把 WMF/EMF/EMF+ 记录流绘制到 Canvas 2D 上下文，
// @napi-rs/canvas（Skia，N-API 预编译，Electron 免重编译）提供栅格化。
// 渲染后回写 zip：
//   - word/media/imageN.wmf → word/media/imageN.png（字节替换）
//   - word/_rels/document.xml.rels：Target="media/imageN.wmf" → .png
//   - [Content_Types].xml：补 <Default Extension="png" …/>（缺才加）
//
// 渲染尺寸 = Word 显示尺寸（px @96dpi，非 WMF 内在尺寸）：MathType 导出
// 的 WMF 内在尺寸是整页画布（如 1376×896），Word 靠 drawing/shape 的显示
// 尺寸缩小展示，编辑器按图片内在尺寸展示 → 必须按显示尺寸栅格化才与
// Word 外观一致。显示尺寸从 document.xml 提取（三种引用形态）：
//   DrawingML：<wp:extent cx cy>（EMU）… <a:blip r:embed="rIdX">
//   VML：<v:shape style="width:72pt;height:18pt">… <v:imagedata r:id=…>
//   OLE 对象：<w:object w:dxaOrig/dyaOrig（twips）>… 首个 r:id = imagedata
// 引用无显示尺寸（罕见）→ 按 WMF 内在尺寸渲染。
//
// 字体三层修正（ctxWithFontFallback 的 Proxy 拦截 font 赋值 + fillText 调用）：
//  ① 字体族回退：Windows 的 Symbol 字体是 F0xx 符号编码（无 Unicode cmap），
//    Skia fillText 按 Unicode 码点查不到字形 → 豆腐块。库（wmf-emf-renderer）
//    已把 Symbol 字节映射为 Unicode（α、=、∈ 等），拦截 ctx.font 赋值把
//    Symbol 族替换为 Cambria Math（Word 原生公式字体，顶部注册 TTC）。
//    但 WMF 里 TNR 直书 run 的数学运算符区字符不经此路径，需 ② 补充。
//  ② 数学符号字符路由：fillText 拦截层检测数学区字符（箭头/算符/⟨⟩），
//    该条 run 整体换 Cambria Math 渲染（缺位时降级 Segoe UI Symbol）。
//  ③ MathType 编码遗留修正：Symbol 字体的 π 写作 0xF0（PUA 区），库的
//    symbolMap 恰缺 240 条目，0xF0 漏成拉丁 ð——fillText 拦截层改回 π。
//
// 高清出图：WMF/EMF 是矢量，小图按倍率超采样渲染（显示尺寸 ×4/×2），
// 并把显示尺寸注入 document.xml 的图片 alt（cherry 语法「描述#宽px#高px」，
// DrawingML 写 wp:docPr/@descr、VML 写 v:imagedata/@o:title——mammoth 的
// alt 来源）。编辑器按 alt 尺寸 CSS 缩放位图 → 高分屏不糊；docx 导出
// （imagePixelSize）读同一参数 → 尺寸往返一致。
//
// 单张转换失败：保留原样 + warning（沿用 mammoth 既有行为，不中断导入）。

/** createCanvas 的产物（Node 的 @napi-rs/canvas 或浏览器的 canvas-shim）。
 *  只用到三件事：宽高、2d 上下文、导出 PNG。 */
type CanvasSurface = {
  width: number
  height: number
  getContext(id: '2d'): unknown
}

/**
 * 画布导出 PNG 字节。
 * Node 侧 toBuffer('image/png') 是同步的，浏览器只能异步拿 blob —— 统一成 await。
 */
async function canvasToPngBytes(canvas: CanvasSurface): Promise<Uint8Array> {
  const surface = canvas as unknown as {
    toBuffer?: (format: string) => Uint8Array
    toPngBytes?: () => Promise<Uint8Array>
  }
  if (typeof surface.toBuffer === 'function') return surface.toBuffer('image/png')
  if (typeof surface.toPngBytes === 'function') return await surface.toPngBytes()
  throw new Error('画布实现不支持导出 PNG')
}

/** 数学符号渲染链：优先 Cambria Math（Word 原生公式字体，衬线数学风格，
 *  顶部注册 TTC 后可用）→ Segoe UI Symbol（Windows 自带全量数学符号）→
 *  空串（无可用数学字体，不换族）。承担两个角色：
 *  ① Symbol 等豆腐字体（无 Unicode cmap）的回退族——希腊字母与基础
 *    符号（α β = + 等）Cambria Math 全覆盖，公式符号风格统一；
 *  ② TNR 缺字形的数学区字符（U+2190-22FF 等，如 ∈ U+2208）的专用渲染族。 */
const MATH_GLYPH_FONT = GlobalFonts.has('Cambria Math')
  ? 'Cambria Math'
  : GlobalFonts.has('Segoe UI Symbol')
    ? 'Segoe UI Symbol'
    : ''

/** 字体族回退表：Skia 渲染不出字形（无 Unicode cmap）的 GDI 字体 → 替代族；
 *  数学字体缺位时降级 Times New Roman（基础希腊字母仍可渲染） */
const TOFU_FONT_FALLBACKS: Record<string, string> = MATH_GLYPH_FONT
  ? { symbol: MATH_GLYPH_FONT }
  : { symbol: 'Times New Roman' }

/** 数学符号字符区：箭头 (U+2190-21FF)、数学算符 (U+2200-22FF)、⟨⟩ (U+27E8/27E9) */
const RE_MATH_GLYPH = /[\u2190-\u21FF\u2200-\u22FF\u27E8\u27E9]/

/** font 字符串拆分正则："style weight Npx family"（family 可含空格/引号） */
const FONT_SPEC_RE = /^(.*?\b\d+(?:\.\d+)?px)\s+(.+)$/

/** 只替换 font 字符串的 family 段，style/weight/size 原样保留 */
function withFontFamily(font: string, family: string): string {
  const m = FONT_SPEC_RE.exec(font)
  return m ? `${m[1]} "${family}"` : font
}

/** MathType Symbol 编码遗留修正：Symbol 字体的 π 写作 0xF0（PUA 区），
 *  wmf-emf-renderer 的 symbolMap 恰缺 240 这一条（161-254 全有，唯 240 空），
 *  0xF0 原样漏成拉丁 ð (U+00F0)。公式图场景不存在真实 ð，直接改回 π。 */
function fixSymbolText(text: string): string {
  return text.replace(/\u00F0/g, '\u03C0')
}

/** 拦截 ctx.font 赋值做字体族回退；库构造的 font 形如
 *  "italic normal 14px Symbol"（"${style} ${weight} ${size}px ${family}"） */
function substituteTofuFont(font: string): string {
  const m = FONT_SPEC_RE.exec(font)
  if (!m) return font
  const family = m[2].trim().replace(/^['"]|['"]$/g, '')
  const fallback = TOFU_FONT_FALLBACKS[family.toLowerCase()]
  return fallback ? `${m[1]} "${fallback}"` : font
}

/** 包装 Canvas 2D 上下文：font 赋值经字体族回退，fillText 做文本修正 +
 *  数学符号字符路由（数学区字符的 run 整条换 MATH_GLYPH_FONT 渲染，
 *  其余属性/方法透传——wmf-emf-renderer 只依赖标准 Canvas 2D 接口，
 *  Proxy 不改变其行为） */
function ctxWithFontFallback<T extends { font: string }>(ctx: T): T {
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'fillText') {
        const raw = Reflect.get(target, prop, target) as (...args: unknown[]) => unknown
        return (...args: unknown[]) => {
          const text = fixSymbolText(String(args[0]))
          args[0] = text
          if (MATH_GLYPH_FONT && RE_MATH_GLYPH.test(text)) {
            const saved = target.font
            target.font = withFontFamily(saved, MATH_GLYPH_FONT)
            try {
              raw.apply(target, args)
            } finally {
              target.font = saved
            }
          } else {
            raw.apply(target, args)
          }
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, prop, value) {
      const final =
        prop === 'font' && typeof value === 'string' ? substituteTofuFont(value) : value
      return Reflect.set(target, prop, final, target)
    },
  })
}

/** WMF/EMF 内在尺寸（px @96dpi）：显示尺寸缺失时的回退渲染尺寸。
 *  placeable 头的逻辑范围按其 ticks/英寸折算；EMF bounds 为设备像素 */
function intrinsicMetafileSize(data: Uint8Array): { w: number; h: number } {
  const { header } = parseMetafile(data)
  const ph = header?.placeableHeader
  if (ph) {
    const inch = ph.inch || 1000
    const w = Math.round((Math.abs(ph.right - ph.left) / inch) * 96)
    const h = Math.round((Math.abs(ph.bottom - ph.top) / inch) * 96)
    if (w > 0 && h > 0) return { w, h }
  }
  const bounds = header?.bounds
  if (bounds) {
    const w = Math.round(bounds.right - bounds.left)
    const h = Math.round(bounds.bottom - bounds.top)
    if (w > 0 && h > 0) return { w, h }
  }
  return { w: 800, h: 600 }
}
/** 转换 word/media 下的 WMF/EMF 为 PNG（zip 字节替换），并给 document.xml
 *  的图片引用注入 alt 显示尺寸参数（编辑器/导出按此尺寸展示），返回修补后
 *  的 document.xml */
async function convertWmfEmfImages(
  zip: JSZip,
  docXml: string,
  warnings: string[],
): Promise<string> {
  // 收集 word/media 下的 WMF/EMF 图片（rels Target 为 zip 路径去掉 word/ 前缀）
  interface WmfItem { zipPath: string; relTarget: string; ext: 'wmf' | 'emf' }
  const items: WmfItem[] = []
  zip.forEach((path, entry) => {
    if (entry.dir) return
    const m = /^(word\/media\/.+)\.(wmf|emf)$/i.exec(path)
    if (!m) return
    items.push({
      zipPath: path,
      relTarget: path.slice('word/'.length),
      ext: m[2].toLowerCase() as 'wmf' | 'emf',
    })
  })
  if (items.length === 0) return docXml

  // ── rId → Word 显示尺寸（px @96dpi），同一图片多次引用取首个 ──
  const sizeByRid = new Map<string, { w: number; h: number }>()

  // DrawingML：每个 w:drawing 内 extent（EMU，1/914400 英寸）+ blip embed
  for (const d of docXml.match(/<w:drawing\b[\s\S]*?<\/w:drawing>/g) ?? []) {
    const ex = /<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(d)
    const blip = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(d)
    if (!ex || !blip) continue
    const w = Math.round((Number(ex[1]) / 914400) * 96)
    const h = Math.round((Number(ex[2]) / 914400) * 96)
    if (w > 0 && h > 0 && !sizeByRid.has(blip[1])) sizeByRid.set(blip[1], { w, h })
  }

  // VML：v:shape 的 style（width/height，单位 pt/in/cm/mm/px）+ imagedata r:id
  const stylePx = (v: string, unit: string): number => {
    const n = parseFloat(v)
    switch (unit) {
      case 'pt': return Math.round((n * 96) / 72)
      case 'in': return Math.round(n * 96)
      case 'cm': return Math.round((n * 96) / 2.54)
      case 'mm': return Math.round((n * 96) / 25.4)
      default: return Math.round(n) // px / 无单位
    }
  }
  for (const m of docXml.matchAll(
    /<v:shape\b[^>]*\bstyle="([^"]*)"[^>]*>[\s\S]{0,400}?<v:imagedata\b[^>]*\br:id="([^"]+)"/g,
  )) {
    const sw = /(?:^|;)\s*width\s*:\s*([\d.]+)\s*(pt|in|cm|mm|px)?/i.exec(m[1])
    const sh = /(?:^|;)\s*height\s*:\s*([\d.]+)\s*(pt|in|cm|mm|px)?/i.exec(m[1])
    if (!sw || !sh) continue
    const w = stylePx(sw[1], (sw[2] ?? 'px').toLowerCase())
    const h = stylePx(sh[1], (sh[2] ?? 'px').toLowerCase())
    if (w > 0 && h > 0 && !sizeByRid.has(m[2])) sizeByRid.set(m[2], { w, h })
  }

  // OLE 对象：w:object 的 dxaOrig/dyaOrig（twips，1/1440 英寸）+ 首个 r:id
  // （对象内 imagedata 的 r:id 位于 o:OLEObject 的 r:id 之前）
  for (const m of docXml.matchAll(
    /<w:object\b([^>]*)>[\s\S]{0,600}?\br:id="([^"]+)"/g,
  )) {
    const dx = /\bw:dxaOrig="(\d+)"/.exec(m[1])
    const dy = /\bw:dyaOrig="(\d+)"/.exec(m[1])
    if (!dx || !dy) continue
    const w = Math.round((Number(dx[1]) / 1440) * 96)
    const h = Math.round((Number(dy[1]) / 1440) * 96)
    if (w > 0 && h > 0 && !sizeByRid.has(m[2])) sizeByRid.set(m[2], { w, h })
  }

  // ── rels：Target → rId（配合 sizeByRid 得到每张图的显示尺寸）──
  const relsFile = zip.file('word/_rels/document.xml.rels')
  const relsXml = relsFile ? await relsFile.async('string') : ''
  const ridByTarget = new Map<string, string>()
  const relPattern = /<Relationship\b[^>]*>/g
  let relM: RegExpExecArray | null
  while ((relM = relPattern.exec(relsXml)) !== null) {
    const id = /\bId\s*=\s*["']([^"']+)["']/.exec(relM[0])?.[1]
    const target = /\bTarget\s*=\s*["']([^"']+)["']/.exec(relM[0])?.[1]
    if (id && target && !ridByTarget.has(target)) ridByTarget.set(target, id)
  }

  // ── 逐张栅格化：wmf-emf-renderer 解析绘制，@napi-rs/canvas 出 PNG ──
  // 超采样：小图放大出图（矢量无损），显示尺寸由 alt 参数控制，高分屏
  // 缩小显示仍清晰；大图原尺寸避免 PNG 字节膨胀。
  // 单张失败保留原样（warning），不影响其余
  const pngs: { item: WmfItem; bytes: Uint8Array }[] = []
  const displayByRid = new Map<string, { w: number; h: number }>()
  let failed = 0
  let lastError: Error | null = null
  for (const it of items) {
    try {
      const bytes = await zip.file(it.zipPath)!.async('uint8array')
      const rid = ridByTarget.get(it.relTarget)
      const size = (rid ? sizeByRid.get(rid) : undefined) ?? intrinsicMetafileSize(bytes)
      const scale = size.h <= 128 ? 4 : size.h <= 320 ? 2 : 1
      const canvas = createCanvas(size.w * scale, size.h * scale)
      renderToContext(bytes, ctxWithFontFallback(canvas.getContext('2d') as { font: string }), {
        viewWidth: size.w * scale,
        viewHeight: size.h * scale,
      })
      if (rid) {
        displayByRid.set(rid, {
          w: Math.round(canvas.width / scale),
          h: Math.round(canvas.height / scale),
        })
      }
      pngs.push({ item: it, bytes: await canvasToPngBytes(canvas) })
    } catch (e) {
      failed++
      lastError = e as Error
    }
  }

  // 回写 zip：字节替换 + rels 改指 .png + [Content_Types] 补 png 类型
  if (pngs.length > 0) {
    let newRelsXml = relsXml
    const ctFile = zip.file('[Content_Types].xml')
    let ctXml = ctFile ? await ctFile.async('string') : ''
    for (const { item: it, bytes: pngBytes } of pngs) {
      let pngTarget = it.relTarget.replace(/\.(wmf|emf)$/i, '.png')
      // zip 内已有同名 png（病态文档）：换名防覆盖
      if (pngTarget !== it.relTarget && zip.file(`word/${pngTarget}`)) {
        pngTarget = pngTarget.replace(/\.png$/i, '__wmf.png')
      }
      newRelsXml = newRelsXml.split(`"${it.relTarget}"`).join(`"${pngTarget}"`)
      zip.file(`word/${pngTarget}`, pngBytes)
      zip.remove(it.zipPath)
    }
    if (relsFile) zip.file('word/_rels/document.xml.rels', newRelsXml)
    if (ctFile && !/Extension="png"/i.test(ctXml)) {
      ctXml = ctXml.replace(
        '</Types>',
        '<Default Extension="png" ContentType="image/png"/></Types>',
      )
      zip.file('[Content_Types].xml', ctXml)
    }
  }
  if (failed > 0) {
    warnings.push(
      `${failed} 张 WMF/EMF 图片转换失败${lastError ? `（${lastError.message}）` : ''}，已保留原样`,
    )
  }

  // ── document.xml alt 注入显示尺寸（cherry 语法「描述#宽px#高px」）──
  // mammoth 的 alt 来源：DrawingML 取 wp:docPr/@descr（缺省退 @title），
  // VML 取 v:imagedata/@o:title。只动 wp:docPr 标签本身（pic:cNvPr 也有
  // descr 属性但 mammoth 不读，须精确限定避免误注）。
  let patchedXml = docXml
  if (displayByRid.size > 0) {
    const suffixOf = (d: { w: number; h: number }) => `#${d.w}px#${d.h}px`
    patchedXml = patchedXml.replace(
      /<w:drawing\b[\s\S]*?<\/w:drawing>/g,
      (block) => {
        const rid = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(block)?.[1]
        const disp = rid ? displayByRid.get(rid) : undefined
        const docPr = /<wp:docPr\b[^>]*?\/?>/.exec(block)
        if (!disp || !docPr) return block
        let tag = docPr[0]
        tag = /\bdescr="[^"]*"/.test(tag)
          ? tag.replace(/(\bdescr=")([^"]*)(")/, (_t, l, v, r) => `${l}${v}${suffixOf(disp)}${r}`)
          : tag.replace(/\s*\/?>$/, ` descr="图片${suffixOf(disp)}"$&`)
        return block.replace(docPr[0], () => tag)
      },
    )
    patchedXml = patchedXml.replace(/<v:imagedata\b[^>]*>/g, (tag) => {
      const rid = /\br:id="([^"]+)"/.exec(tag)?.[1]
      const disp = rid ? displayByRid.get(rid) : undefined
      if (!disp) return tag
      return /\bo:title="[^"]*"/.test(tag)
        ? tag.replace(/(\bo:title=")([^"]*)(")/, (_t, l, v, r) => `${l}${v}${suffixOf(disp)}${r}`)
        : tag.replace(/\s*\/?>$/, ` o:title="图片${suffixOf(disp)}"$&`)
    })
  }
  return patchedXml
}

// ─── OMML→LaTeX 后处理：还原 mhchem 的「隐形占位基座」 ──────────────────
//
// 化学式（\ce）插入 Word 走的是 TeX → MathML → OMML：mhchem 对没有基座的
// 上下标（SO4^2- 里的 4 与 2-）生成的是
//   <mpadded width="0"><mphantom><mi>A</mi></mphantom></mpadded>
// ——借一个零宽、不可见的字母占住基座（MathJax 用 A，KaTeX 用 X、width="0px"）。
// Word 里看不见，但 MML2OMML.XSL 把它变成
// <m:phant><m:zeroWid/>…<m:phant><m:show val=0/><m:t>A</m:t>…，dwml-ts 再翻回来
// 就得到带 \phantom{A} 的 LaTeX。实测往返：
//   MathJax: SO\phantom{A}_{4}\phantom{A}^{2-}+Ba\phantom{A}^{2+}⟶BaSO\phantom{A}_{4}\downarrow
//   KaTeX  : SO\phantom{X}_{4}\phantom{X}^{2-}+Ba\phantom{X}^{2+}\rightarrow BaSO\phantom{X}_{4}\downarrow
// 编辑器里 \phantom{A} 会占满一个 A 的宽度，SO₄²⁻ 被拆成「SO 4 2-」。
// 空基座在 LaTeX 里的规范写法就是空组，故统一还原成 {}（`SO{}_{4}{}^{2-}`
// 与 mhchem 原意一致；独立出现的 \phantom{A} 本来就什么都不显示，也在其内）。
// 只认 A / X 这两个占位字母，用户自己写的 \phantom{xy} 不受影响。
function restoreInvisiblePhantomBase(latex: string): string {
  return latex.replace(/\\phantom\s*\{\s*[AX]\s*\}/g, '{}')
}

// ─── OMML 块级公式提取（m:oMathPara） ──────────────────────────────────
//
// ColaMD 导出：块级公式 → <m:oMathPara><m:oMath>…</m:oMath></m:oMathPara>
// mammoth 对 m:oMathPara 无处理逻辑 → 整个公式（含文字）被丢弃。
// 预处理阶段用 dwml-ts 的 ommlToLatex 转为 LaTeX，替换为占位符。
function extractOmmlBlock(
  xml: string,
  extracted: Extracted[],
  warnings: string[],
): string {
  // 匹配完整的 <m:oMathPara …>…</m:oMathPara>（含命名空间属性）
  const pattern = /<m:oMathPara\b[^>]*>([\s\S]*?)<\/m:oMathPara>/g
  return xml.replace(pattern, (fullMatch) => {
    try {
      const latex = restoreInvisiblePhantomBase(
        ommlToLatex(fullMatch, {
          onUnsupported: (name) =>
            warnings.push(`OMML 元素 ${name} 不支持，已降级为文本`),
        }),
      )
      const idx = extracted.length
      // 块级公式独占一行 → $$ … $$
      extracted.push({ type: T_FB, replacement: `$$${latex}$$` })
      return placeholderRun(T_FB, idx)
    } catch (e) {
      warnings.push(`公式转换失败（块级）: ${(e as Error).message}`)
      return fullMatch // 转换失败保留原文
    }
  })
}

// ─── OMML 行内公式提取（m:oMath） ─────────────────────────────────────
//
// 预处理完 oMathPara 后，剩余独立的 <m:oMath> 即行内公式。
// 用 \b 确保不匹配 <m:oMathPara>。
function extractOmmlInline(
  xml: string,
  extracted: Extracted[],
  warnings: string[],
): string {
  const pattern = /<m:oMath\b[^>]*>([\s\S]*?)<\/m:oMath>/g
  return xml.replace(pattern, (fullMatch) => {
    try {
      const latex = restoreInvisiblePhantomBase(
        ommlToLatex(fullMatch, {
          onUnsupported: (name) =>
            warnings.push(`OMML 元素 ${name} 不支持，已降级为文本`),
        }),
      )
      const idx = extracted.length
      extracted.push({ type: T_FI, replacement: `$${latex}$` })
      return placeholderRun(T_FI, idx)
    } catch (e) {
      warnings.push(`公式转换失败（行内）: ${(e as Error).message}`)
      return fullMatch // 转换失败保留原文
    }
  })
}

// ─── MathType OLE 公式提取（w:object + o:OLEObject） ───────────────────
//
// MathType / 公式编辑器 3.0 公式以 OLE 复合文档嵌入 .docx：
//   word/document.xml：<w:object><v:shape>…fallback 图片…</v:shape>
//                      <o:OLEObject ProgID="Equation.DSMT4"
//                      Type="Embed" r:id="rId9"/></w:object>
//                      ProgID 前缀 Equation.* 即公式对象（常见 Equation.3
//                      = 公式编辑器 3.0，Equation.DSMT4 = MathType 6+），
//                      其余 ProgID（Excel 图表等）不碰
//   word/_rels/document.xml.rels：rId9 → embeddings/oleObject*.bin
//   word/embeddings/oleObject*.bin：OLE 复合文档，"Equation Native" 流
//                      含 MTEF v5 字节码
//
// mammoth 对 w:object 无处理逻辑 → 公式（含 fallback 图片）被丢弃。
// 预处理阶段按 rels 加载 OLE 字节，交给 mtef/oleToLatex 转为 LaTeX，
// 整个 w:object（含 fallback 图片）替换为占位符；块级/行内判定与 EQ 域
// 一致（所在段落除对象与已提取占位符外无文本 → $$…$$）。
// 转换失败（非 MTEF v5、损坏对象）保留原样并记录 warning。
async function extractMathTypeObjects(
  xml: string,
  zip: JSZip,
  relsXml: string,
  extracted: Extracted[],
  warnings: string[],
): Promise<string> {
  // rels：rId → Target（OLE 文件在 zip 内路径，相对 word/ 目录）
  const relMap = new Map<string, string>()
  const relPattern = /<Relationship\b[^>]*>/g
  let relM: RegExpExecArray | null
  while ((relM = relPattern.exec(relsXml)) !== null) {
    const id = /\bId\s*=\s*["']([^"']+)["']/.exec(relM[0])?.[1]
    const target = /\bTarget\s*=\s*["']([^"']+)["']/.exec(relM[0])?.[1]
    if (id && target) relMap.set(id, target)
  }

  // 收集 MathType OLE 对象（w:object 内 o:OLEObject 且 ProgID 为 Equation.*）
  interface ObjMatch { start: number; end: number; rId: string; progId: string }
  const matches: ObjMatch[] = []
  const objPattern = /<w:object\b[^>]*>[\s\S]*?<\/w:object>/g
  let om: RegExpExecArray | null
  while ((om = objPattern.exec(xml)) !== null) {
    const oleTag = /<o:OLEObject\b[^>]*>/.exec(om[0])
    if (!oleTag) continue
    const progId = /\bProgID\s*=\s*["']([^"']+)["']/.exec(oleTag[0])?.[1] ?? ''
    if (!/^Equation\./i.test(progId)) continue
    // Type="Link" 外链对象无 r:id（用 r:link），无嵌入数据，跳过
    const rId = /\br:id\s*=\s*["']([^"']+)["']/.exec(oleTag[0])?.[1]
    if (!rId) continue
    matches.push({ start: om.index, end: om.index + om[0].length, rId, progId })
  }
  if (matches.length === 0) return xml

  // 并行加载 OLE 字节并转换为 LaTeX（失败得 null，回填时记录 warning）
  const latexList = await Promise.all(
    matches.map(async (m) => {
      const target = relMap.get(m.rId)
      if (!target) return null
      // Target 相对 word/（"embeddings/oleObject1.bin"）；以 / 开头为包
      // 绝对路径（"/word/embeddings/…"），去前导 / 即 zip 内路径
      const path = target.startsWith('/') ? target.slice(1) : `word/${target}`
      const oleFile = zip.file(path)
      if (!oleFile) return null
      const bytes = new Uint8Array(await oleFile.async('arraybuffer'))
      // translate() 的 ROOT 节点自带 $$ … $$ 包裹，剥掉得到纯 LaTeX
      const latex = oleToLatex(bytes)
        .replace(/^\s*\$\$/, '')
        .replace(/\$\$\s*$/, '')
        .trim()
      return latex || null
    }),
  )

  // 段落表：对象 span 所在段落查找 + 块级判定的对象外文本提取
  const paras: { start: number; end: number }[] = []
  const pPattern = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
  let pm: RegExpExecArray | null
  while ((pm = pPattern.exec(xml)) !== null) {
    paras.push({ start: pm.index, end: pm.index + pm[0].length })
  }
  const phPattern = new RegExp(`${PH_L}\\w+:\\d+${PH_R}`, 'g')

  // 生成替换（w:object 位于 <w:r> 内，替换为 <w:t> 保持 run 结构合法）
  interface Mod { start: number; end: number; text: string }
  const mods: Mod[] = []
  matches.forEach((m, i) => {
    const latex = latexList[i]
    if (!latex) {
      warnings.push(`MathType 公式解析失败（${m.progId}），已保留原始对象`)
      return
    }
    const para = paras.find((p) => p.start <= m.start && m.end <= p.end)
    const restText = para
      ? extractAllText(xml.slice(para.start, m.start)) +
        extractAllText(xml.slice(m.end, para.end))
      : ''
    const idx = extracted.length
    if (restText.replace(phPattern, '').trim() === '') {
      extracted.push({ type: T_FB, replacement: `$$${latex}$$` })
      mods.push({
        start: m.start, end: m.end,
        text: `<w:t xml:space="preserve">${PH_L}${T_FB}:${idx}${PH_R}</w:t>`,
      })
    } else {
      extracted.push({ type: T_FI, replacement: `$${latex}$` })
      mods.push({
        start: m.start, end: m.end,
        text: `<w:t xml:space="preserve">${PH_L}${T_FI}:${idx}${PH_R}</w:t>`,
      })
    }
  })
  if (mods.length === 0) return xml

  // 从后往前应用替换（保持前面的位置有效）
  mods.sort((a, b) => b.start - a.start)
  let result = xml
  for (const mod of mods) {
    result = result.slice(0, mod.start) + mod.text + result.slice(mod.end)
  }
  return result
}

// ─── EQ 域公式提取（复杂域 fldChar / 简单域 fldSimple） ────────────────
//
// 老版 Word 公式（公式编辑器 3.0 /「插入 → 域 → Eq」）以域形式存储：
//   复杂域：<w:r><w:fldChar w:fldCharType="begin"/></w:r>
//          <w:r><w:instrText> EQ \F(2,3)</w:instrText></w:r>（指令可拆
//          多个 run，需拼接）
//          <w:r><w:fldChar w:fldCharType="separate"/></w:r>
//          …缓存结果 run(s)…（Word 当前显示的内容）
//          <w:r><w:fldChar w:fldCharType="end"/></w:r>
//   简单域：<w:fldSimple w:instr=" EQ …">缓存run</w:fldSimple>
//
// mammoth 不理解域（公式语义丢失）→ 预处理阶段将整个域 span（begin…end /
// 整个 fldSimple，含缓存结果 run）一次性替换为公式占位符，域指令交给
// eq-field/eq-to-latex 转换为 LaTeX。
//
// 非 EQ 域（HYPERLINK/PAGE 等）不碰：保留原样交给 mammoth 既有逻辑。
// 块级/行内判定与 oMathPara 一致：域所在段落除域外无其他文本（剔除已
// 提取的占位符 ⟦TYPE:n⟧）→ 块级 $$…$$，否则行内 $…$。
function extractEqFields(
  xml: string,
  extracted: Extracted[],
  warnings: string[],
): string {
  // 已提取占位符（用于块级判定时剔除 ⟦TYPE:n⟧ 干扰文本）
  const phPattern = new RegExp(`${PH_L}\\w+:\\d+${PH_R}`, 'g')

  /**
   * 转换单个域：EQ 域 → 公式占位符 run；非 EQ / 空 latex → null（保留原样）
   * @param instr    域指令（instrText 拼接 / fldSimple 属性，已解码实体）
   * @param restText 域所在段落中除域 span 外的文本（块级判定用）
   */
  const pushEqField = (instr: string, restText: string): string | null => {
    if (!/^\s*EQ\b/i.test(instr)) return null
    const { latex, warnings: eqWarnings } = eqToLatex(instr)
    for (const w of eqWarnings) warnings.push(`EQ 公式：${w}`)
    // 病态域（指令仅 "EQ"）无输出 → 保留原样，避免产出裸 $$ 定界符
    if (!latex.trim()) return null
    if (restText.replace(phPattern, '').trim() === '') {
      const idx = extracted.length
      extracted.push({ type: T_FB, replacement: `$$${latex}$$` })
      return placeholderRun(T_FB, idx)
    }
    const idx = extracted.length
    extracted.push({ type: T_FI, replacement: `$${latex}$` })
    return placeholderRun(T_FI, idx)
  }

  // 段落位置表：域 span 所在段落查找 + 块级判定的域外文本提取
  const collectParas = (s: string): { start: number; end: number }[] => {
    const paras: { start: number; end: number }[] = []
    const pPattern = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
    let m: RegExpExecArray | null
    while ((m = pPattern.exec(s)) !== null) {
      paras.push({ start: m.index, end: m.index + m[0].length })
    }
    return paras
  }

  // ── 阶段 A：fldSimple 简单域 ──
  // 单次 string.replace 的各回调均基于原始串执行（替换结果最后才整体
  // 返回），段落表对全程有效，直接替换自洽
  const parasA = collectParas(xml)
  xml = xml.replace(
    /<w:fldSimple\b[^>]*\bw:instr\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/w:fldSimple>/g,
    (full, instrRaw: string, _inner: string, offset: number) => {
      const instr = decodeXml(instrRaw)
      const para = parasA.find(
        (p) => p.start <= offset && offset + full.length <= p.end,
      )
      const restText = para
        ? extractAllText(xml.slice(para.start, offset)) +
          extractAllText(xml.slice(offset + full.length, para.end))
        : ''
      return pushEqField(instr, restText) ?? full
    },
  )

  // ── 阶段 B：fldChar 复杂域 ──
  // 在阶段 A 之后的字符串上重新收集段落表和 run 表（位置已变化）
  const parasB = collectParas(xml)
  interface RunInfo {
    start: number
    end: number
    fldCharType: 'begin' | 'separate' | 'end' | null
    instr: string // run 内所有 instrText 拼接（已解码；普通 run 为 ''）
  }
  const runs: RunInfo[] = []
  const runPattern = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g
  let rm: RegExpExecArray | null
  while ((rm = runPattern.exec(xml)) !== null) {
    const inner = rm[1]
    const fc = /<w:fldChar\b[^>]*\bw:fldCharType\s*=\s*["'](begin|separate|end)["']/.exec(inner)
    let instr = ''
    const itPattern = /<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g
    let im: RegExpExecArray | null
    while ((im = itPattern.exec(inner)) !== null) {
      instr += decodeXml(im[1])
    }
    runs.push({
      start: rm.index,
      end: rm.index + rm[0].length,
      fldCharType: fc ? (fc[1] as 'begin' | 'separate' | 'end') : null,
      instr,
    })
  }

  // 扫描域结构：begin 开域（嵌套 begin 深度 +1 / end -1），
  // 指令文本 = begin→separate（无 separate 则到 end）间 instrText 拼接，
  // 域 span = begin run 起点到 end run 终点（含缓存结果 run）
  interface Mod { start: number; end: number; text: string }
  const mods: Mod[] = []
  let i = 0
  while (i < runs.length) {
    if (runs[i].fldCharType !== 'begin') { i++; continue }
    const beginRun = runs[i]
    let instr = beginRun.instr
    let depth = 1
    let seenSeparate = false
    let endIdx = -1
    let j = i + 1
    while (j < runs.length) {
      const r = runs[j]
      if (r.fldCharType === 'begin') {
        depth++
      } else if (r.fldCharType === 'separate') {
        // 嵌套域（depth>1）的 separate 不结束外层指令区
        if (depth === 1) seenSeparate = true
      } else if (r.fldCharType === 'end') {
        depth--
        if (depth === 0) { endIdx = j; break }
      } else if (!seenSeparate && depth === 1) {
        // separate 之前且非嵌套域内的 run 才是指令文本（跨 run 拼接）
        instr += r.instr
      }
      j++
    }
    // 未闭合的域（文档损坏）：跳过该 begin，不中断整体导入
    if (endIdx === -1) { i++; continue }

    const spanStart = beginRun.start
    const spanEnd = runs[endIdx].end
    const para = parasB.find((p) => p.start <= spanStart && spanEnd <= p.end)
    const restText = para
      ? extractAllText(xml.slice(para.start, spanStart)) +
        extractAllText(xml.slice(spanEnd, para.end))
      : ''
    const replacement = pushEqField(instr, restText)
    if (replacement) {
      mods.push({ start: spanStart, end: spanEnd, text: replacement })
    }
    i = endIdx + 1
  }

  // 从后往前应用替换（保持前面的位置有效）
  mods.sort((a, b) => b.start - a.start)
  let result = xml
  for (const mod of mods) {
    result = result.slice(0, mod.start) + mod.text + result.slice(mod.end)
  }
  return result
}

// ─── 田字格提取（DrawingML 行内形状组合） ─────────────────────────────
//
// ColaMD 导出（规约G）：每个格子一个独立 <w:r><w:drawing><wp:inline>…
// <a:graphicData uri=…wordprocessingGroup><wpg:wgp>…</wpg:wgp> 组合，
// wp:docPr 的 name 固定为「田字格 N」（识别标记）。组内：
//   - 汉字格：rect 形状 + KaiTi 文本框（w:txbxContent）装字
//   - 拼音格：Segoe UI 文本框装带调拼音 + 空方框
//   - 空白格：仅空方框
//   - 另有两条 D38B8B 虚线（十字），不含文字，无需提取
//
// mammoth 对 w:drawing 无处理逻辑（warning 后整块忽略）→ 格子全部丢失。
//
// 提取必须按 <w:drawing> 层级匹配而非 <w:r>：w:txbxContent 内含嵌套 run，
// 对 <w:r> 的非贪婪匹配会被内嵌 run 的闭合标签截断，提不到文字。
// 替换时把 drawing 换成 <w:t> 占位符（保留外层 w:r 结构，无嵌套 run）。
// 阶段 3 由 rebuildTianziSequences 把同段连续占位符重组为 ++…++ 语法单元。
function extractTianziGrid(xml: string, extracted: Extracted[]): string {
  const drawingPattern = /<w:drawing\b[^>]*>([\s\S]*?)<\/w:drawing>/g
  return xml.replace(drawingPattern, (fullMatch) => {
    // 只处理 ColaMD 田字格形状（docPr name 以「田字格」开头）
    if (!/<wp:docPr\b[^>]*\bname="田字格/.test(fullMatch)) return fullMatch

    // 从各文本框提取格子内容：Segoe UI → 拼音；其余（KaiTi 等）→ 汉字
    let char: string | undefined
    let pinyin: string | undefined
    const txbxPattern = /<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g
    let m: RegExpExecArray | null
    while ((m = txbxPattern.exec(fullMatch)) !== null) {
      const text = extractAllText(m[1])
      if (!text) continue
      if (/w:ascii="Segoe UI"/.test(m[1])) {
        pinyin = (pinyin ?? '') + text
      } else {
        char = (char ?? '') + text
      }
    }

    const idx = extracted.length
    extracted.push({ type: T_TZ, replacement: '', cell: { char, pinyin } })
    // 直接替换为 run 内文本（drawing 位于 <w:r> 内，w:t 是合法 run 内容）
    return `<w:t xml:space="preserve">${PH_L}${T_TZ}:${idx}${PH_R}</w:t>`
  })
}

// ─── 田字格序列重组（阶段 3a） ─────────────────────────────────────────
//
// mammoth 输出中同一行（段落）内连续的占位符 ⟦TZ:a⟧⟦TZ:a+1⟧… 即导出时
// 同一个 ++…++ 语法单元的格子序列。按 parseCells（tianzi-grid/lib.ts）
// 的三种语法形态逆向重组：
//   全字格   → ++所有汉字拼接++            （导出：每字一格）
//   全拼音格 → ++(音节拼接的数字声调串)++  （导出：每音节一格，带调 → 还原数字声调）
//   全空白格 → ++(N)++（N>1）/ ++()++（N=1）（导出：N 个空方框）
// 混合类型组正常导出不会产生；兜底拼接以尽量保留信息（parseCells 不识别
// 时降级为普通文本，无丢失风险）。
function rebuildTianziSequences(markdown: string, extracted: Extracted[]): string {
  const seqPattern = new RegExp(`(?:${PH_L}${T_TZ}:\\d+${PH_R})+`, 'g')
  const itemPattern = new RegExp(`${PH_L}${T_TZ}:(\\d+)${PH_R}`, 'g')
  return markdown.replace(seqPattern, (seq) => {
    itemPattern.lastIndex = 0
    const idxs: number[] = []
    let im: RegExpExecArray | null
    while ((im = itemPattern.exec(seq)) !== null) {
      idxs.push(Number(im[1]))
    }
    const group = idxs
      .map((i) => extracted[i]?.cell)
      .filter((c): c is { char?: string; pinyin?: string } => !!c)
    if (group.length === 0) return ''

    if (group.every((c) => c.char)) {
      return '++' + group.map((c) => c.char).join('') + '++'
    }
    if (group.every((c) => c.pinyin && !c.char)) {
      // 带调拼音 → 数字声调后拼接（you2yi2 形态，parseCells 按声调数字切音节）
      return '++(' + group.map((c) => diacriticToToneNum(c.pinyin ?? '')).join('') + ')++'
    }
    if (group.every((c) => !c.char && !c.pinyin)) {
      const n = group.length
      return n === 1 ? '++()++' : `++(${n})++`
    }
    // 混合兜底：字格文字拼出，拼音并入括号（非法语法时编辑器按普通文本显示）
    const chars = group.map((c) => c.char ?? '').join('')
    const pys = group.filter((c) => c.pinyin).map((c) => diacriticToToneNum(c.pinyin ?? '')).join('')
    return '++' + chars + (pys ? `(${pys})` : '') + '++'
  })
}

// ─── 带圈序号提取（上标 Run） ──────────────────────────────────────────
//
// ColaMD 导出（规约E）：字^{n} → 汉字 Run + 上标 Run（vertAlign=superscript）：
//   n 1–20  → U+2460…U+2473（①…⑳）
//   n 21–35 → U+3251…U+325F（㉑…㉟）
//   n 36–50 → U+32B1…U+32BF（㊱…㊿）
//   n > 50  → 退化为上标文本 "(n)"（见 docx-export.ts circledDigit）
// mammoth 把 vertAlign 读为 verticalAlignment 但 markdown 输出丢上标语义，
// 带圈数字沦为普通字符 → 无法还原语法。
// 预处理：上标 run 且文本为单个带圈数字（或括号数字退化形态）→ 占位符
// ⟦CS:n⟧，阶段 3 回填 ^{n}（紧贴前一 run 的汉字，满足 remark 的 CJK+^ 语法）。
function extractCircledSup(xml: string, extracted: Extracted[]): string {
  // 上标 run 结构简单（rPr + w:t，无嵌套 run），非贪婪匹配安全
  const runPattern = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g
  return xml.replace(runPattern, (fullMatch, inner) => {
    if (!/<w:vertAlign\s+w:val\s*=\s*["']superscript["']\s*\/?>/.test(inner)) {
      return fullMatch
    }
    const text = extractAllText(inner)
    if (!text) return fullMatch

    // 单个带圈数字字符 → 序号 n
    let n = 0
    const circled = /^[\u2460-\u2473\u3251-\u325F\u32B1-\u32BF]$/.exec(text)
    if (circled) {
      const code = text.codePointAt(0) ?? 0
      if (code <= 0x2473) n = code - 0x2460 + 1
      else if (code <= 0x325F) n = code - 0x3251 + 21
      else n = code - 0x32B1 + 36
    } else {
      // 括号数字 "(n)" → n>50 的退化形态
      const paren = /^\((\d+)\)$/.exec(text)
      if (paren) n = Number(paren[1])
    }
    if (n < 1) return fullMatch

    const idx = extracted.length
    extracted.push({ type: T_CS, replacement: `^{${n}}` })
    return placeholderRun(T_CS, idx)
  })
}

// ─── Ruby 拼音提取（w:ruby） ───────────────────────────────────────────
//
// ColaMD 导出：拼音 ruby → <w:ruby><w:rt>…拼音…</w:rt><w:rubyBase>…汉字…</w:rubyBase></w:ruby>
// mammoth 对 w:ruby 无处理逻辑 → 整个 ruby（含汉字和拼音）被丢弃。
// 预处理阶段提取基字和拼音，将带声调符号的拼音转为数字声调格式。
//
// 转换：'tiān qì' → 'tian1qi4'，'nǚ' → 'nv3'
function extractRuby(xml: string, extracted: Extracted[]): string {
  const pattern = /<w:ruby\b[^>]*>([\s\S]*?)<\/w:ruby>/g
  return xml.replace(pattern, (fullMatch) => {
    // 提取拼音文本（w:rt 内的 w:t）
    const rtText = extractContainerText(fullMatch, 'w:rt')
    // 提取基字文本（w:rubyBase 内的 w:t）
    const baseText = extractContainerText(fullMatch, 'w:rubyBase')

    if (!baseText) return '' // 无基字 → 丢弃

    // 将带 Unicode 声调符号的拼音转为数字声调
    const pinyin = diacriticToToneNum(rtText)

    const idx = extracted.length
    extracted.push({ type: T_RU, replacement: `${baseText}(${pinyin})` })
    return placeholderRun(T_RU, idx)
  })
}

// ─── 下划线提取（w:u） ─────────────────────────────────────────────────
//
// ColaMD 导出：underline <u>内容</u> → <w:r><w:rPr><w:u w:val="single"/>…
// mammoth 读取 run 时不识别 w:u → 文字保留但下划线丢失。
//
// 处理：把 run 的文本就地包成 <u>…</u>（写进 w:t 需转义为 XML 实体，
// 后续 extractAllText 会解码回 <u>）。与着重号（extractEmphasis）不同，
// 这里不把整段 run 换成占位符 —— rFonts / w:b / w:sz 等属性原样保留，
// 后续字体识别（injectFontMarkers）、加粗、上下标等处理不受影响，
// 同一 run 的「加粗 + 下划线」「换字体 + 下划线」都能一并还原。
//
// 标记能原样穿到 markdown：mammoth 的 escapeMarkdown 只转义
// \ ` * _ { } [ ] ( ) # + - . !，不转义 < 与 >，故无需占位符回填。
//
// 取值：w:u 有 w:val 且非 none → 有下划线（single/double/dotted/wave…
// 一律还原为普通下划线）；显式 <w:u w:val="none"/> → 无下划线。
function extractUnderline(xml: string): string {
  const runPattern = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g
  return xml.replace(runPattern, (fullMatch, inner: string) => {
    const rPr = /<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/.exec(inner)
    if (!rPr) return fullMatch
    const uMatch = /<w:u\b([^>]*?)\/?>/.exec(rPr[1])
    if (!uMatch) return fullMatch
    const val = /\bw:val\s*=\s*["']([^"']*)["']/.exec(uMatch[1])
    if (val && val[1] === 'none') return fullMatch
    if (!extractAllText(inner).trim()) return fullMatch // 纯空白 run：无需包裹
    return wrapRunText(inner, '<u>', '</u>')
  })
}

/** 把 run 的文本内容整体包进 open/close（只改 w:t，不动 rPr） */
function wrapRunText(inner: string, open: string, close: string): string {
  const first = /<w:t\b[^>]*?>/.exec(inner)
  if (!first) return inner
  const start = first.index + first[0].length
  const last = inner.lastIndexOf('</w:t>')
  if (last < start) return inner // 自闭合 <w:t …/>（空文本）不包裹
  return (
    inner.slice(0, start) +
    encodeXml(open) +
    inner.slice(start, last) +
    encodeXml(close) +
    inner.slice(last)
  )
}

// ─── 着重号提取（w:em w:val="dot"） ───────────────────────────────────
//
// ColaMD 导出：emphDot @.内容.@ → <w:r><w:rPr><w:em w:val="dot"/></w:rPr><w:t>内容</w:t></w:r>
// mammoth 读取 run 时不识别 w:em → 文字保留但着重号丢失。
// 预处理阶段检测含 w:em w:val="dot" 的 run，将其文本包装为 @.….@。
function extractEmphasis(xml: string, extracted: Extracted[]): string {
  // 逐个处理 w:r 元素（OOXML 中 w:r 不嵌套，非贪婪匹配安全）
  const runPattern = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g
  return xml.replace(runPattern, (fullMatch, inner) => {
    // 检查 w:rPr 中是否含着重号 <w:em w:val="dot"/>
    if (!/<w:em\b[^>]*\bw:val\s*=\s*["']dot["'][^>]*\/?>/.test(inner)) {
      return fullMatch
    }

    // 提取 run 中所有 w:t 的文本
    const text = extractAllText(inner)
    if (!text) return fullMatch

    const idx = extracted.length
    extracted.push({ type: T_EM, replacement: `@.${text}.@` })
    return placeholderRun(T_EM, idx)
  })
}

// ─── 通用上下标提取（vertAlign run） ──────────────────────────────────
//
// ColaMD 导出：下标 _{x} / 上标 ^{x} → <w:vertAlign w:val="subscript|
// superscript"> run。Word 原生化学式（CO₂、SO₄²⁻、H₃O⁺）同样以 vertAlign
// run 表示——mammoth 不识别 vertAlign，输出时拍平为普通文本（CO2、SO42-），
// 格式语义丢失。
//
// 预处理：提取剩余的 vertAlign run 为占位符，阶段 3 回填 _{x} / ^{x}。
//   - 带圈序号上标已被 extractCircledSup 提前提取（run 已替换为占位符文本
//     run，不再含 vertAlign），此处不冲突；
//   - 回填后占位符紧贴前后 run 文本（run 相邻性由 mammoth 按 run 顺序拼接
//     保持），满足 ColaMD 语法的紧贴约束（前一字符非空白）。
//
// 内容约束：ColaMD 语法要求上下标内容为非空白、非花括号的连续字符
// （[^{}\s]+），含空白/花括号的 run 不提取，交由 mammoth 拍平为普通文本
// （降级保文本，格式丢失与 mammoth 现状一致）。
function extractVertAlign(xml: string, extracted: Extracted[]): string {
  const runPattern = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g
  return xml.replace(runPattern, (fullMatch, inner: string) => {
    const valMatch = /<w:vertAlign\b[^>]*\bw:val\s*=\s*["'](subscript|superscript)["']/.exec(inner)
    if (!valMatch) return fullMatch
    const text = extractAllText(inner)
    if (!text || /[\s{}]/.test(text)) return fullMatch

    const idx = extracted.length
    if (valMatch[1] === 'subscript') {
      extracted.push({ type: T_SUB, replacement: `_{${text}}` })
      return placeholderRun(T_SUB, idx)
    }
    extracted.push({ type: T_SUP, replacement: `^{${text}}` })
    return placeholderRun(T_SUP, idx)
  })
}

// ─── 表格提取（w:tbl → GFM 管道表格） ─────────────────────────────────
//
// ColaMD 使用 GFM 管道表格。Word 的 w:tbl 交给 mammoth 处理时，markdown
// writer 不支持表格结构 → 单元格文本被拍平成连续段落，行列信息全丢。
// 预处理：整表解析为行列文本矩阵，替换为占位符段落 ⟦TBL:n⟧，阶段 3 回填
// 为 GFM 管道表格（多行文本）。
//
// 合并单元格 v1 降级（GFM 不支持合并，出现即 warning）：
//   - gridSpan（横向合并）→ 文本放首列，其余列留空
//   - vMerge（纵向合并）  → restart 格保文本，continue 格留空
//
// 限制：
//   - 嵌套表格（w:tbl 内含 w:tbl）v1 跳过（非贪婪匹配在内层 </w:tbl>
//     截断，无法解析完整结构），保留 mammoth 原始处理
//   - 全空表格（纯布局用途）跳过
//   - 单元格内的行内扩展（公式/带圈序号/上下标/田字格等）已在更早阶段
//     提取为占位符，随表格文本一起提取，由多轮回填还原
function extractTables(xml: string, extracted: Extracted[], warnings: string[]): string {
  const tblPattern = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g
  return xml.replace(tblPattern, (fullMatch, inner: string) => {
    if (/<w:tbl\b/.test(inner)) {
      warnings.push('检测到嵌套表格，暂不支持导入（已保留原始处理）')
      return fullMatch
    }

    // 逐行解析单元格文本（w:tr 不嵌套，非贪婪匹配安全）
    const rows: string[][] = []
    let hasMerge = false
    const trPattern = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g
    let trM: RegExpExecArray | null
    while ((trM = trPattern.exec(inner)) !== null) {
      const cells: string[] = []
      const tcPattern = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g
      let tcM: RegExpExecArray | null
      while ((tcM = tcPattern.exec(trM[1])) !== null) {
        const tcInner = tcM[1]
        // 多段落单元格：段落文本以空格拼接（GFM 单元格不支持换行）
        const paras = tcInner.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []
        const text = paras
          .map((p) => extractAllText(p).trim())
          .filter(Boolean)
          .join(' ')
          .trim()
        // 横向合并 gridSpan：文本放首列，其余列留空
        const span = /<w:gridSpan\b[^>]*\bw:val\s*=\s*["'](\d+)["']/.exec(tcInner)
        const spanN = span ? Math.max(1, parseInt(span[1])) : 1
        if (spanN > 1) {
          hasMerge = true
          cells.push(text)
          for (let k = 1; k < spanN; k++) cells.push('')
          continue
        }
        // 纵向合并 vMerge：restart 格保文本，continue 格留空
        if (/<w:vMerge\b/.test(tcInner)) {
          hasMerge = true
          cells.push(
            /<w:vMerge\b[^>]*\bw:val\s*=\s*["']restart["']/.test(tcInner) ? text : '',
          )
          continue
        }
        cells.push(text)
      }
      rows.push(cells)
    }

    // 无行 / 全空表（纯布局用途）不转，保留 mammoth 原始处理
    if (rows.length === 0 || rows.every((r) => r.every((c) => !c))) {
      return fullMatch
    }

    // 列数：tblGrid 的 gridCol 数优先，兜底最大行宽；不足的行补空
    const gridColCount = (inner.match(/<w:gridCol\b/g) ?? []).length
    const colCount = Math.max(gridColCount, ...rows.map((r) => r.length))
    for (const r of rows) {
      while (r.length < colCount) r.push('')
    }

    const idx = extracted.length
    extracted.push({ type: T_TBL, replacement: buildGfmTable(rows) })
    if (hasMerge) {
      warnings.push('表格含合并单元格，已降级为普通表格（合并信息丢失）')
    }
    return `<w:p>${placeholderRun(T_TBL, idx)}</w:p>`
  })
}

/** 行列矩阵 → GFM 管道表格文本（首行为表头；单元格内 | 转义、换行折空格） */
function buildGfmTable(rows: string[][]): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
  const header = rows[0]
  return [
    '| ' + header.map(esc).join(' | ') + ' |',
    '| ' + header.map(() => '---').join(' | ') + ' |',
    ...rows.slice(1).map((r) => '| ' + r.map(esc).join(' | ') + ' |'),
  ].join('\n')
}

// ─── 字体解析（fontBlock / fontSpan，规约H） ──────────────────────────
//
// ColaMD 导出（规约H）：
//   块级 fontBlock:  :::font{family=楷体 size=12pt} … :::  → 段落对齐+字体字号（子树继承）
//   行内 fontSpan:   {= family=楷体 size=12pt : 目标文本}  → Run 字体/字号覆盖
//
// Word 文档中字体变化通过 run 的 <w:rFonts> 和 <w:sz> 实现，无段落级继承。
// 两种模式：
//   1. 整段换字体（如文言文正文用楷体）→ 同一段大多数 run 设相同 rFonts
//      → 识别为 fontBlock，注入 :::font{…} / ::: 标记段落
//   2. 段内部分 run 换字体 → 仅少数 run 设 rFonts
//      → 识别为 fontSpan，用占位符替换 run，阶段 3 回填 {= … : text}
//
// 字体提取优先级：w:eastAsia（中文字体）> w:ascii（西文字体）
// 字号从 <w:sz> 提取（半点值 → pt，如 24 → 12pt）
//
// 判定阈值：主导字体需覆盖 ≥50% 的文本 run，否则视为混合段落（fontSpan 处理）
function injectFontMarkers(xml: string, extracted: Extracted[]): string {
  // ── 1. 分析所有段落的字体信息 ──
  interface ParaInfo {
    start: number
    end: number
    dominantFont: string | null
    dominantSize: string | null
  }
  interface RunInfo {
    paraIdx: number
    runStart: number // 绝对位置
    runEnd: number
    family: string
    size: string | null
    text: string
  }

  const pPattern = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
  const paraInfos: ParaInfo[] = []
  const runInfos: RunInfo[] = []

  let pm: RegExpExecArray | null
  let paraIdx = 0
  while ((pm = pPattern.exec(xml)) !== null) {
    const pXml = pm[0]
    const pStart = pm.index

    // 分析段内所有 run 的字体
    const runPattern = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g
    const fontCounts = new Map<string, number>()
    const sizeCounts = new Map<string, number>()
    let totalTextRuns = 0

    let rm: RegExpExecArray | null
    while ((rm = runPattern.exec(pXml)) !== null) {
      const rInner = rm[1]
      const text = extractAllText(rInner)
      if (!text.trim()) continue
      totalTextRuns++

      const eaMatch = /<w:rFonts\b[^>]*?\bw:eastAsia\s*=\s*["']([^"']+)["']/.exec(rInner)
      const asciiMatch = /<w:rFonts\b[^>]*?\bw:ascii\s*=\s*["']([^"']+)["']/.exec(rInner)
      const family = eaMatch?.[1] ?? asciiMatch?.[1] ?? null

      const szMatch = /<w:sz\b[^>]*?\bw:val\s*=\s*["'](\d+)["']/.exec(rInner)
      const size = szMatch ? parseInt(szMatch[1]) / 2 + 'pt' : null

      // fontCounts 跟踪 resolved family（eastAsia ?? ascii），而非仅 eastAsia。
      // 纯西文字体（如 Arial）只设 w:ascii 不设 w:eastAsia，仅跟踪 eastAsia
      // 会导致这类段落 dominantFont=null，误降级为 fontSpan。
      if (family) fontCounts.set(family, (fontCounts.get(family) ?? 0) + 1)
      if (size) sizeCounts.set(size, (sizeCounts.get(size) ?? 0) + 1)

      if (family) {
        runInfos.push({
          paraIdx,
          runStart: pStart + rm.index,
          runEnd: pStart + rm.index + rm[0].length,
          family,
          size,
          text,
        })
      }
    }

    // 主导字体（最多的 eastAsia 值）
    let dominantFont: string | null = null
    let maxFontCount = 0
    for (const [font, count] of fontCounts) {
      if (count > maxFontCount) { maxFontCount = count; dominantFont = font }
    }
    // 需 ≥50% 文本 run 有此字体
    if (dominantFont && totalTextRuns > 0 && maxFontCount < Math.ceil(totalTextRuns * 0.5)) {
      dominantFont = null
    }

    // 主导字号
    let dominantSize: string | null = null
    let maxSizeCount = 0
    for (const [size, count] of sizeCounts) {
      if (count > maxSizeCount) { maxSizeCount = count; dominantSize = size }
    }

    paraInfos.push({ start: pStart, end: pStart + pXml.length, dominantFont, dominantSize })
    paraIdx++
  }

  // ── 2. 确定 fontBlock 段落组（连续同字体段落）──
  const fontBlockParas = new Set<number>()
  let i = 0
  while (i < paraInfos.length) {
    if (!paraInfos[i].dominantFont) { i++; continue }
    const font = paraInfos[i].dominantFont!
    let j = i
    while (j + 1 < paraInfos.length && paraInfos[j + 1].dominantFont === font) {
      const gap = xml.slice(paraInfos[j].end, paraInfos[j + 1].start)
      if (/<w:tbl\b|<w:sectPr\b/.test(gap)) break
      j++
    }
    for (let k = i; k <= j; k++) fontBlockParas.add(k)
    i = j + 1
  }

  // ── 3. 收集所有修改（fontBlock 插入 + fontSpan 替换）──
  // order 用于同位置插入的排序：FBE(0) < FBS(1) < fontSpan(2)
  // 同位置时 order 大的先处理（先插入），order 小的后处理（插在前面）
  // 这样 FBE 会出现在 FBS 之前（文档中正确顺序：先结束后再开始）
  interface Mod { pos: number; end?: number; text: string; isReplace: boolean; order: number }
  const mods: Mod[] = []

  // fontBlock: 注入 :::font{…} / ::: 标记段落
  // 用占位符而非原始文本：mammoth 会转义 { } _ 等 Markdown 特殊字符
  i = 0
  while (i < paraInfos.length) {
    if (!fontBlockParas.has(i)) { i++; continue }
    const font = paraInfos[i].dominantFont!
    let j = i
    // 连续同字体段落为一组；subBlock 标记段落（@#center/@）无字体
    // 信息，天然打断序列，确保 fontBlock 不跨越 subBlock 边界
    while (j + 1 < paraInfos.length && fontBlockParas.has(j + 1) && paraInfos[j + 1].dominantFont === font) j++

    const attrs = formatFamilyAttr(font) + (paraInfos[i].dominantSize ? ` size=${paraInfos[i].dominantSize}` : '')
    const startIdx = extracted.length
    extracted.push({ type: T_FBS, replacement: `:::font{${attrs}}` })
    mods.push({ pos: paraInfos[i].start, text: `<w:p><w:r><w:t xml:space="preserve">${PH_L}${T_FBS}:${startIdx}${PH_R}</w:t></w:r></w:p>`, isReplace: false, order: 1 })
    const endIdx = extracted.length
    extracted.push({ type: T_FBE, replacement: ':::' })
    mods.push({ pos: paraInfos[j].end, text: `<w:p><w:r><w:t xml:space="preserve">${PH_L}${T_FBE}:${endIdx}${PH_R}</w:t></w:r></w:p>`, isReplace: false, order: 0 })
    i = j + 1
  }

  // fontSpan: 非 fontBlock 段落中有显式字体的 run → 占位符
  for (const ri of runInfos) {
    if (fontBlockParas.has(ri.paraIdx)) continue
    const idx = extracted.length
    let replacement = `{= ${formatFamilyAttr(ri.family)}`
    if (ri.size) replacement += ` size=${ri.size}`
    replacement += ` : ${ri.text}}`
    extracted.push({ type: T_FS, replacement })
    mods.push({ pos: ri.runStart, end: ri.runEnd, text: placeholderRun(T_FS, idx), isReplace: true, order: 2 })
  }

  // ── 4. 从后往前应用所有修改（保持位置有效）──
  // 同位置时 order 大的先处理：fontSpan > FBS > FBE
  mods.sort((a, b) => b.pos - a.pos || b.order - a.order)
  let result = xml
  for (const mod of mods) {
    if (mod.isReplace && mod.end !== undefined) {
      result = result.slice(0, mod.pos) + mod.text + result.slice(mod.end)
    } else {
      result = result.slice(0, mod.pos) + mod.text + result.slice(mod.pos)
    }
  }
  return result
}

/** 格式化 family 属性：含空格时加双引号 */
function formatFamilyAttr(name: string): string {
  return /\s/.test(name) ? `family="${name}"` : `family=${name}`
}

// ─── 子块居中标记注入（w:jc="center" 连续段落） ───────────────────────
//
// ColaMD 导出（规约F）：无框居中子块 @#center ... @ → 直接展开为连续的
// 居中段落（w:jc="center"），无表格/DrawingML 包裹。导入时需逆向还原：
// 检测 2+ 个连续居中段落，在前后插入 @#center / @ 标记段落。
//
// mammoth 不保留对齐信息（markdown 输出中 center 全部丢失）→ 必须在
// OOXML 预处理阶段注入标记。标记文本经占位符在阶段 3 回填（mammoth 会
// 转义 # 等字符，不能直接写 @#center），ColaMD 词法层识别 @#center（行首）
// → @（行尾）的子块语法。
function injectSubBlockMarkers(xml: string, extracted: Extracted[]): string {
  // 起止标记不能直接写 @#center 文本：mammoth 的 markdown writer 会对文本
  // 无条件转义 Markdown 特殊字符（# → \# 等），产出 @\#center 后 ColaMD
  // 词法层（lexer.ts RE_SUB_START）无法识别。因此标记段落里放占位符，
  // 阶段 3 回填真实的 @#center / @ 文本（此时已脱离 mammoth，不会再转义）。
  const SUBBLOCK_START = (idx: number) => `<w:p>${placeholderRun(T_SBS, idx)}</w:p>`
  const SUBBLOCK_END = (idx: number) => `<w:p>${placeholderRun(T_SBE, idx)}</w:p>`

  // 匹配所有 <w:p> 段落（w:p 不自嵌套，非贪婪匹配安全；
  // 浮动表格内嵌的 w:p 可能被截断，但目标文档无表格，不受影响）
  // 跳过仅含占位符的标记段落（fontBlock 的 :::font / ::: 标记段落）：
  // 它们无 w:jc，若参与计数会打断连续居中段落序列，导致标题段落丢失子块包裹。
  const pPattern = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
  const phOnlyPattern = new RegExp(`^${PH_L}\\w+:\\d+${PH_R}$`)
  const matches: { start: number; end: number; centered: boolean }[] = []
  let m: RegExpExecArray | null
  while ((m = pPattern.exec(xml)) !== null) {
    const text = extractAllText(m[0]).trim()
    if (text && phOnlyPattern.test(text)) continue // 跳过 fontBlock 标记段落
    const centered = /<w:jc\b[^>]*\bw:val\s*=\s*["']center["']/.test(m[0])
    matches.push({ start: m.index, end: m.index + m[0].length, centered })
  }

  // 查找 2+ 个连续居中段落的区间
  const insertions: { pos: number; text: string }[] = []
  let i = 0
  while (i < matches.length) {
    if (!matches[i].centered) { i++; continue }
    // 向后扫描连续居中段落
    let j = i
    while (j + 1 < matches.length) {
      // 两段之间若有表格/分节符等块级元素则打断连续性
      const gap = xml.slice(matches[j].end, matches[j + 1].start)
      if (/<w:tbl\b|<w:sectPr\b/.test(gap)) break
      if (!matches[j + 1].centered) break
      j++
    }
    if (j > i) {
      const startIdx = extracted.length
      extracted.push({ type: T_SBS, replacement: '@#center' })
      insertions.push({ pos: matches[i].start, text: SUBBLOCK_START(startIdx) })
      const endIdx = extracted.length
      extracted.push({ type: T_SBE, replacement: '@' })
      insertions.push({ pos: matches[j].end, text: SUBBLOCK_END(endIdx) })
    }
    i = j + 1
  }

  // 逆序应用插入（保持位置索引有效）
  insertions.sort((a, b) => b.pos - a.pos)
  let result = xml
  for (const ins of insertions) {
    result = result.slice(0, ins.pos) + ins.text + result.slice(ins.pos)
  }
  return result
}

// ─── mammoth strong 语法归一（阶段 3-0） ──────────────────────────────
//
// mammoth 对连续加粗 run 输出 __…__（markdown-writer.js L76），存在两类
// 解析缺陷：开启侧紧跟空格（__  2017__）不满足 CommonMark 左侧翼规则；
// 关闭侧后跟 CJK 字符（__2017__年）受下划线词内限制无法闭合。两者都会
// 让字面 __ 残留在正文里。
// 处理：__…__ → **…**（星号无词内限制，且与 ColaMD stringify 输出一致），
// span 首尾的空格/制表符移到标记外（字符数不变，行尾硬换行双空格不受
// 影响），纯空格加粗直接丢弃标记仅保留空格。mammoth 输出中的字面下划线
// 均已转义为 \_，未转义的 __ 只可能是 strong 定界符，正则处理安全。
function normalizeMammothStrong(markdown: string): string {
  return markdown.replace(
    /__([ \t]*)((?:[^_]|\\_)*?)([ \t]*)__/g,
    (_full, lead: string, core: string, trail: string) => {
      if (!core) return lead + trail // 纯空格加粗：丢弃空 strong
      return `${lead}**${core}**${trail}` // 空格移出标记 + 转星号定界
    },
  )
}

// ─── 工具函数 ─────────────────────────────────────────────────────────

/** 生成包含占位符的 <w:r><w:t> 元素，mammoth 会将其作为纯文本输出 */
function placeholderRun(type: string, idx: number): string {
  return `<w:r><w:t xml:space="preserve">${PH_L}${type}:${idx}${PH_R}</w:t></w:r>`
}

/** 从 XML 片段中提取所有 <w:t> 元素的文本内容（已解码 XML 实体） */
function extractAllText(xml: string): string {
  const texts: string[] = []
  const tPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g
  let m: RegExpExecArray | null
  while ((m = tPattern.exec(xml)) !== null) {
    texts.push(decodeXml(m[1]))
  }
  return texts.join('')
}

/** 从 XML 片段中提取指定容器（如 w:rt、w:rubyBase）内所有 w:t 的文本 */
function extractContainerText(xml: string, container: string): string {
  const pattern = new RegExp(
    `<${container}\\b[^>]*>([\\s\\S]*?)<\\/${container}>`,
  )
  const match = pattern.exec(xml)
  return match ? extractAllText(match[1]) : ''
}

/** 编码 XML 文本中的特殊字符（<、>、&） */
function encodeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 解码 XML 实体（&amp; → & 等） */
function decodeXml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
}

/**
 * 将带 Unicode 声调符号的拼音转换为数字声调格式。
 *
 * ColaMD 导出时用 pinyin-pro 的 convert() 把 'tian1qi4' 转成 'tiān qì'
 * 写入 w:ruby 的 w:rt。导入时需逆向还原：'tiān qì' → 'tian1qi4'。
 *
 * 声调符号映射：macron(¯)→1, acute(´)→2, caron(ˇ)→3, grave(`)→4
 * ü/ǖ/ǘ/ǚ/ǜ 映射为 v（ColaMD 拼音正则 [a-z] 接受 v）
 * 声调数字在音节末尾追加（you2 而非 yo2u）——拼音声调标在韵母上但数字
 * 声调格式规定数字收尾整个音节。音节边界判定：空格/非字母分隔符、
 * 下一个带调元音、字符串结束。
 */
const DIACRITIC_MAP: Record<string, string> = {
  // 一声 macron
  ā: 'a1', Ā: 'a1', ē: 'e1', Ē: 'e1', ī: 'i1', Ī: 'i1',
  ō: 'o1', Ō: 'o1', ū: 'u1', Ū: 'u1', ǖ: 'v1', Ǖ: 'v1',
  // 二声 acute
  á: 'a2', Á: 'a2', é: 'e2', É: 'e2', í: 'i2', Í: 'i2',
  ó: 'o2', Ó: 'o2', ú: 'u2', Ú: 'u2', ǘ: 'v2', Ǘ: 'v2',
  // 三声 caron
  ǎ: 'a3', Ǎ: 'a3', ě: 'e3', Ě: 'e3', ǐ: 'i3', Ǐ: 'i3',
  ǒ: 'o3', Ǒ: 'o3', ǔ: 'u3', Ǔ: 'u3', ǚ: 'v3', Ǚ: 'v3',
  // 四声 grave
  à: 'a4', À: 'a4', è: 'e4', È: 'e4', ì: 'i4', Ì: 'i4',
  ò: 'o4', Ò: 'o4', ù: 'u4', Ù: 'u4', ǜ: 'v4', Ǜ: 'v4',
  // 无声调 ü
  ü: 'v', Ü: 'v',
}

function diacriticToToneNum(pinyin: string): string {
  let result = ''
  let pendingTone = ''
  for (const ch of pinyin) {
    if (DIACRITIC_MAP[ch]) {
      // 新音节的带调元音：先结算上一音节的声调数字
      if (pendingTone) {
        result += pendingTone
        pendingTone = ''
      }
      const mapped = DIACRITIC_MAP[ch] // 如 'a1' / 'v'
      result += mapped[0]
      if (mapped.length > 1) pendingTone = mapped[1]
    } else if (/[a-z0-9]/i.test(ch)) {
      // 音节延续字母/已有数字：声调数字仍挂起（如 yóu 的 u 在 ó 之后）
      result += ch.toLowerCase()
    } else {
      // 空格等分隔符：音节结束，结算声调数字
      if (pendingTone) {
        result += pendingTone
        pendingTone = ''
      }
    }
  }
  // 字符串结束：结算最后一个音节
  if (pendingTone) result += pendingTone
  return result
}

// ─── 行内公式图片 OCR（SimpleTex 契约） ──────────────────────────────
//
// 偏好 markdown.imageFormula === 'ocr' 时启用：扫描 mammoth 输出中
// 行内位置的图片（与文字同一行），逐张 POST 到 OCR 接口
// （multipart file + 请求头 token，与 http/server.mjs 模拟服务及
// SimpleTex /api/latex_ocr 同契约），用返回的 data.latex 替换为 $latex$。
//
// 仅处理行内图片：图片独占一行（去掉图片与列表/标题标记后无残留文字）
// 视为配图（照片/示意图）保留原样，符合「行内公式图片」的语义。
// 单张识别失败 / 服务不可达 / 超时：静默退回保留原图片（与偏好
// 「保留图片」行为一致），不产生 warning，不中断导入。

/** 环境变量读取（浏览器里没有 process → undefined，走默认/调用方传值） */
function nodeEnv(name: string): string | undefined {
  return typeof process !== 'undefined' ? process.env[name] : undefined
}

/** base64 → 字节。Node 的 Buffer 在浏览器里没有替代品，手写一份 */
// 显式标注底层是 ArrayBuffer（而不是更宽的 ArrayBufferLike）：下面要把它作为
// BlobPart 交给 FormData，SharedArrayBuffer 视图在那条路上类型不合。
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const DEFAULT_OCR_URL = 'http://127.0.0.1:8787/api/latex_ocr'
const OCR_API_TOKEN = nodeEnv('COLAMD_OCR_TOKEN') || 'test-token'
const OCR_CONCURRENCY = 4
const OCR_TIMEOUT_MS = 15000

/** 公式 OCR 地址：调用方显式传入 > 环境变量 COLAMD_OCR_URL > 默认本地端点 */
function resolveOcrUrl(url?: string): string {
  return url?.trim() || nodeEnv('COLAMD_OCR_URL') || DEFAULT_OCR_URL
}

// data URI 图片：base64 字符表不含 ')'，可安全用 [^)\s]+ 截断
const DATA_URI_IMAGE_RE = /!\[[^\]]*\]\(data:image\/([a-zA-Z0-9.+-]+);base64,([^)\s]+)\)/g
// 仅供行内 replace 去图使用：String.replace 会把全局正则的 lastIndex 归零，
// 不能与上方 exec 迭代共用同一实例（否则外层死循环）
const STRIP_IMAGE_RE = new RegExp(DATA_URI_IMAGE_RE.source, 'g')

interface InlineImageMatch {
  start: number
  end: number
  ext: string
  b64: string
}

/** 并发受限的 map（简单 worker 池） */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

/** 单张图片 → OCR 接口 → LaTeX；任何失败返回 null（调用方保留原图） */
async function recognizeFormulaImage(match: InlineImageMatch, url: string): Promise<string | null> {
  const bytes = base64ToBytes(match.b64)
  // image/jpeg → 扩展名 jpg；image/svg+xml → svg
  const ext = match.ext === 'jpeg' ? 'jpg' : match.ext.replace('svg+xml', 'svg')
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: `image/${match.ext}` }), `formula.${ext}`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { token: OCR_API_TOKEN },
      body: form,
      signal: controller.signal,
    })
    const json = (await resp.json()) as {
      code?: number
      data?: { latex?: unknown }
      msg?: string
    }
    if (resp.ok && json.code === 200 && typeof json.data?.latex === 'string') {
      const latex = json.data.latex.trim()
      return latex || null
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 给外部（文档助手的「识别公式」）用的入口：字节 + 扩展名 → LaTeX。
 * 复用的就是上面那套 SimpleTex 契约，不另起一份实现（换端点/换 token 只改一处）。
 */
export async function ocrFormulaImageBytes(bytes: Uint8Array, ext: string): Promise<string | null> {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return recognizeFormulaImage({ start: 0, end: 0, ext, b64: btoa(binary) }, resolveOcrUrl())
}

/**
 * 扫描行内图片 → 识别 → 替换为 $latex$；独占一行的图片保留；失败静默保留原图。
 * recognize 由调用方决定用内置大模型还是 HTTP 端点（见 DocxImportOptions）。
 */
async function ocrInlineFormulaImages(
  markdown: string,
  recognize: (item: InlineImageMatch) => Promise<string | null>,
  source: string,
  concurrency: number = OCR_CONCURRENCY,
): Promise<string> {
  const matches: InlineImageMatch[] = []
  let m: RegExpExecArray | null
  DATA_URI_IMAGE_RE.lastIndex = 0
  while ((m = DATA_URI_IMAGE_RE.exec(markdown)) !== null) {
    const start = m.index
    const end = m.index + m[0].length
    // 图片所在物理行
    const nlBefore = markdown.lastIndexOf('\n', start)
    const lineStart = nlBefore === -1 ? 0 : nlBefore + 1
    const nlAfter = markdown.indexOf('\n', end)
    const lineEnd = nlAfter === -1 ? markdown.length : nlAfter
    // 去掉行内全部图片，再去标题/列表标记，仍有文字 → 图片是行内元素
    const residual = markdown
      .slice(lineStart, lineEnd)
      .replace(STRIP_IMAGE_RE, '')
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .trim()
    if (residual) matches.push({ start, end, ext: m[1], b64: m[2] })
  }
  if (matches.length === 0) return markdown

  console.log(`[docx-import] ${matches.length} 张行内公式图片提交识别：${source}`)
  const results = await mapWithConcurrency(matches, concurrency, recognize)

  let failed = 0
  const replacements: { start: number; end: number; text: string }[] = []
  matches.forEach((item, i) => {
    const latex = results[i]
    if (!latex) {
      failed++
      return
    }
    replacements.push({ start: item.start, end: item.end, text: `$${latex}$` })
  })

  // 逆序替换，位置保持有效
  replacements.sort((a, b) => b.start - a.start)
  let result = markdown
  for (const r of replacements) {
    result = result.slice(0, r.start) + r.text + result.slice(r.end)
  }
  const succeeded = replacements.length
  if (succeeded > 0) {
    console.log(`[docx-import] OCR 成功 ${succeeded} 张，已替换为 LaTeX`)
  }
  if (failed > 0) {
    // 识别失败：静默退回保留图片方案（原图原样保留，不产生 warning）
    console.log(`[docx-import] ${failed} 张行内公式图片 OCR 识别失败，已退回保留原图片`)
  }
  return result
}

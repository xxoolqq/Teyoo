// mtef/ — MathType (MTEF v5) 公式解析（纯逻辑模块，无 DOM / Node 依赖）
//
// 背景：MathType / 公式编辑器 3.0 在 .docx 中以 OLE 复合文档嵌入
// （word/embeddings/oleObject*.bin），OLE 内的 "Equation Native" 流存有
// MTEF v5 字节码。本目录将其解析为 AST 并翻译为 LaTeX 内容串：
//
//   oleToLatex(oleBytes) → '$$ … $$' 包裹的 LaTeX（失败返回 ''）
//
// 来源：github.com/zhexiao/mtef-go (Apache-2.0) 的 TypeScript 移植，
// 原项目 D:\CodeBuddyProjects\mtef-ts（dist/ 内含 mtef-go 的两处改进）：
//   - readNudge 按规范读 0x80 哨兵字节
//   - readDimensionArrays 在 EOF 干净停止（Go 版会死循环）
//
// 集成（docx-import.ts）：w:object → oleToLatex() → 剥掉 $$ 包裹 →
// 按行内/块级回填 $…$ / $$…$$ 占位符。
export { MTEFv5, parseMtef, extractEquationNative, oleToLatex } from './mtef'
export { CFBFile } from './cfb'
export { Chars, SpecialChar } from './chars'
export * from './record'

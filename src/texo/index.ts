// LaTeX公式（本地 Texo 模型 OCR）—— 桶文件
//
// 整页标签页（菜单「帮助 → LaTeX公式」）：上传/粘贴/拖拽一张公式图片，本地
// Texo 模型（Transformers.js + 2 个 ONNX）把它识别成 LaTeX，KaTeX 预览 + 复制。
// 与工具箱同一套路：body.texo-view 收起编辑面、面板铺满整页。
//
// 模型文件随安装包分发（electron-builder extraResources → resources/texo），
// 运行时由主进程的 texo:// 自定义协议按需读取（见 main/index.ts）。

export { enterTexoTabChrome, leaveTexoTab, initTexoView } from './view'

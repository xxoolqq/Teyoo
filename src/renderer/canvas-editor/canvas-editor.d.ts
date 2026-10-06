// @hufe921/canvas-editor（https://github.com/Hufe921/canvas-editor）的
// package.json 没有 types 字段：类型产物在 dist/src/editor/index.d.ts，
// 按包名导入时 TS 找不到声明（strict 下报 TS7016）。这里把模块声明指向
// 那份产物，业务代码即可继续按包名取值与取类型。
// 注：该 .d.ts 顶部有一行 css 副作用导入（产物里没有 css 文件），
// 由 tsconfig 的 skipLibCheck 跳过。
declare module '@hufe921/canvas-editor' {
  export * from '@hufe921/canvas-editor/dist/src/editor'
  export { default } from '@hufe921/canvas-editor/dist/src/editor'
}

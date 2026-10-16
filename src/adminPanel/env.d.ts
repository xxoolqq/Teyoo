/// <reference types="vite/client" />

// tsc 不认识 .vue：声明成通用组件，让 import 通过。模板里的类型由 vite 在
// 编译期处理（@vitejs/plugin-vue），这里只负责让 `npm run typecheck` 不报错。
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

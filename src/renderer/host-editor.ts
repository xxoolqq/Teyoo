// 宿主自己的编辑器外壳 —— `#editor.host-editor`（类名标在 renderer/index.html）。
//
// 为什么不能按 id 取：后台管理系统那一页（src/adminPanel/views/PutTopicView.vue）里
// 也有一块同 id 的壳 —— 它把最外层写成 `<div id="editor" class="put-body">`，为的是
// 直接命中主题里 `#editor .ProseMirror …` 那批排版规则（base.css / premium.css 里
// 一百多处，全部是后代选择器，结构变了照样命中，不必复制规则）。
//
// 而宿主这块 `#editor` 在 index.html 里排在 `#admin-panel` **之后**，而
// document.getElementById 只返回文档里第一个 —— 于是「提交」标签页的
// showSubmitView（main.ts）会把**面板的**编辑区整块搬进 `#submit-preview`：
// 录入页只剩元信息与大提交按钮，提交页里塞着面板的两条工具栏和占位文字；离开提交页时
// 它又被放回 body 的 `#source-editor` 之前（不是面板里），错乱在本次会话里再也回不去。
//
// 约定：凡「宿主自己那块编辑器」一律经这里取；能拿到实例自己 DOM 的地方（标题跳转、
// 搜索面板滚动、表格悬浮条）顺着实例往上找 `closest('#editor')` 更准，也一并避免写死。
// 两者都与文档顺序、面板挂没挂、提交页有没有把块搬走无关。
export function hostEditorEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#editor.host-editor')
}

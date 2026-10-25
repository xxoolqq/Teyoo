// 只读 markdown 预览的统一挂载口。
//
// 范式来自「录入题目」右侧预览（PutTopicView）：预览是**真的 Milkdown 实例**，
// 喂 setMarkdown 就渲染，公式 / 拼音 / 着重号 / 田字格 / 分栏 / 上下标等全部
// 扩展语法与编辑器同一套管线（同一个 createEditor，全部 remark 插件都在注册），
// 不存在「列表页少渲染几种语法」这回事。只读由两件事锁死：
//   - 挂载点外层 CSS pointer-events: none（各页面自己写）
//   - .ProseMirror 的 tabIndex = -1（Tab 键也进不去；contenteditable 是
//     ProseMirror 自己维护的属性，手动改留不住，tabIndex 不归它管）
//
// 在范式之上这里再加一条**全局串行队列**：内核里每个实例的插件是逐个注册的，
// 并发 createEditor 会交错（PutTopicView 注释里的同款问题）。「我录入的题」一页
// 5 张卡各自 onMounted 同时开跑、检索页 / 详情页 / 纠错页的预览又在别的时刻
// 挂载 —— 这些创建必须全世界排成一队，谁也别插队。
import { createEditor, hasEditor, setMarkdown } from '../../renderer/editor/editor'

/**
 * 这个挂载点里是否有一个活着的实例。
 *
 * 不能只问 hasEditor() —— 那问的是「内核记不记得这个 id」，不是「这份 DOM 里
 * 有没有东西」。内核没有 destroy：旧实例会一直留在 editorRecords 里，但它那份
 * DOM 一旦被换掉（HMR 重渲、翻页重挂），注册表里那条就成了死记录。
 * createEditor 收尾是 set(rootId, …)：同 id 再建一次会顶掉死记录，所以能重建。
 */
export function hasLivePreview(rootId: string): boolean {
  return document.getElementById(rootId)?.querySelector('.milkdown') != null
}

/** 只读锁：把 Tab 键挡在正文外面（pointer-events 由各页面的 CSS 负责） */
export function lockPreview(rootId: string): void {
  const el = document.getElementById(rootId)?.querySelector('.ProseMirror')
  if (el instanceof HTMLElement) el.tabIndex = -1
}

async function doMount(rootId: string, markdown: string): Promise<void> {
  // 已有活实例就只刷新内容，不重复建（重复创建会叠加监听器、注册表只增不减）
  if (!hasLivePreview(rootId)) {
    await createEditor(rootId)
    lockPreview(rootId)
  }
  // flushHistory=true：程序化替换不进撤销栈（只读预览没有撤销入口）
  if (hasEditor(rootId)) setMarkdown(markdown, true, rootId)
}

// 全局队列：前一个建完（或失败）才轮到下一个。失败不断链 —— 一张卡挂了
// 不能把后面所有卡的预览都堵死。
let chain: Promise<void> = Promise.resolve()

/**
 * 挂一块只读预览并渲染 markdown。
 *
 * 幂等：挂载点里已有活实例时只做 setMarkdown 刷新（打字防抖刷新走的也是这里，
 * 与 PutTopicView 的 renderPreviews 同效）。
 */
export function mountReadonlyPreview(rootId: string, markdown: string): Promise<void> {
  const run = chain.then(() => doMount(rootId, markdown))
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

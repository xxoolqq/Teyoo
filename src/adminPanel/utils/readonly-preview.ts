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
// 并发 createEditor 会交错（PutTopicView 注释里的同款问题）。「题库管理」一页
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
  // 排队期间挂载点可能已经没了（卡片被重渲/卸载）：直接跳过，不要让 createEditor
  // 抛 "Element not found" 把这一次变成异常（调用方会误以为是渲染器坏了）
  if (!document.getElementById(rootId)) return
  // 已有活实例就只刷新内容，不重复建（重复创建会叠加监听器、注册表只增不减）
  if (!hasLivePreview(rootId)) {
    await createEditor(rootId, (next) => {
      for (const listener of changeListeners.get(rootId) ?? []) listener(next)
    })
    lockPreview(rootId)
  }
  // flushHistory=true：程序化替换不进撤销栈（只读预览没有撤销入口）
  if (hasEditor(rootId)) setMarkdown(markdown, true, rootId)
}

// ── 预览侧发起的修改（图片参数面板）─────────────────────────────────────────
//
// 预览本身不可编辑，唯一能在里面改东西的是「点图片 → 参数面板」，那一改发生在
// 预览实例上（dispatch setNodeMarkup）。宿主需要知道这件事才能把结果写回表单，
// 否则下一次 setMarkdown 会把改动整篇覆盖掉。
//
// 回调挂在实例的 markdownUpdated 上（createEditor 第二参），实例只在首次创建时
// 建一次，所以这里用一张表按 rootId 分发 —— 调用方何时注册都不影响。

type PreviewChangeListener = (markdown: string) => void
const changeListeners = new Map<string, Set<PreviewChangeListener>>()

export function onPreviewChange(rootId: string, listener: PreviewChangeListener): void {
  const set = changeListeners.get(rootId)
  if (set) set.add(listener)
  else changeListeners.set(rootId, new Set([listener]))
}

export function offPreviewChange(rootId: string, listener: PreviewChangeListener): void {
  changeListeners.get(rootId)?.delete(listener)
}

// 全局队列：前一个建完（或失败）才轮到下一个。失败不断链 —— 一张卡挂了
// 不能把后面所有卡的预览都堵死。
let chain: Promise<void> = Promise.resolve()

/**
 * 单个建实例任务的最长等待。
 *
 * 为什么需要：createEditor 里是 `await editor.create()`，一旦某次创建的挂载点
 * 在创建过程中被移出文档（v-if 收起、翻页重渲、组件卸载），内核那边可能永远
 * 等不到布局就挂在那儿。队列是全局的 —— 一个卡住，之后所有页面的预览（题库
 * 卡片、检索结果、导入中心的解析卡）全都不出内容，且没有任何报错。
 */
const MOUNT_TIMEOUT_MS = 8000

function withTimeout(task: Promise<void>, rootId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`预览实例创建超时（${rootId}）`))
    }, MOUNT_TIMEOUT_MS)
    task.then(
      () => {
        window.clearTimeout(timer)
        resolve()
      },
      (error: unknown) => {
        window.clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * 挂一块只读预览并渲染 markdown。
 *
 * 两种路径：
 *   · 已有活实例 → 直接 setMarkdown 刷新，**不进队列**。打字防抖刷新走这里，
 *     排队会让输入明显滞后；更关键的是，一旦队列里有人卡住，刷新不能被连坐。
 *   · 还没有实例 → 进全局队列串行创建（内核插件逐个注册，并发会交错）。
 */
export function mountReadonlyPreview(rootId: string, markdown: string): Promise<void> {
  if (hasLivePreview(rootId) && hasEditor(rootId)) {
    setMarkdown(markdown, true, rootId)
    return Promise.resolve()
  }
  const run = chain.then(() => withTimeout(doMount(rootId, markdown), rootId))
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

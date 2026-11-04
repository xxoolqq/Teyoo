// 录题提交前的图片拆装：把 markdown 里内嵌的 base64 图片换成「ctbimg:// 占位符 +
// File 文件」，对接后端 addSubjectWithImages（multipart，见《addSubjectWithImages
// 前端对接说明》）。
//
// 约定（与后端 MdImageTool 一一对应）：
//   - markdown 中图片位置写 ![任何alt](ctbimg://<图片id>)
//   - 对应文件的 filename 必须是 <图片id>.<扩展名>
//   - 后端取 filename 去扩展名建 id→文件映射，上传 OSS 后把占位符替换成
//     ctbimg://<OSS key>；alt 原样保留，所以样式参数（#宽#高#对齐#样式）不动。
//
// 处理两类图片：
//   1. base64 内嵌图（data:image/...;base64,...）—— 直接拆；
//   2. 本地路径引用（绝对路径 / file:// / 相对路径）—— 先读成 data URL 再拆，
//      见 inlineLocalImages；读不到就报错，不把坏引用提交上去。
// 远程 http(s) URL 原样保留（与占位符一一对应的校验只针对 ctbimg://，远程 URL
// 后端原样放行）。

/** 后端允许的扩展名（png/jpg/jpeg/gif/webp/bmp）对应的 data URL mime */
const EXT_OF_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp'
}

/**
 * 单次请求最多 6 张（先在前端拦下来少跑一趟）。
 *
 * 这个数字跟着后端 MeiliSearchController#addSubjectWithImages 走 —— 它校验
 * `photoList.size() > 6` 就报「图片数量不能超过6张」；ES 版（SubjectController）
 * 那边是 10 张，两个版本不一样，别照反了。
 */
const MAX_PHOTOS = 6
/** 单张 ≤ 5MB */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024
/** 整请求 ≤ 60MB */
const MAX_TOTAL_BYTES = 60 * 1024 * 1024

/** 图片 id：只准字母/数字/_/-，本次请求内唯一即可（题目和答案共用一个 usedIds） */
function genImageId(): string {
  return 'img_' + Math.random().toString(36).slice(2, 10)
}

function dataUrlToFile(b64: string, mime: string, filename: string): File {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], filename, { type: mime })
}

export interface ExtractResult {
  /** base64 图片换成 ctbimg:// 占位符之后的 markdown */
  markdown: string
  /** 拆出来的图片文件，文件名 <图片id>.<扩展名> */
  files: File[]
}

/**
 * 扫一段 markdown，把 base64 内嵌图片全部换成 ctbimg:// 占位符并收集成文件。
 * usedIds 由调用方在题目 / 答案两次调用间共享，保证同一次提交里 id 不重复。
 */
export function extractEmbeddedImages(md: string, usedIds: Set<string>): ExtractResult {
  const files: File[] = []
  // data URL 形态：![alt](data:image/png;base64,iVBORw0KG…)，alt 可含 #宽#高#对齐#样式
  const re = /!\[([^\]]*)\]\(data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)\)/g
  const markdown = md.replace(re, (_whole, alt: string, mime: string, b64: string) => {
    const ext = EXT_OF_MIME[mime]
    if (!ext) throw new Error(`图片格式不支持：${mime}，请另存为 png/jpg/gif/webp/bmp 再插入`)
    let id = genImageId()
    while (usedIds.has(id)) id = genImageId()
    usedIds.add(id)
    files.push(dataUrlToFile(b64, mime, `${id}.${ext}`))
    // alt 原样保留：样式参数在预览和后端渲染时还要用
    return `![${alt}](ctbimg://${id})`
  })
  return { markdown, files }
}

// ─── 本地路径图片（提交前先读成 data URL）──────────────────────────────────
//
// 题干里可以直接写 ![图](D:\a.png) / ![图](images/a.png)（编辑器插图、从别处
// 粘过来的 Markdown 都可能是这种写法）。后端只认 ctbimg:// 占位符 + 文件 part，
// 读不到用户磁盘，所以提交前先把这些引用读成 data URL，再交给
// extractEmbeddedImages 走原来的拆装流程 —— 网络上能读的相对资源（Web 宿主）
// 用 fetch 兜底，绝对路径必须有 electronAPI。

/** 桌面端读本地图片的桥（结构类型，Web 宿主里没有） */
interface LocalImageBridge {
  readMarkdownImage?: (src: string) => Promise<{
    ok: boolean
    dataUrl?: string
    path?: string
    mime?: string
    error?: string
  }>
}

function localImageBridge(): LocalImageBridge {
  return (window as unknown as { electronAPI?: LocalImageBridge }).electronAPI ?? {}
}

/** 已经是「后端认」或「网络图」的引用：base64 / ctbimg 占位符 / http(s) / blob 一律不动 */
const NON_LOCAL_SRC = /^(data:|https?:|ctbimg:|blob:)/i
/** 只认图片扩展名（允许跟 ?#），避免把 .md/.pdf 之类引用也读进来 */
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i

const LOCAL_IMAGE_ERROR: Record<string, string> = {
  EMPTY: '路径为空',
  BAD_PATH: '路径格式不对',
  NOT_FOUND: '找不到该文件',
  NOT_FILE: '不是一个文件',
  TOO_LARGE: '超过 20MB',
  NOT_IMAGE: '不是可识别的图片',
  READ_FAILED: '读取失败'
}

/** 是不是需要读盘的本地图片引用 */
export function isLocalImagePath(src: string): boolean {
  const value = src.trim()
  if (!value || NON_LOCAL_SRC.test(value)) return false
  return IMAGE_PATH.test(value.split(/[?#]/)[0])
}

/**
 * 把 `![alt](<path> "title")` 的括号内容拆成路径与标题后缀。
 *
 * 路径可能带空格：用 <> 包起来的先剥壳；没包壳时只有「末尾带引号的 title」
 * 才当标题切走，其余整段都按路径算（路径里真有引号的情况不考虑）。
 */
function splitImageDest(raw: string): { src: string; title: string } {
  let rest = raw.trim()
  let title = ''
  const titled = /^(.*?)\s+("[^"]*"|'[^']*')$/.exec(rest)
  if (titled) {
    rest = titled[1].trim()
    title = ` ${titled[2]}`
  }
  if (rest.startsWith('<') && rest.endsWith('>')) rest = rest.slice(1, -1).trim()
  return { src: rest, title }
}

/** Web 宿主（没有 electronAPI）的兜底：能 fetch 到的相对资源就转成 data URL */
async function fetchAsDataUrl(src: string): Promise<string | null> {
  try {
    const response = await fetch(src)
    if (!response.ok) return null
    const blob = await response.blob()
    if (!blob.type.startsWith('image/')) return null
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/**
 * 把 markdown 里的本地图片引用读成 data URL（原地替换，alt / 标题不动）。
 *
 * 读不到就抛 —— 提交一份读不出来的引用没有意义，且后端会把它当成外链原样存下，
 * 之后谁也发现不了这张图是坏的。错误文案带上原始路径，用户才知道改哪一处。
 */
export async function inlineLocalImages(md: string): Promise<string> {
  if (!md || !md.includes('![')) return md
  const pattern = /!\[([^\]]*)\]\(([^)]*)\)/g
  const targets: { whole: string; alt: string; src: string; title: string }[] = []
  for (const match of md.matchAll(pattern)) {
    const dest = splitImageDest(match[2])
    if (!isLocalImagePath(dest.src)) continue
    targets.push({ whole: match[0], alt: match[1], src: dest.src, title: dest.title })
  }
  if (targets.length === 0) return md

  const bridge = localImageBridge()
  let result = md
  // 串行读：一张图几 MB，并发读多张只会抢内存
  for (const target of targets) {
    let dataUrl: string | null = null
    if (typeof bridge.readMarkdownImage === 'function') {
      const read = await bridge.readMarkdownImage(target.src)
      if (read.ok && read.dataUrl) {
        dataUrl = read.dataUrl
      } else {
        const reason = LOCAL_IMAGE_ERROR[read.error ?? ''] ?? read.error ?? '未知原因'
        throw new Error(`图片读取失败：${target.src}（${reason}）`)
      }
    } else {
      dataUrl = await fetchAsDataUrl(target.src)
      if (!dataUrl) {
        throw new Error(`当前环境读不到本地图片：${target.src}，请用「浏览」重新插入`)
      }
    }
    // 同一个引用可能出现多次，全部换掉
    result = result.split(target.whole).join(`![${target.alt}](${dataUrl}${target.title})`)
  }
  return result
}

/** 单个本地引用 → data URL（读不到返回 null，不抛）—— 插图弹窗「转 Base64」用 */
export async function readLocalImageAsDataUrl(src: string): Promise<string | null> {
  const bridge = localImageBridge()
  if (typeof bridge.readMarkdownImage === 'function') {
    const read = await bridge.readMarkdownImage(src)
    return read.ok && read.dataUrl ? read.dataUrl : null
  }
  return fetchAsDataUrl(src)
}

/**
 * 提交用入口：先把本地路径图片读成 data URL，再拆成 ctbimg:// 占位符 + 文件。
 * 读图失败会抛（文案已带路径），由调用方 showError。
 */
export async function extractEmbeddedImagesAsync(
  md: string,
  usedIds: Set<string>
): Promise<ExtractResult> {
  const inlined = await inlineLocalImages(md)
  return extractEmbeddedImages(inlined, usedIds)
}

/**
 * 提交前的张数 / 大小校验（后端同样的规则，先拦下来省一次上传）。
 * 返回给用户看的问题文案；没有问题返回 null。
 */
export function checkPhotoLimits(files: File[]): string | null {
  if (files.length === 0) return null
  if (files.length > MAX_PHOTOS) {
    return `图片数量不能超过 ${MAX_PHOTOS} 张（当前 ${files.length} 张），请删减后再提交`
  }
  let total = 0
  for (const f of files) {
    if (f.size === 0) return '存在空图片文件，请重新插入图片'
    if (f.size > MAX_PHOTO_BYTES) return `图片 ${f.name} 超过 5MB，请先压缩再提交`
    total += f.size
  }
  if (total > MAX_TOTAL_BYTES) return '图片总大小超过 60MB，请压缩后再提交'
  return null
}

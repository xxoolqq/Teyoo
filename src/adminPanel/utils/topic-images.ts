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
// 只处理 base64 内嵌图：远程 http(s) URL 原样保留（与占位符一一对应的校验只针对
// ctbimg://，远程 URL 后端原样放行）。

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

// 规约F：子块与分栏 —— remark 插件
//
// 职责：在 remark-parse 产出 mdast 之后，用 lexer.scanRegions 在「原始
// Markdown」（vfile.value）上找出全部合法区域，把整篇文档的根 children
// 重组为：[普通片段解析…, subBlock/cols 节点, …]。
//
// 区域内部内容通过 processor.parse + processor.runSync 递归处理——必须带上
// runSync：milkdown 的解析管线是 remark.runSync(remark.parse(md), md)，
// 所有行内扩展（着重号 / 拼音 / 填空线等）都是「树 transformer」，仅 parse
// 不会执行它们。直接调 processor.parse 会导致子块内部的行内扩展失效。
//
// 嵌套保护：内层 runSync 会再次经过本插件。规约禁止分栏/子块嵌套，因此内层
// 调用传入带 data.__insideColumns 标记的 VFile，本插件检测到标记直接返回，
// 不在内部重复识别区域。
//
// mdast 节点协议（与 schema.ts / stringify.ts 三方闭环，不再改动）：
//   subBlock: { type:'subBlock', boxed:boolean, align:'left'|'center'|'right',
//               children: BlockContent[] }
//   cols:     { type:'cols', spec:string, children: subBlock[] }

/* eslint-disable @typescript-eslint/no-explicit-any */
import { VFile } from 'vfile'
import { scanRegions } from './lexer'

// 内层解析标记（见上）
const INSIDE_FLAG = '__insideColumns'

// 把一棵 mdast 子树的所有 position 偏移从「局部切片坐标」重定位为
// 「整篇原文坐标」。rebase 把局部偏移映射为绝对偏移。
// 这是修复子块内 strong/emphasis marker 错位的关键：milkdown 的
// remarkMarker 插件用 file.value.charAt(node.position.start.offset) 取
// 分隔符字符；子块内容是用独立 VFile（value=去缩进后内部文本）解析的，
// 其 position 是内部局部偏移。外层 transformer（remarkMarker、残余强调
// 重解析等）仍会遍历进 subBlock 子节点，此时 file.value 是整篇原文，若不
// 重定位就会在错误的偏移上取到无关字符（如把 ** 的 marker 取成「下」）。
function rebasePositions(node: any, rebase: (off: number) => number): void {
  if (!node || typeof node !== 'object') return
  if (node.position) {
    const p = node.position
    if (p.start && typeof p.start.offset === 'number') p.start.offset = rebase(p.start.offset)
    if (p.end && typeof p.end.offset === 'number') p.end.offset = rebase(p.end.offset)
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) rebasePositions(child, rebase)
  }
}

// unified attacher：注册时 this 是 processor，捕获下来供 transformer
// 递归解析区域内部内容使用。
export function remarkColumns(this: unknown) {
  const processor = this as {
    parse: (src: string) => { children: any[] }
    runSync: (tree: unknown, file?: unknown) => { children: any[] }
  }
  return function (tree: any, file: any) {
    // 内层（区域内部）解析：跳过容器识别，仅让其它 transformer 正常运行
    if (file?.data?.[INSIDE_FLAG]) return

    const raw = String(file?.value ?? '')
    // 快速失败：不含 @ 的文档无需扫描
    if (!raw.includes('@')) return
    const regions = scanRegions(raw)
    if (regions.length === 0) return

    // 递归解析一段原文：parse（micromark）+ runSync（全部树 transformer），
    // 但用 VFile 标记禁用本插件的容器识别，杜绝嵌套。
    // base：该切片在整篇原文中的起点（普通切片用，偏移与原文线性对应）。
    // map/end：去缩进内部文本专用——局部偏移先查 map 还原到原始切片偏移，
    // 再加 base；越界（指向切片末尾之后）时夹取到 end。
    const parseChildren = (
      src: string,
      base: number,
      map?: number[],
      end?: number
    ): any[] => {
      if (src.trim() === '') return []
      const ast = processor.parse(src)
      const vfile = new VFile({ value: src, data: { [INSIDE_FLAG]: true } })
      const out: any = processor.runSync(ast, vfile)
      const rebase = (off: number): number => {
        if (map) {
          // off < 0 不应出现在合法 position 中，仅作安全兜底。
          // 注意不能用 off <= 0：去缩进后 offset 0 对应原文中第一个
          // 非空白字符（map[0] > 0），若直接返回 base 会指向被去除的
          // 前导空白，导致 remarkMarker 读到空格而非 * / ~，标记丢失。
          if (off < 0) return base
          if (off >= map.length) return end ?? base + map.length
          return base + map[off]
        }
        return base + off
      }
      for (const child of out.children) rebasePositions(child, rebase)
      return out.children
    }

    const children: any[] = []
    let pos = 0
    for (const r of regions) {
      // 区域之前的普通原文：重新解析后原样接回（偏移线性加 pos）
      if (r.start > pos) {
        children.push(...parseChildren(raw.slice(pos, r.start), pos))
      }
      if (r.kind === 'sub') {
        children.push({
          type: 'subBlock',
          boxed: r.boxed,
          align: r.align,
          children: parseChildren(r.inner, r.innerStart, r.innerMap, r.innerEnd),
        })
      } else {
        children.push({
          type: 'cols',
          spec: r.spec,
          children: r.subs.map((s) => ({
            type: 'subBlock',
            boxed: s.boxed,
            align: s.align,
            children: parseChildren(s.inner, s.innerStart, s.innerMap, s.innerEnd),
          })),
        })
      }
      pos = r.end
    }
    // 末尾剩余普通原文
    if (pos < raw.length) {
      children.push(...parseChildren(raw.slice(pos), pos))
    }
    tree.children = children
  }
}

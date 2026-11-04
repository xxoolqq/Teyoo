// MTEF v5 parser + LaTeX emitter.
// Faithful TypeScript port of mtef-go eqn/mtef.go (github.com/zhexiao/mtef-go, Apache-2.0).
//
// Two deliberate deviations from the Go source, both strict improvements:
//  1. readNudge reads the two 0x80 sentinel bytes per the MTEF v5 spec.
//     (The Go version accidentally reads 16 bytes because binary.Read on a
//     Go `int` consumes 8 bytes on 64-bit platforms; it only ever worked on
//     files that contained no nudges at all.)
//  2. readDimensionArrays stops cleanly at EOF instead of spinning forever.

import { CFBFile } from './cfb'
import { Chars, SpecialChar } from './chars'
import {
  EMB,
  FN,
  OPT,
  RecordType,
  SEL,
  type MtAST,
  type MtChar,
  type MtEmbell,
  type MtLine,
  type MtMatrix,
  type MtPile,
  type MtTmpl,
} from './record'

/** Length of the EQNOLEFILEHDR that precedes the MTEF body in "Equation Native". */
const OLE_CB_HDR = 28

/** Little-endian cursor over the MTEF body. Reads past EOF yield null. */
class ByteReader {
  pos = 0
  constructor(private readonly buf: Uint8Array) {}

  u8(): number | null {
    return this.pos < this.buf.length ? this.buf[this.pos++] : null
  }

  u16(): number | null {
    if (this.pos + 2 > this.buf.length) {
      this.pos = this.buf.length
      return null
    }
    const v = this.buf[this.pos] | (this.buf[this.pos + 1] << 8)
    this.pos += 2
    return v
  }

  i16(): number | null {
    const v = this.u16()
    return v === null ? null : v >= 0x8000 ? v - 0x10000 : v
  }

  cstr(): string {
    let s = ''
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos++]
      if (c === 0) break
      s += String.fromCharCode(c)
    }
    return s
  }

  skip(n: number): void {
    this.pos += n
  }
}

/** Nudge: two bytes, or — when either byte is 0x80 — two int16s follow. */
function readNudge(r: ByteReader): { x: number; y: number } {
  const b1 = r.u8() ?? 0
  const b2 = r.u8() ?? 0
  if (b1 === 128 || b2 === 128) {
    return { x: r.i16() ?? 0, y: r.i16() ?? 0 }
  }
  return { x: b1, y: b2 }
}

/** BCD-ish nibble stream: unit byte, then digits, 0x0f terminates an entry. */
function readDimensionArrays(r: ByteReader, size: number): string[] {
  const out: string[] = []
  let flag = true // first nibble of an entry is the unit
  let tmp = ''
  let count = 0

  const fx = (x: number): void => {
    if (flag) {
      switch (x) {
        case 0x00: flag = false; tmp += 'in'; break
        case 0x01: flag = false; tmp += 'cm'; break
        case 0x02: flag = false; tmp += 'pt'; break
        case 0x03: flag = false; tmp += 'pc'; break
        case 0x04: flag = false; tmp += '%'; break
        default: break // invalid nibble, ignore like the reference
      }
    } else if (x === 0x0f) {
      flag = true
      count++
      out.push(tmp)
      tmp = ''
    } else if (x <= 0x09) {
      tmp += String(x)
      flag = false
    } else if (x === 0x0a) {
      tmp += '.'
      flag = false
    } else if (x === 0x0b) {
      tmp += '-'
      flag = false
    }
  }

  while (count < size) {
    const ch = r.u8()
    if (ch === null) break // EOF guard: the Go version would spin forever here
    fx((ch & 0xf0) >> 4)
    fx(ch & 0x0f)
  }
  return out
}

/** Parsed MTEF document: header info + record tree + LaTeX translation. */
export class MTEFv5 {
  mtefVer = 0
  platform = 0
  product = 0
  version = 0
  versionSub = 0
  application = ''
  inline = 0

  /** False when the input contained records this parser cannot express. */
  valid = true

  ast: MtAST | null = null
  private readonly nodes: MtAST[] = []

  constructor(private readonly reader: ByteReader) {}

  // ─── record stream -> flat node list ────────────────────────────────────

  readRecords(): void {
    const r = this.reader
    this.valid = true

    // Header
    this.mtefVer = r.u8() ?? 0
    this.platform = r.u8() ?? 0
    this.product = r.u8() ?? 0
    this.version = r.u8() ?? 0
    this.versionSub = r.u8() ?? 0
    this.application = r.cstr()
    this.inline = r.u8() ?? 0

    // Body
    for (;;) {
      const record = r.u8()
      if (record === null) break

      // FUTURE records carry a byte count so readers can skip them.
      if (record >= RecordType.FUTURE) {
        const skip = r.u8() ?? 0
        r.skip(skip)
        continue
      }

      switch (record) {
        case RecordType.END:
          this.nodes.push({ tag: RecordType.END, children: [] })
          break
        case RecordType.LINE: {
          const line: MtLine = { nudgeX: 0, nudgeY: 0, lineSpace: 0, null: false }
          const options = r.u8() ?? 0
          if (options & OPT.NUDGE) {
            const n = readNudge(r)
            line.nudgeX = n.x
            line.nudgeY = n.y
          }
          if (options & OPT.LINE_LSPACE) line.lineSpace = r.u8() ?? 0
          if (options & OPT.LP_RULER) {
            // tab stop list: n entries of (type u8, offset u16) — content unused
            const nStops = r.u8() ?? 0
            for (let i = 0; i < nStops; i++) {
              r.u8()
              r.u16()
            }
          }
          if (options & OPT.LINE_NULL) line.null = true
          this.nodes.push({ tag: RecordType.LINE, value: line, children: [] })
          break
        }
        case RecordType.CHAR: {
          const char: MtChar = {
            nudgeX: 0, nudgeY: 0, options: 0, typeface: 0, mtcode: 0, bits8: 0, bits16: 0,
          }
          const options = r.u8() ?? 0
          char.options = options
          if (options & OPT.NUDGE) {
            const n = readNudge(r)
            char.nudgeX = n.x
            char.nudgeY = n.y
          }
          char.typeface = r.u8() ?? 0
          if ((options & OPT.CHAR_ENC_NO_MTCODE) === 0) char.mtcode = r.u16() ?? 0
          if (options & OPT.CHAR_ENC_CHAR8) char.bits8 = r.u8() ?? 0
          if (options & OPT.CHAR_ENC_CHAR16) char.bits16 = r.u16() ?? 0
          this.nodes.push({ tag: RecordType.CHAR, value: char, children: [] })
          break
        }
        case RecordType.TMPL: {
          const tmpl: MtTmpl = { nudgeX: 0, nudgeY: 0, selector: 0, variation: 0, options: 0 }
          const options = r.u8() ?? 0
          if (options & OPT.NUDGE) {
            const n = readNudge(r)
            tmpl.nudgeX = n.x
            tmpl.nudgeY = n.y
          }
          tmpl.selector = r.u8() ?? 0
          const byte1 = r.u8() ?? 0
          if (byte1 & 0x80) {
            const byte2 = r.u8() ?? 0
            tmpl.variation = (byte1 & 0x7f) | (byte2 << 8)
          } else {
            tmpl.variation = byte1
          }
          tmpl.options = r.u8() ?? 0
          this.nodes.push({ tag: RecordType.TMPL, value: tmpl, children: [] })
          break
        }
        case RecordType.PILE: {
          const pile: MtPile = { nudgeX: 0, nudgeY: 0, halign: 0, valign: 0 }
          const options = r.u8() ?? 0
          if (options & OPT.NUDGE) {
            const n = readNudge(r)
            pile.nudgeX = n.x
            pile.nudgeY = n.y
          }
          pile.halign = r.u8() ?? 0
          pile.valign = r.u8() ?? 0
          this.nodes.push({ tag: RecordType.PILE, value: pile, children: [] })
          break
        }
        case RecordType.MATRIX: {
          const matrix: MtMatrix = {
            nudgeX: 0, nudgeY: 0, valign: 0, hJust: 0, vJust: 0, rows: 0, cols: 0,
          }
          const options = r.u8() ?? 0
          if (options & OPT.NUDGE) {
            const n = readNudge(r)
            matrix.nudgeX = n.x
            matrix.nudgeY = n.y
          }
          matrix.valign = r.u8() ?? 0
          matrix.hJust = r.u8() ?? 0
          matrix.vJust = r.u8() ?? 0
          matrix.rows = r.u8() ?? 0
          matrix.cols = r.u8() ?? 0
          this.nodes.push({ tag: RecordType.MATRIX, value: matrix, children: [] })
          // The stream contains two LINE records right after a matrix header
          // (row/col partition lines); mirror the reference parser's nodes.
          this.nodes.push({ tag: RecordType.LINE, value: { nudgeX: 0, nudgeY: 0, lineSpace: 0, null: false } as MtLine, children: [] })
          this.nodes.push({ tag: RecordType.LINE, value: { nudgeX: 0, nudgeY: 0, lineSpace: 0, null: false } as MtLine, children: [] })
          break
        }
        case RecordType.EMBELL: {
          const embell: MtEmbell = { options: 0, nudgeX: 0, nudgeY: 0, embellType: 0 }
          const options = r.u8() ?? 0
          embell.options = options
          if (options & OPT.NUDGE) {
            const n = readNudge(r)
            embell.nudgeX = n.x
            embell.nudgeY = n.y
          }
          embell.embellType = r.u8() ?? 0
          this.nodes.push({ tag: RecordType.EMBELL, value: embell, children: [] })
          break
        }
        case RecordType.FONT_STYLE_DEF: {
          const fontDefIndex = r.u8() ?? 0
          const name = r.cstr()
          // not needed for LaTeX output, kept for parity with the record stream
          void fontDefIndex
          void name
          break
        }
        case RecordType.SIZE: {
          r.u8() // lsize
          r.u8() // dsize
          break
        }
        case RecordType.SUB:
          this.nodes.push({ tag: RecordType.SUB, children: [] })
          break
        case RecordType.SUB2:
          this.nodes.push({ tag: RecordType.SUB2, children: [] })
          break
        case RecordType.SYM:
          this.nodes.push({ tag: RecordType.SYM, children: [] })
          break
        case RecordType.SUBSYM:
          this.nodes.push({ tag: RecordType.SUBSYM, children: [] })
          break
        case RecordType.FONT_DEF: {
          const encDefIndex = r.u8() ?? 0
          const name = r.cstr()
          this.nodes.push({ tag: RecordType.FONT_DEF, value: { encDefIndex, name }, children: [] })
          break
        }
        case RecordType.COLOR: {
          r.u8() // color def index
          break
        }
        case RecordType.COLOR_DEF: {
          const options = r.u8() ?? 0
          const n = options & OPT.COLOR_CMYK ? 4 : 3
          for (let i = 0; i < n; i++) r.u16()
          if (options & OPT.COLOR_NAME) r.cstr()
          break
        }
        case RecordType.FULL:
          this.nodes.push({ tag: RecordType.FULL, children: [] })
          break
        case RecordType.EQN_PREFS: {
          r.u8() // options
          let size = r.u8() ?? 0
          readDimensionArrays(r, size)
          size = r.u8() ?? 0
          readDimensionArrays(r, size)
          size = r.u8() ?? 0
          for (let i = 0; i < size; i++) {
            const c = r.u8()
            if (c === null) break
            if (c !== 0) r.u8() // quirk kept from the reference: two bytes per styled entry
          }
          break
        }
        case RecordType.ENCODING_DEF: {
          const enc = r.cstr()
          this.nodes.push({ tag: RecordType.ENCODING_DEF, value: enc, children: [] })
          break
        }
        default:
          this.valid = false
          break
      }
    }
  }

  // ─── flat node list -> tree (stack machine) ─────────────────────────────

  makeAST(): void {
    const root: MtAST = { tag: RecordType.ROOT, children: [] }
    this.ast = root
    const stack: MtAST[] = [root]

    const top = (): MtAST | null => (stack.length > 0 ? stack[stack.length - 1] : null)

    for (const node of this.nodes) {
      switch (node.tag) {
        case RecordType.LINE: {
          const parent = top()
          if (parent) parent.children.push(node)
          if (!(node.value as MtLine).null) stack.push(node)
          break
        }
        case RecordType.TMPL:
        case RecordType.PILE:
        case RecordType.MATRIX: {
          const parent = top()
          if (parent) parent.children.push(node)
          stack.push(node)
          break
        }
        case RecordType.END:
          stack.pop()
          break
        case RecordType.CHAR: {
          const parent = top()
          if (parent) parent.children.push(node)
          else root.children.push(node)
          break
        }
        case RecordType.EMBELL: {
          const parent = top()
          if (parent) {
            parent.children.push(node)
            // Some accents must precede the char in LaTeX (\dot y, \hat y, \bar y)
            // even though MTEF stores them after it: swap the last two children.
            const t = (node.value as MtEmbell).embellType
            if ((t === EMB.DOT1 || t === EMB.HAT || t === EMB.OBAR) && parent.children.length >= 2) {
              const embell = parent.children[parent.children.length - 1]
              const ch = parent.children[parent.children.length - 2]
              parent.children.length -= 2
              parent.children.push(embell, ch)
            }
          }
          stack.push(node)
          break
        }
        default:
          break // SUB/SUB2/SYM/SUBSYM/FULL and metadata records are markers only
      }
    }
  }

  // ─── tree -> LaTeX ──────────────────────────────────────────────────────

  /** Slot text of children[i]; out-of-range slots count as empty. */
  private slot(ast: MtAST, i: number): string {
    const child = ast.children[i]
    return child ? this.makeLatex(child) : ''
  }

  makeLatex(ast: MtAST): string {
    const out: string[] = []

    switch (ast.tag) {
      case RecordType.ROOT:
        out.push('$$ ')
        for (const c of ast.children) out.push(this.makeLatex(c))
        out.push(' $$')
        return out.join('')

      case RecordType.CHAR: {
        const char = ast.value as MtChar
        const mtcode = char.mtcode
        let s = String.fromCharCode(mtcode)

        // typeface >= 128 means (128 + font style); Go does this in uint8
        // arithmetic, so mirror the wrap-around exactly.
        const tf = ((char.typeface - 128) & 0xff) >>> 0
        let hexExtend = ''
        let typefaceFmt = ''
        switch (tf) {
          case FN.MTEXTRA:
          case FN.SPACE:
            hexExtend = '/mathmode'
            break
          case FN.TEXT:
            typefaceFmt = '{ \\rm{ %v } }'
            break
        }

        const hexCode = mtcode.toString(16).padStart(4, '0')
        const hexKey = `char/0x${hexCode}${hexExtend}`

        const extended = Chars[hexKey]
        if (extended !== undefined) {
          s = extended
        } else {
          const special = SpecialChar[s]
          if (special !== undefined) s = special
        }

        // Unmapped code points from the Unicode private use area (MathType
        // font-internal glyphs like MT Extra 0xEE33) have no LaTeX meaning —
        // emitting them verbatim would only produce mojibake.
        if (extended === undefined && mtcode >= 0xe000 && mtcode <= 0xf8ff) s = ''

        if (typefaceFmt !== '') s = typefaceFmt.replace('%v', s)

        return s
      }

      case RecordType.TMPL: {
        const tmpl = ast.value as MtTmpl
        switch (tmpl.selector) {
          case SEL.ANGLE:
          case SEL.PAREN:
          case SEL.BAR:
          case SEL.INTERVAL:
          case SEL.DBAR:
          case SEL.FLOOR:
          case SEL.CEILING:
          case SEL.OBRACK: {
            const mainSlot = this.slot(ast, 0)
            const leftSlot = this.slot(ast, 1)
            const rightSlot = this.slot(ast, 2)
            const mainStr = mainSlot !== '' ? `{ ${mainSlot} }` : ''
            const leftStr = leftSlot !== '' ? `\\left ${leftSlot}` : ''
            const rightStr = rightSlot !== '' ? `\\right ${rightSlot}` : ''
            return `${leftStr} ${mainStr} ${rightStr}`
          }
          case SEL.BRACE: {
            let mainSlot = ''
            let leftSlot = ''
            let rightSlot = ''
            for (let idx = 0; idx < ast.children.length; idx++) {
              const l = this.makeLatex(ast.children[idx])
              if (idx === 0) mainSlot = l
              else if (idx === 1) leftSlot = l
              else rightSlot = l
            }
            const rightStr = rightSlot === '' ? '.' : ` ${rightSlot}`
            return `\\left ${leftSlot} \\begin{array}{l} ${mainSlot} \\end{array} \\right${rightStr}`
          }
          case SEL.BRACK: {
            const mainSlot = this.slot(ast, 0)
            const leftSlot = this.slot(ast, 1)
            const rightSlot = this.slot(ast, 2)
            const mainStr = mainSlot === '' ? '\\space' : mainSlot
            return `\\left${leftSlot} ${mainStr} \\right${rightSlot}`
          }
          case SEL.ROOT: {
            const mainSlot = this.slot(ast, 0)
            const radiSlot = this.slot(ast, 1)
            return `\\sqrt[${radiSlot}] { ${mainSlot} }`
          }
          case SEL.FRACT: {
            const numSlot = this.slot(ast, 0)
            const denSlot = this.slot(ast, 1)
            return `\\frac { ${numSlot} } { ${denSlot} }`
          }
          case SEL.ARROW: {
            const topSlot = this.slot(ast, 0)
            const bottomSlot = this.slot(ast, 1)
            const topStr = topSlot !== '' ? `{\\mathrm{ ${topSlot} }}` : ''
            const bottomStr = bottomSlot !== '' ? `[\\mathrm{ ${bottomSlot} }]` : ''

            // variation decoding kept from the reference (same semantics)
            const variationsMap: Record<number, string> = {
              0x0000: 'single',
              0x0001: 'double',
              0x0002: 'harpoon',
              0x0004: 'topSlotPresent',
              0x0008: 'bottomSlotPresent',
              0x0010: 'pointLeft',
              0x0020: 'pointRight',
            }
            const variationsCode = [0x0000, 0x0001, 0x0002, 0x0004, 0x0008, 0x0010, 0x0020]

            let arrowStyle = 'single'
            let latexFmt = '\\x'
            for (const vCode of variationsCode) {
              if ((vCode & tmpl.variation) !== 0) {
                const name = variationsMap[vCode]
                if (name === 'double') arrowStyle = 'double'
                else if (name === 'harpoon') arrowStyle = 'harpoon'

                if (arrowStyle === 'single' && name === 'pointLeft') latexFmt += 'leftarrow'
                else if (arrowStyle === 'double' && name === 'pointLeft') {
                  // not implemented in the reference either (large over small)
                } else if (arrowStyle === 'harpoon' && name === 'pointLeft') {
                  // not implemented in the reference either
                }

                if (arrowStyle === 'single' && name === 'pointRight') latexFmt += 'rightarrow'
                else if (arrowStyle === 'double' && name === 'pointRight') {
                  // not implemented in the reference either (small over large)
                } else if (arrowStyle === 'harpoon' && name === 'pointRight') {
                  // not implemented in the reference either
                }
              }
            }
            return `${latexFmt} ${bottomStr} ${topStr}`
          }
          case SEL.UBAR: {
            const mainSlot = this.slot(ast, 0)
            const mainStr = mainSlot !== '' ? ` {\\underline{ ${mainSlot} }} ` : ''
            return ` ${mainStr} `
          }
          case SEL.SUM:
          // tmINTEG is not handled by the Go reference (it yields an empty
          // result on files containing integrals); all BigOp-class templates
          // share tmSUM's slot layout, so they are handled the same way here
          // (falls through on purpose).
          case SEL.INTEG:
          case SEL.PROD:
          case SEL.COPROD:
          case SEL.UNION:
          case SEL.INTER:
          case SEL.INTOP:
          case SEL.SUMOP: {
            let mainSlot = ''
            let lowerSlot = ''
            let upperSlot = ''
            let operatorSlot = ''
            for (let idx = 0; idx < ast.children.length; idx++) {
              const l = this.makeLatex(ast.children[idx])
              if (idx === 0) mainSlot = l
              else if (idx === 1) lowerSlot = l
              else if (idx === 2) upperSlot = l
              else operatorSlot += l
            }
            const mainStr = mainSlot !== '' ? `{ ${mainSlot} }` : ''
            const lowerStr = lowerSlot !== '' ? `\\limits_{ ${lowerSlot} }` : ''
            const upperStr = upperSlot !== '' ? `^ ${upperSlot}` : ''
            return `${operatorSlot} ${lowerStr} ${upperStr} ${mainStr}`
          }
          case SEL.LIM: {
            let mainSlot = ''
            let lowerSlot = ''
            for (let idx = 0; idx < ast.children.length; idx++) {
              const l = this.makeLatex(ast.children[idx])
              if (idx === 0) mainSlot = l
              else if (idx === 1) lowerSlot = l
            }
            const mainStr = mainSlot !== '' ? `\\mathop { ${mainSlot} }` : ''
            const lowerStr = lowerSlot !== '' ? `\\limits_{ ${lowerSlot} }` : ''
            return `${mainStr} ${lowerStr} `
          }
          case SEL.SUP: {
            const subSlot = this.slot(ast, 0)
            const supSlot = this.slot(ast, 1)
            let s = ' ^ { ' + supSlot + ' } '
            if (subSlot !== '') s += ' { ' + subSlot + ' } '
            return s
          }
          case SEL.SUB:
          case SEL.SUBSUP: {
            const subSlot = this.slot(ast, 0)
            const supSlot = this.slot(ast, 1)
            const subFmt = subSlot !== '' ? `_{ ${subSlot} }` : ''
            const supFmt = supSlot !== '' ? `^{ ${supSlot} }` : ''
            return `${subFmt}  ${supFmt}`
          }
          case SEL.VEC: {
            const mainSlot = this.slot(ast, 0)
            const mainStr = mainSlot !== '' ? `{ ${mainSlot} }` : ''
            const variationsMap: Record<number, string> = {
              0x0001: 'left',
              0x0002: 'right',
              0x0004: 'tvVE_UNDER',
              0x0008: 'harpoonup',
            }
            const variationsCode = [0x0001, 0x0002, 0x0004, 0x0008]
            let topStr = '\\overset\\'
            for (const vCode of variationsCode) {
              if ((vCode & tmpl.variation) !== 0) topStr += variationsMap[vCode]
            }
            if (tmpl.variation < 8) topStr += 'arrow'
            return `${topStr} ${mainStr}`
          }
          case SEL.HAT: {
            const mainSlot = this.slot(ast, 0)
            const topSlot = this.slot(ast, 1)
            const mainStr = mainSlot !== '' ? `{ ${mainSlot} }` : ''
            const topStr = topSlot !== '' ? ` ${topSlot} ` : ''
            return `${topStr} ${mainStr}`
          }
          case SEL.ARC: {
            const mainSlot = this.slot(ast, 0)
            const topSlot = this.slot(ast, 1)
            const mainStr = mainSlot !== '' ? `{ ${mainSlot} }` : ''
            const topStr = topSlot !== '' ? `\\overset ${topSlot}` : ''
            return `${topStr} ${mainStr}`
          }
          default:
            this.valid = false
            break
        }
        // unknown template: still emit its children (reference behaviour)
        for (const c of ast.children) out.push(this.makeLatex(c))
        return out.join('')
      }

      case RecordType.PILE: {
        for (let idx = 0; idx < ast.children.length; idx++) {
          if (idx > 0) out.push(' \\\\ ')
          out.push(this.makeLatex(ast.children[idx]))
        }
        return out.join('')
      }

      case RecordType.MATRIX: {
        const matrix = ast.value as MtMatrix
        const matrixCol = matrix.cols
        for (let idx = 0; idx < ast.children.length; idx++) {
          if (idx === 0) {
            out.push(' \\begin{array} {} ')
            continue
          }
          out.push(this.makeLatex(ast.children[idx]))
          if (idx % matrixCol === 0) out.push(' \\\\ ')
          else out.push(' & ')
        }
        out.push(' \\end{array} ')
        return out.join('')
      }

      case RecordType.LINE: {
        for (const c of ast.children) out.push(this.makeLatex(c))
        return out.join('')
      }

      case RecordType.EMBELL: {
        const embellType = (ast.value as MtEmbell).embellType
        switch (embellType) {
          case EMB.DOT1:
            return ' \\dot '
          case EMB.PRIME1:
            return "'"
          case EMB.PRIME2:
            return "''"
          case EMB.PRIME3:
            return "'''"
          case EMB.HAT:
            return ' \\hat '
          case EMB.OBAR:
            return ' \\bar '
          default:
            return ''
        }
      }

      default:
        return ''
    }
  }

  translate(): string {
    if (!this.ast) return ''
    const latex = this.makeLatex(this.ast)
    return this.valid ? latex : ''
  }
}

// ─── public entry points ──────────────────────────────────────────────────

/**
 * Parse raw MTEF v5 bytes (i.e. the Equation Native body without the
 * 28-byte EQNOLEFILEHDR) into a document.
 */
export function parseMtef(body: Uint8Array): MTEFv5 {
  const eqn = new MTEFv5(new ByteReader(body))
  eqn.readRecords()
  eqn.makeAST()
  return eqn
}

/**
 * Extract the "Equation Native" stream from a MathType OLE object
 * (.bin file from word/embeddings) and return the MTEF body bytes.
 */
export function extractEquationNative(oleBuffer: Uint8Array): Uint8Array | null {
  let cfb: CFBFile
  try {
    cfb = new CFBFile(oleBuffer)
  } catch {
    return null
  }
  const stream = cfb.getStream('Equation Native')
  if (!stream) return null

  // EQNOLEFILEHDR: cbHdr u16, version u32, cf u16, cbSize u32
  if (stream.length < OLE_CB_HDR) return null
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  const cbHdr = dv.getUint16(0, true)
  if (cbHdr !== OLE_CB_HDR) return null
  let cbSize = dv.getUint32(8, true)
  if (OLE_CB_HDR + cbSize > stream.length) cbSize = stream.length - OLE_CB_HDR
  return stream.subarray(OLE_CB_HDR, OLE_CB_HDR + cbSize)
}

/**
 * Convert a MathType OLE object (.bin from word/embeddings) to a LaTeX string.
 * Returns "" when the object cannot be parsed.
 */
export function oleToLatex(oleBuffer: Uint8Array): string {
  const body = extractEquationNative(oleBuffer)
  if (!body) return ''
  const eqn = parseMtef(body)
  return eqn.translate()
}

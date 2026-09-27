// MTEF v5 record tags, option bits, template selectors and AST node types.
// Ported from mtef-go eqn/record.go (github.com/zhexiao/mtef-go, Apache-2.0).

/** MTEF record type byte. */
export const RecordType = {
  END: 0,
  LINE: 1,
  CHAR: 2,
  TMPL: 3,
  PILE: 4,
  MATRIX: 5,
  EMBELL: 6,
  RULER: 7,
  FONT_STYLE_DEF: 8,
  SIZE: 9,
  FULL: 10,
  SUB: 11,
  SUB2: 12,
  SYM: 13,
  SUBSYM: 14,
  COLOR: 15,
  COLOR_DEF: 16,
  FONT_DEF: 17,
  EQN_PREFS: 18,
  ENCODING_DEF: 19,
  FUTURE: 100,
  ROOT: 255,
} as const
export type RecordType = (typeof RecordType)[keyof typeof RecordType]

/** Option bit masks shared by several record kinds. */
export const OPT = {
  NUDGE: 0x08,
  CHAR_EMBELL: 0x01,
  CHAR_FUNC_START: 0x02,
  CHAR_ENC_CHAR8: 0x04,
  CHAR_ENC_CHAR16: 0x10,
  CHAR_ENC_NO_MTCODE: 0x20,
  LINE_NULL: 0x01,
  LP_RULER: 0x02,
  LINE_LSPACE: 0x04,
  COLOR_CMYK: 0x01,
  COLOR_SPOT: 0x02,
  COLOR_NAME: 0x04,
} as const

/** MathType font function styles (typeface - 128 in CHAR records). */
export const FN = {
  TEXT: 1,
  FUNCTION: 2,
  VARIABLE: 3,
  LCGREEK: 4,
  UCGREEK: 5,
  SYMBOL: 6,
  VECTOR: 7,
  NUMBER: 8,
  USER1: 9,
  USER2: 10,
  MTEXTRA: 11,
  TEXT_FE: 12,
  EXPAND: 22,
  MARKER: 23,
  SPACE: 24,
} as const

/** TMPL record selector values. */
export const SEL = {
  ANGLE: 0,
  PAREN: 1,
  BRACE: 2,
  BRACK: 3,
  BAR: 4,
  DBAR: 5,
  FLOOR: 6,
  CEILING: 7,
  OBRACK: 8,
  INTERVAL: 9,
  ROOT: 10,
  FRACT: 11,
  UBAR: 12,
  OBAR: 13,
  ARROW: 14,
  INTEG: 15,
  SUM: 16,
  PROD: 17,
  COPROD: 18,
  UNION: 19,
  INTER: 20,
  INTOP: 21,
  SUMOP: 22,
  LIM: 23,
  HBRACE: 24,
  HBRACK: 25,
  LDIV: 26,
  SUB: 27,
  SUP: 28,
  SUBSUP: 29,
  DIRAC: 30,
  VEC: 31,
  TILDE: 32,
  HAT: 33,
  ARC: 34,
  JSTATUS: 35,
  STRIKE: 36,
  BOX: 37,
} as const

/** Embellishment record types. */
export const EMB = {
  DOT1: 2,
  DOT2: 3,
  DOT3: 4,
  PRIME1: 5,
  PRIME2: 6,
  BPRIME: 7,
  TILDE: 8,
  HAT: 9,
  NOT: 10,
  RARROW: 11,
  LARROW: 12,
  BARROW: 13,
  R1ARROW: 14,
  L1ARROW: 15,
  MBAR: 16,
  OBAR: 17,
  PRIME3: 18,
  FROWN: 19,
  SMILE: 20,
  X_BARS: 21,
  UP_BAR: 22,
  DOWN_BAR: 23,
  DOT4: 24,
  U_1DOT: 25,
  U_2DOT: 26,
  U_3DOT: 27,
  U_4DOT: 28,
  U_BAR: 29,
  U_TILDE: 30,
  U_FROWN: 31,
  U_SMILE: 32,
  U_RARROW: 33,
  U_LARROW: 34,
  U_BARROW: 35,
  U_R1ARROW: 36,
  U_L1ARROW: 37,
} as const

export interface MtLine {
  nudgeX: number
  nudgeY: number
  lineSpace: number
  /** Marks a placeholder line with no content (MtefOptLineNull). */
  null: boolean
}

export interface MtChar {
  nudgeX: number
  nudgeY: number
  options: number
  /** Raw typeface byte: values >= 128 are (128 + font style). */
  typeface: number
  mtcode: number
  bits8: number
  bits16: number
}

export interface MtTmpl {
  nudgeX: number
  nudgeY: number
  selector: number
  variation: number
  options: number
}

export interface MtPile {
  nudgeX: number
  nudgeY: number
  halign: number
  valign: number
}

export interface MtMatrix {
  nudgeX: number
  nudgeY: number
  valign: number
  hJust: number
  vJust: number
  rows: number
  cols: number
}

export interface MtEmbell {
  options: number
  nudgeX: number
  nudgeY: number
  embellType: number
}

export interface MtFontDef {
  encDefIndex: number
  name: string
}

export interface MtFontStyleDef {
  fontDefIndex: number
  name: string
}

/** Generic parse tree node produced from the flat record list. */
export interface MtAST {
  tag: number
  value?: unknown
  children: MtAST[]
}

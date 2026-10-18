import { visit } from 'unist-util-visit'

// remark-math treats any two `$` signs on a line as inline LaTeX, so prices
// like "价格 $5，成本 $6" or "$5.00 | $6.00" in a table row render as broken
// formulas. Obsidian applies the same guard: spans that look like currency or
// plain prose fall back to literal text; real LaTeX keeps rendering.
function looksLikeLatex(value: string): boolean {
  // LaTeX commands and structures: \frac, ^, _, {a}
  if (/[\\^_{}]/.test(value)) return true
  // Bare symbols: $x$, $xy$
  if (/^[a-zA-Z\s]+$/.test(value)) return true
  // Function notation: f(0), g(x), sin(x) — a letter directly followed by a
  // parenthesised argument. Currency spans ($5.00) never look like this, but
  // without this rule they fell through every other check and were turned
  // back into literal text.
  if (/[a-zA-Z]\s*\(.*\)/.test(value)) return true
  // Algebra: letters combined with operators, e.g. a+b, y=2x. `:` is the
  // ratio sign in geometry spans like $AB:AC$, and only counts when a letter
  // is present — pure-number spans like $9:30$ (a time) stay literal.
  if (/[a-zA-Z]/.test(value) && /[=+\-*/:<>]/.test(value)) return true
  // Numeric arithmetic: $1+1=2$, $3*4/2$. The guard used to require letters,
  // so $$1+1=2$$ (remark-math parses a same-line $$…$$ as INLINE math) was
  // turned into literal text — the reported "$$ sometimes not recognised".
  // Plain numbers / punctuation without these operators ($5.00, $123$) still
  // fall back to currency / prose.
  if (/[=+\-*/]/.test(value)) return true
  return false
}

interface MathGuardNode {
  value?: unknown
  position?: {
    start?: { offset?: number }
    end?: { offset?: number }
  }
}

interface MathGuardParent {
  children: unknown[]
}

interface MathGuardFile {
  value?: unknown
}

export function remarkMathFalsePositiveGuard(): (tree: unknown, file?: MathGuardFile) => void {
  return (tree: unknown, file?: MathGuardFile) => {
    visit(
      tree as never,
      'inlineMath',
      (node: MathGuardNode, index: number | null, parent: MathGuardParent | null | undefined) => {
        if (index === null || index === undefined || !parent) return
        const value = String(node.value ?? '')
        // A `$$…$$` span has no currency use: doubled dollars are an explicit
        // math fence (display intent, same convention Obsidian uses), so keep
        // it whatever the content looks like ($$123$$, $$3.14$$, …).
        const source = typeof file?.value === 'string' ? file.value : null
        const start = node.position?.start?.offset
        const end = node.position?.end?.offset
        const original =
          source !== null && typeof start === 'number' && typeof end === 'number' && end > start
            ? source.slice(start, end)
            : null
        if (original !== null && original.startsWith('$$')) return
        if (looksLikeLatex(value)) return
        // Fall back to literal text WITHOUT altering what the user typed: the
        // original delimiters (single or double `$`) come from the source
        // slice; only synthesise `$…$` when no position information exists.
        parent.children[index] = { type: 'text', value: original ?? `$${value}$` }
      }
    )
  }
}

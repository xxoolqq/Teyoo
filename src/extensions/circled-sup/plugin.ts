import type { MilkdownPlugin } from '@milkdown/kit/ctx'

import { circledSupSchema } from './schema'
import { circledSupInputRule } from './input-rule'

export const circledSupPlugin = [
  circledSupSchema,
  circledSupInputRule,
] as unknown as MilkdownPlugin[]

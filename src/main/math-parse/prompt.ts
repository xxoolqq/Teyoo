// 拆题 Prompt 的「拼装器」。
// ────────────────────────────────────────────────────────────────────────────
//
// 提示词正文在库（prompt_table），这里只负责三件事：
//   ① 按顺序把四段拼起来：core → subject_type → knowledge_point → answer
//   ② 把 {{占位符}} 换成本次真实数据（科目名、学段、题型清单、知识点清单）
//   ③ 末尾追加一段**代码内置**的【输出格式】
//
// easy / source / referenced_images 三个字段的取值口径**不在这里**：它们写在库里
// core 的【一、题目切分】末尾（跟着切分一起定），代码只做校验与兜底 —— easy 只认
// "1"~"5"（非法回落 "3"），source 模型不给就用试卷标题，referenced_images 与正文
// 扫出来的图片合并去重。
//
// 题型分类与知识点标注各在库里存两份（选中 / 没选中），由调用方按开关挑好再
// 传进来（见 question-bank.resolveParsePrompts）。所以这里的 blocks.subjectType /
// blocks.knowledgePoint 永远是「本次要注入的那一份」：关掉时注入的是那句禁止文案，
// 段位仍然在，模型不会因为缺了【二】【三】而自行发挥 —— 事前的约束比事后丢弃
// （parse.ts 里那些兜底）便宜得多。
//
// 输出格式留在代码里，且**与开关无关**：它只描述 JSON 的形状，字段怎么取值是
// 各段（库里的文案）的职责。改它必须同时改 parse.ts 的解析逻辑，放表里只会让
// 人以为改表就能改结构，改完解析直接崩。
//
// 全文件不认识任何具体学科代码：「能不能用公式」由 subject.lock_formula 决定，
// 「有哪些题型/知识点」由调用方查好传进来。

export interface PromptOption {
  code: string
  name: string
}

/**
 * 从 prompt_table 查出来的四段提示词。
 *
 * `subjectType` / `knowledgePoint` 装的是**本次该注入的那一份**：开关开着是带
 * 清单的「选中」文案，关着是不许输出该字段的「没选中」文案。空串只可能是
 * 「启用但清单为空」（知识点词表没配）—— 那种情况按段跳过，见 buildSystemPrompt。
 */
export interface PromptBlocks {
  core: string
  subjectType: string
  knowledgePoint: string
  answer: string
}

export interface SystemPromptOptions {
  blocks: PromptBlocks
  /** 是否启用题型分类（决定【二】段与 subject_type_code 的取值方式） */
  classifySubjectType: boolean
  /** 是否启用知识点标注（决定【三】段与 knowledge_points 的取值方式） */
  annotateKnowledge: boolean
  /** 科目名，用于替换 {{SUBJECT_NAME}} */
  subjectName: string
  /** 学段 primary / junior / senior / other，用于替换 {{STAGE_LABEL}} */
  stage: string
  /** 本次可选题型（已按科目 + 学段筛过） */
  subjectTypes: readonly PromptOption[]
  /** 本次可选知识点；为空时不拼知识点段 */
  knowledgePoints: readonly PromptOption[]
  /** 提示词里出现未知占位符、或某段被跳过时的告警出口 */
  onWarn?: (message: string) => void
}

const STAGE_LABELS: Record<string, string> = {
  primary: '小学',
  junior: '初中',
  senior: '高中',
  other: '通用'
}

/**
 * 学段代码 → 中文标签。导出供单题「AI 生成解析」复用：那条通道不拼整卷
 * system prompt，但要自己替换 core/answer 段里的 {{STAGE_LABEL}}。
 */
export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? '通用'
}

/**
 * 输出 JSON 契约 —— 与开关无关的一份静态描述。
 *
 * 字段怎么取值（从清单里挑题型、按词表标知识点、还是干脆留空）由库里的【二】【三】
 * 各自说明，格式段只说形状。这样多一个开关也不会多出第二种格式，parse.ts 只按
 * 这一份契约取值。
 */
function outputFormat(): string {
  return `【输出格式】
只输出一个 JSON 对象，不要包 \`\`\`json 代码块。字符串内的换行写成 \\n，LaTeX 反斜杠按 JSON 规范写成 \\\\。
{
  "questions": [
    {
      "content": "题干",
      "answer_markdown": "答案与解析",
      "subject_type_code": "题型代码",
      "knowledge_points": [],
      "easy": "3",
      "source": null,
      "referenced_images": []
    }
  ]
}
只输出上面这 7 个字段，不要输出 source_id、metadata、splits、category_* 等额外字段，也不要加解释性文字。`
}

/**
 * 拼出 System Prompt。
 *
 * 四段的顺序是固定的：core → subject_type → knowledge_point → answer，末尾再接
 * 代码内置的【固定字段】【输出格式】。
 *
 * `blocks.subjectType` / `blocks.knowledgePoint` 已经是「按开关挑好的那一份」，
 * 这里不再看开关决定拼不拼 —— 关掉时拼进去的是禁止文案，段位照样在。
 * 唯一的口子是「启用知识点但清单为空」：那段文案里带 {{KNOWLEDGE_POINTS}}，
 * 填成空白比不拼更糟，所以跳过并告警。
 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const typesText = options.subjectTypes.length
    ? options.subjectTypes.map((t) => `${t.code}（${t.name}）`).join(' / ')
    : '（未提供题型清单，无法判断时用 detailed_answer）'

  const pointsText = options.knowledgePoints.map((p) => `[${p.code}, ${p.name}]`).join('\n')

  // 占位符也要跟着开关走：core 段里若引用了 {{SUBJECT_TYPES}} / {{KNOWLEDGE_POINTS}}，
  // 光跳过【二】【三】段是不够的 —— 整份词表仍会被填进去，省 token 的前提就没了。
  const vars: Record<string, string> = {
    SUBJECT_NAME: options.subjectName,
    STAGE_LABEL: stageLabel(options.stage),
    SUBJECT_TYPES: options.classifySubjectType ? typesText : '（本期不判断题型）',
    FIRST_SUBJECT_TYPE: options.classifySubjectType
      ? (options.subjectTypes[0]?.code ?? 'detailed_answer')
      : '',
    KNOWLEDGE_POINTS: options.annotateKnowledge ? pointsText : '',
    KNOWLEDGE_POINT_COUNT: options.annotateKnowledge
      ? String(options.knowledgePoints.length)
      : '0'
  }

  const fill = (text: string): string =>
    text.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (raw: string, name: string) => {
      const value = vars[name]
      if (value === undefined) {
        // 未知占位符原样留着：拼错的占位符会直接出现在 prompt 里，比静默变空好查
        options.onWarn?.(`提示词里有未知占位符 {{${name}}}（已原样保留）`)
        return raw
      }
      return value
    })

  const parts: string[] = [fill(options.blocks.core)]

  // 【二】题型：选中时是「从清单里挑一个」，没选中时是「一律空字符串」——
  // 两份文案都在库里，调用方按开关挑好传进来，这里只管拼。
  parts.push(fill(options.blocks.subjectType))

  // 【三】知识点：同上。唯一的例外是「启用但词表为空」——那段文案要靠
  // {{KNOWLEDGE_POINTS}} 才有意义，填空清单等于让模型自由发挥，跳过更安全。
  if (options.annotateKnowledge && options.knowledgePoints.length === 0) {
    options.onWarn?.('已启用知识点标注，但本次没有知识点清单：该段已跳过，knowledge_points 将为空')
  } else {
    parts.push(fill(options.blocks.knowledgePoint))
  }

  parts.push(fill(options.blocks.answer), outputFormat())

  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n')
}

/**
 * User Message：试卷源码本身。
 *
 * 只加了两行元信息（标题 + 分隔），其余原样 —— 任何额外的解释性文字都会挤占
 * 模型的注意力，而这段输入可能长达几万字符（一整份试卷）。
 */
export function buildUserMessage(markdown: string, title?: string): string {
  const head = title?.trim() ? `【试卷标题】${title.trim()}\n【试卷源码】\n` : ''
  return `${head}${markdown}`
}

// 提示词种子数据：只灌「高中数学」这一组，其它学段/科目等真实配置好再往 prompt_table 里加。
//
// 为什么放代码里：这些是种子，只在库为空时写一次，之后以库为准（用户在表里改）。
// 放代码能 git diff、能回滚，也不怕首次启动时表还没建。
//
// 每段的分工（顺序即拼装顺序）。可勾选的能力各有「选中 / 没选中」两份：
//   core_prompt                 角色 + 切题 + 公式锁定      —— 每科每学段一份，差异最大
//   subject_type_prompt         题型判定 + 取值域（选中）   —— 必须带 {{SUBJECT_TYPES}}
//   subject_type_prompt_off     不判题型的禁止项（没选中）  —— 不带清单，缺行用内置默认
//   knowledge_point_prompt      知识点判定 + 引文要求（选中）—— 必须带 {{KNOWLEDGE_POINTS}}
//   knowledge_point_prompt_off  不标知识点的禁止项（没选中）—— 缺行用内置默认
//   answer_prompt_generate      允许现场推导的答案规则
//   answer_prompt_extract       只提取原卷答案的答案规则
//
// 输出 JSON 格式不放表里：它是程序契约（字段名与 parse.ts 对齐），不是教研内容，
// 改它必须同时改代码，放在表里只会让人以为改表就能改结构。
//
// 注意：种子只在**建库时**灌一次（见 store.ts 的 migrateV3），已经跑起来的老库不会
// 补上 `_off` 这两行 —— 所以它们必须有内置默认（就是本文件下面两个常量），
// 缺行时由 resolveParsePrompts 顶上，而不是报 BAD_PROMPT。

/** 一条种子：prompt_type / 文案 */
export interface PromptSeed {
  promptType: string
  prompt: string
}

const CORE_SENIOR_MATH = `你是一位资深{{STAGE_LABEL}}{{SUBJECT_NAME}}教研专家。请阅读输入的试卷源码，把它切分成题目列表，并输出 JSON。

【一、题目切分】
1. 一个题号 = 一条 question：选择题的 A/B/C/D、大题下的 (1)(2) 小问、同一题的表格与配图都属于同一条，不要拆成多条，也不要把两道题合成一条。
2. 题干去掉题号、分值、「本小题共 X 分」、页码与页眉页脚；题干里夹带的答案、下划线里的答案要擦掉，留空占位。
3. 原文里的图片语法（如 \`![描述](路径)\`）、「（如图）」「（如表）」这类指代描述必须原样保留，不得删除或改写。
4. 原文里的 \`[公式待核对]\`、\`[公式结构待核对]\`、\`[特殊字符待核对]\` 等标记连同紧随的预览图原样保留，不得猜测或补写公式。
5. 小问之间、选项之间用空行分隔；选择题每个选项单独一行，写成 \`A． ……\`。
6. 原文有的字一个都不能少，原文没有的字一个都不能加：不要摘要、不要合并、不要重排。

每条题在切分时一并定下三个字段：
· \`easy\`：难度取 "1"~"5"，按解题本身所需的步数与方法判断 —— 1 很易（一步直接得出）；2 易（一两步常规运算）；3 中（需组合两三个知识点或中等计算量）；4 难（需构造、分类讨论或多步推导）；5 拔高（压轴层次，需较强技巧或较长推理链）。只判断题面难易，不揣测学生水平；确实判断不了就给 "3"。
· \`source\`：该题在原文中的出处，写成「卷名或章节·题号」这种可定位的短标签（如 "2024 北京卷·二.18"、"期中卷·选择题 7"）；原文没有卷头或来源信息时给 null，不要编造学校名、年份或考试名称。
· \`referenced_images\`：一律 []。题干用到的图片由程序从正文的图片语法里自动收集，不需要你填写。

【公式锁定】
正文中形如 \`<mathbank-math id="MBM_...">公式</mathbank-math>\` 的片段是只读公式：在原位置把它替换成 \`[[完整 id]]\`，每处只替换一次，不得遗漏、重复、改名，也不得把同一个 id 放进两道题。\`[[id]]\` 已代表公式原本的定界符，直接放回正文即可，不要再加 \`$\`。若某处不使用 id，就必须把标签内的公式连同 \`$...$\` 逐字抄下来，不得化简或重排。\`answer_markdown\` 里引用题干中的公式时，可以再次使用同一个 id（同一道题内答案与题干各出现一次不算重复）；但同一道题的题干里同一个 id 只能出现一次，也不得把某题公式的 id 用在另一道题上。`

const SUBJECT_TYPE_SENIOR_MATH = `【二、题型分类】
每条题的 \`subject_type_code\` 只能从以下取值里选一个：{{SUBJECT_TYPES}}。无法判断时用 \`detailed_answer\`。`

const KNOWLEDGE_POINT_SENIOR_MATH = `【三、知识点标注】
只使用下列稳定编码，不得新建点、按名称猜编码，也不得输出其它来源的编号。清单共 {{KNOWLEDGE_POINT_COUNT}} 条，是你唯一可以挑选的范围：
{{KNOWLEDGE_POINTS}}

每题输出 knowledge_points 数组（最多 12 项，无法可靠匹配时返回 []）。每项格式：
{"code":"清单里的编码","role":"main或auxiliary","evidence_source":"content或answer_markdown","evidence":"该字段中逐字连续引用的短原文","target_evidence":"题干直接目标原文，或 1~12 条原文组成的数组","reason":"简短分类理由","scope":"可选，如第(1)问"}

判定要求：
1. main 必须对应题干直接要求完成的目标（求什么、判断什么、证明什么），并由题干目标引文证明；方法类点只有在题干明确要求使用、判断或证明该方法时才能是 main，原解采用的手段不自动成为 main。
2. auxiliary 只给本次解析里确实出现、且能逐字引用关键步骤的方法；只有最终答案、选项字母、孤立结论不算可核对解析，没有就不输出。
3. 不同小问有独立目标时分别覆盖；同一编码覆盖多个目标时合并为一项并保留各目标引文；不为凑数加标签，也不为减数量漏小问。
4. evidence 与 target_evidence 都必须逐字来自本题对应字段，不得改写、化简、拼接，不引用清单、题头或其它题目；reason 必须非空。`

/**
 * 「没勾」时注入的默认文案。与学科无关，所以既是种子也是缺行时的兜底
 * （见 store.ts 的 resolveParsePrompts）。
 *
 * 只写禁止项、不复述格式：格式在 prompt.ts 那份静态契约里，段文案只回答
 * 「这个字段这次要不要给值、给什么」。
 */
export const DEFAULT_SUBJECT_TYPE_PROMPT_OFF = `【二、题型分类】
本次不做题型判断：每条题的 \`subject_type_code\` 一律空字符串 ""。不要从清单里挑选，也不要自造题型代码。`

export const DEFAULT_KNOWLEDGE_POINT_PROMPT_OFF = `【三、知识点标注】
本次不做知识点标注：每题的 \`knowledge_points\` 一律空数组 []。不要输出编码、名称、依据或理由。`

const ANSWER_GENERATE_SENIOR_MATH = `【四、答案】
- 原卷自带参考答案与解析时：只提取原文，\`answer_markdown\` 开头写 \`[EXTRACTED_ORIGINAL]\`，不得改写、压缩或补写。
- 原卷没有答案时：允许现场推导，写出完整解题过程与最终结论，开头写 \`[AI_GENERATED]\`。
- 推导采用 LaTeX 与中文混排（公式写在 \`$...$\` 里），分步骤用空行分段；不得只给一个最终答案就结束。`

const ANSWER_EXTRACT_SENIOR_MATH = `【四、答案】
- 只提取原卷中明确自带的参考答案与解析，\`answer_markdown\` 开头写 \`[EXTRACTED_ORIGINAL]\`。
- 原卷无答案时，\`answer_markdown\` 必须是空字符串 ""，绝对不要现场推导或编造。
- 题干只有题目没有解析时，宁可留空，也不要写「本题考查……」之类的评述。`

const SUBJECT_TYPE_OFF_SEED: PromptSeed = {
  promptType: 'subject_type_prompt_off',
  prompt: DEFAULT_SUBJECT_TYPE_PROMPT_OFF
}

const KNOWLEDGE_POINT_OFF_SEED: PromptSeed = {
  promptType: 'knowledge_point_prompt_off',
  prompt: DEFAULT_KNOWLEDGE_POINT_PROMPT_OFF
}

/**
 * 「没选中」那两行。单独导出是给 v4 迁移用的：老库（user_version=3）里没有这两行，
 * 升级时补上，用户在表里就能看到并改它们 —— 否则只能吃代码里的默认文案。
 */
export const SEED_PROMPT_OFF_SENIOR_MATH: readonly PromptSeed[] = [
  SUBJECT_TYPE_OFF_SEED,
  KNOWLEDGE_POINT_OFF_SEED
]

/** 高中数学（course=0001, stage=senior）的七段提示词（三个能力各两份 + 核心） */
export const SEED_PROMPT_SENIOR_MATH: readonly PromptSeed[] = [
  { promptType: 'core_prompt', prompt: CORE_SENIOR_MATH },
  { promptType: 'subject_type_prompt', prompt: SUBJECT_TYPE_SENIOR_MATH },
  SUBJECT_TYPE_OFF_SEED,
  { promptType: 'knowledge_point_prompt', prompt: KNOWLEDGE_POINT_SENIOR_MATH },
  KNOWLEDGE_POINT_OFF_SEED,
  { promptType: 'answer_prompt_generate', prompt: ANSWER_GENERATE_SENIOR_MATH },
  { promptType: 'answer_prompt_extract', prompt: ANSWER_EXTRACT_SENIOR_MATH }
]

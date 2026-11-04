// 教材大纲（人教 A 版）—— 拆题时用来约束 category_compulsory / chapter / knowledge。
// ────────────────────────────────────────────────────────────────────────────
//
// MathBank 那边是运行时从 SQLite 的章节树读出来的（build_curriculum_text），
// Teyoo 没有那套库，先把大纲固化在这里：
//
//   · 只有「册 → 章 → 小节」三层，顺序即教材目录顺序 —— prompt 里那条
//     「多模块融合题取位置最靠后的模块」完全依赖这个插入顺序，所以这里的
//     书写顺序是有语义的，不要按字母/编号重排；
//   · 增删章节只改这一处，prompt 文本与本地校验同时生效（两者共用同一棵树，
//     保证「模型能选的」与「本地肯认的」永远一致）。
//
// 章节名带序号（"1. 集合与常用逻辑用语"）、小节名带章节号（"1.1 集合的概念"），
// 与模型输出逐字比对，不做任何归一化 —— 归一化会让「1.1」和「1.10」互相通融。

export type CurriculumTree = Record<string, Record<string, readonly string[]>>

export const CURRICULUM: CurriculumTree = {
  必修一: {
    '1. 集合与常用逻辑用语': [
      '1.1 集合的概念',
      '1.2 集合间的基本关系',
      '1.3 集合的基本运算',
      '1.4 充分条件与必要条件',
      '1.5 全称量词与存在量词'
    ],
    '2. 一元二次函数、方程和不等式': [
      '2.1 等式性质与不等式性质',
      '2.2 基本不等式',
      '2.3 二次函数与一元二次方程、不等式'
    ],
    '3. 函数的概念与性质': [
      '3.1 函数的概念及其表示',
      '3.2 函数的基本性质',
      '3.3 幂函数',
      '3.4 函数的应用(一)'
    ],
    '4. 指数函数与对数函数': [
      '4.1 指数',
      '4.2 指数函数',
      '4.3 对数',
      '4.4 对数函数',
      '4.5 函数的应用(二)'
    ],
    '5. 三角函数': [
      '5.1 任意角和弧度制',
      '5.2 三角函数的概念',
      '5.3 诱导公式',
      '5.4 三角函数的图象与性质',
      '5.5 三角恒等变换',
      '5.6 函数y=Asin(wx+φ)',
      '5.7 三角函数的应用'
    ]
  },
  必修二: {
    '6. 平面向量及其应用': [
      '6.1 平面向量的概念',
      '6.2 平面向量的运算',
      '6.3 平面向量基本定理及坐标表示',
      '6.4 平面向量的应用'
    ],
    '7. 复数': ['7.1 复数的概念', '7.2 复数的四则运算', '7.3 复数的三角表示'],
    '8. 立体几何初步': [
      '8.1 基本立体图形',
      '8.2 立体图形的直观图',
      '8.3 简单几何体的表面积与体积',
      '8.4 空间点、直线、平面之间的位置关系',
      '8.5 空间直线、平面的平行',
      '8.6 空间直线、平面的垂直'
    ],
    '9. 统计': ['9.1 随机抽样', '9.2 用样本估计总体', '9.3 统计案例'],
    '10. 概率': ['10.1 随机事件与概率', '10.2 事件的相互独立性', '10.3 频率与概率']
  },
  选修一: {
    '1. 空间向量与立体几何': [
      '1.1 空间向量及其运算',
      '1.2 空间向量基本定理',
      '1.3 空间向量及其运算的坐标表示',
      '1.4 空间向量的应用'
    ],
    '2. 直线和圆的方程': [
      '2.1 直线的倾斜角和斜率',
      '2.2 直线的方程',
      '2.3 直线的交点坐标与距离公式',
      '2.4 圆的方程',
      '2.5 直线与圆、圆与圆的位置关系'
    ],
    '3. 圆锥曲线的方程': ['3.1 椭圆', '3.2 双曲线', '3.3 抛物线']
  },
  选修二: {
    '4. 数列': ['4.1 数列的概念', '4.2 等差数列', '4.3 等比数列', '4.4 数学归纳法'],
    '5. 一元函数的导数及其应用': [
      '5.1 导数的概念及其意义',
      '5.2 导数的运算',
      '5.3 导数在研究函数中的应用'
    ]
  },
  选修三: {
    '6. 计数原理': [
      '6.1 分类加法计数原理与分步乘法计数原理',
      '6.2 排列与组合',
      '6.3 二项式定理'
    ],
    '7. 随机变量及其分布': [
      '7.1 条件概率与全概率公式',
      '7.2 离散型随机变量及其分布列',
      '7.3 离散型随机变量的数字特征',
      '7.4 二项分布与超几何分布',
      '7.5 正态分布'
    ],
    '8. 成对数据的统计分析': [
      '8.1 成对数据的统计相关性',
      '8.2 一元线性回归模型及其应用',
      '8.3 列联表与独立性检验'
    ]
  }
}

/** 渲染成 prompt 里的教材大纲段（格式与 MathBank 的 build_curriculum_text 一致） */
export function buildCurriculumText(tree: CurriculumTree = CURRICULUM): string {
  const lines: string[] = []
  for (const [book, chapters] of Object.entries(tree)) {
    lines.push(`- ${book}:`)
    for (const [chapter, sections] of Object.entries(chapters)) {
      lines.push(`  - ${chapter}: [${sections.map((s) => `'${s}'`).join(', ')}]`)
    }
  }
  return lines.join('\n')
}

export interface CurriculumVerdict {
  compulsory: string
  chapter: string
  /** 空串 = 整章待细分（合法值） */
  knowledge: string
  /** 逐级降级时记下的原因；全对则为空数组 */
  problems: string[]
}

/**
 * 校验/降级教材位置。
 *
 * 逐级降级而不是整条丢弃：册对了章错了 → 留册、清章；章对了小节错了 → 清小节。
 * 因为「小节不确定就留空」本来就是协议允许的，而丢掉册次会让整个分类白做。
 * 册次对不上则全清（模型多半把「选择性必修」之类旧称写出来了）。
 */
export function verifyCurriculum(
  compulsory: unknown,
  chapter: unknown,
  knowledge: unknown,
  tree: CurriculumTree = CURRICULUM
): CurriculumVerdict {
  const problems: string[] = []
  const book = typeof compulsory === 'string' ? compulsory.trim() : ''
  const chap = typeof chapter === 'string' ? chapter.trim() : ''
  const section = typeof knowledge === 'string' ? knowledge.trim() : ''

  const chapters = tree[book]
  if (!chapters) {
    if (book) problems.push(`category_compulsory「${book}」不在教材大纲内`)
    if (chap || section) problems.push('册次无效，已清空章节与小节')
    return { compulsory: '', chapter: '', knowledge: '', problems }
  }
  if (!chap) return { compulsory: book, chapter: '', knowledge: '', problems }
  const sections = chapters[chap]
  if (!sections) {
    problems.push(`category_chapter「${chap}」不属于「${book}」，已清空`)
    return { compulsory: book, chapter: '', knowledge: '', problems }
  }
  if (!section) return { compulsory: book, chapter: chap, knowledge: '', problems }
  if (!sections.includes(section)) {
    problems.push(`category_knowledge「${section}」不是「${chap}」的小节，已清空`)
    return { compulsory: book, chapter: chap, knowledge: '', problems }
  }
  return { compulsory: book, chapter: chap, knowledge: section, problems }
}

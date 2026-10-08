// 可视化解题：题型模板
// ─────────────────────────────────────────────────────────────────────────────
// 点一下就把"这道题按什么套路讲"补进指令里 —— 同一个模型，给不给套路，出来的
// 东西差很多：不给的话它爱跳步、爱直接抛答案；给了"每步注明依据"，步骤就齐了。
//
// 这一层刻意做得很轻：不写题型判断、不做自动分类，就是几条**可编辑的提示词片段**
// （用户自己也能在题目里写，模板只是省事）。要加新题型，往这个数组里加一条即可。

export interface SolveTemplate {
  id: string
  /** 按钮上的短名 */
  label: string
  /** 追加到题目后面的要求（写进用户消息，不是系统提示词） */
  requirement: string
}

export const SOLVE_TEMPLATES: SolveTemplate[] = [
  {
    id: 'algebra',
    label: '代数',
    requirement: '按初中代数的方式分步解，每一步注明依据（等式性质 / 运算法则 / 配方等）。'
  },
  {
    id: 'geometry',
    label: '几何',
    requirement:
      '平面几何：先写已知与求证，再逐步证明，每步注明所用定理；需要时给出 ```figure 指令画出图形与辅助线。'
  },
  {
    id: 'function',
    label: '函数',
    requirement:
      '先求定义域与关键点（零点、顶点、极值、渐近线），再用 ```plot 画出图像并标出关键点，最后结合图像下结论。'
  },
  {
    id: 'calculus',
    label: '微积分',
    requirement: '写清用到的公式与换元 / 分部 / 洛必达等过程，中间不要跳步，最后给出结论。'
  },
  {
    id: 'probability',
    label: '概率统计',
    requirement: '先写样本空间与事件，再算概率（必要时列分布表），最后给出结论与单位。'
  },
  {
    id: 'exam',
    label: '考试作答',
    requirement: '按考试答题格式写：步骤简洁、关键式子和最终答案突出，不要多余的解释与寒暄。'
  }
]

export function findTemplate(id: string | null): SolveTemplate | null {
  if (!id) return null
  return SOLVE_TEMPLATES.find((item) => item.id === id) ?? null
}

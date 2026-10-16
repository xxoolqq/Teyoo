// 后端端点表。路径与 ctbapp 的 utils/urlConfig.js 一字不差，只是换成了 TypeScript。
//
// 两个 base：7088 是业务后端，8088 是检索（ElasticSearch）那一路。

// 这套界面只跑在 ColaMD 里（file:// 页面没有同源可言，只能打绝对地址），
// 所以两个 base 默认指向本机。后端换了地方就用环境变量盖：
//   VITE_ADMIN_API_BASE  业务后端（7088）
//   VITE_ADMIN_API2_BASE 检索后端（8088）
const BASE = (import.meta.env.VITE_ADMIN_API_BASE as string | undefined) ?? 'http://localhost:7088/'
const BASE2 =
  (import.meta.env.VITE_ADMIN_API2_BASE as string | undefined) ?? 'http://localhost:8088/'

export const API_BASE = BASE
export const API2_BASE = BASE2

export const endpoints = {
  // ── 账号 ────────────────────────────────────────────────────────────────
  /** 登录。返回 data.qq 就是 token */
  login: `${BASE}background/login2/sq.do`,
  /** 图形验证码（GET，带 uuid 参数） */
  codeMa: `${BASE}background/createImageCode/sq.do`,
  register: `${BASE}background/register/sq.do`,
  register2: `${BASE}background/register2/sq.do`,
  forgetPasswdStep1: `${BASE}background/forget/passwd/step_1/sq.do`,
  forgetPasswdStep2: `${BASE}background/forget/passwd/step_2/sq.do`,
  forgetPasswdStep4: `${BASE}background/forget/passwd/step_4/sq.do`,
  provinceCity: `${BASE}background/province/city/sq.do`,
  countryData: `${BASE}background/city/country/sq.do`,

  // ── 题目 ────────────────────────────────────────────────────────────────
  submitSubject: `${BASE}background/add/subject.do`,
  fixErrorSubject: `${BASE}background/fix/error/subject.do`,
  getSubjectByExerciseCode: `${BASE}background/get/subject/by/exercise/code.do`,
  myTopic: `${BASE}background/get/teacher/upload/exercises.do`,
  /** 检索（走 ES） */
  search: `${BASE2}elastic/search/match/query.do/?name=ctbindex&field=subjectSelf`,
  /** 按 id 取题目（走 ES） */
  getSubjectById: `${BASE2}elastic/document/api.do`,

  // ── 图床 ────────────────────────────────────────────────────────────────
  photoUpload: `${BASE}background/photo/upload/sq.do`,
  myPhotoBed: `${BASE}background/photo/list.do`,

  // ── 题海拾贝 / 统计 ─────────────────────────────────────────────────────
  pickShellSearchId: `${BASE}background/pick/shell/search_id.do`,
  pickShell: `${BASE}background/pick/shell/tj2.do`,
  pickShellDownload: `${BASE}background/pick/shell/tj/sq/download.do`,
  errorSubjectTJ: `${BASE}background/error/subject/tj.do`,
  exportMdFile: `${BASE}background/error/subject/tj/sq/exports.do`,

  // ── 班级 ────────────────────────────────────────────────────────────────
  classScores: `${BASE}background/course/class/scores.do`,
  addScore: `${BASE}background/add/score.do`,
  scanScore: `${BASE}background/scan/score.do`,
  createClass: `${BASE}background/create/class.do`,
  scanUlimitClassList: `${BASE}background/ulimit/scan/list/class.do`,
  scanClassList: `${BASE}background/scan/list/class.do`,
  updateClassName: `${BASE}background/update/classname.do`,
  checkJoinApply: `${BASE}background/check/join/apply.do`,
  checkJoinAction: `${BASE}background/check/join/action.do`,
  checkJoinList: `${BASE}background/check/join/stu_teacher_list.do`,

  // ── 在线 OCR（Web 端没有本地 Texo 时的退路）─────────────────────────────
  tencentOcr: `${BASE}background/tencent/ocr/sq.do`,
  baiduOcr: `${BASE}background/baidu/ocr/sq.do`,
  mathPix: `${BASE}background/hand/math/text/sq.do`
} as const

export type EndpointKey = keyof typeof endpoints

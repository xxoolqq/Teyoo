// 后端端点表。路径与 ctbapp 的 utils/urlConfig.js 一字不差，只是换成了 TypeScript。
//
// 两个 base：7088 是业务后端，

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
  /**
   * 统一登录（2026-10-23 起只有这一个，老师与家长共用，旧的 login2 已下线）：
   * 入参 LoginArgs{ phone, passwd, codeMa, uuid }，返回 ResponseLogin，
   * token 在 data.token 里（旧接口是 data.qq）。
   */
  login: `${BASE}background/login/v1/sq.do`,
  /** 图形验证码（GET，带 uuid 参数） */
  codeMa: `${BASE}background/createImageCode/sq.do`,
  /** 学生注册 */
  register: `${BASE}background/register/sq.do`,
  /**
   * 统一注册（家长 / 教师）：入参 RegisterArgs，其中 userType 只认 parent / teacher。
   * data 返回后端生成的用户代码（5~7 位数字）。
   */
  register2: `${BASE}background/register2/v1/sq.do`,
  forgetPasswdStep1: `${BASE}background/forget/passwd/step_1/sq.do`,
  forgetPasswdStep2: `${BASE}background/forget/passwd/step_2/sq.do`,
  forgetPasswdStep4: `${BASE}background/forget/passwd/step_4/sq.do`,
  provinceCity: `${BASE}background/province/city/sq.do`,
  countryData: `${BASE}background/city/country/sq.do`,

  // ── 题目 ────────────────────────────────────────────────────────────────
  /**
   * 录入纯文本题目（无图）。走 MeiliSearch 版（MeiliSearchController）：
   * 入参与 ES 版 /background/add/subject.do 完全相同（@RequestBody SubjectArgs），
   * 区别只在索引写入 MeiliSearch 而不是 ES。
   */
  submitSubject: `${BASE}meili/add/subject.do`,
  /**
   * 提交带图片的题目（multipart：args=JSON，photos=图片文件，可多个）。
   * 同样是 MeiliSearch 版，入参形状与 ES 版一致；但**图片上限是 6 张**
   * （ES 版是 10 张），见 utils/topic-images.ts 的 MAX_PHOTOS。
   */
  submitSubjectWithImages: `${BASE}meili/add/subject/with/images.do`,
  /**
   * 纠错（改题）。同样走 MeiliSearch 版：入参与 ES 版一致（SubjectArgs，
   * 多传 subjectID=题号、id=MySQL 主键），区别只在索引更新写 MeiliSearch。
   * 必须和上面两个录入接口用同一套索引 —— 一边写 Meili、一边写 ES，
   * 改完的题在检索里会一直是旧内容。
   */
  fixErrorSubject: `${BASE}meili/fix/error/subject.do`,
  getSubjectByExerciseCode: `${BASE}background/get/subject/by/exercise/code.do`,
  myTopic: `${BASE}background/get/teacher/upload/exercises.do`,
  /**
   * 检索（MeiliSearchController#matchQuery）。
   *
   * 与录入 / 纠错写的是同一个索引（MeiliSearch），所以检索也必须走这条 ——
   * 走 ES 版的话新录的题搜不到、改过的题是旧内容。
   *
   * 入参与返回跟 ES 版一模一样（POST @RequestBody SearchArgs →
   * List<ExerciseDoc>），只有 name 不同：这里要传 Meili 的索引名 ctb_index，
   * 不是 ES 的 ctbindex。
   */
  search: `${BASE}meili/search/match/query.do`,
  /** 按 id 取题目（走 ES） */
  getSubjectById: `${BASE2}elastic/document/api.do`,

  // ── 我的收藏（FavoriteController）───────────────────────────────────────
  /** 收藏 / 取消收藏切换：data=true 已收藏，false 已取消；超 200 条返回 2001 */
  favoriteToggle: `${BASE}background/favorite/toggle.do`,
  /**
   * 我的收藏分页（join 题目全字段 + favoriteTime，md 中图片占位符
   * 已替换为可访问 URL，前端直接拼接下载即可）
   */
  favoriteList: `${BASE}background/favorite/list.do`,
  /** 批量查询题目收藏状态（data=已收藏的题号数组，列表页标星用） */
  favoriteStatus: `${BASE}background/favorite/status.do`,

  // ── 图床 ────────────────────────────────────────────────────────────────
  photoUpload: `${BASE}background/photo/upload/sq.do`,
  myPhotoBed: `${BASE}background/photo/list.do`,

  // ── 纠错审核 ─────────────────────────────────────────────────────────────
  /**
   * 待审核纠错工单列表（SubjectCorrectionController，分页）。
   * submitterCode 传当前教师码：后端拿它查 teacher.is_reviewer，不是审核人直接 2001。
   */
  correctionPendingList: `${BASE}background/correction/pending/list.do`,
  /** 纠错工单详情（correctionId = 工单主键） */
  correctionDetail: `${BASE}background/correction/detail.do`,
  /**
   * 审核纠错工单：action='approve'（通过，变更应用到原题并同步索引）/
   * 'reject'（驳回，只关工单）。通过时后端还会做 base_hash 冲突检测，
   * 原题在工单提交后被改过会返回 2001 提示驳回重报。
   */
  correctionReview: `${BASE}background/correction/review.do`,

  // ── 题海拾贝 / 统计 ─────────────────────────────────────────────────────
  pickShellSearchId: `${BASE}background/pick/shell/search_id.do`,
  pickShell: `${BASE}background/pick/shell/tj2.do`,
  pickShellDownload: `${BASE}background/pick/shell/tj/sq/download.do`,
  errorSubjectTJ: `${BASE}background/error/subject/tj.do`,
  exportMdFile: `${BASE}background/error/subject/tj/sq/exports.do`,

  // ── 班级 ────────────────────────────────────────────────────────────────
  classScores: `${BASE}background/course/class/scores.do`,
  /**
   * 成绩录入页面「确定」用的：按班级分页返回班里的孩子
   * （user_class 中 user_type='parent' 且 child_code 非空，姓名取自 child.student_name）。
   * 返回 PageInfo<UserClass>：{ id, classCode, userCode, realName, childCode, ... }
   */
  classChildInfo: `${BASE}background/get/class/childinfo.do`,
  addScore: `${BASE}background/add/score.do`,
  /** 某学生某科目的历史成绩（ScoreAddController.scanScore） */
  scanScore: `${BASE}background/scan/history/score.do`,
  createClass: `${BASE}background/create/class.do`,
  /**
   * 老师自己的班级列表（ClassController.scanListClass，分页）。
   * 返回 PageInfo<TeacherClassVo>：自己创建的 + 自己申请过的（applying 也在内），
   * 每行带 applyStatus / memberRole。旧的 ulimit/scan/list/class.do 已下线。
   */
  scanClassList: `${BASE}background/scan/list/class.do`,
  updateClassName: `${BASE}background/update/classname.do`,
  checkJoinApply: `${BASE}background/check/join/apply.do`,
  checkJoinAction: `${BASE}background/check/join/action.do`,
  /**
   * 审核页：某班级的加入申请列表（ClassController.checkJoinStuList）。
   * 旧路径 check/join/stu_teacher_list.do 已下线，后端改成了 get/user/class/list.do，
   * 同时去掉了「当前用户在该班是不是审核中」的拦截。
   */
  checkJoinList: `${BASE}background/get/user/class/list.do`,
  /**
   * 家长给孩子加入班级（ClassController.joinClassStep02，App 的 step2）。
   * 入参 JoinClassArgs{ token, childCode, classCode }，直接往 user_class 插一条
   * apply_status='applying' 的记录，仍需老师在「审核加入」里通过。
   */
  joinClassStep2: `${BASE}background/join/class/step_2/sq.do`,

  // ── 我的 → 孩子（ChildController）────────────────────────────────────────
  /** 家长账号下的孩子列表（附当前已通过的主班级） */
  childList: `${BASE}background/child/list.do`,
  /** 新增孩子，data 返回新生成的 childCode */
  childAdd: `${BASE}background/child/add.do`,
  /** 修改孩子资料（只能改自己名下的孩子） */
  childUpdate: `${BASE}background/child/update.do`,
  /** 孩子详情（只能查自己名下的孩子） */
  childDetail: `${BASE}background/child/detail.do`,
  /** 孩子已加入的班级（已通过审核，按入班时间倒序，最多 10 条） */
  childJoinedClasses: `${BASE}background/get/child/joined/classes.do`,

  // ── 在线 OCR（Web 端没有本地 Texo 时的退路）─────────────────────────────
  tencentOcr: `${BASE}background/tencent/ocr/sq.do`,
  baiduOcr: `${BASE}background/baidu/ocr/sq.do`,
  mathPix: `${BASE}background/hand/math/text/sq.do`
} as const

export type EndpointKey = keyof typeof endpoints

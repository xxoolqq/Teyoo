import { computed, reactive } from 'vue'
import type { LoginData } from '../api/auth'

// 登录态的持久化分两条路：
//   - 桌面端（有 window.electronAPI）：token（登录返回的 token 字段）经 IPC 存进主进程
//     safeStorage 加密，其余字段存 electron-store（见主进程 session-store.ts）。
//     明文不再落 localStorage。
//   - Web 构建宿主没有 electronAPI：退回 localStorage，key 与 ctbapp 完全一致
//     （token / userInfo / phone / userCode / schoolCode / userType），同域登录态互通。
const KEY = {
  token: 'token',
  userInfo: 'userInfo',
  phone: 'phone',
  userCode: 'userCode',
  schoolCode: 'schoolCode',
  userType: 'userType'
} as const

// 隐私模式/禁用存储的环境里 localStorage 会直接抛，读写都兜一层：存不下就当
// 没登录，至少界面不会崩
function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function write(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* 存不下就算了，不该因为存储失败打断登录流程 */
  }
}

// 主进程 session-store 的三条通道（preload 里声明的 ElectronAPI 成员），只在
// 桌面端宿主里存在；Web 构建拿不到 → null
interface SessionBridge {
  saveAdminSession: (data: Record<string, unknown>) => Promise<boolean>
  loadAdminSession: () => Promise<Record<string, unknown> | null>
  clearAdminSession: () => Promise<boolean>
}

function bridge(): SessionBridge | null {
  const api = (
    window as unknown as { electronAPI?: Partial<SessionBridge> }
  ).electronAPI
  if (api?.saveAdminSession && api.loadAdminSession && api.clearAdminSession) {
    return api as SessionBridge
  }
  return null
}

export interface Session {
  /** Sa-Token 的值，每个请求带在 token 请求头里 */
  token: string
  phone: string
  userCode: string
  /** 学校代码：登录返回里带（common_user.school_code），创建班级 / 录题 / 加减分都要传 */
  schoolCode: string
  /**
   * 新登录接口不再返回（后端改用 RBAC 的 roles / permissions）。源码里只剩
   * 「申请加入班级」还在传它，暂时会是空串，等那个接口也改成按 token 取身份再删。
   */
  userType: string
}

// 初始为空；真正的内容由 initSession() 在应用挂载前填进来（app.ts 里 await）
export const session = reactive<Session>({
  token: '',
  phone: '',
  userCode: '',
  schoolCode: '',
  userType: ''
})

export const isLoggedIn = computed(() => session.token !== '')

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/** 把登录返回 data（或主进程还原出的同形状对象）填进内存 session */
function fillSession(data: Record<string, unknown>): void {
  // 新接口（login/v1）token 在 data.token；旧接口（login2）放在 data.qq。
  // 后者是迁移老登录态用的，新登录不会再走到那条分支。
  session.token = str(data.token) || str(data.qq)
  session.phone = str(data.phone)
  session.userCode = str(data.userCode)
  session.schoolCode = str(data.schoolCode)
  session.userType = str(data.userType)
}

let inited = false

/**
 * 应用挂载前调用一次（app.ts）：桌面端从主进程（safeStorage + electron-store）
 * 拉登录态，Web 构建从 localStorage 拉之后再挂路由，beforeEach 的门禁才不会
 * 把已登录的用户误判成没登录。
 */
export async function initSession(): Promise<void> {
  if (inited) return
  inited = true
  const b = bridge()
  if (b) {
    try {
      const data = await b.loadAdminSession()
      if (data) fillSession(data)
    } catch {
      /* 读失败当没登录 */
    }
    // 迁移：token 进 safeStorage 之前的版本把登录态存在 localStorage 里
    // （含明文 token）。主进程里还没有时，把那一份搬进新存储，顺手清掉明文 ——
    // 不搬的话老用户升级后第一次打开全是 401，还得莫名其妙重登一遍。
    if (!session.token) {
      try {
        const legacyRaw = localStorage.getItem(KEY.userInfo)
        const legacy =
          legacyRaw && typeof JSON.parse(legacyRaw) === 'object'
            ? (JSON.parse(legacyRaw) as Record<string, unknown>)
            : null
        const token = read(KEY.token)
        if (legacy && token) {
          legacy.token = token
          fillSession(legacy)
          void b.saveAdminSession(legacy).catch(() => {
            /* 搬不进去就保持现状：内存里有 token，本次会话仍可用 */
          })
          for (const key of Object.values(KEY)) write(key, '')
        }
      } catch {
        /* 迁移失败就当没有，走正常登录 */
      }
    }
    return
  }
  // Web：localStorage 同步可读
  session.token = read(KEY.token)
  session.phone = read(KEY.phone)
  session.userCode = read(KEY.userCode)
  session.schoolCode = read(KEY.schoolCode)
  session.userType = read(KEY.userType)
}

/** 登录成功：写内存 + 落盘（桌面走 IPC，Web 走 localStorage） */
export function saveSession(data: LoginData): void {
  fillSession(data as unknown as Record<string, unknown>)

  const b = bridge()
  if (b) {
    // 桌面端：主进程里存。同时清掉历史版本留在 localStorage 里的明文 token。
    void b.saveAdminSession(data as unknown as Record<string, unknown>).catch(() => {
      /* 存不进去也不打断登录，只是下次要重新登录 */
    })
    for (const key of Object.values(KEY)) write(key, '')
    return
  }
  // Web：与 ctbapp 存的字段一致
  write(KEY.token, session.token)
  write(KEY.phone, session.phone)
  write(KEY.userCode, session.userCode)
  write(KEY.schoolCode, session.schoolCode)
  write(KEY.userType, session.userType)
  try {
    localStorage.setItem(KEY.userInfo, JSON.stringify(data))
  } catch {
    /* 同上 */
  }
}

export function clearSession(): void {
  session.token = ''
  session.phone = ''
  session.userCode = ''
  session.schoolCode = ''
  session.userType = ''
  // Web 构建清 localStorage；桌面端顺手把历史版本留在里面的明文也清掉
  for (const key of Object.values(KEY)) write(key, '')
  void bridge()?.clearAdminSession().catch(() => {
    /* 清不掉就算了 */
  })
}

import { computed, reactive } from 'vue'
import type { LoginData } from '../api/auth'

// localStorage 的 key 与 ctbapp 完全一致（token / userInfo / phone / userCode /
// schoolCode / userType）。这样同一域名下的 Web 站和老 ctbapp 登录态互通，
// 老用户不用重新登录。
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

export interface Session {
  token: string
  phone: string
  userCode: string
  schoolCode: string
  userType: string
}

export const session = reactive<Session>({
  token: read(KEY.token),
  phone: read(KEY.phone),
  userCode: read(KEY.userCode),
  schoolCode: read(KEY.schoolCode),
  userType: read(KEY.userType)
})

export const isLoggedIn = computed(() => session.token !== '')

/** 登录成功：写内存 + 落 localStorage（与 ctbapp 存的字段一致） */
export function saveSession(data: LoginData): void {
  session.token = data.qq ?? ''
  session.phone = data.phone ?? ''
  session.userCode = data.userCode ?? ''
  session.schoolCode = data.schoolCode ?? ''
  session.userType = data.userType ?? ''

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
  for (const key of Object.values(KEY)) write(key, '')
}

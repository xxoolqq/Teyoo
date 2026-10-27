// 后台管理系统（src/adminPanel）的登录态持久化 —— 主进程侧。
//
// 安全边界：渲染进程是 contextIsolation + nodeIntegration:false，碰不到
// safeStorage 和文件系统，全部读写经 IPC 走这里：
//   - token（登录返回 data 的 token 字段，旧接口叫 qq）→ safeStorage 加密后以
//     base64 存 electron-store（userData/admin-session.json）
//   - 其余字段（phone / userCode / schoolCode / userType …）→ 原样明文存
//     electron-store
//
// 为什么不全存 safeStorage：safeStorage 只吃 string（encryptString），整套
// userInfo 都是对象，逐字段加密再解一遍没有收益 —— 除 token 外没有秘密。
//
// 降级：Linux 上 safeStorage 依赖 libsecret，无桌面钥匙串时 isEncryptionAvailable()
// 为 false —— 此时退回明文存（与原 localStorage 方案等价，不比它差），
// 带 plain 标记，下次加载按标记取。

import Store from 'electron-store'
import { ipcMain, safeStorage } from 'electron'

interface AdminSessionStoreShape {
  /** base64(safeStorage.encryptString(token)) */
  tokenEnc: string
  /** safeStorage 不可用时的明文降级 */
  tokenPlain: string
  /** 除 token 外的全部登录返回字段 */
  userInfo: Record<string, unknown>
}

const store = new Store<AdminSessionStoreShape>({
  name: 'admin-session',
  defaults: { tokenEnc: '', tokenPlain: '', userInfo: {} }
})

/**
 * 登录返回的 data。token 是 Sa-Token 的值（见 api/auth.ts 的 LoginData）：
 * 新接口 /background/login/v1 放在 token 字段，旧接口 login2 放在 qq 字段。
 */
export interface AdminSessionData {
  token?: unknown
  qq?: unknown
  [key: string]: unknown
}

/** 新旧两种字段名都认：升级前存下的登录态里只有 qq */
function pickToken(data: Record<string, unknown>): string {
  if (typeof data.token === 'string' && data.token) return data.token
  return typeof data.qq === 'string' ? data.qq : ''
}

function saveAdminSession(raw: unknown): boolean {
  if (raw == null || typeof raw !== 'object') return false
  const data = raw as AdminSessionData
  const token = pickToken(data)
  // 除 token 外全部字段原样存（两个键名都要摘掉，别把明文 token 落进 electron-store）
  const userInfo: Record<string, unknown> = { ...data }
  delete userInfo.token
  delete userInfo.qq

  try {
    if (token && safeStorage.isEncryptionAvailable()) {
      store.set('tokenEnc', safeStorage.encryptString(token).toString('base64'))
      store.delete('tokenPlain')
    } else {
      store.set('tokenPlain', token)
      store.delete('tokenEnc')
    }
    store.set('userInfo', userInfo)
    return true
  } catch (err) {
    console.error('[admin-session] save failed:', err)
    return false
  }
}

/** 还原成登录返回 data 的形状：{ ...其余字段, token } */
function loadAdminSession(): AdminSessionData | null {
  try {
    const userInfo = store.get('userInfo') ?? {}
    let token = ''
    const enc = store.get('tokenEnc')
    if (enc) {
      if (safeStorage.isEncryptionAvailable()) {
        try {
          token = safeStorage.decryptString(Buffer.from(enc, 'base64'))
        } catch {
          token = '' // 换了机器 / 密钥失效：当作没登录
        }
      }
    } else {
      token = store.get('tokenPlain') ?? ''
    }
    return { ...userInfo, token }
  } catch (err) {
    console.error('[admin-session] load failed:', err)
    return null
  }
}

function clearAdminSession(): boolean {
  try {
    store.clear()
    return true
  } catch (err) {
    console.error('[admin-session] clear failed:', err)
    return false
  }
}

/**
 * 注册这三条通道。
 *
 * 与 main/index.ts 里 ipcHandle 同一个理由：dev 下主进程入口可能被求值两次
 * （动态 import 出的 chunk 会 require 入口去拿共享模块），本函数就会被调两遍，
 * 第二次撞上 ipcMain.handle 的重复注册检查。先摘旧的再装，重复调用变成无害覆盖。
 */
export function registerAdminSessionIpc(): void {
  for (const channel of ['admin-session:save', 'admin-session:load', 'admin-session:clear']) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('admin-session:save', (_event, data: unknown) => saveAdminSession(data))
  ipcMain.handle('admin-session:load', () => loadAdminSession())
  ipcMain.handle('admin-session:clear', () => clearAdminSession())
}

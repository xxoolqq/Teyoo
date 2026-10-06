// 「文件 → 设为默认应用」：让 Teyoo 成为 .md / .markdown / .txt 双击时打开的那个应用。
//
// 「默认应用」没有跨平台接口，三个平台各写各的：
//   Windows —— 写 HKCU 的 ProgID / OpenWithProgids / RegisteredApplications，再把
//              扩展名的默认值指过来。用户已经在系统里选过默认应用的
//              （FileExts\UserChoice，带一个系统算的 Hash）程序改不动，只能把人
//              送到「设置 → 应用 → 默认应用」去手动选。
//   macOS   —— LaunchServices：osascript(JXA) 调 LSSetDefaultRoleHandlerForContentType。
//   Linux   —— xdg-mime default。
//
// 一律写 HKCU（用户级），不用管理员权限：HKCU\Software\Classes 就是用户级的
// HKCR，同一条会盖住 HKLM 里的，所以免安装（zip）版也能注册关联。

import { app, dialog, shell } from 'electron'
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { execFile } from 'node:child_process'

/** 界面语言由 main/index.ts 决定，这里不自己读偏好（避免与 index 循环依赖）。 */
type Translate = (zh: string, en: string) => string

/** 与 electron-builder.yml 的 appId 一致 —— macOS 只认 bundle id，写错必然注册失败。 */
const MACOS_BUNDLE_ID = 'ai.marswave.teyoo'
/** 与 package.json 的 productName 一致：Windows 的 ProgID 与注册表键名用它。 */
const APP_NAME = 'Teyoo'

const FILE_TYPES: { ext: string; name: string; mime: string }[] = [
  { ext: 'md', name: 'Markdown Document', mime: 'text/markdown' },
  { ext: 'markdown', name: 'Markdown Document', mime: 'text/markdown' },
  { ext: 'mdown', name: 'Markdown Document', mime: 'text/markdown' },
  { ext: 'mkd', name: 'Markdown Document', mime: 'text/markdown' },
  { ext: 'txt', name: 'Text Document', mime: 'text/plain' }
]

export function setAsDefaultApp(t: Translate, parent: BrowserWindow | null): void {
  if (process.platform === 'win32') {
    void setDefaultOnWindows(t, parent)
    return
  }
  if (process.platform === 'darwin') {
    setDefaultOnMacOS(t, parent)
    return
  }
  void setDefaultOnLinux(t, parent)
}

// ─── Windows ──────────────────────────────────────────────────────────────
// 全部走 reg.exe：不需要管理员权限（只写 HKCU），也不需要额外的原生依赖。

type RegOutcome = { ok: boolean; stdout: string }

function reg(args: string[]): Promise<RegOutcome> {
  return new Promise((resolve) => {
    // windowsHide：不让 reg.exe 闪一个控制台窗口出来。
    execFile('reg', args, { windowsHide: true }, (error, stdout) => {
      resolve({ ok: !error, stdout: typeof stdout === 'string' ? stdout : '' })
    })
  })
}

/** 用户在系统里选过的默认应用（FileExts\UserChoice）；没选过就是 null。 */
async function userChoiceProgId(ext: string): Promise<string | null> {
  const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.${ext}\\UserChoice`
  const { ok, stdout } = await reg(['query', key, '/v', 'ProgId'])
  if (!ok) return null
  // 只解析 ProgId 这个**值名**：它是 ASCII，不受系统语言影响。默认值（/ve）在中文
  // 系统上会被 reg.exe 打印成「(默认)」，没法跨语言解析，所以一律不读。
  const match = stdout.match(/^[ \t]*ProgId[ \t]+REG_\w+[ \t]*(.*)$/m)
  if (!match) return null
  return match[1].trim() || null
}

type ExtStatus = { ext: string; status: 'ok' | 'taken' | 'failed' }

async function setDefaultOnWindows(t: Translate, parent: BrowserWindow | null): Promise<void> {
  const exe = process.execPath
  const classes = 'HKCU\\Software\\Classes'
  const progId = (ext: string): string => `${APP_NAME}.${ext}`

  // ① 本应用的 ProgID：显示名、图标、打开命令。与 electron-builder 安装时写的
  //    那套同形（<产品名>.<扩展名>），装在机器上时两边写的是同一条键。
  for (const type of FILE_TYPES) {
    const id = progId(type.ext)
    await reg(['add', `${classes}\\${id}`, '/ve', '/t', 'REG_SZ', '/d', type.name, '/f'])
    await reg(['add', `${classes}\\${id}\\DefaultIcon`, '/ve', '/t', 'REG_SZ', '/d', `"${exe}",0`, '/f'])
    await reg(['add', `${classes}\\${id}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', `"${exe}" "%1"`, '/f'])
  }

  // ② 让 Teyoo 出现在「设置 → 应用 → 默认应用」的应用列表里：系统读
  //    RegisteredApplications 找到 Capabilities，再读它的 FileAssociations 认领扩展名。
  const capabilities = `HKCU\\Software\\${APP_NAME}\\Capabilities`
  await reg(['add', capabilities, '/v', 'ApplicationName', '/t', 'REG_SZ', '/d', APP_NAME, '/f'])
  await reg(['add', capabilities, '/v', 'ApplicationDescription', '/t', 'REG_SZ', '/d', 'Markdown editor', '/f'])
  for (const type of FILE_TYPES) {
    await reg(['add', `${capabilities}\\FileAssociations`, '/v', `.${type.ext}`, '/t', 'REG_SZ', '/d', progId(type.ext), '/f'])
  }
  await reg(['add', 'HKCU\\Software\\RegisteredApplications', '/v', APP_NAME, '/t', 'REG_SZ', '/d', `Software\\${APP_NAME}\\Capabilities`, '/f'])

  // ③ 逐个扩展名：加进「打开方式」候选，并把默认值指过来。
  const done: ExtStatus[] = []
  for (const type of FILE_TYPES) {
    const id = progId(type.ext)
    // OpenWithProgids 的值必须是空串（REG_SZ、无数据），reg.exe 靠 /d '' 写出来。
    await reg(['add', `${classes}\\.${type.ext}\\OpenWithProgids`, '/v', id, '/t', 'REG_SZ', '/d', '', '/f'])
    // HKCU 的默认值会盖住 HKLM，所以免安装版也能靠这一条成为默认。
    const write = await reg(['add', `${classes}\\.${type.ext}`, '/ve', '/t', 'REG_SZ', '/d', id, '/f'])
    const chosen = await userChoiceProgId(type.ext)
    // UserChoice 优先于上面那条默认值，而且它的 Hash 由系统算：程序写它无效
    // （会被 Windows 忽略或还原），所以这里只报告，让人去系统设置里改。
    if (chosen === id) done.push({ ext: type.ext, status: 'ok' })
    else if (chosen !== null) done.push({ ext: type.ext, status: 'taken' })
    else done.push({ ext: type.ext, status: write.ok ? 'ok' : 'failed' })
  }
  await reportWindowsResult(t, parent, done)
}

async function reportWindowsResult(t: Translate, parent: BrowserWindow | null, done: ExtStatus[]): Promise<void> {
  const sep = t('、', ', ')
  const list = (items: ExtStatus[]): string => items.map((item) => `.${item.ext}`).join(sep)
  const ok = done.filter((item) => item.status === 'ok')
  const taken = done.filter((item) => item.status === 'taken')
  const failed = done.filter((item) => item.status === 'failed')
  // 开发模式下 process.execPath 是 electron.exe，注册的是它 —— 说清楚，免得
  // 开发机上双击 .md 打开一个空 Electron 却不知道为什么。
  const devNote = app.isPackaged
    ? ''
    : '\n' + t('（开发模式：注册到的是 Electron 可执行文件，只有打包安装后的版本才会指向 Teyoo.exe）',
      '(Running unpacked: the association points at the Electron binary; only an installed build points at Teyoo.exe)')

  if (taken.length === 0 && failed.length === 0) {
    await show(parent, {
      type: 'info',
      message: t('Teyoo 现在是这些文件的默认打开方式', 'Teyoo is now the default app for these file types'),
      detail: list(ok) + devNote
    })
    return
  }

  const lines: string[] = []
  if (ok.length > 0) lines.push(`${t('已设为默认', 'Now default')}：${list(ok)}`)
  if (taken.length > 0) {
    lines.push(`${t('系统里已经指定了别的默认应用，Windows 不让程序直接改，要在系统设置里手动选 Teyoo',
      'Another app is already the system default here; Windows does not let apps change this, so pick Teyoo in Settings')}：${list(taken)}`)
  }
  if (failed.length > 0) lines.push(`${t('没能写入注册表', 'Could not write to the registry')}：${list(failed)}`)

  const choice = await show(parent, {
    type: 'warning',
    message: t('部分文件类型没能设为默认', 'Some file types could not be set as default'),
    detail: lines.join('\n') + devNote,
    buttons: [t('打开系统设置', 'Open system settings'), t('关闭', 'Close')],
    defaultId: 0,
    cancelId: 1
  })
  if (choice.response === 0) void shell.openExternal('ms-settings:defaultapps')
}

// ─── macOS ────────────────────────────────────────────────────────────────
// LaunchServices 没有 Node 接口，走系统自带的 osascript（JXA）。

function setDefaultOnMacOS(t: Translate, parent: BrowserWindow | null): void {
  const script = `
    ObjC.import('CoreServices');
    var bundleID = '${MACOS_BUNDLE_ID}';
    var exts = ${JSON.stringify(FILE_TYPES.map((type) => type.ext))};
    var results = [];
    for (var i = 0; i < exts.length; i++) {
      var ext = exts[i];
      try {
        var uti = $.UTTypeCreatePreferredIdentifierForTag($.kUTTagClassFilenameExtension, $(ext), null);
        if (!uti) throw new Error('Could not resolve file type');
        var status = String($.LSSetDefaultRoleHandlerForContentType(uti, $.kLSRolesAll, $(bundleID)));
        results.push(ext + ': ' + (status === '0' ? 'OK' : 'error ' + status));
      } catch (e) {
        results.push(ext + ': ' + e.message);
      }
    }
    JSON.stringify(results);
  `
  execFile('osascript', ['-l', 'JavaScript', '-e', script], (error, stdout, stderr) => {
    if (error) {
      void show(parent, {
        type: 'error',
        message: t('设为默认应用失败', 'Could not set Teyoo as the default app'),
        detail: stderr || error.message
      })
      return
    }
    let results: string[] | null = null
    try {
      results = JSON.parse(String(stdout).trim()) as string[]
    } catch { /* 输出不是 JSON：按「已发出请求」处理 */ }
    if (!results) {
      void show(parent, {
        type: 'info',
        message: t('已请求设为默认应用，系统可能会弹窗确认', 'Request sent — the system may ask you to confirm'),
        detail: String(stdout).trim()
      })
      return
    }
    const allOk = results.every((line) => line.endsWith(': OK'))
    void show(parent, {
      type: allOk ? 'info' : 'warning',
      message: allOk
        ? t('Teyoo 现在是 Markdown 与文本文件的默认打开方式', 'Teyoo is now the default app for Markdown and text files')
        : t('部分文件类型没能设为默认', 'Some file types could not be set as default'),
      detail: results.join('\n')
    })
  })
}

// ─── Linux ────────────────────────────────────────────────────────────────
// xdg-mime 把结果写进 ~/.config/mimeapps.list，只对当前用户生效。

function setDefaultOnLinux(t: Translate, parent: BrowserWindow | null): Promise<void> {
  // electron-builder 生成的 .desktop 文件名来自 package.json 的 name。
  const desktop = 'teyoo.desktop'
  const mimes = [...new Set(FILE_TYPES.map((type) => type.mime))]
  return new Promise((resolve) => {
    execFile('xdg-mime', ['default', desktop, ...mimes], (error, _stdout, stderr) => {
      const detail = String(stderr ?? '').trim()
      void show(parent, error
        ? {
            type: 'error',
            message: t('设为默认应用失败', 'Could not set Teyoo as the default app'),
            detail: detail || error.message
          }
        : {
            type: 'info',
            message: t('Teyoo 现在是 Markdown 与文本文件的默认打开方式', 'Teyoo is now the default app for Markdown and text files')
          }).then(() => resolve())
    })
  })
}

// ─── 共用 ────────────────────────────────────────────────────────────────

/** 菜单触发时窗口可能已经关了，所以落到无父窗口的普通对话框上，而不是崩掉。 */
function show(parent: BrowserWindow | null, options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const owner = parent && !parent.isDestroyed() ? parent : undefined
  return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options)
}

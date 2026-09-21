---
name: electron-popup-coords
description: Diagnose and fix Electron native Menu.popup, context menu, and tray menu positioning offsets on Windows — custom frameless title-bar menus that misalign when the window is restored vs maximized, or drift with window position and zoom level. Use when a native popup menu appears shifted from its DOM anchor. Do not use for pure HTML/CSS dropdowns inside the renderer.
---

# Electron 原生弹层菜单坐标定位（Windows）

修复自定义菜单栏（本项目 `#app-menubar`，`titleBarStyle: 'hidden'`）调用 `Menu.popup` 时菜单与触发按钮错位的问题。

## 症状指纹（先对号入座）

- 窗口**最大化时对齐，还原（非最大化）时错位**
- 错位量随窗口位置变化：窗口越偏离屏幕左上角，菜单越偏右下
- 越靠右的菜单项偏得越多，或窗口越小视觉偏差越明显
- 切换页面缩放（视图放大/缩小）后偏差改变

若符合，按本流程处理；若是普通 HTML 下拉（绝对定位的 div）错位，属于 CSS 问题，不用本 skill。

## 坐标基准（Electron 44，源码级结论）

Windows 实现 `shell/browser/api/electron_api_menu_views.cc` 的 `PopupAt`：

```cpp
gfx::Point origin = native_window->GetContentBounds().origin();
location = gfx::Point(origin.x() + x, origin.y() + y);
```

由此得出三条铁律：

1. `menu.popup({ window, x, y })` 的 x/y 是**相对该窗口客户区左上角的 DIP 偏移**，Electron 内部已叠加内容区原点。
   - **禁止再加** `win.getContentBounds().x/y`
   - **禁止加** 渲染端 `window.screenX/screenY`（那是窗口外框坐标，Windows 含约 7-8px 不可见调整边框）
   - 任何一种重复叠加都会让菜单整体偏移一个"窗口原点"，最大化时内容区原点≈(-8,-8) 恰好抵消，这就是"仅还原窗口错位"的成因。
2. 渲染端 `getBoundingClientRect()` 返回的是 **CSS px**；页面缩放后 1 CSS px = `webContents.getZoomFactor()` DIP，必须乘该系数。本项目视图缩放持久化在 `window-state.json` 的 `zoom` 字段。
3. 系统 DPI 缩放（`display.scaleFactor`，如 2.0）**不参与计算**——getBoundingClientRect 与 popup 坐标同为 DIP 体系，已抵消。

## 标准实现

渲染层：只传视口内坐标，不做任何屏幕换算。

```ts
const rect = btn.getBoundingClientRect()
window.electronAPI.popupMenubar(key, Math.round(rect.left), Math.round(rect.bottom))
```

主进程 IPC handler：乘 zoomFactor 后直接 popup。

```ts
ipcMain.handle('menubar-popup', (event, key, x, y) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  const offsetX = Number(x)
  const offsetY = Number(y)
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return
  const zoom = event.sender.getZoomFactor()
  item.submenu.popup({
    window: win,
    x: Math.round(offsetX * zoom),
    y: Math.round(offsetY * zoom),
  })
})
```

本项目落点：渲染层 `src/renderer/main.ts` 的 `popupAt`，主进程 `src/main/index.ts` 的 `menubar-popup` handler。

## 不确定系数时的实测校准法

不要靠猜或反复试错。用点击鼠标位置做基准（鼠标点击时必然落在按钮矩形内）：

1. 主进程临时加日志：
```ts
import { screen } from 'electron'
const bounds = win.getContentBounds()
const cursor = screen.getCursorScreenPoint()
console.log('[cal]', JSON.stringify({
  rect: { x: offsetX, y: offsetY },          // 渲染端传来的 CSS px
  bounds,                                     // 内容区屏幕 DIP
  cursor,                                     // 鼠标屏幕 DIP
  zoom: event.sender.getZoomFactor(),
  scale: screen.getDisplayMatching(bounds).scaleFactor,
}))
```
2. 重启应用（主进程改动不走 HMR：杀掉 electron 后重新 `npm run dev`，dev 需在沙箱外运行）
3. 用户在**非最大化窗口**点击最靠右的菜单项
4. 鼠标在客户区内偏移 = `cursor - bounds.origin`，与 `rect` 对比即得换算系数（本次实测 178 CSSpx → 195 DIP，系数 1.0954 = zoomFactor）
5. 验证后删除诊断日志

## 修复后必须验证的矩阵

- [ ] 非最大化窗口，拖到屏幕不同位置（左上/右下），五个一级菜单逐个对齐
- [ ] 最大化状态对齐
- [ ] 视图放大/缩小改变 zoomFactor 后对齐
- [ ] 偏差 ≤ 1-2px（Math.round 取整）可接受

## 平台备注

- 结论针对 Windows（menu_views 实现）。macOS 走另一套坐标语义且支持 `positioningItem`；本项目仅 Windows 使用自定义菜单栏（`#app-menubar`），macOS 保留系统原生菜单栏。
- 同类问题也适用于 Tray 之外一切"渲染端锚点 → 主进程原生弹层"的坐标换算；纯渲染层 HTML 弹层（如标题下拉 `#heading-menu`）用 `getBoundingClientRect` + CSS 绝对定位即可，与本流程无关。

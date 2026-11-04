// 可视化解题「画图」能力的回归测试
// ─────────────────────────────────────────────────────────────────────────────
// 为什么要有：图形是"受限指令 → 我们自己的渲染器"这条链，最容易坏的恰恰不是渲染
// 器，而是**指令的边界** —— 白名单外的表达式、认不出的关键字、沙箱里报错的函数，
// 三种情况都必须"退回显示指令原文"而不是让解题内容跟着坏。
//
// 做法：起真应用 + 一个假端点，把 11 个用例各当一个步骤一次性喂进去，然后逐条断言。
// 假端点的意义是**确定性**：模型今天心情好不好、有没有按协议写 ```plot，都不影响
// 这里的结果 —— 这些用例考的是解析器 / 渲染器 / 退化路径。
//
// 跑法：npm run test:solver-graphics   （失败会以非 0 退出，可用于 CI）
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '..')
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'teyoo-gfx-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 每个用例 = 一个步骤 + 一段图形指令 + 期望结果 */
const CASES = [
  {
    kind: 'plot',
    id: 'plot-两条曲线+交点',
    want: 'image',
    note: '同一张图里画两条曲线，并标出交点',
    code: 'f: 2*x + 1\nf: x^2\ndomain: -3..3\npoints: (1,3)'
  },
  {
    id: 'plot-指定纵轴范围',
    want: 'image',
    note: 'range 限定 y 显示区间',
    code: 'f: 2*x + 1\ndomain: -3..3\nrange: -1..4'
  },
  {
    id: 'plot-自由参数滑块',
    want: 'image+slider',
    note: 'params 给出自由参数 → 一行滑块，拖动就地重画',
    code: 'f: a*x^2 - 2\ndomain: -3..3\nparams: a = 1 (-2..2)'
  },
  {
    id: 'plot-绝对值函数+标注点',
    want: 'image',
    note: '带函数名的表达式 abs(...) 要能用',
    code: 'f: abs(x - 1) - 2\ndomain: -4..5\npoints: (1,-2)'
  },
  {
    id: 'plot-三角函数',
    want: 'image',
    note: 'sin 与小数区间（domain 用小数不要崩）',
    code: 'f: sin(x)\ndomain: -6.28..6.28\nrange: -1.5..1.5'
  },
  {
    kind: 'figure',
    id: 'figure-直角三角形+外接圆',
    want: 'image',
    note: '线段 / 多边形 / 角标记 / 圆心直接写坐标',
    code: 'A=(0,0)  B=(4,0)  C=(0,3)\nsegment A B\nsegment B C\nsegment C A\npolygon A B C\nangle A B C\ncircle (2,1.5) 2.5'
  },
  {
    kind: 'figure',
    id: 'figure-一行多个点（回归）',
    want: 'image',
    note: '早先要求"整行恰好一个点"，真机上直接解析失败 —— 这条盯着别再退回去',
    code: 'A=(0,0) B=(2,0) C=(1,3)\nsegment A B\nsegment B C\nsegment C A\npolygon A B C'
  },
  {
    kind: 'figure',
    id: 'figure-圆与弦+角',
    want: 'image',
    note: '圆 + 弦 + 顶点在中间的角',
    code: 'O=(0,0)  A=(2,0)  B=(0,2)\ncircle O 2\nsegment A B\nangle A O B'
  },
  {
    id: '退化-f: 里写了 LaTeX',
    want: 'raw',
    note: '表达式白名单挡掉反斜杠 → 解析不出函数 → 退回指令原文',
    code: 'f: \\frac{1}{x}\ndomain: -3..3'
  },
  {
    id: '退化-函数名不存在',
    want: 'raw',
    note: '解析能过，但沙箱里求值报错 → "没画出来（下面是指令原文）"',
    code: 'f: foo(x)\ndomain: -3..3'
  },
  {
    kind: 'figure',
    id: '退化-认不出的关键字',
    want: 'raw',
    note: '整块没有一条可用指令（figure 里没有点/线段/圆/多边形）→ 退回原文',
    code: 'triangle A B C\nintersect l1 l2'
  }
]

/** 假端点返回的"解题结果"：每个用例一个 ## 第 N 步 */
function fakeSolution() {
  return CASES.map((item, index) => {
    const body = `这一步看 ${index + 1} 号图：$y = x$。`
    const fence = item.kind === 'figure' ? 'figure' : 'plot'
    return `## 第 ${index + 1} 步：${item.id}\n${body}\n\n\`\`\`${fence}\n${item.code}\n\`\`\`\n`
  }).join('\n')
}

// ── 假端点（OpenAI 兼容，SSE）──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: fakeSolution() } }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const PORT = server.address().port

fs.mkdirSync(path.join(WORK, 'userdata'), { recursive: true })
fs.writeFileSync(
  path.join(WORK, 'userdata', 'userSetting.json'),
  JSON.stringify({ visualSolve: { baseUrl: `http://127.0.0.1:${PORT}/v1`, apiKey: 'fake', model: 'fake' } })
)

const child = spawn(
  require('electron'),
  ['.', '--remote-debugging-port=9460', '--inspect=9270', `--user-data-dir=${path.join(WORK, 'userdata')}`],
  { cwd: ROOT, stdio: 'ignore' }
)

async function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  let nextId = 1
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    entry(message.result)
  })
  return {
    send: (method, params) =>
      new Promise((resolve) => {
        const id = nextId++
        pending.set(id, resolve)
        ws.send(JSON.stringify({ id, method, params }))
      })
  }
}

async function targetList(port) {
  for (let index = 0; index < 80; index++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      if (list.length) return list
    } catch {
      /* 端口还没起来 */
    }
    await sleep(500)
  }
  return []
}

const report = []
let failed = 0
try {
  const page = (await targetList(9460)).find((target) => target.type === 'page')
  const cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  const mainConn = await connect((await targetList(9270))[0].webSocketDebuggerUrl)
  await mainConn.send('Runtime.enable')
  const evaluate = (expression) =>
    cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value)
  const inMain = (expression) =>
    mainConn.send('Runtime.evaluate', { expression, returnByValue: true, includeCommandLineAPI: true }).then((r) => r?.result?.value)

  for (let index = 0; index < 60; index++) {
    if (await evaluate(`!!document.querySelector('#editor .ProseMirror[contenteditable]')`)) break
    await sleep(400)
  }
  await sleep(2500)
  await inMain(`(() => {
    const req = typeof require === 'function' ? require : process.mainModule.require
    const { Menu, BrowserWindow } = req('electron')
    globalThis.__click = (label) => {
      let hit = null
      const walk = (items) => { for (const item of items) { if (item.label === label) hit = item; if (item.submenu) walk(item.submenu.items) } }
      walk(Menu.getApplicationMenu().items)
      hit?.click(hit, BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0], {})
      return 'ok'
    }
    return 'ok'
  })()`)
  await inMain(`globalThis.__click('可视化解题')`)
  await sleep(1200)
  await evaluate(`(() => { document.getElementById('solver-input').value = '画出下列各图'; return true })()`)
  await evaluate(`document.getElementById('solver-start-btn').click()`)

  // 静下来判据：每个图形块要么有图（img）、要么已经把指令原文摆出来（pre）；
  // 还停在"正在画图…"（只有 head，没有 pre）就继续等。
  let settled = false
  for (let index = 0; index < 200; index++) {
    settled = await evaluate(
      `(() => {
        const blocks = [...document.querySelectorAll('#solver-steps .solver-graphic')]
        if (blocks.length < ${CASES.length}) return false
        return blocks.every((block) => block.querySelector('img, pre'))
      })()`
    )
    if (settled) break
    await sleep(400)
  }
  // 判据只说明"不再是正在画图"，参数图的首帧是 requestAnimationFrame 里发的重画，
  // 这里多等一会儿再取样，否则会把"马上就被替换掉的首帧"当成最终结果。
  await sleep(2500)

  const dump = JSON.parse(
    await evaluate(`(() => {
      const steps = [...document.querySelectorAll('#solver-steps .solver-step')]
      return JSON.stringify(steps.map((step) => {
        const wrap = step.querySelector('.solver-graphic')
        const img = wrap?.querySelector('img')
        return {
          title: step.querySelector('.solver-step-title')?.textContent ?? '',
          hasImg: !!img,
          imgBytes: img?.src?.length ?? 0,
          hasPre: !!wrap?.querySelector('pre'),
          head: wrap?.querySelector('.solver-graphic-head')?.textContent ?? '',
          rawText: wrap?.querySelector('pre')?.textContent ?? '',
          sliders: step.querySelectorAll('.solver-param input[type=range]').length
        }
      }))
    })()`)
  )

  for (let index = 0; index < CASES.length; index += 1) {
    const item = CASES[index]
    const got = dump[index] ?? {}
    const wantImage = item.want.includes('image')
    const wantSlider = item.want.includes('slider')
    const problems = []
    if (wantImage) {
      if (!got.hasImg) problems.push(`该画出图，实际没有${got.head ? `（${got.head}）` : ''}`)
      else if (got.imgBytes < 2000) problems.push(`图太小（data URL 仅 ${got.imgBytes} 字符）`)
    } else {
      if (got.hasImg) problems.push('该退回原文，实际画出了图')
      if (!got.rawText.trim()) problems.push('退回时没把指令原文摆出来（用户就没法判断发生了什么）')
    }
    if (wantSlider) {
      if (got.sliders !== 1) problems.push(`该有 1 条参数滑块，实际 ${got.sliders} 条`)
    } else if (got.sliders > 0) {
      problems.push(`不该有滑块，实际 ${got.sliders} 条`)
    }
    if (problems.length) failed += 1
    report.push({ id: item.id, ok: problems.length === 0, problems })
  }

  // 滑块真的能重画：拖一下，图应该换一张
  const sliderCase = CASES.findIndex((item) => item.want.includes('slider'))
  let sliderWorks = null
  if (sliderCase >= 0) {
    const before = await evaluate(
      `document.querySelectorAll('#solver-steps .solver-graphic')[${sliderCase}].querySelector('img')?.src?.length ?? 0`
    )
    await evaluate(`(() => {
      const range = document.querySelectorAll('#solver-steps .solver-graphic')[${sliderCase}].querySelector('.solver-param input[type=range]')
      range.value = String(Number(range.max))
      range.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(2500)
    const after = await evaluate(
      `document.querySelectorAll('#solver-steps .solver-graphic')[${sliderCase}].querySelector('img')?.src?.length ?? 0`
    )
    sliderWorks = before !== after && after > 2000
    if (!sliderWorks) failed += 1
  }

  // 插入正文：该带图的带图，退化的那份要把指令原文一起带进文档（指令不丢）
  await evaluate(`document.getElementById('solver-insert-btn').click()`)
  await sleep(1500)
  const inserted = JSON.parse(
    await evaluate(`(() => {
      const editor = document.getElementById('editor')
      return JSON.stringify({
        images: editor.querySelectorAll('img[src^="data:"]').length,
        hasRawJson: editor.textContent.includes('\\\\frac{1}{x}'),
        hasRawFoo: editor.textContent.includes('foo(x)'),
        hasRawTriangle: editor.textContent.includes('intersect')
      })
    })()`)
  )
  const imageCases = CASES.filter((item) => item.want.includes('image')).length
  const insertOk =
    inserted.images === imageCases && inserted.hasRawJson && inserted.hasRawFoo && inserted.hasRawTriangle
  if (!insertOk) failed += 1

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  // 截图落在系统临时目录：跑一次肉眼核对就够，别弄脏工作区
  const shotPath = path.join(os.tmpdir(), 'teyoo-solver-graphics-report.png')
  if (shot?.data) fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))

  console.log(`\n可视化解题 · 画图回归：${report.length} 个用例 + 2 项端到端检查`)
  for (const row of report) {
    console.log(`  ${row.ok ? 'PASS' : 'FAIL'}  ${row.id}${row.ok ? '' : `  ← ${row.problems.join('；')}`}`)
  }
  console.log(`  ${sliderWorks ? 'PASS' : 'FAIL'}  滑块拖动后重画（img src 变化）`)
  console.log(`  ${insertOk ? 'PASS' : 'FAIL'}  插入正文：${inserted.images}/${imageCases} 张图 + 退化用例的指令原文`)
  console.log(`  settled=${settled}  截图: ${shotPath}（图已插入文档，可肉眼核对）`)
  console.log(failed === 0 ? '\n全部通过 ✓' : `\n${failed} 项未通过 ✗`)
} catch (error) {
  console.error('测试脚本自身出错：', error?.stack ?? error)
  failed += 1
} finally {
  child.kill()
  server.close()
  // 退出后 Chromium 的子进程还会占着 profile 目录一小会儿（Windows 上 rmSync 会
  // EPERM）—— 等一下再删并重试几次。清不掉也只提示：那是临时目录，不该让它的
  // 清理失败变成"测试失败"。
  await sleep(1500)
  try {
    fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 })
  } catch {
    console.log(`（临时目录没能删除，可稍后手动清：${WORK}）`)
  }
  process.exit(failed === 0 ? 0 : 1)
}

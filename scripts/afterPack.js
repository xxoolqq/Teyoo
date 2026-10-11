const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { Arch } = require('builder-util')

exports.default = async function (context) {
  pruneOnnxRuntimePlatforms(context)
  if (process.platform === 'darwin') {
    cleanMacMetadata(context)
  }
}

/**
 * onnxruntime-node 1.x 把每个平台的动态库都装在 `bin/napi-v6/<platform>/<arch>` 下：
 * linux 的 libonnxruntime.so.1、darwin 的 libonnxruntime.*.dylib、win32 的
 * onnxruntime.dll + DirectML.dll + dxcompiler.dll，五个平台加起来约 287MB。
 * electron-builder 按 files + asarUnpack 的 `onnxruntime-node/**` 通配把它们**全部**
 * 拷进了 app.asar.unpacked，而运行时 onnxruntime-node 只按 process.platform/arch
 * 加载当前那份。其余平台留着纯属死重（打包 win 会从 120MB 涨到 400MB+），这里按
 * 本次打包目标删掉非本平台 / 非本架构的目录。
 */
function pruneOnnxRuntimePlatforms(context) {
  // electronPlatformName 可能是 'mas'（Mac App Store 目标），onnxruntime 目录名是 'darwin'
  const platform = context.electronPlatformName === 'mas' ? 'darwin' : context.electronPlatformName
  const arch = Arch[context.arch]
  if (!platform || !arch || !['win32', 'darwin', 'linux'].includes(platform)) return

  const binDir = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v6'
  )
  if (!fs.existsSync(binDir)) return

  let removed = 0
  for (const platDir of fs.readdirSync(binDir)) {
    const platPath = path.join(binDir, platDir)
    if (!fs.statSync(platPath).isDirectory()) continue

    if (platDir !== platform) {
      fs.rmSync(platPath, { recursive: true, force: true })
      removed += 1
      continue
    }

    // 当前平台目录里再按架构删一层。universal 不在 onnxruntime 的目录枚举里，
    // 遇到它跳过架构层清理（保留 arm64+x64，避免误删成空目录）。
    if (arch !== 'x64' && arch !== 'arm64') continue
    for (const archDir of fs.readdirSync(platPath)) {
      const archPath = path.join(platPath, archDir)
      if (!fs.statSync(archPath).isDirectory()) continue
      if (archDir !== arch) {
        fs.rmSync(archPath, { recursive: true, force: true })
        removed += 1
      }
    }
  }
  if (removed > 0) {
    console.log(`Pruned ${removed} foreign onnxruntime platform/arch dir(s), kept ${platform}/${arch}`)
  }
}

function cleanMacMetadata(context) {
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  console.log(`Cleaning extended attributes and resource forks from ${appPath}`)
  // Remove extended attributes
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' })
  // Remove HFS+ resource forks that xattr -cr doesn't handle
  execFileSync(
    'find',
    [appPath, '-type', 'f', '-exec', 'sh', '-c', 'cat /dev/null > "$1/..namedfork/rsrc" 2>/dev/null; true', '_', '{}', ';'],
    { stdio: 'inherit' }
  )
}

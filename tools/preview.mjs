/**
 * 预览：在不重启 dsh web 的前提下，用真实视频看一遍开机动画。
 *
 *   node tools/preview.mjs
 *   node tools/preview.mjs --file "C:\...\dsh-boot-video\assets\boot.mp4"
 *   node tools/preview.mjs --port 4000 --remember
 *
 * 它起的是一个**静态占位页**（假 DSH 界面 + 真实的注入逻辑 + 真实的视频路由），
 * 不是第二个 dsh web，也不碰正在跑的 3080。用来调 fit / fadeMs / 文案、试 ↑↓ 切换
 * 与两个选项面板最省事：改 config.json 或换视频后刷新预览页即可，无需重启。
 *
 * `--file` 用来指向别处的视频：运行期读的是**已安装副本**的 assets/，
 * 而本工具默认读源码目录的 assets/，用 --file 就能直接预览已安装的那一份。
 * 默认**不记录**选择（不写 state.json），加 `--remember` 才会写。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { createHarness, createServer, PREVIEW_INDEX } from './harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')

/**
 * 读一个 `--name value` 形式的参数。
 * @param {string} flag - 形如 `--port`。
 * @returns {string | undefined} 参数值。
 */
function option(flag) {
  const at = process.argv.indexOf(flag)
  return at === -1 ? undefined : process.argv[at + 1]
}

const port = Number(option('--port') ?? 3099)
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`preview: 端口不合法：${option('--port')}`)
  process.exit(1)
}

const file = option('--file')
if (file !== undefined && !fs.existsSync(file)) {
  console.error(`preview: 视频不存在：${file}`)
  process.exit(1)
}
if (file !== undefined && !/\.(mp4|webm|mov|m4v|ogv|ogg|mkv|avi)$/i.test(file)) {
  console.error(`preview: 扩展名不是认得的视频格式：${file}`)
  process.exit(1)
}

const harness = createHarness()
apply(harness.ctx, {
  // 预览默认不落盘：免得在源码目录里写出一个 state.json 来。
  rememberChoice: process.argv.includes('--remember'),
  ...(file === undefined ? {} : { file }),
})

const server = createServer(harness, PREVIEW_INDEX)
server.once('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`preview: 端口 ${port} 已被占用，换一个：node tools/preview.mjs --port 4000`)
    process.exit(1)
  }
  throw error
})
server.listen(port, '127.0.0.1', () => {
  console.log('')
  console.log('  开机动画预览（这是一个静态占位页，不是 dsh web 本身）')
  console.log(`  打开：http://127.0.0.1:${port}`)
  console.log(`  视频来源：${file ?? path.join(PACKAGE_ROOT, 'assets')}`)
  console.log(`  选择记录：${process.argv.includes('--remember') ? '开（会写 state.json）' : '关（预览不改动记录）'}`)
  console.log('  改素材/改配置后直接刷新页面即可；Ctrl+C 结束预览。')
  for (const [level, message] of harness.logs) {
    console.log(`  ${level === 'warn' ? '提示' : '信息'}：${message}`)
  }
  console.log('')
})

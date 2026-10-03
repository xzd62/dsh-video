/**
 * 自检：不起 dsh web、不进浏览器，直接验证宿主半的全部对外行为。
 *
 *   node tools/selfcheck.mjs
 *
 * 覆盖：index.html 注入（含「必须早于应用脚本」的时序断言）、cover.js 的配置注入、
 * 视频清单与选中项、多候选的按名路由、Range 语义（200/206/416/HEAD/405）、
 * POST 记录选择并跨「重启」保持、以及各种「没有视频 / 指错文件」的防黑屏路径。
 *
 * 全部用例都在系统临时目录里跑：需要「空 assets 目录」「多候选」这类场景时，
 * 复制一份包到临时目录再装载，绝不往真的 assets/ 里写测试文件，
 * 也不会在源码目录留下 state.json。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { createHarness, createServer, FIXTURE_INDEX } from './harness.mjs'
import { runCoverChecks } from './covercheck.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const STATE_FILE = path.join(PACKAGE_ROOT, 'state.json')

let passed = 0
let failed = 0

/**
 * 记一条断言。
 * @param {string} label - 断言说明。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 失败时的补充信息。
 */
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  \u2713 ${label}`)
    return
  }
  failed += 1
  console.log(`  \u2717 ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * 起一个监听随机端口的测试服务器。
 * @param {object} harness - 测试台。
 * @param {string} [indexHtml] - fallback 用的 index.html。
 * @returns {Promise<{base: string, close: () => Promise<void>}>} 服务器句柄。
 */
async function listen(harness, indexHtml = FIXTURE_INDEX) {
  const server = createServer(harness, indexHtml)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => { server.close(() => { resolve() }) }),
  }
}

/**
 * 复制一份可独立装载的插件包到临时目录（lib/ + package.json + 可选的 assets/）。
 * 这样就能构造出「assets 为空」「多个候选」这类用例，而不动真的 assets/。
 * @param {string} label - 目录名后缀，便于排查。
 * @param {Array<{name: string, bytes: Buffer}>} [videos] - 放进临时 assets/ 的文件。
 * @returns {Promise<object>} 该副本的插件模块。
 */
async function stagePackage(label, videos = []) {
  const dir = path.join(tempRoot, `stage-${label}`)
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  // 必须有 type: module，否则临时目录里的 .js 会被当成 CommonJS。
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "staged", "type": "module" }\n')
  for (const file of ['index.js', 'cover.js']) {
    fs.copyFileSync(path.join(PACKAGE_ROOT, 'lib', file), path.join(dir, 'lib', file))
  }
  for (const video of videos) {
    fs.writeFileSync(path.join(dir, 'assets', video.name), video.bytes)
  }
  const module_ = await import(pathToFileURL(path.join(dir, 'lib', 'index.js')).href)
  return { dir, module: module_, statePath: path.join(dir, 'state.json') }
}

/**
 * 递归删除目录。本环境里 fs.rmSync 会静默失败，所以逐项 unlink。
 * @param {string} dir - 目录。
 */
function removeTree(dir) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) { removeTree(target); continue }
    try { fs.unlinkSync(target) } catch { /* 清理尽力而为 */ }
  }
  try { fs.rmdirSync(dir) } catch { /* 清理尽力而为 */ }
}

/**
 * 读一个响应体为 JSON。
 * @param {Response} response - fetch 响应。
 * @returns {Promise<object>} 解析结果。
 */
async function json(response) {
  return JSON.parse(await response.text())
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-boot-video-selfcheck-'))
const tempVideo = path.join(tempRoot, 'sample.mp4')
const BYTES = Buffer.alloc(5000)
for (let i = 0; i < BYTES.length; i += 1) BYTES[i] = i % 251
fs.writeFileSync(tempVideo, BYTES)

const servers = []

try {
  /* ── 1. 指定单个文件：注入与路由 ─────────────────────────────────────── */
  console.log('\n[1] 指定视频文件时的注入与路由')
  const harness = createHarness()
  apply(harness.ctx, { file: tempVideo })
  const { base, close } = await listen(harness)
  servers.push(close)

  const indexRes = await fetch(`${base}/`)
  const html = await indexRes.text()
  check('GET / 返回 200', indexRes.status === 200, `status=${indexRes.status}`)
  check('index.html 里出现覆盖层标记', html.includes('dsh-boot-cover'))
  check('index.html 里注入样式块', html.includes('dsh-boot-video-style'))
  check('index.html 里注入引导脚本', html.includes('/boot-video/cover.js'))
  check(
    '注入块落在 </head> 之前',
    html.indexOf('dsh-boot-video-style') !== -1 && html.indexOf('dsh-boot-video-style') < html.indexOf('</head>'),
  )
  check(
    '注入块早于应用入口脚本（这是「不闪界面」的关键时序）',
    html.indexOf('dsh-boot-video-boot') !== -1
      && html.indexOf('dsh-boot-video-boot') < html.indexOf('/src/main.ts'),
  )
  check('样式把 #root 藏起来', html.includes('html.dsh-boot-cover #root{visibility:hidden'))
  check('注入是幂等的（对已注入的 html 再跑一次不变）', harness.taps.length === 1 && harness.taps[0](html) === html)

  const coverRes = await fetch(`${base}/boot-video/cover.js`)
  const cover = await coverRes.text()
  check('GET /boot-video/cover.js 返回 200', coverRes.status === 200, `status=${coverRes.status}`)
  check(
    'cover.js 的 content-type 是 javascript',
    String(coverRes.headers.get('content-type')).includes('javascript'),
    String(coverRes.headers.get('content-type')),
  )
  check('cover.js 不缓存', coverRes.headers.get('cache-control') === 'no-store')
  check('配置占位符已被替换', !cover.includes('__DSH_BOOT_VIDEO_CONFIG__'))
  check('配置里带上候选清单（1 项，带缓存戳）', /"videos":\[\{"name":"sample\.mp4","url":"\/boot-video\/media\/sample\.mp4\?v=5000-\d+"\}\]/.test(cover))
  check('配置里带上选中下标与记录接口', cover.includes('"current":0') && cover.includes('"selectUrl":"/boot-video/current"'))
  check('配置里带上默认项（有声 + 播完自动进入 + 2 倍速）',
    cover.includes('"requireSound":true') && cover.includes('"autoEnterAtEnd":true') && cover.includes('"fastRate":2'))
  check('配置里带上两个选项的按钮文字', cover.includes('播放视频') && cover.includes('直接进入 DSH'))

  const mediaUrl = `${base}/boot-video/media`
  const full = await fetch(mediaUrl)
  const fullBody = Buffer.from(await full.arrayBuffer())
  check('不带名字的 /media 播选中项，返回 200', full.status === 200, `status=${full.status}`)
  check('声明支持 Range', full.headers.get('accept-ranges') === 'bytes')
  check('Content-Type 为 video/mp4', full.headers.get('content-type') === 'video/mp4', String(full.headers.get('content-type')))
  check('Content-Length 与文件大小一致', full.headers.get('content-length') === String(BYTES.length))
  check('响应体与文件内容一致', fullBody.equals(BYTES))

  const byName = await fetch(`${base}/boot-video/media/sample.mp4`)
  check('带名字的 /media/sample.mp4 也能播', byName.status === 200
    && byName.headers.get('content-length') === String(BYTES.length), `status=${byName.status}`)
  await byName.arrayBuffer()

  const unknown = await fetch(`${base}/boot-video/media/nope.mp4`)
  check('清单外的名字返回 404', unknown.status === 404, `status=${unknown.status}`)

  const traversal = await fetch(`${base}/boot-video/media/..%2Fconfig.json`)
  check('路径穿越返回 404', traversal.status === 404, `status=${traversal.status}`)

  const ranged = await fetch(mediaUrl, { headers: { Range: 'bytes=0-99' } })
  const rangedBody = Buffer.from(await ranged.arrayBuffer())
  check('Range bytes=0-99 返回 206', ranged.status === 206, `status=${ranged.status}`)
  check(
    'Content-Range 正确',
    ranged.headers.get('content-range') === `bytes 0-99/${BYTES.length}`,
    String(ranged.headers.get('content-range')),
  )
  check('分片长度与内容正确', rangedBody.length === 100 && rangedBody.equals(BYTES.subarray(0, 100)))

  const openEnded = await fetch(mediaUrl, { headers: { Range: 'bytes=4999-' } })
  check(
    'Range bytes=4999- 返回最后 1 字节',
    openEnded.status === 206 && (await openEnded.arrayBuffer()).byteLength === 1,
    `status=${openEnded.status}`,
  )

  const suffix = await fetch(mediaUrl, { headers: { Range: 'bytes=-100' } })
  check(
    '后缀 Range bytes=-100 正确',
    suffix.status === 206
      && suffix.headers.get('content-range') === `bytes ${BYTES.length - 100}-${BYTES.length - 1}/${BYTES.length}`,
    String(suffix.headers.get('content-range')),
  )

  const multi = await fetch(mediaUrl, { headers: { Range: 'bytes=0-9,20-29' } })
  check('多区间 Range 优雅退化为整段 200', multi.status === 200, `status=${multi.status}`)
  await multi.arrayBuffer()

  const bad = await fetch(mediaUrl, { headers: { Range: 'bytes=99999-' } })
  check('越界 Range 返回 416', bad.status === 416, `status=${bad.status}`)
  check('416 带 Content-Range: bytes */size', bad.headers.get('content-range') === `bytes */${BYTES.length}`)

  const head = await fetch(mediaUrl, { method: 'HEAD' })
  check('HEAD 返回 200 且无响应体', head.status === 200 && (await head.arrayBuffer()).byteLength === 0)
  check('HEAD 带 Content-Length', head.headers.get('content-length') === String(BYTES.length))

  const post = await fetch(mediaUrl, { method: 'POST' })
  check('对媒体路由 POST 返回 405', post.status === 405, `status=${post.status}`)

  const query = await fetch(`${mediaUrl}?v=123-456`)
  check('带查询串仍命中视频路由', query.status === 200 && query.headers.get('content-type') === 'video/mp4')
  await query.arrayBuffer()
  check('本用例没有在源码目录留下 state.json', !fs.existsSync(STATE_FILE))

  /* ── 2. 多个候选：清单、默认项与按名路由 ───────────────────────────── */
  console.log('\n[2] 多个候选视频')
  const multi_ = await stagePackage('multi', [
    { name: 'aaa-first.mp4', bytes: BYTES.subarray(0, 111) },
    { name: 'boot-hero.mp4', bytes: BYTES.subarray(0, 222) },
    { name: 'zzz-last.mp4', bytes: BYTES.subarray(0, 333) },
  ])
  const multiHarness = createHarness()
  multi_.module.apply(multiHarness.ctx, {})
  const multiServer = await listen(multiHarness)
  servers.push(multiServer.close)

  const multiCover = await (await fetch(`${multiServer.base}/boot-video/cover.js`)).text()
  const videosMatch = /"videos":(\[.*?\]),"current":/.exec(multiCover)
  const listed = videosMatch === null ? [] : JSON.parse(videosMatch[1])
  const currentAt = Number(/"current":(\d+)/.exec(multiCover)?.[1])
  check('清单包含全部 3 个视频', listed.length === 3, multiCover.slice(0, 120))
  check('清单按文件名排序', listed.map(v => v.name).join(',') === 'aaa-first.mp4,boot-hero.mp4,zzz-last.mp4',
    listed.map(v => v.name).join(','))
  check('清单里每个视频都带自己的地址与缓存戳', /^\/boot-video\/media\/boot-hero\.mp4\?v=222-\d+$/.test(listed[1]?.url ?? ''), String(listed[1]?.url))
  check('默认选中 boot* 命名的那个（下标 1）', currentAt === 1, String(currentAt))

  const defaultMedia = await fetch(`${multiServer.base}/boot-video/media`)
  check('不带名字时播默认项（boot-hero，222 字节）', defaultMedia.headers.get('content-length') === '222',
    String(defaultMedia.headers.get('content-length')))
  await defaultMedia.arrayBuffer()

  const namedSmall = await fetch(`${multiServer.base}/boot-video/media/aaa-first.mp4`)
  check('按名取到另一个候选（111 字节）', namedSmall.headers.get('content-length') === '111',
    String(namedSmall.headers.get('content-length')))
  await namedSmall.arrayBuffer()

  const rangedNamed = await fetch(`${multiServer.base}/boot-video/media/zzz-last.mp4`, { headers: { Range: 'bytes=0-9' } })
  check('按名取候选时 Range 依然工作', rangedNamed.status === 206
    && rangedNamed.headers.get('content-range') === 'bytes 0-9/333', String(rangedNamed.headers.get('content-range')))
  await rangedNamed.arrayBuffer()

  const nameWithSpace = await fetch(`${multiServer.base}/boot-video/media/boot-hero.mp4?x=1`)
  check('带查询串不影响按名取候选', nameWithSpace.status === 200)
  await nameWithSpace.arrayBuffer()

  /* ── 2b. 非 ASCII 文件名 ───────────────────────────────────────────── */
  console.log('\n[2b] 中文文件名（真实素材很常见）')
  const cjk = await stagePackage('cjk', [
    { name: 'boot-b.mp4', bytes: BYTES.subarray(0, 111) },
    { name: '新宿决战.mp4', bytes: BYTES.subarray(0, 777) },
  ])
  const cjkHarness = createHarness()
  cjk.module.apply(cjkHarness.ctx, {})
  const cjkServer = await listen(cjkHarness)
  servers.push(cjkServer.close)

  const cjkCover = await (await fetch(`${cjkServer.base}/boot-video/cover.js`)).text()
  const cjkListed = JSON.parse(/"videos":(\[[^\]]*\])/.exec(cjkCover)[1])
  const cjkUrl = cjkListed.find(video => video.name === '新宿决战.mp4')?.url
  check('清单里保留中文名，并给出百分号编码的地址',
    typeof cjkUrl === 'string' && cjkUrl.startsWith('/boot-video/media/%E6%96%B0%E5%AE%BF%E5%86%B3%E6%88%98.mp4?v='),
    String(cjkUrl))

  const cjkMedia = await fetch(`${cjkServer.base}${cjkUrl}`)
  check('按编码地址能取到中文名视频', cjkMedia.status === 200
    && cjkMedia.headers.get('content-length') === '777',
  `status=${cjkMedia.status} len=${cjkMedia.headers.get('content-length')}`)
  await cjkMedia.arrayBuffer()

  const cjkRange = await fetch(`${cjkServer.base}${cjkUrl}`, { headers: { Range: 'bytes=3-13' } })
  check('中文名视频的 Range 也正常', cjkRange.status === 206
    && cjkRange.headers.get('content-range') === 'bytes 3-13/777',
  String(cjkRange.headers.get('content-range')))
  await cjkRange.arrayBuffer()

  const cjkRecord = await fetch(`${cjkServer.base}/boot-video/current`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: '新宿决战.mp4' }),
  })
  const cjkBody = await json(cjkRecord)
  check('中文名也能被记录', cjkRecord.status === 200 && cjkBody.file === '新宿决战.mp4', JSON.stringify(cjkBody))
  check('state.json 用 UTF-8 记下中文名',
    JSON.parse(fs.readFileSync(cjk.statePath, 'utf8')).file === '新宿决战.mp4')

  const cjkRestart = await import(`${pathToFileURL(path.join(cjk.dir, 'lib', 'index.js')).href}?restart=1`)
  const cjkRestartHarness = createHarness()
  cjkRestart.apply(cjkRestartHarness.ctx, {})
  const cjkRestartServer = await listen(cjkRestartHarness)
  servers.push(cjkRestartServer.close)
  const cjkRestartMedia = await fetch(`${cjkRestartServer.base}/boot-video/media`)
  check('重启后仍按记录播中文名视频', cjkRestartMedia.headers.get('content-length') === '777',
    String(cjkRestartMedia.headers.get('content-length')))
  await cjkRestartMedia.arrayBuffer()

  /* ── 3. 记录选择 ──────────────────────────────────────────────────── */
  console.log('\n[3] 记录选择（POST /boot-video/current）')
  check('装载时还没有 state.json', !fs.existsSync(multi_.statePath))

  const record = await fetch(`${multiServer.base}/boot-video/current`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: 'zzz-last.mp4' }),
  })
  const recordBody = await json(record)
  check('记录返回 200 且 persisted 为真', record.status === 200 && recordBody.persisted === true, JSON.stringify(recordBody))
  check('写下了 state.json', fs.existsSync(multi_.statePath))
  check('state.json 里记的是文件名', JSON.parse(fs.readFileSync(multi_.statePath, 'utf8')).file === 'zzz-last.mp4')

  const afterRecord = await fetch(`${multiServer.base}/boot-video/media`)
  check('记录后不带名字的 /media 改播它', afterRecord.headers.get('content-length') === '333',
    String(afterRecord.headers.get('content-length')))
  await afterRecord.arrayBuffer()

  const afterCover = await (await fetch(`${multiServer.base}/boot-video/cover.js`)).text()
  check('记录后 cover.js 的 current 也跟着变', /"current":2/.test(afterCover), /"current":(\d+)/.exec(afterCover)?.[1])

  const badName = await fetch(`${multiServer.base}/boot-video/current`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: 'not-a-video.mp4' }),
  })
  const badBody = await json(badName)
  check('记录清单外的名字返回 400 并列出候选', badName.status === 400 && Array.isArray(badBody.candidates),
    JSON.stringify(badBody))
  check('坏请求没有改动 state.json', JSON.parse(fs.readFileSync(multi_.statePath, 'utf8')).file === 'zzz-last.mp4')

  const badJson = await fetch(`${multiServer.base}/boot-video/current`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  })
  check('请求体不是 JSON 时返回 400', badJson.status === 400, `status=${badJson.status}`)

  const wrongMethod = await fetch(`${multiServer.base}/boot-video/current`)
  check('对记录接口用 GET 返回 405', wrongMethod.status === 405, `status=${wrongMethod.status}`)

  const tooBig = await fetch(`${multiServer.base}/boot-video/current`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: 'x'.repeat(5000) }),
  })
  check('超大请求体被拒绝', tooBig.status === 400, `status=${tooBig.status}`)

  // 「重启」：同一份副本重新装载一个实例，state.json 仍然生效
  const restartedModule = await import(
    `${pathToFileURL(path.join(multi_.dir, 'lib', 'index.js')).href}?restart=1`
  )
  const restartHarness = createHarness()
  restartedModule.apply(restartHarness.ctx, {})
  const restartServer = await listen(restartHarness)
  servers.push(restartServer.close)
  const restartCover = await (await fetch(`${restartServer.base}/boot-video/cover.js`)).text()
  check('重新装载（相当于重启 dsh web）后仍用记录的那一个', /"current":2/.test(restartCover),
    /"current":(\d+)/.exec(restartCover)?.[1])
  const restartMedia = await fetch(`${restartServer.base}/boot-video/media`)
  check('重启后不带名字的 /media 播的就是它', restartMedia.headers.get('content-length') === '333',
    String(restartMedia.headers.get('content-length')))
  await restartMedia.arrayBuffer()

  // 记录的文件被删掉 → 回落到默认项，不报错
  fs.unlinkSync(path.join(multi_.dir, 'assets', 'zzz-last.mp4'))
  const afterDelete = await (await fetch(`${restartServer.base}/boot-video/cover.js`)).text()
  check('记录的视频没了就回落到默认项', /"current":1/.test(afterDelete), /"current":(\d+)/.exec(afterDelete)?.[1])
  const staleMedia = await fetch(`${restartServer.base}/boot-video/media/zzz-last.mp4`)
  check('已删除的候选按名访问返回 404', staleMedia.status === 404, `status=${staleMedia.status}`)

  /* ── 4. rememberChoice: false ─────────────────────────────────────── */
  console.log('\n[4] rememberChoice: false')
  const forgetful = await stagePackage('forgetful', [
    { name: 'one.mp4', bytes: BYTES.subarray(0, 10) },
    { name: 'two.mp4', bytes: BYTES.subarray(0, 20) },
  ])
  const forgetfulHarness = createHarness()
  forgetful.module.apply(forgetfulHarness.ctx, { rememberChoice: false })
  const forgetfulServer = await listen(forgetfulHarness)
  servers.push(forgetfulServer.close)
  const forgetfulCover = await (await fetch(`${forgetfulServer.base}/boot-video/cover.js`)).text()
  check('配置里告诉客户端不要记录', forgetfulCover.includes('"canRemember":false'))
  const forgetfulRecord = await fetch(`${forgetfulServer.base}/boot-video/current`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: 'two.mp4' }),
  })
  const forgetfulBody = await json(forgetfulRecord)
  check('仍然返回 200 但不落盘', forgetfulRecord.status === 200 && forgetfulBody.persisted === false, JSON.stringify(forgetfulBody))
  check('没有生成 state.json', !fs.existsSync(forgetful.statePath))
  const forgetfulMedia = await fetch(`${forgetfulServer.base}/boot-video/media`)
  check('进程内仍然立刻生效', forgetfulMedia.headers.get('content-length') === '20',
    String(forgetfulMedia.headers.get('content-length')))
  await forgetfulMedia.arrayBuffer()

  /* ── 5. 没有视频时不注入（防黑屏） ─────────────────────────────────── */
  console.log('\n[5] assets/ 里没有视频时不注入')
  const empty = await stagePackage('empty')
  const emptyHarness = createHarness()
  empty.module.apply(emptyHarness.ctx, {})
  const emptyServer = await listen(emptyHarness)
  servers.push(emptyServer.close)
  const emptyHtml = await (await fetch(`${emptyServer.base}/`)).text()
  check('未注入覆盖层（页面直接进 DSH）', !emptyHtml.includes('dsh-boot-cover'))
  check('fallback 仍是原样的 index.html', emptyHtml.includes('<div id="root"></div>'))
  const emptyMedia = await fetch(`${emptyServer.base}/boot-video/media`)
  check('视频路由返回 404', emptyMedia.status === 404, `status=${emptyMedia.status}`)
  check('装载时留下告警日志', emptyHarness.logs.some(([level]) => level === 'warn'), JSON.stringify(emptyHarness.logs))

  /* ── 6. file 指错时不静默换素材 ────────────────────────────────────── */
  console.log('\n[6] config.json 指定的文件不可用时')
  const wrongHarness = createHarness()
  apply(wrongHarness.ctx, { file: 'assets/does-not-exist.mp4' })
  const wrongServer = await listen(wrongHarness)
  servers.push(wrongServer.close)
  const wrongHtml = await (await fetch(`${wrongServer.base}/`)).text()
  check('不注入覆盖层', !wrongHtml.includes('dsh-boot-cover'))
  check('告警点名了配置里的路径', wrongHarness.logs.some(([, message]) => message.includes('does-not-exist.mp4')), JSON.stringify(wrongHarness.logs))

  /* ── 7. enabled: false ────────────────────────────────────────────── */
  console.log('\n[7] enabled: false')
  const offHarness = createHarness()
  apply(offHarness.ctx, { enabled: false })
  check('不注册任何路由', offHarness.exact.size === 0 && offHarness.prefixes.size === 0)
  check('不注册 index 变换', offHarness.taps.length === 0)

  /* ── 8+ 浏览器半的行为（自带 DOM 桩） ──────────────────────────────── */
  await runCoverChecks(check)

  check('全程没有在源码目录留下 state.json', !fs.existsSync(STATE_FILE))
} finally {
  for (const close of servers) await close()
  removeTree(tempRoot)
  if (fs.existsSync(STATE_FILE)) { try { fs.unlinkSync(STATE_FILE) } catch { /* 清理尽力而为 */ } }
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

/**
 * dsh-boot-video（宿主半）—— 给 DSH Web 界面加一层「开机动画 / 动态锁屏」。
 *
 * 它做四件事：
 *  1. `ctx.webServer.register` 提供三条路由：
 *       GET  /boot-video/cover.js         覆盖层脚本（配置在响应时注入）
 *       GET  /boot-video/media[/<名字>]   视频本体（支持 HTTP Range：可流式播放/拖动）
 *       POST /boot-video/current          记录「这次选了哪个视频」
 *  2. `ctx.webServer.tapIndex` 往 index.html 的 <head> 注入一段**同步**脚本 + CSS：
 *     在 DSH 应用挂载之前就把 #root 隐藏、把背景刷黑，所以不会先闪出界面。
 *  3. 视频来自本包的 assets/ 目录（丢进去即用）；有几个就都是候选，
 *     客户端用 ↑↓ 切换。清单在**每次请求时**重新扫描，换视频不用重启 dsh web。
 *  4. 选择落在同目录的 state.json：下次启动/刷新仍然播这一个。
 *
 * 为什么不用 dsh.client（React + Slot）：那条路要等 shell 两阶段启动 settle
 * 之后才挂载，只能覆盖在已经画好的界面上 —— 会先闪一下 DSH，拿不到「首帧之前」
 * 的时机，而开机动画的全部意义就在这个时机上。
 *
 * 生命周期：所有副作用都经 ctx.effect 注册，随插件卸载自动撤销。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_DIR = path.join(PACKAGE_ROOT, 'assets')
const COVER_SCRIPT = path.join(PACKAGE_ROOT, 'lib', 'cover.js')
const CONFIG_FILE = path.join(PACKAGE_ROOT, 'config.json')
/** 记录「上次选了哪个视频」。由本插件自己维护，不是给人改的。 */
const STATE_FILE = path.join(PACKAGE_ROOT, 'state.json')

/** 路由前缀，同时也是注入标记的一部分。 */
const ROUTE_BASE = '/boot-video'
/** cover.js 里等着被替换成真实配置的占位符（必须与 lib/cover.js 一致）。 */
const CONFIG_TOKEN = '__DSH_BOOT_VIDEO_CONFIG__'
/** index.html 注入标记：出现它就说明已经注入过（避免重复注入）。 */
const MARK = 'dsh-boot-cover'
/** POST 请求体上限：这里只接受一个文件名。 */
const BODY_LIMIT = 4096

/** 认得的视频扩展名 → Content-Type。 */
const VIDEO_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.ogv', 'video/ogg'],
  ['.ogg', 'video/ogg'],
  ['.mov', 'video/quicktime'],
  ['.mkv', 'video/x-matroska'],
  ['.avi', 'video/x-msvideo'],
])

/** 默认配置；config.json 与行配置都只覆盖其中出现过的键。 */
const DEFAULTS = {
  enabled: true,
  file: '',
  fit: 'cover',
  fadeMs: 600,
  muted: false,
  requireSound: true,
  fallbackMuted: true,
  autoEnterAtEnd: true,
  fastRate: 2,
  rememberChoice: true,
  hint: '点击任意位置进入',
  switchHint: '↑ ↓ 切换视频',
  fullscreenHint: 'F11 可全屏观看',
  prompt: '🔊 浏览器拦截了自动播放，请选择',
  playLabel: '▶ 播放视频',
  skipLabel: '直接进入 DSH',
  showProgress: true,
}

export const name = 'boot-video'

/** 硬依赖：没有 webServer 这个插件什么也做不了。 */
export const inject = ['webServer']

/**
 * 装载插件：注册三条路由 + 一个 index.html 变换。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 携带 webServer 的上下文。
 * @param {object} [rowConfig] - 可选的 loader 行配置（优先级高于 config.json）。
 */
export function apply(ctx, rowConfig) {
  const config = { ...DEFAULTS, ...readJsonFile(CONFIG_FILE), ...plainObject(rowConfig) }

  if (config.enabled === false) {
    log(ctx, 'info', '已在 config.json 里关闭（enabled: false），不注册任何路由')
    return
  }

  /**
   * 本次装载的可变状态。记住的选择放内存而不是每次读盘：写盘失败时
   * 它在本进程内仍然有效，只是活不过重启。
   * `rememberChoice: false` 表示「不落盘」，所以启动时也不去读旧的 state.json。
   */
  const runtime = {
    ctx,
    config,
    remembered: config.rememberChoice === false ? '' : readRemembered(),
    writeWarned: false,
  }

  // 路由：覆盖层脚本（每次请求都重读磁盘 + 重新解析视频清单，因此换视频/改脚本免重启）
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/cover.js`,
      handler: (req, res) => { serveCoverScript(runtime, req, res) },
    }),
    'boot-video: cover script route',
  )

  // 路由：视频本体（Range 流式）。前缀注册，尾部可选一个视频名。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: `${ROUTE_BASE}/media`,
      handler: (req, res) => { void serveMedia(runtime, req, res) },
    }),
    'boot-video: media route',
  )

  // 路由：记录选择（客户端用 ↑↓ 切换视频时调用）
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/current`,
      handler: (req, res) => { void serveSelect(runtime, req, res) },
    }),
    'boot-video: selection route',
  )

  // index.html 变换：仅在「此刻确实存在可播视频」时注入，避免没放视频时白黑屏一次
  ctx.effect(
    () => ctx.webServer.tapIndex(html => tapIndex(runtime, html)),
    'boot-video: index tap',
  )

  const videos = listVideos(config)
  if (videos.length === 0) {
    log(ctx, 'warn', `${missingReason(config)}；在放好视频之前不会注入开机动画`)
  } else {
    const current = videos[resolveIndex(runtime, videos)].name
    log(ctx, 'info', `开机动画就绪（候选 ${videos.length} 个，当前 ${current}）：${videos.map(v => v.name).join(', ')}`)
  }
}

/* ────────────────────────────── index.html 注入 ────────────────────────────── */

/**
 * 把一个 index.html 体变成「带开机覆盖层」的版本。纯函数、幂等。
 * @param {object} runtime - 本次装载的可变状态。
 * @param {string} html - 原始 index.html。
 * @returns {string} 处理后的 html。
 */
function tapIndex(runtime, html) {
  if (typeof html !== 'string' || html.includes(MARK)) return html
  if (listVideos(runtime.config).length === 0) {
    logOnce(runtime.ctx, `本次不注入开机动画：${missingReason(runtime.config)}`)
    return html
  }
  const block = `${STYLE_BLOCK}${bootstrapScript()}`
  const headClose = html.indexOf('</head>')
  if (headClose !== -1) return html.slice(0, headClose) + block + html.slice(headClose)
  const headOpen = html.indexOf('<head>')
  if (headOpen !== -1) return html.slice(0, headOpen + 6) + block + html.slice(headOpen + 6)
  return block + html
}

/**
 * 在 <head> 里先把界面藏起来，再异步加载覆盖层脚本。
 *
 * 时序是关键：这段脚本同步执行（不 defer），而应用的入口是 `<script type="module">`
 * —— module 脚本一律延迟到解析结束后才执行，所以无论它写在 head 还是 body，
 * 隐藏 #root 都发生在 DSH 应用挂载之前，用户永远看不到「先闪一下界面」。
 * 15 秒兜底：万一覆盖层脚本加载失败，必须把界面还回来，不能把人锁在黑屏上。
 * @returns {string} 注入用 HTML 片段。
 */
function bootstrapScript() {
  return '<script id="dsh-boot-video-boot">'
    + '(function(){'
    + 'var d=document,h=d.documentElement;'
    + 'h.classList.add("' + MARK + '");'
    + 'var s=d.createElement("script");'
    + 's.src="' + ROUTE_BASE + '/cover.js";'
    + 's.async=true;'
    + '(d.head||h).appendChild(s);'
    + 'setTimeout(function(){'
    + 'if(window.__dshBootVideoReady!==true){h.classList.remove("' + MARK + '");}'
    + '},15000);'
    + '})();'
    + '</script>'
}

const STYLE_BLOCK = '<style id="dsh-boot-video-style">'
  + 'html.' + MARK + ',html.' + MARK + ' body{background:#000 !important;overflow:hidden !important}'
  + 'html.' + MARK + ' #root{visibility:hidden !important}'
  + '</style>'

/* ────────────────────────────── 路由：cover.js ────────────────────────────── */

/**
 * 提供覆盖层脚本，并把当前配置、视频清单与选中项写进去。
 * 每次请求重读磁盘：改 lib/cover.js 只需刷新浏览器，不用重启。
 * @param {object} runtime - 本次装载的可变状态。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 */
function serveCoverScript(runtime, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' })
    res.end()
    return
  }
  let source
  try {
    source = fs.readFileSync(COVER_SCRIPT, 'utf8')
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`boot-video: 读不到 lib/cover.js\n${String(error)}`)
    return
  }
  if (!source.includes(CONFIG_TOKEN)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`boot-video: lib/cover.js 里缺少配置占位符 ${CONFIG_TOKEN}`)
    return
  }
  const body = source.replace(CONFIG_TOKEN, JSON.stringify(clientConfig(runtime)))
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
  })
  if (req.method === 'HEAD') { res.end(); return }
  res.end(body)
}

/**
 * 交给浏览器那一半的配置：视频清单、选中项、以及各项开关。
 * 每个视频的 URL 都带 size-mtime 缓存戳，换文件后浏览器不会拿旧缓存。
 * @param {object} runtime - 本次装载的可变状态。
 * @returns {object} 覆盖层脚本可用的 JSON。
 */
function clientConfig(runtime) {
  const config = runtime.config
  const { videos, index } = resolveSelection(runtime)
  return {
    videos: videos.map(video => ({
      name: video.name,
      url: `${ROUTE_BASE}/media/${encodeURIComponent(video.name)}?v=${video.size}-${Math.round(video.mtimeMs)}`,
    })),
    current: index < 0 ? 0 : index,
    selectUrl: `${ROUTE_BASE}/current`,
    canRemember: config.rememberChoice !== false,
    fit: config.fit === 'contain' ? 'contain' : 'cover',
    fadeMs: numberOr(config.fadeMs, DEFAULTS.fadeMs),
    muted: config.muted === true,
    requireSound: config.requireSound !== false,
    fallbackMuted: config.fallbackMuted !== false,
    autoEnterAtEnd: config.autoEnterAtEnd !== false,
    fastRate: clampRate(numberOr(config.fastRate, DEFAULTS.fastRate)),
    hint: stringOr(config.hint, DEFAULTS.hint),
    switchHint: stringOr(config.switchHint, DEFAULTS.switchHint),
    fullscreenHint: stringOr(config.fullscreenHint, DEFAULTS.fullscreenHint),
    prompt: stringOr(config.prompt, DEFAULTS.prompt),
    playLabel: stringOr(config.playLabel, DEFAULTS.playLabel),
    skipLabel: stringOr(config.skipLabel, DEFAULTS.skipLabel),
    showProgress: config.showProgress !== false,
  }
}

/* ────────────────────────────── 路由：视频本体 ────────────────────────────── */

/**
 * 流式提供视频文件，支持 Range（浏览器播放/拖动都要用）。
 * 路径尾部可以带一个视频名；不带就用「选中的那个」。
 * 名字必须命中当前清单 —— 这既挡住 `../` 穿越，也挡住不存在的文件。
 * @param {object} runtime - 本次装载的可变状态。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 */
async function serveMedia(runtime, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' })
    res.end()
    return
  }
  const pathname = decodePathname(req.url)
  const video = videoForRequest(runtime, pathname)
  if (video === null) {
    logOnce(runtime.ctx, `/boot-video/media 返回 404：${pathname} 不在候选清单里`)
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('boot-video: 没有这个视频')
    return
  }

  let size
  try {
    size = (await fsp.stat(video.file)).size
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`boot-video: 读不到视频文件\n${String(error)}`)
    return
  }

  const headers = {
    'Content-Type': mimeOf(video.file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  }
  const range = req.headers.range === undefined ? null : parseRange(req.headers.range, size)

  if (range !== null && range.unsatisfiable === true) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` })
    res.end()
    return
  }

  if (range === null) {
    res.writeHead(200, { ...headers, 'Content-Length': String(size) })
    if (req.method === 'HEAD') { res.end(); return }
    pipeFile(res, video.file)
    return
  }

  res.writeHead(206, {
    ...headers,
    'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    'Content-Length': String(range.end - range.start + 1),
  })
  if (req.method === 'HEAD') { res.end(); return }
  pipeFile(res, video.file, range.start, range.end)
}

/**
 * 解析请求路径（解码 + 去掉查询串）。
 * @param {string | undefined} url - 原始 req.url。
 * @returns {string} 解码后的 pathname；解码失败时返回未解码的路径。
 */
function decodePathname(url) {
  /* v8 ignore next -- node:http always sets url on server requests. */
  const raw = new URL(url ?? '/', 'http://localhost').pathname
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * 这次请求要哪个视频。
 * @param {object} runtime - 本次装载的可变状态。
 * @param {string} pathname - 解码后的路径。
 * @returns {object | null} 清单里的一项；没有则为 null。
 */
function videoForRequest(runtime, pathname) {
  const videos = listVideos(runtime.config)
  if (videos.length === 0) return null
  const prefix = `${ROUTE_BASE}/media`
  if (pathname === prefix || pathname === `${prefix}/`) return videos[resolveIndex(runtime, videos)]
  if (!pathname.startsWith(`${prefix}/`)) return null
  const name = pathname.slice(prefix.length + 1)
  return videos.find(video => video.name === name) ?? null
}

/**
 * 把文件（可选区间）管道到响应，并在客户端断开时及时释放句柄。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {string} file - 绝对路径。
 * @param {number} [start] - 起始字节（含）。
 * @param {number} [end] - 结束字节（含）。
 */
function pipeFile(res, file, start, end) {
  const stream = start === undefined ? fs.createReadStream(file) : fs.createReadStream(file, { start, end })
  res.on('close', () => { stream.destroy() })
  stream.on('error', () => {
    if (res.headersSent) { res.destroy(); return }
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('boot-video: 视频流读取失败')
  })
  stream.pipe(res)
}

/**
 * 解析单个 Range 头（`bytes=0-`、`bytes=100-200`、`bytes=-500`）。
 * 多区间、语法错误一律返回 null → 该请求退化为一整个 200 响应。
 * @param {string} header - Range 头原文。
 * @param {number} size - 文件总字节数。
 * @returns {{start: number, end: number} | {unsatisfiable: true} | null} 解析结果。
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (match === null) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  let start
  let end
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start < 0 || start >= size) return { unsatisfiable: true }
  if (end < start) return { unsatisfiable: true }
  return { start, end: Math.min(end, size - 1) }
}

/* ────────────────────────────── 路由：记录选择 ────────────────────────────── */

/**
 * 记录「这次选了哪个视频」：写进 state.json，下次启动/刷新继续用它。
 * 写盘失败不算失败 —— 选择在本进程内仍然有效，只是活不过重启。
 * @param {object} runtime - 本次装载的可变状态。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 */
async function serveSelect(runtime, req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: 'use POST' }))
    return
  }
  let payload
  try {
    payload = JSON.parse(await readBody(req))
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: String(error) }))
    return
  }
  const wanted = stringOr(plainObject(payload).file, '')
  const videos = listVideos(runtime.config)
  const hit = videos.find(video => video.name === wanted)
  if (hit === undefined) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: 'unknown video', candidates: videos.map(v => v.name) }))
    return
  }

  runtime.remembered = hit.name
  const persisted = runtime.config.rememberChoice === false ? false : writeState(hit.name)
  if (runtime.config.rememberChoice !== false && !persisted && !runtime.writeWarned) {
    runtime.writeWarned = true
    log(runtime.ctx, 'warn', `写不进 ${STATE_FILE}，这次选择只在本进程内有效（重启后仍会用回默认视频）`)
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: true, file: hit.name, persisted }))
}

/**
 * 读一个小请求体（上限 {@link BODY_LIMIT} 字节）。
 * 超限时立刻判定失败，但继续把剩余数据读掉 —— 这样 400 响应还能正常发出去，
 * 连接也不会因为半读状态被搞乱。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<string>} utf8 文本。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      if (tooLarge) return
      size += chunk.length
      if (size > BODY_LIMIT) {
        tooLarge = true
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', (error) => { if (!tooLarge) reject(error) })
  })
}

/* ────────────────────────────── 视频清单与选择 ────────────────────────────── */

/**
 * 列出本次可用的视频。看看磁盘就知道，所以换视频不需要重启。
 *
 * - `config.file` 显式指定 → 只认它一个（指错了就是空清单，不会静默换素材）
 * - 否则扫描 assets/，按文件名排序（自然、可预测，↑↓ 就按这个顺序切换）
 * @param {object} config - 生效配置。
 * @returns {Array<{name: string, file: string, size: number, mtimeMs: number}>} 清单。
 */
function listVideos(config) {
  const configured = stringOr(config?.file, '')
  if (configured !== '') {
    const absolute = path.isAbsolute(configured) ? configured : path.join(PACKAGE_ROOT, configured)
    const stat = statFile(absolute)
    if (stat === null) return []
    return [{ name: path.basename(absolute), file: absolute, size: stat.size, mtimeMs: stat.mtimeMs }]
  }
  let entries
  try {
    entries = fs.readdirSync(ASSETS_DIR)
  } catch {
    return []
  }
  const videos = []
  for (const name of entries.sort((a, b) => a.localeCompare(b))) {
    if (!VIDEO_TYPES.has(path.extname(name).toLowerCase())) continue
    const file = path.join(ASSETS_DIR, name)
    const stat = statFile(file)
    if (stat === null) continue
    videos.push({ name, file, size: stat.size, mtimeMs: stat.mtimeMs })
  }
  return videos
}

/**
 * 没有任何记录时默认播哪一个：名字以 boot 开头的优先，否则清单第一个。
 * @param {Array<{name: string}>} videos - 清单。
 * @returns {number} 下标。
 */
function defaultIndex(videos) {
  const boot = videos.findIndex(video => path.basename(video.name, path.extname(video.name)).toLowerCase().startsWith('boot'))
  return boot === -1 ? 0 : boot
}

/**
 * 本次该播清单里的哪一个：记录的选择（且该文件仍然存在）优先，否则默认项。
 * `remembered` 在启动时已经按 rememberChoice 过滤过，之后由 POST 直接更新，
 * 所以这里不再重复判断 —— 它始终代表「本进程当前的选择」。
 * @param {object} runtime - 本次装载的可变状态。
 * @param {Array<object>} videos - 清单。
 * @returns {number} 下标；清单为空时 -1。
 */
function resolveIndex(runtime, videos) {
  if (videos.length === 0) return -1
  if (runtime.remembered !== '') {
    const at = videos.findIndex(video => video.name === runtime.remembered)
    if (at !== -1) return at
  }
  return defaultIndex(videos)
}

/**
 * 清单 + 选中项。
 * @param {object} runtime - 本次装载的可变状态。
 * @returns {{videos: Array<object>, index: number}} 结果。
 */
function resolveSelection(runtime) {
  const videos = listVideos(runtime.config)
  return { videos, index: resolveIndex(runtime, videos) }
}

/**
 * 读 state.json 里记住的文件名。
 * @returns {string} 文件名；没有记录或读不动时为空串。
 */
function readRemembered() {
  return stringOr(readJsonFile(STATE_FILE).file, '')
}

/**
 * 把选择写进 state.json。失败返回 false（调用方会告警并退化为进程内记忆）。
 * @param {string} file - 视频文件名。
 * @returns {boolean} 是否写入成功。
 */
function writeState(file) {
  try {
    fs.writeFileSync(STATE_FILE, `${JSON.stringify({ file, savedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 没有可用视频时的原因说明（用于告警文案）。
 * @param {object} config - 生效配置。
 * @returns {string} 人类可读的原因。
 */
function missingReason(config) {
  const configured = stringOr(config?.file, '')
  if (configured !== '') {
    return `config.json 里 file 指定的视频不可用（不存在或扩展名不认识）：${configured}`
  }
  return `assets/ 里还没有视频文件，把视频丢进 ${ASSETS_DIR} 后刷新浏览器即可`
}

/* ────────────────────────────── 小工具 ────────────────────────────── */

/**
 * stat 一个普通文件，出错就当作不存在。
 * @param {string} file - 绝对路径。
 * @returns {import('node:fs').Stats | null} 结果。
 */
function statFile(file) {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}

/**
 * 由扩展名决定 Content-Type。
 * @param {string} file - 文件路径。
 * @returns {string} MIME 类型。
 */
function mimeOf(file) {
  return VIDEO_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream'
}

/**
 * 安静地读一个 JSON 文件；缺失或损坏都当成空对象。
 * @param {string} file - 绝对路径。
 * @returns {object} 解析出的对象。
 */
function readJsonFile(file) {
  try {
    return plainObject(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return {}
  }
}

/**
 * 只接受普通对象（排除 null / 数组 / 其它类型）。
 * @param {unknown} value - 待判断的值。
 * @returns {object} 原值或空对象。
 */
function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

/**
 * 取字符串，非法或空串则回退。
 * @param {unknown} value - 待判断的值。
 * @param {string} fallback - 回退值。
 * @returns {string} 结果。
 */
function stringOr(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/**
 * 取有限数字，非法则回退（并夹在 0 以上）。
 * @param {unknown} value - 待判断的值。
 * @param {number} fallback - 回退值。
 * @returns {number} 结果。
 */
function numberOr(value, fallback) {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) && num >= 0 ? num : fallback
}

/**
 * 夹一个倍速值到浏览器接受的区间（大于 1 才有意义，上限 16）。
 * @param {number} value - 配置值。
 * @returns {number} 可用的倍速。
 */
function clampRate(value) {
  if (!Number.isFinite(value) || value <= 1) return DEFAULTS.fastRate
  return Math.min(16, value)
}

/**
 * 打日志（logger 在裁剪过的运行环境里也可能缺席）。
 * @param {object} ctx - 插件上下文。
 * @param {'info' | 'warn'} level - 级别。
 * @param {string} message - 内容。
 */
function log(ctx, level, message) {
  const logger = ctx?.logger
  if (typeof logger?.[level] === 'function') logger[level](`boot-video: ${message}`)
}

/** 只提醒一次的告警键集合（避免每次刷新都刷屏）。 */
const warned = new Set()

/**
 * 同一条告警一个进程只打一次。
 * @param {object} ctx - 插件上下文。
 * @param {string} message - 内容。
 */
function logOnce(ctx, message) {
  if (warned.has(message)) return
  warned.add(message)
  log(ctx, 'warn', message)
}

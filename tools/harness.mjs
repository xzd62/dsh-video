/**
 * 自检/预览共用的测试台：一个假的 Cordis 上下文 + 一个真的 node:http 服务器。
 *
 * 它按 @deepseek-ai/dsh-host-webserver 的真实语义实现 `register`（exact / 最长前缀
 * 优先）与 `tapIndex`（fallback 渲染 index.html 时依次执行），所以宿主半在
 * `node tools/selfcheck.mjs` 下跑出来的行为，与装进 dsh web 后一致。
 */

import http from 'node:http'

/**
 * 造一个假的 Cordis 上下文，收集插件注册的路由、index 变换与日志。
 * @returns {{ctx: object, exact: Map<string, object>, prefixes: Map<string, object>, taps: Function[], logs: Array<[string, string]>}} 测试台。
 */
export function createHarness() {
  const exact = new Map()
  const prefixes = new Map()
  const taps = []
  const logs = []

  const webServer = {
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route "${route.path}"`)
      table.set(route.path, route)
      return () => { table.delete(route.path) }
    },
    tapIndex(transform) {
      taps.push(transform)
      return () => {
        const at = taps.indexOf(transform)
        if (at !== -1) taps.splice(at, 1)
      }
    },
    applyIndexTaps(html) {
      let out = html
      for (const transform of taps) out = transform(out)
      return out
    },
  }

  const ctx = {
    webServer,
    logger: {
      info: message => logs.push(['info', message]),
      warn: message => logs.push(['warn', message]),
      error: message => logs.push(['error', message]),
    },
    /** 真实实现是「登记副作用并在卸载时撤销」；测试台里立即执行并返回撤销器。 */
    effect(callback) {
      const disposer = callback()
      return () => { if (typeof disposer === 'function') disposer() }
    },
  }

  return { ctx, exact, prefixes, taps, logs }
}

/**
 * 按 webserver 的匹配顺序找路由：exact 优先，其次最长前缀。
 * @param {object} harness - 测试台。
 * @param {string} pathname - 请求路径。
 * @returns {object | undefined} 命中的路由。
 */
function match(harness, pathname) {
  const exact = harness.exact.get(pathname)
  if (exact !== undefined) return exact
  let best
  for (const [prefix, route] of harness.prefixes) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
    if (best === undefined || prefix.length > best.path.length) best = route
  }
  return best
}

/**
 * 用测试台起一个真实的 HTTP 服务：命中的走插件路由，其余当成 index.html
 * 交给 `applyIndexTaps` 渲染 —— 与 frontend-static 那个 fallback owner 一致。
 * @param {object} harness - 测试台。
 * @param {string} indexHtml - 用作 fallback 的 index.html。
 * @returns {import('node:http').Server} 尚未 listen 的服务器。
 */
export function createServer(harness, indexHtml) {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = match(harness, pathname)
    if (route !== undefined) {
      Promise.resolve(route.handler(req, res)).catch((error) => {
        if (res.headersSent) { res.destroy(); return }
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(String(error))
      })
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(harness.ctx.webServer.applyIndexTaps(indexHtml))
  })
}

/** 空转的 index.html 夹具，结构照抄 apps/web/index.html（只有 #root 与 module script）。 */
export const FIXTURE_INDEX = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '  <head>',
  '    <meta charset="utf-8" />',
  '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
  '    <title>DeepSeek Harness</title>',
  '  </head>',
  '  <body>',
  '    <div id="root"></div>',
  '    <script type="module" src="/src/main.ts"></script>',
  '  </body>',
  '</html>',
  '',
].join('\n')

/** 预览用的假 DSH 界面，用来验证「揭开后看到的是界面」而不是空白。 */
const FAKE_UI = [
  '<style>',
  'body{margin:0;background:#141414;color:#e8e8e8;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif}',
  '#root{display:flex;height:100vh}',
  '.fake-side{width:240px;background:#1b1b1b;border-right:1px solid #2a2a2a;padding:18px}',
  '.fake-main{flex:1;padding:28px}',
  '.fake-title{font-size:18px;font-weight:600;margin:0 0 6px}',
  '.fake-dim{color:#8a8a8a;font-size:12px}',
  '</style>',
  '<script>',
  'document.getElementById("root").innerHTML =',
  '  \'<div class="fake-side"><div class="fake-title">DSH（预览占位）</div>'
  + '<div class="fake-dim">这不是真实的 DSH 界面，只是用来看开机动画的效果。</div></div>\'',
  '  + \'<div class="fake-main"><div class="fake-title">开机动画已揭开</div>'
  + '<div class="fake-dim">如果看到这段文字，说明覆盖层正常退场了。</div></div>\'',
  '</scr' + 'ipt>',
].join('\n')

/** 预览页：假界面 + 会被注入覆盖层的 index.html。 */
export const PREVIEW_INDEX = FIXTURE_INDEX.replace(
  '<div id="root"></div>',
  `<div id="root"></div>\n    ${FAKE_UI}`,
)

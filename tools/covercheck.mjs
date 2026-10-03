/**
 * 浏览器半（lib/cover.js）的行为检查：在自带的极简 DOM 桩里跑真实源码。
 *
 * 重点验证这些用户可见的约定：
 *   1. 自动播放被拦截时给两个选项，「播放视频」只开始播放、不会顺手进入，
 *      「直接进入 DSH」立刻进入；面板空白处点击 = 播放视频；
 *   2. 多个候选时 ↑ ↓ 切换，并把选择 POST 给宿主；单个候选时 ↑ ↓ 不做事；
 *   3. 「N× 快进」按钮切换倍速，且**不会**触发「点击任意处进入」；
 *   4. 播放中点击/按键任意处立即进入，播完自动进入；
 *   5. 播不了时不把人锁在黑屏上（多候选时先提示换一个）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDom, runCover } from './fakedom.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const COVER_SOURCE = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'cover.js'), 'utf8')

/** 让已排队的 Promise 回调跑完。 */
async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

/**
 * 收集右下角所有提示 span（按出现顺序），用来核对每条提示的文案与显隐。
 * @param {object} dom - createDom() 的产物。
 * @returns {object[]} span 元素列表。
 */
function hintSpans(dom) {
  const found = []
  const walk = node => {
    if (node.classList?.contains('dsh-boot-cover-hint')) found.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  const roots = dom.document.body === null ? [dom.document.documentElement] : [dom.document.body]
  for (const root of roots) walk(root)
  return found
}

/**
 * 右下角提示的文字（按顺序拼起来）。
 * @param {object} dom - createDom() 的产物。
 * @returns {string} 以 `|` 连接的文案。
 */
function hintTexts(dom) {
  return hintSpans(dom).map(span => span.textContent).join('|')
}

/** cover.js 在 <html> 上加的隐藏类。 */
const COVER_CLASS = 'dsh-boot-cover'

/**
 * 造一份测试配置。
 * @param {object} [overrides] - 覆盖项。
 * @returns {object} 配置。
 */
function makeConfig(overrides = {}) {
  return {
    videos: [{ name: 'boot.mp4', url: '/boot-video/media/boot.mp4?v=100-1' }],
    current: 0,
    selectUrl: '/boot-video/current',
    canRemember: true,
    fit: 'cover',
    fadeMs: 600,
    muted: false,
    requireSound: true,
    fallbackMuted: true,
    autoEnterAtEnd: true,
    fastRate: 2,
    hint: '点击任意位置进入',
    switchHint: '↑ ↓ 切换视频',
    fullscreenHint: 'F11 可全屏观看',
    prompt: '请选择',
    playLabel: '▶ 播放视频',
    skipLabel: '直接进入 DSH',
    showProgress: true,
    ...overrides,
  }
}

/**
 * 造一个「有 N 个候选」的测试场景：DOM + 已挂载的覆盖层 + 常用句柄。
 * @param {object} [options] - { count, config, bodyPresent }。
 * @returns {Promise<object>} 场景句柄。
 */
async function scene(options = {}) {
  const count = options.count ?? 2
  const videos = []
  for (let i = 0; i < count; i += 1) {
    videos.push({ name: `v${i + 1}.mp4`, url: `/boot-video/media/v${i + 1}.mp4?v=${100 + i}-1` })
  }
  const dom = createDom(options.bodyPresent === undefined ? {} : { bodyPresent: options.bodyPresent })
  dom.document.documentElement.classList.add(COVER_CLASS)
  const posts = []
  dom.window.fetch = (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) })
    return Promise.resolve({ ok: true })
  }
  const config = options.config === undefined ? makeConfig({ videos }) : options.config(videos)
  runCover(dom, config, COVER_SOURCE)
  await settle()
  return {
    dom,
    posts,
    videos,
    video: dom.control.find('video'),
    overlay: dom.control.overlay(),
    panel: dom.control.byClass('dsh-boot-cover-panel'),
    hud: dom.control.byClass('dsh-boot-cover-hud'),
    playButton: dom.control.byKind('play'),
    skipButton: dom.control.byKind('skip'),
    speedButton: dom.control.byKind('speed'),
    /** 面板上的 meta 行（第几个 / 叫什么）。 */
    meta() { return dom.control.byClass('dsh-boot-cover-meta') },
    /** HUD 里的 meta 行。 */
    hudMeta() {
      const hud = dom.control.byClass('dsh-boot-cover-hud')
      return hud === null ? null : hud.find(node => node.classList.contains('dsh-boot-cover-meta'))
    },
    /** 模拟点击某个控件（先 pointerdown 再 click，与真实浏览器一致）。 */
    clickControl(button) {
      dom.control.dispatch(button, 'pointerdown')
      dom.control.dispatch(button, 'click')
    },
    /** 模拟点击覆盖层空白处。 */
    clickBackground() {
      dom.control.dispatch(dom.control.overlay(), 'pointerdown')
    },
    /** 覆盖层是否已开始退场。 */
    leaving() { return dom.control.overlay()?.classList.contains('is-leaving') === true },
    /** 界面是否还被藏着。 */
    hiddenByCover() { return dom.document.documentElement.classList.contains(COVER_CLASS) },
  }
}

/**
 * 跑全部浏览器半用例。
 * @param {(label: string, ok: boolean, detail?: string) => void} check - 断言记录器。
 * @returns {Promise<void>} 完成。
 */
export async function runCoverChecks(check) {
  /* ── A. 正常自动播放 → 点击进入 ─────────────────────────────────────── */
  console.log('\n[6] 播放中点击任意处立即进入')
  {
    const s = await scene({ count: 2 })
    check('挂载后标记 ready（注入脚本的 15 秒兜底据此放弃接管）', s.dom.window.__dshBootVideoReady === true)
    check('覆盖层插入 body', s.overlay !== null && s.overlay.parentNode === s.dom.document.body)
    check('装载的是选中项（第 1 个）', s.video.src === s.videos[0].url)
    check('首次 play() 不带 muted（先争取有声）', s.dom.control.playLog.length === 1 && s.dom.control.playLog[0].muted === false)
    check('播放开始后面板收起了', !s.panel.classList.contains('is-visible'))
    check('播放开始后 HUD 亮起', s.hud.classList.contains('is-visible'))
    check('提供了控制台逃生口 __dshBootVideoSkip', typeof s.dom.window.__dshBootVideoSkip === 'function')

    s.clickBackground()
    check('点击后覆盖层进入退场', s.leaving())
    check('界面隐藏类立刻移除（应用与覆盖层交叉淡入）', !s.hiddenByCover())
    check('淡出用的正是配置里的 fadeMs（外加 60ms 收尾余量）', s.dom.control.pendingDelays().includes(660))
    s.dom.control.flushTimers()
    check('淡出结束后覆盖层从 DOM 移除', s.dom.control.overlay() === null)
    check('结束后标记 done', s.dom.window.__dshBootVideoDone === true)
    check('结束后释放视频源', s.video.attributes.src === undefined)
  }

  /* ── B. 两个选项 ──────────────────────────────────────────────────── */
  console.log('\n[7] 自动播放被拦截时的两个选项')
  {
    const dom = createDom()
    dom.document.documentElement.classList.add(COVER_CLASS)
    let calls = 0
    dom.control.setPlayBehavior(() => { calls += 1; return calls === 1 ? 'reject' : 'resolve' })
    const videos = [
      { name: 'v1.mp4', url: '/boot-video/media/v1.mp4?v=1-1' },
      { name: 'v2.mp4', url: '/boot-video/media/v2.mp4?v=1-1' },
    ]
    runCover(dom, makeConfig({ videos }), COVER_SOURCE)
    await settle()
    const overlay = dom.control.overlay()
    const panel = dom.control.byClass('dsh-boot-cover-panel')
    const playButton = dom.control.byKind('play')
    const skipButton = dom.control.byKind('skip')
    const title = dom.control.byClass('dsh-boot-cover-title')

    check('被拦截时弹出面板', panel.classList.contains('is-visible'))
    check('面板上有「播放视频」与「直接进入 DSH」两个按钮', playButton !== null && skipButton !== null)
    check('面板标题用的是配置里的 prompt', title.textContent === '请选择')
    check('两个按钮文字来自配置', playButton.textContent === '▶ 播放视频' && skipButton.textContent === '直接进入 DSH')
    check('界面仍然藏着（没有提前放行）', dom.document.documentElement.classList.contains(COVER_CLASS))
    check('此时没有进入退场', !overlay.classList.contains('is-leaving'))

    // 点「▶ 播放视频」：只开始播放，不进入
    dom.control.dispatch(playButton, 'pointerdown')
    dom.control.dispatch(playButton, 'click')
    await settle()
    check('点「播放视频」重新发起播放', dom.control.playLog.length === 2)
    check('这一次仍然坚持有声', dom.control.playLog[1].muted === false)
    check('点「播放视频」没有把人送进 DSH', !overlay.classList.contains('is-leaving'))
    check('开始播放后面板收起、HUD 亮起', !panel.classList.contains('is-visible')
      && dom.control.byClass('dsh-boot-cover-hud').classList.contains('is-visible'))
    check('这一次点击只换来「开始播放」，界面继续藏着', dom.document.documentElement.classList.contains(COVER_CLASS))

    // 再点一次空白处才进入
    dom.control.dispatch(overlay, 'pointerdown')
    check('开始播放后点任意处才进入', overlay.classList.contains('is-leaving'))
    dom.control.flushTimers()
  }
  {
    const dom = createDom()
    dom.document.documentElement.classList.add(COVER_CLASS)
    dom.control.setPlayBehavior(() => 'reject')
    runCover(dom, makeConfig(), COVER_SOURCE)
    await settle()
    const overlay = dom.control.overlay()
    const skipButton = dom.control.byKind('skip')
    dom.control.dispatch(skipButton, 'pointerdown')
    dom.control.dispatch(skipButton, 'click')
    check('点「直接进入 DSH」立刻进入', overlay.classList.contains('is-leaving'))
    check('「直接进入」也把界面放开了', !dom.document.documentElement.classList.contains(COVER_CLASS))
    dom.control.flushTimers()
  }
  {
    // 面板空白处点击 = 播放视频
    const dom = createDom()
    dom.document.documentElement.classList.add(COVER_CLASS)
    let calls = 0
    dom.control.setPlayBehavior(() => { calls += 1; return calls === 1 ? 'reject' : 'resolve' })
    runCover(dom, makeConfig(), COVER_SOURCE)
    await settle()
    const panel = dom.control.byClass('dsh-boot-cover-panel')
    dom.control.dispatch(panel, 'pointerdown')
    await settle()
    check('面板空白处点击 = 播放视频（不是直接进入）', dom.control.playLog.length === 2
      && !dom.control.overlay().classList.contains('is-leaving'))
    dom.control.dispatch(dom.control.overlay(), 'pointerdown')
    dom.control.flushTimers()
  }

  /* ── C. ↑↓ 切换 ───────────────────────────────────────────────────── */
  console.log('\n[8] ↑ ↓ 切换视频')
  {
    const s = await scene({ count: 3 })
    check('HUD 上的提示只有切换提醒', s.hudMeta().textContent === '↑ ↓ 切换视频', s.hudMeta().textContent)
    check('HUD 上不出现当前视频的名字', !s.hudMeta().textContent.includes('v1.mp4'), s.hudMeta().textContent)
    check('HUD 上不出现「第几个 / 共几个」计数', !/\d\s*\/\s*\d/.test(s.hudMeta().textContent), s.hudMeta().textContent)
    s.dom.control.dispatchDocument('keydown', { key: 'ArrowDown' })
    await settle()
    check('↓ 切到下一个并换源', s.video.src === s.videos[1].url)
    check('切换后提示不变（不再显示切到了第几个）', s.hudMeta().textContent === '↑ ↓ 切换视频', s.hudMeta().textContent)
    check('切换后把选择 POST 给了宿主', s.posts.length === 1 && s.posts[0].body.file === 'v2.mp4', JSON.stringify(s.posts))
    check('POST 地址来自配置', s.posts[0].url === '/boot-video/current')
    check('切换没有把人送进 DSH', !s.leaving())
    check('切换后继续播放（保持有声）', s.dom.control.playLog.length === 2 && s.dom.control.playLog[1].muted === false)

    s.dom.control.dispatchDocument('keydown', { key: 'ArrowUp' })
    await settle()
    check('↑ 切回上一个', s.video.src === s.videos[0].url)
    s.dom.control.dispatchDocument('keydown', { key: 'ArrowUp' })
    await settle()
    check('在第一个上按 ↑ 环回最后一个', s.video.src === s.videos[2].url)
    check('环回也记录了选择', s.posts[2].body.file === 'v3.mp4')
  }
  {
    const s = await scene({ count: 1 })
    check('单个候选时不显示切换提示', s.meta().textContent === '', s.meta().textContent)
    s.dom.control.dispatchDocument('keydown', { key: 'ArrowDown' })
    check('单个候选时 ↑↓ 不切换、也不进入', s.dom.control.playLog.length === 1 && !s.leaving())
  }
  {
    // 面板状态下切换：只换源不自动播放
    const dom = createDom()
    dom.document.documentElement.classList.add(COVER_CLASS)
    dom.control.setPlayBehavior(() => 'reject')
    const videos = [
      { name: 'v1.mp4', url: '/boot-video/media/v1.mp4?v=1-1' },
      { name: 'v2.mp4', url: '/boot-video/media/v2.mp4?v=1-1' },
    ]
    runCover(dom, makeConfig({ videos }), COVER_SOURCE)
    await settle()
    dom.control.dispatchDocument('keydown', { key: 'ArrowDown' })
    await settle()
    check('等待选择时切换不会触发播放', dom.control.playLog.length === 1, String(dom.control.playLog.length))
    check('等待选择时切换后仍停在面板上', dom.control.byClass('dsh-boot-cover-panel').classList.contains('is-visible'))
    check('等待选择时切换已经换源', dom.control.find('video').src === videos[1].url)
    dom.control.dispatch(dom.control.overlay(), 'pointerdown')
    dom.control.flushTimers()
  }

  /* ── D. 快进按钮 ──────────────────────────────────────────────────── */
  console.log('\n[9] N× 快进按钮')
  {
    const s = await scene({ count: 2 })
    check('按钮初始文字是「2× 快进」', s.speedButton.textContent === '2× 快进', s.speedButton.textContent)
    check('初始倍速是 1', s.video.playbackRate === 1)
    s.clickControl(s.speedButton)
    check('点一下变 2 倍速', s.video.playbackRate === 2)
    check('按钮文字变成「恢复 1× 速度」', s.speedButton.textContent === '恢复 1× 速度', s.speedButton.textContent)
    check('按钮进入选中态', s.speedButton.classList.contains('is-on'))
    check('点快进绝不会进入 DSH', !s.leaving())
    s.clickControl(s.speedButton)
    check('再点一下恢复正常速度', s.video.playbackRate === 1 && !s.speedButton.classList.contains('is-on'))

    s.clickControl(s.speedButton)
    s.dom.control.dispatchDocument('keydown', { key: 'ArrowDown' })
    await settle()
    check('开快进后切换视频，倍速跟着过去', s.video.playbackRate === 2)
    check('切换视频后倍速按钮状态保持', s.speedButton.classList.contains('is-on'))
    s.clickBackground()
    s.dom.control.flushTimers()
  }
  {
    const s = await scene({ count: 1, config: videos => makeConfig({ videos, fastRate: 3.5 }) })
    s.clickControl(s.speedButton)
    check('倍速值取自 config.fastRate', s.video.playbackRate === 3.5 && s.speedButton.textContent === '恢复 1× 速度')
    s.clickBackground()
    s.dom.control.flushTimers()
  }

  /* ── E. 播完 / 键盘 ───────────────────────────────────────────────── */
  console.log('\n[10] 播完与键盘')
  {
    const s = await scene({ count: 2 })
    s.dom.control.dispatch(s.video, 'ended')
    check('autoEnterAtEnd 为真时播完自动进入', s.leaving())
    s.dom.control.flushTimers()
  }
  {
    const s = await scene({ count: 2, config: videos => makeConfig({ videos, autoEnterAtEnd: false }) })
    s.dom.control.dispatch(s.video, 'ended')
    check('autoEnterAtEnd 为假时播完停在最后一帧等点击', !s.leaving())
    check('停在最后一帧时界面仍藏着', s.hiddenByCover())
    s.clickBackground()
    s.dom.control.flushTimers()
  }
  {
    const s = await scene({ count: 2 })
    s.dom.control.dispatchDocument('keydown', { key: 'F5', ctrlKey: true })
    s.dom.control.dispatchDocument('keydown', { key: 'r', metaKey: true })
    check('带修饰键的组合键不接管（Ctrl+F5 / Cmd+R 留给浏览器）', !s.leaving())
    s.dom.control.dispatchDocument('keydown', { key: 'Escape' })
    check('Esc 直接进入', s.leaving())
    s.dom.control.flushTimers()
  }
  {
    // F11 是浏览器全屏键：必须原样留给浏览器，不能被当成「进入」或「开始播放」
    const s = await scene({ count: 2 })
    const press = key => s.dom.control.dispatchDocument('keydown', { key })
    const f11 = press('F11')
    check('播放中按 F11 不进入 DSH', !s.leaving())
    check('F11 不做 preventDefault（浏览器才能切全屏）', f11.defaultPrevented === false)
    check('F11 不是切换视频', s.video.src === s.videos[0].url && s.posts.length === 0)

    // 老浏览器只报 keyCode 的情况
    const legacyF11 = s.dom.control.dispatchDocument('keydown', { key: 'Unidentified', keyCode: 122 })
    check('只报 keyCode=122 时同样不进入', !s.leaving() && legacyF11.defaultPrevented === false)

    s.clickBackground()
    check('F11 之后仍然可以正常点任意处进入', s.leaving())
    s.dom.control.flushTimers()
  }
  {
    // 等待选择时按 F11 也不该开始播放
    const dom = createDom()
    dom.document.documentElement.classList.add(COVER_CLASS)
    dom.control.setPlayBehavior(() => 'reject')
    runCover(dom, makeConfig(), COVER_SOURCE)
    await settle()
    const panel = dom.control.byClass('dsh-boot-cover-panel')
    dom.control.dispatchDocument('keydown', { key: 'F11' })
    await settle()
    check('等待选择时按 F11 不会开始播放', dom.control.playLog.length === 1, String(dom.control.playLog.length))
    check('等待选择时按 F11 也不进入，面板继续等着', !dom.control.overlay().classList.contains('is-leaving')
      && panel.classList.contains('is-visible'))
    dom.control.dispatch(panel, 'pointerdown')
    dom.control.flushTimers()
  }
  {
    // 右下角提示：F11 提示 + 进入提示
    const s = await scene({ count: 2 })
    check('右下角提示里包含 F11 全屏提醒', hintTexts(s.dom).includes('F11 可全屏观看'), hintTexts(s.dom))
    check('右下角提示里保留「点击任意位置进入」', hintTexts(s.dom).includes('点击任意位置进入'), hintTexts(s.dom))
    check('两条提示顺序为 F11 在前、进入在后', hintTexts(s.dom) === 'F11 可全屏观看|点击任意位置进入', hintTexts(s.dom))
    s.clickBackground()
    s.dom.control.flushTimers()
  }
  {
    // 文案给空串 = 不显示（且不占位）
    const s = await scene({
      count: 2,
      config: videos => makeConfig({ videos, fullscreenHint: '' }),
    })
    const hidden = hintSpans(s.dom).filter(span => span.style.display === 'none')
    check('fullscreenHint 给空串时该提示被隐藏', hidden.length === 1 && hidden[0].textContent === '',
      hintTexts(s.dom))
    check('另一条提示不受影响', hintTexts(s.dom).includes('点击任意位置进入'), hintTexts(s.dom))
    s.clickBackground()
    s.dom.control.flushTimers()
  }
  {
    const s = await scene({ count: 2 })
    s.dom.control.dispatchDocument('keydown', { key: 'Enter' })
    check('普通按键进入', s.leaving())
    s.dom.control.flushTimers()
  }

  /* ── F. 播不了 ───────────────────────────────────────────────────── */
  console.log('\n[11] 播不了时的处理')
  {
    const s = await scene({ count: 2 })
    s.dom.control.dispatch(s.video, 'error')
    check('播放中出错 → 直接放行', s.leaving())
    s.dom.control.flushTimers()
  }
  {
    const dom = createDom()
    dom.document.documentElement.classList.add(COVER_CLASS)
    let calls = 0
    dom.control.setPlayBehavior(() => { calls += 1; return calls === 1 ? 'reject' : 'resolve' })
    const videos = [
      { name: 'broken.mkv', url: '/boot-video/media/broken.mkv?v=1-1' },
      { name: 'ok.mp4', url: '/boot-video/media/ok.mp4?v=1-1' },
    ]
    runCover(dom, makeConfig({ videos }), COVER_SOURCE)
    await settle()
    dom.control.dispatch(dom.control.find('video'), 'error')
    check('还有别的候选时，坏视频不把人踢进 DSH', !dom.control.overlay().classList.contains('is-leaving'))
    check('面板上提示哪个播不了', dom.control.byClass('dsh-boot-cover-meta').textContent.includes('broken.mkv')
      && dom.control.byClass('dsh-boot-cover-meta').classList.contains('is-error'),
    dom.control.byClass('dsh-boot-cover-meta').textContent)
    dom.control.dispatchDocument('keydown', { key: 'ArrowDown' })
    await settle()
    check('换到能播的那个后提示恢复正常文案', !dom.control.byClass('dsh-boot-cover-meta').classList.contains('is-error'))
    dom.control.dispatch(dom.control.overlay(), 'pointerdown')
    dom.control.flushTimers()
  }
  {
    const s = await scene({ count: 1 })
    s.dom.control.dispatch(s.video, 'error')
    check('唯一候选播不了 → 立刻放行（不锁黑屏）', s.leaving())
    s.dom.control.flushTimers()
  }
  {
    const dom = createDom()
    dom.document.documentElement.classList.add(COVER_CLASS)
    dom.control.setPlayBehavior(() => 'reject')
    runCover(dom, makeConfig({ requireSound: false }), COVER_SOURCE)
    await settle()
    check('允许放弃声音时先退化为静音重试', dom.control.playLog.length === 2 && dom.control.playLog[1].muted === true)
    check('静音也失败则直接放行', dom.control.overlay().classList.contains('is-leaving'))
    dom.control.flushTimers()
  }

  /* ── G. 进度条 / 减少动态效果 / 异常路径 ───────────────────────────── */
  console.log('\n[12] 进度条、减少动态效果与异常路径')
  {
    const s = await scene({ count: 1 })
    s.video.duration = 10
    s.dom.control.dispatch(s.video, 'loadedmetadata')
    s.video.currentTime = 5
    s.dom.control.dispatch(s.video, 'timeupdate')
    const fill = s.dom.control.byClass('dsh-boot-cover-progress').find(node => node.tagName === 'I')
    check('进度条按 currentTime/duration 推进', fill.style.width === '50.00%', `width=${fill.style.width}`)
    s.video.duration = Number.POSITIVE_INFINITY
    s.dom.control.dispatch(s.video, 'loadedmetadata')
    check('时长未知时进度条宽度不再更新', fill.style.width === '50.00%')
    s.clickBackground()
    s.dom.control.flushTimers()
  }
  {
    const dom = createDom()
    dom.document.documentElement.classList.add(COVER_CLASS)
    dom.control.setReducedMotion(true)
    runCover(dom, makeConfig(), COVER_SOURCE)
    await settle()
    dom.control.dispatch(dom.control.overlay(), 'pointerdown')
    check('系统偏好「减少动态效果」时不淡出', dom.control.pendingDelays().length === 0)
    check('立即移除覆盖层', dom.control.overlay() === null)
  }
  {
    const dom = createDom()
    dom.document.documentElement.classList.add(COVER_CLASS)
    runCover(dom, 'RAW_TOKEN', COVER_SOURCE)
    check('配置占位符没被替换时把界面还回去', !dom.document.documentElement.classList.contains(COVER_CLASS))
    check('没有留下半挂载状态', dom.window.__dshBootVideoMounted !== true)
  }
  {
    const dom = createDom({ bodyPresent: false })
    dom.document.documentElement.classList.add(COVER_CLASS)
    runCover(dom, makeConfig(), COVER_SOURCE)
    check('body 还没解析时不急着挂载', dom.window.__dshBootVideoMounted !== true)
    dom.control.createBody()
    dom.control.dispatchDocument('DOMContentLoaded')
    check('DOMContentLoaded 之后补上挂载', dom.window.__dshBootVideoMounted === true
      && dom.control.overlay() !== null)
  }
  {
    const dom = createDom()
    dom.document.documentElement.classList.add(COVER_CLASS)
    runCover(dom, makeConfig({ videos: [], current: 0 }), COVER_SOURCE)
    await settle()
    check('候选清单为空时也能安全收场', dom.window.__dshBootVideoMounted === true)
    dom.control.dispatch(dom.control.find('video'), 'error')
    check('空清单 + 媒体错误 → 直接放行', dom.control.overlay().classList.contains('is-leaving'))
    dom.control.flushTimers()
  }
  {
    // 旧宿主半（只有单个 src，没有 videos 清单与新增文案）——「刷了代码还没重启」的兼容窗口
    const dom = createDom()
    dom.document.documentElement.classList.add(COVER_CLASS)
    let calls = 0
    dom.control.setPlayBehavior(() => { calls += 1; return calls === 1 ? 'reject' : 'resolve' })
    const legacy = makeConfig({ src: '/boot-video/media?v=100-1' })
    for (const key of ['videos', 'current', 'selectUrl', 'canRemember', 'fastRate', 'prompt', 'hint', 'switchHint', 'playLabel', 'skipLabel']) {
      delete legacy[key]
    }
    runCover(dom, legacy, COVER_SOURCE)
    await settle()
    const overlay = dom.control.overlay()
    check('旧宿主配置下仍然装载并播放那一个视频',
      dom.control.find('video').src === '/boot-video/media?v=100-1' && dom.control.playLog.length === 1)
    check('旧宿主配置下没有切换提示', dom.control.byClass('dsh-boot-cover-meta').textContent === '')

    const panel = dom.control.byClass('dsh-boot-cover-panel')
    check('旧宿主配置下弹出的面板按钮有兜底文案（不会渲染出 undefined）',
      dom.control.byKind('play').textContent === '▶ 播放视频'
      && dom.control.byKind('skip').textContent === '直接进入 DSH',
    `${dom.control.byKind('play').textContent} / ${dom.control.byKind('skip').textContent}`)
    check('旧宿主配置下面板标题与右下角提示也有兜底文案',
      dom.control.byClass('dsh-boot-cover-title').textContent === '🔊 浏览器拦截了自动播放，请选择'
      && hintTexts(dom) === 'F11 可全屏观看|点击任意位置进入',
      `${dom.control.byClass('dsh-boot-cover-title').textContent} / ${hintTexts(dom)}`)
    check('旧宿主配置下倍速按钮有兜底倍速', dom.control.byKind('speed').textContent === '2× 快进')

    dom.control.dispatch(panel, 'pointerdown')
    await settle()
    check('旧宿主配置下点空白处仍能开始播放', dom.control.playLog.length === 2 && !overlay.classList.contains('is-leaving'))
    dom.control.dispatch(overlay, 'pointerdown')
    check('旧宿主配置下点击依然能进入', overlay.classList.contains('is-leaving'))
    dom.control.flushTimers()
  }
}

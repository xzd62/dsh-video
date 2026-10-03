/**
 * dsh-boot-video（浏览器半）—— 全屏视频覆盖层。
 *
 * 由宿主半注入到 index.html 的 <head>：那段同步脚本先给 <html> 加上
 * `dsh-boot-cover` 类（立刻隐藏 #root、把背景刷黑），再异步加载本文件。
 * 因此本文件运行时应用已经藏好了，这里只负责铺视频、收输入、退场。
 *
 * 行为（与 config.json 对应）：
 *  - 打开/刷新页面即尝试播放；`requireSound` 为真时先争取带声音播放。
 *  - 浏览器拦截有声自动播放 → 弹出两个选项：「播放视频」与「直接进入 DSH」，
 *    用户可以自己决定要不要看。空白处点击等同于「播放视频」。
 *  - 有多个视频时 ↑ ↓ 切换；切到哪个就记到宿主（下次启动/刷新仍播这一个）。
 *  - 播放中点击/按键任意处 → 立即淡出进入 DSH；`autoEnterAtEnd` 为真 → 播完自动进入。
 *  - 右下角有「N× 快进」按钮，点一下加速、再点一下恢复正常速度。
 *  - 视频加载/解码失败 → 立即进入；但若还有别的候选视频，先在面板上提示换一个。
 *
 * 调试逃生口：卡住时在控制台执行 `__dshBootVideoSkip()` 立即进入。
 */

(function () {
  'use strict'

  // 宿主半在响应本文件时把这一行替换成真实配置。
  // 必须包 try/catch：万一注入没发生（这一行保持原样），未声明的标识符会抛
  // ReferenceError 并中断整个 IIFE —— 那样界面就被永久藏住了，只能等宿主半
  // 15 秒兜底。这里捕获后立刻把界面还回去，退化成「没有开机动画」而不是黑屏。
  var CFG = null
  try { CFG = __DSH_BOOT_VIDEO_CONFIG__ } catch (error) { CFG = null }

  /** 出错时把界面还回去，并把原因留在控制台。 */
  function bail(error) {
    try { document.documentElement.classList.remove('dsh-boot-cover') } catch (ignored) { /* 忽略 */ }
    if (window.console && console.error) console.error('[dsh-boot-video]', error)
  }

  if (!CFG || typeof CFG !== 'object') { bail(new Error('配置未注入：请重启 dsh web 后硬刷新（Ctrl+F5）')); return }
  if (window.__dshBootVideoMounted === true) return

  /** 挂载点：body 可能还没解析出来，等到 DOMContentLoaded 再建。 */
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })

  function mount() {
    if (window.__dshBootVideoMounted === true) return
    window.__dshBootVideoMounted = true

    var doc = document
    // 兼容窗口：cover.js 每次请求都现读磁盘，而宿主半是进程启动时装载的。
    // 「只刷新了代码、还没重启 dsh web」的这段时间里，本文件是新的、配置是旧的
    // （旧配置只有单个 src，没有 videos 清单）——这时按单候选处理，别让开机动画哑掉。
    var videos = (CFG.videos && CFG.videos.length > 0)
      ? CFG.videos
      : (typeof CFG.src === 'string' && CFG.src !== '' ? [{ name: '', url: CFG.src }] : [])
    var canSwitch = videos.length > 1
    var switchHint = hintText(CFG.switchHint, '↑ ↓ 切换视频')
    var index = clampIndex(CFG.current)
    var fadeMs = resolveFade()
    var fastRate = toRate(CFG.fastRate)
    var speedOn = false
    var state = 'loading' // loading | choosing | playing | leaving
    var entered = false
    var gestureTried = false
    var duration = 0
    /** 某个候选视频播不了时的提示（空串表示没有）。 */
    var notice = ''

    /* ───────── 结构 ───────── */

    var style = doc.createElement('style')
    style.textContent = css(fadeMs)
    doc.head.appendChild(style)

    var overlay = doc.createElement('div')
    overlay.className = 'dsh-boot-cover-layer'
    overlay.setAttribute('role', 'presentation')
    overlay.setAttribute('aria-label', 'DSH 开机动画')

    var video = doc.createElement('video')
    video.className = 'dsh-boot-cover-video' + (CFG.fit === 'contain' ? ' is-contain' : '')
    video.preload = 'auto'
    video.autoplay = false
    video.loop = false
    video.muted = CFG.muted === true
    video.volume = 1
    video.setAttribute('playsinline', '')
    video.setAttribute('webkit-playsinline', '')
    video.setAttribute('disablepictureinpicture', '')
    overlay.appendChild(video)

    // 中央面板：自动播放被拦截时给出两个选项。
    var panel = doc.createElement('div')
    panel.className = 'dsh-boot-cover-panel'
    var title = doc.createElement('div')
    title.className = 'dsh-boot-cover-title'
    title.textContent = label(CFG.prompt, '🔊 浏览器拦截了自动播放，请选择')
    var actions = doc.createElement('div')
    actions.className = 'dsh-boot-cover-actions'
    var playButton = control(label(CFG.playLabel, '▶ 播放视频'), 'primary', 'play')
    var skipButton = control(label(CFG.skipLabel, '直接进入 DSH'), 'ghost', 'skip')
    actions.appendChild(playButton)
    actions.appendChild(skipButton)
    var panelMeta = doc.createElement('div')
    panelMeta.className = 'dsh-boot-cover-meta'
    panel.appendChild(title)
    panel.appendChild(actions)
    panel.appendChild(panelMeta)
    overlay.appendChild(panel)

    // 右下角 HUD：倍速按钮 + 进入提示 + 当前视频。
    var hud = doc.createElement('div')
    hud.className = 'dsh-boot-cover-hud'
    var hudMeta = doc.createElement('div')
    hudMeta.className = 'dsh-boot-cover-meta'
    var hudRow = doc.createElement('div')
    hudRow.className = 'dsh-boot-cover-row'
    var speedButton = control(speedLabel(), 'chip', 'speed')
    hudRow.appendChild(speedButton)
    hudRow.appendChild(hudHint(hintText(CFG.fullscreenHint, 'F11 可全屏观看')))
    hudRow.appendChild(hudHint(hintText(CFG.hint, '点击任意位置进入')))
    hud.appendChild(hudMeta)
    hud.appendChild(hudRow)
    overlay.appendChild(hud)

    var progress = doc.createElement('div')
    progress.className = 'dsh-boot-cover-progress'
    var fill = doc.createElement('i')
    progress.appendChild(fill)
    overlay.appendChild(progress)

    doc.body.appendChild(overlay)

    // 告诉注入脚本「覆盖层已经就位」，15 秒兜底计时器（见宿主半）据此放弃接管。
    window.__dshBootVideoReady = true
    window.__dshBootVideoSkip = enter
    window.__dshBootVideoNext = function () { step(1) }

    /* ───────── 输入 ───────── */

    // 只认 pointerdown：click 要等抬起，而「第一次点击 = 开始播放」必须和
    // 随之而来的 click 事件区分开，否则那一次点击会既开始播放又直接进入。
    if (window.PointerEvent !== undefined) {
      overlay.addEventListener('pointerdown', onPress, true)
    } else {
      overlay.addEventListener('mousedown', onPress, true)
      overlay.addEventListener('touchstart', onPress, true)
    }
    // 覆盖层在退场淡出的这段时间里仍然吃事件：否则 pointerup/click 会穿透到
    // 底下刚亮出来的 DSH 界面上，误触到按钮。（面板与 HUD 自身是
    // pointer-events:none，只有按钮可点，所以这里不需要额外吞 click。）
    overlay.addEventListener('contextmenu', swallow, true)
    overlay.addEventListener('dragstart', swallow, true)
    doc.addEventListener('keydown', onKey, true)

    video.addEventListener('loadedmetadata', onMetadata)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('ended', onEnded)
    video.addEventListener('error', onMediaError)

    loadCurrent()
    attemptPlay(false)

    /* ───────── 控件 ───────── */

    /**
     * 造一个覆盖层内的控件。带 `data-dsh-boot-ui` 标记，这样覆盖层的
     * 「点任意处」处理器会跳过它 —— 否则点「快进」会顺手把人送进 DSH。
     * @param {string} label - 按钮文字。
     * @param {string} variant - 样式变体（primary / ghost / chip）。
     * @param {string} kind - 行为标识（play / skip / speed）。
     * @returns {object} button 元素。
     */
    function control(label, variant, kind) {
      var element = doc.createElement('button')
      element.type = 'button'
      element.className = 'dsh-boot-cover-btn ' + variant
      element.textContent = label
      element.setAttribute('data-dsh-boot-ui', kind)
      element.addEventListener('click', function (event) {
        swallow(event)
        onControl(kind)
      })
      return element
    }

    /**
     * 面板/HUD 上的按钮被点了。
     * @param {string} kind - 行为标识。
     */
    function onControl(kind) {
      if (state === 'leaving') return
      if (kind === 'play') { attemptPlay(true); return }
      if (kind === 'skip') { enter(); return }
      if (kind === 'speed') toggleSpeed()
    }

    /**
     * 事件目标是否落在覆盖层自己的控件上。
     * @param {object} target - 事件目标。
     * @returns {boolean} 是控件则为真。
     */
    function isControl(target) {
      return Boolean(target) && typeof target.closest === 'function'
        && target.closest('[data-dsh-boot-ui]') !== null
    }

    /* ───────── 播放 ───────── */

    /**
     * 调一次 video.play() 并把结果分流。
     * @param {boolean} byGesture - 本次是否由用户手势触发。
     */
    function attemptPlay(byGesture) {
      if (state === 'leaving') return
      if (byGesture) gestureTried = true
      var result
      try {
        result = video.play()
      } catch (error) {
        onPlayFailed(error)
        return
      }
      if (result && typeof result.then === 'function') {
        result.then(onPlaying, onPlayFailed)
        return
      }
      onPlaying()
    }

    /** 真正开始播了：收起面板，亮出 HUD 与进度条。 */
    function onPlaying() {
      if (state === 'leaving') return
      state = 'playing'
      hide(panel)
      show(hud)
      if (CFG.showProgress === true) show(progress)
    }

    /**
     * 播不动时的降级阶梯：给选择 → 静音 → 直接放行。
     * @param {unknown} error - play() 抛出的原因。
     */
    function onPlayFailed(error) {
      if (state === 'leaving') return
      // 1) 需要有声音，且还没试过手势：摆出两个选项让用户决定。
      if (CFG.requireSound === true && video.muted !== true && !gestureTried) {
        state = 'choosing'
        show(panel)
        hide(hud)
        return
      }
      // 2) 允许退化：静音再试一次（重试一次就够，失败会走到第 3 步）。
      if (CFG.fallbackMuted === true && video.muted !== true) {
        video.muted = true
        attemptPlay(false)
        return
      }
      // 3) 真播不了：别把人锁在黑屏上。
      if (window.console && console.warn) console.warn('[dsh-boot-video] 视频无法播放，直接进入：', error)
      enter()
    }

    /* ───────── 媒体事件 ───────── */

    function onMetadata() {
      duration = Number.isFinite(video.duration) ? video.duration : 0
      if (duration === 0) hide(progress)
    }

    function onTimeUpdate() {
      if (duration <= 0) return
      var ratio = Math.min(1, Math.max(0, video.currentTime / duration))
      fill.style.width = (ratio * 100).toFixed(2) + '%'
    }

    function onEnded() {
      if (state === 'leaving') return
      if (CFG.autoEnterAtEnd === true) { enter(); return }
      show(hud)
    }

    function onMediaError() {
      var name = videos.length > 0 ? videos[index].name : ''
      if (window.console && console.error) console.error('[dsh-boot-video] 视频加载/解码失败：', name, video.error)
      // 还有别的候选：提示换一个，而不是把人踢进 DSH（.mkv/.avi 这类很常见）。
      if (state === 'choosing' && canSwitch) {
        notice = name
        syncMeta()
        return
      }
      enter()
    }

    /* ───────── 视频清单 ───────── */

    /** 装载当前选中的视频，并让倍速设置跟过去。 */
    function loadCurrent() {
      if (videos.length === 0) return
      duration = 0
      fill.style.width = '0%'
      hide(progress)
      video.src = videos[index].url
      try { video.load() } catch (ignored) { /* 忽略 */ }
      // load() 会把 playbackRate 重置回 defaultPlaybackRate，所以必须放在它之后。
      video.playbackRate = speedOn ? fastRate : 1
      syncMeta()
    }

    /**
     * 按方向切换视频（环形）。
     * @param {number} delta - +1 下一个，-1 上一个。
     */
    function step(delta) {
      if (!canSwitch) return
      select((index + delta + videos.length) % videos.length)
    }

    /**
     * 切到指定下标：换源、记录选择、必要时继续播放。
     * @param {number} next - 目标下标。
     */
    function select(next) {
      if (!canSwitch || next === index) return
      var wasPlaying = state === 'playing' || state === 'loading'
      index = next
      notice = ''
      loadCurrent()
      remember()
      if (wasPlaying) attemptPlay(false)
    }

    /** 把当前选择告诉宿主，让它记住（写 state.json）。 */
    function remember() {
      if (CFG.canRemember === false || videos.length === 0) return
      var sender = (window && typeof window.fetch === 'function') ? window.fetch : null
      if (sender === null) return
      try {
        var result = sender(CFG.selectUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: videos[index].name }),
          keepalive: true,
        })
        if (result && typeof result.catch === 'function') result.catch(function () { /* 记录失败不影响观看 */ })
      } catch (error) { /* 同上 */ }
    }

    /**
     * 面板与 HUD 上的提示行。只提示「可以 ↑↓ 切换」，**不显示当前是哪个视频**：
     * 播放时那是噪音。唯一需要点名的是「某个文件播不了」——那时才带上文件名。
     */
    function syncMeta() {
      var text = ''
      if (canSwitch && videos.length > 0) {
        text = notice === '' ? switchHint : '无法播放 ' + notice + ' —— 用 ↑ ↓ 换一个'
      }
      panelMeta.textContent = text
      hudMeta.textContent = text
      setFlag(panelMeta, 'is-error', notice !== '')
      setFlag(hudMeta, 'is-error', notice !== '')
      setFlag(panelMeta, 'is-visible', text !== '')
      setFlag(hudMeta, 'is-visible', text !== '')
    }

    /* ───────── 倍速 ───────── */

    /** 在 1× 与配置的倍速之间切换。 */
    function toggleSpeed() {
      if (state === 'leaving') return
      speedOn = !speedOn
      video.playbackRate = speedOn ? fastRate : 1
      speedButton.textContent = speedLabel()
      setFlag(speedButton, 'is-on', speedOn)
    }

    /**
     * 倍速按钮的文字。
     * @returns {string} 按钮文案。
     */
    function speedLabel() {
      return speedOn ? '恢复 1× 速度' : fastRate + '× 快进'
    }

    /* ───────── 输入处理 ───────── */

    function onPress(event) {
      if (isControl(event.target)) return
      if (state === 'choosing') {
        swallow(event)
        attemptPlay(true) // 有手势了，这一次就能带声音开始
        return
      }
      if (state === 'playing' || state === 'loading') {
        swallow(event)
        enter()
      }
    }

    function onKey(event) {
      if (state === 'leaving') return
      // 带修饰键的组合（Ctrl+F5、F12、Cmd+R…）一律不接管，留给浏览器。
      if (event.ctrlKey || event.metaKey || event.altKey) return
      // F11 是浏览器的全屏键：按它只切全屏，绝不能顺手把人送进 DSH。
      // 这里也不 preventDefault —— 全屏必须由浏览器自己处理。
      if (event.key === 'F11' || event.keyCode === 122) return
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        if (!canSwitch) return
        swallow(event)
        step(event.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (event.key === 'Escape' || event.key === 'Esc') { enter(); return }
      if (state === 'choosing') { attemptPlay(true); return }
      if (state === 'playing' || state === 'loading') enter()
    }

    function swallow(event) {
      if (typeof event.preventDefault === 'function') event.preventDefault()
      if (typeof event.stopPropagation === 'function') event.stopPropagation()
    }

    /* ───────── 退场 ───────── */

    /** 揭开界面：先移除隐藏类（应用开始画），覆盖层同时在它上面淡出。 */
    function enter() {
      if (entered) return
      entered = true
      state = 'leaving'
      doc.removeEventListener('keydown', onKey, true)
      overlay.classList.add('is-leaving')
      try { video.pause() } catch (ignored) { /* 忽略 */ }

      // 先把界面还回去：应用与覆盖层交叉淡入淡出，而不是「黑一下再出现」。
      doc.documentElement.classList.remove('dsh-boot-cover')

      var finish = function () {
        try { video.removeAttribute('src'); video.load() } catch (ignored) { /* 忽略 */ }
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
        if (style.parentNode) style.parentNode.removeChild(style)
        window.__dshBootVideoDone = true
      }
      if (fadeMs > 0) window.setTimeout(finish, fadeMs + 60)
      else finish()
    }

    /* ───────── 小工具 ───────── */

    /**
     * 把下标夹进可用范围。
     * @param {unknown} value - 候选下标。
     * @returns {number} 合法下标。
     */
    function clampIndex(value) {
      if (videos.length === 0) return 0
      var num = Math.floor(Number(value))
      if (!Number.isFinite(num)) return 0
      return Math.min(Math.max(0, num), videos.length - 1)
    }

    /**
     * 倍速值兜底：必须大于 1 才有意义。
     * @param {unknown} value - 配置值。
     * @returns {number} 可用倍速。
     */
    function toRate(value) {
      var num = Number(value)
      return (Number.isFinite(num) && num > 1) ? Math.min(16, num) : 2
    }

    /**
     * 造一条右下角提示文字。文案为空时整条隐藏 —— 配置里给空串就是「不要这条」。
     * @param {string} text - 提示文字。
     * @returns {object} span 元素。
     */
    function hudHint(text) {
      var span = doc.createElement('span')
      span.className = 'dsh-boot-cover-hint'
      span.textContent = text
      if (text === '') span.style.display = 'none'
      return span
    }

    /**
     * 文案兜底：宿主半可能比本文件旧（配置在 dsh web 启动时就冻结了，而本文件
     * 每次请求都现读磁盘），所以任何文案都不能假设它一定送来了 —— 否则按钮上
     * 会直接渲染出 "undefined"。空串按「没给」处理，按钮不会变成空白。
     * @param {unknown} value - 配置值。
     * @param {string} fallback - 兜底文案。
     * @returns {string} 可用文案。
     */
    function label(value, fallback) {
      return typeof value === 'string' && value !== '' ? value : fallback
    }

    /**
     * 提示类文案：宿主给了字符串就照用，**空串表示「不要显示这条提示」**；
     * 只有键完全没给（旧宿主半）才用兜底。
     * @param {unknown} value - 配置值。
     * @param {string} fallback - 兜底文案。
     * @returns {string} 要显示的文案（可能为空）。
     */
    function hintText(value, fallback) {
      return typeof value === 'string' ? value : fallback
    }

    /**
     * 开关一个类名。
     * @param {object} element - 目标元素。
     * @param {string} name - 类名。
     * @param {boolean} on - 是否加上。
     */
    function setFlag(element, name, on) {
      if (on) element.classList.add(name)
      else element.classList.remove(name)
    }

    function show(element) { element.classList.add('is-visible') }
    function hide(element) { element.classList.remove('is-visible') }

    /**
     * 淡出时长：尊重系统的「减少动态效果」偏好。
     * @returns {number} 毫秒。
     */
    function resolveFade() {
      var reduced = false
      try {
        reduced = typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      } catch (ignored) { /* 忽略 */ }
      if (reduced) return 0
      return typeof CFG.fadeMs === 'number' && CFG.fadeMs >= 0 ? CFG.fadeMs : 600
    }

    /**
     * 覆盖层样式。z-index 取 int32 上限，确保盖在任何应用层之上。
     * 面板与 HUD 都是 pointer-events:none，只有按钮可点 —— 这样「点任意处」
     * 在面板空白处、提示文字上也照样有效。
     * @param {number} ms - 淡出时长。
     * @returns {string} CSS 文本。
     */
    function css(ms) {
      var font = 'system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif'
      return ''
        + '.dsh-boot-cover-layer{position:fixed;left:0;top:0;right:0;bottom:0;'
        + 'z-index:2147483647;background:#000;display:flex;align-items:center;justify-content:center;'
        + 'overflow:hidden;cursor:pointer;opacity:1;'
        + 'transition:opacity ' + ms + 'ms ease;'
        + 'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}'
        + '.dsh-boot-cover-layer.is-leaving{opacity:0;cursor:default}'
        + '.dsh-boot-cover-video{display:block;width:100%;height:100%;object-fit:cover;background:#000}'
        + '.dsh-boot-cover-video.is-contain{object-fit:contain}'
        + '.dsh-boot-cover-panel{position:absolute;display:none;flex-direction:column;align-items:center;'
        + 'gap:18px;padding:26px 34px;border-radius:20px;background:rgba(0,0,0,.58);'
        + 'border:1px solid rgba(255,255,255,.16);backdrop-filter:blur(8px);'
        + 'max-width:min(560px,86vw);text-align:center;pointer-events:none}'
        + '.dsh-boot-cover-panel.is-visible{display:flex}'
        + '.dsh-boot-cover-title{color:#fff;font:500 17px/1.5 ' + font + ';letter-spacing:.02em}'
        + '.dsh-boot-cover-actions{display:flex;gap:12px;flex-wrap:wrap;justify-content:center}'
        + '.dsh-boot-cover-btn{pointer-events:auto;appearance:none;cursor:pointer;'
        + 'border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:11px 22px;'
        + 'font:500 15px/1 ' + font + ';color:#fff;background:rgba(255,255,255,.10);'
        + 'transition:background .18s ease,transform .18s ease,border-color .18s ease,color .18s ease}'
        + '.dsh-boot-cover-btn:hover{background:rgba(255,255,255,.2)}'
        + '.dsh-boot-cover-btn:active{transform:scale(.97)}'
        + '.dsh-boot-cover-btn.primary{background:#fff;color:#111;border-color:#fff}'
        + '.dsh-boot-cover-btn.primary:hover{background:#eaeaea}'
        + '.dsh-boot-cover-btn.chip{padding:7px 14px;font-size:13px;background:rgba(0,0,0,.45)}'
        + '.dsh-boot-cover-btn.chip.is-on{background:#fff;color:#111;border-color:#fff}'
        + '.dsh-boot-cover-hud{position:absolute;right:26px;bottom:24px;display:none;'
        + 'flex-direction:column;align-items:flex-end;gap:10px;pointer-events:none}'
        + '.dsh-boot-cover-hud.is-visible{display:flex}'
        + '.dsh-boot-cover-row{display:flex;align-items:center;gap:14px}'
        + '.dsh-boot-cover-meta{display:none;color:rgba(255,255,255,.66);'
        + 'font:400 12px/1.5 ' + font + ';letter-spacing:.04em;text-shadow:0 1px 6px rgba(0,0,0,.6)}'
        + '.dsh-boot-cover-meta.is-visible{display:block}'
        + '.dsh-boot-cover-meta.is-error{color:#ff9a9a}'
        + '.dsh-boot-cover-hint{color:rgba(255,255,255,.72);font:400 13px/1 ' + font + ';'
        + 'letter-spacing:.06em;text-shadow:0 1px 6px rgba(0,0,0,.6)}'
        + '.dsh-boot-cover-progress{position:absolute;left:0;right:0;bottom:0;height:2px;'
        + 'background:rgba(255,255,255,.14);opacity:0;transition:opacity .4s ease;pointer-events:none}'
        + '.dsh-boot-cover-progress.is-visible{opacity:1}'
        + '.dsh-boot-cover-progress i{display:block;height:100%;width:0;background:rgba(255,255,255,.62);'
        + 'transition:width .18s linear}'
    }
  }
})()

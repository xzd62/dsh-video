/**
 * 极简 DOM 桩：只为验证 lib/cover.js 的行为，不引入 jsdom 之类的依赖。
 *
 * 它实现 cover.js 真正用到的那一小撮接口：createElement / appendChild /
 * className+classList / style / textContent / setAttribute / addEventListener /
 * dispatchEvent，外加一个可编程的 HTMLMediaElement#play 与可控的定时器队列。
 *
 * 刻意保持「小而准」：桩里实现什么，就是 cover.js 被允许依赖什么。
 */

/** 元素 class 列表（add/remove/contains）。 */
class ClassList {
  constructor() { this.names = new Set() }
  add(...names) { for (const name of names) this.names.add(name) }
  remove(...names) { for (const name of names) this.names.delete(name) }
  contains(name) { return this.names.has(name) }
  toString() { return [...this.names].join(' ') }
}

/**
 * 把一个简化选择器编译成判定函数（只支持 `[attr]` / `.class` / `TAG`）。
 * @param {string} selector - 选择器。
 * @returns {(node: object) => boolean} 判定函数。
 */
function matcher(selector) {
  const attribute = /^\[([^\]=]+)\]$/.exec(selector)
  if (attribute !== null) return node => node.attributes?.[attribute[1]] !== undefined
  const className = /^\.([\w-]+)$/.exec(selector)
  if (className !== null) return node => node.classList?.contains(className[1]) === true
  return node => node.tagName === selector.toUpperCase()
}

/** 一个够用的元素：父/子关系、类名、内联样式、属性、事件监听。 */
class Element {
  constructor(tagName, owner) {
    this.tagName = String(tagName).toUpperCase()
    this.ownerDocument = owner
    this.children = []
    this.parentNode = null
    this.classList = new ClassList()
    this.style = {}
    this.attributes = {}
    this.listeners = []
    this.textContent = ''
  }

  get className() { return this.classList.toString() }
  set className(value) {
    this.classList = new ClassList()
    for (const name of String(value).split(/\s+/)) if (name !== '') this.classList.add(name)
  }

  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  removeChild(child) {
    const at = this.children.indexOf(child)
    if (at !== -1) this.children.splice(at, 1)
    child.parentNode = null
    return child
  }

  setAttribute(name, value) { this.attributes[name] = String(value) }
  removeAttribute(name) { delete this.attributes[name] }

  /**
   * 向上找最近的匹配祖先（含自身）。只支持 cover.js 用到的三种形式：
   * `[attr]`、`.class`、`TAG`。
   * @param {string} selector - 选择器。
   * @returns {Element | null} 命中的元素。
   */
  closest(selector) {
    const test = matcher(selector)
    let node = this
    while (node !== null && node !== undefined) {
      if (test(node)) return node
      node = node.parentNode
    }
    return null
  }

  addEventListener(type, listener, options) {
    this.listeners.push({ type, listener, capture: options === true || options?.capture === true })
  }
  removeEventListener(type, listener) {
    this.listeners = this.listeners.filter(entry => !(entry.type === type && entry.listener === listener))
  }

  /** 深度优先找后代（含自身）中第一个满足条件的元素。 */
  find(predicate) {
    if (predicate(this)) return this
    for (const child of this.children) {
      const hit = child.find(predicate)
      if (hit !== null) return hit
    }
    return null
  }
}

/**
 * 造一个 DOM 世界。
 * @param {{bodyPresent?: boolean}} [options] - bodyPresent 为 false 时不建 body（验证 DOMContentLoaded 分支）。
 * @returns {object} { window, document, control... } 测试句柄。
 */
export function createDom(options = {}) {
  const timers = []
  let timerSeq = 0
  const playLog = []
  /** 由测试设置：返回 'resolve' | 'reject' | Promise。 */
  let playBehavior = () => 'resolve'
  let mediaQueryMatches = false

  const document = {
    documentElement: null,
    head: null,
    body: null,
    createElement(tagName) {
      const element = new Element(tagName, document)
      if (element.tagName === 'VIDEO') attachMediaBehavior(element)
      return element
    },
    addEventListener(type, listener, options) {
      documentListeners.push({ type, listener, capture: options === true || options?.capture === true })
    },
    removeEventListener(type, listener) {
      for (let i = documentListeners.length - 1; i >= 0; i -= 1) {
        const entry = documentListeners[i]
        if (entry.type === type && entry.listener === listener) documentListeners.splice(i, 1)
      }
    },
  }
  const documentListeners = []

  document.documentElement = new Element('html', document)
  document.head = new Element('head', document)
  if (options.bodyPresent !== false) document.body = new Element('body', document)

  /** 让 video 元素拥有可编程的 play/pause/load 与媒体属性。 */
  function attachMediaBehavior(video) {
    video.muted = false
    video.volume = 1
    video.currentTime = 0
    video.duration = Number.NaN
    video.error = null
    video.playCalls = 0
    video.play = () => {
      video.playCalls += 1
      playLog.push({ muted: video.muted, call: video.playCalls })
      const outcome = playBehavior(video, video.playCalls)
      if (outcome && typeof outcome.then === 'function') return outcome
      if (outcome === 'reject') {
        const error = new Error('play() failed')
        error.name = 'NotAllowedError'
        return Promise.reject(error)
      }
      return Promise.resolve()
    }
    video.pause = () => { video.paused = true }
    video.load = () => {}
    video.removeAttribute = name => { delete video.attributes[name]; if (name === 'src') video.src = undefined }
  }

  const window = {
    PointerEvent: function PointerEvent() {},
    setTimeout(callback, delay) {
      timerSeq += 1
      timers.push({ id: timerSeq, callback, delay: Number(delay) || 0 })
      return timerSeq
    },
    clearTimeout(id) {
      const at = timers.findIndex(entry => entry.id === id)
      if (at !== -1) timers.splice(at, 1)
    },
    matchMedia: () => ({ matches: mediaQueryMatches }),
    console: { log() {}, warn() {}, error() {} },
  }

  /**
   * 在 body（或 documentElement）子树里找第一个满足条件的元素。
   * @param {(node: object) => boolean} predicate - 判定函数。
   * @returns {object | null} 命中的元素。
   */
  function findFromBody(predicate) {
    const roots = document.body === null ? [document.documentElement] : [document.body]
    for (const root of roots) {
      const hit = root.find(predicate)
      if (hit !== null) return hit
    }
    return null
  }

  const control = {
    /** 从 body（或 documentElement）里找第一个该标签的元素。 */
    find(tagName) {
      return findFromBody(node => node.tagName === String(tagName).toUpperCase())
    },
    /** 按类名找第一个元素（用来定位面板 / HUD / 提示）。 */
    byClass(className) {
      return findFromBody(node => node.classList.contains(className))
    },
    /** 按 `data-dsh-boot-ui` 值找控件（play / skip / speed）。 */
    byKind(kind) {
      return findFromBody(node => node.attributes['data-dsh-boot-ui'] === kind)
    },
    /** 覆盖层元素（body 里的第一个 div）。 */
    overlay() { return control.find('div') },
    /** 补一个 body，用来验证 DOMContentLoaded 分支。 */
    createBody() {
      document.body = new Element('body', document)
      return document.body
    },
    /** 设置 play() 的行为。 */
    setPlayBehavior(behavior) { playBehavior = behavior },
    /** 设置 prefers-reduced-motion 的结果。 */
    setReducedMotion(matches) { mediaQueryMatches = matches === true },
    /** 每次 play() 调用时 video.muted 的快照。 */
    playLog,
    /**
     * 派发一个事件，模拟真实的捕获 → 目标 → 冒泡三阶段（含 stopPropagation）。
     * 覆盖层把「点任意处」的监听器挂在祖先节点上并用 capture，所以传播必须真实，
     * 否则「点控件不该进入」这类用例根本测不到。
     * @param {object} element - 事件目标。
     * @param {string} type - 事件类型。
     * @param {object} [props] - 附加到事件对象上的字段。
     * @returns {object} 事件对象。
     */
    dispatch(element, type, props = {}) {
      const event = {
        type,
        target: element,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true },
        stopPropagation() { this.propagationStopped = true },
        ...props,
      }
      const chain = []
      let node = element
      while (node !== null && node !== undefined) {
        chain.push(node)
        node = node.parentNode
      }
      // 捕获阶段：最外层祖先 → 目标
      for (const current of [...chain].reverse()) {
        for (const entry of [...current.listeners]) {
          if (entry.type === type && entry.capture && !event.propagationStopped) entry.listener(event)
        }
      }
      // 目标阶段 + 冒泡阶段
      for (const current of chain) {
        for (const entry of [...current.listeners]) {
          if (entry.type === type && !entry.capture && !event.propagationStopped) entry.listener(event)
        }
      }
      for (const entry of [...documentListeners]) {
        if (entry.type === type && !event.propagationStopped) entry.listener(event)
      }
      return event
    },
    /** 派发 document 级事件（keydown / DOMContentLoaded）。 */
    dispatchDocument(type, props = {}) {
      const event = {
        type,
        target: document,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true },
        stopPropagation() {},
        ...props,
      }
      for (const entry of [...documentListeners]) {
        if (entry.type === type) entry.listener(event)
      }
      return event
    },
    /** 跑完所有排队中的定时器（按延迟顺序）。 */
    flushTimers() {
      let guard = 0
      while (timers.length > 0 && guard < 100) {
        guard += 1
        timers.sort((a, b) => a.delay - b.delay || a.id - b.id)
        const entry = timers.shift()
        entry.callback()
      }
    },
    /** 待处理的定时器延迟列表（用于断言淡出时长）。 */
    pendingDelays() { return timers.map(entry => entry.delay) },
  }

  return { window, document, control }
}

/**
 * 在桩环境里执行 lib/cover.js（把配置占位符替换掉）。
 * @param {object} dom - createDom() 的产物。
 * @param {object | string} config - 注入的配置对象；传 'RAW_TOKEN' 表示不做替换（模拟注入失败）。
 * @param {string} source - lib/cover.js 原文。
 * @returns {void}
 */
export function runCover(dom, config, source) {
  const code = config === 'RAW_TOKEN'
    ? source
    : source.replace('__DSH_BOOT_VIDEO_CONFIG__', JSON.stringify(config))
  const factory = new Function('window', 'document', 'console', code)
  factory(dom.window, dom.document, dom.window.console)
}

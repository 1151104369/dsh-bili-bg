/*
 * dsh-bili-bg — 注入到 index.html 的浏览器运行时。
 *
 * 这个文件是**脚本文本**（`kind:'script'`），不是模块：宿主整个读出来塞进结构化注入行。
 * 因此：不能抛异常（求值失败会让页面起不来），只用 ES5 级语法（兼容性最稳）。
 *
 * 它把 B 站视频做成一块"可控制、可关掉、可轮播"的全屏背景：
 *   · 输入 BV 号（或 bilibili 链接）→ 经宿主代理解析并播放；
 *   · 播放/暂停、静音/音量、上一个/下一个、专注（隐藏视频）；
 *   · 轮播：自动播热门/排行榜，一支放完自动切下一支；
 *   · 界面表面按滑块半透明（内联 !important 写 --dsw-alias-*），保证聊天文字可读；
 *   · 用户设置 + 上次 BV 落盘到 $DSH_HOME/dsh-bili-bg.json，重开 DSH 后恢复（不自动开播）。
 *
 * 依赖的宿主契约（见 index.js）：config / play / media / queue / state 五个路由。
 * 任何一步失败都只更新面板状态行，绝不影响 DSH 本身。
 */
;(function (global) {
  'use strict'

  var NS = '__DSH_BILI_BG__'
  if (global.__DSH_BILI_BG_STARTED__ === true) return
  var cfg = global[NS]
  if (cfg === null || typeof cfg !== 'object') return
  if (global.document === undefined || global.document === null) return
  global.__DSH_BILI_BG_STARTED__ = true

  var doc = global.document
  var d = isObj(cfg.defaults) ? cfg.defaults : {}
  var ROUTES = {
    config: str(cfg.config),
    play: str(cfg.play),
    media: str(cfg.media),
    queue: str(cfg.queue),
    state: str(cfg.state),
  }

  // ────────────────────────────── 小工具 ──────────────────────────────

  function isObj(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  }
  function str(v) {
    return typeof v === 'string' ? v : ''
  }
  function num(v, fallback, min, max) {
    var n = typeof v === 'number' ? v : Number(v)
    if (n !== n) return fallback
    if (n < min) return min
    if (n > max) return max
    return n
  }
  function noop() {}
  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v
  }
  function el(tag, className, text) {
    var node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  function formatTime(sec) {
    var s = Math.max(0, Math.floor(Number(sec) || 0))
    var m = Math.floor(s / 60)
    var r = s % 60
    return m + ':' + (r < 10 ? '0' : '') + r
  }
  function isDark() {
    try {
      return !!(doc.body && doc.body.hasAttribute('data-ds-dark-theme'))
    } catch (e) {
      return true
    }
  }
  function fetchJson(url, opts) {
    if (typeof global.fetch !== 'function') return Promise.reject(new Error('fetch 不可用'))
    return global.fetch(url, opts).then(function (res) {
      return res.json()
    })
  }

  // ────────────────────────────── 状态 ──────────────────────────────

  var st = {
    started: false,
    playing: false,
    muted: false,
    volume: num(d.volume, 0.8, 0, 1),
    source: d.source === 'ranking' ? 'ranking' : 'popular',
    count: num(d.count, 12, 1, 30),
    carousel: false,
    focusOff: false,
    veil: num(d.veil, 0.3, 0, 0.92),
    veilLight: num(d.veillight, 0.3, 0, 0.92),
    surface: 0.5,
    fit: 'width',
    preserveBg: true,
    rate: 1,
    expanded: false,
    clear: false,
    progressDragging: false,
    pendingSeek: null,
    resume: true,
    launcher: null,
    queue: [],
    index: -1,
    current: null,
    busy: false,
    error: '',
    failStreak: 0,
  }

  // DOM
  var layer = null
  var video = null
  var veilEl = null
  var panel = null
  var launch = null
  var titleEl = null
  var metaEl = null
  var statusEl = null
  var listEl = null
  var inputEl = null
  var playBtn = null
  var prevBtn = null
  var nextBtn = null
  var muteBtn = null
  var volRange = null
  var carouselBtn = null
  var focusBtn = null
  var surfaceRange = null
  var surfaceVal = null
  var veilRange = null
  var veilVal = null
  var srcPopular = null
  var srcRanking = null
  var fitBtn = null
  var bgBtn = null
  var miniPlayBtn = null
  var clearBtn = null
  var rateVal = null
  var rateButtons = []
  var progressRange = null
  var progressTime = null
  var lastPlaybackPersist = 0

  // ────────────────────────────── 界面表面半透明 ──────────────────────────────

  /**
   * 开关界面表面的半透明（写内联 !important）。
   *
   * **必须写到 <body>，不能只写 <html>。** 内核主题（dsh-client-ui-theme）把整套
   * 别名色 `--dsw-alias-*` 定义在 `body` / `body[data-ds-dark-theme]` 上；自定义属性
   * 有"就近定义"语义——body 自己声明了值，就不会继承 html 上的。所以只往 html 写
   * 内联变量是**无效的**：视频会被 body 的不透明底色盖住。
   *
   * 早先我们只写 html，于是必须靠 dsh-video-skin 用 `html[data-dsvs] body{--dsw-...}`
   * 帮忙把 body 的值改透明才看得见——禁用 video-skin 就黑屏没画面，正是这个原因。
   * 现在 html 和 body 都写内联 !important（内联 !important 高于任何样式表 !important），
   * 因此 **完全不依赖 dsh-video-skin**；两者同时开启时以我们的值为准。
   *
   * @param {boolean} on 是否开启
   */
  function applySurface(on) {
    var html = doc.documentElement
    var body = doc.body
    var targets = []
    if (html && html.style) targets.push(html)
    if (body && body.style) targets.push(body)
    if (targets.length === 0) return
    var setVar = function (name, value) {
      for (var i = 0; i < targets.length; i += 1) {
        try {
          if (value === null) targets[i].style.removeProperty(name)
          else targets[i].style.setProperty(name, value, 'important')
        } catch (e) {
          /* ignore */
        }
      }
    }
    if (!on) {
      setVar('--dsw-alias-bg-base', null)
      setVar('--dsw-specific-sidebar-fill', null)
      try {
        if (body && body.style) body.style.removeProperty('background-color')
      } catch (e) {
        /* ignore */
      }
      try {
        if (html && html.style) html.style.removeProperty('background-color')
      } catch (e) {
        /* ignore */
      }
      if (html) html.removeAttribute('data-dsbili')
      return
    }
    var base = clamp01(st.surface)
    var side = clamp01(base + 0.06)
    var baseValue
    var sideValue
    if (isDark()) {
      baseValue = 'rgba(21,21,23,' + base + ')'
      sideValue = 'rgba(27,27,28,' + side + ')'
    } else {
      var light = clamp01(base + 0.4)
      baseValue = 'rgba(255,255,255,' + light + ')'
      sideValue = 'rgba(249,250,251,' + clamp01(light + 0.06) + ')'
    }
    setVar('--dsw-alias-bg-base', baseValue)
    setVar('--dsw-specific-sidebar-fill', sideValue)
    try {
      if (body && body.style) body.style.setProperty('background-color', 'transparent', 'important')
    } catch (e) {
      /* ignore */
    }
    if (html) html.setAttribute('data-dsbili', 'on')
  }

  /** 把"完整/铺满"写进视频元素的 data-fit。 */
  function applyFit() {
    if (video !== null) video.setAttribute('data-fit', st.fit === 'cover' ? 'cover' : 'width')
  }

  /**
   * 背景层留空区：保留其他插件/主题背景（透明）还是纯黑。
   * 保留时同时把 html 画布色设成主题底色，避免视频下方闪出浏览器默认白底。
   */
  function applyBgMode() {
    var preserve = st.preserveBg === true
    if (layer !== null) layer.setAttribute('data-bg', preserve ? 'preserve' : 'blank')
    var html = doc.documentElement
    if (html && html.style) {
      try {
        if (preserve) html.style.setProperty('background-color', isDark() ? '#0e1116' : '#eef1f5', 'important')
        else html.style.removeProperty('background-color')
      } catch (e) {
        /* ignore */
      }
    }
  }

  /** 把蒙版透明度写到 CSS 变量（亮/暗各一份）。 */
  function applyVeil() {
    var root = doc.documentElement
    if (!root || !root.style) return
    try {
      root.style.setProperty('--dsbili-veil', String(st.veil))
      root.style.setProperty('--dsbili-veil-light', String(st.veilLight))
    } catch (e) {
      /* ignore */
    }
  }

  // ────────────────────────────── 背景层 ──────────────────────────────

  function ensureLayer() {
    if (layer !== null) return layer
    if (!doc.body) return null
    layer = el('div')
    layer.id = 'dsbili-backdrop'
    layer.setAttribute('aria-hidden', 'true')

    video = doc.createElement('video')
    video.id = 'dsbili-video'
    video.playsInline = true
    video.autoplay = false
    video.preload = 'auto'
    video.loop = true
    video.muted = true
    video.setAttribute('playsinline', '')
    video.setAttribute('muted', '')
    video.setAttribute('aria-hidden', 'true')
    video.setAttribute('data-fit', st.fit === 'cover' ? 'cover' : 'width')

    veilEl = el('div')
    veilEl.id = 'dsbili-veil'

    layer.appendChild(video)
    layer.appendChild(veilEl)
    // append 到 body 末尾：同层负 z-index 中"后到者在上"，所以盖住装饰性循环背景。
    doc.body.appendChild(layer)

    video.addEventListener('loadeddata', function () {
      video.setAttribute('data-shown', '1')
    })
    video.addEventListener('error', function () {
      if (video.error) onVideoError('播放源出错（' + video.error.code + '）')
    })
    video.addEventListener('ended', onEnded)
    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('pause', function () {
      persist()
    })
    return layer
  }

  /** 元数据就绪：刷新进度条上限，并应用"续播"暂存的跳转位置。 */
  function onLoadedMetadata() {
    updateProgressUi()
    if (st.pendingSeek !== null && video !== null) {
      var seekTo = st.pendingSeek
      st.pendingSeek = null
      try {
        var dur = isFinite(video.duration) ? video.duration : seekTo
        video.currentTime = Math.max(0, Math.min(seekTo, dur))
      } catch (e) {
        /* ignore */
      }
    }
  }

  /** 播放中：更新进度条；每 5 秒落一次进度，保证重启能接着播。 */
  function onTimeUpdate() {
    if (st.progressDragging) return
    updateProgressUi()
    var now = Date.now()
    if (now - lastPlaybackPersist > 5000) {
      lastPlaybackPersist = now
      persist()
    }
  }

  /** 把当前进度/时长写到进度条与时间文字。 */
  function updateProgressUi() {
    if (video === null) return
    var dur = 0
    var cur = 0
    try {
      dur = isFinite(video.duration) ? video.duration : 0
      cur = isFinite(video.currentTime) ? video.currentTime : 0
    } catch (e) {
      /* ignore */
    }
    if (progressRange !== null) {
      if (dur > 0) {
        progressRange.max = String(dur)
        progressRange.value = String(Math.min(cur, dur))
      } else {
        progressRange.max = '100'
        progressRange.value = '0'
      }
    }
    if (progressTime !== null) {
      progressTime.textContent = formatTime(cur) + ' / ' + (dur > 0 ? formatTime(dur) : '--:--')
    }
  }

  function showLayer() {
    if (layer === null) ensureLayer()
    if (layer === null) return
    layer.setAttribute('data-idle', '0')
    applySurface(true)
    applyBgMode()
    applyVeil()
    st.started = true
  }

  function hideLayer() {
    if (video !== null) {
      try {
        video.pause()
      } catch (e) {
        /* ignore */
      }
    }
    if (layer !== null) layer.setAttribute('data-idle', '1')
    st.playing = false
    applySurface(false)
    syncButtons()
  }

  // ────────────────────────────── 播放逻辑 ──────────────────────────────

  function tryPlay(withAudio) {
    if (video === null) return
    var want = withAudio === true
    video.muted = !want
    var played
    try {
      played = video.play()
    } catch (e) {
      onVideoError('调用播放失败：' + (e && e.message ? e.message : e))
      return
    }
    var settle = function (ok) {
      if (ok) {
        st.playing = true
        st.muted = !want
        syncButtons()
        return
      }
      if (want) {
        // 自动播放被浏览器拦下：退回静音再试。
        st.muted = true
        video.muted = true
        var retry
        try {
          retry = video.play()
        } catch (e) {
          onVideoError('静音播放也被拒绝')
          return
        }
        if (retry && typeof retry.then === 'function') {
          retry.then(
            function () {
              st.playing = true
              st.muted = true
              syncButtons()
              setStatus('浏览器拦下了声音，已静音播放（点🔊开启）', '')
            },
            function () {
              onVideoError('播放被拒绝（可能是自动播放策略）')
            },
          )
        } else {
          st.playing = true
          st.muted = true
          syncButtons()
        }
      } else {
        onVideoError('播放被拒绝')
      }
    }
    if (played && typeof played.then === 'function') played.then(function () { settle(true) }, function () { settle(false) })
    else settle(true)
  }

  /** 解析并播放一个输入（BV / 链接 / aid）。 */
  function loadAndPlay(input) {
    if (st.busy) return
    var query = str(input).trim()
    if (query === '') {
      setStatus('请先输入 BV 号或 bilibili 链接', 'error')
      return
    }
    st.busy = true
    setStatus('解析中…', '')
    syncButtons()
    fetchJson(ROUTES.play + '?bvid=' + encodeURIComponent(query), { cache: 'no-store' })
      .then(
        function (data) {
          st.busy = false
          if (!data || data.ok !== true) {
            var message = (data && data.error) || '解析失败'
            setStatus(message, 'error')
            onVideoFailedInCarousel()
            syncButtons()
            return
          }
          st.current = data
          st.failStreak = 0
          showLayer()
          if (layer === null) ensureLayer()
          if (video !== null) {
            video.removeAttribute('data-shown')
            video.src = data.src
            video.loop = !st.carousel
            video.setAttribute('data-fit', st.fit === 'cover' ? 'cover' : 'width')
            try {
              video.playbackRate = st.rate
            } catch (e) {
              /* ignore */
            }
            tryPlay(!st.muted)
          }
          updateNow()
          syncButtons()
          setStatus('正在播放', 'ok')
          persist()
        },
        function (error) {
          st.busy = false
          setStatus('解析请求失败：' + (error && error.message ? error.message : error), 'error')
          onVideoFailedInCarousel()
          syncButtons()
        },
      )
  }

  function playQueueIndex(i) {
    if (!st.queue.length) {
      setStatus('队列为空，先加载热门/排行榜', 'error')
      return
    }
    var idx = ((i % st.queue.length) + st.queue.length) % st.queue.length
    st.index = idx
    refreshListActive()
    var item = st.queue[idx]
    if (!item || !item.bvid) {
      setStatus('这一项没有 BV 号，已跳过', 'error')
      onVideoFailedInCarousel()
      return
    }
    loadAndPlay(item.bvid)
  }

  function next() {
    if (!st.queue.length) {
      loadQueue().then(function () {
        if (st.queue.length) playQueueIndex(st.index < 0 ? 0 : st.index + 1)
      })
      return
    }
    playQueueIndex(st.index + 1)
  }

  function prev() {
    if (!st.queue.length) {
      loadQueue().then(function () {
        if (st.queue.length) playQueueIndex(st.index < 0 ? st.queue.length - 1 : st.index - 1)
      })
      return
    }
    playQueueIndex(st.index - 1)
  }

  function onEnded() {
    if (st.carousel) {
      setStatus('播完一支，切下一支…', '')
      next()
    } else {
      st.playing = false
      syncButtons()
      setStatus('播放结束', '')
    }
  }

  function onVideoError(message) {
    st.playing = false
    setStatus(message, 'error')
    onVideoFailedInCarousel()
    syncButtons()
  }

  /** 轮播时单个视频失败 → 连续失败有上限，避免死循环。 */
  function onVideoFailedInCarousel() {
    if (!st.carousel) return
    st.failStreak += 1
    if (st.failStreak > 3) {
      st.failStreak = 0
      setStatus('连续失败太多，已暂停轮播', 'error')
      return
    }
    global.setTimeout(function () {
      if (st.carousel) next()
    }, 1200)
  }

  function togglePlay() {
    if (st.current === null) {
      if (st.queue.length) playQueueIndex(st.index < 0 ? 0 : st.index)
      else {
        var typed = inputEl && inputEl.value ? inputEl.value : ''
        if (typed) loadAndPlay(typed)
        else {
          loadQueue().then(function () {
            if (st.queue.length) playQueueIndex(0)
            else setStatus('先输入 BV 或加载热门队列', 'error')
          })
        }
      }
      return
    }
    if (st.playing) {
      try {
        video.pause()
      } catch (e) {
        /* ignore */
      }
      st.playing = false
      syncButtons()
    } else {
      showLayer()
      tryPlay(!st.muted)
    }
  }

  function toggleMute() {
    st.muted = !st.muted
    if (video !== null) video.muted = st.muted
    syncButtons()
    persist()
  }

  // ────────────────────────────── 队列 ──────────────────────────────

  function loadQueue() {
    if (!ROUTES.queue) return Promise.resolve()
    setStatus('加载' + (st.source === 'ranking' ? '排行榜' : '热门') + '…', '')
    return fetchJson(ROUTES.queue + '?source=' + st.source + '&count=' + st.count, { cache: 'no-store' }).then(
      function (data) {
        if (!data || data.ok !== true) {
          setStatus((data && data.error) || '队列加载失败', 'error')
          return
        }
        st.queue = Array.isArray(data.list) ? data.list : []
        st.index = -1
        renderList()
        setStatus('已加载 ' + st.queue.length + ' 支视频', 'ok')
      },
      function (error) {
        setStatus('队列请求失败：' + (error && error.message ? error.message : error), 'error')
      },
    )
  }

  // ────────────────────────────── 入口位置 ──────────────────────────────

  /** 恢复/应用入口胶囊的位置（left/top 像素，相对视口）。 */
  function applyLauncherPos(pos) {
    if (launch === null || !isObj(pos)) return
    var left = num(pos.left, NaN, -100000, 100000)
    var top = num(pos.top, NaN, -100000, 100000)
    if (left !== left || top !== top) return
    st.launcher = { left: Math.round(left), top: Math.round(top) }
    try {
      launch.style.left = Math.round(left) + 'px'
      launch.style.top = Math.round(top) + 'px'
      launch.style.right = 'auto'
    } catch (e) {
      /* ignore */
    }
  }

  /** 拖动结束后记住当前位置。 */
  function rememberLauncherPos() {
    if (launch === null) return
    var rect = typeof launch.getBoundingClientRect === 'function' ? launch.getBoundingClientRect() : null
    var left = rect ? rect.left : parseFloat(launch.style.left)
    var top = rect ? rect.top : parseFloat(launch.style.top)
    if (left !== left || top !== top) return
    st.launcher = { left: Math.round(left), top: Math.round(top) }
    persist()
  }

  // ────────────────────────────── 状态持久化 ──────────────────────────────

  /** 组装要落盘的状态（含播放进度/是否在播，用于重启续播）。 */
  function stateBody() {
    var time = 0
    if (video !== null) {
      try {
        if (isFinite(video.currentTime)) time = video.currentTime
      } catch (e) {
        /* ignore */
      }
    }
    return {
      source: st.source,
      count: st.count,
      carousel: st.carousel,
      muted: st.muted,
      volume: st.volume,
      focusOff: st.focusOff,
      surface: st.surface,
      veil: st.veil,
      veilLight: st.veilLight,
      fit: st.fit,
      preserveBg: st.preserveBg,
      rate: st.rate,
      launcher: st.launcher || null,
      resume: st.resume,
      bvid: st.current && st.current.bvid ? st.current.bvid : '',
      title: st.current && st.current.title ? st.current.title : '',
      playing: st.playing === true,
      time: Math.round(time * 10) / 10,
    }
  }

  function postState(body, keepalive) {
    if (!ROUTES.state) return
    try {
      var init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      if (keepalive) init.keepalive = true
      global.fetch(ROUTES.state, init)
    } catch (e) {
      /* ignore */
    }
  }

  var persistTimer = null
  function persist() {
    if (!ROUTES.state) return
    if (persistTimer !== null) global.clearTimeout(persistTimer)
    persistTimer = global.setTimeout(function () {
      persistTimer = null
      postState(stateBody(), false)
    }, 500)
  }

  /** 关闭页面时立刻把进度发出去（keepalive 提高送达率）。 */
  function flushState() {
    if (!ROUTES.state) return
    postState(stateBody(), true)
  }

  function restoreState() {
    if (!ROUTES.state) return
    fetchJson(ROUTES.state, { cache: 'no-store' }).then(
      function (data) {
        var s = data && data.state
        if (!isObj(s)) return
        st.source = s.source === 'ranking' ? 'ranking' : st.source
        st.count = num(s.count, st.count, 1, 30)
        st.carousel = s.carousel === true
        st.muted = s.muted === true
        st.volume = num(s.volume, st.volume, 0, 1)
        st.veil = num(s.veil, st.veil, 0, 0.92)
        st.veilLight = num(s.veilLight, st.veilLight, 0, 0.92)
        st.surface = num(s.surface, st.surface, 0, 1)
        if (s.fit === 'cover' || s.fit === 'width') st.fit = s.fit
        if (typeof s.preserveBg === 'boolean') st.preserveBg = s.preserveBg
        st.rate = num(s.rate, st.rate, 0.25, 4)
        st.resume = s.resume !== false
        if (s.launcher) applyLauncherPos(s.launcher)
        if (s.bvid && inputEl) inputEl.value = s.bvid
        syncControls()
        applyVeil()
        // 启动续播：上次正在播且记了进度 → 自动接着播（无手势时浏览器会退回静音）
        if (st.resume && s.bvid && s.playing === true) {
          st.pendingSeek = num(s.time, 0, 0, 1e9)
          global.setTimeout(function () {
            loadAndPlay(s.bvid)
          }, 60)
        }
      },
      noop,
    )
  }

  // ────────────────────────────── UI ──────────────────────────────

  function setStatus(text, level) {
    st.error = level === 'error' ? text : ''
    if (statusEl !== null) {
      statusEl.textContent = text
      statusEl.setAttribute('data-level', level || '')
    }
  }

  function updateNow() {
    if (titleEl !== null) {
      titleEl.textContent = st.current ? st.current.title || '（无标题）' : '未播放'
    }
    if (metaEl !== null) {
      if (st.current) {
        var parts = []
        if (st.current.owner) parts.push(st.current.owner)
        if (st.current.duration) parts.push(formatTime(st.current.duration))
        if (st.current.quality) parts.push(st.current.quality + 'P')
        parts.push(st.current.bvid)
        metaEl.textContent = parts.join(' · ')
      } else {
        metaEl.textContent = '输入 BV 号开始'
      }
    }
  }

  function syncButtons() {
    if (playBtn !== null) {
      playBtn.textContent = st.playing ? '⏸ 暂停' : '▶ 播放'
      playBtn.setAttribute('aria-pressed', st.playing ? 'true' : 'false')
    }
    if (muteBtn !== null) {
      muteBtn.textContent = st.muted ? '🔇 已静音' : '🔊 有声'
      muteBtn.setAttribute('aria-pressed', st.muted ? 'false' : 'true')
    }
    if (fitBtn !== null) fitBtn.textContent = st.fit === 'cover' ? '显示: 铺满' : '显示: 完整'
    if (bgBtn !== null) bgBtn.textContent = st.preserveBg ? '背景: 保留' : '背景: 留空'
    if (miniPlayBtn !== null) miniPlayBtn.textContent = st.playing ? '⏸' : '▶'
    if (clearBtn !== null) clearBtn.setAttribute('data-on', st.clear ? '1' : '0')
    if (rateVal !== null) rateVal.textContent = String(st.rate) + 'x'
    for (var rbi = 0; rbi < rateButtons.length; rbi += 1) {
      var rb = rateButtons[rbi]
      rb.setAttribute('data-on', Number(rb.getAttribute('data-rate')) === st.rate ? '1' : '0')
    }
    if (carouselBtn !== null) carouselBtn.setAttribute('aria-pressed', st.carousel ? 'true' : 'false')
    if (focusBtn !== null) {
      focusBtn.textContent = st.focusOff ? '☀ 恢复显示' : '🌙 专注隐藏'
      focusBtn.setAttribute('data-on', st.focusOff ? '1' : '0')
    }
    if (prevBtn !== null) prevBtn.disabled = st.busy
    if (nextBtn !== null) nextBtn.disabled = st.busy
    if (srcPopular !== null) srcPopular.setAttribute('aria-pressed', st.source === 'popular' ? 'true' : 'false')
    if (srcRanking !== null) srcRanking.setAttribute('aria-pressed', st.source === 'ranking' ? 'true' : 'false')
    if (surfaceVal !== null) surfaceVal.textContent = Math.round(st.surface * 100) + '%'
    if (veilVal !== null) veilVal.textContent = Math.round(st.veil * 100) + '%'
    if (volRange !== null) volRange.value = String(Math.round(st.volume * 100))
    if (surfaceRange !== null) surfaceRange.value = String(Math.round(st.surface * 100))
    if (veilRange !== null) veilRange.value = String(Math.round(st.veil * 100))
  }

  function syncControls() {
    syncButtons()
    if (carouselBtn !== null) carouselBtn.setAttribute('aria-pressed', st.carousel ? 'true' : 'false')
    if (inputEl !== null && st.current && st.current.bvid) inputEl.value = st.current.bvid
  }

  function renderList() {
    if (listEl === null) return
    listEl.textContent = ''
    if (!st.queue.length) {
      var empty = el('div', 'dsbili-item', '（队列为空）')
      empty.style.cursor = 'default'
      empty.style.opacity = '0.5'
      listEl.appendChild(empty)
      return
    }
    for (var i = 0; i < st.queue.length; i += 1) {
      ;(function (idx) {
        var item = st.queue[idx]
        var row = el('div', 'dsbili-item')
        row.setAttribute('data-index', String(idx))
        if (idx === st.index) row.setAttribute('data-active', '1')
        var indexEl = el('span', 'dsbili-item-index', String(idx + 1))
        var titleNode = el('span', 'dsbili-item-title', item.title || item.bvid || '(无标题)')
        row.appendChild(indexEl)
        row.appendChild(titleNode)
        row.addEventListener('click', function () {
          playQueueIndex(idx)
        })
        listEl.appendChild(row)
      })(i)
    }
  }

  function refreshListActive() {
    if (listEl === null) return
    var rows = listEl.querySelectorAll('.dsbili-item')
    for (var i = 0; i < rows.length; i += 1) {
      if (i === st.index) rows[i].setAttribute('data-active', '1')
      else rows[i].removeAttribute('data-active')
    }
  }

  function openPanel() {
    if (panel === null) return
    panel.setAttribute('data-open', '1')
    launch.setAttribute('data-active', '1')
  }
  function closePanel() {
    if (panel === null) return
    panel.removeAttribute('data-open')
    launch.removeAttribute('data-active')
  }
  function togglePanel() {
    if (panel === null) return
    if (panel.getAttribute('data-open') === '1') closePanel()
    else openPanel()
  }

  /** 展开/收回悬浮胶囊里的快捷按钮。 */
  function setExpanded(expanded) {
    st.expanded = expanded === true
    if (launch !== null) {
      launch.setAttribute('data-expanded', st.expanded ? '1' : '0')
      launch.setAttribute('aria-expanded', st.expanded ? 'true' : 'false')
    }
    syncButtons()
  }

  /** 清屏：只藏中间内容区，左侧会话/任务列表保持可点。 */
  function applyClear() {
    var html = doc.documentElement
    if (!html) return
    if (st.clear) html.setAttribute('data-dsbili-clear', 'on')
    else html.removeAttribute('data-dsbili-clear')
  }

  function toggleClear() {
    st.clear = !st.clear
    applyClear()
    syncButtons()
  }

  /** 设置播放倍速。 */
  function setRate(rate) {
    var value = num(rate, 1, 0.25, 4)
    st.rate = value
    if (video !== null) {
      try {
        video.playbackRate = value
      } catch (e) {
        /* ignore */
      }
    }
    syncButtons()
    persist()
  }

  function buildUI() {
    if (!doc.body) return false

    // 入口胶囊：可拖动；点击展开/收回「播放/暂停」「下一支」「设置」快捷按钮。
    launch = el('div')
    launch.id = 'dsbili-launch'
    launch.setAttribute('role', 'button')
    launch.setAttribute('tabindex', '0')
    launch.setAttribute('aria-expanded', 'false')
    launch.setAttribute('title', 'B 站背景：点击展开/收回快捷按钮；可拖动；Ctrl+Shift+B 打开面板')

    launch.appendChild(el('span', 'dsbili-launch-label', '📺 B站'))

    var mini = el('div', 'dsbili-mini')
    miniPlayBtn = el('button', 'dsbili-mini-btn', '▶')
    miniPlayBtn.setAttribute('title', '播放 / 暂停')
    miniPlayBtn.addEventListener('click', function (ev) {
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation()
      togglePlay()
    })
    var miniNext = el('button', 'dsbili-mini-btn', '⏭')
    miniNext.setAttribute('title', '下一支')
    miniNext.addEventListener('click', function (ev) {
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation()
      next()
    })
    var miniGear = el('button', 'dsbili-mini-btn', '⚙')
    miniGear.setAttribute('title', '打开设置面板')
    miniGear.addEventListener('click', function (ev) {
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation()
      openPanel()
    })
    clearBtn = el('button', 'dsbili-mini-btn', '清')
    clearBtn.setAttribute('title', '清屏 / 恢复内容（只藏中间，左侧列表保留）')
    clearBtn.addEventListener('click', function (ev) {
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation()
      toggleClear()
    })
    mini.appendChild(miniPlayBtn)
    mini.appendChild(miniNext)
    mini.appendChild(clearBtn)
    mini.appendChild(miniGear)
    launch.appendChild(mini)

    function isMiniTarget(target) {
      return !!(target && typeof target.closest === 'function' && target.closest('.dsbili-mini'))
    }

    // 可拖动 + 点击展开/收回：拖动是必要的，入口位置依赖窗口/工具栏布局，固定坐标猜不准。
    var drag = null
    launch.addEventListener('pointerdown', function (ev) {
      if (isMiniTarget(ev && ev.target)) return
      if (ev && typeof ev.button === 'number' && ev.button !== 0) return
      var rect = typeof launch.getBoundingClientRect === 'function' ? launch.getBoundingClientRect() : { left: 0, top: 0 }
      drag = { sx: ev ? ev.clientX : 0, sy: ev ? ev.clientY : 0, ox: rect.left, oy: rect.top, moved: false }
      try {
        if (ev && typeof launch.setPointerCapture === 'function') launch.setPointerCapture(ev.pointerId)
      } catch (e) {
        /* ignore */
      }
    })
    launch.addEventListener('pointermove', function (ev) {
      if (drag === null || !ev) return
      var dx = ev.clientX - drag.sx
      var dy = ev.clientY - drag.sy
      if (!drag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) drag.moved = true
      if (!drag.moved) return
      launch.setAttribute('data-dragging', '1')
      var maxLeft = (global.innerWidth || 0) - (launch.offsetWidth || 64)
      var maxTop = (global.innerHeight || 0) - (launch.offsetHeight || 28)
      var left = Math.max(0, Math.min(maxLeft, drag.ox + dx))
      var top = Math.max(0, Math.min(maxTop, drag.oy + dy))
      launch.style.left = Math.round(left) + 'px'
      launch.style.top = Math.round(top) + 'px'
      launch.style.right = 'auto'
    })
    launch.addEventListener('pointerup', function (ev) {
      if (drag === null) return
      var moved = drag.moved
      drag = null
      launch.removeAttribute('data-dragging')
      try {
        if (ev && typeof launch.releasePointerCapture === 'function') launch.releasePointerCapture(ev.pointerId)
      } catch (e) {
        /* ignore */
      }
      if (moved) rememberLauncherPos()
      else setExpanded(!st.expanded)
    })
    launch.addEventListener('pointercancel', function () {
      drag = null
      launch.removeAttribute('data-dragging')
    })
    doc.body.appendChild(launch)

    // 面板
    panel = el('div')
    panel.id = 'dsbili-panel'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'B 站背景控制')

    var head = el('div', 'dsbili-head')
    var title = el('div', 'dsbili-title', 'B 站背景')
    var close = el('div', 'dsbili-close', '✕')
    close.addEventListener('click', closePanel)
    head.appendChild(title)
    head.appendChild(close)
    panel.appendChild(head)

    // 输入行
    var inputRow = el('div', 'dsbili-inputrow')
    inputEl = el('input', 'dsbili-input')
    inputEl.type = 'text'
    inputEl.placeholder = '输入 BV 号 / 粘贴链接'
    inputEl.addEventListener('keydown', function (ev) {
      if (ev && ev.key === 'Enter') loadAndPlay(inputEl.value)
    })
    var goBtn = el('button', 'dsbili-btn', '播放')
    goBtn.addEventListener('click', function () {
      loadAndPlay(inputEl.value)
    })
    inputRow.appendChild(inputEl)
    inputRow.appendChild(goBtn)
    panel.appendChild(inputRow)

    // 当前
    var now = el('div', 'dsbili-now')
    titleEl = el('div', 'dsbili-now-title', '未播放')
    metaEl = el('div', 'dsbili-now-meta', '输入 BV 号开始')
    now.appendChild(titleEl)
    now.appendChild(metaEl)
    panel.appendChild(now)

    // 进度条（可拖动）
    var progRow = el('div', 'dsbili-row')
    var progHead = el('div', 'dsbili-rowhead')
    progHead.appendChild(el('span', null, '进度'))
    progressTime = el('span', 'dsbili-valued', '0:00 / 0:00')
    progHead.appendChild(progressTime)
    progressRange = el('input', 'dsbili-range')
    progressRange.id = 'dsbili-progress'
    progressRange.type = 'range'
    progressRange.min = '0'
    progressRange.max = '100'
    progressRange.step = '0.1'
    progressRange.value = '0'
    progressRange.addEventListener('pointerdown', function () {
      st.progressDragging = true
    })
    progressRange.addEventListener('input', function () {
      if (video === null) return
      var target = Number(progressRange.value)
      if (!isFinite(target)) return
      try {
        video.currentTime = target
      } catch (e) {
        /* ignore */
      }
      if (progressTime !== null) {
        var dur = 0
        try {
          dur = isFinite(video.duration) ? video.duration : 0
        } catch (e) {
          /* ignore */
        }
        progressTime.textContent = formatTime(target) + ' / ' + (dur > 0 ? formatTime(dur) : '--:--')
      }
    })
    function endSeek() {
      if (!st.progressDragging) return
      st.progressDragging = false
      updateProgressUi()
      persist()
    }
    progressRange.addEventListener('pointerup', endSeek)
    progressRange.addEventListener('pointercancel', endSeek)
    progressRange.addEventListener('change', endSeek)
    progRow.appendChild(progHead)
    progRow.appendChild(progressRange)
    panel.appendChild(progRow)

    // 播放控制
    var row1 = el('div', 'dsbili-btnrow')
    playBtn = el('button', 'dsbili-btn', '▶ 播放')
    playBtn.addEventListener('click', togglePlay)
    prevBtn = el('button', 'dsbili-btn', '⏮ 上一支')
    prevBtn.addEventListener('click', prev)
    nextBtn = el('button', 'dsbili-btn', '⏭ 下一支')
    nextBtn.addEventListener('click', next)
    row1.appendChild(playBtn)
    row1.appendChild(prevBtn)
    row1.appendChild(nextBtn)
    panel.appendChild(row1)

    // 声音/专注
    var row2 = el('div', 'dsbili-btnrow')
    muteBtn = el('button', 'dsbili-btn', '🔊 有声')
    muteBtn.addEventListener('click', toggleMute)
    focusBtn = el('button', 'dsbili-btn', '🌙 专注隐藏')
    focusBtn.addEventListener('click', function () {
      st.focusOff = !st.focusOff
      if (st.focusOff) {
        hideLayer()
        setStatus('已隐藏视频（专注），点“恢复显示”回来', '')
      } else {
        showLayer()
        if (st.current !== null) tryPlay(!st.muted)
        setStatus('已恢复显示', 'ok')
      }
      syncButtons()
      persist()
    })
    row2.appendChild(muteBtn)
    row2.appendChild(focusBtn)
    panel.appendChild(row2)

    // 显示方式：完整（按宽度靠顶、不裁切）/ 铺满（填满、可裁切）
    var rowFit = el('div', 'dsbili-btnrow')
    fitBtn = el('button', 'dsbili-btn', '显示: 完整')
    fitBtn.addEventListener('click', function () {
      st.fit = st.fit === 'cover' ? 'width' : 'cover'
      applyFit()
      syncButtons()
      persist()
    })
    rowFit.appendChild(fitBtn)
    bgBtn = el('button', 'dsbili-btn', '背景: 保留')
    bgBtn.addEventListener('click', function () {
      st.preserveBg = !st.preserveBg
      applyBgMode()
      syncButtons()
      persist()
    })
    rowFit.appendChild(bgBtn)
    panel.appendChild(rowFit)

    // 倍速
    var rateRow = el('div', 'dsbili-row')
    var rateHead = el('div', 'dsbili-rowhead')
    rateHead.appendChild(el('span', null, '倍速'))
    rateVal = el('span', 'dsbili-valued', String(st.rate) + 'x')
    rateHead.appendChild(rateVal)
    var rateBtns = el('div', 'dsbili-btnrow')
    var rateOptions = [0.5, 0.75, 1, 1.25, 1.5, 2]
    rateButtons = []
    for (var ri = 0; ri < rateOptions.length; ri += 1) {
      ;(function (rate) {
        var rateBtn = el('button', 'dsbili-btn dsbili-rate-btn', String(rate) + 'x')
        rateBtn.setAttribute('data-rate', String(rate))
        rateBtn.addEventListener('click', function () {
          setRate(rate)
        })
        rateBtns.appendChild(rateBtn)
        rateButtons.push(rateBtn)
      })(rateOptions[ri])
    }
    rateRow.appendChild(rateHead)
    rateRow.appendChild(rateBtns)
    panel.appendChild(rateRow)

    // 轮播/来源
    var row3 = el('div', 'dsbili-btnrow')
    carouselBtn = el('button', 'dsbili-btn', '🔁 轮播')
    carouselBtn.addEventListener('click', function () {
      st.carousel = !st.carousel
      if (video !== null) video.loop = !st.carousel
      if (st.carousel && !st.queue.length) {
        loadQueue().then(function () {
          if (st.queue.length && st.current === null) playQueueIndex(0)
        })
      }
      syncButtons()
      persist()
    })
    var refreshBtn = el('button', 'dsbili-btn', '🔄 换队列')
    refreshBtn.addEventListener('click', function () {
      st.index = -1
      loadQueue()
      persist()
    })
    row3.appendChild(carouselBtn)
    row3.appendChild(refreshBtn)
    panel.appendChild(row3)

    var row4 = el('div', 'dsbili-btnrow')
    srcPopular = el('button', 'dsbili-btn', '热门')
    srcPopular.addEventListener('click', function () {
      st.source = 'popular'
      st.index = -1
      syncButtons()
      loadQueue()
      persist()
    })
    srcRanking = el('button', 'dsbili-btn', '排行榜')
    srcRanking.addEventListener('click', function () {
      st.source = 'ranking'
      st.index = -1
      syncButtons()
      loadQueue()
      persist()
    })
    row4.appendChild(srcPopular)
    row4.appendChild(srcRanking)
    panel.appendChild(row4)

    // 音量
    var volRow = el('div', 'dsbili-row')
    var volHead = el('div', 'dsbili-rowhead')
    volHead.appendChild(el('span', null, '音量'))
    volRange = el('input', 'dsbili-range')
    volRange.type = 'range'
    volRange.min = '0'
    volRange.max = '100'
    volRange.value = String(Math.round(st.volume * 100))
    volRange.addEventListener('input', function () {
      st.volume = clamp01(Number(volRange.value) / 100)
      if (video !== null) {
        try {
          video.volume = st.volume
        } catch (e) {
          /* ignore */
        }
      }
    })
    volRow.appendChild(volHead)
    volRow.appendChild(volRange)
    panel.appendChild(volRow)

    // 界面不透明度
    var surfRow = el('div', 'dsbili-row')
    var surfHead = el('div', 'dsbili-rowhead')
    surfHead.appendChild(el('span', null, '界面不透明度'))
    surfaceVal = el('span', 'dsbili-valued', Math.round(st.surface * 100) + '%')
    surfHead.appendChild(surfaceVal)
    surfaceRange = el('input', 'dsbili-range')
    surfaceRange.type = 'range'
    surfaceRange.min = '0'
    surfaceRange.max = '100'
    surfaceRange.value = String(Math.round(st.surface * 100))
    surfaceRange.addEventListener('input', function () {
      st.surface = clamp01(Number(surfaceRange.value) / 100)
      if (surfaceVal !== null) surfaceVal.textContent = Math.round(st.surface * 100) + '%'
      if (st.started) applySurface(true)
    })
    surfRow.appendChild(surfHead)
    surfRow.appendChild(surfaceRange)
    panel.appendChild(surfRow)

    // 蒙版
    var veilRow = el('div', 'dsbili-row')
    var veilHead = el('div', 'dsbili-rowhead')
    veilHead.appendChild(el('span', null, '蒙版浓度'))
    veilVal = el('span', 'dsbili-valued', Math.round(st.veil * 100) + '%')
    veilHead.appendChild(veilVal)
    veilRange = el('input', 'dsbili-range')
    veilRange.type = 'range'
    veilRange.min = '0'
    veilRange.max = '92'
    veilRange.value = String(Math.round(st.veil * 100))
    veilRange.addEventListener('input', function () {
      st.veil = clamp01(Number(veilRange.value) / 100)
      st.veilLight = clamp01(st.veil * 0.9)
      if (veilVal !== null) veilVal.textContent = Math.round(st.veil * 100) + '%'
      applyVeil()
    })
    veilRow.appendChild(veilHead)
    veilRow.appendChild(veilRange)
    panel.appendChild(veilRow)

    // 列表
    listEl = el('div', 'dsbili-list')
    renderList()
    panel.appendChild(listEl)

    // 状态
    statusEl = el('div', 'dsbili-status')
    statusEl.setAttribute('data-level', '')
    panel.appendChild(statusEl)

    var foot = el('div', 'dsbili-foot')
    foot.appendChild(el('span', null, '无登录画质 360p~720p'))
    var reset = el('span', null, '清空状态')
    reset.style.cursor = 'pointer'
    reset.addEventListener('click', function () {
      if (!ROUTES.state) return
      try {
        global.fetch(ROUTES.state, { method: 'DELETE' })
      } catch (e) {
        /* ignore */
      }
    })
    foot.appendChild(reset)
    panel.appendChild(foot)

    doc.body.appendChild(panel)

    syncButtons()
    updateNow()
    applyVeil()
    return true
  }

  // ────────────────────────────── 启动 ──────────────────────────────

  function start() {
    if (st.started === false && !doc.body) {
      global.setTimeout(start, 100)
      return
    }
    if (panel !== null) return
    if (!buildUI()) {
      global.setTimeout(start, 100)
      return
    }
    // 键盘入口：Ctrl+Shift+B 开/关面板（兜底，哪怕按钮被别的东西挡住也能打开）。
    try {
      global.addEventListener('keydown', function (event) {
        if (!event || event.defaultPrevented) return
        if (!event.ctrlKey || !event.shiftKey) return
        var key = String(event.key || '').toLowerCase()
        if (key !== 'b') return
        event.preventDefault()
        togglePanel()
      })
    } catch (e) {
      /* 没有键盘事件也无所谓 */
    }
    restoreState()
    // 主题切换时重新套用透明度
    try {
      var observer = new global.MutationObserver(function () {
        if (st.started && !st.focusOff) {
          applySurface(true)
          applyBgMode()
        }
      })
      observer.observe(doc.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    } catch (e) {
      /* ignore */
    }
    // 清屏期间点击左侧列表 → 先恢复内容再让点击生效，直接切到对应会话。
    try {
      doc.addEventListener(
        'click',
        function (event) {
          if (!st.clear) return
          var target = event && event.target
          if (target && typeof target.closest === 'function' && target.closest('[class*="sidebarCol"]')) {
            st.clear = false
            applyClear()
            syncButtons()
          }
        },
        true,
      )
    } catch (e) {
      /* ignore */
    }
    // 关闭页面时立刻落一次进度，尽量让下次启动能接着播。
    try {
      global.addEventListener('beforeunload', function () {
        flushState()
      })
      global.addEventListener('pagehide', function () {
        flushState()
      })
    } catch (e) {
      /* ignore */
    }
    global.__DSH_BILI_BG_API__ = {
      state: st,
      play: loadAndPlay,
      loadQueue: loadQueue,
      next: next,
      prev: prev,
      clear: toggleClear,
      open: openPanel,
      close: closePanel,
      teardown: function () {
        hideLayer()
        if (layer && layer.parentNode) layer.parentNode.removeChild(layer)
        if (panel && panel.parentNode) panel.parentNode.removeChild(panel)
        if (launch && launch.parentNode) launch.parentNode.removeChild(launch)
        applySurface(false)
        layer = null
        panel = null
        launch = null
      },
    }
  }

  start()
})(typeof window !== 'undefined' ? window : globalThis)
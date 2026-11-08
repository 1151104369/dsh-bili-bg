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
  ROUTES.auth =
    isObj(cfg.auth) && (str(cfg.auth.create) || str(cfg.auth.status))
      ? {
          create: str(cfg.auth.create),
          image: str(cfg.auth.image),
          poll: str(cfg.auth.poll),
          status: str(cfg.auth.status),
          logout: str(cfg.auth.logout),
        }
      : null
  ROUTES.download = isObj(cfg.download)
    ? {
        create: str(cfg.download.create),
        status: str(cfg.download.status),
        list: str(cfg.download.list),
      }
    : null
  ROUTES.ffmpeg = isObj(cfg.ffmpeg)
    ? {
        status: str(cfg.ffmpeg.status),
        install: str(cfg.ffmpeg.install),
      }
    : null
  ROUTES.dm = str(cfg.dm)
  ROUTES.open = str(cfg.open)

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
    // 单曲循环：两种模式都支持；轮播开启时轮播优先（放完切下一支）。
    loop: true,
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
    seekTarget: null,
    pendingSeek: null,
    resume: true,
    duration: 0,
    srcRel: '',
    srcAbs: '',
    srcFallback: false,
    launcher: null,
    panelPos: null,
    // 面板标签页：play | queue | account | download | settings
    tab: 'play',
    queue: [],
    index: -1,
    current: null,
    busy: false,
    queueBusy: false,
    error: '',
    failStreak: 0,
    loggedIn: false,
    account: null,
    authBusy: false,
    authReady: false,
    qr: null,
    // 用户是否手动点过来源按钮。未手动选过时：已登录默认「首页推荐」，未登录回落「热门」。
    sourcePicked: false,
    // 登录后高清（1080p+）走 DASH+MSE。hd=用户想不想用；hdEffective=当前是否真在走 MSE。
    hd: false,
    hdEffective: false,
    hdFallback: '',
    // MSE 诊断：最近一次状态/回退原因（落盘到 state，排障用）。
    hdDiag: null,
    hdQuality: 80, // 请求 qn.cn（1080P ~ 116）
    dashVideoIndex: 0,
    dashAudioIndex: 0,
    // 当前视频去重后的清晰度列表（每个高度一条，已优选编码）。
    hdQualities: [],
    // 当前分P（1-based）与该视频的分P列表（无分P时 pages=[]）。
    pid: 1,
    pages: [],
    // 纯氛围静音墙纸模式：静音铺满、无感后台播放（音量相关按钮不顶格）。
    wallpaper: false,
    // 弹幕开关：在视频画面下方渲染一个滚动浮层（不影响播放，任何失败自动隐藏）。
    dm: false,
    // 弹幕外观（都持久化）：字号百分比/不透明度/速度倍率/显示区域（占画面高度比例）。
    dmSize: 100,
    dmOpacity: 80,
    dmSpeed: 100,
    dmArea: 100,
    // 静音墙纸开启前的原始状态（关闭时还原，避免单向）。
    wallpaperSaved: null,
  }

  // DOM
  var layer = null
  var video = null
  var veilEl = null
  // 弹幕：canvas 浮层（在 video 之上、蒙版之下），随 currentTime 滚动。
  var dmCanvas = null
  var dmCtx = null
  var dmList = null
  var dmIndex = 0
  var dmActive = []
  var dmRaf = null
  var dmLaneSeed = 0
  var dmLastTime = 0
  var dmLastFrame = 0
  var panel = null
  var launch = null
  var titleEl = null
  var metaEl = null
  var nowLabelEl = null
  var statusEl = null
  var listEl = null
  var inputEl = null
  var playBtn = null
  var prevBtn = null
  var nextBtn = null
  var muteBtn = null
  var volRange = null
  var carouselBtn = null
  var loopBtn = null
  // 循环回开头后，等 seek 落地再 play（MSE 里 play 太早会被拒）。
  var seekPlayPending = false
  // 结束处理幂等标志 + 结尾看门狗（MSE 不一定派发 ended）。
  var endHandled = false
  var endWatchTimer = null
  var focusBtn = null
  var wallpaperBtn = null
  var dmBtn = null
  var dmSizeRange = null
  var dmSizeVal = null
  var dmOpacityRange = null
  var dmOpacityVal = null
  var dmAreaRange = null
  var dmAreaVal = null
  var dmSpeedBtns = []
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
  var settingsClearBtn = null
  var miniFocusBtn = null
  var rateVal = null
  var rateButtons = []
  var progressRange = null
  var progressTime = null
  var pageWrap = null
  var lastPlaybackPersist = 0
  var accountEl = null
  var qrOverlay = null
  var panelSetTab = null
  var srcFeed = null
  var qrPollTimer = null
  var qrPollTries = 0
  var dlBtn = null
  var dlStatusEl = null
  var dlDirEl = null
  var dlDir = ''
  var dlTaskId = null
  var dlTimer = null
  // ffmpeg（高清下载自动合轨）：状态行 + 一键下载按钮
  var ffmpegBtn = null
  var ffmpegStatusEl = null
  var ffmpegPollTimer = null
  var ffmpegInfo = null
  // 上一次轮询的 {时间, 已下载字节}，用来估算下载速度。
  var dlPrev = { at: 0, received: 0 }
  // 登录后高清：MSE 播放器句柄 + 面板里的画质控件（隐藏时可能为 null）。
  var dashPlayer = null
  var hdBtn = null
  var hdStateEl = null
  var qualityWrap = null
  var qualityButtons = []
  // 高清播放时后台预热 720p 单文件（隐藏 <video>）：长视频 moov 可达 9MB，
  // 不预热的话「切回 720p」要等 moov 下完（数秒）。预热后切回可命中缓存，几乎是瞬间。
  var warmEl = null
  var warmTimer = null
  // 单文件加载时，先显示「缓冲中…」，等真正 loadeddata 再显示「正在播放」。
  var playingPending = false

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
    // 显示方式改变会改变视频显示区，弹幕画布要跟着重新贴合。
    if (st.dm) global.setTimeout(dmResize, 60)
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
    dmCanvas = el('canvas')
    dmCanvas.id = 'dsbili-danmaku'
    dmCanvas.setAttribute('aria-hidden', 'true')
    try {
      dmCtx = (dmCanvas.getContext && dmCanvas.getContext('2d')) || null
    } catch (e) {
      dmCtx = null
    }

    layer.appendChild(video)
    layer.appendChild(dmCanvas)
    layer.appendChild(veilEl)
    // append 到 body 末尾：同层负 z-index 中"后到者在上"，所以盖住装饰性循环背景。
    doc.body.appendChild(layer)

    video.addEventListener('loadeddata', function () {
      video.setAttribute('data-shown', '1')
      switchingSrc = false
      // 视频真正出画面后才知道实际显示高度，重贴弹幕画布（字号按画面比例）。
      if (st.dm) dmResize()
      applyPendingSeek()
      if (playingPending) {
        playingPending = false
        setStatus('正在播放', 'ok')
      }
      // 单文件已经真正出画面：预热元素可以回收了（释放解码器/内存）。
      if (warmEl !== null) {
        global.setTimeout(stopWarmSingleFile, 1200)
      }
    })
    video.addEventListener('canplay', applyPendingSeek)
    video.addEventListener('error', function () {
      if (!video.error) return
      // 切换高清/清晰度/回退过程中位 src 的过渡态：忽略，别误判成“播放源出错”。
      if (switchingSrc) return
      // MSE 播放中出错：直接降级 720p 单文件，绝不白屏。
      if (st.hdEffective || dashPlayer !== null || video.getAttribute('data-mse') === '1') {
        degradeTo720p('MSE 播放出错（code ' + video.error.code + '）')
        return
      }
      // 直连本机 HTTP 失败（跨源/端口不可达）时，回退到同源代理地址再试一次。
      if (!st.srcFallback && st.srcAbs !== '' && typeof video.src === 'string' && video.src.indexOf(st.srcAbs) !== -1) {
        st.srcFallback = true
        setStatus('直连播放失败，改用代理重试', '')
        try {
          video.src = st.srcRel
          var played = video.play()
          if (played && typeof played.catch === 'function') played.catch(noop)
        } catch (e) {
          /* ignore */
        }
        return
      }
      onVideoError('播放源出错（' + video.error.code + '）')
    })
    video.addEventListener('ended', onEnded)
    video.addEventListener('seeked', function () {
      updateProgressUi()
    })
    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('pause', function () {
      persist()
    })
    return layer
  }

  /** 把"续播"暂存的位置落到 video 上（元数据/数据就绪时各试一次）。 */
  function applyPendingSeek() {
    if (st.pendingSeek === null || video === null) return
    var target = st.pendingSeek
    // MSE 模式：交给播放器按两轨对称 seek（未就绪时它自己排队）。
    if (st.hdEffective && dashPlayer !== null) {
      st.pendingSeek = null
      dashPlayer.seek(target)
      return
    }
    try {
      var dur = isFinite(video.duration) && video.duration > 0 ? video.duration : st.duration
      if (dur <= 0) return
      video.currentTime = Math.max(0, Math.min(target, dur))
      st.pendingSeek = null
    } catch (e) {
      /* 还没就绪，留给下一个事件再试 */
    }
  }

  /** 元数据就绪：刷新进度条上限，并应用"续播"暂存的跳转位置。 */
  function onLoadedMetadata() {
    updateProgressUi()
    applyPendingSeek()
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
      dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 0
      cur = isFinite(video.currentTime) ? video.currentTime : 0
    } catch (e) {
      /* ignore */
    }
    // 浏览器还没解析出时长时，用播放接口返回的 duration 兜底，保证进度条刻度正确。
    if (dur <= 0 && st.duration > 0) dur = st.duration
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
    var settle = function (ok, err) {
      if (ok) {
        st.playing = true
        st.muted = !want
        syncButtons()
        return
      }
      var name = err && err.name ? String(err.name) : ''
      // 只有「浏览器自动播放策略」拦截（NotAllowedError）才该退回静音。
      // 其余（NotSupportedError / AbortError 等）多半是「源还没就绪 / 刚被替换」，
      // 绝不能因此把用户静音——那正是之前「切高清后莫名静音」的原因。
      if (name !== '' && name !== 'NotAllowedError') {
        st.playing = false
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
    if (played && typeof played.then === 'function') played.then(function () { settle(true) }, function (err) { settle(false, err) })
    else settle(true)
  }

  // ────────────────────────────── 登录后高清（MSE）──────────────────────────────

  /** 相对媒体路径拼成"直连本机 HTTP"的绝对地址；拿不到 mediaBase 就用同源代理相对路径。 */
  function trackAbs(rel, absBase) {
    if (!rel) return ''
    if (absBase && rel.charAt(0) === '/') return absBase + rel
    return rel
  }

  // 切换高清/清晰度时，video.src 会被改动；这期间的 error 事件是过渡态噪声，忽略掉。
  var switchingSrc = false

  /** 取当前视频的单文件播放地址（优先直连 mediaBase）。 */
  function singleFileUrl() {
    if (st.srcAbs) return st.srcAbs
    return st.srcRel || ''
  }

  /**
   * 高清播放时后台预热 720p 单文件：用隐藏 <video> preload=auto 拉一次（主要是 moov）。
   * 配合 /media 的短时缓存，用户「关高清」切回 720p 时可直接命中缓存，不用再等几秒。
   */
  function warmSingleFile() {
    var url = singleFileUrl()
    if (!url) return
    if (warmEl === null) {
      if (typeof doc.createElement !== 'function') return
      warmEl = doc.createElement('video')
      warmEl.muted = true
      warmEl.preload = 'auto'
      warmEl.setAttribute('playsinline', '')
      warmEl.setAttribute('aria-hidden', 'true')
      try {
        warmEl.style.cssText =
          'position:absolute;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none'
      } catch (e) {
        /* ignore */
      }
      try {
        if (layer !== null) layer.appendChild(warmEl)
      } catch (e) {
        /* ignore */
      }
    }
    try {
      if (warmEl.getAttribute('data-src') !== url) {
        warmEl.setAttribute('data-src', url)
        warmEl.src = url
        warmEl.load && warmEl.load()
      }
    } catch (e) {
      /* ignore */
    }
  }

  /** 停掉/回收预热元素（新视频、切回完成、关掉高清后）。 */
  function stopWarmSingleFile() {
    if (warmTimer !== null) {
      try {
        global.clearTimeout(warmTimer)
      } catch (e) {
        /* ignore */
      }
      warmTimer = null
    }
    if (warmEl === null) return
    try {
      warmEl.removeAttribute('data-src')
      warmEl.removeAttribute('src')
      warmEl.load && warmEl.load()
    } catch (e) {
      /* ignore */
    }
    try {
      if (warmEl.parentNode) warmEl.parentNode.removeChild(warmEl)
    } catch (e) {
      /* ignore */
    }
    warmEl = null
  }

  /** 高清稳定播放 2.5s 后再预热（避免和 HD 首屏抢带宽）。 */
  function scheduleWarmSingleFile() {
    if (warmTimer !== null) return
    warmTimer = global.setTimeout(function () {
      warmTimer = null
      if (st.hdEffective && st.hd === true) warmSingleFile()
    }, 2500)
  }

  /** 销毁当前 MSE 播放器（切回单文件 / 换轨 / 清屏时用）。 */
  function destroyDash() {
    if (dashPlayer !== null) {
      try {
        dashPlayer.destroy()
      } catch (e) {
        /* ignore */
      }
      dashPlayer = null
    }
    st.hdEffective = false
    if (video !== null) {
      try {
        video.removeAttribute('data-mse')
      } catch (e) {
        /* ignore */
      }
    }
  }

  /** 编码族排序：H.264 兼容性最好，优先；其次 HEVC；最后 AV1。 */
  function codecRank(codecs) {
    var c = String(codecs || '').toLowerCase()
    if (c.indexOf('avc1') === 0 || c.indexOf('avc3') === 0) return 0
    if (c.indexOf('hvc1') === 0 || c.indexOf('hev1') === 0) return 1
    if (c.indexOf('av01') === 0) return 2
    return 3
  }

  /** 浏览器 MSE 是否支持该 mime+codecs（拿不到 MediaSource.isTypeSupported 时乐观放行）。 */
  function mseSupports(mimeType, codecs) {
    try {
      var m = mimeType || 'video/mp4'
      if (codecs) m += '; codecs="' + codecs + '"'
      var MS = global.MediaSource
      if (MS && typeof MS.isTypeSupported === 'function') return MS.isTypeSupported(m)
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * B 站同一清晰度会返回多条编码（例如 1080P 同时有 avc1 / hvc1 / av01），
   * 直接渲染就是「每个清晰度重复 3 个按钮」。这里按高度去重：每档挑一条
   * **浏览器 MSE 支持、且 H.264 优先**的轨，返回去重后的清晰度列表（按高度降序）。
   */
  function buildQualityList(tracks) {
    if (!tracks || !tracks.length) return []
    var byHeight = {}
    var heights = []
    for (var i = 0; i < tracks.length; i += 1) {
      var t = tracks[i]
      if (!t) continue
      var h = Number(t.height) || 0
      if (!byHeight[h]) {
        byHeight[h] = []
        heights.push(h)
      }
      byHeight[h].push(t)
    }
    var out = []
    for (var k = 0; k < heights.length; k += 1) {
      var cands = byHeight[heights[k]].slice().sort(function (a, b) {
        var ra = codecRank(a.codecs)
        var rb = codecRank(b.codecs)
        if (ra !== rb) return ra - rb
        return (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0)
      })
      var chosen = null
      for (var j = 0; j < cands.length; j += 1) {
        if (mseSupports(cands[j].mimeType, cands[j].codecs)) {
          chosen = cands[j]
          break
        }
      }
      if (!chosen) chosen = cands[0]
      out.push(chosen)
    }
    out.sort(function (a, b) {
      return (Number(b.height) || 0) - (Number(a.height) || 0)
    })
    return out
  }

  /** data.videoTracks 里按 raw index 取轨；若该轨不被支持则回落首个可用清晰度。 */
  function resolveVideoTrack(data) {
    var list = data && Array.isArray(data.videoTracks) ? data.videoTracks : []
    if (!list.length) return null
    var wanted = list[st.dashVideoIndex]
    if (wanted && mseSupports(wanted.mimeType, wanted.codecs)) return wanted
    var qualities = Array.isArray(st.hdQualities) && st.hdQualities.length ? st.hdQualities : buildQualityList(list)
    return qualities[0] || wanted || list[0]
  }

  /** 高清是否希望自动播放（MSE 就绪后再播，避免在源未就绪时 play 被拒 → 误静音）。 */
  var dashWantPlay = false

  /**
   * 从 play 结果的 dash 信息启动 MSE 播放器。
   * @param {object} data play 结果
   * @param {boolean} [autoPlay] 就绪后是否自动播（缺省沿用当前 desired）
   */
  function startDash(data, autoPlay) {
    if (video === null) return
    dashWantPlay = autoPlay !== false
    var lib = global && global.__DSH_BILI_DASH__
    if (!lib || typeof lib.create !== 'function') {
      degradeTo720p('MSE 播放器不可用')
      return
    }
    if (!data || data.hd !== true) {
      degradeTo720p('没有高清分轨')
      return
    }
    var vt = resolveVideoTrack(data)
    var at = data.audioTracks && data.audioTracks[st.dashAudioIndex] ? data.audioTracks[st.dashAudioIndex] : null
    if (!at && data.audioTracks && data.audioTracks.length) at = data.audioTracks[0]
    if (!vt || !vt.media) {
      degradeTo720p('高清分轨缺失')
      return
    }
    // 记住实际使用的 raw index（清晰度按钮据此高亮）。
    if (isFinite(Number(vt.index))) st.dashVideoIndex = Number(vt.index)
    var absBase = typeof data.mediaBase === 'string' && data.mediaBase !== '' ? data.mediaBase : ''
    var vAbs = trackAbs(vt.media, absBase)
    var vRel = vt.media
    var aAbs = at ? trackAbs(at.media, absBase) : ''
    var aRel = at ? at.media : ''
    var tracks = {
      video: { media: vAbs, mediaProxy: vRel, mimeType: vt.mimeType || 'video/mp4', codecs: vt.codecs || '' },
    }
    if (aAbs) {
      tracks.audio = { media: aAbs, mediaProxy: aRel, mimeType: at.mimeType || 'audio/mp4', codecs: at.codecs || '' }
    }
    destroyDash()
    st.hdFallback = ''
    st.hdEffective = false
    switchingSrc = true
    // 初始化阶段诊断：万一卡住/超时，把阶段链落到 state.hdDiag 里方便定位。
    var dashPhaseStart = Date.now()
    var dashPhases = []
    var recordPhase = function (phase) {
      dashPhases.push((dashPhases.length ? '>' : '') + phase + '@' + (Date.now() - dashPhaseStart))
      if (dashPhases.length > 12) dashPhases.shift()
      st.hdDiag = { status: phase, reason: '', phase: dashPhases.join(''), at: Date.now() }
    }
    recordPhase('create')
    st.hdDiag = {
      status: 'create',
      reason: '',
      phase: 'create@0',
      env: { origin: global.location ? String(global.location.origin || '') : '', base: absBase },
      at: Date.now(),
    }
    // MSE 的 blob 源不参与原生 loop：关掉 loop，让 ended 事件由 onEnded 统一处理
    //（非轮播时手动 seek(0) 续播，轮播时切下一支）。
    try {
      video.loop = false
    } catch (e) {
      /* ignore */
    }
    setStatus('高清缓冲中…', '')
    // 记住本次要用的轨，供 onStatus 里写「1080P」文案。
    var usedHeight = Number(vt.height) || 0
    dashPlayer = lib.create({
      video: video,
      duration: st.duration,
      tracks: tracks,
      // 只预缓冲前方 90s、播放点后保留 30s：B 站单条 m4s 可达数 GB，不设上限会撑爆 MSE 配额。
      horizon: 90,
      evictBehind: 30,
      fetchFn: function (url, init) {
        var rel = url === vAbs ? vRel : url === aAbs ? aRel : null
        // 直连 mediaBase 优先；给它一个较短的超时，卡住（CORS/端口不可达但请求挂着）
        // 就 abort 并立刻改走同源相对地址，而不是干等 20s 看门狗。
        function attempt(u) {
          if (typeof global.AbortController !== 'function') return global.fetch(u, init)
          var ctrl
          try {
            ctrl = new global.AbortController()
          } catch (e) {
            return global.fetch(u, init)
          }
          var timer = global.setTimeout(function () {
            try {
              ctrl.abort()
            } catch (e) {
              /* ignore */
            }
          }, 6000)
          var opts = { cache: 'no-store', headers: init && init.headers ? init.headers : undefined, signal: ctrl.signal }
          return global.fetch(u, opts).then(
            function (res) {
              global.clearTimeout(timer)
              return res
            },
            function (err) {
              global.clearTimeout(timer)
              throw err
            },
          )
        }
        return attempt(url).catch(function (err) {
          if (rel) {
            st.hdDiag = { status: 'fetch-fallback-rel', reason: err && err.name ? String(err.name) : '', at: Date.now() }
            return attempt(rel)
          }
          throw err || new Error('dash fetch failed')
        })
      },
      onFallback: function (reason) {
        seekPlayPending = false
        st.hdFallback = reason || 'MSE 回退'
        st.hdDiag = {
          reason: st.hdFallback,
          status: 'fallback',
          phase: dashPhases.join(''),
          env: { origin: global.location ? String(global.location.origin || '') : '', base: absBase },
          at: Date.now(),
        }
        // 立刻落盘，重启/排障时能直接看到卡在哪一阶段。
        persist()
        degradeTo720p(st.hdFallback)
      },
      // 循环播放：seek 回 0 真正落地后再开播（MSE 里 seek 未完成时 play 会被拒）。
      onSeeked: function () {
        if (!seekPlayPending) return
        seekPlayPending = false
        if (st.loop === true) tryPlay(!st.muted)
      },
      onStatus: function (s) {
        if (destroyedFlag()) return
        recordPhase(s)
        if (s === 'ready') {
          st.hdEffective = true
          switchingSrc = false
          try {
            video.setAttribute('data-mse', '1')
            video.playbackRate = st.rate
          } catch (e) {
            /* ignore */
          }
          if (st.pendingSeek !== null && dashPlayer !== null) {
            var target = st.pendingSeek
            st.pendingSeek = null
            dashPlayer.seek(target)
          }
          // 「ready」只表示 init 段已就绪，媒体分片还没到——此时露画面只会是黑屏，
          // 状态写着「高清播放中」却没画面。改成等第一帧真正可显示（readyState>=2 /
          // loadeddata）再显示画面、报「高清播放中」并开播。
          var thisPlayer = dashPlayer
          waitDashFirstFrame(
            function () {
              return dashPlayer === thisPlayer
            },
            usedHeight,
          )
          syncButtons()
          syncQuality()
          persist()
          return
        }
        if (s === 'starting' || s === 'buffering') {
          if (!st.hdFallback) setStatus('高清缓冲中…', '')
        }
      },
    })
    if (dashPlayer && dashPlayer.load) {
      try {
        dashPlayer.load()
      } catch (e) {
        degradeTo720p('MSE 启动失败：' + (e && e.message ? e.message : String(e)))
        return
      }
    }
    // 专注模式：与单文件路径保持一致——只把首帧缓冲好，但整层保持 hidden（data-idle=1），
    // 不把画面亮出来。data-shown 仍由 reveal 设置，用户点「恢复显示」时能立即出画面。
    // 之前这里无条件 showLayer()，会让「高清 + 专注」把画面重新露出来，且重启后专注状态丢失
    //（非高清路径尊重 focusOff，故高清/非高清表现不一致）。
    if (st.focusOff) {
      if (layer !== null) layer.setAttribute('data-idle', '1')
    } else {
      showLayer()
    }
    // 注意：不在这是调用 tryPlay —— 等 MSE ready（见上面的 onStatus('ready')）。
    updateNow()
    syncButtons()
    persist()
  }

  /** onStatus 里判断是否已切走（dashPlayer 已被换成别的实例/销毁）。 */
  function destroyedFlag() {
    return dashPlayer === null
  }

  /**
   * 等 MSE 真正有可显示的第一帧，再显示画面 / 报「高清播放中」/ 开播。
   * 早先 init 一就绪就显示，用户会先看到「高清播放中（1080P）」但画面黑几秒。
   * @param {() => boolean} stillCurrent 判断这次播放器是否仍是当前实例
   * @param {number} height 目标高度
   */
  function waitDashFirstFrame(stillCurrent, height) {
    var revealed = false
    var poll = null
    var tries = 0
    function cleanup() {
      if (poll !== null) {
        try {
          global.clearTimeout(poll)
        } catch (e) {
          /* ignore */
        }
        poll = null
      }
      try {
        if (video) {
          video.removeEventListener('loadeddata', reveal)
          video.removeEventListener('canplay', reveal)
        }
      } catch (e) {
        /* ignore */
      }
    }
    function reveal() {
      if (revealed) return
      if (stillCurrent && !stillCurrent()) {
        cleanup()
        return
      }
      revealed = true
      cleanup()
      // 首帧已可显示：先把 video 标成「可显」（data-shown），让「恢复显示」能立即出画面；
      // 但专注模式下整层保持 hidden（data-idle=1），不自动开播、也不覆写「专注保持中」状态。
      try {
        if (video) video.setAttribute('data-shown', '1')
      } catch (e) {
        /* ignore */
      }
      if (st.focusOff) {
        setStatus('高清专注保持中（点「恢复显示」回来看）', '')
      } else {
        setStatus('高清播放中（' + (height ? height + 'P' : 'DASH') + '）', 'ok')
        if (dashWantPlay && video && video.paused) tryPlay(!st.muted)
      }
      syncButtons()
      syncQuality()
      persist()
      scheduleWarmSingleFile()
    }
    function tick() {
      poll = null
      tries += 1
      if (stillCurrent && !stillCurrent()) {
        cleanup()
        return
      }
      if (video && video.readyState >= 2) reveal()
      else if (tries > 70) reveal() // 7s 兜底：别永远不出画面
      else poll = global.setTimeout(tick, 100)
    }
    try {
      if (video) {
        video.addEventListener('loadeddata', reveal)
        video.addEventListener('canplay', reveal)
      }
    } catch (e) {
      /* ignore */
    }
    poll = global.setTimeout(tick, 100)
  }

  /** MSE 失败/不可用：销毁并立刻回退 720p 单文件，绝不留白屏。 */
  var degrading = false
  function degradeTo720p(reason) {
    // 可能被 onFallback / video error / 超时看门狗同时触发，只处理第一次。
    if (degrading) return
    degrading = true
    // 回退也要保住当前进度（否则会被观感成“从头播”）。
    var pos = currentPlayPos()
    destroyDash()
    st.hdEffective = false
    st.hdFallback = reason || '已回退 720p'
    // 注意：**不再把 st.hd 置 false**。st.hd 是用户偏好（持久化），
    // 这里只是本视频/本次播放失败。关掉偏好会导致「重启后高清自动丢失」，
    // 所以保留偏好，下个视频/下次启动仍会尝试高清；UI 用「本视频回退 720p」说明当前状态。
    setStatus('高清不可用：' + st.hdFallback + '，已自动切回 720p 单文件（可再点「高清」重试）', 'error')
    syncButtons()
    syncQuality()
    if (st.current && st.current.bvid) {
      if (pos !== null) st.pendingSeek = pos
      switchingSrc = true
      loadAndPlay(st.current.bvid, { autoPlay: st.playing === true, hd: false })
    }
    // 把回退原因落盘（state.hdDiag），重启/排障时能直接看到卡在哪一步。
    persist()
    resetDegrading()
  }
  /** 回退是异步重载，给一个小延迟再允许下一次回退，避免同一轮错误风暴里反复重载。 */
  function resetDegrading() {
    global.setTimeout(function () {
      degrading = false
    }, 1200)
  }

  /** 当前播放位置（切换高清时用来保位置，别从头播）。 */
  function currentPlayPos() {
    try {
      if (video !== null && isFinite(video.currentTime) && video.currentTime > 0) return video.currentTime
    } catch (e) {
      /* ignore */
    }
    return null
  }

  /** 切换高清开关。 */
  function toggleHd() {
    if (!st.hd && !st.loggedIn) {
      setStatus('高清（1080p+）需先登录（点「账号」→「二维码登录」）', 'error')
      syncQuality()
      return
    }
    // 保位置：切高清/切回 720p 都从当前进度继续，而不是从 0 重播。
    var pos = currentPlayPos()
    st.hd = !st.hd
    st.hdFallback = ''
    if (!st.hd) {
      if (pos !== null) st.pendingSeek = pos
      destroyDash()
      if (st.current && st.current.bvid) {
        switchingSrc = true
        // 保持原来的播放/暂停状态，别因为切画质就自动开播或停播。
        var wasPlaying = st.playing === true
        loadAndPlay(st.current.bvid, { autoPlay: wasPlaying })
      }
    } else if (st.current && st.current.bvid) {
      if (pos !== null) st.pendingSeek = pos
      loadAndPlay(st.current.bvid, { hd: true })
    } else {
      // 还没有当前视频：让后续播出的第一支直接上高清（loadAndPlay 缺省跟 st.hd）。
      var typed = inputEl && inputEl.value ? inputEl.value : ''
      if (typed) loadAndPlay(typed, { hd: true })
      else if (st.queue.length) playQueueIndex(st.index < 0 ? 0 : st.index)
      else loadQueue().then(function () {
        if (st.queue.length) playQueueIndex(0)
        else setStatus('先输入 BV 或加载队列后再开高清', 'error')
      })
    }
    persist()
    syncQuality()
  }

  /** 在已有分轨里切清晰度（无需重新拉 play 接口），同样保住当前进度。 */
  function setHdQuality(rawIndex) {
    var idx = Number(rawIndex)
    if (!isFinite(idx)) return
    st.dashVideoIndex = idx
    persist()
    syncQuality()
    if (st.hdEffective && st.current && st.current.hd === true) {
      var pos = currentPlayPos()
      if (pos !== null) st.pendingSeek = pos
      st.hdFallback = ''
      startDash(st.current, true)
    }
  }

  /** 条高加 'P' 展示；没有则返回空。 */
  function formatLabel(h) {
    var n = Number(h) || 0
    return n > 0 ? String(n) + 'P' : ''
  }

  /** 渲染画质控件状态（高清开关文案 + 去重后的清晰度按钮）。 */
  function syncQuality() {
    if (hdBtn !== null) {
      hdBtn.setAttribute('data-on', st.hd ? '1' : '0')
      hdBtn.textContent = st.hd ? '⬆ 高清已开' : '⬆ 高清'
    }
    if (hdStateEl !== null) {
      var label = ''
      // st.hd 是「用户偏好」，hdFallback 只描述当前视频。偏好开但本视频回退时，
      // 用「本视频回退 720p」说明范围，避免让人以为开关被关掉了。
      if (!st.hd) label = '720p 单文件'
      else if (st.hdFallback && !st.hdEffective) label = '本视频回退 720p'
      else if (st.hdEffective && st.current) label = (formatLabel(st.current.height) || st.current.quality || '') + ' 高清'
      else label = '高清…'
      hdStateEl.textContent = label
    }
    if (qualityWrap === null) return
    qualityWrap.textContent = ''
    qualityButtons = []
    var qualities = st.current && Array.isArray(st.hdQualities) ? st.hdQualities : []
    if (!st.hd) return // 高清没开时不显示清晰度区/提示，保持界面干净
    if (!qualities.length) {
      var note = el('span', 'dsbili-hd-note', st.loggedIn ? '该视频暂无更多清晰度分轨' : '登录后可解锁高清')
      note.style.opacity = '0.5'
      qualityWrap.appendChild(note)
      return
    }
    for (var i = 0; i < qualities.length; i += 1) {
      ;(function (track) {
        var rawIdx = isFinite(Number(track.index)) ? Number(track.index) : i
        var label = formatLabel(track.height) || String(track.id || '')
        if (track.frameRate && String(track.frameRate).indexOf('60') !== -1) label += ' 60fps'
        var btn = el('button', 'dsbili-btn dsbili-hd-btn', label)
        btn.setAttribute('data-index', String(rawIdx))
        btn.setAttribute('data-on', rawIdx === Number(st.dashVideoIndex) ? '1' : '0')
        btn.setAttribute('title', label + ' · ' + (track.codecs || '') + (track.bandwidth ? ' · ' + Math.round(Number(track.bandwidth) / 1000) + 'kbps' : ''))
        btn.addEventListener('click', function () {
          setHdQuality(rawIdx)
        })
        qualityWrap.appendChild(btn)
        qualityButtons.push(btn)
      })(qualities[i])
    }
    if (hdBtn !== null) hdBtn.setAttribute('data-count', String(qualityButtons.length))
  }

  /**
   * 解析并播放一个输入（BV / 链接 / aid）。
   * @param {string} input BV 号 / 链接
   * @param {{autoPlay?: boolean, hd?: boolean}} [opts] autoPlay=false 时只加载（恢复到上次暂停的位置），不自动播放；
   *   hd 覆盖本次是否请求高清（缺省跟 st.hd；降级回 720p 时显式传 false）
   */
  var pendingLoad = null

  /** 解析请求带超时：万一 /play 卡住，也要能把 busy 释放掉，避免「切高清没反应」。 */
  function fetchJsonTimed(url, opts, ms) {
    if (typeof global.AbortController !== 'function') return fetchJson(url, opts)
    var ctrl
    try {
      ctrl = new global.AbortController()
    } catch (e) {
      return fetchJson(url, opts)
    }
    var timer = global.setTimeout(function () {
      try {
        ctrl.abort()
      } catch (e) {
        /* ignore */
      }
    }, Number(ms) || 20000)
    var merged = {}
    if (opts) for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) merged[k] = opts[k]
    merged.signal = ctrl.signal
    return fetchJson(url, merged).then(
      function (v) {
        global.clearTimeout(timer)
        return v
      },
      function (e) {
        global.clearTimeout(timer)
        throw e
      },
    )
  }

  function runPendingLoad() {
    if (pendingLoad === null) return
    var p = pendingLoad
    pendingLoad = null
    loadAndPlay(p.input, p.opts)
  }

  function loadAndPlay(input, opts) {
    if (st.busy) {
      // 忙碌时不要直接丢弃请求：记住最后一次，当前请求结束后接着执行。
      // （否则「刚切高清又切回来」这类快速操作会被静默忽略，表现为「点了没反应」。）
      pendingLoad = { input: input, opts: opts || null }
      return
    }
    var autoPlay = !(opts && opts.autoPlay === false)
    var wantHd = opts && typeof opts.hd === 'boolean' ? opts.hd : st.hd === true
    var pid = opts && Number(opts.pid) >= 1 ? Number(opts.pid) : (st.pid || 1)
    var query = str(input).trim()
    if (query === '') {
      setStatus('请先输入 BV 号或 bilibili 链接', 'error')
      return
    }
    st.busy = true
    setStatus(wantHd ? '解析高清源…' : '解析中…', '')
    syncButtons()
    var playUrl = ROUTES.play + '?bvid=' + encodeURIComponent(query)
    if (wantHd) playUrl += '&hd=1&qn=' + String(st.hdQuality)
    playUrl += '&p=' + pid
    fetchJsonTimed(playUrl, { cache: 'no-store' }, 20000)
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
          endHandled = false // 新视频：允许结尾再次触发结束处理
          // 换视频后分P数可能变小：pid 越界则回落到第一P。
          if (Array.isArray(data.pages) && data.pages.length && st.pid > data.pages.length) st.pid = 1
          syncPages()
          // 开启弹幕时，换/载视频自动装载新 cid 的弹幕池。
          if (st.dm && data.cid) startDanmaku(data.cid)
          st.duration = num(data.duration, 0, 0, 1e9)
          st.srcRel = data.src
          st.srcAbs = ''
          st.srcFallback = false
          // 新视频：按高度去重出一份清晰度列表，并选一个浏览器支持的默认清晰度。
          if (data.hd === true) {
            st.hdQualities = buildQualityList(data.videoTracks)
            var defRaw =
              data.dash && isFinite(Number(data.dash.defaultVideoIndex)) ? Number(data.dash.defaultVideoIndex) : 0
            var defTrack = data.videoTracks && data.videoTracks[defRaw]
            if (!defTrack || !mseSupports(defTrack.mimeType, defTrack.codecs)) {
              defRaw = st.hdQualities.length && isFinite(Number(st.hdQualities[0].index)) ? Number(st.hdQualities[0].index) : 0
            }
            st.dashVideoIndex = defRaw
            st.dashAudioIndex = data.dash && isFinite(Number(data.dash.defaultAudioIndex)) ? Number(data.dash.defaultAudioIndex) : 0
            st.hdFallback = ''
          } else {
            st.hdQualities = []
          }
          if (st.focusOff) {
            // 专注模式：只加载视频，不把画面亮出来（layer 保持 data-idle=1 隐藏）。
            if (layer === null) ensureLayer()
            if (layer !== null) layer.setAttribute('data-idle', '1')
          } else {
            showLayer()
            if (layer === null) ensureLayer()
          }
          // 走 MSE 高清：不再给 <video> 设单文件 src（那个路径拿不到 >720p）。
          if (data.hd === true && wantHd) {
            destroyDash()
            st.hdEffective = false
            if (video !== null) {
              try {
                video.removeAttribute('data-shown')
              } catch (e) {
                /* ignore */
              }
            }
            // startDash 自己会写「高清缓冲中…」→ MSE 真正就绪（ready）才写「高清播放中」，
            // 避免请求还卡着就骗用户说在播（这正是之前「提示播放中但没画面」的观感来源）。
            startDash(data, autoPlay)
            updateNow()
            syncButtons()
            syncQuality()
            persist()
            return
          }
          // 服务端说拿不到高清 → 明确告知用户，并按 720p 单文件播（不白屏）。
          var fallbackNote = ''
          if (wantHd && data.fallback) {
            fallbackNote = String(data.fallback)
            st.hdFallback = fallbackNote
            st.hdEffective = false
            // 保留 st.hd（用户偏好）：这个视频拿不到分轨不代表以后都不用高清，
            // 否则「重启后高清变回非高清」。当前视频按 720p 单文件播并提示即可。
            destroyDash()
          }
          var src = data.src
          if (
            typeof data.mediaBase === 'string' &&
            data.mediaBase !== '' &&
            typeof src === 'string' &&
            src.charAt(0) === '/'
          ) {
            st.srcAbs = data.mediaBase + src
            src = st.srcAbs
          }
          if (video !== null) {
            video.removeAttribute('data-shown')
            video.removeAttribute('data-mse')
            video.src = src
            video.loop = !st.carousel && st.loop === true
            video.setAttribute('data-fit', st.fit === 'cover' ? 'cover' : 'width')
            try {
              video.playbackRate = st.rate
            } catch (e) {
              /* ignore */
            }
            switchingSrc = false
            if (autoPlay) {
              // 先不报「正在播放」：单文件要等 moov/首个分片到位才有画面，
              // 等 loadeddata（见 listener 里 playingPending 分支）再改状态。
              playingPending = true
              tryPlay(!st.muted)
            } else {
              // 恢复到「上次暂停」的状态：加载到记录位置但不自动播放。
              playingPending = false
              st.playing = false
              try {
                video.pause()
              } catch (e) {
                /* ignore */
              }
              syncButtons()
            }
          }
          updateNow()
          syncButtons()
          syncQuality()
          if (fallbackNote) {
            setStatus('高清不可用：' + fallbackNote + '，已用 720p 单文件播放', 'error')
            playingPending = false
          } else if (autoPlay) {
            setStatus('加载 720p…', '')
          } else {
            setStatus(
              st.focusOff
                ? '专注模式保持中（点「恢复显示」回来看）'
                : '已恢复上次暂停的视频（点播放继续）',
              '',
            )
          }
          persist()
        },
        function (error) {
          st.busy = false
          setStatus('解析请求失败：' + (error && error.message ? error.message : error), 'error')
          onVideoFailedInCarousel()
          syncButtons()
        },
      )
      .then(function () {
        runPendingLoad()
      }, function () {
        runPendingLoad()
      })
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
    if (endHandled) return
    endHandled = true
    if (st.carousel) {
      setStatus('播完一支，切下一支…', '')
      next()
      return
    }
    if (st.loop === true) {
      // 高清（MSE）下 blob 源不参与原生 loop：seek 回 0 等 onSeeked 再播。
      if (st.hdEffective && dashPlayer !== null) {
        seekPlayPending = true
        dashPlayer.seek(0)
        return
      }
      // 单文件正常情况下由原生 video.loop 自循环，走不到这里；
      // 能到这说明原生循环没生效（异常/被关），手动回 0 续播。
      seekPlayPending = false
      if (video !== null) {
        try {
          video.currentTime = 0
        } catch (e) {
          /* ignore */
        }
        tryPlay(!st.muted)
      }
      return
    }
    st.playing = false
    syncButtons()
    setStatus('播放结束（循环已关）', '')
  }

  /**
   * 播放到结尾兜底看门狗：MSE（DASH）在部分内核下不一定派发 ended 事件，
   * 而单曲循环/列表连播在高清下都依赖它。这里每秒检查「是否已到结尾但仍在播放状态」，
   * 需要手动收尾时触发一次 onEnded（幂等，不会重复切歌/重播）。
   */
  function checkPlaybackEnd() {
    if (!st.playing || video === null) return
    var dur = 0
    var t = 0
    try {
      dur = isFinite(video.duration) && video.duration > 0 ? video.duration : Number(st.duration) || 0
      t = isFinite(video.currentTime) ? video.currentTime : 0
    } catch (e) {
      return
    }
    if (!(dur > 0)) return
    // 回到中段（seek/重播）→ 允许下一次结束再次触发。
    if (t < dur - 2) {
      endHandled = false
      return
    }
    if (endHandled) return
    var manual = st.carousel === true || (st.loop === true && (st.hdEffective === true || dashPlayer !== null))
    // 贴近结尾且（需要手动收尾，或 media element 已标记 ended 但没收到事件）→ 视为结束。
    var ended = false
    try {
      ended = video.ended === true
    } catch (e) {
      ended = false
    }
    if (t >= dur - 0.5 && (manual || ended)) onEnded()
  }

  function startEndWatchdog() {
    if (endWatchTimer !== null) return
    if (typeof global.setInterval !== 'function') return
    endWatchTimer = global.setInterval(checkPlaybackEnd, 800)
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

  // ────────────────────────────── 账号 / 登录 ──────────────────────────────
  // 只调宿主路由（不直连 B 站）。面板里绝不显示 Cookie，只显示昵称/头像。

  function authRoutes() {
    return ROUTES.auth
  }

  /** 拉一次登录态并重绘账号区。 */
  function refreshAuth() {
    var ar = authRoutes()
    if (!ar || !ar.status) {
      st.authReady = true
      return
    }
    st.authBusy = true
    renderAccount()
    fetchJson(ar.status, { cache: 'no-store' }).then(
      function (data) {
        st.authBusy = false
        st.authReady = true
        if (data && data.ok === true) {
          st.loggedIn = data.loggedIn === true
          st.account = data.account && typeof data.account === 'object' ? data.account : null
        }
        renderAccount()
        applyDefaultSource()
      },
      function () {
        st.authBusy = false
        st.authReady = true
        renderAccount()
        applyDefaultSource()
      },
    )
  }

  /**
   * 默认来源策略：未手动选过来源时，已登录 → 首页推荐，未登录 → 热门。
   * 手动选过（st.sourcePicked）就尊重用户选择；仅在「选的是首页推荐但已登出」时回落热门，
   * 避免一直停在会提示需登录的来源上。
   */
  function applyDefaultSource() {
    if (!st.authReady) return
    var next = st.source
    if (st.sourcePicked) {
      if (!st.loggedIn && st.source === 'feed') next = 'popular'
    } else {
      next = st.loggedIn ? 'feed' : 'popular'
    }
    if (next === st.source) return
    st.source = next
    st.index = -1
    syncButtons()
    if (!st.busy) loadQueue()
  }

  /** 点“二维码登录”：向宿主申请新二维码，再开始 2s 轮询。 */
  function startQrLogin() {
    var ar = authRoutes()
    if (!ar || !ar.create || !ar.status) return
    stopQrLogin()
    st.qr = { active: true, key: '', img: '', statusText: '正在生成二维码…' }
    st.authBusy = true
    renderAccount()
    fetchJson(ar.create, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(
      function (data) {
        st.authBusy = false
        if (!data || data.ok !== true) {
          st.qr.active = false
          st.qr.statusText = (data && data.error) || '生成二维码失败'
          renderAccount()
          return
        }
        st.qr.key = str(data.key)
        st.qr.statusText = '等待扫码…'
        renderAccount()
        startQrPoll()
      },
      function (error) {
        st.authBusy = false
        st.qr.active = false
        st.qr.statusText = '生成二维码失败：' + (error && error.message ? error.message : error)
        renderAccount()
      },
    )
  }

  function startQrPoll() {
    stopQrPoll()
    qrPollTries = 0
    scheduleQrPoll()
  }
  function stopQrPoll() {
    if (qrPollTimer !== null) {
      try {
        global.clearTimeout(qrPollTimer)
      } catch (e) {
        /* ignore */
      }
      qrPollTimer = null
    }
  }
  function scheduleQrPoll() {
    if (!st.qr || !st.qr.active) return
    qrPollTimer = global.setTimeout(function () {
      qrPollTimer = null
      pollQrOnce()
    }, 2000)
  }
  function pollQrOnce() {
    var ar = authRoutes()
    if (!ar || !ar.poll || !st.qr || !st.qr.active || !st.qr.key) return
    qrPollTries += 1
    fetchJson(ar.poll + '?key=' + encodeURIComponent(st.qr.key), { cache: 'no-store' }).then(
      function (data) {
        if (!st.qr || !st.qr.active) return
        if (!data || data.ok !== true) {
          st.qr.statusText = (data && data.error) || '轮询扫码失败'
          stopQrPoll()
          renderAccount()
          return
        }
        if (data.status === 'ok') {
          stopQrPoll()
          st.qr.active = false
          renderAccount()
          refreshAuth()
          setStatus('登录成功', 'ok')
          return
        }
        if (data.status === 'expired') {
          // 失效自动刷新一个新二维码，避免用户手动点。
          stopQrPoll()
          st.qr.statusText = '二维码已过期，正在刷新…'
          renderAccount()
          global.setTimeout(function () {
            startQrLogin()
          }, 400)
          return
        }
        // wait / scanned
        st.qr.statusText = data.status === 'scanned' ? '已扫码，请在手机上确认' : '等待扫码…'
        renderAccount()
        scheduleQrPoll()
      },
      function (error) {
        if (!st.qr || !st.qr.active) return
        st.qr.statusText = '轮询失败：' + (error && error.message ? error.message : error)
        stopQrPoll()
        renderAccount()
      },
    )
  }

  /** 取消扫码（清掉定时器、退回未登录视图）。 */
  function stopQrLogin() {
    stopQrPoll()
    if (st.qr) st.qr.active = false
    renderAccount()
  }

  /** 退出登录。 */
  function doLogout() {
    var ar = authRoutes()
    if (!ar || !ar.logout) return
    st.authBusy = true
    renderAccount()
    fetchJson(ar.logout, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(
      function (data) {
        st.authBusy = false
        st.loggedIn = false
        st.account = null
        renderAccount()
        applyDefaultSource() // 退出后若来源是首页推荐，会自动回落热门
        setStatus(data && data.ok === true ? '已退出登录' : '退出登录完成', 'ok')
      },
      function () {
        st.authBusy = false
        st.loggedIn = false
        st.account = null
        renderAccount()
        applyDefaultSource()
        setStatus('已退出登录', 'ok')
      },
    )
  }

  /**
   * 重绘「常驻顶部」的账号区（紧凑一行）：登录 → 头像+昵称+退出；未登录 → 二维码登录按钮。
   * 扫码二维码放到浮层（renderQrOverlay），不把顶部撑高。
   */
  function renderAccount() {
    if (accountEl === null) return
    accountEl.textContent = ''
    var row = el('div', 'dsbili-account-row')
    row.id = 'dsbili-account-body'

    if (st.loggedIn && st.account && st.account.uname) {
      if (st.account.face) {
        var av = el('img', 'dsbili-account-avatar')
        av.alt = '头像'
        av.src = st.account.face
        row.appendChild(av)
      }
      row.appendChild(el('span', 'dsbili-account-name', st.account.uname))
      var logoutBtn = el('button', 'dsbili-btn dsbili-account-logout', '退出登录')
      logoutBtn.addEventListener('click', doLogout)
      row.appendChild(logoutBtn)
    } else {
      row.appendChild(el('span', 'dsbili-account-state', '未登录'))
      var loginBtn = el('button', 'dsbili-btn dsbili-account-login', '扫码登录')
      loginBtn.addEventListener('click', startQrLogin)
      row.appendChild(loginBtn)
      if (st.authBusy) row.appendChild(el('div', 'dsbili-account-status', '检测登录态…'))
    }

    accountEl.appendChild(row)
    renderQrOverlay()
  }

  /** 扫码登录浮层：只在扫码中显示，避免把常驻顶部撑高。 */
  function renderQrOverlay() {
    if (qrOverlay === null) return
    qrOverlay.textContent = ''
    if (!(st.qr && st.qr.active)) {
      qrOverlay.removeAttribute('data-open')
      return
    }
    qrOverlay.setAttribute('data-open', '1')
    var card = el('div', 'dsbili-qr-card')
    card.appendChild(el('div', 'dsbili-qr-title', '扫码登录 B 站'))
    var qi = el('img', 'dsbili-qr-img')
    qi.alt = '扫码登录'
    qi.src = str(ROUTES.auth.image) + '?key=' + encodeURIComponent(st.qr.key || '')
    card.appendChild(qi)
    card.appendChild(el('div', 'dsbili-qr-status', st.qr.statusText || '…'))
    var cancelBtn = el('button', 'dsbili-btn', '取消')
    cancelBtn.addEventListener('click', stopQrLogin)
    card.appendChild(cancelBtn)
    qrOverlay.appendChild(card)
  }

  /** 在系统默认浏览器打开当前 B 站视频。 */
  function openCurrentVideo() {
    var bvid = st.current && st.current.bvid ? st.current.bvid : ''
    if (!bvid) {
      setStatus('还没有正在播放的视频', 'error')
      return
    }
    var url = 'https://www.bilibili.com/video/' + encodeURIComponent(bvid)
    if (ROUTES.open) {
      fetchJson(ROUTES.open + '?bvid=' + encodeURIComponent(bvid), { cache: 'no-store' }).then(
        function () {},
        function () {
          // 宿主打不开就退浏览器 window.open
          try {
            global.open(url, '_blank')
          } catch (e) {
            setStatus('打不开浏览器：' + url, 'error')
          }
        },
      )
      return
    }
    try {
      global.open(url, '_blank')
    } catch (e) {
      setStatus('打不开浏览器：' + url, 'error')
    }
  }

  // ────────────────────────────── 队列 ──────────────────────────────

  function loadQueue() {
    if (!ROUTES.queue) return Promise.resolve()
    if (st.queueBusy) return Promise.resolve()
    st.queueBusy = true
    var label = st.source === 'ranking' ? '排行榜' : st.source === 'feed' ? '首页推荐' : '热门'
    setStatus('加载' + label + '…', '')
    return fetchJson(ROUTES.queue + '?source=' + st.source + '&count=' + st.count, { cache: 'no-store' }).then(
      function (data) {
        st.queueBusy = false
        if (!data || data.ok !== true) {
          setStatus((data && data.error) || '队列加载失败', 'error')
          return
        }
        if (data.needAuth === true) {
          setStatus('首页推荐需先登录（点“账号”→“二维码登录”）', 'error')
          return
        }
        st.queue = Array.isArray(data.list) ? data.list : []
        st.index = -1
        renderList()
        setStatus('已加载 ' + st.queue.length + ' 支视频', 'ok')
      },
      function (error) {
        st.queueBusy = false
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

  /** 应用面板位置（标题栏拖动后会记住，重启恢复）。 */
  function applyPanelPos(pos) {
    if (panel === null || !isObj(pos)) return
    var left = num(pos.left, NaN, -100000, 100000)
    var top = num(pos.top, NaN, -100000, 100000)
    if (left !== left || top !== top) return
    // 夹进当前视口，避免换了窗口尺寸/分辨率后面板跑到屏幕外或右侧被裁。
    var w = panel.offsetWidth || 300
    var h = panel.offsetHeight || 320
    var maxLeft = Math.max(0, (global.innerWidth || 0) - w - 8)
    var maxTop = Math.max(0, (global.innerHeight || 0) - Math.min(h, 120))
    left = Math.max(0, Math.min(maxLeft, left))
    top = Math.max(0, Math.min(maxTop, top))
    st.panelPos = { left: Math.round(left), top: Math.round(top) }
    try {
      panel.style.left = Math.round(left) + 'px'
      panel.style.top = Math.round(top) + 'px'
      panel.style.right = 'auto'
    } catch (e) {
      /* ignore */
    }
  }

  /** 记录面板当前位置（拖动结束）。 */
  function rememberPanelPos() {
    if (panel === null) return
    var rect = typeof panel.getBoundingClientRect === 'function' ? panel.getBoundingClientRect() : null
    var left = rect ? rect.left : parseFloat(panel.style.left)
    var top = rect ? rect.top : parseFloat(panel.style.top)
    if (left !== left || top !== top) return
    st.panelPos = { left: Math.round(left), top: Math.round(top) }
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
      sourcePicked: st.sourcePicked === true,
      count: st.count,
      carousel: st.carousel,
      loop: st.loop === true,
      muted: st.muted,
      volume: st.volume,
      focusOff: st.focusOff,
      wallpaper: st.wallpaper === true,
      dm: st.dm === true,
      dmSize: st.dmSize,
      dmOpacity: st.dmOpacity,
      dmSpeed: st.dmSpeed,
      dmArea: st.dmArea,
      pid: Math.floor(Number(st.pid) || 1),
      surface: st.surface,
      veil: st.veil,
      veilLight: st.veilLight,
      fit: st.fit,
      preserveBg: st.preserveBg,
      rate: st.rate,
      launcher: st.launcher || null,
      panelPos: st.panelPos || null,
      tab: st.tab,
      resume: st.resume,
      // 高清开关与清晰度选择要跨重启记住（登录态下才生效）。
      hd: st.hd === true,
      hdQuality: st.hdQuality,
      // MSE 诊断（排障用：最近状态 + 回退原因）。
      hdDiag: st.hdDiag || null,
      bvid: st.current && st.current.bvid ? st.current.bvid : '',
      title: st.current && st.current.title ? st.current.title : '',
      playing: st.playing === true,
      time: Math.round(time * 10) / 10,
      // 诊断：重启后若续播/拖动仍有问题，看这几个值就能判断是拿不到时长还是 seek 失败。
      diag: {
        rs: video !== null ? video.readyState : null,
        dur: video !== null && isFinite(video.duration) ? video.duration : null,
        seekableEnd: (function () {
          try {
            if (video !== null && video.seekable && video.seekable.length > 0) return video.seekable.end(0)
          } catch (e) {
            /* ignore */
          }
          return null
        })(),
        cur: video !== null && isFinite(video.currentTime) ? video.currentTime : null,
        src: st.srcFallback ? 'proxy' : st.srcAbs !== '' ? 'direct' : 'proxy',
      },
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
        st.source = s.source === 'ranking' || s.source === 'feed' ? s.source : st.source
        st.sourcePicked = s.sourcePicked === true
        st.count = num(s.count, st.count, 1, 30)
        st.carousel = s.carousel === true
        if (typeof s.loop === 'boolean') st.loop = s.loop
        // 互斥：两个都开时以「列表连播」为准（旧状态兼容）
        if (st.carousel && st.loop) st.loop = false
        st.muted = s.muted === true
        st.volume = num(s.volume, st.volume, 0, 1)
        st.veil = num(s.veil, st.veil, 0, 0.92)
        st.veilLight = num(s.veilLight, st.veilLight, 0, 0.92)
        st.surface = num(s.surface, st.surface, 0, 1)
        if (s.fit === 'cover' || s.fit === 'width') st.fit = s.fit
        if (typeof s.preserveBg === 'boolean') st.preserveBg = s.preserveBg
        st.rate = num(s.rate, st.rate, 0.25, 4)
        st.resume = s.resume !== false
        // 高清偏好恢复。
        st.hd = s.hd === true
        st.hdQuality = num(s.hdQuality, st.hdQuality, 1, 999)
        // 专注模式（隐藏画面）也是持久状态：上次退出时开着，重启后应当保持隐藏，
        // 而不是把画面直接亮出来。必须在 syncControls / 续播之前恢复。
        st.focusOff = s.focusOff === true
        // 分P与纯氛围静音墙纸也是持久状态。
        st.pid = Math.max(1, Math.floor(Number(s.pid) || 1))
        st.wallpaper = s.wallpaper === true
        st.dm = s.dm === true
        st.dmSize = num(s.dmSize, 100, 50, 200)
        st.dmOpacity = num(s.dmOpacity, 80, 10, 100)
        st.dmSpeed = num(s.dmSpeed, 100, 40, 250)
        st.dmArea = num(s.dmArea, 100, 25, 100)
        if (s.launcher) applyLauncherPos(s.launcher)
        if (s.panelPos) applyPanelPos(s.panelPos)
        if (typeof s.tab === 'string' && panelSetTab) panelSetTab(s.tab)
        if (s.bvid && inputEl) inputEl.value = s.bvid
        syncControls()
        applyWallpaper()
        applyVeil()
        // 来源策略可能依赖登录态（已登录默认首页推荐），两者都就绪后再定一次。
        applyDefaultSource()
        // 启动续播：只要记过视频就恢复它（含「暂停时退出」的情况）——上次在播就自动播，
        // 上次是暂停的就加载回原位但保持暂停，避免重启后视频丢失、点播放变成从列表重选。
        // 专注模式下不自动播、也不显示画面（loadAndPlay 会按 st.focusOff 处理）。
        if (st.resume && s.bvid) {
          st.pendingSeek = num(s.time, 0, 0, 1e9)
          var wasPlaying = s.playing === true && !st.focusOff
          global.setTimeout(function () {
            loadAndPlay(s.bvid, { autoPlay: wasPlaying })
          }, 60)
        }
        if (st.focusOff) setStatus('专注模式保持中（上次退出时开启），点「恢复显示」回来看', '')
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

  // ────────────────────────────── 下载当前视频 ──────────────────────────────
  // 宿主注册了 download 路由才可用（ROUTES.download 缺失时按钮禁用、调用优雅返回）。

  function dlAvailable() {
    return !!(ROUTES.download && (ROUTES.download.create || ROUTES.download.status))
  }

  function setDownloadLine(text, level) {
    if (dlStatusEl !== null) {
      dlStatusEl.textContent = text
      dlStatusEl.setAttribute('data-level', level || '')
    }
  }

  /** 拉一次宿主解析出的「保存目录」并显示（首次打开面板时）。 */
  function loadDownloadDir() {
    if (!ROUTES.download || !ROUTES.download.list || dlDir) return
    fetchJson(ROUTES.download.list, { cache: 'no-store' }).then(
      function (data) {
        if (!data || data.ok !== true || !data.dir) return
        dlDir = String(data.dir)
        if (dlDirEl !== null) {
          dlDirEl.textContent = dlDir
          dlDirEl.setAttribute('title', '下载保存目录：' + dlDir)
        }
      },
      noop,
    )
  }

  /** 取路径里的文件名（兼容 / 与 \）。 */
  function fileNameOf(p) {
    if (!p) return ''
    var s = String(p)
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
    return i >= 0 ? s.slice(i + 1) : s
  }

  /** 进度百分比；total 不可用（<=0）时返回 '-'。 */
  function downloadPct(t) {
    var total = Number(t && t.total) || 0
    var received = Number(t && t.received) || 0
    if (total <= 0) return '-'
    var p = Math.floor((received / total) * 100)
    if (p < 0) p = 0
    if (p > 100) p = 100
    return p
  }

  /** 字节数 → 人类可读（1.2 MB / 830 KB / 512 B）。 */
  function formatBytes(n) {
    var v = Number(n) || 0
    if (v <= 0) return '0 B'
    if (v < 1024) return Math.round(v) + ' B'
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
    if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB'
    return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  }

  /**
   * 已下载/总大小 + 速度。速度用相邻两次轮询（约 1s）的字节差估算，
   * 首次没有基准值就不显示速度，避免给出假数字。
   */
  function downloadDetail(t) {
    var received = Number(t && t.received) || 0
    var total = Number(t && t.total) || 0
    var now = Date.now()
    var speed = 0
    if (dlPrev.at > 0 && now > dlPrev.at && received >= dlPrev.received) {
      speed = (received - dlPrev.received) / ((now - dlPrev.at) / 1000)
    }
    dlPrev = { at: now, received: received }
    var text = formatBytes(received)
    if (total > 0) text += ' / ' + formatBytes(total)
    if (speed > 0) text += ' · ' + formatBytes(speed) + '/s'
    return text
  }

  // ────────────────────────────── ffmpeg（高清下载合轨）──────────────────────────────

  function ffmpegRoutes() {
    return ROUTES.ffmpeg && ROUTES.ffmpeg.status ? ROUTES.ffmpeg : null
  }

  function setFfmpegLine(text, level) {
    if (ffmpegStatusEl !== null) {
      ffmpegStatusEl.textContent = text
      ffmpegStatusEl.setAttribute('data-level', level || '')
    }
  }

  /** 渲染 ffmpeg 状态行/按钮（未就绪时给一键下载）。 */
  function syncFfmpegUi() {
    if (ffmpegStatusEl === null || ffmpegBtn === null) return
    var info = ffmpegInfo || {}
    var inst = info.install || {}
    if (inst.state === 'downloading') {
      var pct = Number(inst.total) > 0 ? Math.min(100, Math.floor((Number(inst.received) / Number(inst.total)) * 100)) : -1
      setFfmpegLine(
        '下载 ffmpeg ' + (pct >= 0 ? pct + '%' : formatBytes(inst.received)) + (Number(inst.total) > 0 ? ' · ' + formatBytes(inst.total) : ''),
        '',
      )
      ffmpegBtn.textContent = '✕ 取消下载'
      ffmpegBtn.disabled = false
      return
    }
    if (inst.state === 'verifying') {
      setFfmpegLine('校验 ffmpeg…', '')
      ffmpegBtn.textContent = '✕ 取消下载'
      ffmpegBtn.disabled = false
      return
    }
    if (info.found) {
      setFfmpegLine('ffmpeg 已就绪：高清下载会自动合轨成单个 mp4', 'ok')
      ffmpegBtn.textContent = '✓ 已就绪'
      ffmpegBtn.disabled = true
      if (ffmpegStatusEl !== null) ffmpegStatusEl.setAttribute('title', String(info.path || ''))
      return
    }
    var hint = '未检测到 ffmpeg：高清下载会分别保存视频/音频两个文件'
    if (inst.state === 'error' && inst.error) hint += '（上次下载失败：' + inst.error + '）'
    setFfmpegLine(hint, inst.state === 'error' ? 'error' : '')
    ffmpegBtn.textContent = '⬇ 下载 ffmpeg（约 30MB）'
    ffmpegBtn.disabled = false
    if (ffmpegStatusEl !== null) {
      ffmpegStatusEl.setAttribute(
        'title',
        '一键下载地址：' + String(info.downloadUrl || '') + '\n也可以手动下载后放到：' + String(info.managedPath || ''),
      )
    }
  }

  /** 拉一次 ffmpeg 状态。 */
  function loadFfmpegStatus() {
    var r = ffmpegRoutes()
    if (!r) return
    fetchJson(r.status, { cache: 'no-store' }).then(
      function (data) {
        if (!data || data.ok !== true) return
        ffmpegInfo = data
        syncFfmpegUi()
      },
      function () {
        /* 探测失败就当没有 */
      },
    )
  }

  function stopFfmpegPoll() {
    if (ffmpegPollTimer !== null) {
      try {
        global.clearTimeout(ffmpegPollTimer)
      } catch (e) {
        /* ignore */
      }
      ffmpegPollTimer = null
    }
  }

  /** 轮询安装进度；done/error/cancelled 后停并刷新。 */
  function pollFfmpegInstall() {
    var r = ffmpegRoutes()
    if (!r || !r.install) return
    stopFfmpegPoll()
    ffmpegPollTimer = global.setTimeout(function () {
      ffmpegPollTimer = null
      fetchJson(r.install, { cache: 'no-store' }).then(
        function (data) {
          if (!data || data.ok !== true) {
            stopFfmpegPoll()
            return
          }
          if (ffmpegInfo) ffmpegInfo.install = data
          else ffmpegInfo = { install: data }
          syncFfmpegUi()
          if (data.state === 'downloading' || data.state === 'verifying') {
            pollFfmpegInstall()
          } else {
            loadFfmpegStatus()
          }
        },
        function () {
          stopFfmpegPoll()
        },
      )
    }, 900)
  }

  /** 点按钮：没装 → 一键下载；下载中 → 取消。 */
  function toggleFfmpegInstall() {
    var r = ffmpegRoutes()
    if (!r || !r.install) {
      setFfmpegLine('当前环境不支持自动下载 ffmpeg', 'error')
      return
    }
    var inst = ffmpegInfo && ffmpegInfo.install ? ffmpegInfo.install : null
    if (inst && (inst.state === 'downloading' || inst.state === 'verifying')) {
      fetchJson(r.install, { method: 'DELETE' }).then(
        function () {
          loadFfmpegStatus()
        },
        function () {
          loadFfmpegStatus()
        },
      )
      return
    }
    setFfmpegLine('开始下载 ffmpeg…', '')
    fetchJson(r.install, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(
      function (data) {
        if (ffmpegInfo) ffmpegInfo.install = data
        else ffmpegInfo = { install: data }
        syncFfmpegUi()
        pollFfmpegInstall()
      },
      function (error) {
        setFfmpegLine('下载 ffmpeg 失败：' + (error && error.message ? error.message : error), 'error')
      },
    )
  }

  function renderDownloadTask(t) {
    if (!t) return
    var tag = t.height ? String(t.height) + 'P' : ''
    if (t.status === 'done') {
      var size = Number(t.total) > 0 ? Number(t.total) : Number(t.received) || 0
      var multi = Array.isArray(t.paths) && t.paths.length > 1
      if (multi) {
        setDownloadLine(
          '已保存 ' + (tag ? tag + ' ' : '') + '视频+音频两个文件: ' + fileNameOf(t.paths[0]) + ' / ' + fileNameOf(t.paths[1]) + (t.note ? '（' + t.note + '）' : ''),
          'ok',
        )
        if (dlStatusEl !== null) dlStatusEl.setAttribute('title', '完整路径：\n' + t.paths.join('\n'))
      } else {
        setDownloadLine(
          '已保存: ' + fileNameOf(t.path) + (tag ? '（' + tag + '）' : '') + (size > 0 ? '（' + formatBytes(size) + '）' : '') + (t.note ? ' · ' + t.note : ''),
          'ok',
        )
        if (dlStatusEl !== null) dlStatusEl.setAttribute('title', '完整路径：' + String(t.path || ''))
      }
    } else if (t.status === 'error') setDownloadLine('下载失败: ' + (t.error || '未知原因'), 'error')
    else if (t.status === 'queued') setDownloadLine('排队中…' + (tag ? '（' + tag + '）' : ''), '')
    else if (t.status === 'muxing') setDownloadLine('合轨中（ffmpeg -c copy）…' + (tag ? ' ' + tag : ''), '')
    else {
      // total 未知（还没拿到 content-length）时不显示假百分比，只显示已下载量与速度。
      var pct = downloadPct(t)
      var detail = downloadDetail(t)
      setDownloadLine('下载中' + (tag ? '（' + tag + '）' : '') + (pct === '-' ? '' : ' ' + pct + '%') + ' · ' + detail, '')
    }
  }

  function stopDownloadPoll() {
    if (dlTimer !== null) {
      try {
        global.clearTimeout(dlTimer)
      } catch (e) {
        /* ignore */
      }
      dlTimer = null
    }
  }

  /** 下载期间约每秒轮询一次宿主，done/error 后停。 */
  function pollDownload() {
    if (!dlTaskId || !ROUTES.download || !ROUTES.download.status) return
    stopDownloadPoll()
    dlTimer = global.setTimeout(function () {
      dlTimer = null
      fetchJson(ROUTES.download.status + '?id=' + encodeURIComponent(dlTaskId), { cache: 'no-store' }).then(
        function (data) {
          if (!dlTaskId) return
          if (!data || data.ok !== true) {
            setDownloadLine((data && data.error) || '查询下载状态失败', 'error')
            dlTaskId = null
            syncDownloadButton()
            return
          }
          renderDownloadTask(data.task || {})
          var s = data.task && data.task.status
          if (s === 'downloading' || s === 'queued') pollDownload()
          else if (s === 'done' || s === 'error') {
            dlTaskId = null
            syncDownloadButton()
          }
        },
        function () {
          if (!dlTaskId) return
          dlTaskId = null
          setDownloadLine('查询下载状态失败', 'error')
          syncDownloadButton()
        },
      )
    }, 1000)
  }

  function startDownloadCurrent() {
    if (!dlAvailable()) {
      setDownloadLine('当前环境不支持下载', 'error')
      return
    }
    // 已有任务在跑（排队/下载中）再点 = 中途取消。
    if (dlTaskId) {
      cancelDownloadCurrent()
      return
    }
    if (!st.current || !st.current.bvid) {
      setDownloadLine('当前没有可下载的视频', 'error')
      return
    }
    if (dlBtn !== null) dlBtn.disabled = true
    dlPrev = { at: 0, received: 0 } // 重置速度基准，避免沿用上一次下载的数字
    // 按当前正在播放的画质下载：高清（MSE）时把分轨索引/高度带给宿主，
    // 宿主会按该清晰度取 DASH 分轨（有 ffmpeg 则合轨成单 mp4，否则分别存视频/音频轨）。
    var quality = { mode: st.hdEffective && dashPlayer !== null ? 'hd' : 'single' }
    if (quality.mode === 'hd') {
      quality.videoIndex = st.dashVideoIndex
      quality.audioIndex = st.dashAudioIndex
      quality.qn = st.hdQuality
      var curQ = st.current && Array.isArray(st.hdQualities) ? st.hdQualities : []
      var hit = null
      for (var qi = 0; qi < curQ.length; qi += 1) {
        if (Number(curQ[qi].index) === Number(st.dashVideoIndex)) hit = curQ[qi]
      }
      quality.height = hit ? Number(hit.height) || 0 : Number(st.current && st.current.height) || 0
    }
    // 宿主会弹 Windows「另存为」（默认目录=系统下载目录），用户确认后才开始下载。
    setDownloadLine('请在弹出的窗口选择保存位置…' + (quality.height ? '（' + quality.height + 'P）' : ''), '')
    fetchJson(ROUTES.download.create, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bvid: st.current.bvid, pid: st.pid || 1, quality: quality }),
    }).then(
      function (data) {
        if (!data || data.ok !== true) {
          setDownloadLine((data && data.error) || '下载请求失败', 'error')
          syncDownloadButton()
          return
        }
        if (data.cancelled === true) {
          // 用户在保存框点了取消：不算错误，安静回到可再次点击的状态。
          setDownloadLine('已取消（未下载）', '')
          syncDownloadButton()
          return
        }
        dlTaskId = data.id
        renderDownloadTask(data.task)
        syncDownloadButton()
        pollDownload()
      },
      function (error) {
        setDownloadLine('下载请求失败：' + (error && error.message ? error.message : error), 'error')
        syncDownloadButton()
      },
    )
  }

  /** 中途取消：DELETE /download?id=；宿主断开 HTTP、清理 .part 半成品。 */
  function cancelDownloadCurrent() {
    if (!dlTaskId || !ROUTES.download || !ROUTES.download.status) return
    var id = dlTaskId
    dlTaskId = null
    stopDownloadPoll()
    setDownloadLine('正在取消…', '')
    fetchJson(ROUTES.download.status + '?id=' + encodeURIComponent(id), { method: 'DELETE' }).then(
      function (data) {
        if (data && data.ok === true) {
          setDownloadLine('已取消下载（半成品已清理）', '')
        } else {
          setDownloadLine('已取消' + (data && data.error ? '（' + data.error + '）' : ''), '')
        }
        syncDownloadButton()
      },
      function () {
        setDownloadLine('已取消下载', '')
        syncDownloadButton()
      },
    )
  }

  function syncDownloadButton() {
    if (dlBtn === null) return
    // 有任务在跑 → 按钮变「取消」；否则是「下载当前」。
    if (dlTaskId) {
      dlBtn.textContent = '✕ 取消下载'
      dlBtn.disabled = !dlAvailable()
      return
    }
    dlBtn.textContent = '⬇ 下载当前'
    dlBtn.disabled = !dlAvailable() || !st.current
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
    if (nowLabelEl !== null) {
      nowLabelEl.textContent = st.current ? (st.playing ? '正在播放' : '已暂停') : '未播放'
      nowLabelEl.setAttribute('data-on', st.current ? '1' : '0')
    }
    if (playBtn !== null) {
      playBtn.textContent = st.playing ? '⏸ 暂停' : '▶ 播放'
      playBtn.setAttribute('aria-pressed', st.playing ? 'true' : 'false')
    }
    if (muteBtn !== null) {
      // 只留喇叭图标（文案在 title 里），放音量行右侧
      muteBtn.textContent = st.muted ? '🔇' : '🔊'
      muteBtn.setAttribute('title', st.muted ? '已静音，点击开启声音' : '点击静音')
      muteBtn.setAttribute('data-on', st.muted ? '0' : '1')
      muteBtn.setAttribute('aria-pressed', st.muted ? 'false' : 'true')
    }
    if (fitBtn !== null) fitBtn.textContent = st.fit === 'cover' ? '显示: 铺满' : '显示: 完整'
    if (bgBtn !== null) bgBtn.textContent = st.preserveBg ? '背景: 保留' : '背景: 留空'
    if (miniPlayBtn !== null) miniPlayBtn.textContent = st.playing ? '⏸' : '▶'
    if (clearBtn !== null) clearBtn.setAttribute('data-on', st.clear ? '1' : '0')
    if (settingsClearBtn !== null) settingsClearBtn.setAttribute('data-on', st.clear ? '1' : '0')
    if (miniFocusBtn !== null) miniFocusBtn.setAttribute('data-on', st.focusOff ? '1' : '0')
    if (rateVal !== null) rateVal.textContent = String(st.rate) + 'x'
    for (var rbi = 0; rbi < rateButtons.length; rbi += 1) {
      var rb = rateButtons[rbi]
      rb.setAttribute('data-on', Number(rb.getAttribute('data-rate')) === st.rate ? '1' : '0')
    }
    if (carouselBtn !== null) {
      carouselBtn.setAttribute('aria-pressed', st.carousel ? 'true' : 'false')
      carouselBtn.setAttribute('data-on', st.carousel ? '1' : '0')
    }
    if (loopBtn !== null) {
      loopBtn.setAttribute('aria-pressed', st.loop ? 'true' : 'false')
      loopBtn.setAttribute('data-on', st.loop ? '1' : '0')
      // 文案固定（开关状态用 data-on 高亮），避免「循环关」这种让人困惑的字样
      loopBtn.textContent = '🔂 单曲循环'
    }
    if (focusBtn !== null) {
      focusBtn.textContent = st.focusOff ? '☀ 恢复显示' : '🌙 专注隐藏'
      focusBtn.setAttribute('data-on', st.focusOff ? '1' : '0')
    }
    if (wallpaperBtn !== null) {
      wallpaperBtn.textContent = st.wallpaper ? '🖼 静音墙纸:开' : '🖼 静音墙纸'
      wallpaperBtn.setAttribute('data-on', st.wallpaper ? '1' : '0')
    }
    if (dmBtn !== null) {
      dmBtn.textContent = st.dm ? '💬 弹幕:开' : '💬 弹幕'
      dmBtn.setAttribute('data-on', st.dm ? '1' : '0')
    }
    syncDmSettings()
    if (prevBtn !== null) prevBtn.disabled = st.busy
    if (nextBtn !== null) nextBtn.disabled = st.busy
    if (srcPopular !== null) srcPopular.setAttribute('aria-pressed', st.source === 'popular' ? 'true' : 'false')
    if (srcRanking !== null) srcRanking.setAttribute('aria-pressed', st.source === 'ranking' ? 'true' : 'false')
    if (srcFeed !== null) srcFeed.setAttribute('aria-pressed', st.source === 'feed' ? 'true' : 'false')
    if (surfaceVal !== null) surfaceVal.textContent = Math.round(st.surface * 100) + '%'
    if (veilVal !== null) veilVal.textContent = Math.round(st.veil * 100) + '%'
    if (volRange !== null) volRange.value = String(Math.round(st.volume * 100))
    if (surfaceRange !== null) surfaceRange.value = String(Math.round(st.surface * 100))
    if (veilRange !== null) veilRange.value = String(Math.round(st.veil * 100))
    syncDownloadButton()
  }

  function syncControls() {
    syncButtons()
    if (carouselBtn !== null) carouselBtn.setAttribute('aria-pressed', st.carousel ? 'true' : 'false')
    if (video !== null) video.loop = !st.carousel && st.loop === true
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
    // 恢复上次拖到的位置（窗口尺寸可能变了，这里再夹一次）。
    if (st.panelPos) applyPanelPos(st.panelPos)
    // 首次打开面板时队列还是空的（例如刚重启），自动拉一次，免得用户看到空列表。
    if (!st.queue.length && !st.busy) loadQueue()
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

  /** 专注切换（隐藏/恢复视频画面）。面板按钮与悬浮胶囊的「专」共用。 */
  function toggleFocus() {
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
  }

  function toggleClear() {
    st.clear = !st.clear
    applyClear()
    syncButtons()
  }

  /** 单曲循环开关（高清/单文件都支持）。与「列表连播」互斥。 */
  function toggleLoop() {
    st.loop = !st.loop
    if (st.loop) st.carousel = false // 互斥：开单曲循环就关列表连播
    if (video !== null) video.loop = !st.carousel && st.loop === true
    if (!st.loop) seekPlayPending = false
    setStatus(st.loop ? '单曲循环：开启（放完从头再播）' : '单曲循环：关闭', '')
    syncButtons()
    persist()
  }

  /** 列表连播开关：放完当前视频自动播列表下一支。与「单曲循环」互斥。 */
  function toggleCarousel() {
    st.carousel = !st.carousel
    if (st.carousel) st.loop = false // 互斥：开列表连播就关单曲循环
    if (video !== null) video.loop = !st.carousel && st.loop === true
    if (st.carousel && !st.queue.length) {
      loadQueue().then(function () {
        if (st.queue.length && st.current === null) playQueueIndex(0)
      })
    }
    setStatus(st.carousel ? '列表连播：开启（放完自动播列表下一支）' : '列表连播：关闭', '')
    syncButtons()
    persist()
  }

  /** 纯氛围静音墙纸模式：静音 + 悬浮胶囊收起，做无感后台播放。 */
  function applyWallpaper() {
    // 弹幕画布独立于墙纸；这里只管音量与胶囊。
    if (video !== null) {
      try {
        // 墙纸模式下锁定静音；非墙纸时按用户 mute 偏好。
        video.muted = st.wallpaper ? true : st.muted === true
      } catch (e) {
        /* ignore */
      }
    }
  }
  function toggleWallpaper() {
    if (!st.wallpaper) {
      // 开启：先记住原始静音/展开状态，退出时还原（不只是单向设置）。
      st.wallpaperSaved = { muted: st.muted === true, expanded: st.expanded === true }
      st.wallpaper = true
      st.muted = true // 墙纸默认静音，免得突然出声
      if (video !== null) {
        try {
          video.muted = true
        } catch (e) {
          /* ignore */
        }
      }
      if (launch !== null) setExpanded(false) // 收起悬浮胶囊，减少打扰
      setStatus('纯氛围静音墙纸：已开启（静音后台播放）', 'ok')
    } else {
      // 关闭：还原开启前的静音与胶囊展开状态。
      var saved = st.wallpaperSaved
      st.wallpaper = false
      st.muted = saved && typeof saved.muted === 'boolean' ? saved.muted : st.muted
      if (video !== null) {
        try {
          video.muted = st.muted === true
        } catch (e) {
          /* ignore */
        }
      }
      var restoreExpanded = saved && typeof saved.expanded === 'boolean' ? saved.expanded : st.expanded
      if (launch !== null) setExpanded(restoreExpanded)
      st.wallpaperSaved = null
      setStatus('已退出纯氛围静音墙纸模式（已还原原静音/胶囊状态）', '')
    }
    applyWallpaper()
    syncButtons()
    persist()
  }

  /** 渲染分P选择器：只有多 P 视频才显示；单 P / 无分P时隐藏。 */
  function syncPages() {
    if (pageWrap === null) return
    var pages = st.current && Array.isArray(st.current.pages) && st.current.pages.length ? st.current.pages : []
    while (pageWrap.children && pageWrap.children.length) pageWrap.removeChild(pageWrap.children[0])
    if (pages.length <= 1) {
      pageWrap.setAttribute('hidden', '')
      st.pages = []
      return
    }
    st.pages = pages
    pageWrap.removeAttribute('hidden')
    var head = el('span', 'dsbili-rowhead-span', '分P')
    pageWrap.appendChild(head)
    for (var i = 0; i < pages.length; i += 1) {
      ;(function (pageIdx) {
        var p = pages[pageIdx]
        var label = String(pageIdx + 1)
        var btn = el('button', 'dsbili-btn dsbili-page-btn', label)
        btn.setAttribute('data-page', String(pageIdx + 1))
        btn.setAttribute('title', 'P' + (pageIdx + 1) + (p && p.part ? ' · ' + p.part : ''))
        btn.setAttribute('data-on', st.pid === pageIdx + 1 ? '1' : '0')
        btn.addEventListener('click', function () {
          if (st.current === null) return
          var pid = pageIdx + 1
          if (pid === st.pid) return
          st.pid = pid
          st.pendingSeek = 0 // 换 P = 换内容，从头播
          loadAndPlay(st.current.bvid || '', { pid: pid, hd: st.hd === true })
          syncPages()
          persist()
        })
        pageWrap.appendChild(btn)
      })(i)
    }
  }

  // ────────────────────────────── 弹幕渲染 ──────────────────────────────
  // 背景氛围用的滚动弹幕：canvas 浮层夹在 video 与蒙版之间，随 currentTime 出现、
  // 从右往左滚动。任何一步失败（无 canvas / 接口失败）都自动停掉，绝不影响播放。

  function dmResize() {
    if (dmCanvas === null) return
    try {
      // 弹幕画布贴合**视频实际显示区域**（完整=顶部一条，铺满=全屏），字号据此按比例算。
      var rect = null
      if (video !== null && typeof video.getBoundingClientRect === 'function') {
        var vr = video.getBoundingClientRect()
        var lr =
          layer !== null && typeof layer.getBoundingClientRect === 'function'
            ? layer.getBoundingClientRect()
            : { left: 0, top: 0 }
        if (vr && vr.width > 0 && vr.height > 0) {
          rect = { left: vr.left - (lr.left || 0), top: vr.top - (lr.top || 0), width: vr.width, height: vr.height }
        }
      }
      if (!rect) {
        var lw = layer ? layer.clientWidth : 0
        var lh = layer ? layer.clientHeight : 0
        rect = { left: 0, top: 0, width: lw || global.innerWidth || 0, height: lh || global.innerHeight || 0 }
      }
      if (dmCanvas.style) {
        dmCanvas.style.left = Math.round(rect.left) + 'px'
        dmCanvas.style.top = Math.round(rect.top) + 'px'
        dmCanvas.style.width = Math.round(rect.width) + 'px'
        dmCanvas.style.height = Math.round(rect.height) + 'px'
        dmCanvas.style.opacity = String(num(st.dmOpacity, 80, 10, 100) / 100)
      }
      var w = Math.max(1, Math.round(rect.width))
      var h = Math.max(1, Math.round(rect.height))
      if (dmCanvas.width !== w) dmCanvas.width = w
      if (dmCanvas.height !== h) dmCanvas.height = h
    } catch (e) {
      /* ignore */
    }
  }

  /** 基础字号：按视频显示高度比例（约 5%），并夹在 14~32px，再乘用户字号百分比。 */
  function dmFontPx(h) {
    var base = Math.max(14, Math.min(32, Math.round((Number(h) || 0) * 0.05)))
    return Math.max(10, Math.min(72, Math.round(base * (num(st.dmSize, 100, 50, 200) / 100))))
  }

  function applyDmOpacity() {
    if (dmCanvas !== null && dmCanvas.style) {
      try {
        dmCanvas.style.opacity = String(num(st.dmOpacity, 80, 10, 100) / 100)
      } catch (e) {
        /* ignore */
      }
    }
  }
  /** 把弹幕设置同步到控件（含恢复后回填）。 */
  function syncDmSettings() {
    if (dmSizeRange !== null) dmSizeRange.value = String(Math.round(st.dmSize))
    if (dmSizeVal !== null) dmSizeVal.textContent = Math.round(st.dmSize) + '%'
    if (dmOpacityRange !== null) dmOpacityRange.value = String(Math.round(st.dmOpacity))
    if (dmOpacityVal !== null) dmOpacityVal.textContent = Math.round(st.dmOpacity) + '%'
    if (dmAreaRange !== null) dmAreaRange.value = String(Math.round(st.dmArea))
    if (dmAreaVal !== null) dmAreaVal.textContent = Math.round(st.dmArea) + '%'
    for (var i = 0; i < dmSpeedBtns.length; i += 1) {
      var b = dmSpeedBtns[i]
      var v = Number(b.getAttribute('data-speed'))
      b.setAttribute('data-on', v === Math.round(st.dmSpeed) ? '1' : '0')
    }
    applyDmOpacity()
  }

  function dmColorOf(c) {
    var n = Number(c)
    if (!isFinite(n) || n <= 0) return '#ffffff'
    var s = n.toString(16)
    while (s.length < 6) s = '0' + s
    return '#' + s.slice(-6)
  }

  /** 拉取并装载某支视频（cid）的弹幕池。 */
  function startDanmaku(cid) {
    stopDanmaku()
    if (!ROUTES.dm) return
    if (!st.dm || !cid) return
    dmResize()
    fetchJson(ROUTES.dm + '?cid=' + encodeURIComponent(String(cid)), { cache: 'no-store' }).then(
      function (data) {
        if (!st.dm || dmCanvas === null) return
        if (!data || data.ok !== true) {
          setStatus((data && data.error) || '弹幕获取失败，已隐藏', 'error')
          return
        }
        dmList = Array.isArray(data.list) ? data.list : []
        dmIndex = 0
        dmActive = []
        dmLastTime = 0
        dmLaneSeed = 0
        if (dmList.length && dmRaf === null) startDmLoop()
      },
      noop,
    )
  }

  function stopDanmaku() {
    if (dmRaf !== null) {
      try {
        global.cancelAnimationFrame(dmRaf)
      } catch (e) {
        /* ignore */
      }
      dmRaf = null
    }
    dmActive = []
    dmList = null
    if (dmCtx !== null && dmCanvas !== null) {
      try {
        dmCtx.clearRect(0, 0, dmCanvas.width, dmCanvas.height)
      } catch (e) {
        /* ignore */
      }
    }
  }

  function dmAlive() {
    return st.dm === true && dmCanvas !== null && dmCtx !== null && dmList !== null && video !== null
  }

  function dmPlaybackActive() {
    if (video === null) return false
    try {
      // 必须「真的在播且有当前帧」：缓冲/暂停/seek 淡出时都不推进弹幕，
      // 否则切视频时视频还没出画面，弹幕先按 0s 滚起来 → 差好几秒。
      return video.paused !== true && video.readyState >= 2
    } catch (e) {
      return false
    }
  }

  /** 把播放索引对齐到某时刻（不生成弹幕），供暂停/缓冲期间 seek 后恢复同步。 */
  function dmIndexFor(t) {
    if (!dmList) return 0
    var i = 0
    while (i < dmList.length && dmList[i].t < t) i += 1
    return i
  }

  function startDmLoop() {
    if (dmRaf !== null) return
    var loop = function () {
      dmRaf = null
      if (!dmAlive()) return
      if (!dmPlaybackActive()) {
        // 视频未出画面（缓冲/暂停/换片）：清空并冻结，等真正开播再画。
        if (dmCtx !== null && dmCanvas !== null) {
          try {
            dmCtx.clearRect(0, 0, dmCanvas.width, dmCanvas.height)
          } catch (e) {
            /* ignore */
          }
        }
        dmActive = []
        dmLastFrame = 0
        var t = 0
        try {
          t = isFinite(video.currentTime) ? video.currentTime : 0
        } catch (e) {
          /* ignore */
        }
        // 暂停期间 seek 远了：重排索引，避免恢复播放时补一堆旧弹幕。
        if (Math.abs(t - dmLastTime) > 3) dmIndex = dmIndexFor(t)
        dmLastTime = t
      } else {
        tickDanmaku()
        renderDanmaku()
      }
      dmRaf = global.requestAnimationFrame(loop)
    }
    dmRaf = global.requestAnimationFrame(loop)
  }

  function tickDanmaku() {
    var now = 0
    try {
      now = isFinite(video.currentTime) ? video.currentTime : 0
    } catch (e) {
      return
    }
    // 前后大幅跳变（seek / 换P / 重启续播）时退回到当前时间重排，别一堆旧弹幕扎堆。
    if (Math.abs(now - dmLastTime) > 3) rewindDanmaku(now)
    else spawnDue(now)
    dmLastTime = now
  }

  function rewindDanmaku(now) {
    dmActive = []
    var i = 0
    while (i < dmList.length && dmList[i].t < now) i += 1
    dmIndex = i
    var budget = 0
    while (i < dmList.length && dmList[i].t <= now + 0.4 && budget < 8) {
      spawnDm(dmList[i])
      i += 1
      budget += 1
    }
    dmIndex = i
  }

  function spawnDue(now) {
    var n = 0
    while (dmIndex < dmList.length && dmList[dmIndex].t <= now + 0.15) {
      var d = dmList[dmIndex]
      dmIndex += 1
      if (d.t >= now - 0.15) {
        spawnDm(d)
        n += 1
        if (n > 24) break // 一帧别爆发太多
      }
    }
  }

  function spawnDm(d) {
    if (dmCanvas === null) return
    var w = dmCanvas.width
    var h = dmCanvas.height
    if (w <= 0 || h <= 0) return
    var text = String(d.text || '').trim()
    if (!text) return
    var color = dmColorOf(d.color)
    var fontSize = dmFontPx(h)
    // 显示区域：只在上方 dmArea% 的画面里排弹幕（B站「显示区域」同义）。
    var bandH = Math.max(fontSize + 10, h * (num(st.dmArea, 100, 25, 100) / 100))
    // 顶栏(5)/底栏(6)：固定位置停留一小段；普通滚动(1/4)从右往左匀速。
    if (d.mode === 5 || d.mode === 6) {
      var topY = d.mode === 5 ? fontSize + 6 : bandH - fontSize - 12
      dmActive.push({ fixed: true, x: 6, y: topY, text: text, color: color, size: fontSize, born: Date.now() })
      return
    }
    var laneCount = Math.max(1, Math.floor((bandH - 20) / (fontSize + 8)))
    var lane = (dmLaneSeed = (dmLaneSeed + 1) % laneCount)
    var speedFactor = num(st.dmSpeed, 100, 40, 250) / 100
    dmActive.push({
      x: w,
      y: 8 + lane * (fontSize + 8) + fontSize / 2,
      speed: Math.max(40, (w / 8) * speedFactor),
      text: text,
      color: color,
      size: fontSize,
    })
  }

  function renderDanmaku() {
    if (dmCtx === null || dmCanvas === null) return
    var w = dmCanvas.width
    var h = dmCanvas.height
    dmCtx.clearRect(0, 0, w, h)
    var now = Date.now()
    var dt = (now - (dmLastFrame || now)) / 1000
    dmLastFrame = now
    if (!(dt >= 0)) dt = 0
    if (dt > 0.05) dt = 0.05
    dmCtx.textBaseline = 'middle'
    dmCtx.shadowColor = 'rgba(0,0,0,0.75)'
    dmCtx.shadowBlur = 4
    var next = []
    for (var i = 0; i < dmActive.length; i += 1) {
      var d = dmActive[i]
      if (d.fixed) {
        if (now - d.born > 4000) continue
      } else {
        d.x -= d.speed * dt
        dmCtx.font = '600 ' + d.size + 'px sans-serif'
        var textW = dmCtx.measureText(d.text).width
        if (d.x + textW < 0) continue
      }
      dmCtx.font = '600 ' + d.size + 'px sans-serif'
      dmCtx.fillStyle = d.color
      dmCtx.fillText(d.text, d.fixed ? 6 : d.x, d.y)
      next.push(d)
    }
    dmActive = next
  }

  function toggleDanmaku() {
    st.dm = !st.dm
    if (st.dm) {
      var cid = st.current && st.current.cid ? st.current.cid : ''
      if (cid) startDanmaku(cid)
      else setStatus('弹幕已开启；加载视频后显示', 'ok')
    } else {
      stopDanmaku()
      setStatus('弹幕已关闭', '')
    }
    syncButtons()
    persist()
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
    miniFocusBtn = el('button', 'dsbili-mini-btn', '专')
    miniFocusBtn.id = 'dsbili-mini-focus'
    miniFocusBtn.setAttribute('title', '专注隐藏 / 恢复显示（隐藏视频画面继续工作）')
    miniFocusBtn.addEventListener('click', function (ev) {
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation()
      toggleFocus()
    })
    mini.appendChild(miniPlayBtn)
    mini.appendChild(miniNext)
    mini.appendChild(clearBtn)
    mini.appendChild(miniFocusBtn)
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

    // ── 标题栏拖动：把设置面板拖到任意位置（关闭按钮除外），位置会记住 ──
    var panelDrag = null
    head.addEventListener('pointerdown', function (ev) {
      if (ev && typeof ev.button === 'number' && ev.button !== 0) return
      var target = ev && ev.target
      if (target && typeof target.closest === 'function' && target.closest('.dsbili-close')) return
      var rect = typeof panel.getBoundingClientRect === 'function' ? panel.getBoundingClientRect() : { left: 0, top: 0 }
      panelDrag = { sx: ev ? ev.clientX : 0, sy: ev ? ev.clientY : 0, ox: rect.left, oy: rect.top, moved: false }
      try {
        if (head.setPointerCapture) head.setPointerCapture(ev.pointerId)
      } catch (e) {
        /* ignore */
      }
      if (panel) panel.setAttribute('data-dragging', '1')
    })
    head.addEventListener('pointermove', function (ev) {
      if (panelDrag === null || !ev) return
      var dx = ev.clientX - panelDrag.sx
      var dy = ev.clientY - panelDrag.sy
      if (!panelDrag.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) panelDrag.moved = true
      if (!panelDrag.moved) return
      var w = panel.offsetWidth || 300
      var h = panel.offsetHeight || 320
      var maxLeft = Math.max(0, (global.innerWidth || 0) - w)
      var maxTop = Math.max(0, (global.innerHeight || 0) - Math.min(h, 120))
      var left = Math.max(0, Math.min(maxLeft, panelDrag.ox + dx))
      var top = Math.max(0, Math.min(maxTop, panelDrag.oy + dy))
      panel.style.left = Math.round(left) + 'px'
      panel.style.top = Math.round(top) + 'px'
      panel.style.right = 'auto'
    })
    function endPanelDrag(ev) {
      if (panelDrag === null) return
      var moved = panelDrag.moved
      panelDrag = null
      try {
        if (head.releasePointerCapture && ev) head.releasePointerCapture(ev.pointerId)
      } catch (e) {
        /* ignore */
      }
      if (panel) panel.removeAttribute('data-dragging')
      if (moved) rememberPanelPos()
    }
    head.addEventListener('pointerup', endPanelDrag)
    head.addEventListener('pointercancel', endPanelDrag)

    // 顶部常驻区：账号 + 视频详情（不随标签页切换，始终可见）
    // 扫码登录浮层（绝对定位覆盖面板，不占顶部高度）
    qrOverlay = el('div', 'dsbili-qr-overlay')
    qrOverlay.id = 'dsbili-qr-overlay'
    panel.appendChild(qrOverlay)

    var topArea = el('div', 'dsbili-top')
    panel.appendChild(topArea)

    // ── 标签页：「播放 / 列表 / 下载 / 设置」（账号与视频详情常驻顶部，不占标签页） ──
    var TAB_DEFS = [
      { id: 'play', label: '播放' },
      { id: 'queue', label: '列表' },
      { id: 'download', label: '下载' },
      { id: 'settings', label: '设置' },
    ]
    var tabsBar = el('div', 'dsbili-tabs')
    tabsBar.setAttribute('role', 'tablist')
    var tabButtons = {}
    var panes = {}
    for (var ti = 0; ti < TAB_DEFS.length; ti += 1) {
      ;(function (def) {
        var btn = el('button', 'dsbili-tab', def.label)
        btn.setAttribute('data-tab', def.id)
        btn.setAttribute('role', 'tab')
        btn.addEventListener('click', function () {
          setTab(def.id)
        })
        tabsBar.appendChild(btn)
        tabButtons[def.id] = btn
      })(TAB_DEFS[ti])
    }
    panel.appendChild(tabsBar)

    var bodyEl = el('div', 'dsbili-body')
    panel.appendChild(bodyEl)
    for (var pi = 0; pi < TAB_DEFS.length; pi += 1) {
      var paneEl = el('div', 'dsbili-pane')
      paneEl.setAttribute('data-tab', TAB_DEFS[pi].id)
      bodyEl.appendChild(paneEl)
      panes[TAB_DEFS[pi].id] = paneEl
    }
    function pane(id) {
      return panes[id] || panes.play
    }

    // 底部固定区（状态 + 设置/说明）：不随标签页滚动，随时可见。
    var footWrap = el('div', 'dsbili-footer')
    panel.appendChild(footWrap)

    /** 切换标签页。 */
    function setTab(id) {
      var target = panes[id] ? id : 'play'
      st.tab = target
      for (var k in panes) {
        if (!Object.prototype.hasOwnProperty.call(panes, k)) continue
        var active = k === target ? '1' : '0'
        panes[k].setAttribute('data-active', active)
        if (tabButtons[k]) tabButtons[k].setAttribute('data-active', active)
      }
      syncButtons()
    }
    setTab(st.tab)
    panelSetTab = setTab

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
    pane('play').appendChild(inputRow)

    // 账号（常驻顶部，紧凑一行；二维码登录在浮层里展开，不撑高顶部）
    accountEl = el('div', 'dsbili-account')
    accountEl.id = 'dsbili-account'
    topArea.appendChild(accountEl)
    renderAccount()

    // 分隔线：把「账号」和「视频信息」明确分开（两者权重不同，不要挨成一片）
    topArea.appendChild(el('div', 'dsbili-top-sep'))

    // 当前视频详情（独立卡片，常驻顶部）：可点击，在系统浏览器打开该视频
    var now = el('div', 'dsbili-now dsbili-now-top')
    nowLabelEl = el('div', 'dsbili-now-label', '未播放')
    titleEl = el('div', 'dsbili-now-title', '未播放')
    metaEl = el('div', 'dsbili-now-meta', '输入 BV 号开始')
    now.appendChild(nowLabelEl)
    now.appendChild(titleEl)
    now.appendChild(metaEl)
    now.setAttribute('title', '点击在浏览器打开该视频')
    now.addEventListener('click', function () {
      openCurrentVideo()
    })
    topArea.appendChild(now)

    // 分P选择器：常驻视频信息下方（顶部区域，不随标签页滚动），多 P 视频展现。
    pageWrap = el('div', 'dsbili-pages')
    pageWrap.setAttribute('hidden', '')
    topArea.appendChild(pageWrap)

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
      st.seekTarget = target
      // 高清（MSE）：拖动过程中**不要**每次都做两轨对称 seek —— 一次拖动会触发几十个
      // input 事件，连续 flush/重填会互相打架，表现为拖动后莫名回退 720p 或状态错乱。
      // 这里只更新文案，松手（endSeek）时再一次性 seek。
      if (!(st.hdEffective && dashPlayer !== null)) {
        // 单文件：直接改 currentTime 很便宜，浏览器自己处理连续变化。
        try {
          video.currentTime = target
        } catch (e) {
          /* ignore */
        }
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
    function endSeek(force) {
      var wasDragging = st.progressDragging === true
      if (!wasDragging && force !== true) return
      st.progressDragging = false
      var target = st.seekTarget
      st.seekTarget = null
      if (target !== null && isFinite(target)) {
        if (st.hdEffective && dashPlayer !== null) {
          dashPlayer.seek(target)
        } else if (video !== null) {
          try {
            video.currentTime = target
          } catch (e) {
            /* ignore */
          }
        }
      }
      persist()
      // seek 是异步的：这里不立刻读 currentTime（可能还是旧值，会把滑块弹回去），
      // 交给 'seeked' 事件刷新；再留一个兜底刷新。
      global.setTimeout(updateProgressUi, 160)
    }
    progressRange.addEventListener('pointerup', function () {
      endSeek(false)
    })
    progressRange.addEventListener('pointercancel', function () {
      endSeek(true)
    })
    progressRange.addEventListener('change', function () {
      endSeek(true)
    })
    progRow.appendChild(progHead)
    progRow.appendChild(progressRange)
    pane('play').appendChild(progRow)

    // 登录后高清：开关 + 分轨清晰度（未登录/无分轨时降级展示，但开关仍在）。
    var hdRow = el('div', 'dsbili-row dsbili-hdrow')
    var hdHead = el('div', 'dsbili-rowhead')
    hdHead.appendChild(el('span', null, '高清（1080p+）'))
    hdStateEl = el('span', 'dsbili-valued dsbili-hd-state', '720p 单文件')
    hdHead.appendChild(hdStateEl)
    hdBtn = el('button', 'dsbili-btn dsbili-hd-btn', '⬆ 高清')
    hdBtn.id = 'dsbili-hd-btn'
    hdBtn.setAttribute('title', '登录后可解锁 1080p+ 高清（DASH+MSE）。正在播放时切换立即生效。')
    hdBtn.addEventListener('click', toggleHd)
    hdRow.appendChild(hdHead)
    hdRow.appendChild(hdBtn)
    qualityWrap = el('div', 'dsbili-hd-quality')
    pane('play').appendChild(hdRow)
    pane('play').appendChild(qualityWrap)

    // 弹幕开关（播放标签页，紧挨清晰度区域）。
    var dmRow = el('div', 'dsbili-btnrow')
    dmBtn = el('button', 'dsbili-btn', '💬 弹幕')
    dmBtn.id = 'dsbili-dm-btn'
    dmBtn.setAttribute('title', '在视频上渲染滚动弹幕（随播放进度滚动，可随时开关）')
    dmBtn.setAttribute('data-on', st.dm ? '1' : '0')
    dmBtn.addEventListener('click', toggleDanmaku)
    dmRow.appendChild(dmBtn)
    pane('play').appendChild(dmRow)
    syncQuality()

    // 下载当前视频：宿主有 download 路由才可用，否则按钮禁用（清晰回退）。
    var dlRow = el('div', 'dsbili-row dsbili-dlrow')
    var dlHead = el('div', 'dsbili-rowhead')
    dlHead.appendChild(el('span', null, '下载当前视频'))
    dlDirEl = el('span', 'dsbili-dl-dir', '')
    dlHead.appendChild(dlDirEl)
    dlBtn = el('button', 'dsbili-btn', '⬇ 下载当前')
    dlBtn.id = 'dsbili-dl-btn'
    dlBtn.addEventListener('click', startDownloadCurrent)
    dlStatusEl = el('div', 'dsbili-status dsbili-dl-status', '未开始')
    dlStatusEl.setAttribute('data-level', '')
    dlRow.appendChild(dlHead)
    dlRow.appendChild(dlBtn)
    dlRow.appendChild(dlStatusEl)
    pane('download').appendChild(dlRow)
    loadDownloadDir()

    // ffmpeg 状态 / 一键下载（只有宿主提供 ffmpeg 路由时才显示）
    if (ffmpegRoutes()) {
      var ffRow = el('div', 'dsbili-row dsbili-ffmpegrow')
      var ffHead = el('div', 'dsbili-rowhead')
      ffHead.appendChild(el('span', null, 'ffmpeg（高清合轨）'))
      ffRow.appendChild(ffHead)
      ffmpegBtn = el('button', 'dsbili-btn', '⬇ 下载 ffmpeg（约 30MB）')
      ffmpegBtn.id = 'dsbili-ffmpeg-btn'
      ffmpegBtn.addEventListener('click', toggleFfmpegInstall)
      ffmpegStatusEl = el('div', 'dsbili-status dsbili-ffmpeg-status', '检测中…')
      ffmpegStatusEl.setAttribute('data-level', '')
      ffRow.appendChild(ffmpegBtn)
      ffRow.appendChild(ffmpegStatusEl)
      pane('download').appendChild(ffRow)
      loadFfmpegStatus()
    }

    // 播放控制：暂停/上一支/下一支 —— 放到进度条**上面**
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
    pane('play').insertBefore(row1, progRow)

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
    pane('settings').appendChild(rowFit)

    // 专注隐藏 + 清屏（原来清屏只在悬浮胶囊上有）
    var focusRow = el('div', 'dsbili-btnrow')
    focusBtn = el('button', 'dsbili-btn', '🌙 专注隐藏')
    focusBtn.addEventListener('click', toggleFocus)
    focusRow.appendChild(focusBtn)
    settingsClearBtn = el('button', 'dsbili-btn', '清屏（隐藏中间内容）')
    settingsClearBtn.id = 'dsbili-settings-clear'
    settingsClearBtn.addEventListener('click', toggleClear)
    focusRow.appendChild(settingsClearBtn)
    wallpaperBtn = el('button', 'dsbili-btn', '🖼 静音墙纸')
    wallpaperBtn.id = 'dsbili-wallpaper-btn'
    wallpaperBtn.setAttribute('title', '纯氛围静音墙纸：静音 + 悬浮胶囊收起，做无感后台播放')
    wallpaperBtn.setAttribute('data-on', st.wallpaper ? '1' : '0')
    wallpaperBtn.addEventListener('click', toggleWallpaper)
    focusRow.appendChild(wallpaperBtn)
    pane('settings').appendChild(focusRow)

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
    pane('play').appendChild(rateRow)

    // 轮播/来源
    var row3 = el('div', 'dsbili-btnrow')
    carouselBtn = el('button', 'dsbili-btn', '🔁 列表连播')
    carouselBtn.setAttribute('title', '放完当前视频自动播列表下一支（与「单曲循环」互斥）')
    carouselBtn.addEventListener('click', toggleCarousel)
    var refreshBtn = el('button', 'dsbili-btn', '🔄 刷新列表')
    refreshBtn.setAttribute('title', '重新拉取当前来源（热门/排行榜/首页推荐）的列表')
    refreshBtn.addEventListener('click', function () {
      st.index = -1
      loadQueue()
      persist()
    })
    // 单曲循环：高清与单文件模式都支持（与「列表连播」互斥）。
    loopBtn = el('button', 'dsbili-btn', '🔂 单曲循环')
    loopBtn.id = 'dsbili-loop-btn'
    loopBtn.setAttribute('title', '当前视频放完从头再播（与「列表连播」互斥）')
    loopBtn.addEventListener('click', toggleLoop)
    row3.appendChild(carouselBtn)
    row3.appendChild(loopBtn)
    row3.appendChild(refreshBtn)

    var row4 = el('div', 'dsbili-btnrow')
    srcPopular = el('button', 'dsbili-btn', '热门')
    srcPopular.addEventListener('click', function () {
      st.source = 'popular'
      st.sourcePicked = true
      st.index = -1
      syncButtons()
      loadQueue()
      persist()
    })
    srcRanking = el('button', 'dsbili-btn', '排行榜')
    srcRanking.addEventListener('click', function () {
      st.source = 'ranking'
      st.sourcePicked = true
      st.index = -1
      syncButtons()
      loadQueue()
      persist()
    })
    srcFeed = el('button', 'dsbili-btn', '首页推荐')
    srcFeed.setAttribute('title', '登录后可用：账号首页推荐（需先扫码登录）')
    srcFeed.addEventListener('click', function () {
      if (!st.loggedIn) {
        setStatus('首页推荐需先登录（点“账号”→“二维码登录”）', 'error')
        return
      }
      st.source = 'feed'
      st.sourcePicked = true
      st.index = -1
      syncButtons()
      loadQueue()
      persist()
    })
    row4.appendChild(srcFeed)
    row4.appendChild(srcPopular)
    row4.appendChild(srcRanking)

    // 音量（和进度条一样是滑动条，紧挨着放在进度下面）；静音按钮只留喇叭图标，放本行右侧
    var volRow = el('div', 'dsbili-row')
    var volHead = el('div', 'dsbili-rowhead')
    volHead.appendChild(el('span', null, '音量'))
    muteBtn = el('button', 'dsbili-btn dsbili-mute-btn', '🔊')
    muteBtn.setAttribute('title', '静音 / 取消静音')
    muteBtn.addEventListener('click', toggleMute)
    volHead.appendChild(muteBtn)
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
    // 放在进度条下面、高清区前面（都是滑动条，聚在一起）
    pane('play').insertBefore(volRow, hdRow)

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
    pane('settings').appendChild(surfRow)

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
    pane('settings').appendChild(veilRow)

    // ── 弹幕外观（对齐 B 站播放器：字号 / 不透明度 / 速度 / 显示区域）──
    var dmSettingsHead = el('div', 'dsbili-rowhead')
    dmSettingsHead.appendChild(el('span', null, '弹幕设置'))
    var dmHint = el('span', 'dsbili-valued', '跟随画面比例')
    dmSettingsHead.appendChild(dmHint)
    pane('settings').appendChild(dmSettingsHead)

    var dmSizeRow = el('div', 'dsbili-row')
    var dmSizeHead = el('div', 'dsbili-rowhead')
    dmSizeHead.appendChild(el('span', null, '弹幕字号'))
    dmSizeVal = el('span', 'dsbili-valued', Math.round(st.dmSize) + '%')
    dmSizeHead.appendChild(dmSizeVal)
    dmSizeRange = el('input', 'dsbili-range')
    dmSizeRange.type = 'range'
    dmSizeRange.min = '50'
    dmSizeRange.max = '200'
    dmSizeRange.step = '5'
    dmSizeRange.value = String(Math.round(st.dmSize))
    dmSizeRange.addEventListener('input', function () {
      st.dmSize = num(Number(dmSizeRange.value), 100, 50, 200)
      if (dmSizeVal !== null) dmSizeVal.textContent = Math.round(st.dmSize) + '%'
      persist()
    })
    dmSizeRow.appendChild(dmSizeHead)
    dmSizeRow.appendChild(dmSizeRange)
    pane('settings').appendChild(dmSizeRow)

    var dmOpacityRow = el('div', 'dsbili-row')
    var dmOpacityHead = el('div', 'dsbili-rowhead')
    dmOpacityHead.appendChild(el('span', null, '弹幕不透明度'))
    dmOpacityVal = el('span', 'dsbili-valued', Math.round(st.dmOpacity) + '%')
    dmOpacityHead.appendChild(dmOpacityVal)
    dmOpacityRange = el('input', 'dsbili-range')
    dmOpacityRange.type = 'range'
    dmOpacityRange.min = '10'
    dmOpacityRange.max = '100'
    dmOpacityRange.value = String(Math.round(st.dmOpacity))
    dmOpacityRange.addEventListener('input', function () {
      st.dmOpacity = num(Number(dmOpacityRange.value), 80, 10, 100)
      if (dmOpacityVal !== null) dmOpacityVal.textContent = Math.round(st.dmOpacity) + '%'
      applyDmOpacity()
      persist()
    })
    dmOpacityRow.appendChild(dmOpacityHead)
    dmOpacityRow.appendChild(dmOpacityRange)
    pane('settings').appendChild(dmOpacityRow)

    var dmSpeedRow = el('div', 'dsbili-row')
    var dmSpeedHead = el('div', 'dsbili-rowhead')
    dmSpeedHead.appendChild(el('span', null, '弹幕速度'))
    var dmSpeedBtnsWrap = el('div', 'dsbili-btnrow')
    dmSpeedBtns = []
    var dmSpeedOptions = [
      { label: '慢', value: 60 },
      { label: '适中', value: 100 },
      { label: '快', value: 160 },
    ]
    for (var dsi = 0; dsi < dmSpeedOptions.length; dsi += 1) {
      ;(function (opt) {
        var b = el('button', 'dsbili-btn dsbili-dm-speed-btn', opt.label)
        b.setAttribute('data-speed', String(opt.value))
        b.addEventListener('click', function () {
          st.dmSpeed = opt.value
          syncDmSettings()
          persist()
        })
        dmSpeedBtnsWrap.appendChild(b)
        dmSpeedBtns.push(b)
      })(dmSpeedOptions[dsi])
    }
    dmSpeedRow.appendChild(dmSpeedHead)
    dmSpeedRow.appendChild(dmSpeedBtnsWrap)
    pane('settings').appendChild(dmSpeedRow)

    var dmAreaRow = el('div', 'dsbili-row')
    var dmAreaHead = el('div', 'dsbili-rowhead')
    dmAreaHead.appendChild(el('span', null, '显示区域'))
    dmAreaVal = el('span', 'dsbili-valued', Math.round(st.dmArea) + '%')
    dmAreaHead.appendChild(dmAreaVal)
    dmAreaRange = el('input', 'dsbili-range')
    dmAreaRange.type = 'range'
    dmAreaRange.min = '25'
    dmAreaRange.max = '100'
    dmAreaRange.value = String(Math.round(st.dmArea))
    dmAreaRange.addEventListener('input', function () {
      st.dmArea = num(Number(dmAreaRange.value), 100, 25, 100)
      if (dmAreaVal !== null) dmAreaVal.textContent = Math.round(st.dmArea) + '%'
      persist()
    })
    dmAreaRow.appendChild(dmAreaHead)
    dmAreaRow.appendChild(dmAreaRange)
    pane('settings').appendChild(dmAreaRow)
    syncDmSettings()

    // 轮播 / 来源切换：放在音量·界面不透明度·蒙版之后、列表之前 ——
    // 选完来源立刻在下方看到对应列表（用户反馈的布局顺序）。
    pane('queue').appendChild(row3)
    pane('queue').appendChild(row4)

    // 列表
    listEl = el('div', 'dsbili-list')
    renderList()
    pane('queue').appendChild(listEl)

    // 状态
    statusEl = el('div', 'dsbili-status')
    statusEl.setAttribute('data-level', '')
    footWrap.appendChild(statusEl)

    var foot = el('div', 'dsbili-foot')
    foot.appendChild(el('span', null, '登录 + 开高清 = 1080p+（DASH/MSE）；关闭即 720p'))
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
    footWrap.appendChild(foot)

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
    startEndWatchdog()
    // 拉一次登录态（只显示昵称/头像，绝不回显 Cookie）。
    refreshAuth()
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
    // 弹幕 canvas 跟随窗口尺寸。
    try {
      global.addEventListener('resize', function () {
        if (dmCanvas !== null) {
          dmResize()
          dmLastFrame = 0 // 避免 resize 后一帧按大 dt 跳
        }
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
      focus: toggleFocus,
      wallpaper: toggleWallpaper,
      danmaku: toggleDanmaku,
      loop: toggleLoop,
      carousel: toggleCarousel,
      // 供自动化/排障：手动跑一次「结尾看门狗」检测。
      endCheck: checkPlaybackEnd,
      // 供自动化/排障：统一走当前模式的 seek（高清 → MSE 播放器；否则 media element）
      seek: function (t) {
        var target = Number(t)
        if (!isFinite(target)) return
        if (dashPlayer !== null) dashPlayer.seek(target)
        else if (video !== null) {
          try {
            video.currentTime = target
          } catch (e) {
            /* ignore */
          }
        }
      },
      hd: toggleHd,
      ffmpeg: {
        refresh: loadFfmpegStatus,
        install: toggleFfmpegInstall,
      },
      open: openPanel,
      close: closePanel,
      openVideo: openCurrentVideo,
      tab: function (id) {
        if (panelSetTab) panelSetTab(id)
      },
      download: startDownloadCurrent,
      auth: {
        refresh: refreshAuth,
        startQr: startQrLogin,
        stopQr: stopQrLogin,
        logout: doLogout,
      },
      teardown: function () {
        stopDownloadPoll()
        stopFfmpegPoll()
        stopWarmSingleFile()
        stopDanmaku()
        if (endWatchTimer !== null) {
          try {
            global.clearInterval(endWatchTimer)
          } catch (e) {
            /* ignore */
          }
          endWatchTimer = null
        }
        destroyDash()
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
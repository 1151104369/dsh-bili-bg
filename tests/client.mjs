/**
 * 客户端运行时冒烟测试：用一个极简 DOM stub 执行 runtime/skin.js，
 * 验证 UI 能构建、全局 API 暴露、以及 play 路径不会抛异常。不依赖浏览器。
 *
 * 运行：node tests/client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const code = fs.readFileSync(path.join(here, '..', 'runtime', 'skin.js'), 'utf8')

function makeNode(tag) {
  const node = {
    tagName: tag,
    nodeType: 1,
    children: [],
    parentNode: null,
    className: '',
    id: '',
    value: '',
    type: '',
    placeholder: '',
    disabled: false,
    min: '',
    max: '',
    muted: false,
    paused: true,
    volume: 1,
    currentTime: 0,
    loop: false,
    src: '',
    playsInline: false,
    autoplay: false,
    preload: '',
    error: null,
    style: {
      _p: {},
      setProperty(k, v) {
        this._p[k] = v
      },
      removeProperty(k) {
        delete this._p[k]
      },
      getPropertyValue(k) {
        return this._p[k]
      },
    },
    _attrs: {},
    _listeners: {},
    setAttribute(k, v) {
      this._attrs[k] = String(v)
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null
    },
    removeAttribute(k) {
      delete this._attrs[k]
    },
    hasAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this._attrs, k)
    },
    appendChild(c) {
      c.parentNode = this
      this.children.push(c)
      return c
    },
    insertBefore(c, ref) {
      c.parentNode = this
      const i = this.children.indexOf(ref)
      if (i < 0) this.children.push(c)
      else this.children.splice(i, 0, c)
      return c
    },
    removeChild(c) {
      const i = this.children.indexOf(c)
      if (i >= 0) this.children.splice(i, 1)
      c.parentNode = null
      return c
    },
    addEventListener(type, fn) {
      this._listeners[type] = this._listeners[type] || []
      this._listeners[type].push(fn)
    },
    removeEventListener(type, fn) {
      const a = this._listeners[type]
      if (a) {
        const i = a.indexOf(fn)
        if (i >= 0) a.splice(i, 1)
      }
    },
    emit(type, ev) {
      const a = this._listeners[type]
      if (a) for (const fn of a.slice()) fn(ev || { type })
    },
    querySelectorAll() {
      return []
    },
    play() {
      this.paused = false
      return Promise.resolve()
    },
    pause() {
      this.paused = true
    },
  }
  Object.defineProperty(node, 'textContent', {
    // 模拟真实 DOM：给 textContent 赋值会清掉所有子节点。
    get() {
      return Object.prototype.hasOwnProperty.call(this, '_text') ? this._text : ''
    },
    set(v) {
      this._text = String(v === null || v === undefined ? '' : v)
      this.children = []
    },
  })
  return node
}

function makeDocument() {
  return {
    createElement(tag) {
      return makeNode(tag)
    },
    getElementById() {
      return null
    },
    documentElement: makeNode('html'),
    body: makeNode('body'),
    hidden: false,
  }
}

const document = makeDocument()
// 记录 POST /download 的 body，用来断言「按当前播放画质下载」请求字段。
const downloadBodies = []
const openedUrls = []
let ffmpegInstallCalls = 0
const openCalls = []

function stubFetch(url, opts) {
  const u = String(url)
  let payload = {}
  if (u.includes('/auth/status')) {
    payload = { ok: true, ...authState }
  } else if (u.includes('/auth/logout')) {
    authState = { loggedIn: false, account: null }
    payload = { ok: true, loggedIn: false }
  } else if (u.includes('/auth/qr')) {
    // 生成二维码（POST /auth/qr）；图片本身通过 <img> 加载，不经过 fetch。
    payload = { ok: true, key: 'k123', image: '/dsh-bili/auth/qr?key=k123' }
  } else if (u.includes('/auth/poll')) {
    payload = { ok: true, status: 'wait', message: '等待扫码' }
  } else if (u.includes('/ffmpeg/install')) {    ffmpegInstallCalls += 1
    payload =
      opts && opts.method === 'POST'
        ? { ok: true, state: 'downloading', received: 0, total: 100 }
        : { ok: true, state: 'downloading', received: 50, total: 100 }
  } else if (u.includes('/ffmpeg')) {
    payload = {
      ok: true,
      found: false,
      source: '',
      path: '',
      managedPath: 'C:/fake/ffmpeg.exe',
      downloadUrl: 'https://example.com/ffmpeg.gz',
      install: { state: 'idle', received: 0, total: 0 },
    }
  } else if (u.includes('/open')) {
    openCalls.push(u)
    payload = { ok: true, url: 'https://www.bilibili.com/video/' }
  } else if (u.includes('/downloads')) {
    payload = { ok: true, list: [], dir: '/Downloads/DSH-B站背景' }
  } else if (u.includes('/download')) {
    // 先按 /download（比 /downloads 靠后判断）——注意 /downloads 在其上方。
    if (opts && opts.method === 'POST') {
      try {
        downloadBodies.push(JSON.parse(String(opts.body || '{}')))
      } catch {
        downloadBodies.push({})
      }
      payload = {
        ok: true,
        id: 'dl_1_x',
        // 带字节数，供「大小 + 速度」显示断言（1.0 MB / 4.0 MB）
        task: { id: 'dl_1_x', status: 'downloading', received: 1048576, total: 4194304, path: '/Downloads/x.mp4' },
      }
    } else {
      // 第二轮轮询收到更大的 received，用来验证速度估算（约 1 MB/s）
      payload = {
        ok: true,
        task: { id: 'dl_1_x', status: 'downloading', received: 2097152, total: 4194304, path: '/Downloads/x.mp4' },
      }
    }
  } else if (u.includes('/state')) {
    if (opts && opts.method === 'POST') payload = { ok: true }
    else payload = { ok: true, state: {} }
  } else if (u.includes('/play')) {
    payload = { ok: true, bvid: 'BV1GJ411x7h7', title: '测试视频', src: '/dsh-bili/media?bvid=BV1GJ411x7h7&cid=1', duration: 100, quality: 64, owner: 'o' }
  } else if (u.includes('/queue')) {
    payload = { ok: true, list: [{ bvid: 'BV1', title: 'a' }, { bvid: 'BV2', title: 'b' }] }
  }
  return Promise.resolve({ json: () => Promise.resolve(payload) })
}
let authState = { loggedIn: false, account: null }

const window = {
  document,
  fetch: stubFetch,
  setTimeout,
  clearTimeout,
  MutationObserver: undefined,
    setInterval,
    clearInterval,
  console,
  location: { search: '' },
  navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0 Safari/537.36' },
  open: function (url) {
    openedUrls.push(String(url))
    return {}
  },
  __DSH_BILI_BG__: {
    version: '0.1.0',
    config: '/dsh-bili/config.json',
    play: '/dsh-bili/play',
    media: '/dsh-bili/media',
    queue: '/dsh-bili/queue',
    state: '/dsh-bili/state',
    auth: {
      create: '/dsh-bili/auth/qr',
      image: '/dsh-bili/auth/qr',
      poll: '/dsh-bili/auth/poll',
      status: '/dsh-bili/auth/status',
      logout: '/dsh-bili/auth/logout',
    },
    download: {
      create: '/dsh-bili/download',
      status: '/dsh-bili/download',
      list: '/dsh-bili/downloads',
    },
    ffmpeg: {
      status: '/dsh-bili/ffmpeg',
      install: '/dsh-bili/ffmpeg/install',
    },
    open: '/dsh-bili/open',
    defaults: { source: 'popular', count: 12, volume: 0.8, veil: 0.32, veillight: 0.3 },
  },
}
window.window = window
window.globalThis = window

const runner = new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'console', code + '\nreturn window.__DSH_BILI_BG_API__;')
runner(window, document, stubFetch, setTimeout, clearTimeout, console)

const api = window.__DSH_BILI_BG_API__
if (!api) {
  console.error('FAIL: client did not expose __DSH_BILI_BG_API__')
  process.exit(1)
}

// 触发一次播放（异步），确认不抛异常且设置 src
api.play('BV1GJ411x7h7')
await new Promise((r) => setTimeout(r, 50))

const video = findById(document.body, 'dsbili-video')
const panel = findById(document.body, 'dsbili-panel')
const launch = findById(document.body, 'dsbili-launch')

function findById(node, id) {
  if (!node) return null
  if (node.id === id) return node
  for (const c of node.children || []) {
    const hit = findById(c, id)
    if (hit) return hit
  }
  return null
}

function findByClass(node, cls) {
  if (!node) return null
  if (String(node.className || '').split(/\s+/).indexOf(cls) !== -1) return node
  for (const c of node.children || []) {
    const hit = findByClass(c, cls)
    if (hit) return hit
  }
  return null
}

function findByText(node, text) {
  if (!node) return null
  if (node.tagName === 'button' && node.textContent === text) return node
  for (const c of node.children || []) {
    const hit = findByText(c, text)
    if (hit) return hit
  }
  return null
}

function hasText(node, text) {
  if (!node) return false
  if (node.textContent === text) return true
  for (const c of node.children || []) if (hasText(c, text)) return true
  return false
}

function hasTextIncluding(node, sub) {
  if (!node) return false
  if (String(node.textContent || '').includes(sub)) return true
  for (const c of node.children || []) if (hasTextIncluding(c, sub)) return true
  return false
}

let pass = 0
function ok(name, cond) {
  if (cond) {
    pass += 1
    console.log('PASS', name)
  } else {
    console.error('FAIL', name)
    process.exitCode = 1
  }
}

ok('panel built', !!panel)
ok('panel header built (fixed bar with close)', !!findByClass(document.body, 'dsbili-head') && !!findByClass(document.body, 'dsbili-close'))
ok('launch built', !!launch)
ok('video created', !!video && video.src.includes('/dsh-bili/media'))

// 关键回归：透明变量必须写到 <body>（主题把 --dsw-alias-* 定义在 body 上），
// 否则禁用 dsh-video-skin 后视频会被不透明底色盖住。
const bodyVars = document.body && document.body.style && document.body.style._p ? document.body.style._p : {}
ok('body got --dsw-alias-bg-base', bodyVars['--dsw-alias-bg-base'] !== undefined)
ok('video fit=width by default', video.getAttribute('data-fit') === 'width')
const mini = findByClass(document.body, 'dsbili-mini')
ok('floating pill has expandable mini bar (5 buttons: ▶⏭清专⚙)', !!mini && (mini.children || []).length === 5)
const miniFocus = findById(document.body, 'dsbili-mini-focus')
ok('pill has focus quick button after clear', !!miniFocus && miniFocus.textContent === '专')
// 胶囊「专」与面板按钮共用 toggleFocus（stub 的事件监听是空实现，直接走 API 验证状态流转）
api.focus()
ok('focus state on after pill click', api.state.focusOff === true)
ok('mini focus button highlighted', miniFocus.getAttribute('data-on') === '1')
api.focus()
ok('focus toggles back off', api.state.focusOff === false && miniFocus.getAttribute('data-on') === '0')
const backdrop = findById(document.body, 'dsbili-backdrop')
ok('preserve-bg mode default', !!backdrop && backdrop.getAttribute('data-bg') === 'preserve')
const progress = findById(document.body, 'dsbili-progress')
ok('seekable progress bar built', !!progress && progress.type === 'range')

// 清屏模式：给 html 挂属性，CSS 只隐藏 centerCol
api.clear()
ok('clear mode sets html attr', document.documentElement.getAttribute('data-dsbili-clear') === 'on')
api.clear()
ok('clear mode off again', document.documentElement.getAttribute('data-dsbili-clear') === null)

// ── 队列列表渲染回归 ──
// 曾因面板 flex-shrink 把列表压扁导致"列表消失"；这里断言加载队列后列表条目确实渲染出来。
api.loadQueue()
await new Promise((r) => setTimeout(r, 60))
const listEl = findByClass(document.body, 'dsbili-list')
ok('queue list rendered', !!listEl && (listEl.children || []).length === 2)
ok('queue list rows have index+title', !!listEl && (listEl.children[0].children || []).length === 2)

// 面板结构回归：固定标题栏 + 顶部常驻（账号/视频详情）+ 标签页 + 可滚动内容 + 固定底部。
const scrollBody = findByClass(document.body, 'dsbili-body')
ok('panel has fixed header outside scroll body', !!scrollBody && !scrollBody.children.some((c) => c.className === 'dsbili-head'))
ok('panel has fixed tabs outside scroll body', !!findByClass(document.body, 'dsbili-tabs'))
const tabDefs = ['play', 'queue', 'download', 'settings']
const paneOf = (id) => (scrollBody ? scrollBody.children.find((c) => c.getAttribute && c.getAttribute('data-tab') === id) : null)
const tabCount = (scrollBody ? scrollBody.children.filter((c) => String(c.className || '').indexOf('dsbili-pane') !== -1) : []).length
ok('four tab panes built', tabCount === 4, tabCount)
ok('account tab removed', !paneOf('account'))
ok('default tab is play', api.state.tab === 'play' && paneOf('play').getAttribute('data-active') === '1', api.state.tab)

// 顶部常驻：账号 + 视频详情（不在标签页里）；视频详情可点击打开浏览器
const topArea = findByClass(document.body, 'dsbili-top')
ok('top area holds account + video detail', !!topArea && !!findById(topArea, 'dsbili-account') && !!findByClass(topArea, 'dsbili-now-top'))
// 账号与视频信息之间有分隔线 + 视频卡片有「正在播放」小标签（视觉上区分开）
ok('account and video detail visually separated', !!findByClass(topArea, 'dsbili-top-sep'))
const nowLabelEl = findByClass(document.body, 'dsbili-now-label')
ok('video detail card has playing label', !!nowLabelEl && String(nowLabelEl.textContent) === '正在播放', nowLabelEl && nowLabelEl.textContent)
const nowTop = findByClass(document.body, 'dsbili-now-top')
ok('video detail is clickable (title hint)', !!nowTop && String(nowTop.getAttribute('title')).includes('浏览器'))
openCalls.length = 0
openedUrls.length = 0
api.openVideo()
await new Promise((r) => setTimeout(r, 40))
ok('web mode opens via browser window.open (not host route)', openedUrls.length === 1 && openCalls.length === 0, openedUrls)
// 桌面壳(Electron UA)仍走宿主 /open 打开系统浏览器
window.navigator.userAgent = 'Mozilla/5.0 (Windows NT 10.0) Electron/28.0.0 Chrome/120 Safari/537.36'
openCalls.length = 0
openedUrls.length = 0
api.openVideo()
await new Promise((r) => setTimeout(r, 40))
ok('desktop(electron) opens via host open route', openCalls.length === 1 && openCalls[0].includes('/dsh-bili/open?bvid='), openCalls)
window.navigator.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0 Safari/537.36'

// 分类正确：音量在「播放」；界面不透明度/蒙版在「设置」；来源切换与列表在「列表」
const playPane = paneOf('play')
const settingsPane = paneOf('settings')
const queuePane = paneOf('queue')
ok('play pane has volume', !!playPane && hasText(playPane, '音量'))
ok('settings pane has opacity/veil', !!settingsPane && hasText(settingsPane, '界面不透明度') && hasText(settingsPane, '蒙版浓度'))
ok('queue pane has source switcher + list', !!queuePane && hasText(queuePane, '首页推荐'))
// 播放页顺序：控制按钮(暂停/上一支/下一支) 在进度条**上面**；音量滑动条在进度条下面
const playKids = playPane ? playPane.children : []
const idxControls = playKids.findIndex((c) => (c.children || []).some((x) => x.textContent === '⏭ 下一支'))
const idxProgress = playKids.findIndex((c) => (c.children || []).some((x) => x.id === 'dsbili-progress'))
const idxVolume = playKids.findIndex((c) => (c.children || []).some((x) => String(x.className || '').includes('dsbili-range') && hasText(c, '音量')))
ok('layout: play controls above progress', idxControls >= 0 && idxProgress > idxControls, { idxControls, idxProgress })
ok('layout: volume slider right below progress', idxVolume > idxProgress, { idxProgress, idxVolume })
// 静音按钮：只在音量行、只有图标
const muteBtnEl = findByClass(document.body, 'dsbili-mute-btn')
ok('mute button only shows icon', !!muteBtnEl && (muteBtnEl.textContent === '🔊' || muteBtnEl.textContent === '🔇'), muteBtnEl && muteBtnEl.textContent)
ok('mute button lives in volume row', !!muteBtnEl && !!idxVolume && hasText(playKids[idxVolume], '🔊'))
// 专注 + 清屏 在设置页；清屏按钮不再只在悬浮胶囊
ok('settings pane has focus toggle', !!settingsPane && hasTextIncluding(settingsPane, '专注隐藏'))
const settingsClear = findById(document.body, 'dsbili-settings-clear')
ok('settings pane has clear-screen button', !!settingsClear && hasTextIncluding(settingsPane, '清屏'), settingsClear && settingsClear.textContent)
// 来源切换紧邻列表（同一标签页内，来源在上、列表在下）
const queueKids = queuePane ? queuePane.children : []
const qIdxSource = queueKids.findIndex((c) => (c.children || []).some((x) => hasText(x, '首页推荐')))
const qIdxList = queueKids.findIndex((c) => String(c.className || '').split(/\s+/).indexOf('dsbili-list') !== -1)
ok('layout: source switcher right above list', qIdxSource >= 0 && qIdxList > qIdxSource, { qIdxSource, qIdxList })
// 切标签：只有目标页 active
api.tab('queue')
ok('tab switch marks only queue active', paneOf('queue').getAttribute('data-active') === '1' && paneOf('play').getAttribute('data-active') === '0')
ok('tab state remembered', api.state.tab === 'queue', api.state.tab)
api.tab('play')
ok('status lives in fixed footer', !!findByClass(document.body, 'dsbili-footer') && !!findByClass(document.body, 'dsbili-status'))
ok('panel draggable title (cursor move class present)', !!findByClass(document.body, 'dsbili-head'))

// ── 下载当前视频 ──
// 面板 body 里渲染了下载区块与按钮；当前已加载视频（api.play 已设置 st.current）时按钮可用。
const dlBtn = findById(document.body, 'dsbili-dl-btn')
const dlRow = findByClass(document.body, 'dsbili-dlrow')
ok('download section rendered in panel body', !!dlRow && !!dlBtn && dlRow !== null)
ok('download button enabled after current loaded', !!dlBtn && dlBtn.disabled === false)
// 面板应显示宿主解析出的保存目录（避免用户不知道文件去哪了）
const dlDirEl = findByClass(document.body, 'dsbili-dl-dir')
ok('download dir shown in panel', !!dlDirEl && String(dlDirEl.textContent).includes('DSH-B站背景'), dlDirEl && dlDirEl.textContent)

// ffmpeg：未检测到时显示「下载 ffmpeg」按钮 + 说明；点一下会发起安装请求。
const ffBtn = document.getElementById ? null : null
const ffBtnEl = findById(document.body, 'dsbili-ffmpeg-btn')
const ffStatusEl = findByClass(document.body, 'dsbili-ffmpeg-status')
ok('ffmpeg section built (no binary → download button)', !!ffBtnEl && String(ffBtnEl.textContent).includes('下载 ffmpeg'), ffBtnEl && ffBtnEl.textContent)
ok('ffmpeg status explains two-file fallback', !!ffStatusEl && String(ffStatusEl.textContent).includes('未检测到 ffmpeg'), ffStatusEl && ffStatusEl.textContent)
api.ffmpeg.install()
await new Promise((r) => setTimeout(r, 80))
ok('ffmpeg install request fired', ffmpegInstallCalls >= 1, ffmpegInstallCalls)

// 循环开关：默认开；点一下关、再点开；单文件模式 video.loop 跟随。
const loopBtnEl = findById(document.body, 'dsbili-loop-btn')
ok('loop toggle button built', !!loopBtnEl)
ok('loop on by default', api.state.loop === true && loopBtnEl.getAttribute('data-on') === '1', api.state.loop)
api.loop()
ok('loop off after toggle', api.state.loop === false && loopBtnEl.getAttribute('data-on') === '0', api.state.loop)
api.loop()
ok('loop on again', api.state.loop === true && loopBtnEl.getAttribute('data-on') === '1', api.state.loop)
// 列表连播 / 单曲循环互斥：开一个自动关另一个
api.carousel()
ok('carousel on turns loop off (mutually exclusive)', api.state.carousel === true && api.state.loop === false, {
  carousel: api.state.carousel,
  loop: api.state.loop,
})
api.loop()
ok('loop on turns carousel off (mutually exclusive)', api.state.loop === true && api.state.carousel === false, {
  loop: api.state.loop,
  carousel: api.state.carousel,
})
const carouselBtnEl = findByText(document.body, '🔁 列表连播')
ok('carousel button labelled 列表连播', !!carouselBtnEl)
ok('refresh button labelled 刷新列表', !!findByText(document.body, '🔄 刷新列表'))

// 下载状态行要显示「大小 / 总大小」（以及后续轮询的速度）。
api.download()
await new Promise((r) => setTimeout(r, 80))
const dlStatusEl = findByClass(document.body, 'dsbili-dl-status')
const dlText = dlStatusEl ? String(dlStatusEl.textContent) : ''
ok('download request carries quality mode=single', downloadBodies.length > 0 && downloadBodies[0].quality && downloadBodies[0].quality.mode === 'single', downloadBodies[0] && downloadBodies[0].quality)
ok('download status shows received/total size', dlText.includes('1.0 MB') && dlText.includes('4.0 MB'), dlText)
ok('download status shows percent when total known', dlText.includes('25%'), dlText)
// 第二次轮询（约 1s 后）received 增长 → 状态行应出现速度（KB/s 或 MB/s，取决于轮询间隔）
await new Promise((r) => setTimeout(r, 1400))
const dlText2 = dlStatusEl ? String(dlStatusEl.textContent) : ''
ok('download status shows speed', /(KB|MB)\/s/.test(dlText2), dlText2)
// 下载中按钮变成「取消」，再点即中途取消并恢复按钮
ok('download button becomes cancel while running', dlBtn.textContent === '✕ 取消下载', dlBtn.textContent)
api.download()
await new Promise((r) => setTimeout(r, 60))
const dlText3 = dlStatusEl ? String(dlStatusEl.textContent) : ''
ok('mid-download cancel acknowledged', dlText3.includes('已取消下载'), dlText3)
ok('download button restored after cancel', dlBtn.textContent === '⬇ 下载当前' && dlBtn.disabled === false)

// 未登录：默认来源应为「热门」
ok('default source popular when logged out', api.state.source === 'popular', api.state.source)

// ── 账号区 / 首页推荐 ──
const account = findById(document.body, 'dsbili-account')
ok('account area built', !!account)
ok('account shows QR login when logged out', !!findByClass(document.body, 'dsbili-account-login'))
// 未登录：左「未登录」+ 右「扫码登录」
const accState = findByClass(document.body, 'dsbili-account-state')
ok('logged-out shows 未登录 on the left', !!accState && String(accState.textContent) === '未登录', accState && accState.textContent)
ok('login button labelled 扫码登录', !!findByText(document.body, '扫码登录'))
ok('feed source button present', !!findByText(document.body, '首页推荐'))

// 来源按钮顺序：首页推荐 → 热门 → 排行榜
const sourceRow = (queuePane ? queuePane.children : []).find((c) => (c.children || []).some((x) => x.textContent === '首页推荐'))
if (sourceRow) {
  const order = sourceRow.children.map((b) => b.textContent)
  ok('source order: feed before popular', order.indexOf('首页推荐') < order.indexOf('热门'), order)
}

// 点“二维码登录”→ 显示二维码 + 状态
if (api.auth && api.auth.startQr) api.auth.startQr()
await new Promise((r) => setTimeout(r, 60))
const qrImg = findByClass(document.body, 'dsbili-qr-img')
ok('qr image shown after login click', !!qrImg && String(qrImg.src).includes('key=k123'))
ok('qr status text shown', !!findByClass(document.body, 'dsbili-qr-status'))
if (api.auth && api.auth.stopQr) api.auth.stopQr()

// 登录成功 → 头像 + 昵称 + 退出按钮；未登录按钮隐藏
authState = { loggedIn: true, account: { uname: '阿B测试', mid: 7, face: 'http://x/face.png' } }
if (api.auth && api.auth.refresh) api.auth.refresh()
await new Promise((r) => setTimeout(r, 40))
const accName = findByClass(document.body, 'dsbili-account-name')
ok('account shows nickname', !!accName && accName.textContent === '阿B测试')
ok('default source switches to feed when logged in', api.state.source === 'feed', api.state.source)
const accAvatar = findByClass(document.body, 'dsbili-account-avatar')
ok('account shows avatar', !!accAvatar && accAvatar.src === 'http://x/face.png')
ok('account hides login button when logged in', !findByClass(document.body, 'dsbili-account-login'))
ok('account shows logout button', !!findByClass(document.body, 'dsbili-account-logout'))
ok('logout button labelled 退出登录', !!findByText(document.body, '退出登录'))
ok('logged-in no 未登录 text', !findByClass(document.body, 'dsbili-account-state'))

// 退出 → 回到未登录视图
if (api.auth && api.auth.logout) api.auth.logout()
await new Promise((r) => setTimeout(r, 40))
ok('after logout shows login button again', !!findByClass(document.body, 'dsbili-account-login'))
ok('source falls back to popular after logout', api.state.source === 'popular', api.state.source)

// ── 重启续播：上次「暂停」退出，重启后也要把那个视频恢复回来（不能丢）──
const recoverDoc = makeDocument()
function recoverFetch(url, opts) {
  const u = String(url)
  let payload = {}
  if (u.includes('/auth/status')) payload = { ok: true, loggedIn: false, account: null }
  else if (u.includes('/state')) {
    payload =
      opts && opts.method === 'POST'
        ? { ok: true }
        : {
            ok: true,
            state: {
              bvid: 'BV1GJ411x7h7',
              title: '暂停的视频',
              time: 42,
              playing: false,
              // 专注模式（隐藏画面）也要跟着重启恢复
              focusOff: true,
              source: 'popular',
              sourcePicked: true,
              resume: true,
              // 音量也要跨重启恢复（曾出现重启后变最大音量）
              volume: 0.35,
            },
          }
  } else if (u.includes('/play')) {
    payload = {
      ok: true,
      bvid: 'BV1GJ411x7h7',
      title: '暂停的视频',
      src: '/dsh-bili/media?bvid=BV1GJ411x7h7&cid=1',
      duration: 100,
      quality: 64,
      owner: 'o',
    }
  } else if (u.includes('/queue')) payload = { ok: true, list: [] }
  return Promise.resolve({ json: () => Promise.resolve(payload) })
}
const recoverWin = {
  document: recoverDoc,
  fetch: recoverFetch,
  setTimeout,
  clearTimeout,
  MutationObserver: undefined,
    setInterval,
    clearInterval,
  console,
  location: { search: '' },
  __DSH_BILI_BG__: window.__DSH_BILI_BG__,
}
recoverWin.window = recoverWin
recoverWin.globalThis = recoverWin
const recoverRunner = new Function(
  'window',
  'document',
  'fetch',
  'setTimeout',
  'clearTimeout',
  'console',
  code + '\nreturn window.__DSH_BILI_BG_API__;',
)
const recoverApi = recoverRunner(recoverWin, recoverDoc, recoverFetch, setTimeout, clearTimeout, console)
await new Promise((r) => setTimeout(r, 220))
const recoverVideo = findById(recoverDoc.body, 'dsbili-video')
ok('restores last video after restart even when paused', !!recoverApi.state.current && recoverApi.state.current.bvid === 'BV1GJ411x7h7', recoverApi.state.current && recoverApi.state.current.bvid)
ok('restored video loads its src', !!recoverVideo && String(recoverVideo.src).includes('BV1GJ411x7h7'))
ok('restored video stays paused (not autoplayed)', !!recoverVideo && recoverVideo.paused === true && recoverApi.state.playing === false)
ok('restored volume applied to video element', !!recoverVideo && Math.abs(recoverVideo.volume - 0.35) < 0.001, recoverVideo && recoverVideo.volume)
ok('restored video records resume position', recoverApi.state.pendingSeek === null || recoverApi.state.pendingSeek === 42)
// 专注模式重启恢复：状态保持 + 背景层仍是隐藏的（data-idle=1），不会把画面亮出来
ok('focus mode restored after restart', recoverApi.state.focusOff === true)
const recoverBackdrop = findById(recoverDoc.body, 'dsbili-backdrop')
ok('focus mode keeps video hidden after restart', !!recoverBackdrop && recoverBackdrop.getAttribute('data-idle') === '1')
recoverApi.teardown() // 清掉结尾看门狗等定时器，避免测试进程不退出

// ── 登录后高清（DASH+MSE）：开关 + 分轨清晰度 + 回退路径 ──
{
  const hdDoc = makeDocument()
  // 伪造一个可用的 MSE 播放器：create 记下 tracks，加载后立刻 onStatus('ready')。
  const playerCalls = []
  function FakeDashPlayer(opts) {
    if (opts && typeof opts.onStatus === 'function') {
      // 异步触发 ready，模拟 MSE 就绪
      setTimeout(() => opts.onStatus('ready'), 10)
    }
    return {
      load() {
        playerCalls.push({ kind: 'load', tracks: opts && opts.tracks })
      },
      destroy() {
        playerCalls.push({ kind: 'destroy' })
      },
      seek(t) {
        playerCalls.push({ kind: 'seek', t })
      },
      play() {},
    }
  }
  const fakeDashLib = {
    version: '1.0.0',
    supported: () => true,
    create: (opts) => FakeDashPlayer(opts),
  }

  let hdAuth = { loggedIn: true, account: { uname: 'HD测试', mid: 8 } }
  // 模拟「服务端说拿不到高清」：hd=1 仍返回 hd:false + fallback + 可播单文件
  let hdServerFallback = false
  function hdFetch(url, opts) {
    const u = String(url)
    let payload = {}
    if (u.includes('/auth/status')) payload = { ok: true, ...hdAuth }
    else if (u.includes('/state')) {
      payload = opts && opts.method === 'POST' ? { ok: true } : { ok: true, state: {} }
    }
    else if (u.includes('/download') && opts && opts.method === 'POST') {
      try {
        downloadBodies.push(JSON.parse(String(opts.body || '{}')))
      } catch {
        downloadBodies.push({})
      }
      payload = { ok: true, id: 'dl_hd', task: { id: 'dl_hd', status: 'downloading', received: 0, total: 0, height: 1080, quality: 'hd' } }
    }
    // 高清请求：返回 DASH 分轨（照真实 B 站：每个清晰度有 avc1/hvc1/av01 三条 → 共 12 条）
    else if (u.includes('/play') && u.includes('hd=1')) {
      if (hdServerFallback) {
        payload = {
          ok: true,
          hd: false,
          fallback: '此时拿不到高清分轨，已回退 720p',
          bvid: 'BV1HDTEST',
          title: '高清测试',
          src: '/dsh-bili/media?bvid=BV1HDTEST&cid=1',
          duration: 200,
          quality: 64,
        }
      } else {
      const mk = (index, id, height, codecs) => ({
        index,
        id,
        height,
        codecs,
        mimeType: 'video/mp4',
        media: `/dsh-bili/media?bvid=BV1HDTEST&cid=1&kind=video&idx=${index}&qn=80`,
      })
      payload = {
        ok: true,
        hd: true,
        bvid: 'BV1HDTEST',
        title: '高清测试',
        duration: 200,
        height: 1080,
        quality: 80,
        format: 'dash',
        src: '/dsh-bili/media?bvid=BV1HDTEST&cid=1',
        mediaBase: 'http://127.0.0.1:55999',
        videoTracks: [
          mk(0, 80, 1080, 'avc1.640033'),
          mk(1, 80, 1080, 'hvc1.1.6.L150.90'),
          mk(2, 80, 1080, 'av01.0.08M.08'),
          mk(3, 64, 720, 'avc1.640033'),
          mk(4, 64, 720, 'hvc1.1.6.L120.90'),
          mk(5, 64, 720, 'av01.0.08M.08'),
          mk(6, 32, 480, 'avc1.640033'),
          mk(7, 32, 480, 'hvc1.1.6.L120.90'),
          mk(8, 32, 480, 'av01.0.08M.08'),
          mk(9, 16, 360, 'hvc1.1.6.L120.90'),
          mk(10, 16, 360, 'avc1.640033'),
          mk(11, 16, 360, 'av01.0.08M.08'),
        ],
        audioTracks: [
          { index: 0, id: 30232, codecs: 'mp4a.40.2', mimeType: 'audio/mp4', media: '/dsh-bili/media?bvid=BV1HDTEST&cid=1&kind=audio&idx=0&qn=80' },
          { index: 1, id: 30280, codecs: 'mp4a.40.2', mimeType: 'audio/mp4', media: '/dsh-bili/media?bvid=BV1HDTEST&cid=1&kind=audio&idx=1&qn=80' },
        ],
        dash: { defaultVideoIndex: 0, defaultAudioIndex: 0 },
      }
      }
    }
    // 单文件回退
    else if (u.includes('/play')) {
      payload = { ok: true, bvid: 'BV1HDTEST', title: '高清测试', src: '/dsh-bili/media?bvid=BV1HDTEST&cid=1', duration: 200, quality: 64 }
    }
    return Promise.resolve({ json: () => Promise.resolve(payload), headers: { get: () => '' } })
  }

  const hdWin = {
    document: hdDoc,
    fetch: hdFetch,
    setTimeout,
    clearTimeout,
    MutationObserver: undefined,
    setInterval,
    clearInterval,
    console,
    location: { search: '' },
    __DSH_BILI_BG__: window.__DSH_BILI_BG__,
    __DSH_BILI_DASH__: fakeDashLib,
  }
  hdWin.window = hdWin
  hdWin.globalThis = hdWin
  const hdRunner = new Function(
    'window',
    'document',
    'fetch',
    'setTimeout',
    'clearTimeout',
    'console',
    code + '\nreturn window.__DSH_BILI_BG_API__;',
  )
  const hdApi = hdRunner(hdWin, hdDoc, hdFetch, setTimeout, clearTimeout, console)
  await new Promise((r) => setTimeout(r, 80))

  const hdBtnEl = findById(hdDoc.body, 'dsbili-hd-btn')
  ok('hd toggle button built', !!hdBtnEl && hdBtnEl.textContent.indexOf('高清') !== -1)
  ok('hd off by default', hdApi.state.hd === false)
  // 先播一个单文件视频，再开高清（真实交互顺序：播放中切换画质）。
  hdApi.play('BV1HDTEST')
  await new Promise((r) => setTimeout(r, 60))
  ok('base play loaded a current video', !!hdApi.state.current && hdApi.state.current.bvid === 'BV1HDTEST')
  // 保位置：先定位到 42s，再开高清，应该从 42s 继续而不是回到 0。
  const hdBaseVideo = findById(hdDoc.body, 'dsbili-video')
  if (hdBaseVideo) hdBaseVideo.currentTime = 42
  // 打开高清 → 重新解析 hd=1 → startDash → MSE ready → hdEffective
  playerCalls.length = 0
  hdApi.hd()
  await new Promise((r) => setTimeout(r, 140))
  ok('hd enabled after toggle', hdApi.state.hd === true)
  ok('hd effective (MSE ready) after load', hdApi.state.hdEffective === true)
  ok('hd player created with two tracks', playerCalls.some((c) => c.kind === 'load' && c.tracks && c.tracks.video && c.tracks.audio))
  ok(
    'hd uses direct mediaBase for fetch',
    playerCalls.some(
      (c) => c.kind === 'load' && c.tracks && c.tracks.video.media.indexOf('http://127.0.0.1:55999') === 0,
    ),
    playerCalls.length ? playerCalls[0].tracks && playerCalls[0].tracks.video.media : '',
  )
  // 切高清保住进度：MSE ready 后应 seek 回到 42s
  ok('hd switch preserves playback position (seek 42)', playerCalls.some((c) => c.kind === 'seek' && Number(c.t) === 42), playerCalls)
  // 去重后的清晰度按钮：12 条原始分轨(4 高度 × 3 编码) → 4 个按钮，且默认选中 1080P(avc1 idx0)
  const btnsOfWrap = []
  ;(function collect(elNode) {
    if (!elNode) return
    if (String(elNode.className || '').indexOf('dsbili-hd-btn') !== -1 && elNode !== hdBtnEl) btnsOfWrap.push(elNode)
    for (const c of elNode.children || []) collect(c)
  })(hdDoc.body)
  ok('quality buttons deduped to one per height (4)', btnsOfWrap.length === 4, btnsOfWrap.map((b) => b.textContent))
  ok('deduped quality buttons ordered high→low', btnsOfWrap.map((b) => b.textContent).join(',') === '1080P,720P,480P,360P', btnsOfWrap.map((b) => b.textContent))
  ok('default quality is 1080P (idx 0)', btnsOfWrap[0] && btnsOfWrap[0].getAttribute('data-on') === '1', btnsOfWrap[0] && btnsOfWrap[0].getAttribute('data-on'))
  // 高清播放中下载 → 请求应带 mode=hd、当前高度与分轨索引（宿主据此下 1080p DASH）
  downloadBodies.length = 0
  hdApi.download()
  await new Promise((r) => setTimeout(r, 60))
  const hdDlBody = downloadBodies[0]
  ok(
    'download request carries current hd quality',
    !!hdDlBody &&
      hdDlBody.quality &&
      hdDlBody.quality.mode === 'hd' &&
      hdDlBody.quality.height === 1080 &&
      hdDlBody.quality.videoIndex === 0 &&
      hdDlBody.quality.qn === 80,
    hdDlBody && hdDlBody.quality,
  )
  // 关闭高清 → 立即回 720p 单文件，不白屏
  playerCalls.length = 0
  hdApi.hd()
  await new Promise((r) => setTimeout(r, 120))
  ok('hd off after toggle', hdApi.state.hd === false)
  const hdOffVideo = findById(hdDoc.body, 'dsbili-video')
  const offSrc = hdOffVideo ? String(hdOffVideo.src) : ''
  ok(
    'single-file src reattached after hd off (no blank)',
    !!hdOffVideo && offSrc.indexOf('kind=video') === -1 && offSrc.indexOf('/dsh-bili/media') !== -1,
    offSrc,
  )
  ok('dash player destroyed when hd off', playerCalls.some((c) => c.kind === 'destroy'))
  ok('hd no longer effective after off', hdApi.state.hdEffective === false)
  // MSE 不可用（__DSH_BILI_DASH__ 缺失，模拟不支持 MSE 的内核）→ 开高清也不白屏，落到 720p 单文件
  hdWin.__DSH_BILI_DASH__ = null
  hdApi.hd()
  await new Promise((r) => setTimeout(r, 160))
  const nomVideo = findById(hdDoc.body, 'dsbili-video')
  const nomSrc = nomVideo ? String(nomVideo.src) : ''
  ok(
    'hd without MSE falls back without blank (video + single-file src intact)',
    !!nomVideo && nomSrc.indexOf('/dsh-bili/media') !== -1 && nomSrc.indexOf('kind=video') === -1,
    nomSrc,
  )
  ok('hd without MSE reports effective=false', hdApi.state.hdEffective === false)
  // 回退后必须状态自洽：高清开关变回「关」，不能同时显示「高清已开」+「已回退 720p」。
  // 关键：回退只影响「当前视频」，**用户的高清偏好不能丢**（否则重启后高清自动变回非高清）
  ok('fallback keeps hd preference (persist across restart)', hdApi.state.hd === true, hdApi.state.hd)
  const hdStateEl = findByClass(hdDoc.body, 'dsbili-hd-state')
  ok('fallback label scoped to current video', !!hdStateEl && String(hdStateEl.textContent) === '本视频回退 720p', hdStateEl && hdStateEl.textContent)
  const hdBtnAfter = findById(hdDoc.body, 'dsbili-hd-btn')
  ok('fallback keeps hd toggle on (preference)', !!hdBtnAfter && hdBtnAfter.textContent.indexOf('已开') !== -1, hdBtnAfter && hdBtnAfter.textContent)
  // 服务端明确回退（hd:false + fallback）时同样只影响当前视频，偏好保留。
  // 此时 st.hd 偏好仍为 true（上一步回退没有关掉它），直接重新播放即可走到服务端回退分支。
  hdServerFallback = true
  hdApi.play('BV1HDTEST')
  await new Promise((r) => setTimeout(r, 120))
  ok('server-side fallback keeps hd preference', hdApi.state.hd === true, hdApi.state.hd)
  const hdStateEl2 = findByClass(hdDoc.body, 'dsbili-hd-state')
  ok('server-side fallback label scoped to current video', !!hdStateEl2 && String(hdStateEl2.textContent) === '本视频回退 720p', hdStateEl2 && hdStateEl2.textContent)
  ok('server-side fallback keeps a playable single-file src', (() => {
    const v = findById(hdDoc.body, 'dsbili-video')
    const s = v ? String(v.src) : ''
    return !!v && s.indexOf('/dsh-bili/media') !== -1 && s.indexOf('kind=video') === -1
  })())
  hdServerFallback = false
  hdWin.__DSH_BILI_DASH__ = fakeDashLib

  // 高清 + 专注模式回归：与单文件路径一致——开启专注后重载高清，背景层必须保持隐藏
  //（data-idle=1），不能因为 startDash() 里无条件 showLayer() 又把画面亮出来
  //（这正是「高清下专注状态重启后记不住」的根因）。
  hdApi.focus()
  ok('hd focus toggled on', hdApi.state.focusOff === true)
  playerCalls.length = 0
  hdApi.play('BV1HDTEST')
  await new Promise((r) => setTimeout(r, 160))
  ok('hd re-enables MSE while focused', hdApi.state.hdEffective === true, hdApi.state.hdEffective)
  const hdFocusBackdrop = findById(hdDoc.body, 'dsbili-backdrop')
  ok(
    'hd + focus keeps backdrop hidden (data-idle=1)',
    !!hdFocusBackdrop && hdFocusBackdrop.getAttribute('data-idle') === '1',
    hdFocusBackdrop && hdFocusBackdrop.getAttribute('data-idle'),
  )
  ok(
    'hd + focus does not autoplay (paused while hidden)',
    (() => {
      const v = findById(hdDoc.body, 'dsbili-video')
      return !!v && v.paused !== false
    })(),
  )
  hdApi.focus()
  await new Promise((r) => setTimeout(r, 30))
  ok(
    'hd focus restore makes backdrop visible (data-idle=0)',
    (() => {
      const b = findById(hdDoc.body, 'dsbili-backdrop')
      return !!b && b.getAttribute('data-idle') === '0'
    })(),
  )
  hdApi.teardown()
}

// ── 计划第五项：分P / 纯氛围静音墙纸 / 弹幕（新功能冒烟） ──
{
  const doc = makeDocument()
  const playCalls = []
  const dmCalls = []
  const downBodies = []
  let lastState = null
  const updateCalls = []
  const openUrlCalls = []
  function featFetch(url, opts) {
    const u = String(url)
    const method = opts && opts.method
    let payload = {}
    if (u.includes('/auth/status')) payload = { ok: true, loggedIn: true, account: { uname: 'F', mid: 9 } }
    else if (u.includes('/state')) {
      if (method === 'POST') {
        try {
          lastState = JSON.parse(String(opts.body || '{}'))
        } catch {
          lastState = {}
        }
        payload = { ok: true }
      } else payload = { ok: true, state: {} }
    } else if (u.includes('/download') && method === 'POST') {
      try {
        downBodies.push(JSON.parse(String(opts.body || '{}')))
      } catch {
        downBodies.push({})
      }
      payload = { ok: true, id: 'dl_p', task: { id: 'dl_p', status: 'downloading', received: 0, total: 100, height: 1080 } }
    } else if (u.includes('/dm')) {
      dmCalls.push(u)
      payload = { ok: true, list: [{ t: 0, mode: 1, color: 16777215, text: '你好' }, { t: 2.5, mode: 5, color: 16711680, text: '顶弹幕' }] }
    } else if (u.includes('/update')) {
      updateCalls.push(u)
      payload = { ok: true, current: '0.10.4', latest: '0.11.0', hasUpdate: true, url: 'https://github.com/1151104369/dsh-bili-bg', checkedAt: Date.now(), commit: { sha: 'abc1234' } }
    } else if (u.includes('/open-url')) {
      openUrlCalls.push(u)
      payload = { ok: true, url: 'https://github.com/1151104369/dsh-bili-bg' }
    } else if (u.includes('/queue')) {
      payload = { ok: true, list: [{ bvid: 'BV1Q111', title: '队列一' }, { bvid: 'BV1Q222', title: '队列二' }] }
    } else if (u.includes('/play')) {
      playCalls.push(u)
      const p = /[?&]p=(\d+)/i.exec(u)
      const pid = p ? Number(p[1]) : 1
      const cid = pid >= 2 ? 9002 : 9001
      payload = {
        ok: true,
        bvid: 'BV1MP',
        title: '多P视频',
        cid,
        duration: 60,
        quality: 64,
        owner: 'o',
        pages: [
          { page: 1, cid: 9001, part: '第一P', duration: 30 },
          { page: 2, cid: 9002, part: '第二P', duration: 30 },
        ],
        src: '/dsh-bili/media?bvid=BV1MP&cid=' + cid,
      }
    }
    return Promise.resolve({ json: () => Promise.resolve(payload) })
  }
  const win = {
    document: doc,
    fetch: featFetch,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 1, // 测试环境不真正跑 RAF 循环，返回值非 0 即可
    cancelAnimationFrame: () => 0,
    MutationObserver: undefined,
    setInterval,
    clearInterval,
    console,
    location: { search: '' },
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/122.0 Safari/537.36' },
    open: function (url) {
      openedUrls.push(String(url))
      return {}
    },
    __DSH_BILI_BG__: {
      version: '0.9.0',
      config: '/dsh-bili/config.json',
      play: '/dsh-bili/play',
      media: '/dsh-bili/media',
      queue: '/dsh-bili/queue',
      state: '/dsh-bili/state',
      auth: { create: '/dsh-bili/auth/qr', image: '/dsh-bili/auth/qr', poll: '/dsh-bili/auth/poll', status: '/dsh-bili/auth/status', logout: '/dsh-bili/auth/logout' },
      download: { create: '/dsh-bili/download', status: '/dsh-bili/download', list: '/dsh-bili/downloads' },
      ffmpeg: { status: '/dsh-bili/ffmpeg', install: '/dsh-bili/ffmpeg/install' },
      open: '/dsh-bili/open',
      dm: '/dsh-bili/dm',
      openUrl: '/dsh-bili/open-url',
      update: '/dsh-bili/update',
      repo: { owner: '1151104369', name: 'dsh-bili-bg', url: 'https://github.com/1151104369/dsh-bili-bg' },
      defaults: { source: 'popular', count: 12, volume: 0.8, veil: 0.32, veillight: 0.3 },
    },
  }
  win.window = win
  win.globalThis = win
  const featRunner = new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'console', code + '\nreturn window.__DSH_BILI_BG_API__;')
  const feat = featRunner(win, doc, featFetch, setTimeout, clearTimeout, console)
  await new Promise((r) => setTimeout(r, 60))

  function collectByClass(root, cls) {
    const out = []
    ;(function walk(n) {
      if (!n) return
      if (String(n.className || '').indexOf(cls) !== -1) out.push(n)
      for (const c of n.children || []) walk(c)
    })(root)
    return out
  }
  function backdropOf() {
    return findById(doc.body, 'dsbili-backdrop')
  }

  // ① 分P：加载多 P 视频后显示选择器，play 请求携带 &p=
  feat.play('BV1MP')
  await new Promise((r) => setTimeout(r, 80))
  ok('multipage video loaded', !!feat.state.current && feat.state.current.bvid === 'BV1MP')
  ok('pid defaults to 1', feat.state.pid === 1)
  const pageBtns = collectByClass(doc.body, 'dsbili-page-btn')
  ok('renders 2 page buttons for multipage video', pageBtns.length === 2, pageBtns.length)
  ok('page 1 marked active by default', !!pageBtns[0] && pageBtns[0].getAttribute('data-on') === '1')
  ok('play request carries p=1', playCalls.some((u) => /[?&]p=1/.test(u)), playCalls[playCalls.length - 1])

  // ② 切到第二P：pid=2 + 重解析（换 cid），下载请求带 pid
  pageBtns[1].click && pageBtns[1].click()
  feat.state.pid = 2 // 模拟持久化后再开时从上次的 P 恢复
  await new Promise((r) => setTimeout(r, 80))
  feat.play('BV1MP')
  await new Promise((r) => setTimeout(r, 60))
  ok('switching page re-requests with p=2', playCalls.some((u) => /[?&]p=2/.test(u)), playCalls[playCalls.length - 1])
  ok('page 2 active after switch', (() => {
    const b = collectByClass(doc.body, 'dsbili-page-btn')
    return !!b[1] && b[1].getAttribute('data-on') === '1'
  })())
  feat.download()
  await new Promise((r) => setTimeout(r, 40))
  ok('download body carries current pid', !!downBodies[0] && downBodies[0].pid === 2, downBodies[0])

  // 列表连播：开启后，当前视频 ended 应自动切到队列下一支
  const vidEl = findById(doc.body, 'dsbili-video')
  feat.loadQueue()
  await new Promise((r) => setTimeout(r, 60))
  feat.carousel()
  ok('carousel enabled', feat.state.carousel === true)
  ok('carousel turns off native loop so ended can fire', !vidEl.loop)
  const beforeEnded = playCalls.length
  vidEl.emit('ended')
  await new Promise((r) => setTimeout(r, 160))
  ok(
    'carousel advances to next queue item on ended',
    playCalls.length > beforeEnded && /bvid=BV1Q111/.test(String(playCalls[playCalls.length - 1])),
    playCalls[playCalls.length - 1],
  )
  feat.carousel() // 关掉，后续测试不受影响

  // 结尾看门狗：MSE 不派发 ended 时，也能靠「贴近结尾」兜底收尾（高清循环/连播的关键）
  const wdVideo = findById(doc.body, 'dsbili-video')
  feat.carousel() // 再开连播
  wdVideo.duration = 100
  wdVideo.currentTime = 99.8
  wdVideo.paused = false
  feat.state.playing = true
  const beforeWd = playCalls.length
  feat.endCheck()
  await new Promise((r) => setTimeout(r, 160))
  ok(
    'end watchdog advances carousel when ended not dispatched',
    playCalls.length > beforeWd && /bvid=BV1Q222/.test(String(playCalls[playCalls.length - 1])),
    playCalls[playCalls.length - 1],
  )
  feat.carousel() // 关掉

  // ③ 纯氛围静音墙纸：开关 + 静音锁定
  ok('wallpaper off by default', feat.state.wallpaper === false)
  feat.wallpaper()
  ok('wallpaper toggled on', feat.state.wallpaper === true)
  ok('wallpaper forces muted', feat.state.muted === true)
  const vid = findById(doc.body, 'dsbili-video')
  ok('wallpaper mutes the video element', !!vid && vid.muted === true, vid && vid.muted)
  // 关闭墙纸要还原开启前的状态（不是单向）——静音应回到关闭前（默认未静音）
  feat.wallpaper()
  ok(
    'wallpaper off restores prior muted state',
    feat.state.wallpaper === false && feat.state.muted === false && !!vid && vid.muted === false,
    'wallpaper=' + feat.state.wallpaper + ' muted=' + feat.state.muted,
  )
  // ④ 弹幕：开启后按当前 cid 拉取
  ok('danmaku off by default', feat.state.dm === false)
  feat.danmaku()
  await new Promise((r) => setTimeout(r, 80))
  ok('danmaku toggled on', feat.state.dm === true)
  ok('danmaku fetched for current cid', dmCalls.some((u) => u.indexOf('cid=9002') !== -1), dmCalls)
  const dmCanvas = findById(doc.body, 'dsbili-danmaku')
  ok('danmaku canvas present in backdrop', !!dmCanvas && !!backdropOf())

  // ⑤ 分P/墙纸/弹幕都落盘
  feat.danmaku() // 关掉，避免后台轮询；同时触发 persist
  await new Promise((r) => setTimeout(r, 700)) // persist 有 500ms 去抖，等它真正 POST
  ok('state persists pid', !!lastState && lastState.pid === 2, lastState)
  ok('state persists wallpaper', !!lastState && lastState.wallpaper === false, lastState)

  // ── 插件信息：GitHub 主页跳转 + 检查更新 ──
  const githubBtnEl = findById(doc.body, 'dsbili-github-btn')
  ok('settings has github homepage button', !!githubBtnEl)
  const updateBtnEl = findById(doc.body, 'dsbili-update-btn')
  ok('settings has check-update button', !!updateBtnEl)
  const updateStatusNode = findByClass(doc.body, 'dsbili-update-status')
  ok('settings has update status line', !!updateStatusNode)

  if (githubBtnEl) {
    openedUrls.length = 0
    githubBtnEl.emit('click')
    ok(
      'github button opens repo homepage in browser',
      openedUrls.some((u) => u.indexOf('github.com/1151104369/dsh-bili-bg') !== -1),
      openedUrls[openedUrls.length - 1],
    )
  }
  if (updateBtnEl) {
    updateCalls.length = 0
    updateBtnEl.emit('click')
    await new Promise((r) => setTimeout(r, 60))
    ok('check-update hits host update route', updateCalls.length === 1, updateCalls)
    ok(
      'check-update shows new version available',
      !!updateStatusNode && String(updateStatusNode.textContent).indexOf('0.11.0') !== -1,
      updateStatusNode && updateStatusNode.textContent,
    )
    ok('check-update marks warn level for new version', !!updateStatusNode && updateStatusNode.getAttribute('data-level') === 'warn')
  }

  win.__DSH_BILI_BG_API__ && feat.teardown()
}
{
  const allBtns = []
  const allSelects = []
  ;(function walk(n) {
    if (!n) return
    if (String(n.tagName) === 'button') allBtns.push(n)
    if (String(n.tagName) === 'select') allSelects.push(n)
    for (const c of n.children || []) walk(c)
  })(document.body)
  ok('dance region button removed', !allBtns.find((b) => String(b.textContent) === '舞蹈区'))
  const danceUpBtn = allBtns.find((b) => String(b.textContent) === '宅舞区')
  ok('宅舞区 source button exists', !!danceUpBtn)
  if (danceUpBtn) {
    danceUpBtn.emit('click')
    ok('danceup source selected after click', api.state.source === 'danceup')
  }
  const sortSel = allSelects[0]
  ok('danceup sort dropdown exists', !!sortSel)
  ok('danceup sort defaults to latest (pubdate)', !!sortSel && sortSel.value === 'pubdate')
  if (sortSel) {
    sortSel.value = 'click'
    sortSel.emit('change')
    ok('danceup sort switch to most-played', api.state.danceupSort === 'click')
  }

  // Web 模式（非 Electron）：点信息卡片应在点击手势内同步用浏览器新标签打开，
  // 不能放到 fetch 回调里（会被弹窗拦截 → 表现为点了没反应）。
  if (api.openVideo && api.state.current && api.state.current.bvid) {
    openedUrls.length = 0
    api.openVideo()
    ok(
      'web mode opens video card in browser tab synchronously',
      openedUrls.some((u) => u.indexOf('/video/' + api.state.current.bvid) !== -1),
      openedUrls[openedUrls.length - 1],
    )
  }
}

// 清理主 runtime 的轮询定时器，否则下载轮询会让测试进程无法退出。
api.teardown()

console.log(`\n${pass} checks passed`)

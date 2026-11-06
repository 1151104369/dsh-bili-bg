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
    addEventListener() {},
    removeEventListener() {},
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
  } else if (u.includes('/downloads')) {
    payload = { ok: true, list: [], dir: '/Downloads/DSH-B站背景' }
  } else if (u.includes('/download')) {
    // 先按 /download（比 /downloads 靠后判断）——注意 /downloads 在其上方。
    if (opts && opts.method === 'POST') {
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
  console,
  location: { search: '' },
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

// 布局顺序回归：音量/界面不透明度/蒙版 在 轮播·来源 之上，来源切换紧邻列表（用户要求的顺序）。
// 面板是「固定标题栏 + 内部滚动 body」两段式，顺序类断言要看 body 的子项。
const scrollBody = findByClass(document.body, 'dsbili-body')
ok('panel has fixed header outside scroll body', !!scrollBody && !scrollBody.children.some((c) => c.className === 'dsbili-head'))
const bodyKids = scrollBody ? scrollBody.children : []
const idxOf = (pred) => bodyKids.findIndex(pred)
const idxVolume = idxOf((c) => hasText(c, '音量'))
const idxOpacity = idxOf((c) => hasText(c, '界面不透明度'))
const idxSource = idxOf((c) => (c.children || []).some((x) => hasText(x, '首页推荐')))
const idxList = idxOf((c) => String(c.className || '').split(/\s+/).indexOf('dsbili-list') !== -1)
ok('layout: volume/opacity rows above source switcher', idxVolume >= 0 && idxOpacity > idxVolume && idxSource > idxOpacity, {
  idxVolume,
  idxOpacity,
  idxSource,
})
ok('layout: source switcher right above list', idxSource >= 0 && idxList > idxSource, { idxSource, idxList })

// ── 下载当前视频 ──
// 面板 body 里渲染了下载区块与按钮；当前已加载视频（api.play 已设置 st.current）时按钮可用。
const dlBtn = findById(document.body, 'dsbili-dl-btn')
const dlRow = findByClass(document.body, 'dsbili-dlrow')
ok('download section rendered in panel body', !!dlRow && !!dlBtn && dlRow !== null)
ok('download button enabled after current loaded', !!dlBtn && dlBtn.disabled === false)
// 面板应显示宿主解析出的保存目录（避免用户不知道文件去哪了）
const dlDirEl = findByClass(document.body, 'dsbili-dl-dir')
ok('download dir shown in panel', !!dlDirEl && String(dlDirEl.textContent).includes('DSH-B站背景'), dlDirEl && dlDirEl.textContent)

// 下载状态行要显示「大小 / 总大小」（以及后续轮询的速度）。
api.download()
await new Promise((r) => setTimeout(r, 80))
const dlStatusEl = findByClass(document.body, 'dsbili-dl-status')
const dlText = dlStatusEl ? String(dlStatusEl.textContent) : ''
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
ok('feed source button present', !!findByText(document.body, '首页推荐'))

// 来源按钮顺序：首页推荐 → 热门 → 排行榜
const sourceRow = bodyKids.find((c) => (c.children || []).some((x) => x.textContent === '首页推荐'))
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
ok('restored video records resume position', recoverApi.state.pendingSeek === null || recoverApi.state.pendingSeek === 42)
// 专注模式重启恢复：状态保持 + 背景层仍是隐藏的（data-idle=1），不会把画面亮出来
ok('focus mode restored after restart', recoverApi.state.focusOff === true)
const recoverBackdrop = findById(recoverDoc.body, 'dsbili-backdrop')
ok('focus mode keeps video hidden after restart', !!recoverBackdrop && recoverBackdrop.getAttribute('data-idle') === '1')

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
  function hdFetch(url, opts) {
    const u = String(url)
    let payload = {}
    if (u.includes('/auth/status')) payload = { ok: true, ...hdAuth }
    else if (u.includes('/state')) {
      payload = opts && opts.method === 'POST' ? { ok: true } : { ok: true, state: {} }
    }
    // 高清请求：返回 DASH 分轨
    else if (u.includes('/play') && u.includes('hd=1')) {
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
          { index: 0, id: 80, height: 1080, codecs: 'avc1.640028', mimeType: 'video/mp4', media: '/dsh-bili/media?bvid=BV1HDTEST&cid=1&kind=video&idx=0&qn=80' },
          { index: 1, id: 64, height: 720, codecs: 'avc1.64001f', mimeType: 'video/mp4', media: '/dsh-bili/media?bvid=BV1HDTEST&cid=1&kind=video&idx=1&qn=80' },
        ],
        audioTracks: [
          { index: 0, id: 30280, codecs: 'mp4a.40.2', mimeType: 'audio/mp4', media: '/dsh-bili/media?bvid=BV1HDTEST&cid=1&kind=audio&idx=0&qn=80' },
        ],
        dash: { defaultVideoIndex: 0, defaultAudioIndex: 0 },
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
  // 分轨清晰度按钮已渲染（1080P 与 720P 两条）
  const btnsOfWrap = []
  ;(function collect(elNode) {
    if (!elNode) return
    if (String(elNode.className || '').indexOf('dsbili-hd-btn') !== -1 && elNode !== hdBtnEl) btnsOfWrap.push(elNode)
    for (const c of elNode.children || []) collect(c)
  })(hdDoc.body)
  ok('quality buttons rendered (1080P + 720P)', btnsOfWrap.length === 2, btnsOfWrap.length)
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
  hdWin.__DSH_BILI_DASH__ = fakeDashLib
  hdApi.teardown()
}

// 清理主 runtime 的轮询定时器，否则下载轮询会让测试进程无法退出。
api.teardown()

console.log(`\n${pass} checks passed`)

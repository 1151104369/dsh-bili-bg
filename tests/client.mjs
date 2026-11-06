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

const document = {
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
ok('launch built', !!launch)
ok('video created', !!video && video.src.includes('/dsh-bili/media'))

// 关键回归：透明变量必须写到 <body>（主题把 --dsw-alias-* 定义在 body 上），
// 否则禁用 dsh-video-skin 后视频会被不透明底色盖住。
const bodyVars = document.body && document.body.style && document.body.style._p ? document.body.style._p : {}
ok('body got --dsw-alias-bg-base', bodyVars['--dsw-alias-bg-base'] !== undefined)
ok('video fit=width by default', video.getAttribute('data-fit') === 'width')
const mini = findByClass(document.body, 'dsbili-mini')
ok('floating pill has expandable mini bar (4 buttons)', !!mini && (mini.children || []).length === 4)
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
const panelKids = panel.children || []
const idxOf = (pred) => panelKids.findIndex(pred)
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

// ── 账号区 / 首页推荐 ──
const account = findById(document.body, 'dsbili-account')
ok('account area built', !!account)
ok('account shows QR login when logged out', !!findByClass(document.body, 'dsbili-account-login'))
ok('feed source button present', !!findByText(document.body, '首页推荐'))

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
const accAvatar = findByClass(document.body, 'dsbili-account-avatar')
ok('account shows avatar', !!accAvatar && accAvatar.src === 'http://x/face.png')
ok('account hides login button when logged in', !findByClass(document.body, 'dsbili-account-login'))
ok('account shows logout button', !!findByClass(document.body, 'dsbili-account-logout'))

// 退出 → 回到未登录视图
if (api.auth && api.auth.logout) api.auth.logout()
await new Promise((r) => setTimeout(r, 40))
ok('after logout shows login button again', !!findByClass(document.body, 'dsbili-account-login'))

console.log(`\n${pass} checks passed`)

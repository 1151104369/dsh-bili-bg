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
    textContent: '',
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
  if (u.includes('/state')) {
    if (opts && opts.method === 'POST') payload = { ok: true }
    else payload = { ok: true, state: {} }
  } else if (u.includes('/play')) {
    payload = { ok: true, bvid: 'BV1GJ411x7h7', title: '测试视频', src: '/dsh-bili/media?bvid=BV1GJ411x7h7&cid=1', duration: 100, quality: 64, owner: 'o' }
  } else if (u.includes('/queue')) {
    payload = { ok: true, list: [{ bvid: 'BV1', title: 'a' }, { bvid: 'BV2', title: 'b' }] }
  }
  return Promise.resolve({ json: () => Promise.resolve(payload) })
}

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
console.log(`\n${pass} checks passed`)

/**
 * 冒烟测试：用假 ctx 驱动真实 index.js，把注册的路由挂到一个真 http 服务器上，
 * 再逐个请求验证（config / play / queue / state / media）。不依赖正在运行的 DSH。
 *
 * 运行：node tests/smoke.mjs
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsx from 'node:fs'
import assert from 'node:assert/strict'

// 用临时 DSH_HOME，避免冒烟测试覆盖用户真实的 dsh-bili-bg.json 状态。
const TMP_HOME = fsx.mkdtempSync(path.join(os.tmpdir(), 'dsh-bili-bg-test-'))
process.env.DSH_HOME = TMP_HOME

const { apply, VERSION } = await import('../index.js')

const routes = new Map()
const handlers = {}
let injectHandler = null

const fakeCtx = {
  logger: { info() {}, warn: (...a) => console.error('[warn]', ...a) },
  on(event, cb) {
    handlers[event] = cb
    if (event === 'webserver/index-inject') injectHandler = cb
  },
  inject(_deps, cb) {
    const child = {
      webServer: {
        port: 55999,
        protocol: 'http:',
        register({ path, handler }) {
          routes.set(path, handler)
          return () => routes.delete(path)
        },
      },
      effect(fn) {
        const disposer = fn()
        return () => {
          try {
            disposing && disposing()
          } catch {
            /* ignore */
          }
        }
        function disposing() {
          if (typeof disposer === 'function') disposer()
        }
      },
    }
    cb(child)
  },
}

apply(fakeCtx)

// ① 索引注入行
const rows = []
injectHandler(rows)
assert.equal(rows.length, 2, '应注入 2 行（style + script）')
assert.equal(rows[0].kind, 'style')
assert.equal(rows[1].kind, 'script')
assert.equal(rows[1].placement, 'body')
assert.ok(rows[1].text.includes('__DSH_BILI_BG__'), '脚本应包含 bootstrap 全局')
assert.ok(rows[0].text.includes('#dsbili-launch'), '样式应包含入口胶囊选择器')
assert.ok(rows[1].text.includes('dsbili-launch'), '脚本应创建入口胶囊')
assert.ok(rows[1].text.includes('Ctrl+Shift+B'), '脚本应带键盘入口')

// ② 起真服务器
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  const h = routes.get(u.pathname)
  if (!h) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('no route: ' + u.pathname)
    return
  }
  h(req, res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

let pass = 0
function ok(name, cond, extra) {
  if (cond) {
    pass += 1
    console.log('PASS', name, extra === undefined ? '' : JSON.stringify(extra))
  } else {
    console.error('FAIL', name, extra === undefined ? '' : JSON.stringify(extra))
    process.exitCode = 1
  }
}

// config
const cfg = await (await fetch(base + '/dsh-bili/config.json')).json()
ok('config', cfg.name === 'dsh-bili-bg' && cfg.version === VERSION, cfg)

// play
const play = await (await fetch(base + '/dsh-bili/play?bvid=BV1GJ411x7h7')).json()
ok('play', play.ok === true && play.bvid === 'BV1GJ411x7h7' && !!play.src, {
  bvid: play.bvid,
  title: play.title,
  quality: play.quality,
})
ok('play exposes direct mediaBase', play.mediaBase === 'http://127.0.0.1:55999', { base: play.mediaBase })

// play via full url
const playUrl = await (
  await fetch(base + '/dsh-bili/play?bvid=' + encodeURIComponent('https://www.bilibili.com/video/BV1GJ411x7h7/?x=1'))
).json()
ok('play-url-input', playUrl.ok === true && playUrl.bvid === 'BV1GJ411x7h7', { bvid: playUrl.bvid })

// play bad input
const bad = await (await fetch(base + '/dsh-bili/play?bvid=not-a-bv')).json()
ok('play-bad-input', bad.ok === false && typeof bad.error === 'string', bad.error)

// queue
const q = await (await fetch(base + '/dsh-bili/queue?source=popular&count=3')).json()
ok('queue', q.ok === true && Array.isArray(q.list) && q.list.length === 3, { n: q.list?.length })

// state
const stGet = await (await fetch(base + '/dsh-bili/state')).json()
ok('state-get', stGet.ok === true && typeof stGet.state === 'object', stGet.state)
const stPost = await (
  await fetch(base + '/dsh-bili/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'ranking', bvid: 'BV1GJ411x7h7' }),
  })
).json()
ok('state-post', stPost.ok === true && stPost.state.source === 'ranking', stPost.state)

// media with Range
const mediaRes = await fetch(base + '/dsh-bili/media?bvid=BV1GJ411x7h7&cid=137649199', {
  headers: { Range: 'bytes=0-2047' },
})
ok('media-range', mediaRes.status === 206 && !!mediaRes.headers.get('content-range'), {
  status: mediaRes.status,
  range: mediaRes.headers.get('content-range'),
})
try {
  await mediaRes.body?.cancel?.()
} catch {
  /* ignored */
}

console.log(`\n${pass} checks passed`)
server.close()
try {
  fsx.rmSync(TMP_HOME, { recursive: true, force: true })
} catch {
  /* ignore */
}

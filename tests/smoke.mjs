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
const { qrPng, qrMatrix } = await import('../lib/qr.js')
const { parsePoll } = await import('../lib/auth.js')

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

// ① config 应暴露 auth 路由供客户端使用
ok(
  'config exposes auth routes',
  !!(cfg.auth && cfg.auth.create && cfg.auth.image && cfg.auth.poll && cfg.auth.status && cfg.auth.logout),
  cfg.auth,
)

// ② poll 状态解析回归：新版接口状态在 data.code（顶层 code 恒为 0），绝不能误判为"登录成功"
const pollWait = parsePoll({ code: 0, message: 'OK', data: { url: '', refresh_token: '', timestamp: 0, code: 86101, message: '未扫码' } }, {})
ok('poll wait from data.code (new api)', pollWait.status === 'wait', pollWait.status)
ok('poll scanned', parsePoll({ code: 0, data: { code: 86090 } }, {}).status === 'scanned')
ok('poll expired', parsePoll({ code: 0, data: { code: 86038 } }, {}).status === 'expired')
ok('poll wait from top-level (old api)', parsePoll({ code: 86101, message: '未扫码' }, {}).status === 'wait')
const pollOk = parsePoll(
  { code: 0, data: { code: 0, url: 'https://x/', message: '' } },
  { 'set-cookie': ['SESSDATA=abc123; Path=/', 'bili_jct=def456; Path=/'] },
)
ok('poll ok status', pollOk.status === 'ok' && pollOk.url === 'https://x/')
ok('poll ok captures set-cookie', pollOk.setCookie.some((c) => c.name === 'SESSDATA' && c.value === 'abc123'), pollOk.setCookie)

// ② 未登录时“首页推荐”应优雅返回 needAuth（不发网络请求，不报错崩）
const feedOut = await (await fetch(base + '/dsh-bili/queue?source=feed&count=5')).json()
ok('feed needAuth when logged out', feedOut.ok === true && feedOut.needAuth === true && Array.isArray(feedOut.list), {
  needAuth: feedOut.needAuth,
  n: feedOut.list?.length,
})

// ③ 写入一个“假登录态”文件（离线），验证：能读出登录态、但绝不把 Cookie 回显给页面
const AUTH_FILE = path.join(TMP_HOME, 'dsh-bili-bg-auth.json')
fsx.writeFileSync(
  AUTH_FILE,
  JSON.stringify({
    savedAt: new Date().toISOString(),
    cookie: 'SESSDATA=topsecret-jct; bili_jct=topsecret-jct',
    nav: { isLogin: true, uname: '测试号', mid: 42, face: '' },
  }),
)
const authIn = await (await fetch(base + '/dsh-bili/auth/status')).json()
ok('auth-status reads login', authIn.ok === true && authIn.loggedIn === true && authIn.account?.uname === '测试号', authIn)
ok(
  'auth-status never exposes cookie',
  !JSON.stringify(authIn).includes('SESSDATA') && !JSON.stringify(authIn).includes('bili_jct'),
  authIn,
)

// ④ 退出登录：清本地文件后应回到未登录
const logoutRes = await (
  await fetch(base + '/dsh-bili/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
).json()
ok('auth logout ok', logoutRes.ok === true && logoutRes.loggedIn === false)
const authOut = await (await fetch(base + '/dsh-bili/auth/status')).json()
ok('auth-status after logout is logged out', authOut.ok === true && authOut.loggedIn === false, authOut)

// ⑤ QR 编码器离线单元：有效 PNG + 方阵边长为奇
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const qrImg = qrPng('https://passport.bilibili.com/h5/login?code=abc123&isSnsLogin=0&accountType=1')
ok('qr png signature', Buffer.compare(qrImg.subarray(0, 8), PNG_SIG) === 0, { len: qrImg.length })
const qrMat = qrMatrix('hello world qr')
ok(
  'qr matrix is square & odd',
  Array.isArray(qrMat) && qrMat.length > 0 && qrMat.length % 2 === 1 && qrMat.every((r) => Array.isArray(r) && r.length === qrMat.length),
  { n: qrMat && qrMat.length },
)

// ⑥ 二维码登录路由（生成 + PNG 渲染）端到端（需要外网，与既有 play/queue 用例同要求）
const qrGen = await (
  await fetch(base + '/dsh-bili/auth/qr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
).json()
ok('auth-qr generate', qrGen.ok === true && !!qrGen.key && !!qrGen.image, { hasKey: !!qrGen.key })
if (qrGen.ok && qrGen.key) {
  const imgRes = await fetch(base + qrGen.image)
  const imgBuf = Buffer.from(await imgRes.arrayBuffer())
  ok('auth-qr png route', imgRes.status === 200 && imgRes.headers.get('content-type') === 'image/png', {
    status: imgRes.status,
    type: imgRes.headers.get('content-type'),
    len: imgBuf.length,
  })
  ok('auth-qr png signature', Buffer.compare(imgBuf.subarray(0, 8), PNG_SIG) === 0)
}

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

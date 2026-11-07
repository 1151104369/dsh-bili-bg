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
// 下载相关：目录强制隔离到临时目录（别往用户真实的下载夹写东西）；禁用保存对话框（无头环境）。
process.env.DSH_BILI_DOWNLOAD_DIR = path.join(TMP_HOME, 'downloads')
process.env.DSH_BILI_NO_DIALOG = '1'

const { apply, VERSION } = await import('../index.js')
const { qrPng, qrMatrix } = await import('../lib/qr.js')
const { parsePoll, saveAuth } = await import('../lib/auth.js')
const { pickDashTracks, findFfmpeg } = await import('../lib/download.js')
const { extractTarEntry } = await import('../lib/ffmpeg.js')

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
// 阶段新增 MSE 播放器：style + dash.js + skin.js 三条。
assert.equal(rows.length, 3, '应注入 3 行（style + dash + skin）')
assert.equal(rows[0].kind, 'style')
assert.equal(rows[1].kind, 'script')
assert.equal(rows[1].placement, 'body')
assert.equal(rows[2].kind, 'script')
assert.equal(rows[2].placement, 'body')
assert.ok(rows[2].text.includes('__DSH_BILI_BG__'), 'skin 脚本应包含 bootstrap 全局')
assert.ok(rows[1].text.includes('__DSH_BILI_DASH__'), 'dash 脚本应暴露 MSE 播放器命名空间')
assert.ok(rows[0].text.includes('#dsbili-launch'), '样式应包含入口胶囊选择器')
// 回归：面板是 flex column + max-height，必须禁止子项收缩，否则内容超长时队列列表被压扁"消失"。
assert.ok(
  rows[0].text.includes('#dsbili-panel > *') && rows[0].text.includes('flex: 0 0 auto'),
  '样式应禁止面板子项 flex 收缩（防止列表被压扁消失）',
)
// 回归：面板采用「固定标题栏 + 内部滚动 body」两段式（不是 sticky 悬浮）。
assert.ok(
  rows[0].text.includes('.dsbili-body') &&
    rows[0].text.includes('#dsbili-panel > .dsbili-body') &&
    rows[0].text.includes('#dsbili-panel') &&
    !rows[0].text.includes('position: sticky'),
  '样式应为固定标题栏 + 内部滚动 body（标题栏不随内容滚动）',
)
assert.ok(rows[2].text.includes('dsbili-launch'), '皮肤脚本应创建入口胶囊')
assert.ok(rows[2].text.includes('Ctrl+Shift+B'), '皮肤脚本应带键盘入口')
// 面板标签页 + 标题栏拖动：脚本/CSS 都要有对应实现
assert.ok(rows[2].text.includes('dsbili-tab') && rows[2].text.includes('setTab'), '皮肤脚本应实现标签页切换')
assert.ok(rows[2].text.includes('pointermove') && rows[2].text.includes('rememberPanelPos'), '皮肤脚本应实现面板标题栏拖动')
assert.ok(rows[0].text.includes('.dsbili-tabs') && rows[0].text.includes('.dsbili-pane'), '样式应包含标签栏/面板样式')
assert.ok(rows[0].text.includes('cursor: move'), '标题栏应显示可拖动光标')

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

// 登录后高清：未登录请求 hd=1 → 应优雅回退 720p 单文件（hd:false + fallback + 有 src 可播，不报错）
const playHdNoLogin = await (
  await fetch(base + '/dsh-bili/play?bvid=BV1GJ411x7h7&hd=1&qn=80')
).json()
ok('play hd without login falls back gracefully', playHdNoLogin.ok === true, {
  ok: playHdNoLogin.ok,
  error: playHdNoLogin.error,
})
ok(
  'play hd fallback is single-file non-hd with playable src',
  playHdNoLogin.ok === true &&
    playHdNoLogin.hd === false &&
    !!playHdNoLogin.src &&
    String(playHdNoLogin.src).indexOf('/dsh-bili/media') === 0 &&
    typeof playHdNoLogin.fallback === 'string' &&
    playHdNoLogin.fallback.length > 0,
  { hd: playHdNoLogin.hd, fallback: playHdNoLogin.fallback, src: playHdNoLogin.src },
)

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

// ① config 应暴露 download 路由供客户端使用
ok(
  'config exposes download routes',
  !!(cfg.download && cfg.download.create && cfg.download.status && cfg.download.list),
  cfg.download,
)

// ② 下载：POST 缺/无效 bvid → 400 + ok:false（不发网络，保持离线/快速）
const dlBadEmpty = await (
  await fetch(base + '/dsh-bili/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
).json()
ok('download missing bvid returns 400', dlBadEmpty.ok === false && typeof dlBadEmpty.error === 'string', dlBadEmpty)
const dlBadBlank = await (
  await fetch(base + '/dsh-bili/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"bvid":"  "}' })
).json()
ok('download blank bvid returns 400', dlBadBlank.ok === false && typeof dlBadBlank.error === 'string', dlBadBlank)

// ③ 下载列表：ok:true，list 是数组，带 dir
const dlList = await (await fetch(base + '/dsh-bili/downloads')).json()
ok('downloads list ok', dlList.ok === true && Array.isArray(dlList.list) && typeof dlList.dir === 'string', {
  n: dlList.list?.length,
  dir: dlList.dir,
})

// ④ 下载状态：未知 id → 404 + ok:false
const dlUnknown = await (await fetch(base + '/dsh-bili/download?id=nope')).json()
ok('download unknown id returns 404', dlUnknown.ok === false && typeof dlUnknown.error === 'string', dlUnknown)

// ④' 按播放画质下载：pickDashTracks 选轨逻辑（离线纯函数）
{
  const dash = {
    video: [
      { height: 1080, codecs: 'hvc1.1.6', bandwidth: 2000, baseUrl: 'v1080hvc' },
      { height: 1080, codecs: 'avc1.640033', bandwidth: 2800, baseUrl: 'v1080avc' },
      { height: 720, codecs: 'avc1.64001f', bandwidth: 1200, baseUrl: 'v720avc' },
      { height: 480, codecs: 'avc1.64001e', bandwidth: 600, baseUrl: 'v480avc' },
    ],
    audio: [
      { bandwidth: 64000, codecs: 'mp4a.40.2', baseUrl: 'a64' },
      { bandwidth: 128000, codecs: 'mp4a.40.2', baseUrl: 'a128' },
    ],
  }
  const byIndex = pickDashTracks(dash, { videoIndex: 2, audioIndex: 0 })
  ok('pickDashTracks honours videoIndex/audioIndex', byIndex && byIndex.video.height === 720 && byIndex.audio.baseUrl === 'a64', byIndex && { v: byIndex.video.height, a: byIndex.audio.baseUrl })
  const byHeight = pickDashTracks(dash, { height: 1080 })
  ok(
    'pickDashTracks by height prefers avc1 (compat)',
    byHeight && byHeight.video.height === 1080 && byHeight.video.baseUrl === 'v1080avc',
    byHeight && byHeight.video.baseUrl,
  )
  const defaultPick = pickDashTracks(dash, {})
  ok('pickDashTracks default picks highest ≤1080', defaultPick && defaultPick.video.height === 1080)
  ok('pickDashTracks default audio is best bandwidth', defaultPick && defaultPick.audio.baseUrl === 'a128')
  ok('pickDashTracks null on empty dash', pickDashTracks({ video: [], audio: [] }, {}) === null)
  // findFfmpeg：DSH_BILI_FFMPEG 显式指定的路径应被采用
  const fakeFf = path.join(TMP_HOME, 'ffmpeg-fake.exe')
  fsx.writeFileSync(fakeFf, '')
  process.env.DSH_BILI_FFMPEG = fakeFf
  ok('findFfmpeg honours DSH_BILI_FFMPEG', findFfmpeg(TMP_HOME) === fakeFf, findFfmpeg(TMP_HOME))
  delete process.env.DSH_BILI_FFMPEG
}

// ⑤ ffmpeg 一键下载：本地假 gz 源 + 跳过可执行校验，验证下载→解压→落盘→状态探测。
{
  const zlib = await import('node:zlib')
  const payload = Buffer.from('fake-ffmpeg-binary-'.repeat(200))
  const gz = zlib.gzipSync(payload)
  const fakeServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': gz.length })
    res.end(gz)
  })
  await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r))
  const fakeUrl = `http://127.0.0.1:${fakeServer.address().port}/ffmpeg.gz`
  process.env.DSH_BILI_FFMPEG_SKIP_VERIFY = '1'
  const started = await (
    await fetch(base + '/dsh-bili/ffmpeg/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: fakeUrl }),
    })
  ).json()
  ok('ffmpeg install starts', started.ok === true && ['downloading', 'verifying', 'done'].includes(started.state), started.state)
  let stFinal = started
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 100))
    stFinal = await (await fetch(base + '/dsh-bili/ffmpeg/install')).json()
    if (stFinal.state === 'done' || stFinal.state === 'error') break
  }
  ok('ffmpeg install reaches done', stFinal && stFinal.state === 'done', stFinal && stFinal.error)
  const managed = path.join(TMP_HOME, 'dsh-bili-bg-bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  ok(
    'ffmpeg managed file written with exact bytes',
    fsx.existsSync(managed) && Buffer.compare(fsx.readFileSync(managed), payload) === 0,
    fsx.existsSync(managed) ? fsx.statSync(managed).size : 'missing',
  )
  const stDetect = await (await fetch(base + '/dsh-bili/ffmpeg')).json()
  ok(
    'ffmpeg status detects managed binary',
    stDetect.ok === true && stDetect.found === true && stDetect.source === 'managed',
    { found: stDetect.found, source: stDetect.source },
  )
  delete process.env.DSH_BILI_FFMPEG_SKIP_VERIFY
  fakeServer.close()
}

// ⑤' 内置最小 tar 解析器（npm 平台包 .tgz 里取 ffmpeg.exe）：构造两个条目的 tar 验证。
{
  function tarHeader(name, size) {
    const h = Buffer.alloc(512)
    h.write(name, 0, 'utf8')
    h.write('0000644\0', 100)
    h.write('0000000\0', 108)
    h.write('0000000\0', 116)
    h.write(String(size.toString(8)).padStart(11, '0') + '\0', 124)
    h.write('00000000000\0', 136)
    h.write('0', 156)
    return h
  }
  function tarEntry(name, content) {
    const data = Buffer.from(content)
    const pad = Buffer.alloc((512 - (data.length % 512)) % 512)
    return Buffer.concat([tarHeader(name, data.length), data, pad])
  }
  const tar = Buffer.concat([
    tarEntry('package/README.txt', 'hello'),
    tarEntry('package/ffmpeg.exe', 'FAKE-EXE-BYTES'),
    Buffer.alloc(1024),
  ])
  const got = extractTarEntry(tar, 'package/ffmpeg.exe')
  ok('extractTarEntry finds nested file', !!got && got.toString() === 'FAKE-EXE-BYTES', got && got.toString())
  ok('extractTarEntry ignores other entries', extractTarEntry(tar, 'package/nope') === null)
  ok('extractTarEntry handles ./ prefix', !!extractTarEntry(tar, './package/ffmpeg.exe'))
}

// ⑤ 中途取消（真实下载一支热门里最短的视频，立刻取消）：
//    DELETE → status 变 cancelled；.part 半成品与正式文件都不应残留。
const qCancel = await (await fetch(base + '/dsh-bili/queue?source=popular&count=20')).json()
const shortestCancel = (qCancel.list || []).slice().sort((a, b) => (a.duration || 0) - (b.duration || 0))[0]
if (shortestCancel && shortestCancel.bvid) {
  const start = await (
    await fetch(base + '/dsh-bili/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bvid: shortestCancel.bvid }),
    })
  ).json()
  if (start.ok === true && start.id) {
    const del = await (await fetch(base + '/dsh-bili/download?id=' + encodeURIComponent(start.id), { method: 'DELETE' })).json()
    ok('download cancel accepted', del.ok === true && del.task && (del.task.status === 'cancelled' || del.task.status === 'downloading'), del.task && del.task.status)
    let finalTask = del.task
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 500))
      const cur = await (await fetch(base + '/dsh-bili/download?id=' + encodeURIComponent(start.id))).json()
      if (cur.ok === true && cur.task) {
        finalTask = cur.task
        if (cur.task.status === 'cancelled' || cur.task.status === 'done' || cur.task.status === 'error') break
      }
    }
    ok('download cancel settles to cancelled', finalTask && finalTask.status === 'cancelled', finalTask && finalTask.status)
    const partGone = !fsx.existsSync(finalTask.path) && !fsx.existsSync(finalTask.path + '.part')
    ok('download cancel cleans up files', partGone, finalTask.path)
  } else {
    // 解析失败（如无外网）不算测试失败，只提示跳过。
    console.log('SKIP download-cancel e2e（无法发起真实下载）:', start.error || '')
  }
}
// 取消/结束后再 DELETE → 404
const dlUnknownDel = await (await fetch(base + '/dsh-bili/download?id=definitely-not-exist', { method: 'DELETE' })).json()
ok('download cancel unknown id returns 404', dlUnknownDel.ok === false, dlUnknownDel)

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

// ③ saveAuth 收紧权限后文件必须仍可读（Windows icacls 锁死凭据文件的回归）
const RESTRICT_HOME = path.join(TMP_HOME, 'restrict-test')
saveAuth(RESTRICT_HOME, { savedAt: 'x', cookie: 'SESSDATA=unit-test; bili_jct=j', nav: null })
let restrictReadable = ''
try {
  restrictReadable = fsx.readFileSync(path.join(RESTRICT_HOME, 'dsh-bili-bg-auth.json'), 'utf8')
} catch {
  restrictReadable = ''
}
ok('auth file readable after restrict', restrictReadable.includes('SESSDATA=unit-test'))

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
// 媒体响应必须带 ACAO（MSE 从页面直连 127.0.0.1 跨源读 body）。
ok('media response exposes ACAO', mediaRes.headers.get('access-control-allow-origin') === '*', {
  acao: mediaRes.headers.get('access-control-allow-origin'),
})
try {
  await mediaRes.body?.cancel?.()
} catch {
  /* ignored */
}

// CORS 预检回归：MSE 从页面直连 127.0.0.1 拉 DASH 分轨时会先发 OPTIONS（带 Range 触发）。
// 处理器必须**立刻**答 204 + CORS 头；绝不能当成媒体 GET 去上游拉整条 m4s（会永久挂住，
// 浏览器 fetch 永不 resolve ⇒ 表现「提示高清播放中但画面永远不出来」）。
const preflight = await fetch(base + '/dsh-bili/media?bvid=BV1GJ411x7h7&cid=137649199&kind=video&idx=0&qn=80', {
  method: 'OPTIONS',
  headers: {
    Origin: 'dsh-app://x',
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'range',
  },
})
ok('media preflight returns 204', preflight.status === 204, { status: preflight.status })
ok(
  'media preflight allows CORS + Range',
  preflight.headers.get('access-control-allow-origin') === '*' &&
    String(preflight.headers.get('access-control-allow-headers') || '')
      .toLowerCase()
      .indexOf('range') !== -1 &&
    String(preflight.headers.get('access-control-allow-methods') || '').indexOf('GET') !== -1,
  {
    origin: preflight.headers.get('access-control-allow-origin'),
    headers: preflight.headers.get('access-control-allow-headers'),
    methods: preflight.headers.get('access-control-allow-methods'),
  },
)
ok('media preflight has empty body', (await preflight.text()).length === 0)
// 预检必须很快返回（衡量是否误走媒体代理导致挂住）；本地 204 应远低于 2s。
const pfStart = Date.now()
await fetch(base + '/dsh-bili/media?bvid=BV1GJ411x7h7&cid=137649199&kind=video&idx=0&qn=80', {
  method: 'OPTIONS',
  headers: { Origin: 'dsh-app://x', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' },
})
ok('media preflight is fast (not proxied)', Date.now() - pfStart < 2000, { ms: Date.now() - pfStart })
// 真实 GET 仍必须带 ACAO（否则跨源读 body 也会被拦）。注意：临时 home 没有登录 Cookie，
// DASH 分轨可能拿不到而回 502；这里只在成功 206 时校验响应头（CORS 头由统一头逻辑给出）。
const dashMedia = await fetch(base + '/dsh-bili/media?bvid=BV1GJ411x7h7&cid=137649199&kind=video&idx=0&qn=80', {
  headers: { Range: 'bytes=0-1023' },
})
if (dashMedia.status === 206) {
  ok('dash media GET exposes ACAO for MSE fetch', dashMedia.headers.get('access-control-allow-origin') === '*', {
    status: dashMedia.status,
    acao: dashMedia.headers.get('access-control-allow-origin'),
  })
} else {
  console.log('SKIP dash media GET ACAO（未登录/无分轨）:', dashMedia.status)
}
try {
  await dashMedia.body?.cancel?.()
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

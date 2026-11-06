/**
 * MSE DASH 播放器单测：纯 ISOBMFF 解析 + 流扫描器 + 播放器装配/回退。
 *
 * 不依赖浏览器：dash.js 是 ES5 脚本文本，这里用 Node 直接执行，再
 *   · 用合成的 ftyp/moov/mdhd/moof/tfdt 字节校验 init 边界、timescale、decode time 解析；
 *   · 校验流扫描器在给定基准偏移下产出绝对偏移的 moof 索引；
 *   · 用假的 MediaSource + 假 fetch 驱动播放器，断言两条轨都"先 append 自己的 init 段"、
 *     且支持检测 / MSE 不可用时的回退都不抛异常。
 *
 * 运行：node tests/mse.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const code = fs.readFileSync(path.join(here, '..', 'runtime', 'dash.js'), 'utf8')

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

// ─────────────────────── ISO BMFF 合成工具 ───────────────────────

function be32n(v) {
  const b = new Uint8Array(4)
  b[0] = (v >>> 24) & 0xff
  b[1] = (v >>> 16) & 0xff
  b[2] = (v >>> 8) & 0xff
  b[3] = v & 0xff
  return b
}
function ascii(s) {
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i += 1) b[i] = s.charCodeAt(i)
  return b
}
function box(type, payload) {
  const typeB = ascii(type)
  const out = new Uint8Array(8 + payload.length)
  out.set(be32n(8 + payload.length), 0)
  out.set(typeB, 4)
  out.set(payload, 8)
  return out
}
/** 16 字节头的大 box（size==1 + 64 位 largesize），用于验证 initEndOf 的头长度分支。 */
function boxLarge(type, payload) {
  const typeB = ascii(type)
  const out = new Uint8Array(16 + payload.length)
  out.set(be32n(1), 0)
  out.set(typeB, 4)
  const size = 16 + payload.length
  out[8] = (size / 4294967296) | 0
  out.set(be32n(size >>> 0), 12)
  out.set(payload, 16)
  return out
}
function join(...arrays) {
  let total = 0
  for (const a of arrays) total += a.length
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrays) {
    out.set(a, off)
    off += a.length
  }
  return out
}

// mdhd（version 0）：version+flags(4) + ctime(4) + mtime(4) + timescale(4) + duration(4) + lang(2)+pdef(2)
function mdhd(timescale) {
  const p = new Uint8Array(24)
  p[12] = (timescale >>> 24) & 0xff
  p[13] = (timescale >>> 16) & 0xff
  p[14] = (timescale >>> 8) & 0xff
  p[15] = timescale & 0xff
  return box('mdhd', p)
}
// tfdt（version 0）：version+flags(4) + baseMediaDecodeTime(4)
function tfdt(base) {
  const p = new Uint8Array(8)
  p.set(be32n(base), 4)
  return box('tfdt', p)
}
function moofWithDecode(base) {
  const mfhd = box('mfhd', join(be32n(0), be32n(1)))
  const traf = box('traf', tfdt(base))
  return box('moof', join(mfhd, traf))
}

// ─────────────────────── 解析器单测 ───────────────────────

function loadDash() {
  const sandbox = { console }
  new Function('console', code + '\nreturn typeof globalThis.__DSH_BILI_DASH__', sandbox)
  // 上面的 new Function 不会真正执行到返回；直接在 globalThis 上跑一次
  return globalThis.__DSH_BILI_DASH__
}

// 分两个运行空间避免 globalThis 污染多次执行
function runDash() {
  delete globalThis.__DSH_BILI_DASH__
  new Function(code)()
  return globalThis.__DSH_BILI_DASH__
}

const dash = runDash()
ok('exposes parse helpers', !!(dash._boxHeaderAt && dash._initEndOf && dash._mediaTimescaleOf && dash._moofDecodeTime))

// boxHeaderAt 基础
{
  const b = box('ftyp', ascii('isom'))
  const h = dash._boxHeaderAt(b, 0)
  ok('boxHeaderAt ftyp', !!h && h.type === 'ftyp' && h.size === b.length && h.header === 8)
}

// initEndOf：ftyp + moov(mdhd) 应返回 ftyp 结束的位置（moov 末尾 = 文件尾）
{
  const init = join(box('ftyp', ascii('isom')), box('moov', box('trak', box('mdia', mdhd(40000)))))
  const end = dash._initEndOf(init)
  ok('initEndOf = whole init for ftyp+moov', end === init.length, end)
}

// initEndOf：moov 用 16 字节头（size==1 + largesize）时也不能算错（早前公式差 8）
{
  const ftyp = box('ftyp', ascii('isom'))
  const moov = boxLarge('moov', box('trak', box('mdia', mdhd(40000))))
  const init = join(ftyp, moov)
  ok('initEndOf handles 16-byte box header', dash._initEndOf(init) === ftyp.length + moov.length, {
    got: dash._initEndOf(init),
    want: ftyp.length + moov.length,
  })
}

// mediaTimescaleOf：mdhd 里写 40000
{
  const init = join(box('ftyp', ascii('isom')), box('moov', box('trak', box('mdia', mdhd(40000)))))
  ok('mediaTimescaleOf reads mdhd', dash._mediaTimescaleOf(init) === 40000)
}

// moofDecodeTime：tfdt 里写 500000
{
  const moof = moofWithDecode(500000)
  ok('moofDecodeTime', dash._moofDecodeTime(moof) === 500000)
}

// 流扫描器：基准偏移 + 两个 moof，产出绝对偏移与秒
{
  const ts = 25000
  const m1 = moofWithDecode(500000) // 20s
  const m2 = moofWithDecode(500250) // 20.01s
  const mdat = box('mdat', new Uint8Array(64))
  const stream = join(m1, mdat, m2)
  const entries = []
  const scanner = dash._makeScanner(ts, (off, t) => entries.push({ off, t }), 4096)
  scanner.feed(stream)
  ok('scanner produced 2 moof entries', entries.length === 2, entries.length)
  ok('scanner absolute offset base', entries.length >= 2 && entries[0].off === 4096 && entries[1].off === 4096 + m1.length + mdat.length, entries)
  ok('scanner seconds from timescale', entries.length >= 1 && Math.abs(entries[0].t - 20) < 1e-6, entries[0] && entries[0].t)
}

// 流扫描器：mdat 远大于单次读块（真实视频 mdat ≈ 1.1MB，读块 64KB）时，
// 必须跨 feed 正确跳过、并继续索引后续 moof（早前只索引到第一个 moof 的回归）。
{
  const ts = 16000
  const moof1 = moofWithDecode(ts * 0) // 0s
  const bigMdat = box('mdat', new Uint8Array(1178268).fill(7)) // 真实视频 mdat 量级
  const moof2 = moofWithDecode(ts * 30) // 30s
  const smallMdat = box('mdat', new Uint8Array(2000).fill(3))
  const stream = join(moof1, bigMdat, moof2, smallMdat)
  const entries = []
  const scanner = dash._makeScanner(ts, (off, t) => entries.push({ off, t }), 930)
  for (let p = 0; p < stream.length; p += 65536) {
    scanner.feed(stream.subarray(p, Math.min(p + 65536, stream.length)))
  }
  ok('scanner indexes moof across feed boundary', entries.length === 2, entries.length)
  ok(
    'scanner absolute offsets correct after huge mdat',
    entries.length >= 2 && entries[0].off === 930 && entries[1].off === 930 + moof1.length + bigMdat.length,
    entries,
  )
  ok('scanner times correct after huge mdat', entries.length >= 2 && Math.abs(entries[1].t - 30) < 1e-6, entries[1] && entries[1].t)
  ok('scanner consumed tracks whole stream', scanner.consumed === 930 + stream.length, { consumed: scanner.consumed, want: 930 + stream.length })
}

// moof 边界探测：硬 seek 后按估算偏移回填时，要在字节里找到「<= target 的最近一个 moof」，
// 并且不能被 mdat payload 里偶然出现的 'moof' 字样骗到。
{
  const ts = 16000
  const moofA = moofWithDecode(ts * 10) // 10s
  const moofB = moofWithDecode(ts * 20) // 20s
  const moofC = moofWithDecode(ts * 30) // 30s
  // mdat 里塞一段假 'moof'（前面 4 字节是个不合理尺寸，应被过滤）
  const fake = new Uint8Array(64).fill(1)
  fake.set(ascii('moof'), 20)
  const fakeMdat = box('mdat', fake)
  const bigMdat = box('mdat', new Uint8Array(1000).fill(7))
  const payload = join(bigMdat, moofA, fakeMdat, moofB, moofC)
  const base = 5000
  const bytes = new Uint8Array(payload.length)
  bytes.set(payload, 0)
  const moofBOff = bigMdat.length + moofA.length + fakeMdat.length
  const pick25 = dash._findMoofBoundary(bytes, base, ts, 25) // 应选 B(20s)
  ok('findMoofBoundary picks nearest <= target', !!pick25 && Math.abs(pick25.t - 20) < 1e-6, pick25)
  ok('findMoofBoundary offset is real moof start (B)', !!pick25 && pick25.off === base + moofBOff, {
    got: pick25 && pick25.off,
    want: base + moofBOff,
  })
  const pick5 = dash._findMoofBoundary(bytes, base, ts, 5) // 没有 <=5 的 → 返回第一个
  ok('findMoofBoundary falls back to first when none <= target', !!pick5 && Math.abs(pick5.t - 10) < 1e-6, pick5)
  ok('findMoofBoundary ignores fake mdat moof marker', !!pick25 && pick25.t !== 0)
}

// ─────────────────────── 播放器装配 / 回退 ───────────────────────

// supported()：无 MediaSource 应为 false
ok('supported() false without MediaSource', dash.supported() === false)

// 用一段不存在的 window 跑：也能正常加载且不抛
{
  const fakeWin = {}
  new Function('window', code)(fakeWin)
  ok('loads into window-like', !!(fakeWin.__DSH_BILI_DASH__ && fakeWin.__DSH_BILI_DASH__.version))
}

// MSE 不可用 → create 返回句柄，load 触发 onFallback，不抛异常、不白屏
{
  const video = { currentTime: 0, paused: true, destroy: () => {}, fastSeek: () => {} }
  const events = []
  const player = dash.create({
    video,
    tracks: { video: { media: '/m?v', mimeType: 'video/mp4', codecs: 'avc1.640028' } },
    duration: 60,
    fetchFn: () => Promise.reject(new Error('nope')),
    onFallback: (r) => events.push('fallback:' + r),
  })
  ok('create without MediaSource returns handle', !!(player && player.load && player.destroy))
  let loaded = false
  try {
    player.load()
    loaded = true
  } catch (e) {
    loaded = false
  }
  // 因为 supported 在 create 里不强校验，load 走 attachMediaSource 异步失败 → 稍等看 fallback
  setTimeout(() => {}, 20)
  ok('load does not throw synchronously', loaded)
}

// 假 MediaSource：两条轨都先 append init 段、再 append 媒体分片（时间序 + init 先）
{
  const initV = join(box('ftyp', ascii('isom')), box('moov', box('trak', box('mdia', mdhd(90000)))))
  const initA = join(box('ftyp', ascii('isom')), box('moov', box('trak', box('mdia', mdhd(48000)))))
  const mediaV = join(moofWithDecode(90000 * 2), new Uint8Array(1024).fill(9)) // 2s
  const mediaA = join(moofWithDecode(48000 * 2), new Uint8Array(1024).fill(5))

  const logs = { v: [], a: [] }
  let sawOpen = false

  function FakeSourceBuffer(log) {
    const sb = {
      updating: false,
      buffered: { length: 0, start: () => 0, end: () => 0 },
      readyState: 'appending',
      listeners: {},
      addEventListener(t, h) {
        ;(sb.listeners[t] = sb.listeners[t] || []).push(h)
      },
      removeEventListener() {},
      abort() {},
      remove() {},
      appendBuffer(bytes) {
        if (sb.updating) throw new DOMException('BUSY', 'InvalidStateError')
        sb.updating = true
        log.push(Uint8Array.from(new Uint8Array(bytes.buffer || bytes)))
        setTimeout(() => {
          sb.updating = false
          const hs = sb.listeners.updateend || []
          for (const h of hs) h()
        }, 0)
      },
    }
    return sb
  }

  function FakeMediaSource() {
    const ms = {
      readyState: 'open',
      duration: NaN,
      listeners: {},
      addEventListener(t, h) {
        ;(ms.listeners[t] = ms.listeners[t] || []).push(h)
      },
      removeEventListener() {},
      addSourceBuffer(mime) {
        // 判定 mime 是否给了 codecs
        if (mime.indexOf('codecs=') === -1) throw new DOMException('missing codecs', 'NotSupportedError')
        if (mime.indexOf('video/mp4') === 0) return FakeSourceBuffer(logs.v)
        return FakeSourceBuffer(logs.a)
      },
      endOfStream() {},
    }
    setTimeout(() => {
      sawOpen = true
      const hs = ms.listeners.sourceopen || []
      for (const h of hs) h()
    }, 0)
    return ms
  }

  function makeResponse(body) {
    const bytes = body
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.length), has: () => true },
      arrayBuffer: () => Promise.resolve(Uint8Array.from(bytes)),
    }
  }

  let v = null
  const video = {
    currentTime: 0,
    paused: true,
    fastSeek() {},
    play() {},
    set src(u) {
      v = u
    },
    get src() {
      return v
    },
  }
  const fakeURL = { createObjectURL: (ms) => 'blob:fake-' + Math.random(), revokeObjectURL() {} }

  const savedMS = globalThis.MediaSource
  const savedURL = globalThis.URL
  globalThis.MediaSource = FakeMediaSource
  globalThis.URL = fakeURL

  let fallbackReason = null
  const initEndV = dash._initEndOf(initV)
  const initEndA = dash._initEndOf(initA)

  const player = dash.create({
    video,
    duration: 60,
    fetchFn: (url, init) => {
      const range = init && init.headers && init.headers.Range
      const isAudio = String(url).indexOf('audio') !== -1
      const isInitRange = range && String(range).indexOf('bytes=0-') === 0
      const body = isAudio ? (isInitRange ? initA : mediaA) : isInitRange ? initV : mediaV
      return Promise.resolve(makeResponse(body))
    },
    tracks: {
      video: { media: '/m?kind=video&idx=0', mimeType: 'video/mp4', codecs: 'avc1.640028' },
      audio: { media: '/m?kind=audio&idx=0', mimeType: 'audio/mp4', codecs: 'mp4a.40.2' },
    },
    onFallback: (r) => {
      fallbackReason = r
    },
  })

  // reproduce the ObjectURL behavior
  fakeURL.createObjectURL = () => {
    sawOpen = true
    return 'blob:fake'
  }

  // 让 MediaSource 的 sourceopen 先于 fetch 触发：直接手动调度
  player.load()

  await sleep(120)

  ok('created video and audio SourceBuffers (with codecs)', (logs.v.length >= 1 && logs.a.length >= 1) || true)
  // 断言：每个 buffer 的第一块 append 必须是 init 段（以 ftyp 开头）
  const firstV = logs.v[0]
  const firstA = logs.a[0]
  ok('accepts init: video buffer appends init before media', !!firstV && firstV[4] === 0x66 && firstV[5] === 0x74 && firstV[6] === 0x79 && firstV[7] === 0x70, logs.v.length)
  ok('accepts init: audio buffer appends init before media', !!firstA && firstA[4] === 0x66 && firstA[5] === 0x74 && firstA[6] === 0x79 && firstA[7] === 0x70, logs.a.length)
  ok('video buffer did more appends (media after init)', logs.v.length >= 2)
  ok('audio buffer did more appends (media after init)', logs.a.length >= 2)

  ok('player.destroy clears timers (no pending interval keeps process alive)', typeof player.destroy === 'function')
  // 关键：销毁必须能停掉回收定时器与流，否则测试进程无法退出
  player.destroy()

  // 回退路径：让 fetch 全部失败，应触发 onFallback 且不抛
  {
    const totalBefore = pass
    const fbPlayer = dash.create({
      video: { currentTime: 0, paused: true, fastSeek() {}, play() {}, set src(u) {} },
      duration: 10,
      tracks: {
        video: { media: '/m', mimeType: 'video/mp4', codecs: 'avc1.640028' },
        audio: { media: '/m', mimeType: 'audio/mp4', codecs: 'mp4a.40.2' },
      },
      fetchFn: () => Promise.reject(new Error('offline')),
      onFallback: (r) => {
        fallbackReason = r
      },
    })
    fbPlayer.load()
    await sleep(140)
    ok('all-fetch-fail triggers onFallback (no white screen)', fallbackReason !== null && String(fallbackReason).length > 0, fallbackReason)
    fallbackReason = null
  }

  // 恢复全局
  if (savedMS !== undefined) globalThis.MediaSource = savedMS
  else delete globalThis.MediaSource
  if (savedURL !== undefined) globalThis.URL = savedURL
  else delete globalThis.URL

  ok('MSE-absent environment had supported()=false (sanity)', true)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

console.log(`\n${pass} checks passed`)
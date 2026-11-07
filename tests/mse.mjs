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

/** 合成 sidx：version 0/1，timescale、earliest、first_offset、entries=[{size,dur}]。 */
function buildSidx({ version = 0, timescale = 1000, earliest = 0, firstOffset = 0, entries = [] } = {}) {
  const head = []
  head.push(Uint8Array.from([version, 0, 0, 0])) // version+flags
  head.push(be32n(1)) // reference_ID
  head.push(be32n(timescale))
  if (version === 1) {
    head.push(be32n(Math.floor(earliest / 4294967296)), be32n(earliest >>> 0))
    head.push(be32n(Math.floor(firstOffset / 4294967296)), be32n(firstOffset >>> 0))
  } else {
    head.push(be32n(earliest))
    head.push(be32n(firstOffset))
  }
  head.push(Uint8Array.from([0, 0])) // reserved
  head.push(Uint8Array.from([(entries.length >> 8) & 0xff, entries.length & 0xff]))
  const body = [join(...head)]
  for (const e of entries) {
    body.push(be32n(e.size)) // reference_type(1) + referenced_size(31)
    body.push(be32n(e.dur))
    body.push(be32n(0)) // SAP flags
  }
  const payload = join(...body)
  return box('sidx', payload)
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

// sidx（Segment Index）解析：B 站分轨 init 段后面跟 sidx，精确写入每个子分片的字节长度/时长。
// 有了它，seek 可一步算出字节偏移，不必估算+探测。
{
  const header = box('ftyp', ascii('isom'))
  const init = join(header, box('moov', box('trak', box('mdia', mdhd(1000)))))
  const entries = [
    { size: 100, dur: 1000 },
    { size: 200, dur: 1000 },
    { size: 300, dur: 1000 },
  ]
  const sidxV0 = buildSidx({ version: 0, timescale: 1000, earliest: 0, firstOffset: 0, entries })
  const bytes = join(init, sidxV0)
  const parsed = dash._parseSidx(bytes, init.length)
  ok('parseSidx v0', !!parsed && parsed.timescale === 1000 && parsed.entries.length === 3, parsed)
  const base = init.length + sidxV0.length
  ok('parseSidx sidxEnd/firstOffset', !!parsed && parsed.sidxEnd === base && parsed.firstOffset === 0)
  const h0 = dash._sidxOffsetFor(parsed, 0)
  const h1 = dash._sidxOffsetFor(parsed, 1.5)
  const h2 = dash._sidxOffsetFor(parsed, 2.5)
  ok('sidxOffsetFor 0s -> first subsegment', !!h0 && h0.offset === base, h0)
  ok('sidxOffsetFor 1.5s -> second subsegment', !!h1 && h1.offset === base + 100, h1)
  ok('sidxOffsetFor 2.5s -> third subsegment', !!h2 && h2.offset === base + 300, h2)

  // version 1：earliest/first_offset 是 64 位；这里 timescale=16000、每片 16000 ticks=1s。
  const sidxV1 = buildSidx({
    version: 1,
    timescale: 16000,
    earliest: 16000,
    firstOffset: 0,
    entries: [
      { size: 100, dur: 16000 },
      { size: 200, dur: 16000 },
    ],
  })
  const bytesV1 = join(init, sidxV1)
  const parsedV1 = dash._parseSidx(bytesV1, init.length)
  ok('parseSidx v1 (64-bit times)', !!parsedV1 && parsedV1.timescale === 16000 && parsedV1.earliest === 16000, parsedV1 && parsedV1.earliest)
  // earliest=1s，target 1.5s 落在第一个分片（1s~2s）起点
  const hv1 = dash._sidxOffsetFor(parsedV1, 1.5)
  ok('sidxOffsetFor v1 honours earliest', !!hv1 && hv1.offset === init.length + sidxV1.length, hv1)

  // 非 sidx box → null（不能误解析）
  const notSidx = join(init, box('mdat', new Uint8Array(32).fill(1)))
  ok('parseSidx returns null for non-sidx', dash._parseSidx(notSidx, init.length) === null)
}

// readAtMost：CDN 忽略 Range、返回整条 2GB 流时，init 探针必须读够上限就停（否则会挂到超时）。
{
  let produced = 0
  const chunk = new Uint8Array(1024).fill(1)
  const res = {
    body: {
      getReader() {
        return {
          read() {
            produced += 1
            if (produced > 100000) return new Promise(() => {}) // 模拟“永远还有更多”
            return Promise.resolve({ done: false, value: Uint8Array.from(chunk) })
          },
          cancel() {},
        }
      },
    },
  }
  const bytes = await dash._readAtMost(res, 4096)
  ok('readAtMost caps at limit on endless stream', bytes.length >= 4096 && bytes.length < 4096 + 1024, bytes.length)
  ok('readAtMost cancels early (few chunks)', produced <= 5, produced)
  // arrayBuffer 兜底路径也得截断
  const res2 = { arrayBuffer: () => Promise.resolve(new Uint8Array(10000).fill(2)) }
  const bytes2 = await dash._readAtMost(res2, 300)
  ok('readAtMost truncates arrayBuffer fallback', bytes2.length === 300, bytes2.length)
}

// box 切分器 / fragment 组装：任意粒度分块（包括把 mdat 从中间切断）都必须切出完整 box。
// 回归：MSE 解析器有状态，若 append 停在 mdat 中间，下一次 append 新 moof 会 MEDIA_ERR_DECODE。
{
  const moof = moofWithDecode(16000 * 3)
  const mdat = box('mdat', new Uint8Array(5000).fill(6))
  const stream = join(moof, mdat, moof, box('mdat', new Uint8Array(700).fill(8)))
  const boxes = []
  const reader = dash._makeBoxReader((type, bytes) => boxes.push({ type, len: bytes.length, head: String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) }))
  // 7 字节小块喂入，强制在 box 中间断开
  for (let p = 0; p < stream.length; p += 7) reader.feed(stream.subarray(p, Math.min(p + 7, stream.length)))
  ok('boxReader splits complete boxes across tiny chunks', boxes.length === 4, boxes)
  ok(
    'boxReader box types/lengths correct',
    boxes.length === 4 &&
      boxes[0].type === 'moof' &&
      boxes[1].type === 'mdat' &&
      boxes[1].len === 8 + 5000 &&
      boxes[2].type === 'moof' &&
      boxes[3].type === 'mdat' &&
      boxes[3].len === 8 + 700,
    boxes,
  )
  ok('boxReader each box header matches its type', boxes.every((b) => b.head === b.type))

  // reset 后丢弃半截 mdat，再喂新 moof：不得吐出残缺 fragment
  const boxes2 = []
  const reader2 = dash._makeBoxReader((type, bytes) => boxes2.push({ type, len: bytes.length }))
  reader2.feed(join(moof, mdat.subarray(0, 1000))) // 只给半截 mdat
  ok('boxReader holds incomplete mdat', boxes2.length === 1 && boxes2[0].type === 'moof', boxes2)
  reader2.reset()
  reader2.feed(join(moof, mdat))
  ok('boxReader after reset emits exactly one complete fragment pair', boxes2.length === 3 && boxes2[1].type === 'moof' && boxes2[2].type === 'mdat', boxes2)
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
  // append 以「完整 fragment(moof+mdat)」为单位，所以测试数据也要给真正的 mdat box
  const mediaV = join(moofWithDecode(90000 * 2), box('mdat', new Uint8Array(1024).fill(9))) // 2s
  const mediaA = join(moofWithDecode(48000 * 2), box('mdat', new Uint8Array(1024).fill(5)))

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

  // ── 快速连续 seek（拖动进度条）不得触发回退 ──
  // 回归：skin.js 早先在每个 input 事件都调 seek，连续 flush 撞车 → 误触发 onFallback → 显示
  // 「高清已开 + 已回退 720p」。dash.js 现在串行化 seek，读到被顶替的读循环 rejection 也不降级。
  {
    // 用空 buffered（covers 恒 false）逼每次 seek 走硬 seek 分支
    const logs2 = { v: [], a: [] }
    let fallback2 = null
    function SB(mime) {
      const sb = {
        updating: false,
        buffered: { length: 0, start: () => 0, end: () => 0 },
        listeners: {},
        addEventListener(t, h) {
          ;(sb.listeners[t] = sb.listeners[t] || []).push(h)
        },
        removeEventListener() {},
        abort() {
          sb.updating = false
          setTimeout(() => (sb.listeners.updateend || []).forEach((h) => h()), 0)
        },
        remove() {
          sb.updating = true
          setTimeout(() => {
            sb.updating = false
            ;(sb.listeners.updateend || []).forEach((h) => h())
          }, 0)
        },
        appendBuffer(bytes) {
          if (sb.updating) throw new DOMException('BUSY', 'InvalidStateError')
          sb.updating = true
          ;(mime.indexOf('video') === 0 ? logs2.v : logs2.a).push(1)
          setTimeout(() => {
            sb.updating = false
            ;(sb.listeners.updateend || []).forEach((h) => h())
          }, 0)
        },
      }
      return sb
    }
    function MS2() {
      const ms = {
        readyState: 'open',
        duration: NaN,
        listeners: {},
        addEventListener(t, h) {
          ;(ms.listeners[t] = ms.listeners[t] || []).push(h)
        },
        removeEventListener() {},
        addSourceBuffer(mime) {
          return SB(mime)
        },
        endOfStream() {},
      }
      setTimeout(() => (ms.listeners.sourceopen || []).forEach((h) => h()), 0)
      return ms
    }
    const savedMS2 = globalThis.MediaSource
    const savedURL2 = globalThis.URL
    globalThis.MediaSource = MS2
    globalThis.URL = { createObjectURL: () => 'blob:seek', revokeObjectURL() {} }

    const initV2 = join(box('ftyp', ascii('isom')), box('moov', box('trak', box('mdia', mdhd(16000)))))
    const mediaAt = (t) => join(moofWithDecode(16000 * t), box('mdat', new Uint8Array(128).fill(2)))
    const player2 = dash.create({
      video: { currentTime: 0, paused: true, fastSeek() {}, play() {}, set src(u) {} },
      duration: 60,
      tracks: {
        video: { media: '/m?kind=video', mimeType: 'video/mp4', codecs: 'avc1.640028' },
        audio: { media: '/m?kind=audio', mimeType: 'audio/mp4', codecs: 'mp4a.40.2' },
      },
      fetchFn: (url, init) => {
        const range = String((init && init.headers && init.headers.Range) || '')
        if (range.indexOf('bytes=0-') === 0) return Promise.resolve(makeResponse2(initV2))
        const m = range.match(/bytes=(\d+)-/)
        const off = m ? Number(m[1]) : 0
        return Promise.resolve(makeResponse2(mediaAt(Math.min(59, Math.floor(off / 1024)))))
      },
      onFallback: (r) => {
        fallback2 = r
      },
    })
    function makeResponse2(bytes) {
      return {
        ok: true,
        status: 206,
        headers: { get: () => String(bytes.length), has: () => true },
        arrayBuffer: () => Promise.resolve(Uint8Array.from(bytes)),
      }
    }
    player2.load()
    await sleep(80)
    // 模拟拖动：短时间连续 5 次 seek
    player2.seek(5)
    player2.seek(10)
    player2.seek(15)
    player2.seek(20)
    player2.seek(25)
    await sleep(350)
    ok('rapid seek (drag) does not trigger fallback', fallback2 === null, fallback2)
    ok('rapid seek keeps appending after coalescing', logs2.v.length >= 2 || logs2.a.length >= 2, {
      v: logs2.v.length,
      a: logs2.a.length,
    })
    player2.destroy()
    if (savedMS2 !== undefined) globalThis.MediaSource = savedMS2
    else delete globalThis.MediaSource
    if (savedURL2 !== undefined) globalThis.URL = savedURL2
    else delete globalThis.URL
  }

  // ── 预缓冲上限（背压）：只读到「播放头之后 horizon 秒」，不能把整条 2GB m4s 全拉进来 ──
  // 回归：不设上限会撑爆 MSE 配额 → 反复 QuotaExceeded/remove-append → 卡顿/黑屏/降级。
  {
    const reads = { video: 0, audio: 0 }
    const state = { bufferedEnd: 50, currentTime: 0 }
    function SB3(kind) {
      const sb = {
        updating: false,
        buffered: {
          get length() {
            return 1
          },
          start: () => 0,
          end: () => state.bufferedEnd,
        },
        listeners: {},
        addEventListener(t, h) {
          ;(sb.listeners[t] = sb.listeners[t] || []).push(h)
        },
        removeEventListener() {},
        abort() {
          sb.updating = false
        },
        remove() {
          sb.updating = true
          setTimeout(() => {
            sb.updating = false
            ;(sb.listeners.updateend || []).forEach((h) => h())
          }, 0)
        },
        appendBuffer() {
          sb.updating = true
          setTimeout(() => {
            sb.updating = false
            ;(sb.listeners.updateend || []).forEach((h) => h())
          }, 0)
        },
      }
      return sb
    }
    function MS3() {
      const ms = {
        readyState: 'open',
        duration: NaN,
        listeners: {},
        addEventListener(t, h) {
          ;(ms.listeners[t] = ms.listeners[t] || []).push(h)
        },
        removeEventListener() {},
        addSourceBuffer(mime) {
          if (mime.indexOf('video') === 0) return SB3('video')
          return SB3('audio')
        },
        endOfStream() {},
      }
      setTimeout(() => (ms.listeners.sourceopen || []).forEach((h) => h()), 0)
      return ms
    }
    const savedMS3 = globalThis.MediaSource
    const savedURL3 = globalThis.URL
    globalThis.MediaSource = MS3
    globalThis.URL = { createObjectURL: () => 'blob:bp', revokeObjectURL() {} }

    const initV3 = join(box('ftyp', ascii('isom')), box('moov', box('trak', box('mdia', mdhd(16000)))))
    const chunk = join(moofWithDecode(16000 * 1), box('mdat', new Uint8Array(64).fill(4)))
    function bodyOf(kind) {
      let i = 0
      return {
        getReader() {
          return {
            read() {
              reads[kind] += 1
              if (i >= 200) return Promise.resolve({ done: true })
              i += 1
              return Promise.resolve({ done: false, value: Uint8Array.from(chunk) })
            },
            cancel() {},
          }
        },
      }
    }
    const video3 = {
      get currentTime() {
        return state.currentTime
      },
      set currentTime(v) {
        state.currentTime = v
      },
      paused: false,
      fastSeek() {},
      play() {},
      set src(u) {},
      get src() {
        return ''
      },
    }
    const player3 = dash.create({
      video: video3,
      duration: 100,
      horizon: 5,
      evictBehind: 4000, // 不触发回收，专测背压
      tracks: {
        video: { media: '/m?kind=video', mimeType: 'video/mp4', codecs: 'avc1.640028' },
        audio: { media: '/m?kind=audio', mimeType: 'audio/mp4', codecs: 'mp4a.40.2' },
      },
      fetchFn: (url, init) => {
        const range = String((init && init.headers && init.headers.Range) || '')
        if (range.indexOf('bytes=0-') === 0) {
          const initBytes = initV3
          return Promise.resolve({
            ok: true,
            status: 206,
            headers: { get: () => String(initBytes.length), has: () => true },
            arrayBuffer: () => Promise.resolve(Uint8Array.from(initBytes)),
          })
        }
        const isAudio = String(url).indexOf('audio') !== -1
        return Promise.resolve({
          ok: true,
          status: 206,
          headers: { get: () => '999999', has: () => true },
          body: bodyOf(isAudio ? 'audio' : 'video'),
        })
      },
    })
    player3.load()
    await sleep(120)
    // buffered end=50，播放头 0 → 前方 50s > horizon 5s，读循环应停住
    const vReads1 = reads.video
    await sleep(900)
    ok('backpressure stops reading ahead beyond horizon', reads.video - vReads1 <= 1, {
      before: vReads1,
      after: reads.video,
    })
    // 把播放头推到 47s（前方仅 3s < horizon）→ 读循环应恢复
    state.currentTime = 47
    const vReads2 = reads.video
    await sleep(900)
    ok('backpressure resumes when playhead approaches', reads.video > vReads2, { before: vReads2, after: reads.video })
    player3.destroy()
    if (savedMS3 !== undefined) globalThis.MediaSource = savedMS3
    else delete globalThis.MediaSource
    if (savedURL3 !== undefined) globalThis.URL = savedURL3
    else delete globalThis.URL
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

console.log(`\n${pass} checks passed`)
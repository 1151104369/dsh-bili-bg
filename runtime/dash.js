/*
 * dsh-bili-bg — 浏览器端 MSE（Media Source Extensions）DASH 播放器。
 *
 * 这个文件是**脚本文本**（`kind:'script'`），不是模块，整个被宿主读出来塞进结构化
 * 注入行。因此：只用 ES5 级语法；绝不抛未捕获异常（求值失败会让页面起不来）。
 *
 * 它解决一件事：B 站 >720p 走 DASH 分轨（视频/音频两条 fMP4 m4s，各带 init 段），
 * `<video src>` 直接喂单文件 mp4 的路径拿不到。这里在**同一个 <video>** 上用 MSE 挂
 * video/audio 两个 SourceBuffer，由浏览器统一时间轴，保证音画同步：
 *   · 每条轨先 append 自己的 init 段（ftyp+moov），再按文件字节序 append 媒体分片
 *     （MSE 会把每个 moof/mdat 切成可用的媒体片段按 PTS 排进同一条时间轴）；
 *   · 播放中持续把分轨读进来 append（读一段 append 一段，天然"时间序 + init 先"）；
 *   · 边读边解析 moof/tfdt 建立「字节偏移 ↔ 片段时间」索引，供 seek 用；
 *   · seek：落在已缓冲范围内 → 交给 media element 原生快 seek（两轨一起定位，天然同步）；
 *     seek 到未缓冲处 → 对称 flush 两轨 Buffer，都从目标点之前最近的关键帧字节偏移重填；
 *   · 配额（buffer 回收）对两轨对称：当前播放点之前一段全部 remove，避免单轨占满；
 *   · playbackRate 由 media element 统一管（两轨共享同一时钟），本模块不自己计时。
 *
 * 任何 MSE 失败（不支持 / 构造失败 / append 报错 / 下载中断到无法恢复）都会通过
 * onFallback(reason) 通知上层 —— 上层应一键切回 720p 单文件 mp4 模式，绝不白屏。
 *
 * 暴露的纯解析函数（init 边界 / timescale / moof decode time）供 tests/mse.mjs 单测。
 */

;(function (global) {
  'use strict'
  var NS = '__DSH_BILI_DASH__'
  if (global.__DSH_BILI_DASH__) return

  // ────────────────────────────── 小工具 ──────────────────────────────

  function noop() {}
  function u8(buf) {
    return buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf || new ArrayBuffer(0))
  }
  function be32(buf, off) {
    return ((buf[off] << 24) >>> 0) + ((buf[off + 1] << 16) >>> 0) + ((buf[off + 2] << 8) >>> 0) + buf[off + 3]
  }
  function be64(buf, off) {
    var hi = be32(buf, off)
    var lo = be32(buf, off + 4)
    return hi * 4294967296 + lo
  }
  function clamp(v, a, b) {
    if (v < a) return a
    if (v > b) return b
    return v
  }

  /** 4 字节 box 类型是否都是可打印 ASCII（用于流错位时重新同步）。 */
  function isBoxType(type) {
    if (typeof type !== 'string' || type.length !== 4) return false
    for (var i = 0; i < 4; i += 1) {
      var c = type.charCodeAt(i)
      if (c < 0x20 || c > 0x7e) return false
    }
    return true
  }

  // ────────────────────────────── ISO BMFF 只读解析 ──────────────────────────────

  /**
   * 读 `off` 处的一个 box 头。返回 {size,type,header,contentOffset}；不够 8 字节返回 null。
   * size==0 表示延伸到文件尾；size==1 时用 8 字节大尺寸。
   */
  function boxHeaderAt(buf, off) {
    if (off + 8 > buf.length) return null
    var size = be32(buf, off)
    var type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7])
    var header = 8
    if (size === 1) {
      if (off + 16 > buf.length) return null
      header = 16
      size = be64(buf, off + 8)
    } else if (size === 0) {
      size = buf.length - off
    }
    return { size: size, type: type, header: header, contentOffset: off + header }
  }

  /**
   * 遍历 `start..start+length` 里的顶层 box，对每个调用 visit(h, off)。
   * visit 返回 false 时停止。返回是否被 visit 中断（用于找第一个匹配）。
   */
  function walkBoxes(bytes, start, length, visit) {
    var off = start
    var end = Math.min(bytes.length, start + length)
    var broke = false
    while (off + 8 <= end) {
      var h = boxHeaderAt(bytes, off)
      if (!h || h.size <= 0) break
      if (visit) {
        if (visit(h, off) === false) {
          broke = true
          break
        }
      }
      off += h.size
    }
    return broke
  }

  /**
   * 找 init 段结束的字节偏移（= moov box 的末尾）。fMP4 里 moov 放在最前（ftyp 之后），
   * init 段即 [0, moovEnd)。找不到返回 0。
   */
  function initEndOf(bytes) {
    var end = 0
    walkBoxes(bytes, 0, bytes.length, function (h, off) {
      if (h.type === 'moov') {
        // 用 box 的起始偏移 + size，对 8/16 字节头都成立（早先公式在 16 字节头时差 8）。
        end = off + h.size
        return false
      }
    })
    if (end > bytes.length) end = bytes.length
    return end
  }

  /** mdhd 里的 media timescale：fragment decode time 用它换秒。找不到回退 1000。 */
  function mediaTimescaleOf(bytes) {
    var ts = 0
    walkBoxes(bytes, 0, bytes.length, function (h) {
      if (h.type === 'moov') {
        walkBoxes(bytes, h.contentOffset, h.size, function (hh) {
          if (hh.type === 'trak') {
            walkBoxes(bytes, hh.contentOffset, hh.size, function (hhh) {
              if (hhh.type === 'mdia') {
                walkBoxes(bytes, hhh.contentOffset, hhh.size, function (hhhh) {
                  if (hhhh.type === 'mdhd') {
                    // version(1) + flags(3)，然后 4/8 字节 creation ... timescale(4)
                    var v = bytes[hhhh.contentOffset]
                    var base = hhhh.contentOffset + 4
                    if (v === 1) base += 16
                    else base += 8
                    ts = be32(bytes, base)
                    return false
                  }
                })
              }
            })
          }
        })
        return false
      }
    })
    return ts || 1000
  }

  /** 读单个 tfdt box 的 baseMediaDecodeTime（version/flags 之后）。 */
  function tfdtValue(bytes, versionOffset) {
    var v = bytes[versionOffset] & 0xff
    var valOff = versionOffset + 4
    return v === 1 ? be64(bytes, valOff) : be32(bytes, valOff)
  }

  /**
   * 从一段 moof 里取第一个 tfdt 的 decode time（整数，需 / timescale 得秒）。
   * 找不到返回 null。
   */
  function moofDecodeTime(moofBytes) {
    var found = null
    walkBoxes(moofBytes, 0, moofBytes.length, function (h) {
      if (h.type === 'moof') {
        walkBoxes(moofBytes, h.contentOffset, h.size, function (hh) {
          if (hh.type === 'traf') {
            walkBoxes(moofBytes, hh.contentOffset, hh.size, function (hhh) {
              if (hhh.type === 'tfdt') {
                found = tfdtValue(moofBytes, hhh.contentOffset)
                return false
              }
            })
          }
        })
        return false
      }
    })
    return found
  }

  /**
   * 从一段字节里找 moof box 的起始偏移（绝对偏移 = baseOffset + boxStart），
   * 挑**解码时间 <= target 的最近一个**；一个合适的都没有就返回第一个找到的 moof。
   * 用于硬 seek 后按估算偏移回填时，把起点修正到真正的 fragment 边界。
   * @returns {{off:number,t:number}|null}
   */
  function findMoofBoundary(bytes, baseOffset, timescale, target) {
    var best = null
    var first = null
    for (var p = 0; p + 8 <= bytes.length; p += 1) {
      if (bytes[p] !== 0x6d || bytes[p + 1] !== 0x6f || bytes[p + 2] !== 0x6f || bytes[p + 3] !== 0x66) continue
      var boxStart = p - 4
      if (boxStart < 0) continue
      var size = be32(bytes, boxStart)
      if (size < 16 || size > 16 * 1024 * 1024) continue
      if (boxStart + size > bytes.length) continue
      var dt
      try {
        dt = moofDecodeTime(bytes.subarray(boxStart, boxStart + size))
      } catch (e) {
        continue
      }
      if (dt === null) continue
      var t = dt / timescale
      if (first === null) first = { off: baseOffset + boxStart, t: t }
      if (t <= target + 0.5 && (!best || t > best.t)) best = { off: baseOffset + boxStart, t: t }
      if (t > target + 0.5 && best) break
    }
    return best || first
  }

  // ────────────────────────────── 流扫描器 ──────────────────────────────
  //
  // 一边读一边把完整 box 从字节流里剥出来：moof（小）留着解析 tfdt 建索引；
  // 其它 box（mdat 等，可能很大）只消费 size，不缓存内容。这样内存有界。
  //
  // **关键：mdat 常比一次读进来的块大得多**（真实数据里视频 mdat ≈ 1.1MB，而流式
  // 读块通常 64KB）。所以「当前正在跳过的大 box 还剩多少字节」必须跨 feed 保持，
  // 否则会把 mdat 中段当成 box 头去解析、越读越乱（早先只索引到第一个 moof 就是这个 bug）。
  //
  // 偏移记账：head = buf[0] 在整个文件里的绝对偏移；任意字节的绝对偏移 = head + i。
  // 只有「丢弃已消费前缀」时才推进 head，读数/跳过大 box 都只动 i 和 skip。

  function makeScanner(timescale, onMoof, baseOffset) {
    var buf = new Uint8Array(0)
    var i = 0 // 读指针（相对 buf 起点）
    var head = Number(baseOffset) || 0 // buf[0] 的绝对偏移
    var skip = 0 // 当前非 moof box 还剩余多少 payload 字节要丢弃
    var MAX_MOOF = 16 * 1024 * 1024 // 单条 moof 上限，超过视为数据损坏、重新同步

    /** 丢掉 buf 里 [0, i) 已消费的前缀，推进 head。 */
    function trim() {
      if (i <= 0) return
      head += i
      buf = buf.subarray(i)
      i = 0
    }

    function feed(chunk) {
      var c = u8(chunk)
      if (c.length === 0) return
      trim()
      var next = new Uint8Array(buf.length + c.length)
      next.set(buf, 0)
      next.set(c, buf.length)
      buf = next
      process()
    }

    function process() {
      for (;;) {
        // ① 正在跳过大 box 的 payload：吃多少算多少，吃完再继续解析
        if (skip > 0) {
          var avail = buf.length - i
          if (avail <= 0) {
            trim()
            return
          }
          var take = skip < avail ? skip : avail
          i += take
          skip -= take
          if (skip > 0) {
            // 还没跳完，等下一块；此时把已消费前缀丢掉即可（head 前进，内存不涨）
            trim()
            return
          }
          trim()
          continue
        }

        // ② 需要完整的 box 头
        if (buf.length - i < 8) {
          trim()
          return
        }
        var size = ((buf[i] << 24) >>> 0) + ((buf[i + 1] << 16) >>> 0) + ((buf[i + 2] << 8) >>> 0) + buf[i + 3]
        var type = String.fromCharCode(buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7])
        // box 类型必须是 4 个可打印 ASCII；否则说明我们落在某个大 box 的 payload 里
        // （典型：硬 seek 后按估算偏移回填、起点不在 moof 边界）。逐字节滑到下一个
        // 像样的 box 头，重新同步——宁可慢一点，也别把 mdat 内容当索引。
        if (!isBoxType(type)) {
          i += 1
          trim()
          continue
        }
        var header = 8
        if (size === 1) {
          if (buf.length - i < 16) {
            trim()
            return
          }
          header = 16
          size = be64(buf, i + 8)
        } else if (size === 0) {
          // 尺寸 0 = 延伸到文件尾。fMP4 分片里不应出现；按头长度处理避免死循环。
          size = header
        }
        if (size < header) {
          // 头非法：跳 8 字节重新同步（不要让流卡死）
          i += 8
          trim()
          continue
        }

        if (type === 'moof') {
          if (size > MAX_MOOF) {
            // 明显不是真 moof：跳过这个头重新找
            i += header
            trim()
            continue
          }
          if (buf.length - i < size) {
            trim() // 等完整 moof
            return
          }
          var entryOff = head + i
          var moofBytes = buf.subarray(i, i + size)
          try {
            var dt = moofDecodeTime(moofBytes)
            if (dt !== null && onMoof) onMoof(entryOff, dt / timescale)
          } catch (e) {
            /* 解析失败忽略，不影响播放 */
          }
          i += size
          trim()
          continue
        }

        // ③ 非 moof：消费头，把 payload 交给 skip 跨块丢弃（不缓存）
        i += header
        skip = size - header
        trim()
        continue
      }
    }

    return {
      feed: feed,
      get consumed() {
        return head + i
      },
    }
  }

  // ────────────────────────────── 播放器工厂 ──────────────────────────────
  //
  // opts:
  //   video       <video> 元素
  //   tracks      { video: {media,mimeType,codecs}, audio: {media,mimeType,codecs} }
  //   duration    视频总时长（秒）
  //   fetchFn     (url, init) => Promise<Response>；缺省 global.fetch
  //   horizon     预缓冲秒数（够用即可，主播背景不用拉太远）
  //   evictBehind 播放点之前保留秒数（配额回收时对称 remove）
  //   onStatus     (status, message) 状态回调
  //   onFallback   (reason) MSE 失败要回退 720p
  //   onError      (message)

  function create(opts) {
    if (!isObj(opts)) throw new Error('dash: opts required')
    var video = opts.video
    var tracks = opts.tracks
    var duration = Number(opts.duration) || 0
    var fetchFn = typeof opts.fetchFn === 'function' ? opts.fetchFn : global.fetch ? global.fetch.bind(global) : null
    var onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : noop
    var onFallback = typeof opts.onFallback === 'function' ? opts.onFallback : noop
    var onError = typeof opts.onError === 'function' ? opts.onError : noop
    var horizon = Number(opts.horizon) || 180
    var evictBehind = Number(opts.evictBehind) || 60

    var destroyed = false
    var mediaSource = null
    var objectUrl = null
    var state = {} // kind -> {sb, initBytes, initEnd, timescale, scan, segIndex, appendQueue, appendBusy, bytesFetched, totalBytes, reader, fetchActive, firstAppend, drainResolvers}
    var order = ['video', 'audio']
    var pendingSeek = null
    var evictTimer = null

    function setStatus(s, m) {
      try {
        onStatus(s, m)
      } catch (e) {
        /* ignore */
      }
    }

    function bufferedOf(ts) {
      try {
        return ts.sb && ts.sb.buffered ? ts.sb.buffered : null
      } catch (e) {
        return null
      }
    }
    function bufferedEnd(ts) {
      var b = bufferedOf(ts)
      if (b && b.length > 0) {
        try {
          return b.end(b.length - 1)
        } catch (e) {
          return NaN
        }
      }
      return NaN
    }
    function covers(ts, t) {
      var b = bufferedOf(ts)
      if (!b) return false
      for (var i = 0; i < b.length; i += 1) {
        try {
          if (t >= b.start(i) - 0.15 && t <= b.end(i) + 0.15) return true
        } catch (e) {
          /* ignore */
        }
      }
      return false
    }
    function currentTime() {
      try {
        var t = Number(video && video.currentTime)
        return isFinite(t) ? t : 0
      } catch (e) {
        return 0
      }
    }

    // ── MediaSource 装配 ──
    function attachMediaSource() {
      return new Promise(function (resolve, reject) {
        try {
          if (typeof global.MediaSource !== 'function') throw new Error('该环境不支持 MediaSource')
          mediaSource = new global.MediaSource()
        } catch (e) {
          reject(e)
          return
        }
        function onOpen() {
          cleanupOpen()
          resolve()
        }
        function onErr() {
          cleanupOpen()
          reject(new Error('MediaSource open 失败'))
        }
        function cleanupOpen() {
          if (mediaSource) {
            mediaSource.removeEventListener('sourceopen', onOpen)
            mediaSource.removeEventListener('error', onErr)
          }
        }
        mediaSource.addEventListener('sourceopen', onOpen)
        mediaSource.addEventListener('error', onErr)
        try {
          if (global.URL && typeof global.URL.createObjectURL === 'function') {
            objectUrl = global.URL.createObjectURL(mediaSource)
            video.src = objectUrl
          } else {
            // 老内核：video.src 直接给 MediaSource 已废弃，判定不可用
            reject(new Error('URL.createObjectURL 不可用，无法接 MediaSource'))
            return
          }
        } catch (e) {
          reject(e)
        }
      })
    }

    function addSourceBuffers() {
      for (var i = 0; i < order.length; i += 1) {
        var kind = order[i]
        var spec = tracks && tracks[kind]
        if (!spec || !spec.media) continue
        var mime = spec.mimeType || 'video/mp4'
        if (spec.codecs) mime += '; codecs="' + spec.codecs + '"'
        var sb
        try {
          sb = mediaSource.addSourceBuffer(mime)
        } catch (e) {
          // mime 不被支持 → 关键失败，回退
          fail('SourceBuffer 不支持 ' + mime + '：' + msgOf(e))
          return
        }
        var ts = {
          kind: kind,
          spec: spec,
          sb: sb,
          initBytes: null,
          initEnd: 0,
          timescale: 1000,
          scan: null,
          segIndex: [],
          appendQueue: [],
          appendBusy: false,
          drainResolvers: [],
          bytesFetched: 0,
          totalBytes: 0,
          reader: null,
          fetchActive: false,
          firstAppend: false,
          triedOpen: false,
        }
        ts.scan = makeScanner(0, function (off, t) {
          ts.segIndex.push({ off: off, t: t })
        })
        wireSourceBuffer(ts)
        state[kind] = ts
      }
      if (!state.video) fail('没有可用的 video 分轨')
    }

    function wireSourceBuffer(ts) {
      ts.sb.addEventListener('updateend', function () {
        ts.appendBusy = false
        if (ts.drainResolvers.length) {
          var resolvers = ts.drainResolvers
          ts.drainResolvers = []
          for (var i = 0; i < resolvers.length; i += 1) resolvers[i]()
        }
        pumpAppends(ts)
        if (pendingSeek !== null && state.video) {
          var target = pendingSeek
          if (covers(state.video, target) && (!state.audio || covers(state.audio, target))) {
            applyPendingSeek()
          }
        }
      })
      ts.sb.addEventListener('error', function () {
        if (!destroyed) fail('SourceBuffer 解码出错')
      })
    }

    // ── append 队列 ──
    function enqueueAppend(ts, bytes) {
      if (destroyed || !bytes || bytes.length === 0) return
      ts.appendQueue.push(bytes)
      pumpAppends(ts)
    }
    function pumpAppends(ts) {
      if (ts.appendBusy || ts.appendQueue.length === 0 || ts.sb.updating) return
      ts.appendBusy = true
      var bytes = ts.appendQueue.shift()
      try {
        ts.sb.appendBuffer(bytes)
        ts.firstAppend = true
      } catch (e) {
        ts.appendBusy = false
        if (e && e.name === 'QuotaExceededError') {
          // 配额不足：对称回收后重试当前这一块（先放回队首）
          ts.appendQueue.unshift(bytes)
          evictSymmetrically(function () {
            pumpAppends(ts)
          })
          return
        }
        fail('append 失败：' + msgOf(e))
      }
    }
    function whenAppendsSettled(ts) {
      return new Promise(function (resolve) {
        if (!ts.appendBusy && ts.appendQueue.length === 0) {
          resolve()
          return
        }
        ts.drainResolvers.push(resolve)
      })
    }

    // ── 配额 / 对称回收 ──
    function evictSymmetrically(done) {
      var cur = currentTime()
      var pending = 0
      var finished = 0
      function onDone() {
        finished += 1
        if (finished >= pending) {
          if (typeof done === 'function') done()
        }
      }
      for (var i = 0; i < order.length; i += 1) {
        var ts = state[order[i]]
        if (!ts) continue
        var endB = bufferedEnd(ts)
        if (!isFinite(endB) || endB <= 0) continue
        var keepFrom = Math.max(cur - evictBehind, 0)
        if (keepFrom >= endB) continue
        pending += 1
        try {
          ts.sb.remove(0, keepFrom)
          // remove 异步完成（updateend），挂在已经有的 drain 上
          waitDrain(ts).then(onDone)
        } catch (e) {
          onDone()
        }
      }
      if (pending === 0) {
        if (typeof done === 'function') done()
      }
    }
    function waitDrain(ts) {
      return new Promise(function (resolve) {
        if (!ts.sb.updating) {
          resolve()
          return
        }
        ts.drainResolvers.push(resolve)
      })
    }

    // ── 分轨：取 init → 建索引 → 流式 append ──
    var PROBE = 1 << 20 // 1 MiB 探针

    /**
     * 带超时的 fetch。**只等响应头**，不等整个 body——所以对「拉 init 探针」和
     * 「开始拉媒体流」都能兜住「请求永远不返回」的情况（例如 CORS 预检卡死时
     * fetch 会一直 pending；没有超时就会永远停在“高清播放中”却没有任何画面）。
     */
    function fetchOnce(url, init, timeoutMs) {
      if (!fetchFn) return Promise.reject(new Error('fetch 不可用'))
      var ms = Number(timeoutMs) || 20000
      return new Promise(function (resolve, reject) {
        var settled = false
        var timer = global.setTimeout(function () {
          if (settled) return
          settled = true
          reject(new Error('请求超时（' + Math.round(ms / 1000) + 's）'))
        }, ms)
        function done(fn) {
          return function (value) {
            if (settled) return
            settled = true
            try {
              global.clearTimeout(timer)
            } catch (e) {
              /* ignore */
            }
            fn(value)
          }
        }
        Promise.resolve(fetchFn(url, init)).then(done(resolve), done(reject))
      })
    }

    function fetchRange(url, start, end) {
      if (!fetchFn) return Promise.reject(new Error('fetch 不可用'))
      var r = 'bytes=' + (start >= 0 ? start : 0) + '-'
      if (end !== undefined && end >= 0) r += end
      return fetchOnce(url, { cache: 'no-store', headers: { Range: r } }).then(function (res) {
        if (!res || !res.ok) throw new Error('http ' + (res && res.status))
        var buf = res.arrayBuffer ? res.arrayBuffer() : Promise.resolve(res)
        return buf
      })
    }

    function fetchInit(ts) {
      return fetchRange(ts.spec.media, 0, PROBE)
        .then(function (ab) {
          var bytes = u8(ab)
          var initEnd = initEndOf(bytes)
          if (initEnd <= 0) throw new Error('该分轨没有可用 init 段')
          if (initEnd > bytes.length) {
            // 探针没装下整个 moov：按需补齐
            return fetchRange(ts.spec.media, 0, initEnd - 1).then(function (fullAb) {
              var full = u8(fullAb)
              ts.initBytes = full.subarray(0, initEndOf(full) || initEnd)
              ts.initEnd = ts.initBytes.length
            })
          }
          ts.initBytes = bytes.subarray(0, initEnd)
          ts.initEnd = initEnd
        })
        .then(function () {
          ts.timescale = mediaTimescaleOf(ts.initBytes) || 1000
          // 重置索引（基准 0；媒体流从 initEnd 起读时会把 initEnd 计入_consumed）
          resetScanner(ts, 0)
          enqueueAppend(ts, ts.initBytes)
          return whenAppendsSettled(ts)
        })
    }

    /** 以注册的 moof 回调重建 scanner 与索引，基准偏移 = base。 */
    function resetScanner(ts, base) {
      ts.segIndex = []
      ts.scan = makeScanner(ts.timescale, function (off, t) {
        ts.segIndex.push({ off: off, t: t })
      }, base)
    }

    /** 从绝对字节偏移 fromOffset 起流式拉取一条轨（媒体部分）。调用方需先 resetScanner(fromOffset)。 */
    function startTrackFetch(ts, fromOffset) {
      if (destroyed || ts.fetchActive) return
      ts.fetchActive = true
      return fetchOnce(ts.spec.media, {
        cache: 'no-store',
        headers: { Range: 'bytes=' + fromOffset + '-' },
      })
        .then(function (res) {
          if (destroyed) return
          if (!res || !res.ok) throw new Error('http ' + (res && res.status))
          if (res.headers && res.headers.get) {
            var cl = Number(res.headers.get('content-length'))
            if (isFinite(cl)) ts.totalBytes = fromOffset + cl
          }
          if (res.body && typeof res.body.getReader === 'function') {
            ts.reader = res.body.getReader()
            return pumpReader(ts)
          }
          // 没有流式 body（代理兜底）→ 一次读完
          return res.arrayBuffer().then(function (ab) {
            if (destroyed) return
            ts.totalBytes = fromOffset + ab.byteLength
            feedChunk(ts, u8(ab))
            ts.readDone = true
            return whenAppendsSettled(ts).then(function () {
              maybeEndOfStream()
            })
          })
        })
        .catch(function (e) {
          if (destroyed) return
          fail('分轨下载失败：' + msgOf(e))
        })
    }

    /** 两条轨都读到文件尾、且 append 都排空后，告诉 MediaSource 结束——这样才会触发 ended/轮播。 */
    function maybeEndOfStream() {
      if (destroyed) return
      var pending = []
      for (var i = 0; i < order.length; i += 1) {
        var ts = state[order[i]]
        if (!ts) continue
        if (!ts.readDone) return
        pending.push(whenAppendsSettled(ts))
      }
      if (!pending.length) return
      Promise.all(pending).then(function () {
        if (destroyed) return
        try {
          if (mediaSource && mediaSource.readyState === 'open') mediaSource.endOfStream()
        } catch (e) {
          /* ignore */
        }
      })
    }

    function pumpReader(ts) {
      function step() {
        if (destroyed || !ts.reader) return
        ts.reader.read().then(
          function (r) {
            if (destroyed || !ts.reader) return
            if (r.done) {
              ts.reader = null
              ts.readDone = true
              whenAppendsSettled(ts).then(maybeEndOfStream)
              return
            }
            feedChunk(ts, u8(r.value))
            // 背压：等 append 队列排空再读下一块，避免内存无限膨胀
            whenAppendsSettled(ts).then(step)
          },
          function (e) {
            if (destroyed) return
            fail('分轨下载中断：' + msgOf(e))
          },
        )
      }
      step()
      return whenAppendsSettled(ts)
    }

    function feedChunk(ts, bytes) {
      if (destroyed || !bytes || bytes.length === 0) return
      ts.bytesFetched += bytes.length
      try {
        ts.scan.feed(bytes)
      } catch (e) {
        /* 索引失败不影响播放 */
      }
      enqueueAppend(ts, bytes)
    }

    // ── 加载入口 ──
    function load() {
      if (!isObj(tracks)) {
        fail('tracks 缺失')
        return
      }
      setStatus('starting', '连接 MediaSource…')
      // 初始化看门狗：MediaSource/fetch 任意一步卡住（预检挂死、端口不通而不报错等）
      // 都要在限定时间内转成失败，从而让上层回退 720p；绝不能停在“高清播放中”没画面。
      var watchdog = global.setTimeout(function () {
        if (!destroyed && !loadSettled) fail('高清初始化超时（没能在 20 秒内开始缓冲）')
      }, 20000)
      var loadSettled = false
      attachMediaSource()
        .then(function () {
          if (destroyed) return
          addSourceBuffers()
          if (destroyed) return
          setStatus('buffering', '正在加载 init 段…')
          var inits = []
          for (var i = 0; i < order.length; i += 1) {
            var ts = state[order[i]]
            if (ts) inits.push(fetchInit(ts))
          }
          return Promise.all(inits).then(function () {
            if (destroyed) return
            loadSettled = true
            try {
              global.clearTimeout(watchdog)
            } catch (e) {
              /* ignore */
            }
            try {
              mediaSource.duration = duration > 0 ? duration : NaN
            } catch (e) {
              /* ignore */
            }
            setStatus('ready', 'init 就绪，开始缓冲')
            for (var j = 0; j < order.length; j += 1) {
              var t2 = state[order[j]]
              if (t2) {
                resetScanner(t2, t2.initEnd)
                startTrackFetch(t2, t2.initEnd)
              }
            }
            scheduleEvict()
          })
        })
        .catch(function (e) {
          loadSettled = true
          try {
            global.clearTimeout(watchdog)
          } catch (e2) {
            /* ignore */
          }
          if (!destroyed) fail('MSE 初始化失败：' + msgOf(e))
        })
    }

    function scheduleEvict() {
      if (evictTimer !== null) return
      evictTimer = global.setInterval(function () {
        if (destroyed) {
          clearInterval(evictTimer)
          evictTimer = null
          return
        }
        if (video && !video.paused) evictSymmetrically()
      }, 5000)
    }

    // ── seek ──
    function seekTo(t) {
      var target = clamp(Number(t) || 0, 0, duration > 0 ? duration : 1e9)
      if (!state.video) {
        pendingSeek = target
        return
      }
      if (covers(state.video, target) && (!state.audio || covers(state.audio, target))) {
        try {
          video.fastSeek ? video.fastSeek(target) : (video.currentTime = target)
        } catch (e) {
          try {
            video.currentTime = target
          } catch (e2) {
            /* ignore */
          }
        }
        return
      }
      // 硬 seek：两轨对称 flush + 从目标前最近的关键帧字节偏移重填
      pendingSeek = target
      var v = state.video
      var a = state.audio
      restartTrack(v, target)
      if (a) restartTrack(a, target)
    }

    /**
     * 目标时间之前最近的已建分片偏移；有精确 moof 索引就返回 exact=true，
     * 否则按总字节占比估算（exact=false，调用方会再探 moof 边界修正）。
     */
    function refillOffset(ts, target) {
      var best = null
      for (var i = 0; i < ts.segIndex.length; i += 1) {
        var e = ts.segIndex[i]
        if (e.t <= target && (!best || e.t > best.t)) best = e
      }
      if (best) return { offset: best.off, exact: true }
      if (duration > 0 && ts.totalBytes > 0) {
        var est = Math.max(ts.initEnd, Math.floor((target / duration) * ts.totalBytes))
        return { offset: est, exact: false }
      }
      return { offset: ts.initEnd, exact: false }
    }

    /**
     * 硬 seek 的整条轨重建：先按旧索引算出回填偏移（在清空索引**之前**），
     * 停旧流 → 对称 flush（remove 整条）→ 重 app init → 从偏移起重拉媒体。
     */
    function restartTrack(ts, target) {
      if (!ts) return
      var refill = refillOffset(ts, target)
      var hadBuffered = isFinite(bufferedEnd(ts)) && bufferedEnd(ts) > 0
      // 停旧下载 / 清 pending append
      if (ts.reader) {
        try {
          ts.reader.cancel && ts.reader.cancel()
        } catch (e) {
          /* ignore */
        }
        ts.reader = null
      }
      ts.fetchActive = false
      ts.appendQueue = []
      ts.drainResolvers = []
      ts.readDone = false
      // 对称 flush
      if (hadBuffered) {
        try {
          ts.sb.remove(0, bufferedEnd(ts))
        } catch (e) {
          hadBuffered = false
        }
      }
      // 先重放 init，再接 flush 收尾后从回填点拉媒体
      if (ts.initBytes) enqueueAppend(ts, ts.initBytes)
      var gate = hadBuffered ? waitDrain(ts) : whenAppendsSettled(ts)
      gate.then(function () {
        if (destroyed) return
        if (refill.exact) {
          resetScanner(ts, refill.offset)
          startTrackFetch(ts, refill.offset)
          return
        }
        // 只有估算偏移：先探一小段、在真实字节里找最近的 moof 边界，避免落在 mdat 中间
        // 导致 append 出坏数据。找不到就退回估算值，至少不崩。
        probeMoofBoundary(ts, refill.offset, target)
          .then(function (offset) {
            if (destroyed) return
            resetScanner(ts, offset)
            startTrackFetch(ts, offset)
          })
          .catch(function () {
            if (destroyed) return
            resetScanner(ts, refill.offset)
            startTrackFetch(ts, refill.offset)
          })
      })
    }

    /**
     * 从估算偏移拉一小段，在字节里搜 'moof' 并解析其 tfdt，挑**时间 <= target 的最近一个**
     * 的 box 起点作为真正回填点；一个都没有就返回第一个找到的 moof。
     */
    function probeMoofBoundary(ts, estimate, target) {
      var PROBE_BYTES = 512 * 1024
      var start = Math.max(ts.initEnd, estimate)
      return fetchOnce(ts.spec.media, {
        cache: 'no-store',
        headers: { Range: 'bytes=' + start + '-' + (start + PROBE_BYTES - 1) },
      })
        .then(function (res) {
          if (!res || !res.ok) throw new Error('probe http ' + (res && res.status))
          return res.arrayBuffer ? res.arrayBuffer() : res
        })
        .then(function (ab) {
          var bytes = u8(ab)
          var pick = findMoofBoundary(bytes, start, ts.timescale, target)
          if (!pick) throw new Error('probe 未找到 moof 边界')
          return pick.off
        })
    }

    function applyPendingSeek() {
      if (pendingSeek === null || !state.video) return
      var t = pendingSeek
      pendingSeek = null
      try {
        video.fastSeek ? video.fastSeek(t) : (video.currentTime = t)
      } catch (e) {
        /* ignore */
      }
    }

    // ── 失败 / 销毁 ──
    function msgOf(e) {
      return e && e.message ? e.message : String(e)
    }
    function fail(reason) {
      if (destroyed) return
      destroyed = true
      teardownInternal()
      setStatus('fallback', reason)
      try {
        onFallback(reason)
      } catch (e) {
        /* ignore */
      }
    }
    function teardownInternal() {
      if (evictTimer !== null) {
        clearInterval(evictTimer)
        evictTimer = null
      }
      for (var i = 0; i < order.length; i += 1) {
        var ts = state[order[i]]
        if (!ts) continue
        ts.reader = null
        ts.appendQueue = []
        ts.drainResolvers = []
      }
      try {
        if (mediaSource && mediaSource.readyState !== 'closed') mediaSource.endOfStream()
      } catch (e) {
        /* ignore */
      }
    }

    return {
      load: load,
      seek: seekTo,
      play: function () {
        try {
          if (video) video.play()
        } catch (e) {
          /* ignore */
        }
      },
      destroy: function () {
        destroyed = true
        teardownInternal()
        for (var i = 0; i < order.length; i += 1) {
          var ts = state[order[i]]
          if (!ts || !ts.sb) continue
          try {
            ts.sb.abort()
          } catch (e) {
            /* ignore */
          }
        }
        try {
          if (mediaSource && mediaSource.readyState === 'open') mediaSource.endOfStream()
        } catch (e) {
          /* ignore */
        }
        if (objectUrl && global.URL && global.URL.revokeObjectURL) {
          try {
            global.URL.revokeObjectURL(objectUrl)
          } catch (e) {
            /* ignore */
          }
        }
      },
    }
  }

  function isObj(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  }

  global.__DSH_BILI_DASH__ = {
    version: '1.0.0',
    supported: function () {
      try {
        return typeof global.MediaSource === 'function' && !!(global.URL && typeof global.URL.createObjectURL === 'function')
      } catch (e) {
        return false
      }
    },
    create: create,
    // 纯解析工具（供单测 / 排查）
    _boxHeaderAt: boxHeaderAt,
    _initEndOf: initEndOf,
    _mediaTimescaleOf: mediaTimescaleOf,
    _moofDecodeTime: moofDecodeTime,
    _makeScanner: makeScanner,
    _findMoofBoundary: findMoofBoundary,
  }
})(typeof window !== 'undefined' ? window : globalThis)
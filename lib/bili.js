/**
 * dsh-bili-bg — B 站接口客户端 + 播放流代理（宿主侧）。
 *
 * 只用 node: 内建模块（无任何外部依赖）。三个事实决定实现：
 *   - 元数据（view）、热门（popular）、排行榜（ranking）**无需登录、无需签名**即可取；
 *   - playurl（platform=html5&fnval=16）**无需登录**即可拿到"音视频合一"的单文件 mp4（durl）；
 *   - 播放流 CDN 支持 Range（206 Partial Content），所以它能被本地代理以 <video>
 *     需要的语义喂给浏览器（可拖进度），代理时带上 Referer 头规避 CDN 防盗链。
 *
 * 清晰度取舍：不登录多数视频只能拿到 360p~720p（qn=64 优先，取不到自动降级）。
 * 登录拿高清留作二期；接口若日后变动，所有失败都抛结构化错误，由路由转成可读 JSON。
 */
import https from 'node:https'
import http from 'node:http'
import { signWbi } from './wbi.js'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'
export const REFERER = 'https://www.bilibili.com/'

const API = {
  view: 'https://api.bilibili.com/x/web-interface/view',
  playurl: 'https://api.bilibili.com/x/player/playurl',
  popular: 'https://api.bilibili.com/x/web-interface/popular',
  ranking: 'https://api.bilibili.com/x/web-interface/ranking/v2',
}

/** 单文件 mp4 的解析结果缓一缓，避免每个 Range 请求都重打接口。 */
const cache = new Map()
function cacheGet(key) {
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value
  if (hit) cache.delete(key)
  return undefined
}
function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expires: Date.now() + ttlMs })
  if (cache.size > 64) {
    const now = Date.now()
    for (const [k, v] of cache) if (v.expires <= now) cache.delete(k)
  }
}

/** 简单的 GET，自动跟随重定向（最多 5 跳），返回 {status, headers, body:Buffer}。 */
export async function get(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch (e) {
      reject(new Error(`invalid url: ${String(e?.message ?? e)}`))
      return
    }
    const mod = u.protocol === 'https:' ? https : http
    const outHeaders = { 'User-Agent': UA, Referer: REFERER, ...headers }
    if (process.env.DSH_BILI_DEBUG) {
      try {
        console.error('[bili-debug]', u.href, JSON.stringify(outHeaders))
      } catch {
        /* ignore */
      }
    }
    const req = mod.request(
      u,
      {
        method: 'GET',
        headers: outHeaders,
      },
      (res) => {
        const status = res.statusCode ?? 0
        const location = res.headers?.location
        if (status >= 300 && status < 400 && location) {
          res.resume()
          if (redirects >= 5) {
            res.destroy()
            reject(new Error(`too many redirects: ${url}`))
            return
          }
          let next
          try {
            next = new URL(location, url).toString()
          } catch (e) {
            reject(new Error(`bad redirect location: ${String(e?.message ?? e)}`))
            return
          }
          resolve(get(next, headers, redirects + 1))
          return
        }
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size > 64 * 1024 * 1024) {
            res.destroy()
            reject(new Error('response too large'))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', (e) => reject(e))
      },
    )
    req.on('error', (e) => reject(e))
    req.end()
  })
}

/** B 站风控/限流类错误码：值得隔一会儿重试一次（62012/-352 等都是瞬时风控）。 */
const RETRYABLE_CODES = new Set([62012, -412, -799, -504, -509, -352])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 风控类错误面向用户的友好文案，避免把原始 JSON 甩到面板上。 */
const FRIENDLY_ERRORS = {
  '-352': 'B 站风控/请求过快（-352），请稍后重试',
  '-412': 'B 站请求被拦截（-412），请稍后重试或先登录',
  '-799': 'B 站请求过于频繁（-799），请稍后重试',
}

function apiError(code, message, snippet) {
  const err = new Error(`bilibili api error ${code}: ${message} :: ${snippet}`)
  err.code = code
  if (RETRYABLE_CODES.has(code)) err.retryable = true
  return err
}

/** 把内部错误转成面板可读文案（风控类给友好提示，其余保留原 message）。 */
export function friendlyError(error) {
  const code = error && error.code
  if (code !== undefined && FRIENDLY_ERRORS[String(code)]) return FRIENDLY_ERRORS[String(code)]
  if (error && typeof error.message === 'string' && error.message) return error.message
  return String(error)
}

/** 拿 JSON，非 2xx 或 code!==0 时抛结构化错误；风控类错误自动重试一次。 */
export async function apiJson(url, headers = {}) {
  let lastErr
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await apiJsonOnce(url, headers)
    } catch (e) {
      lastErr = e
      if (attempt === 0 && e && e.retryable) {
        // -352 风控通常 ttl 1s 左右，多等一会儿再试，别 450ms 就撞上去。
        await sleep(e.code === -352 ? 1300 : 450)
        continue
      }
      throw e
    }
  }
  throw lastErr
}

async function apiJsonOnce(url, headers = {}) {
  const res = await get(url, headers)
  let parsed
  const text = res.body.toString('utf8')
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`bilibili api returned non-json (http ${res.status}): ${url} :: ${text.slice(0, 120)}`)
  }
  if (res.status < 200 || res.status >= 300) {
    const msg = parsed?.message || `http ${res.status}`
    const err = new Error(`bilibili api http ${res.status}: ${msg}`)
    if (res.status === 412 || res.status === 503) err.retryable = true
    throw err
  }
  if (parsed?.code !== 0) {
    const msg = parsed?.message || `code ${parsed?.code}`
    throw apiError(parsed?.code, msg, text.slice(0, 300))
  }
  return parsed.data
}

function bvidFromInput(input) {
  const s = String(input ?? '').trim()
  if (!s) return ''
  // 兼容完整链接 / 纯 BV 号 / 带 query。注意：**BV 号区分大小写**，后面 10 位必须原样保留，
  // 只把前缀 "bv" 规整成 "BV"（早先误把整串 toUpperCase ⇒ BV1GJ411X7H7 ⇒ code 62012）。
  const m = s.match(/[bB][vV][0-9A-Za-z]+/)
  if (m) return 'BV' + m[0].slice(2)
  return ''
}

/** 让解析结果的 src 走同一个路由（避免散落的魔数）。单文件 = media?bvid&cid。 */
function singleFileSrc(bvid, cid) {
  return `/dsh-bili/media?bvid=${encodeURIComponent(bvid)}&cid=${cid}`
}

/** 解析一个视频的元数据（view）。接受 bvid 或 aid。返回 {ok, ...meta}，含分P列表。 */
async function resolveView(input) {
  const bvid = bvidFromInput(input)
  let view
  if (bvid) {
    view = await apiJson(`${API.view}?bvid=${bvid}`)
  } else if (/^\d+$/.test(String(input).trim())) {
    view = await apiJson(`${API.view}?aid=${String(input).trim()}`)
  } else {
    return { ok: false, error: '未能从输入中识别出 BV 号或视频链接' }
  }
  const pages = Array.isArray(view.pages) && view.pages.length
    ? view.pages.map((p, i) => ({
        page: Number(p.page) || i + 1,
        cid: Number(p.cid) || 0,
        part: p.part || '',
        duration: p.duration || 0,
      }))
    : []
  return {
    ok: true,
    bvid: view.bvid || bvid,
    aid: view.aid,
    cid: view.cid,
    title: view.title || '',
    pic: view.pic || '',
    duration: view.duration || 0,
    owner: view.owner?.name || '',
    tname: view.tname || '',
    pages,
  }
}

/** 按分P序号（1-based）取该 P 的 cid；越界或没有 pages 时回退到整片默认 cid。 */
function pickPageCid(view, pid) {
  const n = Math.floor(Number(pid) || 0)
  if (n >= 1 && Array.isArray(view.pages) && view.pages[n - 1] && view.pages[n - 1].cid) {
    return view.pages[n - 1].cid
  }
  return view.cid || 0
}

/** 取两个播放源的公共可读描述；失败时 meta 兜底给前端展示用。 */
function playFailure(error, v, cid) {
  return { ok: false, error, meta: { bvid: v.bvid, title: v.title, cid } }
}

/** 解析一个视频：元数据 + 单文件 mp4 播放源。接受 bvid/aid，`pid` 为分P序号（1-based）。 */
export async function resolveBvid(input, pid) {
  const v = await resolveView(input)
  if (!v.ok) return v
  const cid = pickPageCid(v, pid)
  let play
  try {
    play = await resolvePlay(v.bvid, cid)
  } catch (e) {
    return playFailure(`获取播放源失败：${e?.message ?? e}`, v, cid)
  }
  if (!play.url) {
    return playFailure(play.error || '该视频没有可用的 HTML5 播放源（可能需要登录）', v, cid)
  }

  return {
    ok: true,
    bvid: v.bvid,
    aid: v.aid,
    cid,
    title: v.title,
    pic: v.pic,
    duration: v.duration,
    owner: v.owner,
    quality: play.quality,
    format: play.format || 'mp4',
    tname: v.tname,
    pages: v.pages,
    src: singleFileSrc(v.bvid, cid),
  }
}

/** 取播放源：playurl(platform=html5&fnval=16) → durl[0].url。qn 从高到低降级。 */
export async function resolvePlay(bvid, cid) {
  const key = `${bvid}|${cid}`
  const hit = cacheGet(key)
  if (hit) return hit
  const qns = [64, 32, 16]
  let lastErr = null
  for (const qn of qns) {
    const url = `${API.playurl}?bvid=${bvid}&cid=${cid}&qn=${qn}&fnval=16&platform=html5&high_quality=1`
    try {
      const data = await apiJson(url)
      const durl = data?.durl
      if (Array.isArray(durl) && durl.length > 0 && durl[0].url) {
        const result = { url: durl[0].url, quality: data.quality ?? qn, format: data.format || 'mp4' }
        cacheSet(key, result, 60_000)
        return result
      }
      if (data?.dash && Array.isArray(data.dash.video) && data.dash.video.length > 0) {
        // 说明该视频在当前登录态下只给 DASH 分轨 —— 无登录下我们不做 MSE 混流，
        // 但可退回最低 qn 再试一次；仍不行就明确报"需登录/仅 DASH"。
        lastErr = new Error('该视频当前仅提供 DASH 分轨（通常需登录），暂不支持无登录播放')
      }
    } catch (e) {
      lastErr = e
    }
  }
  const err = lastErr ?? new Error('no playable source')
  return { url: '', quality: 0, error: err.message }
}

/**
 * 代理播放流：本路由带着 bvid/cid 解析出 CDN mp4，再按 Range 语义转发，
 * 让浏览器 <video> 能正常加载/拖进度。每次请求独立解析（有 60s 缓存兜底）。
 * @returns {Promise<{status:number, headers:Record<string,string>, stream:import('node:stream').Readable} | {error:string}>}
 */
export async function openMediaStream(bvid, cid, range) {
  const play = await resolvePlay(bvid, cid)
  if (!play.url) return { error: play.error || 'no playable source' }
  return requestStream(play.url, range, 0)
}

/** 带 Range 的流请求；跟随一到两跳 CDN 重定向。 */
function requestStream(url, range, redirects) {
  return new Promise((resolve, reject) => {
    if (redirects > 2) {
      reject(new Error('too many media redirects'))
      return
    }
    let u
    try {
      u = new URL(url)
    } catch (e) {
      reject(e)
      return
    }
    const mod = u.protocol === 'https:' ? https : http
    const headers = { 'User-Agent': UA, Referer: REFERER }
    if (range) headers.Range = range
    const req = mod.request(u, { method: 'GET', headers }, (res) => {
      const status = res.statusCode ?? 0
      const location = res.headers?.location
      if (status >= 300 && status < 400 && location) {
        res.resume()
        let next
        try {
          next = new URL(location, url).toString()
        } catch (e) {
          reject(e)
          return
        }
        resolve(requestStream(next, range, redirects + 1))
        return
      }
      resolve({ status, headers: res.headers, stream: res })
    })
    req.on('error', reject)
    req.end()
  })
}

// ────────────────────────────── 登录后高清（DASH 分轨）──────────────────────────────
//
// >720p 走 DASH（fnval=4048 的 fMP4），视频/音频是两条 m4s 各自带 init 段，
// 由浏览器端 MSE 挂两个 SourceBuffer 混流。这里只负责：带登录 Cookie 请求 playurl、
// 把 mp4 / m4s 的 baseUrl 归一化成一致的 track 数组、按 Range 代理某一条轨。
// 归一化用同一个函数，保证「play 路由给客户的 index」和「media 路由按 index 取轨」对齐。

/** 请求 DASH 用到的 qn（从高到低优先取），qn 越大画质越高。80=1080P，112=1080P高码率，116=1080P60。 */
export const DASH_QN = [80, 112, 116]

/** DASH playurl 的 fnval：启用 fMP4 分轨（视频/音频分离）。 */
const FNVAL_DASH = 4048

/**
 * 把 B 站 playurl 的 data.dash 归整成「有 baseUrl 的轨」数组，并保持**稳定顺序**：
 * video / audio 各自按原数组序给出；两端（resolveDash 与 openDashMedia）都用这份，
 * 因此 index 一定对齐。丢掉 baseUrl 为空的轨（CIP 只给防盗链地址等情况）。
 */
export function normalizeDash(dash) {
  if (!dash) return null
  const pick = (u) => (typeof u === 'string' && u ? u : '')
  const video = (Array.isArray(dash.video) ? dash.video : [])
    .map((v) => ({
      id: v.id || 0,
      baseUrl: pick(v.baseUrl),
      backupUrl: (Array.isArray(v.backupUrl) ? v.backupUrl : []).map(pick).filter(Boolean),
      codecs: v.codecs || '',
      mimeType: v.mimeType || '',
      width: v.width || 0,
      height: v.height || 0,
      bandwidth: v.bandwidth || 0,
      frameRate: v.frameRate || '',
      sar: v.sar || '',
    }))
    .filter((t) => t.baseUrl)
  const audio = (Array.isArray(dash.audio) ? dash.audio : [])
    .map((a) => ({
      id: a.id || 0,
      baseUrl: pick(a.baseUrl),
      backupUrl: (Array.isArray(a.backupUrl) ? a.backupUrl : []).map(pick).filter(Boolean),
      codecs: a.codecs || '',
      mimeType: a.mimeType || '',
      bandwidth: a.bandwidth || 0,
    }))
    .filter((t) => t.baseUrl)
  return { duration: dash.duration || 0, video, audio }
}

/**
 * 带登录 Cookie 请求 playurl(DASH)，归一化分轨。不复用 fnval=16 的单文件缓存的 key。
 * 任何非 0 code / 无 dash 都返回 ok:false / hasDash:false，由上层决定回退。
 */
export async function resolveDash(bvid, cid, cookie, qn) {
  // 缓存 key 必须带「是否登录」：未登录拿不到高清，若不区分会把失败结果缓存下来，
  // 让紧接着的登录态请求也误判失败（15s）。cookie 本身不放进 key（敏感）。
  const key = `${bvid}|${cid}|dash|${qn}|${cookie ? 'auth' : 'anon'}`
  const hit = cacheGet(key)
  if (hit) return hit
  const qns = Array.from(new Set([Number(qn) || DASH_QN[0], ...DASH_QN])).filter(Number.isFinite)
  const headers = cookie ? { Cookie: cookie } : {}
  let lastErr = null
  for (const q of qns) {
    const url =
      `${API.playurl}?bvid=${bvid}&cid=${cid}&qn=${q}&fnval=${FNVAL_DASH}&fnver=0&fourk=1` +
      `&platform=html5&high_quality=1`
    try {
      const data = await apiJson(url, headers)
      const dash = normalizeDash(data && data.dash)
      const supportFormats = Array.isArray(data?.support_formats) ? data.support_formats : []
      if (dash && dash.video.length > 0 && dash.audio.length > 0) {
        const result = {
          ok: true,
          hasDash: true,
          quality: data.quality || q,
          supportFormats,
          dash,
        }
        cacheSet(key, result, 90_000)
        return result
      }
      lastErr = new Error('该视频当前无 DASH 分轨（或该清晰度不可用）')
    } catch (e) {
      lastErr = e
    }
  }
  const err = lastErr || new Error('no dash source')
  const result = { ok: false, hasDash: false, error: err.message, retryable: err.retryable === true }
  cacheSet(key, result, 15_000)
  return result
}

/** 带 Range 代理一条 DASH 分轨（video[0..] 或 audio[0..]），baseUrl → backupUrl 逐个试。 */
export async function openDashMedia(bvid, cid, kind, idx, range, cookie, qn) {
  const dash = await resolveDash(bvid, cid, cookie, Number(qn) || DASH_QN[0])
  if (!dash || !dash.ok || !dash.hasDash) return { error: (dash && dash.error) || 'no dash source' }
  const list = dash.dash && dash.dash[kind]
  const track = list && list[Number(idx)]
  if (!track) return { error: `dash ${kind}[${Number(idx)}] 不存在` }
  const urls = [track.baseUrl].concat(track.backupUrl || [])
  let lastErr = null
  for (const u of urls) {
    try {
      const stream = await requestStream(u, range, 0)
      if (stream && !stream.error && stream.status >= 200 && stream.status < 300) return stream
      if (stream && stream.stream) {
        try {
          stream.stream.destroy()
        } catch {
          /* ignore */
        }
      }
      lastErr = stream && stream.error ? stream.error : new Error(`http ${stream && stream.status}`)
    } catch (e) {
      lastErr = e
    }
  }
  return { error: 'DASH 分轨所有地址都不通：' + (lastErr ? lastErr.message : '') }
}

/**
 * 登录后高清解析：元数据 + DASH 分轨。返回 hd:true 带完整分轨描述；拿不到 DASH（未登录 /
 * 该清晰度无分轨 / 接口失败）时**自动回退单文件 mp4**，并用 fallback 字段告知前端，
 * 保证前端永远有得播、不白屏。qn 给客户端想要的清晰度，取不到自动降级。
 */
export async function resolveBvidHd(input, cookie, qn, pid) {
  const v = await resolveView(input)
  if (!v.ok) return v
  const requestedQn = Number(qn) || DASH_QN[0]
  const cid = pickPageCid(v, pid)
  const base = singleFileSrc(v.bvid, cid)
  // 回退：单文件 mp4（无需登录，低清但一定能播）。
  const fallbackSingle = (why) => resolvePlay(v.bvid, cid).then(
    (play) =>
      play.url
        ? {
            ok: true,
            hd: false,
            fallback: why,
            bvid: v.bvid,
            aid: v.aid,
            cid,
            title: v.title,
            pic: v.pic,
            duration: v.duration,
            owner: v.owner,
            tname: v.tname,
            quality: play.quality,
            format: play.format || 'mp4',
            pages: v.pages,
            src: base,
          }
        : playFailure(play.error || '无可用播放源', v, cid),
    (e) => playFailure(`获取播放源失败：${e?.message ?? e}`, v, cid),
  )
  if (!cookie) return fallbackSingle('高清（1080p+）需登录，已回退 720p 单文件')

  let dash
  try {
    dash = await resolveDash(v.bvid, cid, cookie, Number(qn) || DASH_QN[0])
  } catch (e) {
    return fallbackSingle(`DASH 解析失败（${e?.message ?? e}），已回退 720p`)
  }
  if (!dash.ok || !dash.hasDash) {
    return fallbackSingle(`此时拿不到高清分轨${dash && dash.error ? '：' + dash.error : ''}，已回退 720p`)
  }

  const videoTracks = dash.dash.video.map((t, index) => ({
    index,
    id: t.id,
    height: t.height,
    width: t.width,
    codecs: t.codecs,
    mimeType: t.mimeType,
    frameRate: t.frameRate,
    bandwidth: t.bandwidth,
    // 直连 mediaBase 会由前端拼上，qn 保持一致才能让 media 路由用同一份 dash 取绪索引。
    media: `${base}&kind=video&idx=${index}&qn=${requestedQn}`,
  }))
  const audioTracks = dash.dash.audio.map((t, index) => ({
    index,
    id: t.id,
    codecs: t.codecs,
    mimeType: t.mimeType,
    bandwidth: t.bandwidth,
    media: `${base}&kind=audio&idx=${index}&qn=${requestedQn}`,
  }))
  // 默认清晰度：≤1080p 里最高；没有就取最高的那条（可能 720p，作为尽力而为）。
  const byHeightDesc = videoTracks.slice().sort((a, b) => (b.height || 0) - (a.height || 0))
  const chosen = (videoTracks.find((t) => t.height <= 1080) || videoTracks[0]) || null

  return {
    ok: true,
    hd: true,
    bvid: v.bvid,
    aid: v.aid,
    cid,
    title: v.title,
    pic: v.pic,
    duration: v.duration,
    owner: v.owner,
    tname: v.tname,
    pages: v.pages,
    quality: chosen ? chosen.id : 0,
    height: chosen ? chosen.height : 0,
    codecs: chosen ? chosen.codecs : '',
    format: 'dash',
    qn: requestedQn,
    src: base,
    videoTracks,
    audioTracks,
    dash: {
      duration: dash.dash.duration || v.duration,
      defaultVideoIndex: chosen ? chosen.index : videoTracks.length ? videoTracks[0].index : 0,
      defaultAudioIndex: audioTracks.length ? audioTracks[0].index : 0,
    },
    supportFormats: dash.supportFormats,
  }
}

/** 热门/排行榜最近一次成功结果（失败回退用）。 */
const queueCache = new Map()

/**
 * 播放队列：source=popular(热门) | ranking(全站排行榜)
 * | danceup(宅舞区：专挑完整舞蹈投稿) | feed(首页推荐，需登录)。
 */
export async function fetchQueue(source, count, cookie, order) {
  const n = Math.min(Math.max(parseInt(count, 10) || 12, 1), 30)
  if (source === 'feed') {
    return fetchFeed(n, cookie)
  }
  if (source === 'danceup') {
    return fetchDanceUp(n, cookie, order)
  }
  let pick = 'popular'
  let url = `${API.popular}?ps=${n}&pn=1`
  if (source === 'ranking') {
    pick = 'ranking'
    url = `${API.ranking}?rid=0&type=all`
  }
  const cacheKey = pick + '|' + n
  try {
    const data = await apiJson(url)
    const list = Array.isArray(data?.list) ? data.list : []
    const out = []
    for (const it of list.slice(0, n)) {
      out.push({
        bvid: it.bvid || '',
        aid: it.aid,
        title: it.title || '',
        tname: it.tname || '',
        duration: it.duration || 0,
        pic: it.pic || '',
        owner: it.owner?.name || '',
      })
    }
    const result = { source: pick, list: out }
    if (out.length) {
      queueCache.set(cacheKey, { at: Date.now(), value: result })
      if (queueCache.size > 32) {
        const now = Date.now()
        for (const [k, v] of queueCache) if (now - v.at > 10 * 60 * 1000) queueCache.delete(k)
      }
    }
    return result
  } catch (error) {
    // 瞬时风控（-352/-412 等）可能把重试也打掉：回退到最近一次成功结果，别把列表清空。
    const hit = queueCache.get(cacheKey)
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value
    throw error
  }
}

// ────────────────────────── 舞蹈 UP主 精选（独立来源） ──────────────────────────
//
// 用户反馈：舞蹈区综合榜常混入官方/游戏 PV、十几秒切片，不是「专门跳舞的 UP主 的
// 完整一段舞」。B 站没有公开的「舞蹈 UP主排行榜」接口，UP主 space 接口匿名又被风控
// （-352），所以这里用**视频搜索**（可匿名 + wbi 签名，实测 code=0）按关键词取高点击
// 结果，再做三件事贴近需求：
//   · 只保留时长 ≥ 45s（完整一段，排除短切片）；
//   · 每个作者最多 2 条（避免整屏同一人，保证“多个 UP主”）；
//   · 关键词覆盖 宅舞/翻跳/街舞/舞蹈，合并去重。
const DANCEUP_KEYWORDS = ['宅舞', '翻跳']
const DANCEUP_MIN_SECONDS = 45
const DANCEUP_MAX_SECONDS = 1200
const DANCEUP_PER_AUTHOR = 2
/** 排序选项，对齐 B 站搜索原版：综合排序/最多播放/最新发布/最多弹幕/最多收藏。 */
const DANCEUP_ORDERS = ['totalrank', 'click', 'pubdate', 'dm', 'stow']
/** 舞区相关的分区名（typename）：宅舞/街舞/明星舞蹈/舞蹈综合…都含「舞」；搞笑/篮球/MMD/日常 会被排除。 */
function isDanceTypename(name) {
  return String(name || '').indexOf('舞') >= 0
}
/** 短时缓存：搜索接口有风控（连续请求会回 HTML），同一来源 60s 内复用，刷新/轮播不会反复打。 */
const danceUpCache = { at: 0, n: 0, order: '', list: null }

/** 取 nav 的 wbi_img：匿名时 code=-101，但 data.wbi_img 仍在，不能用 apiJson（它会抛错）。 */
async function fetchWbiKeys(headers) {
  try {
    const res = await get('https://api.bilibili.com/x/web-interface/nav', headers)
    const parsed = JSON.parse(res.body.toString('utf8'))
    const img = parsed && parsed.data && parsed.data.wbi_img
    if (img && img.img_url && img.sub_url) return img
  } catch {
    /* ignore */
  }
  return null
}

/** 搜索结果的 title 带 <em class="keyword"> 高亮标签和 HTML 实体，清洗成纯文本。 */
function stripSearchTitle(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 搜索返回时长形如 "3:46" / "1:02:03"，转秒；无法解析返回 0。 */
function searchDurationToSeconds(s) {
  const t = String(s || '').trim()
  if (/^\d+$/.test(t)) return Number(t)
  const parts = t.split(':').map((x) => Number(x))
  if (parts.some((x) => !isFinite(x))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return 0
}

/** 搜索被风控/失败时的兜底：用舞蹈区排行榜，按同一套「完整+舞区+作者去重」规则过滤。 */
async function appendDanceRegionFallback(out, seen, perAuthor, n) {
  let data
  try {
    data = await apiJson(`${API.ranking}?rid=129&type=all`)
  } catch {
    return
  }
  const list = Array.isArray(data && data.list) ? data.list : []
  for (const it of list) {
    if (out.length >= n) break
    if (!it || !it.bvid || seen.has(it.bvid)) continue
    if (!isDanceTypename(it.tname)) continue
    const sec = Number(it.duration) || 0
    if (sec > 0 && (sec < DANCEUP_MIN_SECONDS || sec > DANCEUP_MAX_SECONDS)) continue
    const author = it.owner?.name || ''
    const authorKey = author || 'mid:' + String(it.owner?.mid || '')
    const count = perAuthor.get(authorKey) || 0
    if (count >= DANCEUP_PER_AUTHOR) continue
    seen.add(it.bvid)
    perAuthor.set(authorKey, count + 1)
    out.push({
      bvid: it.bvid,
      aid: it.aid,
      title: it.title || '',
      tname: it.tname || '舞蹈',
      duration: sec,
      pic: it.pic || '',
      owner: author,
    })
  }
}

async function fetchDanceUp(n, cookie, order) {
  // 排序：对齐 B 站搜索（综合/最多播放/最新发布/最多弹幕/最多收藏），默认最新发布。
  const sortOrder = DANCEUP_ORDERS.indexOf(order) >= 0 ? order : 'pubdate'
  // 60s 内复用，避免刷新/轮播时把搜索接口打到风控。排序不同不共用缓存。
  if (
    danceUpCache.list &&
    danceUpCache.n === n &&
    danceUpCache.order === sortOrder &&
    Date.now() - danceUpCache.at < 60_000
  ) {
    return { source: 'danceup', list: danceUpCache.list.slice(0, n) }
  }
  const headers = cookie ? { Cookie: cookie } : {}
  const wbi = await fetchWbiKeys(headers)
  const out = []
  const seen = new Set()
  const perAuthor = new Map()
  for (let i = 0; i < DANCEUP_KEYWORDS.length && out.length < n; i += 1) {
    if (i > 0) await sleep(450) // 关键词之间留间隔，降低风控概率
    let data
    try {
      const signed = signWbi(
        { search_type: 'video', keyword: DANCEUP_KEYWORDS[i], order: sortOrder, page: 1 },
        wbi ? wbi.img_url : '',
        wbi ? wbi.sub_url : '',
      )
      data = await apiJson('https://api.bilibili.com/x/web-interface/search/type?' + signed.query, headers)
    } catch {
      continue // 某个关键词失败（含风控回 HTML）不影响其它关键词
    }
    const list = Array.isArray(data && data.result) ? data.result : []
    for (const it of list) {
      if (out.length >= n) break
      if (!it || !it.bvid || seen.has(it.bvid)) continue
      // 只要「跳舞」类分区，过滤掉搞笑/篮球/MMD/日常等噪声。
      if (!isDanceTypename(it.typename)) continue
      const sec = searchDurationToSeconds(it.duration)
      if (sec > 0 && (sec < DANCEUP_MIN_SECONDS || sec > DANCEUP_MAX_SECONDS)) continue
      const author = String(it.author || '')
      const authorKey = author || 'mid:' + String(it.mid || '')
      const count = perAuthor.get(authorKey) || 0
      if (count >= DANCEUP_PER_AUTHOR) continue
      seen.add(it.bvid)
      perAuthor.set(authorKey, count + 1)
      const pic = typeof it.pic === 'string' && it.pic ? (it.pic.charAt(0) === '/' ? 'https:' + it.pic : it.pic) : ''
      out.push({
        bvid: it.bvid,
        aid: it.aid,
        title: stripSearchTitle(it.title) || it.bvid,
        tname: it.typename || '舞蹈',
        duration: sec,
        pic,
        owner: author,
        mid: it.mid || 0,
      })
    }
  }
  // 搜索被风控/结果不足时，用舞蹈区排行榜补齐（仍然只取完整 + 舞区 + 每作者≤2）。
  if (out.length < n) await appendDanceRegionFallback(out, seen, perAuthor, n)
  if (out.length) {
    danceUpCache.at = Date.now()
    danceUpCache.n = n
    danceUpCache.order = sortOrder
    danceUpCache.list = out.slice()
  }
  return { source: 'danceup', list: out }
}

/**
 * 登录后的账号首页推荐（来源 source=feed）。
 *
 * 需要带 Cookie 请求 nav 拿 wbi_img，再用 wbi 签名请求首页推荐接口（data.item 列表）。
 * 未登录（无 cookie）时**不发起网络请求**，直接返回 needAuth，让面板提示"登录后可用"。
 * 接口结构以实际返回为准：把所有有 bvid 的条目规整成与热门/排行榜相同的队列项。
 */
export async function fetchFeed(count, cookie) {
  if (!cookie) return { source: 'feed', needAuth: true, list: [] }
  const n = Math.min(Math.max(parseInt(count, 10) || 12, 1), 30)
  const headers = { Cookie: cookie }
  // 拿当前 wbi_img（img_key/sub_key 会周期性轮换，现取现签最稳）。
  const nav = await apiJson('https://api.bilibili.com/x/web-interface/nav', headers)
  const wbi = nav && nav.wbi_img ? nav.wbi_img : {}
  const signed = signWbi(
    { ps: String(n), fresh_type: '4', fresh_idx: '1', brush: '0', homepage_ver: '1', y_num: '5' },
    wbi.img_url || '',
    wbi.sub_url || '',
  )
  const url = 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?' + signed.query
  const data = await apiJson(url, headers)
  const list = Array.isArray(data?.item) ? data.item : []
  const out = []
  for (const it of list.slice(0, n)) {
    if (!it || !it.bvid) continue
    out.push({
      bvid: it.bvid,
      aid: it.aid,
      title: it.title || '',
      tname: it.tname || '',
      duration: it.duration || 0,
      pic: it.pic || '',
      owner: it.owner?.name || '',
    })
  }
  return { source: 'feed', list: out }
}

/** 常见字符转义，供注入行的 toInlineJson 用（与 video-skin 的 route.js 同语义）。 */
export function toInlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export const ROUTE_PREFIX = '/dsh-bili'
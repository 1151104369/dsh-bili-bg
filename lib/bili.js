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

/** B 站风控/限流类错误码：值得隔几百毫秒重试一次（早先实测 62012 是瞬时的）。 */
const RETRYABLE_CODES = new Set([62012, -412, -799, -504, -509])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function apiError(code, message, snippet) {
  const err = new Error(`bilibili api error ${code}: ${message} :: ${snippet}`)
  if (RETRYABLE_CODES.has(code)) err.retryable = true
  return err
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
        await sleep(450)
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

/** 解析一个视频：元数据 + 播放源。接受 bvid 或 aid。 */
export async function resolveBvid(input) {
  const bvid = bvidFromInput(input)
  let view
  if (bvid) {
    view = await apiJson(`${API.view}?bvid=${bvid}`)
  } else if (/^\d+$/.test(String(input).trim())) {
    view = await apiJson(`${API.view}?aid=${String(input).trim()}`)
  } else {
    return { ok: false, error: '未能从输入中识别出 BV 号或视频链接' }
  }

  const cid = view.cid
  const effectiveBvid = view.bvid || bvid
  let play
  try {
    play = await resolvePlay(effectiveBvid, cid)
  } catch (e) {
    return {
      ok: false,
      error: `获取播放源失败：${e?.message ?? e}`,
      meta: { bvid: effectiveBvid, title: view.title, cid },
    }
  }
  if (!play.url) {
    return {
      ok: false,
      error: play.error || '该视频没有可用的 HTML5 播放源（可能需要登录）',
      meta: { bvid: effectiveBvid, title: view.title, cid },
    }
  }

  return {
    ok: true,
    bvid: effectiveBvid,
    aid: view.aid,
    cid,
    title: view.title,
    pic: view.pic || '',
    duration: view.duration || 0,
    owner: view.owner?.name || '',
    quality: play.quality,
    format: play.format || 'mp4',
    tname: view.tname || '',
    src: `/dsh-bili/media?bvid=${encodeURIComponent(effectiveBvid)}&cid=${cid}`,
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

/** 播放队列：source=popular(热门) | ranking(排行榜) | feed(首页推荐，需登录)。 */
export async function fetchQueue(source, count, cookie) {
  const n = Math.min(Math.max(parseInt(count, 10) || 12, 1), 30)
  if (source === 'feed') {
    return fetchFeed(n, cookie)
  }
  const pick = source === 'ranking' ? 'ranking' : 'popular'
  const url = pick === 'ranking' ? `${API.ranking}?rid=0&type=all` : `${API.popular}?ps=${n}&pn=1`
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
  return { source: pick, list: out }
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
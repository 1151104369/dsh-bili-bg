/**
 * dsh-bili-bg — 弹幕获取（宿主侧）。
 *
 * B 站弹幕接口 `x/v1/dm/list.so?oid=<cid>` 返回 **gzip 压缩的 XML**：`<d p="时间,模式,字号,颜色,…">内容</d>`。
 * 我们只依赖 node: 内建（zlib + ./bili.js 的 get），把 XML 解析成前端可用的数组：
 *   [{ t: 秒, mode, size, color, text }]
 * 解析失败 / 接口异常一律降级为 ok:false，前端据此隐藏弹幕层（绝不影响播放）。
 *
 * 接口本身不要求登录，但带上 Referer 更稳（bili.js 的 get 已内置 UA + Referer）。
 */

import zlib from 'node:zlib'
import { get } from './bili.js'

const DM_URL = 'https://api.bilibili.com/x/v1/dm/list.so'

/** 短时缓存（按 cid），避免 seek/重进反复拉：90s，和 playurl 一致。 */
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

/** 兜底上限：弹幕再多也只在内存留前 2000 条（够一场氛围弹幕；避免极端情况撑爆）。 */
const MAX_DANMAKU = 2000

/** 取一支视频（cid）的弹幕池。返回 {ok, count, list} 或 {ok:false, error}。 */
export async function fetchDanmaku(cid) {
  const id = String(cid || '').trim()
  if (!id) return { ok: false, error: '缺少 cid' }
  const cached = cacheGet(id)
  if (cached) return cached
  let res
  try {
    res = await get(`${DM_URL}?oid=${encodeURIComponent(id)}`)
  } catch (e) {
    return fail(`弹幕请求失败：${e?.message ?? e}`, id)
  }
  if (res.status < 200 || res.status >= 300) {
    return fail(`弹幕接口 http ${res.status}`, id)
  }
  let xml
  try {
    xml = decompressToXml(res.body, res.headers['content-encoding'])
  } catch {
    xml = res.body.toString('utf8')
  }
  if (!/\<d\b/i.test(xml)) {
    return fail('弹幕接口返回的不是预期 XML', id)
  }
  const list = parseDanmakuXml(xml, MAX_DANMAKU)
  const result = { ok: true, count: list.length, list }
  cacheSet(id, result, 90_000)
  return result
}

function fail(error, cid) {
  const result = { ok: false, error, count: 0, list: [] }
  cacheSet(cid, result, 15_000)
  return result
}

/**
 * 把接口返回的字节解成弹幕 XML。不同节点/时期会用 gzip 或 deflate（含 raw deflate）压缩，
 * 统一按「gzip → zlib-deflate → raw-deflate → brotli → 原文」的顺序逐个试，取第一个能解出 XML 的。
 */
function decompressToXml(body, encoding) {
  if (body.length < 2) throw new Error('empty body')
  const tries = [zlib.gunzipSync, zlib.inflateSync, zlib.inflateRawSync, zlib.brotliDecompressSync]
  for (const fn of tries) {
    let out
    try {
      out = fn(body)
    } catch {
      continue
    }
    const text = out.toString('utf8')
    if (/\<d\b/i.test(text)) return text
  }
  // 没压缩（或压缩形似但解不出 XML）：直接当明文返回，让调用方判断。
  if (!/^[\s\S]*</i.test(body.toString('latin1'))) throw new Error('not xml')
  return body.toString('utf8')
}

/** 解析 `<d p="...">text</d>`，p 的第 0 项是时间（秒），第 3 项是颜色。 */
function parseDanmakuXml(xml, cap) {
  const out = []
  const re = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const p = String(m[1] || '').split(',')
    const t = parseFloat(p[0])
    if (!isFinite(t)) continue
    out.push({
      t,
      mode: parseInt(p[1], 10) || 1,
      size: parseInt(p[2], 10) || 25,
      color: parseInt(p[3], 10) || 16777215,
      text: decodeEntities(m[2]),
    })
    if (out.length >= cap) break
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

export const DM_ROUTE_SUFFIX = '/dm'
/**
 * dsh-bili-bg — B 站 Web 端 WBI 签名（宿主侧）。
 *
 * 只依赖 node: 内建（crypto 的 md5）。B 站对部分接口（如首页推荐 top/feed/rcmd）
 * 要求带 wbi 签名的 wts + w_rid 参数：取 nav 返回的 wbi_img 的 img_key / sub_key，
 * 拼出 mixin key，把参数按字典序 URL 编码后 md5 加上后缀。
 *
 * 接口若变动导致签名被拒，只在这里抛错，由上层路由转成面板可读提示，不影响 DSH。
 */

import crypto from 'node:crypto'

/** B 站 mixinKeyEncTab：固定 64 位重排表，取其前 32 位拼出真实 img_key/sub_key。 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

function mixinKey(orig) {
  let s = ''
  for (const i of MIXIN_KEY_ENC_TAB) s += orig[i] ?? ''
  return s.slice(0, 32)
}

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex')
}

/**
 * 生成带 wbi 签名的查询参数（对象形式）。注意 B 站要求参数按字典序 + URL 编码后
 * 再拼接 w_rid；本函数把传入 params 与 wts 一起排序签名，返回可直接拼到 query
 * 的完整参数对象。
 *
 * @param {Record<string,string|number>} params 普通查询参数
 * @param {string} imgKey nav.wbi_img.img_url 里的 key
 * @param {string} subKey nav.wbi_img.sub_url 里的 key
 * @returns {{ params: Record<string,string>, query: string, wts: number }}
 */
export function signWbi(params, imgKey, subKey) {
  if (typeof imgKey !== 'string' || !imgKey || typeof subKey !== 'string' || !subKey) {
    throw new Error('缺少 wbi_img（需登录）')
  }
  // img_url 形如 https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png
  const keyOf = (u) => {
    const m = String(u).match(/\/([0-9a-f]{32})\.png$/i)
    return m ? m[1].toLowerCase() : ''
  }
  const ik = keyOf(imgKey)
  const sk = keyOf(subKey)
  if (!ik || !sk) throw new Error('wbi_img 解析失败')
  const mixin = mixinKey(ik + sk)
  const wts = Math.round(Date.now() / 1000)
  const merged = {}
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    merged[k] = String(v)
  }
  merged.wts = String(wts)
  const keys = Object.keys(merged).sort()
  const query = keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(merged[k])}`).join('&')
  const w_rid = md5(query + mixin)
  return { params: { ...merged, w_rid }, query: `${query}&w_rid=${encodeURIComponent(w_rid)}`, wts }
}
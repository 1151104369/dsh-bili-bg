/**
 * dsh-bili-bg — 检查更新（宿主侧）。
 *
 * 仓库没有打 tag / 发 release，所以用最稳的一条：
 *   GET https://raw.githubusercontent.com/<owner>/<repo>/master/package.json → version
 * （raw 域名匿名可访问、不占 GitHub API 的 60 次/小时匿名配额）。
 * 另外尽力取一次最新提交（api.github.com/commits，失败忽略），让面板能显示「最新提交」。
 *
 * 只用 node: 内建；任何失败都返回 ok:false，由前端提示，绝不影响播放。
 */

import { get } from './bili.js'

export const REPO_OWNER = '1151104369'
export const REPO_NAME = 'dsh-bili-bg'
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`
const RAW_PKG_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/master/package.json`
const COMMITS_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits?per_page=1`

/** 远端结果短时缓存：5 分钟，避免连点把 GitHub 打到限流。 */
const cache = { at: 0, value: null }
const CACHE_TTL = 5 * 60 * 1000

/** 解析 "0.10.4" / "v0.10.4" → [0,10,4]；非法返回 null。 */
export function parseVersion(text) {
  const m = String(text || '')
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)/i)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** a 比 b 新返回 1，旧返回 -1，相同返回 0；无法解析返回 null。 */
export function compareVersion(a, b) {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va || !vb) return null
  for (let i = 0; i < 3; i += 1) {
    if (va[i] > vb[i]) return 1
    if (va[i] < vb[i]) return -1
  }
  return 0
}

/** 取最新提交（失败不影响主流程）。 */
async function fetchLatestCommit() {
  try {
    const res = await get(COMMITS_API, { Accept: 'application/vnd.github+json' })
    if (res.status < 200 || res.status >= 300) return null
    const list = JSON.parse(res.body.toString('utf8'))
    const first = Array.isArray(list) ? list[0] : null
    if (!first) return null
    return {
      sha: String(first.sha || '').slice(0, 7),
      message: String((first.commit && first.commit.message) || '').split('\n')[0],
      date: String((first.commit && first.commit.committer && first.commit.committer.date) || ''),
    }
  } catch {
    return null
  }
}

/**
 * 检查更新：对比当前版本与 master 的 package.json。
 * @param {string} currentVersion 本地 VERSION
 * @returns {Promise<{ok:boolean, current:string, latest:string, hasUpdate:boolean, url:string, commit?:object, checkedAt:number, error?:string}>}
 */
export async function checkUpdate(currentVersion) {
  const current = String(currentVersion || '')
  if (cache.value && Date.now() - cache.at < CACHE_TTL) {
    return { ...cache.value, current, hasUpdate: compareVersion(cache.value.latest, current) === 1 }
  }
  let res
  try {
    res = await get(RAW_PKG_URL, { cache: 'no-store' })
  } catch (e) {
    return {
      ok: false,
      current,
      latest: '',
      hasUpdate: false,
      url: REPO_URL,
      checkedAt: Date.now(),
      error: `检查更新失败：${e && e.message ? e.message : String(e)}`,
    }
  }
  if (res.status < 200 || res.status >= 300) {
    return {
      ok: false,
      current,
      latest: '',
      hasUpdate: false,
      url: REPO_URL,
      checkedAt: Date.now(),
      error: `检查更新失败：GitHub 返回 http ${res.status}`,
    }
  }
  let latest = ''
  try {
    const pkg = JSON.parse(res.body.toString('utf8'))
    latest = typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    latest = ''
  }
  if (!latest) {
    return {
      ok: false,
      current,
      latest: '',
      hasUpdate: false,
      url: REPO_URL,
      checkedAt: Date.now(),
      error: '检查更新失败：远端 package.json 无法解析',
    }
  }
  const cmp = compareVersion(latest, current)
  const value = {
    ok: true,
    current,
    latest,
    hasUpdate: cmp === 1,
    url: REPO_URL,
    commit: await fetchLatestCommit(),
    checkedAt: Date.now(),
  }
  cache.at = Date.now()
  cache.value = value
  return value
}

/** 允许外部打开的站点（防把任意 URL 拼进系统命令）。 */
const ALLOWED_HOSTS = new Set(['github.com', 'www.github.com', 'raw.githubusercontent.com', 'gitee.com'])

/** 校验并归一化一个可外部打开的 URL；不在白名单返回 ''。 */
export function safeExternalUrl(input) {
  let u
  try {
    u = new URL(String(input || '').trim())
  } catch {
    return ''
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return ''
  return u.toString()
}

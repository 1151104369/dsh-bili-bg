/**
 * dsh-bili-bg — 账号登录态（宿主侧）：二维码登录、Cookie 持久化、账号信息、退出。
 *
 * 只依赖 node: 内建（fs/os/path/child_process + ./bili.js 的 get）。
 *
 * 安全约定（本阶段硬性要求）：
 *   - Cookie 是敏感凭证，存 $DSH_HOME/dsh-bili-bg-auth.json，写入时收紧文件权限
 *     （POSIX 0600；Windows 尽量用 icacls 去掉继承、只留当前用户，均 best-effort 不报错）；
 *   - 任何面向页面的接口**绝不回显 Cookie**，只回传昵称/头像等展示信息；
 *   - 绝不把 Cookie 写进日志。
 *
 * 一切失败优雅降级：读不到/损坏的配置文件当"未登录"处理，绝不让 DSH 起不来。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { get } from './bili.js'

const AUTH_FILE = 'dsh-bili-bg-auth.json'

// ────────────────────────────── 存储 ──────────────────────────────

function authPath(homeDir) {
  return path.join(homeDir, AUTH_FILE)
}

function loadAuth(homeDir) {
  try {
    const text = fs.readFileSync(authPath(homeDir), 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 收紧文件权限：POSIX 0600；Windows 尽力 icacls 去继承只留当前用户，失败无害。 */
function restrictFile(file) {
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* ignore */
  }
  if (process.platform !== 'win32') return
  try {
    const user = os.userInfo().username
    if (!user) return
    spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:(F)`], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5000,
    })
  } catch {
    /* ignore */
  }
}

function saveAuth(homeDir, auth) {
  try {
    fs.mkdirSync(homeDir, { recursive: true })
    fs.writeFileSync(authPath(homeDir), JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 })
    restrictFile(authPath(homeDir))
  } catch (e) {
    /* 存不下不影响 DSH；上层按"未登录"处理即可 */
  }
}

function clearAuth(homeDir) {
  try {
    fs.rmSync(authPath(homeDir), { force: true })
  } catch {
    /* ignore */
  }
}

// ────────────────────────────── 基础请求 ──────────────────────────────

/** 取 JSON，不校验 code（poll / nav 需要自己读 code）。网络/解析错误抛结构化 Error。 */
async function rawJson(url, headers = {}) {
  const res = await get(url, headers)
  let parsed
  const text = res.body.toString('utf8')
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`bilibili 返回非 JSON（http ${res.status}）：${text.slice(0, 120)}`)
  }
  return { status: res.status, headers: res.headers, parsed }
}

/** 取 JSON 的 data 字段，仅在 code===0 时成功（与 bili.apiJson 同语义，但用本模块 get）。 */
async function apiData(url, headers = {}) {
  const { parsed } = await rawJson(url, headers)
  if (!parsed || parsed.code !== 0) {
    throw new Error(parsed?.message || `bilibili code ${parsed?.code ?? '?'}`)
  }
  return parsed.data
}

// ────────────────────────────── 二维码登录 ──────────────────────────────

/** 向 passport 申请一个新的二维码（内容 + key）。 */
export async function generateQr() {
  const data = await apiData('https://passport.bilibili.com/x/passport-login/web/qrcode/generate')
  const url = typeof data?.url === 'string' ? data.url : ''
  const key = typeof data?.qrcode_key === 'string' ? data.qrcode_key : ''
  if (!url || !key) throw new Error('二维码生成接口返回异常')
  return { url, key }
}

/**
 * 轮询二维码状态。返回 {status, message}：
 *   'wait'（86101 未扫码）/ 'scanned'（86090 已扫码待确认）/ 'expired'（86038 失效）
 *   'ok'（0 成功，已落盘 Cookie）。
 * 网络错误/接口异常 → throw，由路由转成面板提示。
 */
export async function pollQr(key) {
  const { parsed } = await rawJson(
    `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`,
  )
  const code = parsed?.code
  const message = parsed?.message || ''
  if (code === 0) {
    const url = parsed?.data?.url
    return { status: 'ok', message: message || '登录成功', url: typeof url === 'string' ? url : '' }
  }
  if (code === 86101) return { status: 'wait', message: message || '等待扫码' }
  if (code === 86090) return { status: 'scanned', message: message || '已扫码，请在手机上确认' }
  if (code === 86038) return { status: 'expired', message: message || '二维码已过期' }
  // 其它错误码：当作过期/失败，让面板刷新一个新码。
  throw new Error(`扫码接口返回 ${code}：${message}`)
}

/** 取 buvid3 / buvid4（指纹），供完整 Cookie 使用。 */
async function fetchBuvid() {
  try {
    const { parsed } = await rawJson('https://api.bilibili.com/x/frontend/finger/spi')
    const d = parsed?.data
    return { b3: d?.b_3 || '', b4: d?.b_4 || '' }
  } catch {
    return { b3: '', b4: '' }
  }
}

/** 从登录成功返回的 url 查询串 + 指纹里拼出 Cookie 字符串（不回显、不落日志）。 */
async function buildCookieFromLoginUrl(url) {
  let params = {}
  try {
    const u = new URL(url, 'https://passport.bilibili.com')
    params = Object.fromEntries(u.searchParams.entries())
  } catch {
    params = {}
  }
  const fp = await fetchBuvid()
  const parts = []
  const add = (name, value) => {
    if (typeof value === 'string' && value) parts.push(`${name}=${value}`)
  }
  add('SESSDATA', params.SESSDATA)
  add('bili_jct', params.bili_jct)
  add('DedeUserID', params.DedeUserID)
  add('DedeUserID__ckMd5', params.DedeUserID__ckMd5)
  add('sid', params.sid)
  add('buvid3', fp.b3)
  add('buvid4', fp.b4)
  add('b_nut', String(Math.round(Date.now() / 1000)))
  const cookie = parts.join('; ')
  if (!cookie || !params.SESSDATA) throw new Error('登录成功但未取到凭证字段')
  return cookie
}

/**
 * 确认扫码成功：根据登录 url 提取 Cookie 并落盘，再取一次 nav 缓存账号信息。
 * @returns {{ ok: boolean, account: object|null }}
 */
export async function confirmLogin(homeDir, url) {
  const cookie = await buildCookieFromLoginUrl(url)
  saveAuth(homeDir, { savedAt: new Date().toISOString(), cookie })
  let account = null
  try {
    account = await fetchNav(homeDir)
  } catch {
    /* nav 失败不阻断登录；状态面板会显示"已登录"但缺头像 */
  }
  const auth = loadAuth(homeDir)
  if (auth && auth.cookie) auth.nav = account || null
  saveAuth(homeDir, auth)
  return { ok: true, account }
}

// ────────────────────────────── 账号信息 & 退出 ──────────────────────────────

/** 带 Cookie 取账号信息（nav）。未登录返回 {isLogin:false}；失败返回空对象。 */
export async function fetchNav(homeDir) {
  const cookie = buildCookieHeader(homeDir)
  try {
    const { parsed } = await rawJson('https://api.bilibili.com/x/web-interface/nav', cookie ? { Cookie: cookie } : {})
    const data = parsed?.data || {}
    if (!data || data.isLogin !== true) return { isLogin: false }
    return {
      isLogin: true,
      uname: data.uname || '',
      mid: data.mid || 0,
      face: data.face || '',
      wbi_img: data.wbi_img || null,
    }
  } catch {
    return { isLogin: false }
  }
}

/** 面向页面的登录态：只暴露昵称/头像/mid，绝不回显 Cookie。 */
export function getLoginStatus(homeDir) {
  const auth = loadAuth(homeDir)
  if (!auth || !auth.cookie) return { loggedIn: false, account: null }
  const nav = auth.nav && auth.nav.isLogin ? auth.nav : null
  return {
    loggedIn: true,
    account: {
      uname: nav?.uname || '',
      mid: nav?.mid || 0,
      face: nav?.face || '',
      hasNav: !!nav,
    },
  }
}

/** 供其它请求用的 Cookie 头；未登录返回空串。 */
export function buildCookieHeader(homeDir) {
  const auth = loadAuth(homeDir)
  return auth && typeof auth.cookie === 'string' ? auth.cookie : ''
}

/** 退出登录：清本地 Cookie 文件。点到即止，不调任何远端。 */
export function logout(homeDir) {
  clearAuth(homeDir)
  return { ok: true }
}
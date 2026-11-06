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
/** 取 icacls 认的当前用户主体：Windows 必须用 "域\用户"，单给用户名会生成空账户 ACE 把文件锁死。 */
function currentUserPrincipal() {
  try {
    const domain = process.env.USERDOMAIN
    const user = process.env.USERNAME
    if (domain && user) return `${domain}\\${user}`
  } catch {
    /* ignore */
  }
  try {
    const u = os.userInfo().username
    if (u) return u
  } catch {
    /* ignore */
  }
  return ''
}

/**
 * 收紧文件权限。POSIX 走 0600；Windows 用 icacls 去掉继承、只授予当前用户。
 *
 * 关键教训：收紧后必须**自检可读**，万一锁死立即 /reset 恢复继承——绝不能把插件自己的
 * 凭据文件弄坏。（早前 os.userInfo().username 在 Electron 进程里为空，`/grant:r ":(F)"`
 * 生成了空账户 ACE、又去掉了继承，结果连当前用户都读不了，表现为"登录成功但面板不认"。）
 */
function restrictFile(file) {
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* ignore */
  }
  if (process.platform !== 'win32') return
  const principal = currentUserPrincipal()
  if (principal) {
    try {
      spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${principal}:(F)`], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000,
      })
    } catch {
      /* ignore */
    }
  }
  try {
    fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK)
  } catch {
    // 自检失败：恢复继承，保证插件自己能读写。
    try {
      spawnSync('icacls', [file, '/reset'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
    } catch {
      /* ignore */
    }
  }
}

export function saveAuth(homeDir, auth) {
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

/** 把响应的 Set-Cookie 头归整成 [{name,value}, ...]（只有首段 "name=value"，去掉属性）。 */
function normalizeSetCookie(value) {
  const out = []
  const list = Array.isArray(value) ? value : value ? [value] : []
  for (const raw of list) {
    const first = String(raw).split(';')[0].trim()
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    out.push({ name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() })
  }
  return out
}

/**
 * 从 poll 的 JSON + 原始响应头解析出轮询状态（纯函数，便于单测）。
 *
 * **新版接口的轮询状态放在 data.code（顶层 code 恒为 0）**，例如
 * `{code:0, data:{code:86101,message:"未扫码"}}`；老版接口才放顶层。这里两处都认，
 * 优先 data.code，否则会误把"未扫码"当成"登录成功"。
 *
 * @returns {{status:string, message:string, url:string, setCookie:Array<{name:string,value:string}>}}
 */
export function parsePoll(parsed, headers) {
  const data = (parsed && typeof parsed.data === 'object' && parsed.data) || {}
  const code = typeof data.code === 'number' ? data.code : typeof parsed?.code === 'number' ? parsed.code : NaN
  const message = (typeof data.message === 'string' ? data.message : '') || parsed?.message || ''
  const url = typeof data.url === 'string' ? data.url : ''
  const setCookie = normalizeSetCookie(headers && headers['set-cookie'])
  if (code === 0) return { status: 'ok', message: message || '登录成功', url, setCookie }
  if (code === 86101) return { status: 'wait', message: message || '等待扫码', url, setCookie }
  if (code === 86090) return { status: 'scanned', message: message || '已扫码，请在手机上确认', url, setCookie }
  if (code === 86038) return { status: 'expired', message: message || '二维码已过期', url, setCookie }
  // 其它错误码：当作过期/失败，让面板刷新一个新码。
  throw new Error(`扫码接口返回 ${code}：${message}`)
}

export async function pollQr(key) {
  const { parsed, headers } = await rawJson(
    `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`,
  )
  return parsePoll(parsed, headers)
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

/**
 * 从"登录成功"的来源拼 Cookie 字符串（不回显、不落日志）。
 *
 * 现代 B 站 QR 登录的凭证走**成功响应的 Set-Cookie 头**（SESSDATA/bili_jct/DedeUserID…），
 * 而老版才把它们带在 data.url 的查询串里。这里两手都收，再以指纹补 buvid3/buvid4。
 * 至少要有 SESSDATA 才算拿到凭证，否则抛错由路由转成面板可读提示。
 */
async function buildCookie(url, setCookieArr) {
  const params = {}
  try {
    const u = new URL(url, 'https://passport.bilibili.com')
    Object.assign(params, Object.fromEntries(u.searchParams.entries()))
  } catch {
    params = {}
  }
  const fromCookie = {}
  for (const sc of setCookieArr || []) fromCookie[sc.name] = sc.value
  const fp = await fetchBuvid()
  // 优先认 Set-Cookie 里的字段；缺的用 url 查询串 / 指纹补。
  const merged = {}
  for (const n of ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']) {
    merged[n] = fromCookie[n] !== undefined ? fromCookie[n] : params[n]
  }
  if (!merged['buvid3']) merged['buvid3'] = fp.b3 || fromCookie['buvid3']
  if (!merged['buvid4']) merged['buvid4'] = fp.b4 || fromCookie['buvid4']
  if (!merged['b_nut']) merged['b_nut'] = String(Math.round(Date.now() / 1000))
  if (!merged['SESSDATA']) throw new Error('登录成功但未取到 SESSDATA 凭证字段')
  const parts = []
  for (const name of Object.keys(merged)) {
    if (name && typeof merged[name] === 'string' && merged[name]) parts.push(`${name}=${merged[name]}`)
  }
  return parts.join('; ')
}

/**
 * 确认扫码成功：根据成功来源（Set-Cookie + 登录 url）提取 Cookie 并落盘，再取一次 nav 缓存账号信息。
 * info 形如 { url, setCookie }；兼容旧调用直接传 url 字符串。
 * @returns {{ ok: boolean, account: object|null }}
 */
export async function confirmLogin(homeDir, info) {
  const source = info && typeof info === 'object' ? info : { url: String(info || '') }
  const cookie = await buildCookie(source.url || '', Array.isArray(source.setCookie) ? source.setCookie : [])
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

/**
 * 返回面向页面的登录态；若已登录但还没缓存到账号信息，就**懒取一次 nav** 补上
 * （避免"登录成功瞬间 nav 失败就显示不出昵称"的问题）。绝不回显 Cookie。
 */
export async function ensureNav(homeDir) {
  const status = getLoginStatus(homeDir)
  if (!status.loggedIn) return status
  if (status.account && status.account.hasNav) return status
  try {
    const nav = await fetchNav(homeDir)
    if (nav && nav.isLogin) {
      const auth = loadAuth(homeDir)
      if (auth && auth.cookie) {
        auth.nav = nav
        saveAuth(homeDir, auth)
      }
      return {
        loggedIn: true,
        account: { uname: nav.uname || '', mid: nav.mid || 0, face: nav.face || '', hasNav: true },
      }
    }
  } catch {
    /* 保持原状 */
  }
  return status
}

/** 退出登录：清本地 Cookie 文件。点到即止，不调任何远端。 */
export function logout(homeDir) {
  clearAuth(homeDir)
  return { ok: true }
}
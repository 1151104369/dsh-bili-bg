/**
 * dsh-bili-bg — ffmpeg 探测 / 一键下载（宿主侧）。
 *
 * 高清（1080p+）是 DASH 分轨（video/audio 分开），要落成**单个 mp4** 必须合轨；
 * 为了不引入重依赖、也不强迫用户自己装完整版 ffmpeg，这里支持：
 *   ① 探测：DSH_BILI_FFMPEG 环境变量 → 本插件管理的单文件 exe → 常见安装位置 / PATH；
 *   ② 一键下载：拉「单文件 gzip」版 ffmpeg（约 30MB，gunzip 后约 83MB），
 *      解压到 $DSH_HOME/dsh-bili-bg-bin/ffmpeg.exe，校验可执行后原子替换。
 *
 * 只用 node: 内建（https/http/fs/zlib/path/child_process）。所有失败都返回/抛出可读错误。
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'

const MANAGED_DIR = 'dsh-bili-bg-bin'

/** GitHub 备选源的单文件 gzip 资产名。 */
const ASSET = {
  win32: 'ffmpeg-win32-x64.gz',
  linux: 'ffmpeg-linux-x64.gz',
  darwin: process.arch === 'arm64' ? 'ffmpeg-darwin-arm64.gz' : 'ffmpeg-darwin-x64.gz',
}

/**
 * 默认下载源：优先国内可达的 npmmirror（@ffmpeg-installer 平台包 tgz 里直接带 ffmpeg.exe，
 * 实测 ~2.7MB/s；GitHub release 在该网络下只有 ~20KB/s），GitHub 单文件 gz 作为备选。
 * 两种都是「单文件 gzip 系列」，不需要额外解压工具：tgz 由本模块内置的最小 tar 解析器处理。
 */
const PLATFORM_PKG = {
  win32: '@ffmpeg-installer/win32-x64',
  linux: '@ffmpeg-installer/linux-x64',
  darwin: process.arch === 'arm64' ? '@ffmpeg-installer/darwin-arm64' : '@ffmpeg-installer/darwin-x64',
}

/** 平台包内 ffmpeg 文件名。 */
const EXE_IN_PKG = {
  win32: 'package/ffmpeg.exe',
  linux: 'package/ffmpeg',
  darwin: 'package/ffmpeg',
}

const NPMMIRROR_TARBALL = process.env.DSH_BILI_FFMPEG_NPM_URL || ''

function npmTarballUrl() {
  if (NPMMIRROR_TARBALL) return NPMMIRROR_TARBALL
  const pkg = PLATFORM_PKG[process.platform] || PLATFORM_PKG.win32
  const name = pkg.split('/')[1]
  // npmmirror 的 registry 元数据接口给出最新版 tarball；这里用 fixed 版本保证可重复。
  const ver = process.env.DSH_BILI_FFMPEG_NPM_VERSION || '4.1.0'
  return `https://registry.npmmirror.com/${pkg}/-/${name}-${ver}.tgz`
}

export const DEFAULT_FFMPEG_URL =
  process.env.DSH_BILI_FFMPEG_URL ||
  `https://github.com/eugeneware/ffmpeg-static/releases/latest/download/${ASSET[process.platform] || ASSET.win32}`

/** 安装源列表（按顺序尝试）。url 显式覆盖时只用它。 */
function installSources() {
  const override = process.env.DSH_BILI_FFMPEG_URL
  if (override) return [{ url: override, kind: guessKind(override), name: 'custom' }]
  return [
    { url: npmTarballUrl(), kind: 'targz', name: 'npmmirror' },
    { url: DEFAULT_FFMPEG_URL, kind: 'gz', name: 'github' },
  ]
}

function guessKind(url) {
  const s = String(url || '').toLowerCase()
  if (s.endsWith('.tgz') || s.endsWith('.tar.gz')) return 'targz'
  return 'gz'
}

export const MANAGED_DIR_NAME = MANAGED_DIR

/** 插件管理目录下的 ffmpeg 路径（一键下载落点）。 */
export function managedFfmpegPath(homeDir) {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  return path.join(homeDir, MANAGED_DIR, name)
}

/** 常见安装位置（不算 PATH）。 */
function commonCandidates() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA || ''
  const user = process.env.USERPROFILE || ''
  if (process.platform === 'win32') {
    return [
      path.join(pf, 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(pf86, 'ffmpeg', 'bin', 'ffmpeg.exe'),
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      path.join(local, 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(user, 'scoop', 'shims', 'ffmpeg.exe'),
      'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
    ]
  }
  return ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
}

function fileUsable(p) {
  try {
    const st = fs.statSync(p)
    return st.isFile() && st.size > 1024
  } catch {
    return false
  }
}

/** findFfmpeg 结果按 homeDir 缓存（安装完可 clear）。 */
const cache = new Map()

/**
 * 找可用的 ffmpeg。返回 {path, source}；没有返回 {path:'', source:''}。
 * @param {string} homeDir
 */
export function findFfmpegInfo(homeDir) {
  // key 带上 DSH_BILI_FFMPEG，环境变量改了要能立刻生效（测试/用户改路径）。
  const key = String(homeDir || '') + '|' + String(process.env.DSH_BILI_FFMPEG || '')
  if (cache.has(key)) return cache.get(key)
  let result = { path: '', source: '' }
  const env = process.env.DSH_BILI_FFMPEG
  // 用户显式指定的路径：只要求存在（信任用户的显式选择）。
  if (env && env.trim()) {
    try {
      if (fs.existsSync(env.trim())) result = { path: env.trim(), source: 'env' }
    } catch {
      /* ignore */
    }
  }
  if (!result.path) {
    const managed = homeDir ? managedFfmpegPath(homeDir) : ''
    if (managed && fileUsable(managed)) result = { path: managed, source: 'managed' }
  }
  if (!result.path) {
    for (const p of commonCandidates()) {
      if (fileUsable(p)) {
        result = { path: p, source: 'system' }
        break
      }
    }
  }
  if (!result.path) {
    try {
      const r = spawnSync('ffmpeg', ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
      if (r && r.status === 0) result = { path: 'ffmpeg', source: 'path' }
    } catch {
      /* ignore */
    }
  }
  cache.set(key, result)
  return result
}

/** 兼容旧调用：只返回路径（'' 表示没有）。 */
export function findFfmpeg(homeDir) {
  return findFfmpegInfo(homeDir).path
}

/** 清缓存（安装完成后调用）。 */
export function clearFfmpegCache() {
  cache.clear()
}

/** 跑 `-version` 拿版本号（不带则返回 ''）；按路径缓存，避免状态轮询反复 spawn。 */
const versionCache = new Map()
export function ffmpegVersion(ffmpegPath) {
  if (!ffmpegPath) return ''
  if (versionCache.has(ffmpegPath)) return versionCache.get(ffmpegPath)
  let out = ''
  try {
    const r = spawnSync(ffmpegPath, ['-version'], { windowsHide: true, encoding: 'utf8', timeout: 8000 })
    if (r && r.status === 0 && r.stdout) out = String(r.stdout).split('\n')[0].trim()
  } catch {
    /* ignore */
  }
  versionCache.set(ffmpegPath, out)
  return out
}

// ────────────────────────────── 一键下载 ──────────────────────────────

/** 下载/安装状态（单例：同一时间只跑一个）。 */
const install = {
  state: 'idle', // idle | downloading | verifying | done | error | cancelled
  url: DEFAULT_FFMPEG_URL,
  received: 0,
  total: 0,
  error: '',
  path: '',
  startedAt: null,
  finishedAt: null,
  _req: null,
  _gzipPath: '',
  _exePath: '',
}

export function getInstallState() {
  return {
    state: install.state,
    url: install.url,
    sourceName: install.sourceName || '',
    received: install.received,
    total: install.total,
    error: install.error,
    path: install.path,
    startedAt: install.startedAt,
    finishedAt: install.finishedAt,
  }
}

export function cancelInstall() {
  if (install.state !== 'downloading' && install.state !== 'verifying') return false
  try {
    if (install._req && typeof install._req.destroy === 'function') install._req.destroy()
  } catch {
    /* ignore */
  }
  cleanupInstallFiles()
  install.state = 'cancelled'
  install.error = '已取消'
  install.finishedAt = Date.now()
  return true
}

function cleanupInstallFiles() {
  for (const f of [install._gzipPath, install._exePath]) {
    if (!f) continue
    try {
      fs.rmSync(f, { force: true })
    } catch {
      /* ignore */
    }
  }
  install._gzipPath = ''
  install._exePath = ''
}

/** 跟随重定向下载到文件（最多 8 跳），带进度。 */
function downloadToFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      reject(new Error('重定向次数过多'))
      return
    }
    let u
    try {
      u = new URL(url)
    } catch (e) {
      reject(new Error('无效的下载地址'))
      return
    }
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(
      u,
      {
        method: 'GET',
        headers: { 'User-Agent': 'dsh-bili-bg', Accept: 'application/octet-stream' },
      },
      (res) => {
        const status = res.statusCode || 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          let next
          try {
            next = new URL(res.headers.location, url).toString()
          } catch (e) {
            reject(new Error('无效的重定向地址'))
            return
          }
          resolve(downloadToFile(next, dest, redirects + 1))
          return
        }
        if (status !== 200) {
          res.resume()
          reject(new Error(`下载失败 HTTP ${status}`))
          return
        }
        const len = parseInt(res.headers['content-length'], 10)
        if (!Number.isNaN(len)) install.total = len
        install.received = 0
        const ws = fs.createWriteStream(dest)
        install._req = req
        res.on('data', (c) => {
          install.received += c.length
        })
        res.on('error', (e) => {
          ws.destroy()
          reject(e)
        })
        ws.on('error', (e) => {
          res.destroy()
          reject(e)
        })
        ws.on('finish', () => resolve())
        res.pipe(ws)
      },
    )
    req.on('error', reject)
    req.setTimeout(60000, () => {
      try {
        req.destroy(new Error('下载超时'))
      } catch {
        /* ignore */
      }
    })
    req.end()
  })
}

/** gunzip 到目标文件。 */
function gunzipToFile(src, dest) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src)
    const ws = fs.createWriteStream(dest)
    const gunzip = zlib.createGunzip()
    let done = false
    const finish = (err) => {
      if (done) return
      done = true
      if (err) reject(err)
      else resolve()
    }
    rs.on('error', finish)
    gunzip.on('error', finish)
    ws.on('error', finish)
    ws.on('finish', () => finish())
    rs.pipe(gunzip).pipe(ws)
  })
}

/** tar 里的以 NUL 结尾的字符串字段。 */
function readTarString(buf, off, len) {
  let end = off
  while (end < off + len && buf[end] !== 0) end += 1
  return buf.toString('utf8', off, end)
}

/**
 * 从（已 gunzip 的）tar 里取出指定路径的文件内容（最小 ustar 解析，够 npm 包用）。
 * @param {Buffer} tar
 * @param {string} wanted 例如 'package/ffmpeg.exe'
 */
export function extractTarEntry(tar, wanted) {
  const want = String(wanted || '').replace(/^\.\//, '')
  let off = 0
  while (off + 512 <= tar.length) {
    const name = readTarString(tar, off, 100)
    if (!name) break // 结束块
    const size = parseInt(readTarString(tar, off + 124, 12).trim(), 8) || 0
    const type = String.fromCharCode(tar[off + 156] || 48)
    const dataStart = off + 512
    const norm = name.replace(/^\.\//, '')
    if ((type === '0' || type === '\0' || type === '7') && norm === want && dataStart + size <= tar.length) {
      return tar.subarray(dataStart, dataStart + size)
    }
    off = dataStart + Math.ceil(size / 512) * 512
  }
  return null
}

/** 从下载好的压缩包里取出 ffmpeg 可执行文件写到 exePath。 */
async function extractExecutable(src, archivePath, exePath) {
  if (src.kind === 'targz') {
    const tar = zlib.gunzipSync(fs.readFileSync(archivePath))
    const wanted = EXE_IN_PKG[process.platform] || EXE_IN_PKG.win32
    const entry = extractTarEntry(tar, wanted)
    if (!entry) throw new Error('安装包里没有找到 ffmpeg 可执行文件')
    fs.writeFileSync(exePath, entry)
  } else {
    await gunzipToFile(archivePath, exePath)
  }
  try {
    fs.chmodSync(exePath, 0o755)
  } catch {
    /* ignore */
  }
}

/**
 * 一键下载并安装单文件 ffmpeg 到 $DSH_HOME/dsh-bili-bg-bin/。
 * 幂等：已有安装直接返回 done。
 * @param {{homeDir: string, url?: string}} opts
 * @returns {Promise<{state: string, path: string, error: string}>}
 */
export async function installFfmpeg(opts = {}) {
  const homeDir = opts.homeDir || ''
  const target = managedFfmpegPath(homeDir)
  const already = findFfmpegInfo(homeDir)
  // 显式给了 url（手动/测试）就强制重新下载，不受已有安装影响
  if (!opts.url && already.path && already.source === 'managed') {
    install.state = 'done'
    install.path = already.path
    install.error = ''
    return { state: 'done', path: already.path, error: '' }
  }
  if (install.state === 'downloading' || install.state === 'verifying') {
    return { state: install.state, path: '', error: '已有下载任务在进行' }
  }

  const dir = path.dirname(target)
  fs.mkdirSync(dir, { recursive: true })
  const archivePath = path.join(dir, 'ffmpeg.download')
  const exePath = `${target}.part`
  install._gzipPath = archivePath
  install._exePath = exePath
  install.state = 'downloading'
  install.received = 0
  install.total = 0
  install.error = ''
  install.path = ''
  install.startedAt = Date.now()
  install.finishedAt = null

  const sources = opts.url ? [{ url: opts.url, kind: guessKind(opts.url), name: 'custom' }] : installSources()
  let lastErr = null
  for (const src of sources) {
    if (install.state === 'cancelled') return { state: 'cancelled', path: '', error: '已取消' }
    install.url = src.url
    install.sourceName = src.name
    install.received = 0
    install.total = 0
    install._gzipPath = archivePath
    install._exePath = exePath
    install.state = 'downloading'
    try {
      await downloadToFile(src.url, archivePath)
      if (install.state === 'cancelled') return { state: 'cancelled', path: '', error: '已取消' }
      install.state = 'verifying'
      await extractExecutable(src, archivePath, exePath)
      // 校验：能跑起来才算装好（测试环境可用 DSH_BILI_FFMPEG_SKIP_VERIFY=1 跳过）
      if (process.env.DSH_BILI_FFMPEG_SKIP_VERIFY !== '1') {
        const r = spawnSync(exePath, ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 15000 })
        if (!r || r.status !== 0) throw new Error('下载的 ffmpeg 无法运行（校验失败）')
      }
      fs.renameSync(exePath, target)
      install.state = 'done'
      install.path = target
      install.finishedAt = Date.now()
      clearFfmpegCache()
      versionCache.clear()
      cleanupInstallFiles()
      return { state: 'done', path: target, error: '' }
    } catch (e) {
      lastErr = e
      cleanupInstallFiles()
      // 当前源失败 → 清场后换下一个源
      install._gzipPath = archivePath
      install._exePath = exePath
    }
  }
  install.state = 'error'
  install.error = lastErr && lastErr.message ? lastErr.message : String(lastErr || '下载失败')
  install.finishedAt = Date.now()
  cleanupInstallFiles()
  return { state: 'error', path: '', error: install.error }
}

/** 面向接口的状态描述（供 /ffmpeg 路由）。 */
export function describeFfmpeg(homeDir) {
  const info = findFfmpegInfo(homeDir)
  const sources = installSources()
  return {
    found: !!info.path,
    path: info.path,
    source: info.source,
    version: info.path ? ffmpegVersion(info.path) : '',
    managedPath: managedFfmpegPath(homeDir),
    downloadUrl: sources[0] ? sources[0].url : DEFAULT_FFMPEG_URL,
    downloadSources: sources.map((s) => ({ name: s.name, url: s.url })),
    platform: process.platform,
    install: getInstallState(),
  }
}

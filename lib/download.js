/**
 * dsh-bili-bg — 视频下载（宿主侧）。
 *
 * 把「正在播放 / 已解析」的视频整支 mp4 下载到本地 Downloads/DSH-B站背景。
 * 只用 node: 内建 + lib/bili.js，不引入任何外部依赖：
 *   · `resolveBvid` 拿元数据（title/cid/时长/作者），`resolvePlay` 拿 CDN mp4 直链；
 *   · 流式写入 `<文件名>.part` 临时文件，完成后再 rename 成正式 mp4（原子化，
 *     失败不留下半成品）；重定向最多跟 3 跳（CDN 常态）；
 *   · 并发最多 2 个，其余排队；任务只存内存，保留最近 50 个；
 *   · 任何失败都落到任务 status:'error' + 可读 error，绝不抛未处理异常。
 *
 * 文件命名：清理后的 title + `-<bvid>` + .mp4，重名自动追加 `-2`/`-3`…
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { resolveBvid, resolvePlay, UA, REFERER } from './bili.js'

const MAX_CONCURRENT = 2
const MAX_TASKS = 50
const MAX_REDIRECTS = 3

/** Windows 注册表里「下载」文件夹的 GUID（KnownFolder Downloads）。 */
const DOWNLOADS_FOLDER_GUID = '{374DE290-123F-4565-9164-39C4925E467B}'

/**
 * Windows 上取真实的「下载」目录。
 *
 * 不能只拼 `os.homedir()/Downloads`：用户可能把下载夹重定向到别的盘
 * （本机就是 `F:\Downloads`，`C:\Users\...\Downloads` 根本不存在）。
 * 优先读 User Shell Folders（会解析 %USERPROFILE% 之类的变量），再退回 Shell Folders。
 */
/** 注册表解析结果按进程缓存（子进程有启动开销，别在每次路由里重查）。 */
let cachedWinDownloads = ''

/** 注册表里「下载」文件夹的值（KnownFolder Downloads GUID）。 */
const SHELL_FOLDERS_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'

/**
 * Windows 上取真实的「下载」目录。
 *
 * 不能只拼 `os.homedir()/Downloads`：用户可能把下载夹重定向到别的盘
 * （本机就是 `F:\Downloads`，`C:\Users\...\Downloads` 根本不存在）。
 *
 * 用 PowerShell 读注册表并**显式把控制台输出钉成 UTF-8**：reg.exe 的输出走系统
 * 代码页（中文系统 GBK），路径里带中文会被 Node 按 UTF-8 解码成乱码，进而把
 * 文件存进乱码目录。PowerShell 方案与系统区域设置无关。
 */
function windowsDownloadsDir() {
  if (cachedWinDownloads) return cachedWinDownloads
  try {
    const script =
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
      `$v = (Get-ItemProperty -LiteralPath '${SHELL_FOLDERS_KEY}' -ErrorAction Stop).'{${DOWNLOADS_FOLDER_GUID.slice(1, -1)}}'; ` +
      `[Console]::Out.Write($v)`
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
    })
    if (r.status === 0 && r.stdout) {
      const expanded = r.stdout
        .trim()
        .replace(/%([^%]+)%/g, (whole, name) => process.env[name] || whole)
      if (expanded && fs.existsSync(expanded)) {
        cachedWinDownloads = expanded
        return expanded
      }
    }
  } catch {
    /* 走后面的回退 */
  }
  return ''
}

/** 保存对话框的默认目录：系统下载 KnownFolder 根目录（如 F:\Downloads），读不到则退回保存基目录。 */
function dialogDefaultDir(homeDir) {
  if (process.platform === 'win32') {
    const real = windowsDownloadsDir()
    if (real) return real
  }
  return resolveDownloadsBase(homeDir)
}

/** 下载根目录：DSH_BILI_DOWNLOAD_DIR（显式覆盖）→ 真实系统下载目录 → 常见位置 → $DSH_HOME/downloads。 */
function resolveDownloadsBase(dir) {
  // 显式覆盖（测试用临时目录；也方便用户以后自定义保存位置）
  const override = process.env.DSH_BILI_DOWNLOAD_DIR
  if (override && override.trim()) return override.trim()
  if (process.platform === 'win32') {
    const real = windowsDownloadsDir()
    if (real) return real
  }
  try {
    const dl = path.join(os.homedir(), 'Downloads')
    if (fs.existsSync(dl)) return dl
  } catch {
    /* ignore */
  }
  return path.join(dir, 'downloads')
}

/** 清理标题中的文件名非法字符与控制字符，折叠空白，截到 ~80 字。 */
function sanitizeFilename(title) {
  let s = String(title || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length > 80) s = s.slice(0, 80).trim()
  return s || 'video'
}

/** 避免覆盖：已存在则追加 -2、-3… 直到不冲突。 */
function uniquePath(dir, base) {
  let f = path.join(dir, base + '.mp4')
  let n = 2
  while (fs.existsSync(f)) {
    f = path.join(dir, `${base}-${n}.mp4`)
    n += 1
  }
  return f
}

/**
 * 下载器工厂：绑定一个 DSH home 目录，返回 startDownload / listDownloads /
 * getDownload / getDownloadDir。任务状态只存内存（进度/错误/完成均不进落盘）。
 */
export function createDownloader(homeDir) {
  const tasks = new Map()
  const order = []
  const queue = []
  const running = new Set()
  let counter = 0

  const downloadsDir = () => path.join(resolveDownloadsBase(homeDir), 'DSH-B站背景')

  function newId() {
    counter += 1
    return `dl_${counter}_${Math.random().toString(36).slice(2, 8)}`
  }

  function snapshot(task) {
    return {
      id: task.id,
      bvid: task.bvid,
      title: task.title,
      status: task.status,
      received: task.received,
      total: task.total,
      path: task.path,
      error: task.error,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
    }
  }

  function store(task) {
    tasks.set(task.id, task)
    order.push(task.id)
    while (order.length > MAX_TASKS) {
      const old = order.shift()
      tasks.delete(old)
    }
  }

  function failTask(task, err) {
    try {
      if (task.path) fs.rmSync(task.path + '.part', { force: true })
    } catch {
      /* ignore */
    }
    task.status = 'error'
    task.error = err instanceof Error ? err.message : String(err)
    task.finishedAt = Date.now()
  }

  /** 用户没加扩展名时补 .mp4（保存框允许改扩展名/过滤为所有文件）。 */
  function ensureMp4(p) {
    const s = String(p || '').trim()
    if (!s) return s
    return /\.[A-Za-z0-9]{2,5}$/.test(s) ? s : s + '.mp4'
  }

  /**
   * 发起一次下载。先解析出元数据与 CDN 直链，再决定保存路径，然后登记任务并排队；
   * 解析/无播放源失败会抛错（由路由转成 422 可读 JSON）。
   *
   * @param {string} input BV 号 / 链接
   * @param {{decide?: (info: {defaultDir: string, filename: string, title: string, bvid: string}) => Promise<string|'cancelled'>}} [opts]
   *   decide 回调决定保存位置：返回绝对路径用之；'cancelled' 表示用户取消（本次不下载，不登记任务）；
   *   返回 ''/undefined 表示走默认目录自动命名（保存框不可用时的回退）。
   * @returns {Promise<{id: string, task: object} | {cancelled: true}>}
   */
  async function startDownload(input, opts = {}) {
    const resolved = await resolveBvid(input)
    if (!resolved || resolved.ok !== true) {
      throw new Error((resolved && resolved.error) || '无法识别视频')
    }
    const play = await resolvePlay(resolved.bvid, resolved.cid)
    if (!play.url) {
      throw new Error(play.error || '该视频没有可下载的播放源')
    }

    const base = sanitizeFilename(resolved.title) + '-' + resolved.bvid
    let finalPath = ''
    if (typeof opts.decide === 'function') {
      const picked = await opts.decide({
        defaultDir: dialogDefaultDir(homeDir),
        filename: base + '.mp4',
        title: resolved.title || '',
        bvid: resolved.bvid,
      })
      if (picked === 'cancelled') return { cancelled: true }
      if (typeof picked === 'string' && picked.trim()) finalPath = ensureMp4(picked)
    }
    if (!finalPath) finalPath = uniquePath(downloadsDir(), base)

    // 用户可能把对话框指到任何目录（含不存在的新目录）——确保父目录存在。
    fs.mkdirSync(path.dirname(finalPath), { recursive: true })

    const id = newId()
    const task = {
      id,
      bvid: resolved.bvid,
      title: resolved.title || '',
      status: 'queued',
      received: 0,
      // 未知，收到响应后才用 content-length 填充。**不要拿视频时长冒充字节数**，
      // 否则前端进度百分比会算出一个 100% 却没下完的假进度。
      total: 0,
      path: finalPath,
      error: '',
      startedAt: null,
      finishedAt: null,
    }

    store(task)
    queue.push({ id, url: play.url, tmp: finalPath + '.part' })
    pump()
    return { id, task: snapshot(task) }
  }

  /** 按并发上限把排队中的任务拉起来执行。 */
  function pump() {
    while (running.size < MAX_CONCURRENT && queue.length > 0) {
      const item = queue.shift()
      running.add(item.id)
      run(item)
        .catch(() => {
          /* failTask 已在 run 里兜底 */
        })
        .finally(() => {
          running.delete(item.id)
          pump()
        })
    }
  }

  /** 真正跑一个下载：流式写 .part → rename 成正式文件，失败清理 .part。 */
  async function run(item) {
    const task = tasks.get(item.id)
    if (!task) return
    task.status = 'downloading'
    task.startedAt = Date.now()
    try {
      await streamToFile(item.url, item.tmp, task)
      // 用户可能在流结束的同一瞬间请求取消：以完成优先，别把已完成的 rename 拆掉。
      if (task.cancelRequested) {
        settleCancelled(task)
        return
      }
      const stat = fs.statSync(item.tmp)
      if (stat.size <= 0) {
        failTask(task, '下载结果为空文件')
        return
      }
      fs.renameSync(item.tmp, task.path)
      task.status = 'done'
      task.finishedAt = Date.now()
    } catch (err) {
      if (task.cancelRequested) {
        settleCancelled(task)
        return
      }
      failTask(task, err)
    }
  }

  /** 取消收尾：清理 .part 半成品，状态落 cancelled（不是 error）。 */
  function settleCancelled(task) {
    try {
      if (task.path) fs.rmSync(task.path + '.part', { force: true })
    } catch {
      /* ignore */
    }
    task.status = 'cancelled'
    task.error = '已取消'
    task.finishedAt = Date.now()
  }

  /**
   * 中途取消一个任务（下载中 → 断开 HTTP 连接；排队中 → 直接出队）。
   * 返回取消后的任务快照；任务不存在/已结束返回 undefined。
   */
  function cancelDownload(id) {
    const task = tasks.get(id)
    if (!task) return undefined
    if (task.status === 'done' || task.status === 'error' || task.status === 'cancelled') return undefined
    if (task.status === 'queued') {
      const qi = queue.findIndex((q) => q.id === id)
      if (qi >= 0) queue.splice(qi, 1)
      settleCancelled(task)
      return snapshot(task)
    }
    // downloading：打断 HTTP 请求，run() 的 catch 里会走 settleCancelled。
    task.cancelRequested = true
    try {
      if (task.activeReq && typeof task.activeReq.destroy === 'function') task.activeReq.destroy()
      if (task.activeWs && typeof task.activeWs.destroy === 'function') task.activeWs.destroy()
    } catch {
      /* ignore */
    }
    return snapshot(task)
  }

  function streamToFile(url, tmp, task) {
    return writeStream(url, tmp, task, 0)
  }

  /** 带 Referer/UA 的流式下载，最多跟 3 跳重定向；content-length 回填 total。 */
  function writeStream(url, tmp, task, redirects) {
    return new Promise((resolve, reject) => {
      if (redirects > MAX_REDIRECTS) {
        reject(new Error('重定向次数过多'))
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
      const req = mod.request(u, { method: 'GET', headers: { 'User-Agent': UA, Referer: REFERER } }, (res) => {
        const status = res.statusCode || 0
        const location = res.headers && res.headers.location
        if (status >= 300 && status < 400 && location) {
          res.resume()
          let next
          try {
            next = new URL(location, url).toString()
          } catch (e) {
            reject(e)
            return
          }
          resolve(writeStream(next, tmp, task, redirects + 1))
          return
        }
        if (status !== 200 && status !== 206) {
          res.resume()
          reject(new Error(`HTTP ${status}`))
          return
        }
        const contentLength = parseInt(res.headers['content-length'], 10)
        if (!Number.isNaN(contentLength)) task.total = contentLength
        task.received = 0
        const ws = fs.createWriteStream(tmp)
        // 记下活跃的请求/写流，供 cancelDownload 中途打断。
        task.activeReq = req
        task.activeWs = ws
        res.on('data', (chunk) => {
          // 确定性取消点：req.destroy() 的错误事件在 pipe 场景下可能被吞，
          // 这里逐块检查取消标记，保证一取消立刻断流。
          if (task.cancelRequested) {
            try {
              req.destroy()
              ws.destroy()
            } catch {
              /* ignore */
            }
            reject(new Error('已取消'))
            return
          }
          task.received += chunk.length
        })
        res.on('error', (e) => {
          ws.destroy()
          reject(e)
        })
        ws.on('error', (e) => {
          res.destroy()
          reject(e)
        })
        res.pipe(ws)
        ws.on('finish', () => resolve())
      })
      req.on('error', reject)
      req.end()
    })
  }

  /** 全部任务快照，最新的在前。 */
  function listDownloads() {
    return order
      .map((id) => tasks.get(id))
      .filter(Boolean)
      .map(snapshot)
      .reverse()
  }

  /** 单个任务快照；未知 id 返回 undefined。 */
  function getDownload(id) {
    const t = tasks.get(id)
    return t ? snapshot(t) : undefined
  }

  return {
    startDownload,
    cancelDownload,
    listDownloads,
    getDownload,
    getDownloadDir: downloadsDir,
    getDialogDefaultDir: () => dialogDefaultDir(homeDir),
  }
}
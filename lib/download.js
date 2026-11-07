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
import { spawn, spawnSync } from 'node:child_process'
import { resolveBvid, resolvePlay, resolveDash, UA, REFERER } from './bili.js'

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
function sanitizeFilename(title) {  let s = String(title || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length > 80) s = s.slice(0, 80).trim()
  return s || 'video'
}

/**
 * 避免覆盖：已存在则追加 -2、-3… 直到不冲突。ext 可指定（默认 .mp4）。
 */
function uniquePath(dir, base, ext) {
  const e = ext || '.mp4'
  let f = path.join(dir, base + e)
  let n = 2
  while (fs.existsSync(f)) {
    f = path.join(dir, `${base}-${n}${e}`)
    n += 1
  }
  return f
}

/**
 * 从 DASH 分轨里挑出要下载的视频/音频轨。
 * @param {{video:Array, audio:Array}} dash normalizeDash 结果
 * @param {{videoIndex?: number, audioIndex?: number, height?: number}} want
 */
export function pickDashTracks(dash, want = {}) {
  if (!dash || !Array.isArray(dash.video) || !dash.video.length) return null
  const videos = dash.video
  let video = null
  if (isFinite(Number(want.videoIndex)) && videos[Number(want.videoIndex)]) {
    video = videos[Number(want.videoIndex)]
  }
  if (!video && isFinite(Number(want.height)) && Number(want.height) > 0) {
    // 同高度优先 H.264（兼容性最好），再按码率
    const sameHeight = videos.filter((t) => Number(t.height) === Number(want.height))
    const pool = sameHeight.length ? sameHeight : videos
    video = pool.slice().sort((a, b) => {
      const rank = (c) => (/^avc1|^avc3/i.test(String(c || '')) ? 0 : /^hvc1|^hev1/i.test(String(c || '')) ? 1 : /^av01/i.test(String(c || '')) ? 2 : 3)
      const d = rank(a.codecs) - rank(b.codecs)
      if (d !== 0) return d
      return (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0)
    })[0]
  }
  if (!video) {
    // 默认取 ≤1080p 里最高的一条
    const sorted = videos.slice().sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0))
    video = sorted.find((t) => Number(t.height) <= 1080) || sorted[0]
  }
  const audios = Array.isArray(dash.audio) ? dash.audio : []
  let audio = null
  if (isFinite(Number(want.audioIndex)) && audios[Number(want.audioIndex)]) {
    audio = audios[Number(want.audioIndex)]
  }
  if (!audio && audios.length) {
    audio = audios.slice().sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0))[0]
  }
  return { video, audio }
}

/** 候选 ffmpeg 路径（可用 DSH_BILI_FFMPEG 显式指定）。 */
function ffmpegCandidates() {
  const list = []
  const env = process.env.DSH_BILI_FFMPEG
  if (env && env.trim()) list.push(env.trim())
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA || ''
  const user = process.env.USERPROFILE || ''
  if (process.platform === 'win32') {
    list.push(
      path.join(pf, 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(pf86, 'ffmpeg', 'bin', 'ffmpeg.exe'),
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      path.join(local, 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(user, 'scoop', 'shims', 'ffmpeg.exe'),
      'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
    )
  } else {
    list.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg')
  }
  return list
}

/** 找可用的 ffmpeg（结果缓存）。返回绝对路径或 ''。 */
let cachedFfmpeg
export function findFfmpeg() {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg
  for (const p of ffmpegCandidates()) {
    try {
      if (p && fs.existsSync(p)) {
        cachedFfmpeg = p
        return p
      }
    } catch {
      /* ignore */
    }
  }
  try {
    const r = spawnSync('ffmpeg', ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
    if (r && r.status === 0) {
      cachedFfmpeg = 'ffmpeg'
      return cachedFfmpeg
    }
  } catch {
    /* ignore */
  }
  cachedFfmpeg = ''
  return cachedFfmpeg
}

/** 用 ffmpeg -c copy 把视频轨+音频轨合轨成单个 mp4（不重新编码）。 */
function muxWithFfmpeg(ffmpeg, videoFile, audioFile, outFile) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(
        ffmpeg,
        [
          '-y',
          '-loglevel',
          'error',
          '-i',
          videoFile,
          '-i',
          audioFile,
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          outFile,
        ],
        { windowsHide: true, stdio: 'ignore' },
      )
    } catch (e) {
      reject(e)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(new Error('ffmpeg 合轨超时'))
    }, 10 * 60 * 1000)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 合轨失败（退出码 ${code}）`))
    })
  })
}

/**
 * 下载器工厂：绑定一个 DSH home 目录，返回 startDownload / listDownloads /
 * getDownload / getDownloadDir。任务状态只存内存（进度/错误/完成均不进落盘）。
 * @param {string} homeDir
 * @param {{getCookie?: () => string}} [options] getCookie 供按播放画质解析 DASH 分轨
 */
export function createDownloader(homeDir, options = {}) {
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
      // 1080p 走 DASH：没有 ffmpeg 时会分别保存视频/音频两个文件
      paths: Array.isArray(task.paths) ? task.paths.slice() : undefined,
      height: task.height || 0,
      quality: task.quality || 'single',
      note: task.note || '',
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
    cleanupTemps(task)
    task.status = 'error'
    task.error = err instanceof Error ? err.message : String(err)
    task.finishedAt = Date.now()
  }

  /** 清理任务所有临时文件（.part / 合轨中间产物）。 */
  function cleanupTemps(task) {
    for (const f of task.temps || []) {
      try {
        fs.rmSync(f, { force: true })
      } catch {
        /* ignore */
      }
    }
    try {
      if (task.path) fs.rmSync(task.path + '.part', { force: true })
    } catch {
      /* ignore */
    }
  }

  /** 用户没加扩展名时补 .mp4（保存框允许改扩展名/过滤为所有文件）。 */
  function ensureMp4(p) {
    const s = String(p || '').trim()
    if (!s) return s
    return /\.[A-Za-z0-9]{2,5}$/.test(s) ? s : s + '.mp4'
  }

  /** 把「用户选的 mp4 路径」派生为同名不同后缀（用于音频轨/中间文件）。 */
  function siblingPath(file, suffix, ext) {
    const dir = path.dirname(file)
    const stem = path.basename(file).replace(/\.[A-Za-z0-9]{2,5}$/, '')
    return path.join(dir, stem + suffix + (ext || ''))
  }

  /**
   * 发起一次下载。**按当前播放画质**选源：
   *   - quality.mode === 'hd'：走 DASH 分轨（1080p 等），有 ffmpeg 就 -c copy 合轨成单 mp4；
   *     没有 ffmpeg 就分别保存视频/音频两个文件（保证画质不降级）。
   *   - 否则走现有 720p 单文件 mp4。
   * 解析/无播放源失败会抛错（由路由转成 422 可读 JSON）。
   *
   * @param {string} input BV 号 / 链接
   * @param {{decide?: Function, quality?: {mode?: string, videoIndex?: number, audioIndex?: number, height?: number, qn?: number}}} [opts]
   * @returns {Promise<{id: string, task: object} | {cancelled: true}>}
   */
  async function startDownload(input, opts = {}) {
    const resolved = await resolveBvid(input)
    if (!resolved || resolved.ok !== true) {
      throw new Error((resolved && resolved.error) || '无法识别视频')
    }
    const want = opts.quality && typeof opts.quality === 'object' ? opts.quality : {}
    const wantHd = String(want.mode || '') === 'hd'

    let height = 0
    let sources = [] // [{ urls:[...], tmpLabel }]
    let muxEd = false
    let note = ''
    let fallbackReason = ''

    if (wantHd) {
      const cookie = typeof options.getCookie === 'function' ? options.getCookie() : ''
      let dash = null
      try {
        dash = await resolveDash(resolved.bvid, resolved.cid, cookie, Number(want.qn) || 80)
      } catch (e) {
        fallbackReason = e && e.message ? e.message : String(e)
      }
      const picked = dash && dash.ok && dash.hasDash ? pickDashTracks(dash.dash, want) : null
      if (picked && picked.video) {
        height = Number(picked.video.height) || 0
        const ffmpeg = findFfmpeg()
        muxEd = !!ffmpeg && !!picked.audio
        if (picked.audio) {
          sources = [
            { urls: [picked.video.baseUrl].concat(picked.video.backupUrl || []), kind: 'video' },
            { urls: [picked.audio.baseUrl].concat(picked.audio.backupUrl || []), kind: 'audio' },
          ]
        } else {
          sources = [{ urls: [picked.video.baseUrl].concat(picked.video.backupUrl || []), kind: 'video' }]
          muxEd = false
          note = '该视频无独立音频轨，仅保存视频'
        }
        if (sources.length === 2 && !muxEd) {
          note = '未检测到 ffmpeg：已分别保存视频轨与音频轨（安装 ffmpeg 后可自动合轨成单个 mp4）'
        }
      } else {
        fallbackReason = fallbackReason || (dash && dash.error) || '拿不到 DASH 分轨'
      }
    }

    // 回退：720p 单文件
    if (!sources.length) {
      const play = await resolvePlay(resolved.bvid, resolved.cid)
      if (!play.url) throw new Error(play.error || '该视频没有可下载的播放源')
      sources = [{ urls: [play.url], kind: 'single' }]
      height = Number(play.quality) === 64 ? 720 : 0
      muxEd = false
      if (wantHd && fallbackReason) note = '高清分轨不可用，已回退 720p 单文件下载'
    }

    const qualityTag = height > 0 ? `-${height}p` : ''
    const base = sanitizeFilename(resolved.title) + '-' + resolved.bvid + qualityTag
    let finalPath = ''
    if (typeof opts.decide === 'function') {
      const picked = await opts.decide({
        defaultDir: dialogDefaultDir(homeDir),
        filename: base + '.mp4',
        title: resolved.title || '',
        bvid: resolved.bvid,
        height,
      })
      if (picked === 'cancelled') return { cancelled: true }
      if (typeof picked === 'string' && picked.trim()) finalPath = ensureMp4(picked)
    }
    if (!finalPath) finalPath = uniquePath(downloadsDir(), base)
    fs.mkdirSync(path.dirname(finalPath), { recursive: true })

    // 组装临时文件与最终路径
    const audioPath = siblingPath(finalPath, '.audio', '.m4a')
    let paths = [finalPath]
    sources.forEach((src, i) => {
      if (sources.length === 1 || muxEd) src.tmp = `${finalPath}.${src.kind}.part`
      else if (src.kind === 'video') src.tmp = `${finalPath}.part`
      else src.tmp = `${audioPath}.part`
    })
    if (sources.length === 2 && !muxEd) {
      paths = [finalPath, audioPath]
    }

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
      paths,
      audioPath,
      height,
      quality: sources.length === 2 || (wantHd && muxEd) ? 'hd' : 'single',
      note,
      error: '',
      temps: sources.map((s) => s.tmp),
      startedAt: null,
      finishedAt: null,
    }

    store(task)
    queue.push({ id, sources, mux: muxEd, muxOutput: finalPath, audioPath, videoPath: paths[0] })
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

  /** 下载单条源（依次尝试 baseUrl/backupUrl）。 */
  async function downloadSource(task, src) {
    let lastErr = null
    for (const url of src.urls) {
      if (!url) continue
      if (task.cancelRequested) throw new Error('已取消')
      task.baseReceived = task.received
      try {
        await streamToFile(url, src.tmp, task)
        return
      } catch (e) {
        if (task.cancelRequested) throw e
        lastErr = e
      }
    }
    throw lastErr || new Error('没有可用的下载地址')
  }

  /** 真正跑一个下载：流式写 .part →（必要时 ffmpeg 合轨）→ rename 成正式文件。 */
  async function run(item) {
    const task = tasks.get(item.id)
    if (!task) return
    task.status = 'downloading'
    task.startedAt = Date.now()
    task.received = 0
    task.total = 0
    task.baseReceived = 0
    task.baseTotal = 0
    try {
      for (const src of item.sources) {
        await downloadSource(task, src)
        if (task.cancelRequested) {
          settleCancelled(task)
          return
        }
        const size = fs.statSync(src.tmp).size
        if (size <= 0) {
          failTask(task, '下载结果为空文件')
          return
        }
      }
      if (task.cancelRequested) {
        settleCancelled(task)
        return
      }
      if (item.mux) {
        task.status = 'muxing'
        const ffmpeg = findFfmpeg()
        let muxErr = null
        if (!ffmpeg) muxErr = new Error('找不到 ffmpeg')
        else {
          try {
            await muxWithFfmpeg(ffmpeg, item.sources[0].tmp, item.sources[1].tmp, task.path)
          } catch (e) {
            muxErr = e
          }
        }
        if (task.cancelRequested) {
          settleCancelled(task)
          return
        }
        if (muxErr) {
          // 合轨失败（ffmpeg 损坏/编码不兼容等）：别把已下好的轨删掉，
          // 改为分别保存视频/音频两个文件，并说明原因。
          fs.renameSync(item.sources[0].tmp, task.paths[0])
          fs.renameSync(item.sources[1].tmp, task.audioPath)
          task.paths = [task.path, task.audioPath]
          task.temps = []
          task.note =
            'ffmpeg 合轨失败（' + (muxErr && muxErr.message ? muxErr.message : String(muxErr)) + '），已分别保存视频/音频'
        } else {
          cleanupTemps(task)
          task.note = ''
        }
      } else if (item.sources.length > 1) {
        // 无 ffmpeg：分别落盘视频轨/音频轨
        fs.renameSync(item.sources[0].tmp, item.videoPath)
        fs.renameSync(item.sources[1].tmp, item.audioPath)
        task.temps = []
      } else {
        fs.renameSync(item.sources[0].tmp, task.path)
        task.temps = []
      }
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

  /** 取消收尾：清理所有临时文件，状态落 cancelled（不是 error）。 */
  function settleCancelled(task) {
    cleanupTemps(task)
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
        // 多源（视频轨+音频轨）时进度累计：base 是前一阶段已下的字节与总量。
        const baseReceived = Number(task.baseReceived) || 0
        const baseTotal = Number(task.baseTotal) || 0
        if (!Number.isNaN(contentLength)) {
          task.total = baseTotal + contentLength
          task.baseTotal = task.total
        }
        task.received = baseReceived
        let fileReceived = 0
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
          fileReceived += chunk.length
          task.received = baseReceived + fileReceived
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
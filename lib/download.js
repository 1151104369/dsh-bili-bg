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
import { resolveBvid, resolvePlay, UA, REFERER } from './bili.js'

const MAX_CONCURRENT = 2
const MAX_TASKS = 50
const MAX_REDIRECTS = 3

/** 下载根目录：优先系统 Downloads（存在时），否则退回 $DSH_HOME/downloads。 */
function resolveDownloadsBase(homeDir) {
  let homeDl = ''
  try {
    const dl = path.join(os.homedir(), 'Downloads')
    if (fs.existsSync(dl)) homeDl = dl
  } catch {
    homeDl = ''
  }
  if (homeDl) return homeDl
  return path.join(homeDir, 'downloads')
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

  /**
   * 发起一次下载。先解析出元数据与 CDN 直链，成功后才登记任务并排队；
   * 解析/无播放源失败会抛错（由路由转成 422 可读 JSON）。
   * @param {string} input BV 号 / 链接
   * @returns {Promise<{id: string, task: object}>}
   */
  async function startDownload(input) {
    const resolved = await resolveBvid(input)
    if (!resolved || resolved.ok !== true) {
      throw new Error((resolved && resolved.error) || '无法识别视频')
    }
    const play = await resolvePlay(resolved.bvid, resolved.cid)
    if (!play.url) {
      throw new Error(play.error || '该视频没有可下载的播放源')
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
      path: '',
      error: '',
      startedAt: null,
      finishedAt: null,
    }
    const dir = downloadsDir()
    fs.mkdirSync(dir, { recursive: true })
    const finalPath = uniquePath(dir, sanitizeFilename(resolved.title) + '-' + resolved.bvid)
    task.path = finalPath

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
      const stat = fs.statSync(item.tmp)
      if (stat.size <= 0) {
        failTask(task, '下载结果为空文件')
        return
      }
      fs.renameSync(item.tmp, task.path)
      task.status = 'done'
      task.finishedAt = Date.now()
    } catch (err) {
      failTask(task, err)
    }
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
        res.on('data', (chunk) => {
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
    listDownloads,
    getDownload,
    getDownloadDir: downloadsDir,
  }
}
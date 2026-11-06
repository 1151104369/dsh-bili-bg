/**
 * dsh-bili-bg —— 宿主半边。
 *
 * 让「B 站视频当背景边工作边看」成立的三件事：
 *   ① 给 `webserver/index-inject` 贡献两行结构化注入（样式 + 运行时脚本），
 *      页面加载时把全屏视频背景层与一个控制面板挂上去；
 *   ② 用几个路由把 B 站接口的解析（BV→播放源、热门/排行榜队列）和播放流**代理由本地**：
 *      浏览器 <video> 只认同源 URL，而 B 站 CDN 需要 Referer 且分 Range，所以由宿主抓流转发；
 *   ③ 把用户状态（当前来源/上次播放/静音/专注）落盘到 $DSH_HOME/dsh-bili-bg.json。
 *
 * 与 dsh-video-skin 同样的容错原则：**这块背景是装饰品**，任何一步失败都只 warn 并跳过，
 * 绝不能让索引渲染或应用启动失败。所以 inject 是空数组，apply 立刻跑并先注册订阅；
 * 不 import 任何 DSH 包（只用 node: 内建），避免"依赖解析不到 ⇒ fiber FAILED"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ROUTE_PREFIX,
  fetchQueue,
  openMediaStream,
  openDashMedia,
  resolveBvid,
  resolveBvidHd,
} from './lib/bili.js'
import {
  generateQr,
  pollQr,
  confirmLogin,
  ensureNav,
  getLoginStatus,
  logout,
  buildCookieHeader,
} from './lib/auth.js'
import { qrPng } from './lib/qr.js'
import { createDownloader } from './lib/download.js'
import { pickSavePath } from './lib/save-dialog.js'
import { BOOTSTRAP_GLOBAL, buildInjectionRows } from './lib/injections.js'

export { BOOTSTRAP_GLOBAL, ROUTE_PREFIX }

/** Cordis 诊断用插件名。 */
export const name = 'dsh-bili-bg'
/** 没有必需服务：webServer 用 ctx.inject 迟到接入，不阻塞 apply。 */
export const inject = []

/** 与 package.json 的 version 保持一致。 */
export const VERSION = '0.3.3'

const CONFIG_ROUTE = `${ROUTE_PREFIX}/config.json`
const PLAY_ROUTE = `${ROUTE_PREFIX}/play`
const MEDIA_ROUTE = `${ROUTE_PREFIX}/media`
const QUEUE_ROUTE = `${ROUTE_PREFIX}/queue`
const STATE_ROUTE = `${ROUTE_PREFIX}/state`
const AUTH_QR_ROUTE = `${ROUTE_PREFIX}/auth/qr`
const AUTH_POLL_ROUTE = `${ROUTE_PREFIX}/auth/poll`
const AUTH_STATUS_ROUTE = `${ROUTE_PREFIX}/auth/status`
const AUTH_LOGOUT_ROUTE = `${ROUTE_PREFIX}/auth/logout`
const DOWNLOAD_ROUTE = `${ROUTE_PREFIX}/download`
const DOWNLOADS_ROUTE = `${ROUTE_PREFIX}/downloads`

/** 已生成、尚未扫码/未过期的二维码内容（按 qrcode_key 索引，仅内存，随扫码/过期清理）。 */
const pendingQrs = new Map()

const STATE_FILE = 'dsh-bili-bg.json'
const STATE_BODY_LIMIT = 64 * 1024
const DOWNLOAD_BODY_LIMIT = 16 * 1024
const RUNTIME_DIR = 'runtime'

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function resolveDshHome() {
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim()) return home.trim()
  try {
    return path.join(os.homedir(), '.dsh')
  } catch {
    return path.join(os.tmpdir(), '.dsh')
  }
}

/** 按 mtime+size 缓存运行时文本（改完 runtime/*.js 刷新页面即生效）。 */
function makeRuntimeReader(packageRoot) {
  const cache = new Map()
  return (file) => {
    const target = path.join(packageRoot, RUNTIME_DIR, file)
    const stat = fs.statSync(target)
    const hit = cache.get(file)
    if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text
    const text = fs.readFileSync(target, 'utf8')
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, text })
    return text
  }
}

function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        done = true
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (e) => {
      if (!done) {
        done = true
        reject(e)
      }
    })
  })
}

function sendJson(res, status, value) {
  const text = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

function parseUrl(req) {
  try {
    return new URL(String(req.url ?? '/'), 'http://127.0.0.1')
  } catch {
    return new URL('http://127.0.0.1/')
  }
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const packageRoot = fileURLToPath(new URL('.', import.meta.url))
  const homeDir = resolveDshHome()
  const downloader = createDownloader(homeDir)
  const stateFile = path.join(homeDir, STATE_FILE)
  const readRuntime = makeRuntimeReader(packageRoot)

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[${name}] ${message}`)
    } catch {
      /* 日志不该成为失败原因 */
    }
  }
  const info = (message) => {
    try {
      ctx.logger?.info?.(`[${name}] ${message}`)
    } catch {
      /* 同上 */
    }
  }

  const current = () => ({
    version: VERSION,
    name,
    config: CONFIG_ROUTE,
    play: PLAY_ROUTE,
    media: MEDIA_ROUTE,
    queue: QUEUE_ROUTE,
    state: STATE_ROUTE,
    auth: {
      create: AUTH_QR_ROUTE,
      image: AUTH_QR_ROUTE,
      poll: AUTH_POLL_ROUTE,
      status: AUTH_STATUS_ROUTE,
      logout: AUTH_LOGOUT_ROUTE,
    },
    download: {
      create: DOWNLOAD_ROUTE,
      status: DOWNLOAD_ROUTE,
      list: DOWNLOADS_ROUTE,
    },
    defaults: {
      source: 'popular',
      count: 12,
      volume: 0.8,
      veillight: 0.3,
      veil: 0.32,
      autostart: false,
    },
  })

  // ── ① 注入行：必须同步注册，且不能等任何服务就绪 ──
  ctx.on('webserver/index-inject', (table) => {
    if (!Array.isArray(table)) return
    try {
      const cssText = readRuntime('skin.css')
      const jsText = readRuntime('skin.js')
      const dashText = readRuntime('dash.js')
      table.push(...buildInjectionRows({ clientConfig: current(), cssText, jsText, dashText }))
    } catch (error) {
      warn(`注入行生成失败，页面将没有 B 站背景面板：${describe(error)}`)
    }
  })

  // ── ② 路由：webServer 是可选能力，晚到就晚接 ──
  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      const disposers = []

      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: CONFIG_ROUTE,
          handler: (req, res) => {
            let payload
            try {
              payload = current()
            } catch (error) {
              payload = { error: describe(error) }
            }
            sendJson(res, 200, payload)
          },
        }),
      )

      // 解析一个 BV/链接 → 元数据 + 播放地址。
      // ?hd=1 → 带登录 Cookie 走 DASH 分轨（高清，>720p，url 里可再带 qn=80/112/116 指定清晰度）；
      // 否则走现有单文件 mp4（无登录 ~360p~720p）。DASH 拿不到会由宿主自动回退 720p 单文件。
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: PLAY_ROUTE,
          handler: (req, res) => {
            const url = parseUrl(req)
            const input = url.searchParams.get('bvid') || url.searchParams.get('aid') || ''
            if (!input) {
              sendJson(res, 400, { ok: false, error: '需要 bvid 或 aid 参数' })
              return
            }
            // 附带一个"直连本机 HTTP"的 mediaBase：页面经过 dsh-app:// 的转发层会丢掉
            // 响应的 Content-Length，导致 <video> 无法建立可 seek 的时长/范围（表现为
            // 能顺序播放、但一拖进度条就回 0）。让媒体直连 127.0.0.1:<port> 可拿到完整
            // 的 206/Content-Range，拖动就正常了。客户端失败时会自动回退到相对代理地址。
            const mediaBase = (() => {
              try {
                const ws = child.webServer
                if (!ws || !ws.port) return ''
                const proto = String(ws.protocol || 'http')
                return (proto.indexOf(':') >= 0 ? proto : proto + ':') + '//127.0.0.1:' + String(ws.port)
              } catch {
                return ''
              }
            })()
            const hd = url.searchParams.get('hd') === '1'
            const qn = parseInt(url.searchParams.get('qn') || '0', 10)
            const cookie = hd ? buildCookieHeader(homeDir) : ''
            const task = hd
              ? resolveBvidHd(input, cookie, qn || undefined)
              : resolveBvid(input)
            task
              .then((result) => {
                // 直连本机 HTTP 时，把 mediaBase 挂到结果上（单文件 src 与 DASH 各轨的 media 都是相对路径）。
                if (mediaBase !== '' && result && typeof result.src === 'string' && result.src.charAt(0) === '/') {
                  result.mediaBase = mediaBase
                }
                sendJson(res, result.ok ? 200 : 422, result)
              })
              .catch((error) => sendJson(res, 500, { ok: false, error: describe(error) }))
          },
        }),
      )

      // 播放流代理：带 Range 转发，供 <video> 加载/拖进度。
      // ?kind=video|audio&idx=N → 代理 DASH 分轨（MSE 用）；否则代理单文件 mp4。
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: MEDIA_ROUTE,
          handler: (req, res) => {
            // CORS 预检：MSE 用 fetch 从页面直连 127.0.0.1 拉分轨（跨源），且带了 Range
            // 这个非「简单请求」头，浏览器一定先发 OPTIONS。**必须在这里直接答，绝不能
            // 当成媒体 GET 去代理**——否则会去上游拉整条 m4s（可达 2GB+）并一直挂着，
            // 浏览器的 fetch 永远不 resolve，表现就是「提示高清播放中但画面永远不出来」。
            if (String(req.method ?? '').toUpperCase() === 'OPTIONS') {
              try {
                res.writeHead(204, {
                  'Access-Control-Allow-Origin': '*',
                  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                  'Access-Control-Allow-Headers': 'Range, Content-Type, If-Range',
                  'Access-Control-Max-Age': '600',
                  'Content-Length': '0',
                })
                res.end()
              } catch {
                /* connection gone */
              }
              return
            }
            const url = parseUrl(req)
            const bvid = url.searchParams.get('bvid') || ''
            const cid = url.searchParams.get('cid') || ''
            if (!bvid || !cid) {
              res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('media: need bvid and cid')
              return
            }
            const range = typeof req.headers.range === 'string' ? req.headers.range : undefined
            const kind = url.searchParams.get('kind') || ''
            const idx = url.searchParams.get('idx')
            const qn = parseInt(url.searchParams.get('qn') || '0', 10)
            // DASH 分轨的播放地址已带登录态签名，但解析分轨需 cookie 才能拿到该清晰度，
            // 所以这里仍带 cookie 重解析一次（有 90s 缓存兜底）；CDN 本身靠 Referer。
            const cookie = kind ? buildCookieHeader(homeDir) : ''
            const task =
              kind && idx !== null
                ? openDashMedia(bvid, cid, kind, idx, range, cookie, qn || undefined)
                : openMediaStream(bvid, cid, range)
            task
              .then((upstream) => {
                if (!upstream || upstream.error) {
                  const message = upstream?.error || 'no playable source'
                  res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
                  res.end(`media: ${message}`)
                  return
                }
                const status = upstream.status || 200
                const headers = {
                  'Content-Type': upstream.headers['content-type'] || 'video/mp4',
                  'Accept-Ranges': upstream.headers['accept-ranges'] || 'bytes',
                  'Cache-Control': 'no-store',
                  // MSE 用 fetch 从页面直连 127.0.0.1 拉分轨（不同源），必须有 CORS 头。
                  'Access-Control-Allow-Origin': '*',
                }
                if (upstream.headers['content-length']) headers['Content-Length'] = upstream.headers['content-length']
                if (upstream.headers['content-range']) headers['Content-Range'] = upstream.headers['content-range']
                if (upstream.headers.etag) headers.ETag = upstream.headers.etag
                res.writeHead(status, headers)
                if (req.method === 'HEAD') {
                  upstream.stream.destroy()
                  res.end()
                  return
                }
                let closed = false
                const close = () => {
                  if (closed) return
                  closed = true
                  try {
                    upstream.stream.destroy()
                  } catch {
                    /* ignore */
                  }
                }
                req.on('close', close)
                upstream.stream.on('error', () => {
                  try {
                    res.destroy()
                  } catch {
                    /* ignore */
                  }
                })
                upstream.stream.pipe(res)
              })
              .catch((error) => {
                try {
                  res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
                  res.end(`media: ${describe(error)}`)
                } catch {
                  /* connection gone */
                }
              })
          },
        }),
      )

      // 热门 / 排行榜队列。
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: QUEUE_ROUTE,
          handler: (req, res) => {
            const url = parseUrl(req)
            const source = url.searchParams.get('source') || 'popular'
            const count = url.searchParams.get('count') || '12'
            const cookie = source === 'feed' ? buildCookieHeader(homeDir) : ''
            fetchQueue(source, count, cookie)
              .then((result) => sendJson(res, 200, { ok: true, ...result }))
              .catch((error) => sendJson(res, 502, { ok: false, error: describe(error) }))
          },
        }),
      )

      // 下载当前视频：POST 发起（body {bvid}），GET 按 ?id= 查任务状态。
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: DOWNLOAD_ROUTE,
          handler: (req, res) => {
            const method = String(req.method ?? 'GET').toUpperCase()
            if (method === 'POST') {
              readBody(req, DOWNLOAD_BODY_LIMIT)
                .then((text) => {
                  let body
                  try {
                    body = JSON.parse(text)
                  } catch (error) {
                    sendJson(res, 400, { ok: false, error: `无效的 JSON：${describe(error)}` })
                    return
                  }
                  if (!body || typeof body !== 'object' || typeof body.bvid !== 'string' || !body.bvid.trim()) {
                    sendJson(res, 400, { ok: false, error: '需要 bvid 字段（当前播放视频的 BV 号）' })
                    return
                  }
                  // 保存位置：body 带了显式 dir+filename（如测试/自动化）就直接用；
                  // 否则弹 Windows「另存为」对话框（默认目录=注册表 KnownFolder 系统下载目录）。
                  // 对话框开着时请求会挂住——这是有意的：用户确认/取消后才继续。
                  // 客户端页面关掉（req close）→ kill 对话框进程，不留僵尸窗口。
                  const explicitDir = typeof body.dir === 'string' ? body.dir.trim() : ''
                  const explicitName = typeof body.filename === 'string' ? body.filename.trim() : ''
                  const noDialog = process.env.DSH_BILI_NO_DIALOG === '1' || (explicitDir && explicitName)
                  let dialogChild = null
                  const onReqClose = () => {
                    try {
                      if (dialogChild && dialogChild.exitCode === null) dialogChild.kill()
                    } catch {
                      /* ignore */
                    }
                  }
                  req.on('close', onReqClose)
                  downloader
                    .startDownload(body.bvid.trim(), {
                      decide: async (info) => {
                        if (explicitDir && explicitName) return path.join(explicitDir, explicitName)
                        if (noDialog) return ''
                        const picked = await pickSavePath(info.defaultDir, info.filename, (child) => {
                          dialogChild = child
                        })
                        if (picked === null) return '' // 弹不出保存框 → 回退默认目录自动保存
                        if (picked === '') return 'cancelled' // 用户点了取消
                        return picked
                      },
                    })
                    .then((result) => {
                      req.off?.('close', onReqClose)
                      if (result && result.cancelled) {
                        sendJson(res, 200, { ok: true, cancelled: true })
                        return
                      }
                      sendJson(res, 200, { ok: true, id: result.id, task: result.task })
                    })
                    // 解析失败 / 无播放源：422 + 可读错误，任务不落地。
                    .catch((error) => {
                      req.off?.('close', onReqClose)
                      sendJson(res, 422, { ok: false, error: describe(error) })
                    })
                })
                .catch((error) => sendJson(res, 400, { ok: false, error: describe(error) }))
              return
            }
            if (method !== 'GET' && method !== 'DELETE') {
              sendJson(res, 405, { ok: false, error: 'use GET/DELETE' })
              return
            }
            const url = parseUrl(req)
            const id = url.searchParams.get('id') || ''
            if (!id) {
              sendJson(res, 400, { ok: false, error: '需要 id 参数' })
              return
            }
            // DELETE ?id= → 中途取消（下载中断开 HTTP，排队中直接出队），并清理 .part 半成品。
            if (method === 'DELETE') {
              const cancelled = downloader.cancelDownload(id)
              if (!cancelled) {
                sendJson(res, 404, { ok: false, error: '任务不存在或已结束' })
                return
              }
              sendJson(res, 200, { ok: true, task: cancelled })
              return
            }
            const task = downloader.getDownload(id)
            if (!task) {
              sendJson(res, 404, { ok: false, error: '下载任务不存在' })
              return
            }
            sendJson(res, 200, { ok: true, task })
          },
        }),
      )

      // 全部下载任务列表 + 保存目录。
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: DOWNLOADS_ROUTE,
          handler: (req, res) => {
            try {
              sendJson(res, 200, {
                ok: true,
                list: downloader.listDownloads(),
                dir: downloader.getDownloadDir(),
              })
            } catch (error) {
              sendJson(res, 500, { ok: false, error: describe(error) })
            }
          },
        }),
      )

      // 用户状态持久化。
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: STATE_ROUTE,
          handler: (req, res) => {
            const method = String(req.method ?? 'GET').toUpperCase()
            if (method === 'GET') {
              sendJson(res, 200, { ok: true, state: readJsonFile(stateFile) })
              return
            }
            if (method === 'DELETE') {
              try {
                fs.rmSync(stateFile, { force: true })
              } catch {
                /* ignore */
              }
              sendJson(res, 200, { ok: true, state: {} })
              return
            }
            if (method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'use GET/POST/DELETE' })
              return
            }
            readBody(req, STATE_BODY_LIMIT)
              .then((text) => {
                let patch
                try {
                  patch = JSON.parse(text)
                } catch (error) {
                  sendJson(res, 400, { ok: false, error: `invalid json: ${describe(error)}` })
                  return
                }
                if (!patch || typeof patch !== 'object') {
                  sendJson(res, 400, { ok: false, error: 'body must be a json object' })
                  return
                }
                const merged = { ...readJsonFile(stateFile), ...patch }
                writeJsonFile(stateFile, merged)
                sendJson(res, 200, { ok: true, state: merged })
              })
              .catch((error) => sendJson(res, 400, { ok: false, error: describe(error) }))
          },
        }),
      )

      // 二维码登录 / 账号 / 退出。
      // POST /dsh-bili/auth/qr → 生成新二维码（返回 key 与图片路由）；GET ?key= → 返回 QR PNG。
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: AUTH_QR_ROUTE,
          handler: async (req, res) => {
            const method = String(req.method ?? 'GET').toUpperCase()
            if (method === 'POST') {
              try {
                // 顺手清理过期的旧二维码，避免内存无限增长。
                const now = Date.now()
                for (const [k, v] of pendingQrs) if (now - v.createdAt > 180000) pendingQrs.delete(k)
                const qr = await generateQr()
                pendingQrs.set(qr.key, { url: qr.url, createdAt: Date.now() })
                sendJson(res, 200, {
                  ok: true,
                  key: qr.key,
                  image: `${AUTH_QR_ROUTE}?key=${encodeURIComponent(qr.key)}`,
                })
              } catch (error) {
                sendJson(res, 502, { ok: false, error: describe(error) })
              }
              return
            }
            // GET：渲染已生成二维码的 PNG。
            const url = parseUrl(req)
            const key = url.searchParams.get('key') || ''
            const pending = key ? pendingQrs.get(key) : undefined
            if (!pending || !pending.url) {
              sendJson(res, 410, { ok: false, error: '二维码不存在或已过期，请重新生成' })
              return
            }
            try {
              const body = qrPng(pending.url)
              res.writeHead(200, {
                'Content-Type': 'image/png',
                'Content-Length': body.length,
                'Cache-Control': 'no-store',
              })
              res.end(body)
            } catch (error) {
              sendJson(res, 500, { ok: false, error: `二维码渲染失败：${describe(error)}` })
            }
          },
        }),
      )

      // 轮询扫码状态。status: wait(未扫码) | scanned(已扫码待确认) | expired(失效) | ok(成功，已落盘)。
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: AUTH_POLL_ROUTE,
          handler: async (req, res) => {
            const url = parseUrl(req)
            const key = url.searchParams.get('key') || ''
            if (!key) {
              sendJson(res, 400, { ok: false, error: '需要 key 参数' })
              return
            }
            try {
              const result = await pollQr(key)
              if (result.status === 'ok') {
                const pending = pendingQrs.get(key)
                pendingQrs.delete(key)
                const confirmed = await confirmLogin(homeDir, {
                  url: result.url || (pending && pending.url) || '',
                  setCookie: Array.isArray(result.setCookie) ? result.setCookie : [],
                })
                sendJson(res, 200, { ok: true, status: 'ok', account: confirmed.account })
                return
              }
              sendJson(res, 200, { ok: true, status: result.status, message: result.message })
            } catch (error) {
              sendJson(res, 502, { ok: false, error: describe(error) })
            }
          },
        }),
      )

      // 登录态（只回传昵称/头像/mid，绝不回显 Cookie）。
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: AUTH_STATUS_ROUTE,
          handler: async (req, res) => {
            try {
              sendJson(res, 200, { ok: true, ...(await ensureNav(homeDir)) })
            } catch (error) {
              sendJson(res, 200, { ok: true, ...getLoginStatus(homeDir) })
            }
          },
        }),
      )

      // 退出登录：清本地 Cookie 文件。
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: AUTH_LOGOUT_ROUTE,
          handler: (req, res) => {
            sendJson(res, 200, { ok: true, ...logout(homeDir), loggedIn: false })
          },
        }),
      )

      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* already removed */
          }
        }
      }
    })
  })

  info(
    `已就绪：B 站背景（步进解析 + 本地代理）。状态文件：${stateFile}` +
      `（无登录画质约 360p~720p；接口异常时面板会提示，不影响 DSH）`,
  )
}
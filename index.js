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
  resolveBvid,
} from './lib/bili.js'
import { BOOTSTRAP_GLOBAL, buildInjectionRows } from './lib/injections.js'

export { BOOTSTRAP_GLOBAL, ROUTE_PREFIX }

/** Cordis 诊断用插件名。 */
export const name = 'dsh-bili-bg'
/** 没有必需服务：webServer 用 ctx.inject 迟到接入，不阻塞 apply。 */
export const inject = []

/** 与 package.json 的 version 保持一致。 */
export const VERSION = '0.1.0'

const CONFIG_ROUTE = `${ROUTE_PREFIX}/config.json`
const PLAY_ROUTE = `${ROUTE_PREFIX}/play`
const MEDIA_ROUTE = `${ROUTE_PREFIX}/media`
const QUEUE_ROUTE = `${ROUTE_PREFIX}/queue`
const STATE_ROUTE = `${ROUTE_PREFIX}/state`

const STATE_FILE = 'dsh-bili-bg.json'
const STATE_BODY_LIMIT = 64 * 1024
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
      table.push(...buildInjectionRows({ clientConfig: current(), cssText, jsText }))
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

      // 解析一个 BV/链接 → 元数据 + 同源播放地址。
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
            resolveBvid(input)
              .then((result) => {
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
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: MEDIA_ROUTE,
          handler: (req, res) => {
            const url = parseUrl(req)
            const bvid = url.searchParams.get('bvid') || ''
            const cid = url.searchParams.get('cid') || ''
            if (!bvid || !cid) {
              res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('media: need bvid and cid')
              return
            }
            const range = typeof req.headers.range === 'string' ? req.headers.range : undefined
            openMediaStream(bvid, cid, range)
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
            fetchQueue(source, count)
              .then((result) => sendJson(res, 200, { ok: true, ...result }))
              .catch((error) => sendJson(res, 502, { ok: false, error: describe(error) }))
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
#!/usr/bin/env node
/**
 * dsh-bili-bg 一键发布脚本。
 *
 * 用法：
 *   node scripts/release.mjs                 # 交互：问版本类型（patch/minor/major）
 *   node scripts/release.mjs patch           # 0.11.0 → 0.11.1
 *   node scripts/release.mjs minor           # 0.11.0 → 0.12.0
 *   node scripts/release.mjs major           # 0.11.0 → 1.0.0
 *   node scripts/release.mjs 0.12.3          # 指定版本
 *
 * 可选参数：
 *   --dry        演练：只 bump+测试，不提交/不发布/不推送（结束自动还原）
 *   --smoke      额外跑宿主冒烟测试（需要联网访问 B 站，较慢）
 *   --no-push    发布后不 git push
 *   --no-tests   跳过测试（不推荐）
 *   --yes        不再询问确认
 *   --allow-dirty 允许工作区有未提交改动（不推荐）
 *
 * 环境变量：
 *   NPM_OTP      直接提供 npm 二步验证码（免得交互输入）
 *   NPM_REGISTRY 覆盖发布源（默认 https://registry.npmjs.org）
 *
 * 流程：校验工作区 → bump 版本(package.json + index.js) → 测试 → git commit
 *       → 交互输入 OTP → npm publish → git push
 * 任何一步失败都会停止并给出可重试的提示。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PKG_FILE = path.join(ROOT, 'package.json')
const INDEX_FILE = path.join(ROOT, 'index.js')
const REGISTRY = process.env.NPM_REGISTRY || 'https://registry.npmjs.org'
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))

const DRY = flags.has('--dry')
const SMOKE = flags.has('--smoke')
const NO_PUSH = flags.has('--no-push')
const NO_TESTS = flags.has('--no-tests')
const YES = flags.has('--yes')
const ALLOW_DIRTY = flags.has('--allow-dirty')

// ────────────────────────────── 小工具 ──────────────────────────────

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

function log(step, msg) {
  console.log(`${c.cyan('▸')} ${c.bold(step)} ${msg}`)
}
function fail(msg, hint) {
  console.error(`\n${c.red('✖ 失败：')}${msg}`)
  if (hint) console.error(c.dim(`  提示：${hint}`))
  process.exit(1)
}
function ok(msg) {
  console.log(`${c.green('✔')} ${msg}`)
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: opts.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32' && /\.cmd$/i.test(cmd),
    env: { ...process.env, ...(opts.env || {}) },
  })
  if (res.error) fail(`执行 ${cmd} ${args.join(' ')} 出错：${res.error.message}`)
  if (res.status !== 0) {
    const tail = opts.capture && res.stdout ? `\n${String(res.stdout).trim().slice(-800)}` : ''
    fail(`${cmd} ${args.join(' ')} 退出码 ${res.status}${tail}`)
  }
  return opts.capture ? String(res.stdout || '').trim() : ''
}

/** 读一行（非隐藏）。 */
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(String(answer || '').trim())
    })
  })
}

/** 隐藏输入（用于 OTP，不回显）。非 TTY 时退化为普通读取（方便管道/CI）。 */
function askHidden(question) {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      rl.question(question, (a) => {
        rl.close()
        resolve(String(a || '').trim())
      })
    })
  }
  return new Promise((resolve) => {
    process.stdout.write(question)
    const stdin = process.stdin
    stdin.resume()
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    let buf = ''
    const cleanup = () => {
      stdin.removeListener('data', onData)
      try {
        stdin.setRawMode(false)
      } catch {
        /* ignore */
      }
      stdin.pause()
    }
    const onData = (chunk) => {
      const s = String(chunk)
      if (s === '\r' || s === '\n') {
        cleanup()
        process.stdout.write('\n')
        resolve(buf)
        return
      }
      if (s === '\u0003') {
        cleanup()
        process.stdout.write('\n')
        process.exit(1)
      }
      if (s === '\u007f' || s === '\b') {
        buf = buf.slice(0, -1)
        return
      }
      buf += s
    }
    stdin.on('data', onData)
  })
}

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'))
  return { pkg, version: String(pkg.version || '') }
}

function parseVersion(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) fail(`当前版本号格式不认识：${v}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function bumpVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind
  const [maj, min, pat] = parseVersion(current)
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`
  if (kind === 'minor') return `${maj}.${min + 1}.0`
  if (kind === 'major') return `${maj + 1}.0.0`
  fail(`未知版本类型：${kind}`, '可用 patch / minor / major 或直接给 1.2.3')
  return ''
}

/** 写回版本号：package.json 与 index.js 的 VERSION 常量保持一致。 */
function writeVersion(next) {
  const raw = fs.readFileSync(PKG_FILE, 'utf8')
  const pkg = JSON.parse(raw)
  pkg.version = next
  fs.writeFileSync(PKG_FILE, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

  const idx = fs.readFileSync(INDEX_FILE, 'utf8')
  const re = /export const VERSION = '([^']*)'/
  if (!re.test(idx)) fail('index.js 里找不到 `export const VERSION = ...`，无法同步版本号')
  fs.writeFileSync(INDEX_FILE, idx.replace(re, `export const VERSION = '${next}'`), 'utf8')
}

// ────────────────────────────── 预检查 ──────────────────────────────

function git(args, capture = true) {
  const opts = { cwd: ROOT, encoding: 'utf8' }
  if (!capture) opts.stdio = 'inherit'
  const res = spawnSync('git', args, opts)
  if (res.error) fail(`git 执行失败：${res.error.message}`)
  return { code: res.status, out: String(res.stdout || '').trim(), err: String(res.stderr || '').trim() }
}

function preflight() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out
  if (!branch) fail('当前目录不是 git 仓库？', `工作目录：${ROOT}`)
  if (!ALLOW_DIRTY) {
    const dirty = git(['status', '--porcelain']).out
    if (dirty) {
      fail('工作区有未提交的改动，请先提交或加 --allow-dirty', dirty.split('\n').slice(0, 8).join('\n'))
    }
  }
  log('仓库', `${branch} · ${ROOT}`)
  return branch
}

// ────────────────────────────── 主流程 ──────────────────────────────

async function main() {
  console.log(c.bold('\n=== dsh-bili-bg 一键发布 ===\n'))
  if (DRY) console.log(c.yellow('（演练模式：不会提交/发布/推送）\n'))

  const branch = preflight()
  const { version: current } = readVersion()
  log('当前版本', `v${current}`)

  // 1) 决定新版本
  let kind = positional[0]
  if (!kind) {
    console.log('\n选择版本类型：')
    console.log('  1) patch  —— 修 bug（' + bumpVersion(current, 'patch') + '）')
    console.log('  2) minor  —— 新功能（' + bumpVersion(current, 'minor') + '）')
    console.log('  3) major  —— 破坏性变更（' + bumpVersion(current, 'major') + '）')
    console.log('  4) 自定义版本号')
    const pick = await ask('\n请输入 1-4 [1]: ')
    kind = pick === '2' ? 'minor' : pick === '3' ? 'major' : pick === '4' ? await ask('输入版本号（如 1.2.3）: ') : 'patch'
  }
  const next = bumpVersion(current, kind)
  if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`版本号非法：${next}`)

  log('将发布', c.green(`v${next}`) + c.dim(`（当前 v${current}）`))
  if (!YES) {
    const ans = await ask(`\n确认继续？(y/N) `)
    if (!/^y(es)?$/i.test(ans)) {
      console.log(c.dim('已取消'))
      process.exit(0)
    }
  }

  // 2) 改版本号
  log('Bump', `package.json + index.js → ${next}`)
  writeVersion(next)

  // 3) 跑测试
  if (NO_TESTS) {
    console.log(c.yellow('⚠ 已跳过测试（--no-tests）'))
  } else {
    log('测试', 'client.mjs')
    run('node', [path.join(ROOT, 'tests', 'client.mjs')])
    log('测试', 'mse.mjs')
    run('node', [path.join(ROOT, 'tests', 'mse.mjs')])
    if (SMOKE) {
      log('测试', 'smoke.mjs（联网，稍慢）')
      run('node', [path.join(ROOT, 'tests', 'smoke.mjs')])
    }
    ok('测试通过')
  }

  if (DRY) {
    log('演练结束', '还原版本号')
    git(['checkout', '--', 'package.json', 'index.js'])
    ok('dry-run 完成，未提交未发布')
    return
  }

  // 4) commit
  log('提交', `chore(release): v${next}`)
  run('git', ['add', 'package.json', 'index.js'])
  run('git', ['commit', '-m', `chore(release): v${next}`])
  ok('已提交')

  // 5) 检查 npm 登录状态
  log('npm', '检查登录状态')
  let who = ''
  try {
    who = run(NPM, ['whoami', '--registry', REGISTRY], { capture: true })
  } catch {
    fail('npm 未登录', `先执行：npm login --registry ${REGISTRY}`)
  }
  log('npm', `已登录：${c.green(who)}`)

  // 6) 输入 OTP
  let otp = process.env.NPM_OTP || ''
  if (!otp) {
    console.log(c.dim('\n如果账号启用了 2FA，需要输入验证器里的 6 位码；已配置 bypass token 可直接回车。'))
    otp = await askHidden('npm 验证码（可留空）: ')
  }
  const publishArgs = ['publish', '--registry', REGISTRY, '--access', 'public']
  if (otp) publishArgs.push('--otp', otp)

  // 7) 发布
  log('发布', `npm publish → ${REGISTRY}`)
  run(NPM, publishArgs)
  ok(`已发布 ${next}`)

  // 8) 推送
  if (NO_PUSH) {
    console.log(c.yellow(`⚠ 已跳过 git push（--no-push），记得手动推送 ${branch}`))
  } else {
    log('推送', `git push origin ${branch}`)
    run('git', ['push', 'origin', branch])
    ok('已推送')
  }

  console.log(`
${c.green('🎉 发布完成')}
  ${c.bold('版本')}   v${next}
  ${c.bold('npm')}    https://www.npmjs.com/package/dsh-bili-bg/v/${next}
  ${c.bold('仓库')}   ${branch} 已更新
`)
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)))

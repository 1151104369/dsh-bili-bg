/**
 * 结构化索引注入行（`webserver/index-inject` 的贡献）。
 *
 * 契约与 dsh-video-skin 相同，由桌面壳页面侧解释器逐行应用：
 *   ① 两种渲染器都按数组顺序应用行 —— style 必须先于 script（脚本建 DOM 时不能没样式），
 *      给脚本读的 global 行必须先于读它的脚本；
 *   ② `kind:'script-src'` 在桌面壳上失败会 reject 并打掉 __DSH_BOOT_READY__ ⇒ 应用起不来，
 *      所以这里只用 `kind:'script'`（createElement + textContent，不可能失败）；
 *   ③ `placement` 只决定 script/html 进 head 还是 body；style 永远进 head。
 */
import { toInlineJson } from './bili.js'

/** 页面侧读取部署期配置用的全局名。 */
export const BOOTSTRAP_GLOBAL = '__DSH_BILI_BG__'

/**
 * 生成本插件的注入行。
 * 顺序：style → dash.js（MSE 播放器，skin 依赖它）→ 带 bootstrap 的 skin.js。
 * @param {{ clientConfig: Record<string, unknown>, cssText: string, jsText: string, dashText?: string }} input
 * @returns {Array<Record<string, unknown>>}
 */
export function buildInjectionRows(input) {
  const bootstrap = `globalThis.${BOOTSTRAP_GLOBAL}=${toInlineJson(input.clientConfig)};`
  const rows = [{ kind: 'style', text: input.cssText }]
  if (typeof input.dashText === 'string' && input.dashText.trim()) {
    // 单独一条：同一 script 里先求值 dash.js 再求值 skin.js 也行，但分开更清晰、利于排查
    rows.push({ kind: 'script', placement: 'body', text: input.dashText })
  }
  rows.push({ kind: 'script', placement: 'body', text: `${bootstrap}\n${input.jsText}` })
  return rows
}
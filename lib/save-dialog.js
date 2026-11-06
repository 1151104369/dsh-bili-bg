/**
 * dsh-bili-bg — Windows 原生「另存为」对话框（宿主侧）。
 *
 * 用 PowerShell + System.Windows.Forms.SaveFileDialog 弹出系统保存框：
 *   - 默认目录 = 调用方传入（注册表 KnownFolder 解析出的系统下载目录）；
 *   - 默认文件名 = 标题-BV号.mp4；
 *   - 用户确认 → resolve(绝对路径)；取消 → resolve('')；环境不支持 → resolve(null)。
 *
 * 为什么不用 spawnSync：对话框可能开几分钟，同步等待会**卡死 DSH 宿主整个事件循环**
 * （web 路由全挂）。这里用异步 spawn + Promise，对话框开着时宿主照常服务其它请求。
 *
 * 脚本用 -EncodedCommand（UTF-16LE base64）传递，避免引号转义地狱；
 * 对话框挂在一个不透明度 0 的 TopMost 窗体上，保证它出现在 DSH 窗口前面而不是被盖住。
 * 调用方可以通过 onChild(child) 拿到进程句柄，在 HTTP 请求断开时 kill 掉。
 *
 * pwsh 不存在时自动回退 powershell.exe；两者都失败 → resolve(null)，由上层回退自动保存。
 */
import { spawn } from 'node:child_process'

const PS_SCRIPT = `
# 子进程 stdout 默认走系统控制台代码页（中文系统是 GBK），Node 这边按 UTF-8 解码会把
# 中文文件名变成乱码方块——必须先把控制台输出编码钉死成 UTF-8 再写路径。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'Manual'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
[System.Windows.Forms.Application]::DoEvents()
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = '选择视频保存位置'
$dialog.InitialDirectory = $env:DSH_DL_DIR
$dialog.FileName = $env:DSH_DL_NAME
$dialog.Filter = 'MP4 视频 (*.mp4)|*.mp4|所有文件 (*.*)|*.*'
$dialog.OverwritePrompt = $true
$dialog.AddExtension = $true
$dialog.DefaultExt = 'mp4'
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.FileName) {
  [Console]::Out.Write($dialog.FileName)
}
`

const CANDIDATES = process.platform === 'win32' ? ['pwsh', 'powershell'] : []

/**
 * 弹出保存对话框。
 * @param {string} defaultDir 默认目录（KnownFolder）
 * @param {string} defaultName 默认文件名
 * @param {(child: import('node:child_process').ChildProcess) => void} [onChild] 拿到子进程句柄（用于请求断开时 kill）
 * @returns {Promise<string|null>} 绝对路径 / ''（用户取消）/ null（环境不支持）
 */
export function pickSavePath(defaultDir, defaultName, onChild) {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64')
  const tryNext = (index) => {
    if (index >= CANDIDATES.length) return Promise.resolve(null)
    return new Promise((resolve) => {
      let settled = false
      const done = (value) => {
        if (!settled) {
          settled = true
          resolve(value)
        }
      }
      let child
      try {
        child = spawn(CANDIDATES[index], ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', encoded], {
          env: { ...process.env, DSH_DL_DIR: String(defaultDir || ''), DSH_DL_NAME: String(defaultName || '') },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      } catch {
        done(null)
        return
      }
      if (typeof onChild === 'function') {
        try {
          onChild(child)
        } catch {
          /* ignore */
        }
      }
      let out = ''
      child.stdout.on('data', (c) => {
        out += c
      })
      child.on('error', () => {
        // 该候选不可用（例如没装 pwsh）→ 试下一个；done 有 settled 保护，安全。
        tryNext(index + 1).then(done)
      })
      child.on('close', (code) => {
        const p = out.trim()
        done(code === 0 && p ? p : '')
      })
    })
  }
  return tryNext(0)
}

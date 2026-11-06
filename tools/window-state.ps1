# dsh-window-state.ps1 — 记住并恢复 DeepSeek Harness 主窗口的大小与位置
#
# 为什么需要它：DSH 桌面壳（app.asar 内 lib/main.js）把主窗口尺寸硬编码为 1280x820，
# 既没有持久化窗口状态，也没有把窗口控制暴露给插件（preload 沙箱、IPC 白名单）。
# 所以「记住窗口大小」无法由 dsh-bili-bg 这类 DSH 插件实现，只能改 DSH 本体（升级会被覆盖）
# 或像本脚本这样在系统层做。本脚本不改动 DSH 任何文件，随时可停用。
#
# 用法：
#   pwsh -File dsh-window-state.ps1            # 常驻监控（保存 + 新窗口出现时恢复）
#   pwsh -File dsh-window-state.ps1 -Once      # 只跑一轮（保存一次，便于检查）
#   pwsh -File dsh-window-state.ps1 -Reset     # 清除已保存状态
#   pwsh -File dsh-window-state.ps1 -Install   # 注册登录自启（计划任务）
#   pwsh -File dsh-window-state.ps1 -Uninstall # 移除自启
#
param(
  [switch]$Once,
  [switch]$Reset,
  [switch]$Install,
  [switch]$Uninstall,
  [int]$IntervalMs = 1500
)

$ErrorActionPreference = 'Stop'
$TaskName = 'DSH-WindowState'
$StateDir = Join-Path $env:LOCALAPPDATA 'DeepSeek Harness'
$StateFile = Join-Path $StateDir 'window-state.json'
$ProcessName = 'DeepSeek Harness'

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class DshW32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
    public int length; public int flags; public int showCmd;
    public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition;
  }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const int SW_RESTORE = 9;
  public const int SW_MAXIMIZE = 3;
}
'@

function Get-DshWindow {
  $p = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1
  if (-not $p) { return $null }
  return @{ Handle = [IntPtr]$p.MainWindowHandle; Pid = $p.Id }
}

function Read-NormalBounds($handle) {
  $wp = New-Object DshW32+WINDOWPLACEMENT
  $wp.length = [Runtime.InteropServices.Marshal]::SizeOf($wp)
  if (-not [DshW32]::GetWindowPlacement($handle, [ref]$wp)) { return $null }
  $r = $wp.rcNormalPosition
  return @{
    x = $r.Left; y = $r.Top
    width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top)
    maximized = [DshW32]::IsZoomed($handle)
    minimized = [DshW32]::IsIconic($handle)
  }
}

function Read-State {
  if (-not (Test-Path -LiteralPath $StateFile)) { return $null }
  try { return Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-State($bounds) {
  if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
  $obj = [ordered]@{
    x = [int]$bounds.x; y = [int]$bounds.y
    width = [int]$bounds.width; height = [int]$bounds.height
    maximized = [bool]$bounds.maximized
    updatedAt = (Get-Date).ToString('o')
  }
  if (Test-Path -LiteralPath $StateFile) {
    try { Copy-Item -LiteralPath $StateFile -Destination "$StateFile.bak" -Force } catch { }
  }
  $json = ($obj | ConvertTo-Json -Compress)
  $tmp = "$StateFile.tmp"
  Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $StateFile -Force
}

function Apply-State($handle, $state) {
  if (-not $state) { return $false }
  $w = [int]$state.width; $h = [int]$state.height
  if ($w -lt 520 -or $h -lt 600) { return $false }   # 低于 DSH 的 minWidth/minHeight 就放弃
  if ([DshW32]::IsIconic($handle)) { [void][DshW32]::ShowWindow($handle, [DshW32]::SW_RESTORE) }
  $ok = [DshW32]::SetWindowPos($handle, [IntPtr]::Zero, [int]$state.x, [int]$state.y, $w, $h,
    ([DshW32]::SWP_NOZORDER -bor [DshW32]::SWP_NOACTIVATE))
  if (-not $ok) { return $false }
  if ($state.maximized) { [void][DshW32]::ShowWindow($handle, [DshW32]::SW_MAXIMIZE) }
  return $true
}

if ($Reset) {
  Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath "$StateFile.bak" -Force -ErrorAction SilentlyContinue
  Write-Host "已清除窗口状态：$StateFile"
  return
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "已移除登录自启任务：$TaskName"
  return
}

if ($Install) {
  $scriptPath = $PSCommandPath
  if (-not $scriptPath) { throw '无法确定脚本路径，请用 pwsh -File 方式运行' }
  $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
  if (-not $pwsh) { $pwsh = (Get-Command powershell).Source }
  $action = New-ScheduledTaskAction -Execute $pwsh `
    -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $scriptPath)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description '记住并恢复 DeepSeek Harness 主窗口大小与位置' -Force | Out-Null
  Write-Host "已注册登录自启任务：$TaskName（注销/重启后生效）"
  return
}

# ── 保存 / 恢复 ──
$lastPid = 0
$applied = $false

function Invoke-Tick {
  $win = Get-DshWindow
  if (-not $win) {
    $script:lastPid = 0
    $script:applied = $false
    return
  }
  $bounds = Read-NormalBounds $win.Handle
  if (-not $bounds) { return }

  # 新窗口（首次出现或 DSH 重启）→ 先恢复上次保存的尺寸
  if ($win.Pid -ne $script:lastPid) {
    $script:lastPid = $win.Pid
    $script:applied = $false
    $state = Read-State
    if ($state -and -not $bounds.minimized) {
      if (Apply-State $win.Handle $state) {
        $script:applied = $true
        $bounds = Read-NormalBounds $win.Handle
      }
    }
  }

  # 用户调整过（且不是刚恢复的那一下）→ 保存
  if (-not $bounds.minimized) {
    $state = Read-State
    $changed = -not $state -or
      [int]$state.x -ne [int]$bounds.x -or [int]$state.y -ne [int]$bounds.y -or
      [int]$state.width -ne [int]$bounds.width -or [int]$state.height -ne [int]$bounds.height -or
      [bool]$state.maximized -ne [bool]$bounds.maximized
    if ($changed -and -not $script:applied) { Write-State $bounds }
    if ($script:applied) {
      # 恢复完成后允许后续保存（下一轮起 applied 失效）
      $script:applied = $false
    }
  }
}

if ($Once) {
  Invoke-Tick
  $w = Get-DshWindow
  if ($w) {
    $b = Read-NormalBounds $w.Handle
    Write-Host ("窗口: pid={0} {1}x{2} @ ({3},{4}) maximized={5} minimized={6}" -f $w.Pid, $b.width, $b.height, $b.x, $b.y, $b.maximized, $b.minimized)
    Write-Host ("状态文件: {0}" -f $StateFile)
    if (Test-Path -LiteralPath $StateFile) { Get-Content -LiteralPath $StateFile -Raw }
  } else {
    Write-Host '未找到 DeepSeek Harness 主窗口'
  }
  return
}

Write-Host ("[dsh-window-state] 启动，进程='{0}'，状态文件：{1}（Ctrl+C 退出）" -f $ProcessName, $StateFile)
while ($true) {
  try { Invoke-Tick } catch { Start-Sleep -Milliseconds 500; continue }
  Start-Sleep -Milliseconds $IntervalMs
}

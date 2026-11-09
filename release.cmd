@echo off
chcp 65001 >nul
cd /d "%~dp0"
node "scripts\release.mjs" %*
if errorlevel 1 (
  echo.
  echo [发布失败] 按任意键退出...
  pause >nul
)

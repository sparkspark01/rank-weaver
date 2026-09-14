# 启动番茄自动化控制台
# 用法：powershell -ExecutionPolicy Bypass -File scripts/start.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:PORT = if ($env:PORT) { $env:PORT } else { '3210' }
Write-Host "番茄自动化控制台启动中：http://127.0.0.1:$env:PORT" -ForegroundColor Green
Write-Host "按 Ctrl+C 停止" -ForegroundColor DarkGray
Set-Location $root
node server.mjs

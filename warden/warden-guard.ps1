# 管家守护循环：开机由 HKCU Run → wscript 隐藏启动本脚本。
# 每 5 分钟确保 ①管家(47800) ②cloudflared 命名隧道 都在跑，不在则静默拉起
# （开机自启 + 崩溃自愈合一，无需管理员权限）。
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot  # warden/ 的父 = 代码包根
$port = if ($env:WARDEN_HTTP_PORT) { [int]$env:WARDEN_HTTP_PORT } else { 47800 }  # 与 config.ts 单源对齐
$cf = Join-Path $PSScriptRoot 'bin\cloudflared.exe'
$cfg = Join-Path $env:USERPROFILE '.cloudflared\config.yml'  # 命名隧道配置（含 tunnel id + ingress）

while ($true) {
  # ① 管家 HTTP（端口探测）
  $up = $false
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $port)
    $up = $true
    $c.Close()
  } catch {}
  if (-not $up) {
    Start-Process 'cmd.exe' -ArgumentList '/c', 'npx tsx warden/server.ts' `
      -WorkingDirectory $root -WindowStyle Hidden
  }

  # ② cloudflared 命名隧道（进程探测——唯一长驻 cloudflared 即命名隧道，临时隧道已弃用）
  if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
    Start-Process $cf -ArgumentList '--config', $cfg, 'tunnel', 'run' -WindowStyle Hidden
  }

  Start-Sleep -Seconds 300
}

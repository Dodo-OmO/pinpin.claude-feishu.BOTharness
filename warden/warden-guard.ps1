# 管家守护循环：开机由 HKCU Run → wscript 隐藏启动本脚本。
# 每 5 分钟确保 ①管家(47800) ②cloudflared 命名隧道 都在跑，不在/不健康则静默拉起
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

  # ② cloudflared 命名隧道——健康探测而非仅进程探测。
  #    教训(2026-06-10)：隧道连接卡死 CloseWait 时进程仍在，Get-Process 查不出"假活"。
  #    cloudflared 自带 metrics 端口（默认在 20241-20245 取一个），GET /ready 返回 200 = 隧道已注册健康。
  $tunnelOk = $false
  foreach ($p in 20241..20245) {
    try {
      $r = Invoke-WebRequest "http://127.0.0.1:$p/ready" -TimeoutSec 2 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $tunnelOk = $true; break }
    } catch {}
  }
  if (-not $tunnelOk) {
    # 进程可能僵死（CloseWait）——先杀干净再拉起；--metrics 固定端口让下轮探测只打一个口
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    Start-Process $cf -ArgumentList '--config', $cfg, '--metrics', '127.0.0.1:20241', 'tunnel', 'run' -WindowStyle Hidden
  }

  Start-Sleep -Seconds 300
}

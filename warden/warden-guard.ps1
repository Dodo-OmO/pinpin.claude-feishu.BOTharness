# 管家守护循环：开机由 HKCU Run → wscript 隐藏启动本脚本（无需管理员权限）。
# ① 主机开关：同步盘 `品品主机.txt` 第 1 行 = 该跑品品的电脑名（第 2 行 = 切换口令）。每 30s 查一次：
#    主机从本机切走 → 停本机启动器 / 管家 / 隧道 → 频道配置放 `品品主机-交接\`（换机进行中再导出状态包）→ 写回执 `品品主机-已停-<本机名>.txt`（带口令）。
#    启动器侧切换逻辑见 launcher/main/host-lock.ts。
# ② 本机是主机：开机顺带拉起启动器（服务器断电自恢复）；每 5 分钟确保管家(47800) + cloudflared 命名隧道在跑。
param([switch]$DryRun)  # 只打印将停的进程、不停不导出，供验证
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot  # warden/ 的父 = 代码包根
$hostDir = Split-Path -Parent $root
$hostFile = Join-Path $hostDir '品品主机.txt'
$me = $env:COMPUTERNAME
$port = if ($env:WARDEN_HTTP_PORT) { [int]$env:WARDEN_HTTP_PORT } else { 47800 }  # 与 config.ts 单源对齐
$cf = Join-Path $PSScriptRoot 'bin\cloudflared.exe'
$cfg = Join-Path $env:USERPROFILE '.cloudflared\config.yml'  # 命名隧道配置（含 tunnel id + ingress）

function Read-HostLock {
  $l = @(Get-Content -LiteralPath $hostFile -Encoding UTF8 -TotalCount 2)
  if (-not $l.Count -or -not "$($l[0])".Trim()) { return $null }
  [pscustomobject]@{ Name = "$($l[0])".Trim(); Token = "$($l[1])".Trim() }
}

function Stop-PinpinHere {
  # 启动器（npm/electron-vite/electron 链，树杀连带频道与工人 claude）+ 管家 + 隧道
  $targets = Get-CimInstance Win32_Process | Where-Object {
    $c = $_.CommandLine
    if (-not $c) { return $false }
    ($_.Name -eq 'cloudflared.exe' -and $c.Contains($cf)) -or
    ($_.Name -eq 'claude.exe' -and $c -match 'feishu-channel') -or  # 频道 CLI 兜底（正常随 electron 树杀）
    ($_.Name -eq 'electron.exe' -and $c.Contains($root)) -or
    ($_.Name -eq 'node.exe' -and $c.Contains($root) -and $c -match 'electron-vite|warden[\\/]server\.ts')  # 只认本代码包；npm / cmd 外壳随子进程退出
  }
  foreach ($p in $targets) {
    if ($DryRun) { "[DryRun] 将停 $($p.ProcessId) $($p.Name) $($p.CommandLine)"; continue }
    taskkill /PID $p.ProcessId /T /F | Out-Null
  }
}

function Test-LauncherUp {
  [bool](Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) })
}

$lock = Read-HostLock
if (-not $lock) {
  if (-not $DryRun) { Set-Content -LiteralPath $hostFile -Value $me -Encoding UTF8 }
  $lock = [pscustomobject]@{ Name = $me; Token = '' }
}
$lastSeen = $lock
if ($DryRun) { "[DryRun] 主机=$($lock.Name) 本机=$me"; Stop-PinpinHere; return }

# 开机：本机是主机且启动器没开 → 等网络/网络就绪后拉起（与桌面快捷方式同一入口）
if ($lock.Name -eq $me -and -not (Test-LauncherUp)) {
  Start-Sleep -Seconds 60
  Start-Process 'wscript.exe' -ArgumentList "`"$(Join-Path $root 'scripts\launch-pinpin.vbs')`"" -WorkingDirectory $root
}

$tick = 0
while ($true) {
  $lock = Read-HostLock
  if ($lock) {
    if ($lock.Name -ne $me -and $lastSeen.Name -eq $me) {
      Stop-PinpinHere
      Start-Sleep -Seconds 3  # 等 electron 松开文件句柄
      # 频道配置 / 认人表交给接手的电脑（launcher host-lock.ts 读回执后导入）
      $handoff = Join-Path $hostDir '品品主机-交接'
      New-Item -ItemType Directory -Force -Path $handoff | Out-Null
      foreach ($f in 'channel-config.json', 'name-mappings.json') {
        Copy-Item -LiteralPath (Join-Path $env:APPDATA "pinpin-feishu-mcp\$f") -Destination $handoff -Force
      }
      # 换机进行中（状态包目录存在）→ 顺带导出最新本机状态给新机部署用
      $tools = Join-Path $hostDir '品品换机工具'
      if (Test-Path -LiteralPath (Join-Path $tools '状态包')) {
        try { & (Join-Path $tools '导出本机状态.ps1') *> (Join-Path $tools '上次导出.log') } catch { "$_" | Set-Content -LiteralPath (Join-Path $tools '上次导出.log') }
      }
      Set-Content -LiteralPath (Join-Path $hostDir "品品主机-已停-$me.txt") -Encoding UTF8 -Value @($lock.Token, (Get-Date -Format o))
    }
    $lastSeen = $lock
  }

  if ($lastSeen.Name -eq $me -and $tick % 10 -eq 0) {
    # 管家 HTTP（端口探测）
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

    # cloudflared 命名隧道——健康探测而非仅进程探测。
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
      Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $cf } | Stop-Process -Force
      Start-Sleep -Seconds 2
      Start-Process $cf -ArgumentList '--config', $cfg, '--metrics', '127.0.0.1:20241', 'tunnel', 'run' -WindowStyle Hidden
    }
  }

  $tick++
  Start-Sleep -Seconds 30
}

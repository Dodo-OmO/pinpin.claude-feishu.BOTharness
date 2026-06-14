# 创建桌面快捷方式 "品品 channel" 指向 启动品品测试.cmd
# 用法（Owner桌面）：右键此脚本 → "使用 PowerShell 运行"
#                  或 cmd：powershell -ExecutionPolicy Bypass -File scripts\create-desktop-shortcut.ps1

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
# .lnk 改指 .vbs（隐藏 cmd 窗 + 后台启动）；.cmd 保留供 dev 手动调试
$vbsPath = Join-Path $projectRoot "scripts\launch-pinpin.vbs"
$iconPng = Join-Path $projectRoot "launcher\renderer\assets\品品图标.png"

if (-not (Test-Path $vbsPath)) {
    throw "启动包装不存在: $vbsPath"
}

$desktop = [Environment]::GetFolderPath("Desktop")
$lnkPath = Join-Path $desktop "品品 channel.lnk"

# 把 PNG 转多尺寸 ICO（vista+ PNG 嵌入式 ICO，含 256/48/32/16 四尺寸 mipmap）
# 旧版用 GetHicon → Icon.Save 只存单尺寸 + 透明通道丢失 → Win 11 桌面缩 48px 显示糊+变色
$icoPath = Join-Path $projectRoot "launcher\renderer\assets\品品图标.ico"
if ((Test-Path $iconPng) -and (-not (Test-Path $icoPath))) {
    try {
        Add-Type -AssemblyName System.Drawing
        $source = [System.Drawing.Bitmap]::FromFile($iconPng)
        $sizes = @(256, 48, 32, 16)
        $pngBuffers = @()
        foreach ($size in $sizes) {
            $resized = New-Object System.Drawing.Bitmap($size, $size)
            $g = [System.Drawing.Graphics]::FromImage($resized)
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $g.DrawImage($source, 0, 0, $size, $size)
            $g.Dispose()
            $ms = New-Object System.IO.MemoryStream
            $resized.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            $pngBuffers += ,$ms.ToArray()
            $resized.Dispose()
            $ms.Dispose()
        }
        $source.Dispose()
        # 写 ICO 文件格式（ICONDIR 6B + ICONDIRENTRY 16B × 4 + PNG buffers）
        $bw = New-Object System.IO.BinaryWriter([System.IO.File]::Create($icoPath))
        $bw.Write([uint16]0)
        $bw.Write([uint16]1)
        $bw.Write([uint16]$sizes.Count)
        $offset = 6 + 16 * $sizes.Count
        for ($i = 0; $i -lt $sizes.Count; $i++) {
            $size = $sizes[$i]; $buf = $pngBuffers[$i]
            $bw.Write([byte]($size % 256))
            $bw.Write([byte]($size % 256))
            $bw.Write([byte]0); $bw.Write([byte]0)
            $bw.Write([uint16]1); $bw.Write([uint16]32)
            $bw.Write([uint32]$buf.Length); $bw.Write([uint32]$offset)
            $offset += $buf.Length
        }
        foreach ($buf in $pngBuffers) { $bw.Write($buf) }
        $bw.Close()
        Write-Host "  ✓ 已生成 ICO (4 尺寸): $icoPath" -ForegroundColor Green
    } catch {
        Write-Host "  ! ICO 生成失败 (不阻塞，快捷方式将用 cmd 默认图标): $_" -ForegroundColor Yellow
    }
}

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
# .lnk 指 wscript.exe + .vbs 参数，让 .vbs 直接被 WScript 启动；vbs 内 .Run "...", 0 = 隐藏 cmd 窗
$lnk.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$lnk.Arguments = "`"$vbsPath`""
$lnk.WorkingDirectory = $projectRoot
$lnk.Description = "品品 channel - MCP 多 CLI 飞书集成（后台启动）"
if (Test-Path $icoPath) {
    $lnk.IconLocation = "$icoPath,0"
}
$lnk.WindowStyle = 7  # 7 = minimized (wscript.exe 本身无窗口，但保险设置)
$lnk.Save()

Write-Host ""
Write-Host "  ✓ 桌面快捷方式创建成功" -ForegroundColor Green
Write-Host "    路径：$lnkPath"
Write-Host "    指向：$vbsPath"
Write-Host ""
Write-Host "  双击桌面 '品品 channel' 图标即可启动多 CLI 架构" -ForegroundColor Cyan

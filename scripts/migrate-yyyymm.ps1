<#
.SYNOPSIS
    品品 vault 沉淀目录 → YYYY-MM 平铺一层子目录 迁移脚本。

.DESCRIPTION
    把 vault 里还在平铺 / 用杂乱中文月份命名的 5 块沉淀目录，统一成 `YYYY-MM\` 一层子目录。
    默认干跑（-DryRun 语义），必须显式 -Execute 才真动文件。

    5 块：
      M1  品品work\游历\游历日记\      6 个杂乱子目录 → YYYY-MM\（迁完删空目录）
      M2  记忆系统\记忆自检\           平铺 2026-Www.md → YYYY-MM\（文件名不变）
      M3  记忆系统\周回顾\             平铺 2026-ww.md / 2026-Www.md → YYYY-MM\（统一改名带 W）
      M4  记忆系统\备份\               永存记忆-自动备份-YYYY-MM-DD.md → 按文件名日期分月
      M5  系统日志\后台账本\YYYY-MM.md 老版"一月一文件"孤儿 → 按行归并进 YYYY-MM\YYYY-MM-DD.md（不是 move）

.PARAMETER Execute
    真正执行迁移。不传 = 干跑，只打印计划、一个文件都不动。

.PARAMETER Rollback
    传入本脚本此前生成的 .log 文件路径，按日志反向还原。

.EXAMPLE
    .\migrate-yyyymm.ps1
    干跑，打印完整「源 → 目标」表 + M5 归并结果全文预览。

.EXAMPLE
    .\migrate-yyyymm.ps1 -Execute
    真跑，落 migrate-yyyymm-<时间戳>.log。

.EXAMPLE
    .\migrate-yyyymm.ps1 -Rollback .\migrate-yyyymm-20260730-101500.log
    按日志还原。

.NOTES
    ⚠️ 跑之前：品品必须停机（MCP server 会往 后台账本 追写），且已做完整备份。
#>

[CmdletBinding()]
param(
    [switch]$Execute,
    [string]$Rollback
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# ============================================================================
# 常量
# ============================================================================

$VaultRoot = '/path/to/obsidian-vault'

# 允许动的 5 个根（相对 vault）。任何源文件不在这 5 个根之内 → 前置检查③ 失败
$AllowedRoots = @(
    '品品work\游历\游历日记',
    '记忆系统\记忆自检',
    '记忆系统\周回顾',
    '记忆系统\备份',
    '系统日志\后台账本'
)

# 豁免名单（硬编码）。这些是"活文件"——代码按固定路径读写，挪了品品会静默坏掉且不报错。
# 命中即 [SKIP-EXEMPT] 打印并跳过。目录写目录名 = 整棵子树豁免。
$ExemptPaths = @(
    '记忆系统\人物',                      # instructions.ts:62-95 readdirSync 只取一层，目录异常 return "" 静默
    '记忆系统\永存记忆50条.md',
    '记忆系统\心境',                      # 含 当前.md 及同目录 .pad-bak
    '记忆系统\外部指针',
    '品品work\早报\已推送.md',
    '品品work\游历\自由活动台账.md',
    '品品work\游历\游历日记\已读.md',
    '品品技术栈',                         # 含 项目全背景\
    '对话记录',
    '对话附件',
    '他人附件',
    '品品技能',                           # 实测是指向 .claude\skills 的 Junction，碰它等于碰 skills
    '.claude',
    '.obsidian',
    '.trash',
    '归档'
)

# M1：游历日记 下的杂乱子目录 → 目标月份
$M1DirMap = [ordered]@{
    '26年5月日记' = '2026-05'
    '26年06月'    = '2026-06'
    '26年6月'     = '2026-06'
    '26年6月日记' = '2026-06'
    '26年7月日记' = '2026-07'
}

$script:Plan       = New-Object System.Collections.ArrayList   # 迁移计划条目
$script:Problems   = New-Object System.Collections.ArrayList   # 前置检查失败明细
$script:WeekTable  = [ordered]@{}                              # 周号 → 周四/归档月（打印用）

# ============================================================================
# 工具函数
# ============================================================================

function Write-Note([string]$Tag, [string]$Msg, [string]$Color = 'Gray') {
    Write-Host ("[{0}] {1}" -f $Tag, $Msg) -ForegroundColor $Color
}

<#
 ISO 周算法——严格移植品品代码 src\mcp\utils\helper.ts:44-52 的 getISOWeek()。
 不许自己另发明日期公式：这里逐行对应 TS 版，含 target.setDate(getDate() - dayNr + 3)
 那一步（把日期挪到该周的周四）。.NET 的 DayOfWeek 与 JS getDay() 一致（周日=0）。
#>
function Get-ISOWeekFromDate {
    param([Parameter(Mandatory)][datetime]$Date)

    $target = $Date.Date
    $dayNr  = ([int]$Date.DayOfWeek + 6) % 7          # JS: (d.getDay() + 6) % 7
    $target = $target.AddDays(-$dayNr + 3)            # JS: setDate(getDate() - dayNr + 3) → 本周周四
    $firstThursday = [datetime]::new($target.Year, 1, 4)
    $diff = ($target - $firstThursday).TotalMilliseconds
    $week = 1 + [math]::Round($diff / (7 * 24 * 60 * 60 * 1000))

    [PSCustomObject]@{
        Year     = $target.Year
        Week     = [int]$week
        Thursday = $target
    }
}

<#
 反查：给定 ISO 年 + 周号，求该周的周四。
 anchor 用 1月4日（ISO 定义上恒在第 1 周）推出 W1 周四，再加 (W-1) 周。
 关键：算完必须用上面那个 getISOWeek 移植版**回验**——回验不过就 throw，
 保证归档月只可能来自品品自己那套算法，不可能来自我这里的推导笔误。
#>
function Get-ISOWeekThursday {
    param(
        [Parameter(Mandatory)][int]$Year,
        [Parameter(Mandatory)][int]$Week
    )

    $jan4 = [datetime]::new($Year, 1, 4)
    $w1Thursday = $jan4.AddDays(-((([int]$jan4.DayOfWeek) + 6) % 7) + 3)
    $thursday = $w1Thursday.AddDays(($Week - 1) * 7)

    $check = Get-ISOWeekFromDate -Date $thursday
    if ($check.Year -ne $Year -or $check.Week -ne $Week -or $thursday.DayOfWeek -ne [DayOfWeek]::Thursday) {
        throw ("周号反查回验失败：{0}-W{1} 推出 {2}（{3}），回代得 {4}-W{5}" -f `
            $Year, $Week, $thursday.ToString('yyyy-MM-dd'), $thursday.DayOfWeek, $check.Year, $check.Week)
    }
    return $thursday
}

# 周号 → 归档月（YYYY-MM），顺带记进 WeekTable 供打印核对
function Get-MonthForISOWeek {
    param([int]$Year, [int]$Week)

    $key = '{0}-W{1:d2}' -f $Year, $Week
    if (-not $script:WeekTable.Contains($key)) {
        $thu = Get-ISOWeekThursday -Year $Year -Week $Week
        $script:WeekTable[$key] = [PSCustomObject]@{
            Week     = $key
            Thursday = $thu.ToString('yyyy-MM-dd')
            Month    = $thu.ToString('yyyy-MM')
        }
    }
    return $script:WeekTable[$key].Month
}

<#
 ⚠️ 关键坑：/path/to 是repo同步盘，**盘上每一个文件和目录**都带
 ReparsePoint 属性（云端占位符 reparse tag）。若照搬
 `$_.Attributes -band [IO.FileAttributes]::ReparsePoint` 去跳过，会把 100% 的文件全跳掉，
 脚本静默迁 0 个。
 真正要防的是 Junction / 符号链接（如 品品技能 → .claude\skills）——它们的判据是
 LinkType 为 Junction/SymbolicLink 且 Target 非空；云占位符这两个字段都是空。
#>
function Test-IsRealLink {
    param([Parameter(Mandatory)]$Item)

    $lt = $null
    if ($Item.PSObject.Properties.Name -contains 'LinkType') { $lt = $Item.LinkType }
    if ($lt -in @('Junction', 'SymbolicLink', 'HardLink')) { return $true }

    $tg = $null
    if ($Item.PSObject.Properties.Name -contains 'Target') { $tg = $Item.Target }
    if ($null -ne $tg -and @($tg).Count -gt 0 -and -not [string]::IsNullOrWhiteSpace(@($tg)[0])) { return $true }

    return $false
}

# 安全遍历：-Force 拿隐藏项，显式滤掉真链接（不顺着 Junction 走进去）
function Get-SafeChildren {
    param(
        [Parameter(Mandatory)][string]$Path,
        [ValidateSet('File', 'Directory', 'Any')][string]$Kind = 'Any'
    )

    if (-not (Test-Path -LiteralPath $Path)) { return @() }

    $items = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop)
    $out = New-Object System.Collections.ArrayList
    foreach ($it in $items) {
        if (Test-IsRealLink -Item $it) {
            Write-Note 'SKIP-LINK' ("跳过链接（Junction/符号链接）：{0}" -f $it.FullName) 'DarkYellow'
            continue
        }
        if ($Kind -eq 'File'      -and $it.PSIsContainer) { continue }
        if ($Kind -eq 'Directory' -and -not $it.PSIsContainer) { continue }
        [void]$out.Add($it)
    }
    return $out.ToArray()
}

# 豁免判定：路径本身或其任一祖先命中豁免名单
function Test-Exempt {
    param([Parameter(Mandatory)][string]$FullPath)

    $full = [IO.Path]::GetFullPath($FullPath)
    foreach ($rel in $ExemptPaths) {
        $ex = [IO.Path]::GetFullPath((Join-Path $VaultRoot $rel))
        if ($full -eq $ex -or $full.StartsWith($ex + '\', [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

# 源是否落在允许的 5 个根之内
function Test-InAllowedRoot {
    param([Parameter(Mandatory)][string]$FullPath)

    $full = [IO.Path]::GetFullPath($FullPath)
    foreach ($rel in $AllowedRoots) {
        $r = [IO.Path]::GetFullPath((Join-Path $VaultRoot $rel))
        if ($full.StartsWith($r + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Add-PlanEntry {
    param(
        [Parameter(Mandatory)][string]$Block,
        [Parameter(Mandatory)][ValidateSet('Move', 'Merge', 'Compliant')][string]$Kind,
        [Parameter(Mandatory)][string]$Source,
        [string]$Target = '',
        [string]$Note = ''
    )
    [void]$script:Plan.Add([PSCustomObject]@{
        Block = $Block; Kind = $Kind; Source = $Source; Target = $Target; Note = $Note
    })
}

# ============================================================================
# 计划构建：M1 ~ M5
# ============================================================================

# --- M1：游历日记 ---
function Build-M1 {
    $root = Join-Path $VaultRoot '品品work\游历\游历日记'
    if (-not (Test-Path -LiteralPath $root)) { Write-Note 'SKIP' "M1 根不存在：$root" 'DarkYellow'; return }

    foreach ($d in (Get-SafeChildren -Path $root -Kind Directory)) {
        if (Test-Exempt -FullPath $d.FullName) { Write-Note 'SKIP-EXEMPT' $d.FullName 'Cyan'; continue }

        if ($d.Name -match '^\d{4}-\d{2}$') {
            # 已经是 YYYY-MM 目标形态 → 里面的文件原地不动（幂等）
            foreach ($f in (Get-SafeChildren -Path $d.FullName -Kind File)) {
                Add-PlanEntry -Block 'M1' -Kind 'Compliant' -Source $f.FullName -Target $f.FullName -Note '已合规'
            }
            continue
        }

        if (-not $M1DirMap.Contains($d.Name)) {
            Write-Note 'WARN-UNKNOWN-DIR' ("游历日记 下有映射表外的目录，本次不动：{0}" -f $d.FullName) 'Yellow'
            continue
        }

        $month = $M1DirMap[$d.Name]
        foreach ($f in (Get-SafeChildren -Path $d.FullName -Kind File)) {
            if (Test-Exempt -FullPath $f.FullName) { Write-Note 'SKIP-EXEMPT' $f.FullName 'Cyan'; continue }
            # 交叉校验：文件名里的 YYYY-MM-DD 前缀必须和目录映射出的月份一致，
            # 不一致 = 有文件会被放错月 → 记为前置检查失败，宁可整体不跑
            if ($f.Name -match '^(\d{4})-(\d{2})-\d{2}[_\-]' -and "$($Matches[1])-$($Matches[2])" -ne $month) {
                [void]$script:Problems.Add(("④ 月份不符：{0} 文件名月份 {1}-{2}，但所在目录映射到 {3}" -f `
                    $f.FullName, $Matches[1], $Matches[2], $month))
            }
            Add-PlanEntry -Block 'M1' -Kind 'Move' -Source $f.FullName `
                -Target (Join-Path $root (Join-Path $month $f.Name)) -Note "$($d.Name) → $month"
        }
    }

    # 游历日记 根下散落的文件（当前只有豁免的 已读.md）
    foreach ($f in (Get-SafeChildren -Path $root -Kind File)) {
        if (Test-Exempt -FullPath $f.FullName) { Write-Note 'SKIP-EXEMPT' $f.FullName 'Cyan'; continue }
        if ($f.Name -match '^(\d{4})-(\d{2})-\d{2}[_\-]') {
            $m = "$($Matches[1])-$($Matches[2])"
            Add-PlanEntry -Block 'M1' -Kind 'Move' -Source $f.FullName `
                -Target (Join-Path $root (Join-Path $m $f.Name)) -Note "根散落 → $m"
        }
        else {
            Write-Note 'WARN-UNPLACEABLE' ("游历日记 根下文件名无日期前缀，本次不动：{0}" -f $f.FullName) 'Yellow'
        }
    }
}

# --- M2 / M3：按 ISO 周归月 ---
function Build-WeekBlock {
    param(
        [Parameter(Mandatory)][string]$Block,
        [Parameter(Mandatory)][string]$RelRoot,
        [Parameter(Mandatory)][bool]$NormalizeW   # $true = 统一改名成 YYYY-Www.md（M3）；$false = 文件名不变（M2）
    )

    $root = Join-Path $VaultRoot $RelRoot
    if (-not (Test-Path -LiteralPath $root)) { Write-Note 'SKIP' "$Block 根不存在：$root" 'DarkYellow'; return }

    foreach ($f in (Get-SafeChildren -Path $root -Kind File)) {
        if (Test-Exempt -FullPath $f.FullName) { Write-Note 'SKIP-EXEMPT' $f.FullName 'Cyan'; continue }
        if ($f.Name -notmatch '^(\d{4})-W?(\d{1,2})\.md$') {
            Write-Note 'WARN-UNPLACEABLE' ("$Block 文件名不是周文件，本次不动：{0}" -f $f.FullName) 'Yellow'
            continue
        }
        $y = [int]$Matches[1]; $w = [int]$Matches[2]
        $month = Get-MonthForISOWeek -Year $y -Week $w
        $newName = if ($NormalizeW) { '{0}-W{1:d2}.md' -f $y, $w } else { $f.Name }
        $note = if ($NormalizeW -and $newName -ne $f.Name) { "改名 $($f.Name) → $newName" } else { '' }
        Add-PlanEntry -Block $Block -Kind 'Move' -Source $f.FullName `
            -Target (Join-Path $root (Join-Path $month $newName)) -Note $note
    }
}

# --- M4：永存记忆自动备份，按文件名日期分月 ---
function Build-M4 {
    $root = Join-Path $VaultRoot '记忆系统\备份'
    if (-not (Test-Path -LiteralPath $root)) { Write-Note 'SKIP' "M4 根不存在：$root" 'DarkYellow'; return }

    foreach ($f in (Get-SafeChildren -Path $root -Kind File)) {
        if (Test-Exempt -FullPath $f.FullName) { Write-Note 'SKIP-EXEMPT' $f.FullName 'Cyan'; continue }
        if ($f.Name -notmatch '(\d{4}-\d{2})-\d{2}\.md$') {
            Write-Note 'WARN-UNPLACEABLE' ("M4 文件名无 YYYY-MM-DD，本次不动：{0}" -f $f.FullName) 'Yellow'
            continue
        }
        $month = $Matches[1]   # = 文件名日期 slice(0,7)
        Add-PlanEntry -Block 'M4' -Kind 'Move' -Source $f.FullName `
            -Target (Join-Path $root (Join-Path $month $f.Name)) -Note "文件名日期 → $month"
    }
}

# --- M5：后台账本 老版"一月一文件"孤儿 → 按行归并进 日文件 ---
function Build-M5 {
    $root = Join-Path $VaultRoot '系统日志\后台账本'
    if (-not (Test-Path -LiteralPath $root)) { Write-Note 'SKIP' "M5 根不存在：$root" 'DarkYellow'; return }

    foreach ($f in (Get-SafeChildren -Path $root -Kind File)) {
        if (Test-Exempt -FullPath $f.FullName) { Write-Note 'SKIP-EXEMPT' $f.FullName 'Cyan'; continue }
        if ($f.Name -notmatch '^(\d{4}-\d{2})\.md$') {
            Write-Note 'WARN-UNPLACEABLE' ("M5 根下非月文件，本次不动：{0}" -f $f.FullName) 'Yellow'
            continue
        }
        Add-PlanEntry -Block 'M5' -Kind 'Merge' -Source $f.FullName `
            -Target (Join-Path $root $Matches[1]) -Note '按行归并进日文件（非 move），完成后删源'
    }
}

# ============================================================================
# M5 归并核心（纯计算，不写盘；写盘在 Invoke-Migration 里）
# ============================================================================

# 取行首时间戳排序键；无时间戳的续行沿用上一条键（保证不被拆散）
function Get-LineKeys {
    param([string[]]$Lines)
    $keys = @(); $last = ''
    foreach ($l in $Lines) {
        if ($l -match '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})') { $last = $Matches[1] }
        $keys += $last
    }
    # 不加逗号包裹：直接往输出流写数组，由调用方统一 @() 归一。
    # （曾用 `return ,$arr` 的写法，结果被调用方 @() 又套一层，整份文件塌成 1 个 String[] 元素）
    return $keys
}

function Read-TextLines {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    $raw = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
    if ($raw.Length -eq 0) { return @() }
    return (($raw -replace "`r`n", "`n").TrimEnd("`n") -split "`n")
}

<#
 计算 M5 归并结果。返回每个受影响日文件的 { TargetFile, Before, After, Inserted, Skipped }。
 归并规则：源文件按行首日期分组 → 每组归并进 <月目录>\<YYYY-MM-DD>.md；
 先 diff 去重（整行完全相同 = 已存在，跳过不插），再按时间戳插到正确位置
 （插在"最后一条 键<=新键"之后，即同分钟组的末尾），不打乱既有行的相对顺序。
#>
function Get-M5MergeResult {
    param(
        [Parameter(Mandatory)][string]$SourceFile,
        [Parameter(Mandatory)][string]$TargetMonthDir
    )

    $srcLines = Read-TextLines -Path $SourceFile
    $groups = [ordered]@{}
    $lastDate = ''
    foreach ($l in $srcLines) {
        if ($l -match '^(\d{4}-\d{2}-\d{2})') { $lastDate = $Matches[1] }
        if ([string]::IsNullOrWhiteSpace($lastDate)) {
            throw "M5 源文件首行没有 YYYY-MM-DD 时间戳，无法判断归属日：$SourceFile"
        }
        if (-not $groups.Contains($lastDate)) { $groups[$lastDate] = New-Object System.Collections.ArrayList }
        [void]$groups[$lastDate].Add($l)
    }

    $results = New-Object System.Collections.ArrayList
    foreach ($date in $groups.Keys) {
        $targetFile = Join-Path $TargetMonthDir "$date.md"
        $before = @(Read-TextLines -Path $targetFile)
        $after = New-Object System.Collections.ArrayList
        foreach ($b in $before) { [void]$after.Add($b) }

        $inserted = 0; $skipped = 0
        foreach ($nl in $groups[$date]) {
            if ($after -contains $nl) { $skipped++; continue }   # diff 去重
            $newKey = if ($nl -match '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})') { $Matches[1] } else { "$date 00:00" }
            $keys = @(Get-LineKeys -Lines @($after))
            $pos = 0
            for ($i = 0; $i -lt $keys.Count; $i++) {
                if ([string]::Compare($keys[$i], $newKey, [StringComparison]::Ordinal) -le 0) { $pos = $i + 1 }
            }
            $after.Insert($pos, $nl)
            $inserted++
        }

        [void]$results.Add([PSCustomObject]@{
            TargetFile = $targetFile
            Before     = @($before)
            After      = $after.ToArray()
            Inserted   = $inserted
            Skipped    = $skipped
        })
    }
    return $results.ToArray()
}

# ============================================================================
# 前置检查（全量扫描后、执行前）：任一条不过 → 打印明细、退出码 1、一个文件都不动
# ============================================================================

function Test-Plan {
    $moves = @($script:Plan | Where-Object { $_.Kind -eq 'Move' })

    # ① 每个目标路径都不存在（M5 走特判，不在 moves 里）
    foreach ($e in $moves) {
        if (Test-Path -LiteralPath $e.Target) {
            [void]$script:Problems.Add(("① 目标已存在：{0}  ←  {1}" -f $e.Target, $e.Source))
        }
    }

    # ② 目标路径之间无重复
    $dupes = $moves | Group-Object -Property Target | Where-Object { $_.Count -gt 1 }
    foreach ($d in $dupes) {
        [void]$script:Problems.Add(("② 目标撞名 x{0}：{1}`n     源：{2}" -f `
            $d.Count, $d.Name, (($d.Group | ForEach-Object { $_.Source }) -join "`n         ")))
    }

    # ③ 每个源都在允许的 5 个根之内，且不命中豁免名单
    foreach ($e in @($script:Plan | Where-Object { $_.Kind -ne 'Compliant' })) {
        if (-not (Test-InAllowedRoot -FullPath $e.Source)) {
            [void]$script:Problems.Add(("③ 源不在允许的 5 个根之内：{0}" -f $e.Source))
        }
        if (Test-Exempt -FullPath $e.Source) {
            [void]$script:Problems.Add(("③ 源命中豁免名单：{0}" -f $e.Source))
        }
        if ($e.Kind -eq 'Move' -and -not (Test-InAllowedRoot -FullPath $e.Target)) {
            [void]$script:Problems.Add(("③ 目标不在允许的 5 个根之内：{0}" -f $e.Target))
        }
    }

    return ($script:Problems.Count -eq 0)
}

# ============================================================================
# 打印
# ============================================================================

function Show-WeekTable {
    if ($script:WeekTable.Count -eq 0) { return }
    Write-Host "`n=== 周号 → 周四 → 归档月（按 helper.ts getISOWeek 实算，供人工核对）===" -ForegroundColor Cyan
    $script:WeekTable.Values |
        Sort-Object Week |
        Format-Table @{L = '周号'; E = { $_.Week } }, @{L = '该周周四'; E = { $_.Thursday } }, @{L = '归档月'; E = { $_.Month } } -AutoSize |
        Out-String -Width 200 | Write-Host
}

function Show-Plan {
    Write-Host "`n=== 迁移计划（源 → 目标）===" -ForegroundColor Cyan
    foreach ($blk in @('M1', 'M2', 'M3', 'M4', 'M5')) {
        $rows = @($script:Plan | Where-Object { $_.Block -eq $blk })
        if ($rows.Count -eq 0) { continue }
        Write-Host ("`n--- {0}（{1} 条）---" -f $blk, $rows.Count) -ForegroundColor White
        foreach ($r in $rows) {
            $tag = switch ($r.Kind) { 'Compliant' { 'SKIP-COMPLIANT' } 'Merge' { 'MERGE' } default { 'MOVE' } }
            $color = switch ($r.Kind) { 'Compliant' { 'DarkGray' } 'Merge' { 'Magenta' } default { 'Green' } }
            if ($r.Kind -eq 'Compliant') {
                Write-Host ("  [{0}] {1}" -f $tag, $r.Source) -ForegroundColor $color
            }
            else {
                Write-Host ("  [{0}] {1}`n         → {2}{3}" -f $tag, $r.Source, $r.Target,
                    $(if ($r.Note) { "   ({0})" -f $r.Note } else { '' })) -ForegroundColor $color
            }
        }
    }
}

function Show-Summary {
    $mv = @($script:Plan | Where-Object { $_.Kind -eq 'Move' }).Count
    $mg = @($script:Plan | Where-Object { $_.Kind -eq 'Merge' }).Count
    $ck = @($script:Plan | Where-Object { $_.Kind -eq 'Compliant' }).Count
    Write-Host "`n=== 汇总 ===" -ForegroundColor Cyan
    foreach ($blk in @('M1', 'M2', 'M3', 'M4', 'M5')) {
        $r = @($script:Plan | Where-Object { $_.Block -eq $blk })
        if ($r.Count -eq 0) { continue }
        Write-Host ("  {0}: move={1} merge={2} 已合规={3}" -f $blk,
            @($r | Where-Object { $_.Kind -eq 'Move' }).Count,
            @($r | Where-Object { $_.Kind -eq 'Merge' }).Count,
            @($r | Where-Object { $_.Kind -eq 'Compliant' }).Count)
    }
    Write-Host ("  ────────────────────────────") -ForegroundColor DarkGray
    Write-Host ("  待迁移条数（move + merge）= {0}   [其中 move {1} / merge {2}]" -f ($mv + $mg), $mv, $mg) -ForegroundColor Yellow
    Write-Host ("  已合规原地不动 = {0}" -f $ck) -ForegroundColor DarkGray
}

function Show-M5Preview {
    foreach ($e in @($script:Plan | Where-Object { $_.Kind -eq 'Merge' })) {
        Write-Host "`n=== M5 归并结果全文预览 ===" -ForegroundColor Magenta
        Write-Host ("源：{0}" -f $e.Source)
        foreach ($m in (Get-M5MergeResult -SourceFile $e.Source -TargetMonthDir $e.Target)) {
            Write-Host ("`n目标：{0}   （原 {1} 行 → 新 {2} 行；插入 {3}，去重跳过 {4}）" -f `
                    $m.TargetFile, $m.Before.Count, $m.After.Count, $m.Inserted, $m.Skipped) -ForegroundColor Magenta
            $newSet = @($m.After | Where-Object { $m.Before -notcontains $_ })
            for ($i = 0; $i -lt $m.After.Count; $i++) {
                $line = $m.After[$i]
                if ($newSet -contains $line) {
                    Write-Host ("  {0,5} + {1}" -f ($i + 1), $line) -ForegroundColor Green
                }
                else {
                    Write-Host ("  {0,5}   {1}" -f ($i + 1), $line) -ForegroundColor DarkGray
                }
            }
        }
    }
}

# ============================================================================
# 执行
# ============================================================================

# 日志**增量**落盘：本脚本 $ErrorActionPreference='Stop'，任何一次 Move-Item 失败（云同步盘锁文件、
# 路径过长、瞬时占用）都会当场终止。若攒到最后一次性写，中途挂掉 = 已挪走的文件一行凭据都没有、
# -Rollback 无从下手——而"迁移中途失败"恰恰是最需要回滚的场景。故每条即写即落盘。
function Write-LogLine {
    param([Parameter(Mandatory)][string]$LogPath, [Parameter(Mandatory)][string]$Line)
    [IO.File]::AppendAllLines($LogPath, [string[]]@($Line), $script:Utf8NoBom)
}

function Invoke-Migration {
    param([Parameter(Mandatory)][string]$LogPath)

    $stamp = { (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') }
    # 先建空文件（同名残留一律截断），之后全部走 AppendAllLines
    [IO.File]::WriteAllText($LogPath, '', $script:Utf8NoBom)
    Write-LogLine -LogPath $LogPath -Line "# migrate-yyyymm 执行日志  开始=$(& $stamp)"
    Write-LogLine -LogPath $LogPath -Line "# 字段：MOVE|源|目标|迁移前mtime|迁移后mtime  /  RMDIR|空目录  /  M5MERGE|源|目标目录|目标备份|源备份|插入数"

    # --- Move ---
    foreach ($e in @($script:Plan | Where-Object { $_.Kind -eq 'Move' })) {
        $dir = Split-Path -Parent $e.Target
        if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }

        $before = (Get-Item -LiteralPath $e.Source -Force).LastWriteTime.ToString('o')
        # 只用 Move-Item：源和目标同在 D: 卷，这是文件系统 rename，mtime 天然不变。
        # 绝不做 Copy-Item + Remove-Item，也绝不手动回写 LastWriteTime。
        Move-Item -LiteralPath $e.Source -Destination $e.Target -ErrorAction Stop
        $after = (Get-Item -LiteralPath $e.Target -Force).LastWriteTime.ToString('o')

        Write-LogLine -LogPath $LogPath -Line "MOVE|$($e.Source)|$($e.Target)|$before|$after"
        if ($before -ne $after) {
            Write-Note 'WARN-MTIME' ("mtime 变了！{0}  {1} → {2}" -f $e.Target, $before, $after) 'Red'
        }
        Write-Host ("  [MOVED] {0}`n       → {1}" -f $e.Source, $e.Target) -ForegroundColor Green
    }

    # --- M5 归并 ---
    foreach ($e in @($script:Plan | Where-Object { $_.Kind -eq 'Merge' })) {
        if (-not (Test-Path -LiteralPath $e.Target)) { [void](New-Item -ItemType Directory -Path $e.Target -Force) }
        $srcBak = "$LogPath.m5-source.bak"
        Copy-Item -LiteralPath $e.Source -Destination $srcBak -Force

        $idx = 0
        foreach ($m in (Get-M5MergeResult -SourceFile $e.Source -TargetMonthDir $e.Target)) {
            $idx++
            $tgtBak = "$LogPath.m5-target-$idx.bak"
            if (Test-Path -LiteralPath $m.TargetFile) { Copy-Item -LiteralPath $m.TargetFile -Destination $tgtBak -Force }
            else { [IO.File]::WriteAllText($tgtBak, '', $script:Utf8NoBom) }

            # 原文件是 UTF-8 无 BOM + 纯 LF + 末尾带换行（实测），归并后必须保持一致
            $text = ($m.After -join "`n") + "`n"
            $tmp = "$($m.TargetFile).migrating.tmp"
            [IO.File]::WriteAllText($tmp, $text, $script:Utf8NoBom)
            Move-Item -LiteralPath $tmp -Destination $m.TargetFile -Force

            Write-LogLine -LogPath $LogPath -Line "M5MERGE|$($e.Source)|$($m.TargetFile)|$tgtBak|$srcBak|$($m.Inserted)"
            Write-Host ("  [MERGED] {0}  插入 {1} 行，去重跳过 {2} 行" -f $m.TargetFile, $m.Inserted, $m.Skipped) -ForegroundColor Magenta
        }

        Remove-Item -LiteralPath $e.Source -Force
        Write-Host ("  [REMOVED-SRC] {0}（已备份到 {1}）" -f $e.Source, $srcBak) -ForegroundColor Magenta
    }

    # --- 删 M1 的空目录 ---
    $m1Root = Join-Path $VaultRoot '品品work\游历\游历日记'
    foreach ($name in $M1DirMap.Keys) {
        $d = Join-Path $m1Root $name
        if (-not (Test-Path -LiteralPath $d)) { continue }
        $left = @(Get-ChildItem -LiteralPath $d -Force)
        if ($left.Count -eq 0) {
            Remove-Item -LiteralPath $d -Force
            Write-LogLine -LogPath $LogPath -Line "RMDIR|$d"
            Write-Host ("  [RMDIR] {0}" -f $d) -ForegroundColor Green
        }
        else {
            Write-Note 'WARN-NOT-EMPTY' ("目录非空未删（还剩 {0} 项）：{1}" -f $left.Count, $d) 'Yellow'
        }
    }

    Write-LogLine -LogPath $LogPath -Line "# 结束=$(& $stamp)"
    Write-Host ("`n执行日志已落盘：{0}" -f $LogPath) -ForegroundColor Cyan
}

function Invoke-Rollback {
    param([Parameter(Mandatory)][string]$LogPath)

    if (-not (Test-Path -LiteralPath $LogPath)) { Write-Host "日志文件不存在：$LogPath" -ForegroundColor Red; exit 1 }
    $lines = @([IO.File]::ReadAllLines($LogPath, [Text.Encoding]::UTF8))
    [array]::Reverse($lines)   # 反向还原

    Write-Host "=== 回滚模式 ===" -ForegroundColor Yellow
    $n = 0
    foreach ($l in $lines) {
        if ($l.StartsWith('#') -or [string]::IsNullOrWhiteSpace($l)) { continue }
        $p = $l.Split('|')
        switch ($p[0]) {
            'MOVE' {
                $src = $p[1]; $dst = $p[2]
                if (-not (Test-Path -LiteralPath $dst)) { Write-Note 'SKIP' "目标已不在，跳过：$dst" 'DarkYellow'; break }
                $sd = Split-Path -Parent $src
                if (-not (Test-Path -LiteralPath $sd)) { [void](New-Item -ItemType Directory -Path $sd -Force) }
                Move-Item -LiteralPath $dst -Destination $src -ErrorAction Stop
                Write-Host ("  [UNDO-MOVE] {0} → {1}" -f $dst, $src) -ForegroundColor Green; $n++
            }
            'M5MERGE' {
                $src = $p[1]; $tgt = $p[2]; $tgtBak = $p[3]; $srcBak = $p[4]
                if (Test-Path -LiteralPath $tgtBak) {
                    Copy-Item -LiteralPath $tgtBak -Destination $tgt -Force
                    Write-Host ("  [UNDO-MERGE] 已从备份还原 {0}" -f $tgt) -ForegroundColor Magenta; $n++
                }
                if ((Test-Path -LiteralPath $srcBak) -and -not (Test-Path -LiteralPath $src)) {
                    Copy-Item -LiteralPath $srcBak -Destination $src -Force
                    Write-Host ("  [UNDO-MERGE] 已还原源文件 {0}" -f $src) -ForegroundColor Magenta
                }
            }
            'RMDIR' {
                $d = $p[1]
                if (-not (Test-Path -LiteralPath $d)) { [void](New-Item -ItemType Directory -Path $d -Force) }
                Write-Host ("  [UNDO-RMDIR] {0}" -f $d) -ForegroundColor Green; $n++
            }
        }
    }
    Write-Host ("`n回滚完成，共还原 {0} 项。" -f $n) -ForegroundColor Cyan
    exit 0
}

# ============================================================================
# 主流程
# ============================================================================

if ($Rollback) { Invoke-Rollback -LogPath $Rollback }

$mode = if ($Execute) { '真跑（-Execute）' } else { '干跑（默认 -DryRun，不动任何文件）' }
Write-Host "=== 品品 vault YYYY-MM 迁移 ===" -ForegroundColor Cyan
Write-Host ("vault: {0}" -f $VaultRoot)
Write-Host ("模式 : {0}" -f $mode) -ForegroundColor $(if ($Execute) { 'Red' } else { 'Green' })

if (-not (Test-Path -LiteralPath $VaultRoot)) { Write-Host "vault 根不存在：$VaultRoot" -ForegroundColor Red; exit 1 }

# 1) 全量扫描
Write-Host "`n--- 扫描 ---" -ForegroundColor Cyan
Build-M1
Build-WeekBlock -Block 'M2' -RelRoot '记忆系统\记忆自检' -NormalizeW $false
Build-WeekBlock -Block 'M3' -RelRoot '记忆系统\周回顾'   -NormalizeW $true
Build-M4
Build-M5

Show-WeekTable
Show-Plan
# M5 归并预览有几百行，先打——否则会把下面的汇总和前置检查结论冲出屏幕，人要审的恰恰是后者
if (-not $Execute) { Show-M5Preview }
Show-Summary

# 2) 前置检查
Write-Host "`n=== 前置检查 ===" -ForegroundColor Cyan
if (-not (Test-Plan)) {
    Write-Host ("不通过，共 {0} 处冲突——一个文件都不会动：`n" -f $script:Problems.Count) -ForegroundColor Red
    foreach ($p in $script:Problems) { Write-Host ("  • {0}" -f $p) -ForegroundColor Red }
    exit 1
}
Write-Host "  ① 目标路径均不存在  ② 目标无重复  ③ 源均在允许根内且未命中豁免  ④ M1 文件名月份与目录映射一致  → 全部通过" -ForegroundColor Green

# 3) 干跑：到此为止（M5 预览已在前置检查之前打过）；真跑：执行
if (-not $Execute) {
    Write-Host "`n干跑结束——没有动任何文件。确认无误后加 -Execute 真跑。" -ForegroundColor Green
    exit 0
}

Write-Host "`n--- 执行 ---" -ForegroundColor Red
$logPath = Join-Path $PSScriptRoot ("migrate-yyyymm-{0}.log" -f (Get-Date).ToString('yyyyMMdd-HHmmss'))
Invoke-Migration -LogPath $logPath
Write-Host "`n完成。回滚命令：" -ForegroundColor Cyan
Write-Host ("  .\migrate-yyyymm.ps1 -Rollback `"{0}`"" -f $logPath) -ForegroundColor Cyan
exit 0

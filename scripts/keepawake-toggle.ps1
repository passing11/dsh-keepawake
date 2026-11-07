# keepawake-toggle.ps1 -- 「DSH 保活」的总开关
#   开 -> 后台起看门狗: 我在思考/干活时阻止系统睡眠, 空闲满 IdleMinutes 分钟自动放开
#   关 -> 杀掉看门狗, 立刻恢复你原来的睡眠计划
#
# 用法:
#   ... keepawake-toggle.ps1                切换开/关(弹窗告诉你结果)
#   ... keepawake-toggle.ps1 -Action On     明确开启
#   ... keepawake-toggle.ps1 -Action Off    明确关闭
#   ... keepawake-toggle.ps1 -Action Status 只看状态
#   ... keepawake-toggle.ps1 -Quiet         不弹窗, 只打印

param(
    [ValidateSet('Toggle', 'On', 'Off', 'Status')]
    [string]$Action = 'Toggle',
    [double]$IdleMinutes = 5,
    # 默认连屏幕一起保活: 本机只有现代待机(S0), 屏幕一关就进待机
    [switch]$AllowDisplayOff,
    [switch]$Quiet
)

$watchScript = Join-Path $PSScriptRoot 'dsh-keepawake-watch.ps1'
$logFile     = "$env:TEMP\dsh-keepawake.log"
$pidFile     = "$env:TEMP\dsh-keepawake.pid"
# 严格匹配: 必须是「powershell -File ...dsh-keepawake-watch.ps1」
# (不能用 Contains/-like, 否则会匹配到我们自己这条命令行里出现的同名字符串)
$watchPattern = '-File\s+"?[^"\s]*dsh-keepawake-watch\.ps1'

function Test-IsWatchdog([int]$procId) {
    if ($procId -le 0) { return $false }
    $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    if (-not $ci) { return $false }
    return ($ci.CommandLine -match $watchPattern)
}

# PID 文件为准(快), 再扫一遍进程表(兼容手工启动的孤儿)
function Get-Watchdogs {
    $ids = New-Object System.Collections.Generic.List[int]
    if (Test-Path $pidFile) {
        $raw = Get-Content $pidFile -Raw -ErrorAction SilentlyContinue
        foreach ($tok in ([string]$raw -split '\s+')) {
            $n = 0
            if ([int]::TryParse($tok, [ref]$n) -and (Test-IsWatchdog $n) -and -not $ids.Contains($n)) { $ids.Add($n) }
        }
    }
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -match $watchPattern })
    foreach ($p in $all) {
        $n = [int]$p.ProcessId
        if (-not $ids.Contains($n)) { $ids.Add($n) }
    }
    return $ids.ToArray()
}

function Show-Msg([string]$text) {
    if ($Quiet) { Write-Output $text; return }
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    [System.Windows.Forms.MessageBox]::Show(
        $text, 'DSH 保活开关',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
}

function Start-Watchdog {
    if (-not (Test-Path $watchScript)) { return "找不到 $watchScript" }
    $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$watchScript`" -IdleMinutes $IdleMinutes"
    if ($AllowDisplayOff) { $argList += ' -AllowDisplayOff' }
    $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Hidden -PassThru
    if (-not $proc) { return "启动失败 ❌`n`n没能创建后台进程。" }
    Set-Content -Path $pidFile -Value $proc.Id -Encoding ASCII
    Start-Sleep -Milliseconds 800
    if (-not (Test-IsWatchdog $proc.Id)) {
        Remove-Item $pidFile -ErrorAction SilentlyContinue
        return "启动失败 ❌`n`n后台进程刚起来就退出了。日志: $logFile"
    }
    $extra = if ($AllowDisplayOff) { '，屏幕仍会按计划关闭（本机会因此进待机，不建议）' } else { '，屏幕会一起保持常亮' }
    return "已开启  ✅`n`n我思考、调工具、跟模型对话的期间，电脑不会自动睡眠或休眠$extra。`n停止干活满 $IdleMinutes 分钟后自动放开，恢复你原本的睡眠计划。"
}

function Stop-Watchdog {
    $ids = @(Get-Watchdogs)
    if ($ids.Count -eq 0) {
        Remove-Item $pidFile -ErrorAction SilentlyContinue
        return "当前就是关闭状态 —— 电脑按原来的计划睡眠/休眠。"
    }
    foreach ($wid in $ids) { Stop-Process -Id $wid -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    return "已关闭 ⏸`n`n看门狗已停止，锁已释放，电脑恢复原来的睡眠计划。"
}

function Get-StatusText {
    $ids = @(Get-Watchdogs)
    if ($ids.Count -eq 0) {
        $state = "关闭"
    } else {
        $state = "开启（PID $($ids -join ', ')）"
    }
    $tail = ''
    if (Test-Path $logFile) {
        $last = Get-Content $logFile -Tail 3 -ErrorAction SilentlyContinue
        if ($last) { $tail = "`n`n最近的看门狗记录：`n" + ($last -join "`n") }
    }
    return "DSH 保活：$state$tail"
}

switch ($Action) {
    'On'     { Show-Msg (Start-Watchdog) }
    'Off'    { Show-Msg (Stop-Watchdog) }
    'Status' { Show-Msg (Get-StatusText) }
    'Toggle' {
        if (@(Get-Watchdogs).Count -gt 0) { Show-Msg (Stop-Watchdog) } else { Show-Msg (Start-Watchdog) }
    }
}

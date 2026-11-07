# dsh-keepawake-watch.ps1 -- DSH 干活时自动阻止系统睡眠/休眠
# 判定"DSH 正在干活"的两个信号, 任一成立即持锁:
#   1) DSH 会话文件最近 IdleMinutes 分钟内被写过 (工具调用/思考落盘)
#   2) 任一 DSH 进程存在指向公网 443 的 ESTABLISHED 连接 (正在与模型流式对话)
# 两个信号都消失后再持续 IdleMinutes 分钟, 释放锁, 让电脑按原计划睡眠。
param(
    [double]$IdleMinutes = 5,
    # 本机只有「现代待机(S0)」：屏幕一关就等于进待机，
    # 所以默认必须连屏幕一起申请，否则 ES_SYSTEM_REQUIRED 挡不住。
    [switch]$AllowDisplayOff,
    [string]$LogFile = "$env:TEMP\dsh-keepawake.log",
    [string]$SessionRoot = "$env:USERPROFILE\.dsh\sessions",
    [string]$ProcessName = "DeepSeek Harness"
)

Add-Type -Namespace W32 -Name Power -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
"@

$ES_CONTINUOUS       = [uint32]2147483648
$ES_SYSTEM_REQUIRED  = [uint32]1
$ES_DISPLAY_REQUIRED = [uint32]2

$flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED
if (-not $AllowDisplayOff) { $flags = $flags -bor $ES_DISPLAY_REQUIRED }

function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'MM-dd HH:mm:ss')  $msg"
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Get-FileActivity {
    $newest = [datetime]::MinValue
    if (-not (Test-Path $SessionRoot)) { return $newest }
    Get-ChildItem $SessionRoot -Recurse -File -Filter "session.v4.jsonl.*" -ErrorAction SilentlyContinue |
        ForEach-Object { if ($_.LastWriteTime -gt $newest) { $newest = $_.LastWriteTime } }
    return $newest
}

function Get-DshTalking {
    $pids = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    if ($pids.Count -eq 0) { return $false }
    $conns = Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
        Where-Object { $pids -contains $_.OwningProcess -and $_.RemotePort -eq 443 }
    foreach ($c in $conns) {
        $ip = $c.RemoteAddress
        if ($ip -eq "127.0.0.1" -or $ip -eq "::1") { continue }
        if ($ip -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)') { continue }
        return $true
    }
    return $false
}

$holding = $false
$lastBusy = [datetime]::MinValue
Write-Log "watchdog 启动, 空闲阈值 $IdleMinutes 分钟, 目标进程 '$ProcessName', flags=0x$('{0:x}' -f $flags)"

try {
    while ($true) {
        $fileAct = Get-FileActivity
        $fileIdle = ((Get-Date) - $fileAct).TotalMinutes
        $busy = ($fileIdle -lt $IdleMinutes) -or (Get-DshTalking)

        if ($busy) { $lastBusy = Get-Date }

        if ($busy -and -not $holding) {
            $r = [W32.Power]::SetThreadExecutionState($flags)
            if ($r -ne 0) {
                $holding = $true
                $why = if ($fileIdle -lt $IdleMinutes) { "会话文件活跃($($fileIdle.ToString('N1'))分钟前)" } else { "正在与模型通信(公网443)" }
                Write-Log "DSH 忙 -> 持锁 [$why]"
            } else {
                Write-Log "SetThreadExecutionState 失败, 错误码 $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
            }
        }
        elseif ($busy -and $holding) {
            # 每轮重申一次: 现代待机(S0)的屏幕常亮请求会被系统超时回收, 必须持续刷新
            [W32.Power]::SetThreadExecutionState($flags) | Out-Null
        }
        elseif (-not $busy -and $holding) {
            $quiet = ((Get-Date) - $lastBusy).TotalMinutes
            if ($quiet -ge $IdleMinutes) {
                [W32.Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
                $holding = $false
                Write-Log "空闲 $($quiet.ToString('N1')) 分钟 -> 释放锁, 恢复系统休眠计划"
            }
        }

        Start-Sleep -Seconds 10
    }
}
finally {
    [W32.Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
    Write-Log "watchdog 退出, 锁已释放"
}
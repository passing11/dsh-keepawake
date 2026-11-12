# dsh-keepawake-watch.ps1 -- DSH 干活时自动阻止系统睡眠/休眠
# 判定"DSH 正在干活"的两个信号, 任一成立即持锁:
#   1) DSH 会话文件最近 IdleMinutes 分钟内被写过 (工具调用/思考落盘)
#   2) 任一 DSH 进程存在指向公网 443 的 ESTABLISHED 连接 (正在与模型流式对话)
# 两个信号都消失后再持续 IdleMinutes 分钟, 释放锁, 让电脑按原计划睡眠。
#
# 关于屏幕: 默认「允许息屏」——只申请 ES_SYSTEM_REQUIRED, 屏幕照常按电源计划关闭。
# 但 S0 现代待机机型上, 关屏本身就可能触发待机, ES_SYSTEM_REQUIRED 未必挡得住。
# 所以本脚本会自己看: 持锁期间若仍出现待机事件(Kernel-Power 506/42), 就自动升级为
# 「连屏幕一起保活」(加 ES_DISPLAY_REQUIRED), 并在日志里说明。用 -KeepDisplayOn 可跳过
# 试探、直接屏幕常亮; 用 -NoAutoDisplayOn 可关掉自动升级(宁可睡也不亮屏)。
param(
    [double]$IdleMinutes = 5,
    # 直接申请屏幕常亮, 不做"允许息屏"的试探
    [switch]$KeepDisplayOn,
    # 关掉自动升级: 即使发现持锁期间仍进了待机, 也不去申请屏幕常亮
    [switch]$NoAutoDisplayOn,
    [string]$LogFile = "$env:TEMP\dsh-keepawake.log",
    [string]$SessionRoot = $(if ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'sessions' } else { "$env:USERPROFILE\.dsh\sessions" }),
    [string]$ProcessName = "DeepSeek Harness",
    # 轮到我说话(弹卡/审批/一轮结束等你打字)时也保持唤醒。默认不加 = 轮到我时立刻放锁
    [switch]$WaitKeepAwake,
    # 宿主写的「轮到用户」标记, 必须和 index.js waitingFile() 是同一个绝对路径
    # (index.js 用 DSH_HOME || ~/.dsh, 这里保持一致)
    [string]$WaitingFile = $(if ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'dsh-keepawake-waiting.json' } else { "$env:USERPROFILE\.dsh\dsh-keepawake-waiting.json" }),
    # 标记超过这么多秒没刷新就当不存在(宿主崩了不会永久放锁)
    [int]$WaitingTtlSeconds = 90
)

Add-Type -Namespace W32 -Name Power -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
"@

$ES_CONTINUOUS       = [uint32]2147483648
$ES_SYSTEM_REQUIRED  = [uint32]1
$ES_DISPLAY_REQUIRED = [uint32]2

$flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED
if ($KeepDisplayOn) { $flags = $flags -bor $ES_DISPLAY_REQUIRED }

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

# 持锁期间系统是否还是进了待机/睡眠。
# 只看"进入"类事件: 506=进入现代待机(S0), 42=进入睡眠。507/107 是退出/恢复, 不算。
function Test-WentToSleep([datetime]$since) {
    try {
        $ev = Get-WinEvent -FilterHashtable @{
            LogName      = 'System'
            ProviderName = 'Microsoft-Windows-Kernel-Power'
            StartTime    = $since
        } -ErrorAction Stop | Where-Object { $_.Id -in 506, 42 }
        return @($ev).Count -gt 0
    } catch {
        # 读不到事件日志时保持沉默: 不能因为查不到就误升级
        return $false
    }
}

# 宿主是否正在等我回答。文件不存在 / 读不出 / JSON 解析失败 / 超过 TTL 一律当"不在等"。
function Get-WaitingUser {
    if (-not (Test-Path -LiteralPath $WaitingFile -PathType Leaf)) { return $false }
    try {
        $item = Get-Item -LiteralPath $WaitingFile -ErrorAction Stop
        if (((Get-Date) - $item.LastWriteTime).TotalSeconds -gt $WaitingTtlSeconds) { return $false }
        $raw = Get-Content -LiteralPath $WaitingFile -Raw -Encoding UTF8 -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) { return $false }
        $obj = $raw | ConvertFrom-Json -ErrorAction Stop
        return ($obj.waiting -eq $true)
    } catch {
        return $false
    }
}

$holding = $false
$lastBusy = [datetime]::MinValue
$holdStarted = [datetime]::MinValue
$displayUpgraded = $false
$probeCount = 0
$probeInterval = 6   # 每 6 轮(约 60 秒)查一次事件日志, 别每 10 秒都查
$waitingLogged = $false   # 「轮到用户」只在刚进入等待时记一行, 不每 10 秒刷屏
$waitMode = if ($WaitKeepAwake) { '等待用户也保活' } else { '等待用户不保活' }
Write-Log "watchdog 启动, 空闲阈值 $IdleMinutes 分钟, 目标进程 '$ProcessName', $waitMode, flags=0x$('{0:x}' -f $flags)"

try {
    while ($true) {
        $waiting = Get-WaitingUser
        if (-not $waiting) { $waitingLogged = $false }

        # 落到我这边说话 = 不需要为我保活。只有显式 -WaitKeepAwake 才继续走下面的正常逻辑。
        # 立刻放锁(不走 IdleMinutes 空转); continue 前自补一次 10 秒睡眠, 否则变成忙转刷屏。
        if ($waiting -and -not $WaitKeepAwake) {
            if ($holding) {
                [W32.Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
                $holding = $false
                $displayUpgraded = $false
                $probeCount = 0
            }
            if (-not $waitingLogged) {
                Write-Log "轮到用户 -> 立刻放锁, 恢复系统休眠计划"
                $waitingLogged = $true
            }
            $busy = $false
            Start-Sleep -Seconds 10
            continue
        }

        $fileAct = Get-FileActivity
        $fileIdle = ((Get-Date) - $fileAct).TotalMinutes
        $busy = ($fileIdle -lt $IdleMinutes) -or (Get-DshTalking) -or ($waiting -and $WaitKeepAwake)

        if ($busy) { $lastBusy = Get-Date }

        if ($busy -and -not $holding) {
            $r = [W32.Power]::SetThreadExecutionState($flags)
            if ($r -ne 0) {
                $holding = $true
                $holdStarted = Get-Date
                $probeCount = 0
                $why = if ($fileIdle -lt $IdleMinutes) { "会话文件活跃($($fileIdle.ToString('N1'))分钟前)" } elseif ($waiting -and $WaitKeepAwake) { "等待用户(已配置轮到用户也保活)" } else { "正在与模型通信(公网443)" }
                Write-Log "DSH 忙 -> 持锁 [$why]"
            } else {
                Write-Log "SetThreadExecutionState 失败, 错误码 $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
            }
        }
        elseif ($busy -and $holding) {
            # 每轮重申一次: S0 机型的执行状态请求可能被系统超时回收, 必须持续刷新
            [W32.Power]::SetThreadExecutionState($flags) | Out-Null

            # 自动升级: 允许息屏的情况下, 若持锁期间系统还是睡了, 说明这台机器
            # 关屏即待机(ES_SYSTEM_REQUIRED 挡不住), 此时补上 ES_DISPLAY_REQUIRED。
            if (-not $displayUpgraded -and -not $KeepDisplayOn -and -not $NoAutoDisplayOn) {
                $probeCount++
                if ($probeCount -ge $probeInterval) {
                    $probeCount = 0
                    if (Test-WentToSleep $holdStarted) {
                        $flags = $flags -bor $ES_DISPLAY_REQUIRED
                        [W32.Power]::SetThreadExecutionState($flags) | Out-Null
                        $displayUpgraded = $true
                        Write-Log "检测到持锁期间仍进了待机 -> 自动改为屏幕常亮, flags=0x$('{0:x}' -f $flags)（本机关屏即待机, 只申请系统唤醒挡不住）"
                    }
                }
            }
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
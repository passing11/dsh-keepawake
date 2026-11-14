# dsh-keepawake-watch.ps1 -- DSH 干活时自动阻止系统睡眠/休眠
#
# 唯一判定输入是宿主(index.js)每 10 秒重写的标记文件 <DSH_HOME>\dsh-keepawake-waiting.json:
#   1) 标记新鲜(未超过 -WaitingTtlSeconds)时, 完全采信其中的 busy / waiting 字段:
#      busy=true -> 持锁; busy=false -> 放锁。
#   2) 标记过期 / 缺失 / 读不出 / JSON 损坏 -> 直接判定"不忙"并立刻放锁, 不回退任何旧启发式。
#      由此: 插件没加载、宿主崩溃、宿主还没重启到新版本时, 保活会静默失效 —— 这是刻意的取舍,
#      因为下面的旧信号在本机恒真, 回退过去等于永不睡眠。
#
# 旧版的两个"忙"信号(会话落盘文件的 mtime、指向公网的 ESTABLISHED 连接)
# 已删除: 它们在本机常年为真, 导致"空闲满 -IdleMinutes 分钟自动释放"这条路永远走不到。
#
# 关于屏幕: 默认「允许息屏」——只申请 ES_SYSTEM_REQUIRED, 屏幕照常按电源计划关闭。
# 但 S0 现代待机机型上, 关屏本身就可能触发待机, ES_SYSTEM_REQUIRED 未必挡得住。
# 所以本脚本会自己看: 持锁期间若仍出现待机事件(Kernel-Power 506/42), 就自动升级为
# 「连屏幕一起保活」(加 ES_DISPLAY_REQUIRED), 并在日志里说明。用 -KeepDisplayOn 可跳过
# 试探、直接屏幕常亮; 用 -NoAutoDisplayOn 可关掉自动升级(宁可睡也不亮屏)。
param(
    # 历史参数, 已不影响放锁时机; 保留只为 keepawake-toggle.ps1 / 自启快捷方式的命令行兼容
    [double]$IdleMinutes = 5,
    # 直接申请屏幕常亮, 不做"允许息屏"的试探
    [switch]$KeepDisplayOn,
    # 关掉自动升级: 即使发现持锁期间仍进了待机, 也不去申请屏幕常亮
    [switch]$NoAutoDisplayOn,
    [string]$LogFile = "$env:TEMP\dsh-keepawake.log",
    # 历史参数, 只为命令行兼容(旧版用它找会话文件, 现已不看)
    [string]$SessionRoot = $(if ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'sessions' } else { "$env:USERPROFILE\.dsh\sessions" }),
    # 历史参数, 只为命令行兼容(旧版用它找网络连接, 现已不看)
    [string]$ProcessName = "DeepSeek Harness",
    # 轮到我说话(弹卡/审批/一轮结束等你打字)时也保持唤醒。默认不加 = 轮到我时立刻放锁
    [switch]$WaitKeepAwake,
    # 宿主写的「轮到用户」标记, 必须和 index.js waitingFile() 是同一个绝对路径
    # (index.js 用 DSH_HOME || ~/.dsh, 这里保持一致)
    [string]$WaitingFile = $(if ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'dsh-keepawake-waiting.json' } else { "$env:USERPROFILE\.dsh\dsh-keepawake-waiting.json" }),
    # 标记超过这么多秒没刷新就当它不存在(插件没在写 -> 不保活)
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

# 读宿主写的标记。返回 Fresh / Waiting / Busy / Age / Error。
# - busy 用严格布尔判定: 只有字段存在且值真的是 [bool] 才算(避免 {"busy":1} 被 PowerShell 判真)。
# - 缺 busy 字段(旧版插件)时 Busy=$false, 并把 Error 标成 no-busy-field 供日志区分。
# - version 只读不校验: 手写的标记也必须能生效。
# - 文件不存在 / 读失败 / 空白 / JSON 损坏 / 超过 TTL 一律 Fresh=$false。
function Get-WaitingState {
    $st = [pscustomobject]@{ Fresh = $false; Waiting = $false; Busy = $false; Age = -1.0; Error = $null }
    if (-not (Test-Path -LiteralPath $WaitingFile -PathType Leaf)) {
        $st.Error = 'missing'
        return $st
    }
    try {
        $item = Get-Item -LiteralPath $WaitingFile -ErrorAction Stop
        $st.Age = ((Get-Date) - $item.LastWriteTime).TotalSeconds
        if ($st.Age -gt $WaitingTtlSeconds) {
            $st.Error = "stale($([int]$st.Age)s)"
            return $st
        }
        $raw = Get-Content -LiteralPath $WaitingFile -Raw -Encoding UTF8 -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) {
            $st.Error = 'empty'
            return $st
        }
        $obj = $raw | ConvertFrom-Json -ErrorAction Stop
        $waitProp = $obj.PSObject.Properties['waiting']
        if ($null -ne $waitProp -and $waitProp.Value -is [bool]) { $st.Waiting = $waitProp.Value }
        $busyProp = $obj.PSObject.Properties['busy']
        if ($null -ne $busyProp -and $busyProp.Value -is [bool]) {
            $st.Busy = $busyProp.Value
        } elseif ($null -eq $busyProp) {
            $st.Error = 'no-busy-field'
        }
        $st.Fresh = $true
        return $st
    } catch {
        $st.Error = 'unreadable'
        return $st
    }
}

$holding = $false
$holdStarted = [datetime]::MinValue
$displayUpgraded = $false
$probeCount = 0
$probeInterval = 6   # 每 6 轮(约 60 秒)查一次事件日志, 别每 10 秒都查
$waitingLogged = $false   # 「轮到用户」只在刚进入等待时记一行, 不每 10 秒刷屏
$staleLogged = $false     # 「标记过期」只在刚进入非新鲜状态时记一行
$noBusyLogged = $false    # 「宿主没写 busy 字段」只记一次, 免得每 10 秒刷屏
$waitMode = if ($WaitKeepAwake) { '等待用户也保活' } else { '等待用户不保活' }
Write-Log "watchdog 启动, 标记文件 '$WaitingFile' (TTL $WaitingTtlSeconds 秒), $waitMode, flags=0x$('{0:x}' -f $flags)"

try {
    while ($true) {
        $w = Get-WaitingState

        # 1) 标记新鲜, 宿主说在等我回答, 且没开 -WaitKeepAwake: 立刻放锁, 不空转等待。
        #    只有原本真的持锁才记"放锁", 否则记一条中性行, 免得日志里出现从未持锁的"放锁"。
        if ($w.Fresh -and $w.Waiting -and -not $WaitKeepAwake) {
            $wasHolding = $holding
            if ($holding) {
                [W32.Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
                $holding = $false
                $displayUpgraded = $false
                $probeCount = 0
            }
            if (-not $waitingLogged) {
                if ($wasHolding) {
                    Write-Log "轮到用户 -> 立刻放锁, 恢复系统休眠计划"
                } else {
                    Write-Log "轮到用户 (本就没持锁)"
                }
                $waitingLogged = $true
            }
            $staleLogged = $false
            Start-Sleep -Seconds 10
            continue
        }
        $waitingLogged = $false

        # 2) 标记不新鲜: 插件没在写(没加载/崩了/宿主未重启) -> 判定不忙并立刻放锁, 不回退旧启发式。
        if (-not $w.Fresh) {
            $wasHolding = $holding
            if ($holding) {
                [W32.Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
                $holding = $false
                $displayUpgraded = $false
                $probeCount = 0
            }
            if (-not $staleLogged) {
                $why = if ($w.Error) { $w.Error } else { "未刷新超过 $WaitingTtlSeconds 秒" }
                if ($wasHolding) {
                    Write-Log "标记文件过期(或插件未加载) -> 放锁, 恢复系统休眠计划 [$why]"
                } else {
                    Write-Log "标记文件不可用 -> 判定不忙, 未持锁 [$why]"
                }
                $staleLogged = $true
            }
            Start-Sleep -Seconds 10
            continue
        }
        $staleLogged = $false

        # 3) 标记新鲜: 完全采信宿主的 busy。开着 -WaitKeepAwake 时 waiting 也继续持锁。
        if ($w.Error -eq 'no-busy-field') {
            if (-not $noBusyLogged) {
                Write-Log "标记里没有 busy 字段(旧版插件/宿主未重启) -> 不保活, 等待宿主重启"
                $noBusyLogged = $true
            }
        } else {
            $noBusyLogged = $false
        }
        $busy = $w.Busy -or ($w.Waiting -and $WaitKeepAwake)

        if ($busy -and -not $holding) {
            $r = [W32.Power]::SetThreadExecutionState($flags)
            if ($r -ne 0) {
                $holding = $true
                $holdStarted = Get-Date
                $probeCount = 0
                $why = if ($w.Waiting -and $WaitKeepAwake) { "等待用户(已配置轮到用户也保活)" } else { "宿主 busy=true" }
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
            # 宿主说空闲就立刻放锁: 不再等 -IdleMinutes(那个等待在本机永远走不到)
            [W32.Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
            $holding = $false
            $displayUpgraded = $false
            $probeCount = 0
            Write-Log "宿主报告空闲 -> 放锁, 恢复系统休眠计划"
        }

        Start-Sleep -Seconds 10
    }
}
finally {
    [W32.Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
    Write-Log "watchdog 退出, 锁已释放"
}

# keepawake-status.ps1 -- 查/停 DSH 保活看门狗
# 用法:
#   ... keepawake-status.ps1            查状态
#   ... keepawake-status.ps1 -Stop      停掉看门狗(锁随之释放)

param([switch]$Stop)

$log = "$env:TEMP\dsh-keepawake.log"

$procs = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '-File\s+"?[^"\s]*dsh-keepawake-watch\.ps1' })

if ($Stop) {
    if ($procs.Count -eq 0) { "看门狗没在跑"; return }
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    "已停止 $($procs.Count) 个看门狗进程, 锁已释放"
    return
}

if ($procs.Count -eq 0) {
    "看门狗: ✗ 没在跑"
} else {
    "看门狗: ✓ 在跑  PID = $($procs.ProcessId -join ', ')"
}

$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'DSH-keepawake.lnk'
if (Test-Path $lnk) { "登录自启: ✓ 已安装 ($lnk)" } else { "登录自启: ✗ 未安装" }

"日志: $log"
if (Test-Path $log) {
    "--- 最近 10 行 ---"
    Get-Content $log -Tail 10
} else {
    "(还没有日志)"
}
"--- 当前持有锁的进程 (需管理员) ---"
try { powercfg /requests } catch { "查不到 (powercfg /requests 需要管理员权限)" }
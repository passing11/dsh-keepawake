# install-keepawake-autostart.ps1 -- 把 DSH 保活看门狗装成"登录自动运行"
# 做法: 在 用户启动文件夹 里放一个 .lnk, 指向 powershell 跑 dsh-keepawake-watch.ps1
# 不需要管理员权限。卸载: 删掉那个 .lnk (或跑 -Uninstall)

param(
    [double]$IdleMinutes = 5,
    [switch]$KeepDisplayOn,
    [switch]$Uninstall
)

$ps1 = Join-Path $PSScriptRoot 'dsh-keepawake-watch.ps1'
if (-not (Test-Path $ps1)) { throw "找不到 $ps1, 请把两个脚本放在同一个目录" }

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'DSH-keepawake.lnk'

if ($Uninstall) {
    if (Test-Path $lnkPath) { Remove-Item $lnkPath -Force; "已卸载: $lnkPath" } else { "没有安装过" }
    return
}

$psArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ps1`" -IdleMinutes $IdleMinutes"
if ($KeepDisplayOn) { $psArgs += " -KeepDisplayOn" }

$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut($lnkPath)
$lnk.TargetPath       = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$lnk.Arguments        = $psArgs
$lnk.WorkingDirectory = $PSScriptRoot
$lnk.WindowStyle      = 7          # 7 = 最小化启动
$lnk.Description      = 'DSH 干活时阻止 Windows 自动睡眠/休眠'
$lnk.Save()

"已安装登录自启: $lnkPath"
"  目标: $($lnk.TargetPath)"
"  参数: $($lnk.Arguments)"
"生效方式: 下次登录自动启动; 想现在就跑, 双击那个快捷方式即可。"
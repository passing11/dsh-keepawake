# dsh-keepawake

DSH 保活开关 —— 在会话右侧放一个开关，开启期间 DSH 思考、调工具、跟模型对话时电脑不会睡眠/休眠。

Windows 专用。核心是一个 PowerShell 看门狗，用 `SetThreadExecutionState` 向内核申请执行状态锁；插件只是给它加了一个能点开、能点关的界面。

## 为什么需要它

DSH 一次思考可能几分钟到十几分钟。Windows 的空闲计时器不知道你在等模型，到点就关屏、睡眠、甚至休眠，回来发现对话卡在半路。

普通的「演示模式」在这类机器上往往不可用（`PresentationSettings.exe` 不一定存在），所以这里直接调 Win32 API。

## 一个必须知道的坑：现代待机（S0）

很多新机器（尤其笔记本）只有 **S0 低电量待机**，没有 S3：

```
> powercfg /a
待机 (S0 低电量待机) 连接的网络
休眠
快速启动
```

S1/S2/S3 显示「系统固件不支持」。

**在 S0 机器上，只申请 `ES_SYSTEM_REQUIRED` 未必挡得住。** S0 的进入条件可能由**屏幕关闭**触发，而不是独立的空闲计时器。实测：持锁 `0x80000001` 的进程还在跑，系统照样在关屏超时后进了 Modern Standby（事件日志 `Kernel-Power Id=506`，`Reason: Idle Timeout`）。

但「关屏就一定进待机」并不普遍——取决于机型和固件。所以本插件**默认允许息屏**，然后自己验证：

```powershell
$flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED
if ($KeepDisplayOn) { $flags = $flags -bor $ES_DISPLAY_REQUIRED }
# 默认 -> 0x80000001（屏幕照常关）
# 加 -KeepDisplayOn -> 0x80000003（屏幕常亮）
```

持锁期间每 60 秒查一次事件日志。如果发现这段持锁时间里出现过 `Kernel-Power Id=506`（进入 S0）或 `Id=42`（进入睡眠），说明这台机器**关屏即待机**、光靠系统唤醒请求挡不住，于是自动补上 `ES_DISPLAY_REQUIRED` 并写进日志：

```
检测到持锁期间仍进了待机 -> 自动改为屏幕常亮, flags=0x80000003（本机关屏即待机, 只申请系统唤醒挡不住）
```

这样在「关屏不影响待机」的机器上屏幕能正常省电，在「关屏即待机」的机器上自动兜底。

| 场景 | 用法 |
|:--|:--|
| 想省电，接受自动兜底 | 默认，什么都不用加 |
| 明确要屏幕常亮，不做试探 | `-KeepDisplayOn` |
| 宁可系统睡，也不要亮屏 | `-NoAutoDisplayOn` |

## 工作方式

看门狗每 10 秒判断两个信号，任一成立就持锁：

1. **会话文件活跃** —— DSH 的 `session.v4.jsonl.*` 在最近 `IdleMinutes` 分钟内被写过
2. **模型连接活跃** —— 名为 `DeepSeek Harness` 的进程有指向公网 443 的 ESTABLISHED 连接

两个信号都消失后再空转 `IdleMinutes` 分钟才释放。这样工具调用的间隙不会误放锁。

```
① 双击快捷方式
② 查看门狗在不在跑
③ 起后台进程
④ 每 10 秒主循环
⑤ 两个信号取或
⑥ 忙则上锁
⑦ Windows 内核：这期间不许睡
⑧ 闲满 5 分钟放锁
⑨ 回原电源计划
```

流程图见 [`docs/keepawake-diagram.png`](docs/keepawake-diagram.png)（源文件 `docs/keepawake-diagram.html`）。

## 安装

### 1. 放脚本

把 `scripts/` 里的三个脚本放到一个目录，它们互相按文件名查找，必须在同一目录：

```
keepawake-toggle.ps1         总开关
dsh-keepawake-watch.ps1      看门狗（真正持锁的进程）
keepawake-status.ps1         只查状态
```

插件按以下顺序找 `keepawake-toggle.ps1`，第一个存在的就用：

1. 插件配置里的 `scriptPath`
2. 环境变量 `DSH_KEEPAWAKE_SCRIPT`
3. 当前工作区根目录
4. `process.cwd()`
5. `~/Documents/deepseek-harness/default-workspace`
6. `~/.dsh`

### 2. 装插件

```bash
dsh plugin --profile <你的 profile> add dsh-keepawake
```

或者手动把本仓库 link 进 profile 的 `dependencies` 和 `dsh.profile.bundles`。

### 3. 打开

在右侧栏的 tab 条上找「保活」。

## 命令行用法

不用界面也能操作：

```powershell
# 切换（弹窗告诉你结果）
.\keepawake-toggle.ps1

# 明确开启 / 关闭
.\keepawake-toggle.ps1 -Action On
.\keepawake-toggle.ps1 -Action Off

# 只看状态
.\keepawake-toggle.ps1 -Action Status

# 不弹窗，只打印
.\keepawake-toggle.ps1 -Quiet

# 自定义空闲阈值（分钟，支持小数）
.\keepawake-toggle.ps1 -IdleMinutes 3

# 直接屏幕常亮（跳过"允许息屏"的试探）
.\keepawake-toggle.ps1 -KeepDisplayOn

# 宁可系统睡，也不要自动亮屏
.\keepawake-toggle.ps1 -NoAutoDisplayOn
```

看门狗日志：`%TEMP%\dsh-keepawake.log`

## 开机自启

**默认不做。** 需要的话用 `scripts/install-keepawake-autostart.ps1`，它会在用户启动文件夹放一个快捷方式。

注意 DSH 本身重启不会带上保活 —— 看门狗是独立进程，DSH 退出时它还在；但如果 DSH 是被一起杀掉的（比如整棵树 TerminateProcess），看门狗也会跟着没，需要重新开一次。

## 验证锁是否生效

`powercfg /requests` 需要管理员权限：

```powershell
Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-Command',"powercfg /requests | Out-File '$env:TEMP\req.txt' -Encoding utf8"
```

持锁成功时，`SYSTEM:` 段下会出现你的 powershell.exe 进程路径。

反过来，判断有没有偷偷进过待机，看事件日志：

```powershell
Get-WinEvent -FilterHashtable @{LogName='System'; Id=42,506,107} | Select-Object -First 10 TimeCreated,Id
```

- `506` = 进入 Modern Standby
- `42` = 进入睡眠
- `107` = 从睡眠恢复

## 已知限制

- **只支持 Windows。** 其他平台插件会显示「保活开关只在 Windows 上可用」。
- **DSH 重启会断。** 看门狗是独立进程，DSH 被整棵杀掉时它一起没。
- **关屏即待机的机器上屏幕会保持常亮。** 默认允许息屏，但若检测到持锁期间仍进了待机，会自动升级为屏幕常亮（见上文 S0 一节）。不想亮屏用 `-NoAutoDisplayOn`，代价是那台机器上保活可能失效。
- **不跨用户会话。** 锁是线程级的，用户注销就没了。

## 文件

```
index.js                        host 半：/dsh-keepawake/api 路由
client.js                       client 半：右侧栏 tab
cordis.patch.yml                bundle 挂载声明
locale/{zh,en}.json             语言包
icon.svg                        图标
scripts/keepawake-toggle.ps1    总开关
scripts/dsh-keepawake-watch.ps1 看门狗
scripts/keepawake-status.ps1    状态查询
scripts/install-keepawake-autostart.ps1  开机自启（可选）
docs/keepawake-diagram.*        流程图
```

## License

MIT
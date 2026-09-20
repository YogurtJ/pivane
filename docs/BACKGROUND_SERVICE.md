# 后台常驻与桌面入口

正式安装默认使用后台常驻。`npm start` 仍可用于试用和排障，但需要保持终端运行。3001 是固定监听端口，不会自动到期；常驻解决的是关闭终端、注销和重启后的进程生命周期。睡眠、关机和断网仍会使工作台不可达。

## 安装

先完成对应平台的依赖安装与 `.env` 配置，使用绝对的数据路径和固定 PORT。已有服务保持原配置，不要重复安装。在最初安装目录执行：

```sh
node scripts/install-service.cjs
```

macOS 和 Windows 默认在当前用户桌面创建带实例标识的 Pivane 网页快捷入口；桌面被重定向到 OneDrive 时，Windows 使用系统 Desktop 路径。入口只打开 `http://127.0.0.1:<PORT>`，不创建第二个服务。只监听远端接口的部署需自行使用实际可达 URL；自动健康检查要求本机回环地址可达。跳过桌面入口可加 `--no-shortcut`。

安装器不需要保存用户密码，不自动申请管理员权限，不修改防火墙或对公网开放端口。不能以 root 运行。它固定当前 Node 的绝对路径、PATH 和工作目录；原生 Pi 身份仍由实例 `.env` 或用户默认目录决定。不要移动/删除所引用的 Node 或安装目录。环境变量凭据、代理和外部认证命令须为实例单独配置，安装器不会把全部终端环境或秘密写入服务模板。

端口被占用、服务文件/计划任务已存在或安装目录已有安装记录时，拒绝覆盖。失败后保留现场，不自动重复注册。普通安装不自动安装可选系统组件；缺少 systemd 用户管理器等前提时由安装 Agent 按平台处理。

## 启动时机与管理

安装记录在原目录 `.pivane-runtime/service/installation.json`，包含实际服务名、路径和只读健康检查状态。以下 `<id>`、`<label>` 和 `<plist>` 用记录中的值替换。停止、卸载之前先保存草稿、结束任务并暂停预约；不能从正在承载当前 Agent 的服务内停止自身。

### Linux

生成 `~/.config/systemd/user/pivane-<实例标识>.service`，使用 `systemctl --user enable --now`。用户登录后启动；要让服务器开机启动且注销后继续运行，由管理员执行 `loginctl enable-linger <实际用户名>`。安装器不自动更改此系统策略。没有用户 systemd 的环境应配置等价的普通用户系统服务或使用容器管理器，不能把临时后台 shell 当作常驻交付。

```sh
systemctl --user status <id>.service
journalctl --user -u <id>.service
systemctl --user stop <id>.service
systemctl --user start <id>.service
```

异常退出后间隔 10 秒重试，5 分钟内最多 3 次。正常停机等待 launcher 清理，不以短超时强杀 worker。卸载时 `systemctl --user disable --now <id>.service`，确认退出后只移除记录中的 unit 文件，再 `systemctl --user daemon-reload`。不要删除数据、备份或其他服务。

### macOS

生成当前用户 `~/Library/LaunchAgents/` 下的 plist，并以 `launchctl bootstrap gui/<uid> <plist>` 加载。登录后启动，异常退出按 launchd 节流重试；普通用户会话注销后停止。日志位于安装记录指定的 `service.log`，需按使用量定期归档，安装器不自动删除旧日志。

使用 `launchctl print gui/<uid>/<label>` 查看，`launchctl bootout gui/<uid> <plist>` 停止，重新 `bootstrap` 启动。卸载前停止并确认退出，再移除记录中的 plist 和桌面 `.webloc`。不配置系统级 LaunchDaemon，不改变 macOS 隐私权限。

### Windows

注册当前用户的登录计划任务，使用 InteractiveToken 和最低权限，不保存账户密码；安装完成后立即启动。计划任务不设执行时长上限，允许电池供电运行，异常退出最多重试 3 次。用户注销后不能保证继续运行，这不是开机前运行的 Windows 系统服务。

在“任务计划程序”中按记录的 `<id>` 查询，或使用 PowerShell `Get-ScheduledTaskInfo -TaskName '<id>'`。任务计划程序历史/LastTaskResult 用于诊断启动；需要详细应用输出时，安全停机后在原目录前台运行 `npm.cmd start`。此安装方式不提供 stdout 文件收集。

停机前结束工作并暂停预约，从独立 PowerShell 禁用任务，避免重新登录时触发，然后向原安装目录的 runner 提交正常退出请求：

```powershell
Disable-ScheduledTask -TaskName '<id>'
New-Item -ItemType File -Path '.pivane-runtime\service\stop-request'
```

runner 会调用统一异步停机流程，等待 launcher 和 worker 退出后移除请求文件；必须继续确认任务已退出、端口关闭，才能备份。不要把“结束任务”或 `taskkill /F` 当作正常停机。重新启用使用 `Enable-ScheduledTask`，立即启动使用 `Start-ScheduledTask`；遗留的 stop-request 会阻止启动，应核对前次停机后再移除。卸载使用 `Unregister-ScheduledTask -TaskName '<id>' -Confirm:$false`，这不保证已运行进程退出；仍须单独核对。仅移除对应桌面 `.url`，不删除用户数据。

## 交付检查与验证范围

安装器轮询 `/api/access/status`，最多约 2 分钟；这仅证明 HTTP 访问入口就绪。安装 Agent 还应核对服务归属、认证后的 `/api/pi/status`、实际 Pi 身份、模型目录和日志，验证关闭安装终端后可访问，记录重新登录/重启是否实际测试。桌面入口打开的是本机浏览器，跨设备访问另按访问控制文档配置。

模板、路径转义及发布包含关系可在 Linux 测试；macOS launchd、Windows 计划任务与桌面行为必须在目标系统实际检查。旧版跨平台安装验收不代表本次常驻安装器已通过原生平台验收。已有实例不因文档变化自动改装服务。

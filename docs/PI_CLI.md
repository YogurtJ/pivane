# 将已有 Pi CLI 接入 Pivane

Pivane 使用 Pi 原生身份目录读取供应商、认证、模型、设置与会话。普通安装沿用当前用户的 Pi 目录；目录尚不存在时，由 Pi 正常启动初始化。无需全局安装 Pi，也无需导入或复制 `auth.json`。

## 各平台的目录规则

| Pi CLI 运行环境 | 未设置覆盖变量时的常见路径 |
|---|---|
| macOS | `/Users/<用户>/.pi/agent` |
| Linux | `/home/<用户>/.pi/agent`，实际以系统用户主目录为准 |
| Windows 原生 Node / PowerShell / cmd | `C:\Users\<用户>\.pi\agent`，实际以 Node 的用户主目录为准 |
| WSL 内的 Linux Pi | WSL 用户主目录下的 `.pi/agent`，不是 Windows 原生身份 |

这些是常见路径，不应硬编码用户名或盘符。Pi 使用 Node `os.homedir()`，再追加 `.pi/agent`，并优先采用非空 `PI_CODING_AGENT_DIR`。Windows 默认不是 AppData；Windows 下的 `$HOME`、Git Bash 的 `~` 与原生 Node 的主目录也不一定相同。

先核对平时启动 Pi 的终端、系统用户及 `PI_CODING_AGENT_DIR` 覆盖。若 Pi 由 shell alias、脚本、服务或其他环境启动，必须以那个入口的实际值为准，不能把安装 Agent 自身继承的身份当成用户的 Pi 身份。WSL 和 Windows 原生路径不要直接互换，跨系统复用不是本指南的默认操作。

## 新安装：直接采用 Pi 的原生目录

在发布目录完成 `npm ci` 后，从与 Pi CLI 相同的用户和配置环境运行：

```sh
node scripts/pi-agent-dir.cjs
```

此命令通过 Pi 公开的 `getAgentDir()` 取得路径，规范化已有目录，仅输出目录名；不读取或打印认证正文、不创建目录、不启动会话，也不发模型请求。无覆盖变量时采用平台默认目录。有覆盖变量但路径错误时处理错误，不自动换成另一套身份。已有目录是否有可用模型仍需启动后核对。

[macOS](MACOS.md)、[Linux](INSTALL_RECOVERY.md)和[Windows](WINDOWS.md)安装示例会捕获这个结果，写入实例的 `PI_CODING_AGENT_DIR`。配置文件保存真实绝对路径，避免服务管理器没有加载 shell 初始化而选错身份。`.env` 不展开 `~`、`$HOME`、`%USERPROFILE%` 或 PowerShell 变量。

只在用户明确要求独立身份或进行隔离验收时，改用实例专用目录。例如 POSIX 设置 `AGENT_DIR="$BASE/data/agent"`，PowerShell 设置 `$agentDir = Join-Path $base 'data\agent'`，再生成配置。保留已有目录，不复制其他身份的认证文件。

## 已经安装成空身份：切换到原 Pi 目录

1. 在原 Pi CLI 的用户和启动环境中确定实际身份路径。不要因发现了另一个目录就删除 Pivane 当前目录。
2. 保存网页草稿、暂停预约、等待当前任务完成；通过原启动终端或独立管理通道停止 Pivane。若开发会话由该 Pivane 承载，不从其内部停止自身。
3. 备份原 Pi 目录和 Pivane 当前身份目录。将实际 `.env` / 服务环境中的 `PI_CODING_AGENT_DIR` 改为原 Pi 目录；如保存了 `instance.env`，同步该配置源。非空进程环境优先于 `.env`。媒体目录及预约文件继续沿用此实例的原值。
4. 按原方式启动。设置 → Pi 配置的只读接口 `GET /api/pi/settings/native` 返回 `agentDir`，可以核对实际使用位置；有访问验证时先认证。再在“供应商与模型”检查已配置供应商、可用模型及默认模型，不自动点击收费测试。

切换是共用原生身份，不会合并两套会话或把新身份中的配置覆盖到旧身份。原生认证、默认模型、全局设置、Packages、Skills 和标准会话目录会随身份共用；更改它们也可能影响 CLI。项目设置仍按项目与信任规则读取。不要让 CLI 和网页同时写同一个会话。Pivane 继续使用包内 Pi 版本，不会因此改成调用全局安装的 Pi 可执行文件。

CLI 通过 `--session-dir` 或 `PI_CODING_AGENT_SESSION_DIR` 存在别处的历史，不保证仅改身份路径就出现在网页中；模型接入不等于自定义会话目录迁移。不要改写 JSONL 来合并历史。

## 同一身份仍然没有模型

- **只在终端环境里设置了 Key**：`env -i`、LaunchAgent、systemd、不同 PowerShell 窗口可能没有这些变量。给 Pivane 的启动环境提供该供应商实际需要的变量，或在网页通过原生登录保存认证。不要把 Key 粘贴到聊天、日志或命令示例里。
- **认证或模型配置引用环境变量/外部命令**：相关变量、PATH、代理和命令依赖也必须在 Pivane 启动环境可用；共用目录不会自动复制 shell 环境。只核对变量名和是否存在，不输出值。
- **供应商仅由扩展注册**：网页供应商管理不加载任意 CLI 扩展注册的 Provider；标准兼容服务使用 Pi 原生自定义模型配置。详见[供应商接入](PROVIDER_SETTINGS.md)。
- **认证失效或模型被筛选**：检查认证状态、“仅可用”等筛选以及默认模型；已有会话保留自己的模型。空闲时使用模型目录刷新，不能把所有 401 或网络错误都当成目录错误。

## 备份和恢复共享身份

平台安装示例将 Pivane 媒体配置、媒体文件与预约文件保留在实例的 `data` 下，Pi 身份通常在实例目录之外。只备份 `$BASE/data` 不会包含 `~/.pi/agent`；[通用备份](INSTALL_RECOVERY.md#4-备份范围与一致性)中的 BASE 归档必须再配套保存实际 Pi 身份。

备份共享身份前同时停止使用它的 Pivane 与 Pi CLI。将完整实际 Pi 目录另存为私有备份，包含原生认证、模型、设置、会话和 Pivane 写入其中的工作台偏好。恢复时将它还原到记录的原绝对路径，保持与同一时点的媒体、预约、项目和启动配置配套。Windows 保留实际 DACL，POSIX 保留权限；外置链接、命令依赖、项目目录和自定义会话目录另行登记。

不把共享 Pi 目录整体迁入 Pivane 安装目录，不以复制认证文件制造需要同步的第二套登录状态。

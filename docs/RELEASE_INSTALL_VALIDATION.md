# Pivane 平台验证范围

此页描述已完成的平台验证；不表示每个新候选包已经重复完成全部实机测试。准确的包版本、SHA256和补验结果应随该次发布说明提供。

## 当前 RC3

[1.0.0-rc.3](releases/1.0.0-rc.3.md) 锁定 Pi 0.85.1。本包在 Linux ARM64、Node 22.23.2 上执行隔离安装、RC2 升级、原路径恢复与 Chromium 验收；具体结果和归档 SHA256 以 Release 附件 validation.json 为准。macOS、Windows 和 Linux x86_64 未使用此包重跑，以下历史基线不代表 RC3 全平台验收。

## 已验证基线

2026-09-11原生适配基线使用包内Pi 0.85.0，已完成以下验证：

| 平台 | 实际范围 | 结果 |
|---|---|---|
| Linux | Debian ARM64、Ubuntu24.04 x86_64；Node22.x，系统rg和/proc | 干净安装、聊天、文件/搜索/用量、更新恢复；最终Linux回归161项通过 |
| macOS | Apple Silicon M2、macOS26.5.1、Node22.23.2、原生Chrome | 161项Node；原生文件/搜索/用量、同worker别名、更新与17文件同路径恢复 |
| Windows | Windows11 x64 build26200、NTFS、Node22.23.2、Git Bash/rg、原生Chrome | 161项Node；未提权用户核心24项、更新与16文件同路径恢复 |

Node全量无跳过。恢复文件逐项哈希比较；浏览器覆盖桌面与手机宽度、pageerror和实际子项宽度。测试使用独立身份和合成服务，不继承维护者的私人配置。使用者反馈的真实聊天可用性不代表所有供应商已测试。

上述三端全量之后的Windows文件链接展示小调整已通过专项浏览器与恢复后运行检查。1.0.0-rc.1发行改动包括品牌、文档、许可及构建/验收入口；当前包结果由同名validation.json提供，须核对artifactSha256，不能只复用旧包结论。可复跑的隔离入口见[发布流程](development/RELEASING.md)。

## 尚未验收

- Intel Mac硬件、其他macOS版本、Safari/Finder系统剪贴板和真实手机后台推送。
- Windows10/Server/ARM64、ReFS/exFAT、网络共享及映射盘。
- 所有真实供应商账户、付费媒体生成、用户自有GPU环境。
- 完整原生会话树跨路径迁移。当前支持原路径恢复，或当前分支JSONL导入为新线程。

macOS Intel切片编译不代表Intel真机通过；Windows不以WSL代替原生验收。浏览器手机宽度仿真不等同于手机操作系统验证。

安装前提和使用步骤见[安装与恢复](INSTALL_RECOVERY.md)、[macOS](MACOS.md)、[Windows](WINDOWS.md)。源码发布流程见[RELEASING.md](development/RELEASING.md)。

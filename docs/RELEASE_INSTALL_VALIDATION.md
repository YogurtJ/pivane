# Pivane 平台验证范围

此页描述已完成的平台验证；不表示每个新候选包已经重复完成全部实机测试。准确的包版本、SHA256和补验结果应随该次发布说明提供。RC4 的中间候选验收失败记录不作为最终发布结论，只有绑定最终归档 SHA256 的 validation.json 才代表 RC4。

## 当前正式版 1.1.0

[1.1.0](releases/1.1.0.md) 锁定 Pi 0.87.1。精确归档通过 Linux ARM64 / Node 22.23.2 的 292 项 Node 测试、12 组 Chromium 浏览器专项、独立安装、从 1.0.0 升级及 17 个文件逐项哈希一致的原路径恢复，生产依赖 audit 为 0 漏洞。结果随 Release 的 `pivane-1.1.0.validation.json` 提供，并绑定归档 SHA256。测试采用隔离身份与合成供应商。

macOS、Windows、Linux x86_64 保留历史基线，本包未新增这些平台的实机验收；Chromium 手机宽度仿真不代表 Safari、真实手机后台通知或所有真实供应商已验收。

## 历史正式版 1.0.0

[1.0.0](releases/1.0.0.md) 锁定 Pi 0.86.1。最终包的安装、RC4 升级、恢复和浏览器检查结果随 Release 的 `pivane-1.0.0.validation.json` 提供，并绑定精确归档 SHA256。本次验收平台为 Linux ARM64、Node 22.x；macOS、Windows 与 Linux x86_64 保留历史基线，不宣称本包已重跑这些实机验收。新后台安装器的 macOS/Windows 系统服务与桌面入口仍需实机验收。

## 历史 RC4

[1.0.0-rc.4](releases/1.0.0-rc.4.md) 锁定 Pi 0.86.1。发布验收以该版本的精确归档 SHA256 和 validation.json 为准；Linux ARM64、Node 22.23.2 的隔离安装与浏览器/原生恢复结果不得沿用 RC3 的历史结论。macOS、Windows 和 Linux x86_64 若未在 RC4 包重跑，仍只标为历史基线。

## 已验证基线

2026-09-11原生适配基线使用包内Pi 0.85.0，已完成以下验证：

| 平台 | 实际范围 | 结果 |
|---|---|---|
| Linux | Debian ARM64、Ubuntu24.04 x86_64；Node22.x，系统rg和/proc | 干净安装、聊天、文件/搜索/用量、更新恢复；最终Linux回归161项通过 |
| macOS | Apple Silicon M2、macOS26.5.1、Node22.23.2、原生Chrome | 161项Node；原生文件/搜索/用量、同worker别名、更新与17文件同路径恢复 |
| Windows | Windows11 x64 build26200、NTFS、Node22.23.2、Git Bash/rg、原生Chrome | 161项Node；未提权用户核心24项、更新与16文件同路径恢复 |

Node全量无跳过。恢复文件逐项哈希比较；浏览器覆盖桌面与手机宽度、pageerror和实际子项宽度。测试使用独立身份和合成服务，不继承维护者的私人配置。使用者反馈的真实聊天可用性不代表所有供应商已测试。

上述三端全量之后的Windows文件链接展示小调整已通过专项浏览器与恢复后运行检查。RC4 的 Pi 0.86.1 协议兼容、会话 system transcript 导入导出和完整隔离验收必须绑定 RC4 的 artifactSha256，不能复用 RC3 或 RC1 结论。可复跑的隔离入口见[发布流程](development/RELEASING.md)。

## 尚未验收

- Intel Mac硬件、其他macOS版本、Safari/Finder系统剪贴板和真实手机后台推送。
- Windows10/Server/ARM64、ReFS/exFAT、网络共享及映射盘。
- 所有真实供应商账户、付费媒体生成、用户自有GPU环境。
- 完整原生会话树跨路径迁移。当前支持原路径恢复，或当前分支JSONL导入为新线程。

macOS Intel切片编译不代表Intel真机通过；Windows不以WSL代替原生验收。浏览器手机宽度仿真不等同于手机操作系统验证。

安装前提和使用步骤见[安装与恢复](INSTALL_RECOVERY.md)、[macOS](MACOS.md)、[Windows](WINDOWS.md)。源码发布流程见[RELEASING.md](development/RELEASING.md)。

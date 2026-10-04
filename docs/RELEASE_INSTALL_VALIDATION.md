# Pivane 平台验证范围

此页描述已完成的平台验证；不表示每个新候选包已经重复完成全部实机测试。准确的包版本、SHA256和补验结果应随该次发布说明提供。RC4 的中间候选验收失败记录不作为最终发布结论，只有绑定最终归档 SHA256 的 validation.json 才代表 RC4。

## 1.6.1 发布候选

[1.6.1](releases/1.6.1.md) 锁定 Pi 1.0.2。准确正式归档将在 Linux ARM64 / Node 22.x 使用独立身份补验安装、正式 1.6.0 升级与原路径恢复，结果随 `pivane-1.6.1.validation.json` 提供。源码和本机运行候选的通过记录不能替代正式包验收；本次不新增 Windows、macOS 或其他架构的实机结论。

## 当前正式版 1.6.0

[1.6.0](releases/1.6.0.md) 锁定 Pi 1.0.0，准确归档 SHA256 `d70c0b6f4d309b1454b660aa66461b7eb5675e48f5023dba47c4d32e7c220e51`。Linux ARM64 与原生 Windows 11 x64 / Node 22.23.2 各 606 项 Node 测试、13 个 Chromium 专项全部通过，0 失败／跳过。安装、语法、72 文档、生产 audit 0 漏洞、运行与原路径恢复通过；Windows 普通权限单独验收通过，完整测试因符号链接 fixture 使用提升权限。Linux 验证从正式 1.5.0 升级，Windows 仅验证干净安装及同版更新恢复。2046 文件逐项校验，未调用真实付费模型。手机宽度模拟不代表真实手机、Safari 或真实 ASR；macOS 与其他架构未新增验收。详情见 `pivane-1.6.0.validation.json`。

## 历史正式版 1.5.0

[1.5.0](releases/1.5.0.md) 锁定 Pi 1.0.0、内置 pi-subagents 0.74.0 和 memory 0.9.9，保留 DOMPurify 3.4.16。Linux ARM64 / Node 22.23.2 的准确归档（SHA256 `004cc1391cacc7690915189db7e41c30f4b10bd1d23954ed6b3c6baedc8c789e`）通过 589 项 Node 测试、480 文件语法、71 文档检查、独立安装、从正式 1.4.0 升级及 18 文件逐项哈希一致的原路径恢复，生产 audit 为 0 漏洞；28 组隔离 Chromium 专项通过。2036 文件逐项校验，测试后 manifest 未变。精确范围随 `pivane-1.5.0.validation.json` 提供，7 次合成模型请求、0 付费请求。未重跑 macOS、Windows 或其他架构实机验收；手机宽度／合成麦克风不代表真实手机、Safari、真实 ASR 或供应商速度渠道。普通升级不移动真实线程，不重复已完成的原生 MCP 迁移。

## 历史正式版 1.4.0

[1.4.0](releases/1.4.0.md) 锁定 Pi 0.99.1 和 DOMPurify 3.4.16。Linux ARM64 / Node 22.23.2 的准确归档（SHA256 `150440e5c6d697eafe5687f0b563313e8943f1ad9db6b166307d5558e738a537`）通过 530 项 Node 测试、457 文件语法、70 文档检查、独立安装、从正式 1.3.0 升级及 18 文件逐项哈希一致的原路径恢复，生产 audit 为 0 漏洞；19 组 Chromium 专项通过。1968 文件逐项校验，测试后 manifest 未变。精确范围随 `pivane-1.4.0.validation.json` 提供，没有付费请求。本包未重跑 macOS、Windows 或其他架构实机验收；手机宽度仿真不代表真实手机与 Safari 验收。旧 MCP 适配器配置需显式审查/停机迁移，安装不自动迁移。

## 历史正式版 1.3.0

[1.3.0](releases/1.3.0.md) 保持 Pi 0.87.1。Linux ARM64 / Node 22.23.2 上的最终归档（SHA256 `e3660e4d6e4bfc31478f8a9ba35e562815eb42460dc51826d7d6c97182533d16`）通过 486 项 Node 测试、独立安装、从 1.2.0 正式包升级、旧版 1.1.0 网页更新器安装及 17 个文件逐项哈希一致的原路径恢复，生产依赖 audit 为 0 漏洞；8 组变更相关 Chromium 桌面/手机专项通过。精确范围随 `pivane-1.3.0.validation.json` 提供。macOS、Windows 及其他平台保留历史基线，本包未重跑实机验收。

## 历史正式版 1.2.0

[1.2.0](releases/1.2.0.md) 锁定 Pi 0.87.1。Linux ARM64 / Node 22.23.2 完成 444 项 Node 测试和 19 组 Chromium 专项，无剩余失败；最终归档完成独立安装、从 1.1.0 升级、旧版网页更新器安装及 17 个文件逐项哈希一致的原路径恢复，生产依赖 audit 为 0 漏洞。完整 Node 测试在同一冻结源码执行，最终归档另做安装恢复和受影响浏览器复验；未变化场景按文件对比复用。精确范围随 `pivane-1.2.0.validation.json` 提供，绑定安装包 SHA256。

此前内置组件候选已在 Linux ARM64、M2 Mac 和 Windows 11 x64 验证统一安装、SQLite、更新探测及各 13 项专项；这不是最终1.2.0归档在所有平台的整包验收。最终包的其他平台、Safari、真实手机后台通知和真实模型/媒体供应商仍按历史范围与单独验收说明处理。

## 历史正式版 1.1.0

[1.1.0](releases/1.1.0.md) 锁定 Pi 0.87.1。精确归档通过 Linux ARM64 / Node 22.23.2 的 292 项 Node 测试、12 组 Chromium 浏览器专项、独立安装、从 1.0.0 升级及 17 个文件逐项哈希一致的原路径恢复，生产依赖 audit 为 0 漏洞。结果随 Release 的 `pivane-1.1.0.validation.json` 提供，并绑定归档 SHA256。测试采用隔离身份与合成供应商。

macOS、Windows、Linux x86_64 保留历史基线，本包未新增这些平台的实机验收；Chromium 手机宽度仿真不代表 Safari、真实手机后台通知或所有真实供应商已验收。

## 历史正式版 1.0.0

[1.0.0](releases/1.0.0.md) 锁定 Pi 0.86.1。最终包的安装、RC4 升级、恢复和浏览器检查结果随 Release 的 `pivane-1.0.0.validation.json` 提供，并绑定精确归档 SHA256。本次验收平台为 Linux ARM64、Node 22.x；macOS、Windows 与 Linux x86_64 保留历史基线，不宣称本包已重跑这些实机验收。新后台安装器的 macOS/Windows 系统服务与桌面入口仍需实机验收。

## 历史 RC4

[1.0.0-rc.4](https://github.com/YogurtJ/pivane/blob/v1.0.0-rc.4/docs/releases/1.0.0-rc.4.md) 锁定 Pi 0.86.1。发布验收以该版本的精确归档 SHA256 和 validation.json 为准；Linux ARM64、Node 22.23.2 的隔离安装与浏览器/原生恢复结果不得沿用 RC3 的历史结论。macOS、Windows 和 Linux x86_64 若未在 RC4 包重跑，仍只标为历史基线。

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

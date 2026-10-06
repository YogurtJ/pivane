# Pivane 平台验证范围

本页是版本验收索引。**结果只适用于对应归档**：准确 SHA256、测试明细和失败尝试见各 [Release](https://github.com/YogurtJ/pivane/releases) 的 `pivane-<版本>.validation.json`。源码、浏览器模拟和旧版结果不能替代新包的实机验收。

## 当前正式版 1.6.1

[1.6.1 说明](releases/1.6.1.md) · [验收附件](https://github.com/YogurtJ/pivane/releases/download/v1.6.1/pivane-1.6.1.validation.json)

Linux ARM64 / Node 22.23.2 完成准确归档的独立安装、635 项 Node 测试、语法／文档检查、生产依赖审计、从 1.6.0 升级和 19 文件原路径恢复。5 个相关 Chromium 专项及安装／升级／恢复／文件预览检查通过；18 个既有专项仅在生产文件与浏览器用例字节一致后复用。2,060 个包内文件逐项核对，7 次合成请求、0 付费请求。未新增其他平台实机验收。

## 历史正式版 1.6.0

[1.6.0 说明](releases/1.6.0.md) · [验收附件](https://github.com/YogurtJ/pivane/releases/download/v1.6.0/pivane-1.6.0.validation.json)

Linux ARM64 与原生 Windows 11 x64 / Node 22.23.2 完成安装、运行、恢复和浏览器检查。Linux 验证从正式 1.5.0 升级；Windows 验证干净安装及同版更新恢复，普通权限核心运行另行通过，完整测试因符号链接 fixture 使用提升权限。

## 历史正式版 1.5.0

[1.5.0 说明](releases/1.5.0.md)：Linux ARM64 / Node 22.23.2，准确归档安装、从 1.4.0 升级、原路径恢复及 Chromium 检查。

## 历史正式版 1.4.0

[1.4.0 说明](releases/1.4.0.md)：Linux ARM64 / Node 22.23.2，准确归档安装、从 1.3.0 升级、原路径恢复及 Chromium 检查；旧 MCP 迁移须显式执行。

## 历史正式版 1.3.0

[1.3.0 说明](releases/1.3.0.md)：Linux ARM64 / Node 22.23.2，准确归档安装、从 1.2.0 升级、旧版网页更新器安装、原路径恢复及 Chromium 检查。

## 历史正式版 1.2.0

[1.2.0 说明](releases/1.2.0.md)：Linux ARM64 / Node 22.23.2，安装、从 1.1.0 升级、旧版网页更新器安装及原路径恢复。全量 Node 在冻结源码执行，准确归档补验安装恢复与相关浏览器场景，其余按文件一致复用。此前内置组件的 Mac／Windows 候选检查不等同于本包整体验收。

## 历史正式版 1.1.0

[1.1.0 说明](releases/1.1.0.md)：Linux ARM64 / Node 22.23.2，准确归档安装、从 1.0.0 升级、原路径恢复及 Chromium 检查。

## 历史正式版 1.0.0

[1.0.0 说明](releases/1.0.0.md)：Linux ARM64 / Node 22.x，准确归档安装、RC4 升级、原路径恢复及浏览器检查。

## 历史 RC4

[RC4 说明](https://github.com/YogurtJ/pivane/blob/v1.0.0-rc.4/docs/releases/1.0.0-rc.4.md)：以最终归档的 validation 附件为准，中间候选失败和更早 RC 的通过结果不能互相替代。

## 已验证基线

2026-09-11 的 Pi 0.85.0 基线涵盖 Linux（ARM64、x86_64）、Apple Silicon M2 macOS 和 Windows 11 x64：安装、聊天、文件／搜索／用量、更新与原路径恢复。此记录只证明当时的实现，不能表示当前版本已在这些平台重新验收。

## 尚未验收

- 当前包未明确列出的原生系统和架构，包括 Intel Mac、Windows ARM64、网络文件系统。
- Safari、真实手机的软键盘、麦克风、后台通知及系统剪贴板行为；Chromium 手机宽度模拟不等同实机。
- 所有真实模型／媒体供应商、付费服务与用户自有 GPU 环境。
- 通用跨路径完整会话树迁移；现有恢复按原路径执行，分支导入另建线程。

安装步骤见[安装与恢复](INSTALL_RECOVERY.md)、[macOS](MACOS.md)、[Windows](WINDOWS.md)；维护者验收方法见[发布流程](development/RELEASING.md)。

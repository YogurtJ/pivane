# Pivane 文档

English: [project overview](../README.en.md) · [installation](en/INSTALL.md) · [user guide](en/USER_GUIDE.md)。详细功能和开发文档目前主要为中文。

## 从哪里开始

| 你是 | 先读 |
|---|---|
| 第一次使用的用户 | [用户指南](USER_GUIDE.md) |
| 要安装、升级或恢复实例的管理员 | [安装与恢复](INSTALL_RECOVERY.md)，再按平台读 [macOS](MACOS.md) / [Windows](WINDOWS.md) |
| 协助用户安装、配置或排障的 Agent | [用户 Agent 操作指南](AGENT_GUIDE.md) |
| 修改 Pivane 源码的开发者或 Agent | [开发文档](development/README.md) 与根目录 [AGENTS.md](../AGENTS.md) |

当前正式版为 **1.4.0**（Pi 0.99.1），见 [1.4.0 版本说明](releases/1.4.0.md)；下载包、校验文件和精确验收摘要以 [GitHub Releases](https://github.com/YogurtJ/pivane/releases) 为准。旧 MCP 适配器配置须显式审查与迁移；公开发布不表示运行实例已切换。当前源码为尚未公开发布的 1.5.0 候选（Pi 1.0.0），见[候选说明](releases/1.5.0.md)；完整变化见 [CHANGELOG](../CHANGELOG.md)。

下面按主题列出功能文档。每篇前半部分讲使用，后半部分可能包含接口字段和限额，供高级用户、集成者和用户 Agent 查询。模型能力来自实际配置与运行实例；文档中的示例不代表服务已经配置好。

## 安装、升级与运维

| 任务 | 文档 |
|---|---|
| 部署、升级、备份和恢复 | [安装与恢复](INSTALL_RECOVERY.md) · [macOS](MACOS.md) · [Windows](WINDOWS.md) |
| 后台常驻、登录启动与桌面入口 | [后台服务](BACKGROUND_SERVICE.md) |
| 给已有 Pi CLI 接入网页，共用模型与身份 | [已有 Pi 接入](PI_CLI.md) |
| 检查版本、交给独立 Agent 辅助更新 | [版本与更新](UPDATES.md) |
| 访问验证、通知、日常排障 | [访问控制](ACCESS_CONTROL.md) · [通知](NOTIFICATIONS.md) · [运维](OPERATIONS.md) |
| 界面语言、浏览器默认与生效方式 | [中英文界面](I18N.md) |

## 会话与日常工作

| 任务 | 文档 |
|---|---|
| 输入、命令模板、Shell | [命令与模板](COMPOSER_TOOLS.md) · [Shell](WEB_SHELL.md) |
| 停止、重试、运行与配置恢复 | [运行控制](NATIVE_CONTROLS.md) · [运行与配置恢复](NATIVE_COMPLETION.md) |
| 历史、分叉、导入导出 | [历史](HISTORY.md) · [工作流](SESSION_WORKFLOWS.md) · [导入导出](SESSION_TRANSFER.md) |
| 围绕当前任务的临时侧聊 | [侧聊](SIDE_CHAT.md) |
| 让 Agent 新开线程交办任务、线程间直接沟通 | [Agent 任务线程与线程间消息](AGENT_THREADS.md) |
| 周期执行、文字问候与身份主线程 | [定时任务](SCHEDULED_TASKS.md) |
| 文件浏览、交付物与正文渲染 | [文件查看](FILE_VIEWER.md) · [数学公式](MATH.md) · [Mermaid](MERMAID.md) |
| 用量与朗读 | [用量统计](USAGE.md) · [回复朗读](REPLY_TTS.md) |

## 模型、扩展与助手

| 任务 | 文档 |
|---|---|
| 供应商认证、聊天模型、Thinking | [供应商与模型](PROVIDER_SETTINGS.md) |
| Pi 原生设置、资源、Packages/Skills、系统提示词 | [Pi 原生设置](NATIVE_SETTINGS.md) |
| 按用途配置标题与媒体规划模型 | [辅助模型](AUXILIARY_MODELS.md) |
| Pi 原生 MCP、Codemode 和旧适配器迁移 | [原生 MCP](MCP.md) |
| 内置子 Agent、记忆组件与旧安装兼容 | [内置能力包](BUNDLED_CAPABILITIES.md) |
| 助手身份与档案记忆 | [助手档案](AGENT_PROFILES.md) · [记忆适配与安装](PROFILE_MEMORY.md) |

## 媒体

| 任务 | 文档 |
|---|---|
| 媒体服务与生成 | [实验室](MEDIA_LAB.md) · [接入协议](MEDIA_CONNECTIONS.md) · [媒体 Agent](MEDIA_AGENT.md) |
| 旧媒体适配器配置 | [Flux](FLUX2_DEV.md) · [MiniMax 视频](MINIMAX_H3.md) · [语音 registry](tts-providers/README.md) |

## 接口与版本

| 内容 | 文档 |
|---|---|
| REST/WebSocket 字段、错误与并发语义 | [API](API.md) |
| 版本变化 | [CHANGELOG](../CHANGELOG.md) · [1.3.0](releases/1.3.0.md) · [1.2.0](releases/1.2.0.md) · [1.1.0](releases/1.1.0.md) · [1.0.0](releases/1.0.0.md)；RC 版本说明保留在对应 Git 标签 |
| 各版本平台验收范围 | [平台验证范围](RELEASE_INSTALL_VALIDATION.md) |
| 产品方向 | [路线图](ROADMAP.md) |

## 文档维护

公开文档的明确清单为 [public-files.json](public-files.json)，新增或删除文档须同步登记；责任分工见 [开发流程](development/WORKFLOW.md#文档责任)。实例地址、部署状态和维护记录不属于公开文档，保存在维护者的私有资料中（本机 `AGENTS.local.md` 提供入口），被 Git 与发行规则排除，应用和公开文档不依赖它们。

# Pivane 文档

English: [project overview](../README.en.md) · [installation](en/INSTALL.md) · [user guide](en/USER_GUIDE.md)。详细功能和开发文档目前主要为中文。

第一次使用从[用户指南](USER_GUIDE.md)开始；需要安装或恢复实例，从[安装与恢复](INSTALL_RECOVERY.md)开始。让自己的Agent协助时，把[用户Agent操作指南](AGENT_GUIDE.md)交给它。

电脑、平板和手机使用同一套响应式浏览器界面；服务可部署在下述已验收的Linux、Apple Silicon macOS与Windows环境中。下载包、校验文件和精确验收摘要见[GitHub Releases](https://github.com/YogurtJ/pivane/releases)。

## 使用与管理

| 任务 | 文档 |
|---|---|
| 给已有 Pi CLI 接入网页，共用模型与身份 | [已有 Pi 接入](PI_CLI.md) |
| 部署、升级、备份和恢复 | [安装与恢复](INSTALL_RECOVERY.md) · [macOS](MACOS.md) · [Windows](WINDOWS.md) |
| 检查版本、更新 Pi、备份与重启 | [版本与更新](UPDATES.md) |
| 版本与系统范围 | [1.0.0-rc.3说明](releases/1.0.0-rc.3.md) · [RC2](releases/1.0.0-rc.2.md) · [首版RC1](releases/1.0.0-rc.1.md) · [平台验证范围](RELEASE_INSTALL_VALIDATION.md) |
| 界面语言、浏览器默认与生效方式 | [中英文界面](I18N.md) |
| 访问验证、通知、日常排障 | [访问控制](ACCESS_CONTROL.md) · [通知](NOTIFICATIONS.md) · [运维](OPERATIONS.md) |
| 聊天模型、Thinking、资源 | [供应商与模型](PROVIDER_SETTINGS.md) · [Pi原生设置](NATIVE_SETTINGS.md) |
| 按用途配置标题与媒体规划模型 | [辅助模型](AUXILIARY_MODELS.md) |
| 输入、Shell、运行恢复 | [命令与模板](COMPOSER_TOOLS.md) · [Shell](WEB_SHELL.md) · [运行控制](NATIVE_CONTROLS.md) · [运行与配置恢复](NATIVE_COMPLETION.md) |
| 历史、分叉、导出与侧聊 | [历史](HISTORY.md) · [工作流](SESSION_WORKFLOWS.md) · [导入导出](SESSION_TRANSFER.md) · [侧聊](SIDE_CHAT.md) |
| 文件与正文 | [文件查看](FILE_VIEWER.md) · [数学公式](MATH.md) · [Mermaid](MERMAID.md) |
| 用量与朗读 | [用量统计](USAGE.md) · [回复朗读](REPLY_TTS.md) |
| 媒体服务与生成 | [实验室](MEDIA_LAB.md) · [接入协议](MEDIA_CONNECTIONS.md) · [媒体Agent](MEDIA_AGENT.md) |
| 旧媒体适配器配置 | [Flux](FLUX2_DEV.md) · [MiniMax视频](MINIMAX_H3.md) · [语音registry](tts-providers/README.md) |
| 程序集成 | [API](API.md) |

功能文档后半部分可能包含接口字段和限额，供高级用户、集成者和用户Agent查询。模型能力来自实际配置与运行实例；文档中的示例不代表已经配置好服务。

## 开发文档与本地记录

[开发入口](development/README.md)保存架构、测试和发布流程，随源码版本管理。根目录[AGENTS.md](../AGENTS.md)约束源码修改；它不是用户Agent的默认运维指令。

`docs/local/`、`AGENTS.local.md`和`backups/`保存维护者私有记录，Git忽略且候选包排除。公开文档与应用不依赖这些文件。公开文件的明确清单为[public-files.json](public-files.json)。

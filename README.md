# Pivane

**Pivane 是基于 Pi Coding Agent 的个人 AI 工作台。** 在浏览器中管理项目、持续对话、查看文件与执行记录，也可以配置自己的图像、视频和语音服务。

每位使用者部署独立实例，使用自己的模型凭据、项目、会话和媒体数据。Pivane 提供 **Pi Agent** 与 **多媒体实验室** 两个工作区；不提供多人共享同一实例的账户隔离。

当前应用版本为 **1.0.0-rc.1**，包内Pi为0.85.0。首次公开候选版的安装入口、兼容要求和反馈方式见[发布说明](docs/releases/1.0.0-rc.1.md)。

## 开始使用

1. 按 [安装、更新与恢复指南](docs/INSTALL_RECOVERY.md) 部署，配置独立数据目录。
2. 在“设置 → 供应商与模型”完成 API Key 或 OAuth 登录。
3. 选择服务器上的项目目录，新建线程，选择模型后开始对话。

Linux 需要 Node.js 22.x、npm、Bash、tar/gzip 与 ripgrep。Apple Silicon macOS 和 Windows 11 x64 的原生安装要求分别见 [macOS](docs/MACOS.md)、[Windows](docs/WINDOWS.md)。使用锁定的 Pi 依赖，不要求全局安装 Pi，也没有前端构建步骤。更细的系统与未验收范围见 [平台验证范围](docs/RELEASE_INSTALL_VALIDATION.md)。

已经配置好独立身份和数据目录后，在代码目录运行：

```bash
npm ci
npm start
```

[.env.example](.env.example) 默认监听 `127.0.0.1:3001`。未配置时服务端口默认 3000；远程访问前请核对监听地址、访问验证和项目范围。

## 可以做什么

- **管理项目与会话**：持久线程、临时对话、置顶、未读、当前线程和跨线程搜索、书签与会话树。
- **跟进 Agent 工作**：流式回复、工具执行、手动 Shell、引导/后续队列、停止和压缩；默认正文视图折叠连续思考与工具记录。
- **阅读与检查文件**：原生编辑差异、当次写入记录、当前磁盘全文、Markdown、数学公式、Mermaid 和代码高亮。
- **保留工作分支**：复制、分叉、编辑重试、历史导航和 HTML/JSONL 导入导出。导航对话不会撤销文件或工具副作用。
- **临时侧聊**：冻结当前有效背景进行无工具讨论，再显式追加到主草稿。
- **配置模型与资源**：动态供应商登录、Thinking、全局/项目设置、Packages、Skills、模板与实际加载来源。
- **创作媒体**：添加自己的服务与模型，规划参数、检查清单、确认单项生成，查看与下载历史结果。回复朗读使用独立的语音默认配置。
- **跨设备浏览**：桌面分栏、手机抽屉、主题、页面提醒与可选 Web Push；后台手机通知受 HTTPS、系统和浏览器限制。

没有默认可执行的媒体服务。聊天模型、媒体模型和其服务费用由使用者自行配置与承担。媒体规划不会执行生成；失败或结果不确定的请求不会自动重放。

## 文档入口

| 读者与任务 | 入口 |
|---|---|
| 日常使用、首次设置 | [用户指南](docs/USER_GUIDE.md) |
| 让自己的 Agent 帮助安装或排障 | [用户 Agent 操作指南](docs/AGENT_GUIDE.md) |
| 安装、升级、停机备份、恢复 | [安装与恢复](docs/INSTALL_RECOVERY.md) · [运维与排障](docs/OPERATIONS.md) |
| 按功能查询细节 | [文档目录](docs/README.md) |
| 修改 Pivane 源码 | [贡献与开发](CONTRIBUTING.md) · [代码 Agent 约定](AGENTS.md) |
| 当前变化与计划 | [变更记录](CHANGELOG.md) · [路线图](docs/ROADMAP.md) |

## 数据与权限

Pi 的原生 SessionManager 和 JSONL 是会话的唯一来源。不要让 Web 与终端同时写同一会话。`PI_CODING_AGENT_DIR` 选择 Pi 身份/会话目录；`PI_MEDIA_DATA_DIR` 选择媒体/历史目录；每个实例还应显式设置独立的 `PI_WEB_DEFERRED_FILE`。

访问验证可在设置中启用；非空 `PI_WEB_TOKEN` 会强制开启。项目目录白名单用于目录选择与接口检查，**不是 Agent 工具沙箱**。Packages、Skills、扩展及工具可能执行当前系统用户权限内的操作。

Pivane 沿用已有 `PI_*` 环境变量、`pi5-*` 数据文件和浏览器偏好键。品牌改名不要求迁移或重命名已有数据、系统服务、安装目录。

## 构建候选包

```bash
npm run pack:release
```

输出`dist/pivane-1.0.0-rc.1.tar.gz`、SHA256和逐文件清单；相同版本已有包时拒绝覆盖。开发快照仍可用npm run pack:trial，生成带时间戳的pivane-trial包。脚本按允许清单打包；本地维护文档、凭据、依赖、会话、用户媒体和备份不进入包内。这些命令只构建本地文件，不发布到外部平台。

Pivane代码采用[ISC许可证](LICENSE)，[第三方声明](THIRD_PARTY_NOTICES.md)列出随包资源和npm依赖许可。蓝色π星光图标保持使用；主屏幕安装由浏览器决定，当前没有离线模式。

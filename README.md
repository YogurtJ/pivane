# Pivane

简体中文 · [English](README.en.md)

![Pivane](public/brand/logo-192.png)

**把自己的 AI 工作台带到每一块屏幕上。**

Pivane 是基于 **Pi Coding Agent** 的自托管 AI 工作台：在浏览器里写代码、管理项目和文件、跟进 Agent 任务，也能使用自己的图像、视频与语音模型。服务部署在 Linux、macOS 或 Windows 上，电脑、平板、手机通过浏览器访问同一个工作台。

**A self-hosted AI workspace powered by Pi Coding Agent. Code, manage files, and create images, video & audio from your desktop, tablet or phone. Bring your own models.**

[下载 1.1.0 正式版](https://github.com/YogurtJ/pivane/releases/tag/v1.1.0) · [开始使用](docs/USER_GUIDE.md) · [安装与恢复](docs/INSTALL_RECOVERY.md) · [Agent 操作指南](docs/AGENT_GUIDE.md) · [反馈问题](https://github.com/YogurtJ/pivane/issues)

**1.1.0 正式版锁定 Pi 0.87.1**，整合项目文件浏览、原生任务进度卡、可搜索的模型选择与跨设备收藏，以及手机布局和操作反馈改进。[查看本版变化与升级说明](docs/releases/1.1.0.md)。

本包已通过 Linux ARM64 / Node 22 的独立安装、292 项测试、12 组浏览器专项、从 1.0.0 升级及原路径恢复验收。历史版本归档保持不变；运行实例需经正常更新流程切换后生效。

## 为什么用 Pivane

### 从提问到完成工作

把项目目录交给 Pi Agent，在同一个界面里讨论方案、查看工具执行、检查文件差异，再继续下一步。支持附件、手动 Shell、停止、引导/后续消息和上下文压缩，适合需要多轮推进的编码与项目任务。

### 任务过程清楚，阅读保持轻松

默认正文视图收起连续的思考与工具记录，重要说明和最终回复始终可见。需要核对细节时切换完整记录，或在侧栏查看编辑差异、当次写入和当前文件全文。Markdown、代码高亮、数学公式和 Mermaid 图表可直接阅读。

### 长期工作有原生记录可循

沿用 Pi 原生 SessionManager 与 JSONL 会话，提供搜索、书签、会话树、分叉、编辑重试和 HTML/JSONL 导入导出。可以围绕当前任务开一段临时侧聊，读取文件、检索代码，或在明确交办并确认本次执行权限后完成小范围修改；主侧共享目录，需避免并发修改同一文件。讨论后也可把选定内容追加到主草稿。

### 模型和部署由你选择

在网页管理 API Key/OAuth、聊天模型、Thinking、Packages、Skills 与模板。每位使用者部署独立实例，配置自己的模型和数据目录；凭据保存在自己的部署环境，请求按所选供应商的协议发送。

### 把媒体创作接进工作流

多媒体实验室支持添加自己的图像、视频和语音服务。让 Agent 把自然语言需求整理为可编辑参数，检查清单并确认后执行单项生成；历史支持预览、复用和下载。回复朗读可单独配置语音默认值。

### 为人和 Agent 都准备好入口

用户指南、安装恢复、API 契约和源码开发文档分别组织。用户自己的 Agent 可以按明确步骤帮助部署、配置、升级和排障，开发者也能找到架构、数据边界与验证方法。

## 电脑、平板、手机，都能接着工作

在电脑上启动任务，用手机查看进度，在平板上阅读文件和继续讨论。持久会话保存在部署端；多个浏览器打开同一线程时，共用服务管理的同一个 Pi worker。

| 设备 | 使用体验 |
|---|---|
| 电脑 | 项目/线程侧栏、聊天正文、可调节的文件与详情分栏，适合复杂任务与代码阅读 |
| 平板 | 响应式布局、可切换面板与触摸操作，适合查看文件、阅读长回复和继续对话 |
| 手机 | 抽屉导航、紧凑的模型与任务控件、附件入口和消息跟随，便于查看进度与补充需求 |

服务端只需部署一份，其他设备通过可访问的实例地址连接。远程访问需要配置监听地址、网络和访问验证；`localhost` 只代表当前设备。切换设备前请保存未发送的草稿和附件，临时会话/侧聊有独立的生命周期。

网页适配包含 320、393、1024、1440 等宽度的浏览器回归。手机后台通知等系统能力受 HTTPS、操作系统与浏览器条件限制，具体验收范围见[平台说明](docs/RELEASE_INSTALL_VALIDATION.md)与[通知文档](docs/NOTIFICATIONS.md)。

## 界面语言

当前源码提供简体中文与英文，首次按浏览器的首个受支持语言显示，没有匹配时回退英文。在“设置 → 使用偏好 → 界面语言”选择跟随浏览器、简体中文或 English；选择保存在当前浏览器，下次打开或刷新页面时生效。保存不会自动刷新，也不改变模型回复、聊天正文或朗读语言。详细范围见[界面语言说明](docs/I18N.md)。

双语功能从 **1.0.0-rc.2** 提供；旧版1.0.0-rc.1的固定发布资产保持不变。

## 部署在你自己的机器上

当前正式版 **1.1.0** 锁定 **Pi 0.87.1**，推荐 Node.js 22.x；历史版本资产保留。1.1.0 的精确包 SHA256、验收范围和限制见[版本说明](docs/releases/1.1.0.md)及 Release 附件。下表是历史平台基线，不表示本包已在每个平台重跑验收。

| 服务端平台 | 已验收范围 | 安装入口 |
|---|---|---|
| Linux | Debian ARM64、Ubuntu 24.04 x86_64 | [Linux 安装与恢复](docs/INSTALL_RECOVERY.md) |
| macOS | Apple Silicon M2 / macOS 26.5.1 | [macOS 原生安装](docs/MACOS.md) |
| Windows | Windows 11 x64 / NTFS，原生运行，无需 WSL | [Windows 原生安装](docs/WINDOWS.md) |

需要 Node、npm 和对应平台的 Bash/ripgrep 等基础工具。**无需全局安装 Pi，没有前端构建步骤，普通安装无需现场编译原生组件。** 其他系统版本、Intel Mac 硬件及特殊文件系统的状态详见[验证范围](docs/RELEASE_INSTALL_VALIDATION.md)。

1. 从 [Releases](https://github.com/YogurtJ/pivane/releases) 下载发布包与校验文件，按平台指南准备独立数据目录和启动配置。
2. 在解压后的代码目录运行 `npm ci`，配置实例后运行 `node scripts/install-service.cjs` 安装[后台常驻与桌面入口](docs/BACKGROUND_SERVICE.md)。前台 `npm start` 仅用于试用或排障。
3. 打开工作台，在“设置 → 供应商与模型”核对已有 Pi 配置；没有可用认证时再完成 API Key 或 OAuth 登录，选择项目并新建线程。

**已经在用 Pi CLI？** 普通安装会通过 Pi 原生接口取得当前用户的身份目录，直接复用模型、认证和设置。macOS/Linux 与 Windows 使用各自的系统主目录，`PI_CODING_AGENT_DIR` 覆盖优先；无需复制认证文件。具体步骤、Windows/WSL 差异和已装成空身份的切换方法见[已有 Pi 接入](docs/PI_CLI.md)。

普通安装以后台常驻、网页可打开和只读健康检查通过为基础交付，不需要运行开发测试或打包；模型认证和真实请求单独验证。数据目录独立不代表项目必须放进指定子目录：普通安装默认开放系统用户可访问的目录，Linux/macOS 使用 `/`，Windows 使用各盘符根目录；用户明确需要时才缩小范围。当前网页不能扩大项目范围，配置方法见[目录范围排障](docs/INSTALL_RECOVERY.md#项目选择器找不到目录)。

首次安装需要下载锁定依赖；`npm ci` 还会尝试安装可选的 pi-subagents 0.69.0，失败不影响 Pivane 使用，可在“设置 → 模型与能力 → 子 Agent”确认补装。已有版本保留，默认安装不自动启动子任务；跳过与独立身份说明见[默认可选能力](docs/INSTALL_RECOVERY.md#默认可选能力)。图标、代码高亮、公式与图表所需资源随包或随依赖提供。聊天模型与媒体服务需要使用者自行配置，其服务费用由使用者承担。没有默认可执行的媒体服务。

[.env.example](.env.example) 采用 `127.0.0.1:3001`；未配置时服务端口默认 3000。不同设备访问时，请使用部署机器的可达地址。

## 历史平台验收基线

- Linux ARM64、M2 Mac、Windows 11：同一发布包各通过 **167 项 Node 测试**，完成干净安装、核心 RPC、浏览器、旧包升级和 **17 个文件逐项哈希一致的原路径恢复**。
- Windows 普通用户权限下另通过 **30 项检查**；Ubuntu x86_64 另完成同包安装、167 项测试和静态检查补验。
- 各验收环境的生产依赖 audit 为 **0 漏洞**。测试使用独立身份与合成服务，不把这些结果称为所有真实媒体供应商或手机系统的验收。

准确的历史平台、包 SHA256 和检查结果随 [RC1 Release](https://github.com/YogurtJ/pivane/releases/tag/v1.0.0-rc.1) 的 `validation.json` 提供。**1.1.0** 的变更和本包验证范围见[版本说明](docs/releases/1.1.0.md)及[1.1.0 Release](https://github.com/YogurtJ/pivane/releases/tag/v1.1.0)附件；历史 RC 跨平台结果不冒充 1.1.0 实机验收。

## 文档与 Agent 入口

| 你想做什么 | 从这里开始 |
|---|---|
| 日常使用与首次设置 | [用户指南](docs/USER_GUIDE.md) |
| 让自己的 Agent 帮助安装、配置或排障 | [用户 Agent 操作指南](docs/AGENT_GUIDE.md) |
| 升级、停机备份与恢复 | [安装与恢复](docs/INSTALL_RECOVERY.md) · [运维](docs/OPERATIONS.md) |
| 查询功能和接口 | [文档目录](docs/README.md) · [REST/WebSocket API](docs/API.md) |
| 修改 Pivane 源码 | [贡献指南](CONTRIBUTING.md) · [源码 Agent 约定](AGENTS.md) · [模块导航](docs/development/MODULES.md) · [架构](docs/development/ARCHITECTURE.md) |
| 查看版本变化与后续方向 | [变更记录](CHANGELOG.md) · [路线图](docs/ROADMAP.md) |

**给协助用户的 Agent：** 安装与排障从 `docs/AGENT_GUIDE.md` 开始；修改源码才转读 `AGENTS.md`。按实际实例的 `/api/pi/status` 和模型目录核对能力，不推断用户的凭据、项目路径或服务配置。

## 数据与执行边界

Pivane 面向个人独立部署，不提供多人共用同一实例的账户隔离。项目目录范围用于路径检查，**不是 Agent 工具沙箱**；工具、Packages、Skills 和扩展可能执行当前系统用户权限内的操作。

Pi 原生会话是对话的唯一事实来源。不要让网页与外部 CLI 同时写同一会话；历史导航不会撤销文件或外部请求的副作用。媒体规划不会直接执行生成，失败或结果不确定的请求不会自动重放。

升级前请结束任务、暂停预约、停机并整批备份。兼容既有 `PI_*` 配置、旧数据文件、API/RPC 和浏览器偏好。新源码采用 Pivane 标识并提供配置别名，目录改名使用单独的停机迁移流程，详见[命名与兼容](docs/development/NAMING.md)。当前源码在设置提供[版本检查、Pi 受管更新、停机备份与重启](docs/UPDATES.md)。`node server.js` 和 `npm start` 都自动支持网页执行与命令输出反馈，无需更改服务启动命令；Pivane 应用可从版本卡片安装新发布包，自动校验、安装锁定依赖并停机备份后切换；首次启用需加载支持应用更新的启动器。当前不包含离线模式。

## 开发与许可

在独立测试环境中运行：

```bash
npm ci
npm test
npm run check
npm run check:docs
npm audit --omit=dev
npm run pack:trial
```

`pack:trial` 构建带时间戳的开发快照；`pack:release` 根据应用版本构建发行包并拒绝覆盖同名包。发布使用允许清单，私有配置、维护记录、依赖目录、会话、用户媒体和备份不进入包内，流程见[发布文档](docs/development/RELEASING.md)。

欢迎通过 [Issues](https://github.com/YogurtJ/pivane/issues) 反馈问题或建议，通过 PR 参与改进。反馈请附版本与最短复现步骤，日志和截图先去除凭据、私人正文及备份内容。

Pivane 自身代码使用 [ISC 许可证](LICENSE)。Pi、Font Awesome、KaTeX、Mermaid 等组件保留各自许可，详见[第三方声明](THIRD_PARTY_NOTICES.md)。

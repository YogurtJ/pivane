# Pivane：源码 Agent 入口

本文件用于修改源码。安装、配置和排障从 [用户 Agent 指南](docs/AGENT_GUIDE.md) 开始。

## 开始工作

首次接手依次读 README.md、docs/README.md、CONTRIBUTING.md；再按 [模块导航](docs/development/MODULES.md) 选择相关实现和契约。架构见 [ARCHITECTURE.md](docs/development/ARCHITECTURE.md)，验证与文档维护见 [开发流程](docs/development/WORKFLOW.md)。

如果存在 `AGENTS.local.md`，读取其中的本机入口。私有维护资料可以在相邻的独立仓库，按入口给出的绝对路径读取；Pi 不会自动加载任意相邻目录。公开源码和发行包不依赖私有资料。

修改前检查 Git 状态，保留用户已有改动；没有 Git 时先保存本次改动快照。明确源码、实际运行版本和候选版本，不能用旧发布快照覆盖尚未发布的修复。默认直接完成已授权工作；用户已有授权继续有效。

## 正确性边界

1. **会话与 worker**：Pi SessionManager 和原生 JSONL 是唯一对话事实来源。每个 native realpath 会话文件只能有一个受 Supervisor 管理的 RPC worker。不可另建聊天副本或绕开管理器启动同文件 worker。
2. **协议与状态**：stdout 严格按 LF 分帧。迟到/未知的私有响应也要截获。异步变更在 await 前预占互斥；超时不表示取消或空闲。保留 runtime、revision、socket generation 与草稿版本检查。新增 worker 工作类型同时维护生命周期投影。
3. **文件与身份**：保留 realpath、项目范围、系统权限、已打开描述符的内核路径/完整身份/类型/预算/前后变化校验。Linux /proc、macOS F_GETPATH、Windows HANDLE 不得退化为请求路径或低精度 inode。原生源码、二进制和 manifest 一起更新。
4. **凭据与执行**：凭据使用公开 ModelRuntime.login/logout，私密文件保留 POSIX 权限或实际 Windows DACL、原子保存和未知字段。不要输出 .env、auth.json、Cookie、Key、Token 或私钥。媒体规划与执行票据分离，执行只用用户确认的服务器票据，不自动重放失败或不确定请求。
5. **用户数据与迁移**：不因重构删除会话、媒体、历史或 prompts。迁移必须有明确范围、停机备份、变更清单和原生语义验证。禁止全局替换 JSONL 正文冒充迁移；项目改名只允许经验证的结构字段迁移，保持会话 ID、时间、完整分支、书签和正文。删除会话先停对应 worker，并按实际 trash 结果报告。
6. **展示与平台**：模型、思考等级和参数取自 runtime/schema。Markdown 经 marked + DOMPurify，其余用户/工具文字使用安全 DOM。保留手机 16px 表单、内部滚动边界和浏览器明确偏好。
7. **上游与部署**：适配放在本项目的 CLI/RPC/SDK 边界，不改 node_modules。依赖升级单独验证，lockfile 一致。不能重启承载当前执行的服务；维护前核对全部任务、Shell、侧聊、预约、媒体、配置及导入导出。SIGINT/SIGTERM 继续使用统一异步停机，重复信号不重跑清理，失败不报告成功。

## 命名与开发

产品名 Pivane；Pi Coding Agent 是上游引擎名。新工作台标识使用 `pivane`，旧名称集中在兼容边界；原生 Pi 包名、身份变量和协议保持上游定义。改目录、配置或持久化名称按 [命名与迁移](docs/development/NAMING.md) 执行，不能仅替换字符串。

按功能职责提取模块，避免只为缩短文件而转移同样的共享状态。新增代码、测试和文档应进入统一源码发现或明确的公开清单；不要在打包、受管快照和测试入口各维护一份目录规则。

开发中运行相关检查；源码交付前完成 `npm test`、`npm run check`。本轮架构、兼容和发行边界变更还须 `npm run check:docs`、`npm audit --omit=dev`、`npm run pack:trial`。后续任务按开发流程的变更类型选择额外检查。UI 变更使用独立身份/合成服务完成 Chromium 桌面和手机检查，核对 pageerror、实际宽度、抽屉、附件与工具状态；不在维护中的真实会话发送测试消息。

用户可见行为更新指南和 CHANGELOG，接口变化更新 API，模块责任变化更新开发文档。只记录已实现行为，区分源码完成、已部署、已发布和实机验收。应用版本与 lockfile 根版本一致，发行结果绑定实际包 SHA256，同名正式包不覆盖。

私有资料、身份、媒体、备份和运行目录必须同时被 Git 和发行规则排除。Git ignore 不是打包策略或权限边界，也不清除已经提交的历史。

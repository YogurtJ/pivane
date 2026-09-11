# Pivane：代码 Agent 约定

本文件面向修改源码的 Agent。仅帮助用户安装、配置或排障时，先读 `docs/AGENT_GUIDE.md`，不要将源码开发流程当成用户操作步骤。

## 开始工作

依次阅读 README.md、docs/README.md、CONTRIBUTING.md 和与任务有关的接口/功能文档。架构见 docs/development/ARCHITECTURE.md，验证与发布见 docs/development/README.md。

若当前 checkout 存在 `AGENTS.local.md`，继续读取其中的实例约束；它是可选的本地上下文，不是用户安装所需文件。`docs/local/` 保存维护者记录，公开源码/候选包不依赖该目录。没有 Git 时先在备份目录建立本次改动快照；不要假设可以 git checkout 回滚。

## 必须保持的边界

1. **原生会话**：Pi 是唯一会话事实来源，使用 SessionManager 和原生 JSONL。不得创建第二套聊天历史或文本改写 JSONL 冒充完整跨路径迁移。
2. **唯一 worker**：同一规范 sessionPath 在服务进程内只能由 PiAgentSupervisor 管理一个 RPC worker；规范路径使用系统 native realpath。不可绕过管理器另开同文件 worker。
3. **严格协议**：Pi stdout 使用严格 LF framing；禁止 readline 按 Unicode 分隔符拆帧。内部扩展私有结果含迟到/未知响应也须截获，不广播隐藏上下文。
4. **上游依赖**：不得修改 node_modules 或维护 Pi 源码补丁；适配放在本项目 CLI/RPC/SDK 边界。依赖更新单独验证并保持 lockfile 一致。
5. **文件与身份**：项目先经过 realpath/PI_PROJECT_ROOTS/系统权限检查。保留已打开对象的内核路径、身份、类型、预算与前后变化检查：Linux /proc、macOS F_GETPATH、Windows HANDLE。不能以请求路径或低精度 inode 兜底。原生源码/二进制/manifest 成批更新。
6. **私密写入**：凭据走公开 ModelRuntime.login/logout，未知模型配置字段保留，原子写入及私有备份；POSIX权限与Windows实际DACL分别验证。不得输出 .env、auth.json、Cookie、Key、Token 或私钥。
7. **用户数据**：未经要求不删除/覆盖会话、媒体历史、public/images、public/videos、public/audio 或 prompts。删除须先停止对应 worker，按实际 trash 结果说明永久删除。
8. **执行确认**：媒体规划没有生成/保存授权。执行只使用用户确认的服务器票据，不覆盖票据参数、不自动批量执行或重放失败/不确定请求。朗读的喇叭点击授权当前回复单项生成。
9. **异步与运行状态**：await 前预占互斥；超时不代表取消/空闲。保留 runtime/revision/socket-generation 防迟到响应串线程、覆盖草稿或重发消息。保存配置不自动停止正在运行的任务。
10. **显示安全**：Markdown 经 marked + DOMPurify，用户/工具文字使用安全 DOM。模型目录、思考等级和参数由 runtime/schema 获取。保留手机16px表单、内部滚动边界、正文默认与显式浏览器偏好。
11. **维护操作**：不要重启承载当前开发会话的服务；部署需核对 Agent、Shell、侧聊、预约、媒体、配置和导入导出活动，暂停预约、停机备份。外部副作用不会因会话导航或停止而撤销。
12. **命名兼容**：产品名 Pivane；Pi Agent 是上游能力名。保留已有 PI_*、pi5-*、API/RPC 标识与存储键，改名不迁移用户安装目录或身份。
13. **发行身份**：应用版本与lockfile根版本保持一致；pack:release按版本命名且不覆盖同名包。原生manifest、项目LICENSE与第三方声明随包；验收结果绑定实际归档SHA256。
14. **正常停机**：SIGINT/SIGTERM通过pi-process-shutdown统一异步清理，监听在退出前保持注册；不能恢复once监听导致Pi依赖的signal-exit提前重发信号。重复信号不重跑清理，失败不报告成功。

## 验证与文档

完成源码变更至少运行 `npm test`、`npm run check`、`npm audit --omit=dev`。只改文档也运行 `npm run check:docs` 和 `npm run pack:trial` 核对链接、公开清单与排除边界。UI需Chromium/Playwright桌面和手机检查pageerror、实际子项宽度、抽屉/附件/tool状态；测试用独立身份和合成服务，不在当前工作会话发送测试消息。

按变化同步用户指南、接口契约及CHANGELOG；架构变化同步开发文档。用户文档只描述已实现行为和限制；公开平台范围与版本验收分开，不把代码完成写成某台机器已部署。不将维护者地址、用户名、运维单元、验收日志写进公开文档。

`docs/local/`、`AGENTS.local.md`、备份、身份、用户媒体必须同时由 .gitignore 与发布允许清单排除。.gitignore 不等于打包规则，也不是工具权限边界；已经提交到其他仓库的内容不会因新增 ignore 自动移除。

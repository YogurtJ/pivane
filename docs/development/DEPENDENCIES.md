# 依赖与上游适配

## 版本来源

应用版本和默认 Pi 依赖取自 package.json，与 package-lock 根版本及锁定条目一致。Pi Coding Agent、pi-ai、pi-agent-core、pi-tui、pi-codemode、pi-mcp、pi-telemetry 成组使用精确版本；当前绑定不依赖已退役的 pi-server、pi-protocol 或 Chord。历史归档只按其明确声明的受限布局验证。不要在另一份通用文档长期重复一组“当前版本”；发布说明记录当时的版本，运行状态报告实际加载的版本。

历史受管 Pi 更新可能与发布包原配不同；当前绑定版拒绝独立切换 Pi，必须随应用与适配层验证。源码工作区、运行 release 和下载归档分别核对，不能通过一个版本字符串推断所有文件一致。普通安装使用锁定依赖；详细升级和失败语义见 [版本与更新](../UPDATES.md)。

## 适配边界

依赖调整放在 Pivane 的 CLI/RPC/SDK 适配层，不修改 node_modules，也不维护 Pi 源码补丁。升级前阅读目标版本的原生文档和类型，核对实际公开 API；开发环境中导入成功不等于运行协议兼容。

| 边界 | 需要验证的行为 |
|---|---|
| 进程与 RPC | 启动就绪、严格 LF、响应关联、未知/迟到私有结果、正常退出 |
| 会话格式 | 原生 header、完整树/分支、system transcript、压缩、标签和导入导出 |
| 模型与认证 | ModelRuntime 生命周期、模型目录、思考等级、原生凭据保存与失败状态 |
| 设置与资源 | SettingsManager 持久化、ProjectTrustStore、资源发现与显式重载 |
| 扩展与工具 | 会话身份保护、受管命令、tool_call/result、agent_settled、工具与确认语义 |
| 平台组件 | 描述符后端、二进制与 manifest、实际目标系统 |

第三方 Pi Packages 有独立的适配范围。可选包不变成应用必需依赖，安装/更新也不自动启动子任务；扩大版本范围应有实际验证。插件配置投影不冒充插件运行时的完整能力发现。

## 原生安装安全依赖

较早 Pi npm 包含独立 shrinkwrap；1.0.2 已移除它。两种布局均不能只靠根 override 或外层 audit 证明真实运行解析已修复。根直接依赖与 lock 保留审查过的 brace-expansion／undici 固定版本，`install-bundled-capabilities.cjs` 在所有受管安装入口先核实这些声明和真实目录，只移除明确识别的旧嵌套副本，再定位实际 nested／hoisted consumer，按 Node 查找顺序核对解析并扫描已知漏洞残留；consumer 缺失或解析不符失败关闭。未知版本、符号链接或布局失败关闭，不修改上游实现字节。隔离记忆 recipe 调用同一入口并更新 lock hash。

Pivane 使用未打包的 Pi SDK／RPC 入口；Pi 自带 `dist/bundle` 中的内联代码不受依赖目录修正覆盖，不把本机运行修复宣称为所有上游分发产物已修复。

## 浏览器分发包

第三方预构建文件可能内嵌与根依赖不同的版本，根安装图审计不能证明这些字节已修复。Mermaid使用官方模块入口，经`scripts/mermaid-build/`完整锁和`build-mermaid.cjs`生成本地单文件；构建核对实际版本与唯一DOMPurify输入，保留许可证注释，不修改上游实现。构建图与主安装图分别审计，源文件、输出哈希、iframe引用和统一分发清单共同更新；方法与边界见[Mermaid指南](../MERMAID.md)。

## Pi 原生接入约束

版本审查包含 `agent_settled.aborted`、原生耗时字段、工具模式/默认修饰语、`disabledBuiltinExtensions`、MCP 取消与关停，以及 Codemode 的 `getPromptGuidelines()`、图片结构化输出/私有临时文件和模型注册表隔离。自定义流必须返回原生 `AssistantMessageEventStream`，不伪造已移除导出；原生 provider 与自定义扩展分别核对。Azure provider 标识改为 `azure`，API 标识 `azure-openai-responses` 与环境变量保持；真实旧配置须另行有界迁移审查，不改写会话正文或凭据，也不凭全局无引用推断全部项目/历史兼容。

Pi 1.3 审查新增：默认工具从 transcript 恢复与显式选择的优先级、Kimi Coding Chat Completions 及官方地址 `/v1`、最终工具参数 `argumentsError`、Responses 的 `providerThinkingLevel` 和模型范围歧义诊断。原生 JSONL 管理格式不迁移；字段往返、跨模型上下文和工具权限通过 SDK/RPC 验证。`pi-reviewed-host.js` 保存显式审查版本，主题门禁与独立记忆 recipe 复用它，并核对 package/lock。更改该常量仍须审查适配边界，不自动兼容任意版本。

Pi 1.4 审查新增：Codemode FIFO 准入、按调用读取的容量覆盖、等待期限和迟到启动保护；恢复尝试与工具结果成对省略并保留原生 JSONL；压缩的分段自定义重点、先前 checkpoint 和模型输出预算；原生扩展默认工具与显式选择优先级。MCP 迁移只在解析时去除首个 UTF-8 BOM，私有备份保持原始字节。双向会话读取须在独立 fixture 上核对完整树、custom entries 和原文件不变，不通过正文替换实现兼容。

模型高级 compat 控件直接投影 `@earendil-works/pi-ai/providers/compat-schema` 公开的 `CompatSchemasByApi[api]`，只开放布尔和字面量选项；复杂对象保留在原生配置，删除覆盖保留未知或其他 API 字段。

## 原生 Codemode 与 SDK 启动适配

Codemode 输出直接使用官方 executor／sandbox，已移除旧的输出合并子类与精确 import 重定向。原生沙箱拥有 16 Mi 字符／100000 条输出限制、取消及 store；官方 executor 拥有目录／嵌套权限、用量、截断与私有完整输出文件。Pi 1.4 的结果、finished 或 close 完成只表示已请求 VM 停止，真实退出可更晚；官方工厂默认两个存活 VM 额度按单 Pi 进程共享，`PI_CODEMODE_MAX_WORKERS` 可设为正整数并按调用读取。容量耗尽时 FIFO 等待，最多 60 秒或更短的调用期限，等待计入执行期限；取消后仍占额度至实际退出。Pivane 不把它描述为整个工作台的并发上限。Node 专项通过公开 acquireWorker/onWorkerStarted 观测实际退出，并覆盖官方工厂间 FIFO、取消、等待超时与迟到启动保护；RPC 进程退出、已派发工具和维护生命周期继续由各自所有者核实。Pivane 工厂继续约束模型注册表与媒体确认权限。验证覆盖 100001 条压力、文本／console／返回值及图片顺序、完整输出文件、失败 store、取消与不重放。

受管主会话在资源发现前初始化原生主题 schema validator；这一内部模块导出路径绑定已审查的 Pi 版本，不复制 schema。模型选择预检在保存的模型或新线程默认不可用时保留原生未选模型状态，完整目录和显式 set_model 仍可恢复；仅在 SDK 初始选择期间隐藏可用候选，真实目录与认证不变。

公开 prompt/sendCustomMessage 适配在原生调用前保留带 UUID、会话身份与导航 nonce 的启动所有权，通过原生串行 stdout 发送私有开始／完成帧。真实 Promise 完成或进程退出释放；原生 settled、读取快照及超时不能提前释放。命名 prompt section 保留普通用户／custom wake 的组合顺序和更早的 forceSystemPrompt。Pi 升级须重新验证这些公开方法的完成语义及内部 transport／theme seam。

pi-subagents 使用官方 child factory 与原生包解析；0.80 的选定 MCP／Codemode wrapper 负责就绪等待，Pivane 经 SDK seam 注入受过滤的 factory，不另设轮询。主扩展 wrapper 通过公开注册、事件和工具 API 保持 Pi 原生工具选择：惰性委派工具不因注册取得默认激活，已有分支在绑定／导航前的原生当前选择优先于上游的卸载猜测；明确启用工具的执行保留独立异步调用范围，待答请求不取得恢复委派的权限。不持久化额外的工具选择状态或迁移 JSONL。真正的 eager 工厂保留原定义默认注册，让 Pi 1.4 按原生 new-tools 规则启用从未提及的默认委派；已有 active 保持，明确 removed 不因配置转换恢复，未选中的监督回复工具也不因转换新增。

Pi 的 reload 会重新激活扩展默认工具。wrapper 只在公开 `session_shutdown(reason=reload)` 保存一次原生当前选择，以 SessionManager 弱身份、session ID 与 leaf ID 校验，在下一次启动消费并清除；结合公开 `getCurrentTools()` 和原生 mentioned 信息阻止默认重加覆盖撤销，不实现另一套会话回放。冷 loader 转 eager 可增加从未提及的默认工具；其余 live reload 保留已经完成的选择。已在 reload 前完成的公开选择、已持久化重新启用、reload 后的 `setActiveTools`／`subagents_enable` 与新进程 `--tools` 继续有效。自定义 SDK 宿主若在同次 `beforeSessionStart` 中新增工具，且该集合与自动默认重加无法区分，wrapper 保守保持撤销；应在 reload 完成后明确选择，或在 reload 前选择并持久化。Pivane 生产服务不通过该回调重选工具。

销毁代次检查使启动期间已排队的创建失效；精确 MCP selector、工具 gate、授权与媒体限制仍由 Pivane 保留。单一精确 import 重定向仅用于直接工具 selector 解析，不扩大为通用 alias。官方 calendar 模块需要根锁定的 Temporal polyfill；不安装 vendor 的开发依赖。记忆绑定 0.9.10：上游把 pi-tui 改为 peer，根依赖与独立 recipe 均直接提供宿主 TUI；数据库追加列、搜索只读与技能描述上限见[记忆适配](../PROFILE_MEMORY.md#upstream-0910-adaptation)。

## 验证与交付

1. 在隔离身份和目录中安装目标精确版本，保留依赖、锁文件、原生组件和恢复材料。
2. 先执行 SDK/RPC/原生会话探针，再运行受影响测试与完整交付检查；真实供应商另行验证，不继承开发者认证。
3. 原始会话、凭据和媒体不替换为测试数据。失败或响应不确定不自动重放用户请求。
4. 候选、安装、启动、数据恢复分别记录状态。验证结果绑定具体提交/归档及平台、Node/Pi 版本。
5. 发布或启用按已有授权和维护边界执行，不停止承载当前操作的服务。

常规代码重构沿用已验证的锁定依赖；升级 Pi、第三方包或系统 Node 是独立变更。记录已知不兼容点和验证依据，避免把阶段性限制写成永久禁止。

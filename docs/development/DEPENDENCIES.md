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

## Pi 1.2 接入约束

版本审查包含 `agent_settled.aborted`、原生耗时字段、工具模式/默认修饰语、`disabledBuiltinExtensions`、MCP 取消与关停，以及 Codemode 的 `getPromptGuidelines()`、图片结构化输出/私有临时文件和模型注册表隔离。自定义流必须返回原生 `AssistantMessageEventStream`，不伪造已移除导出；原生 provider 与自定义扩展分别核对。Azure provider 标识改为 `azure`，API 标识 `azure-openai-responses` 与环境变量保持；真实旧配置须另行有界迁移审查，不改写会话正文或凭据，也不凭全局无引用推断全部项目/历史兼容。

## 原生 Codemode 与 SDK 启动适配

Codemode 输出直接使用 Pi 1.2 官方 executor／sandbox，已移除旧的输出合并子类与精确 import 重定向。原生沙箱拥有 16 Mi 字符／100000 条输出限制、取消、worker 关闭及 store；官方 executor 拥有目录／嵌套权限、用量、截断与私有完整输出文件。Pivane 工厂继续约束模型注册表与媒体确认权限。验证覆盖 100001 条压力、文本／console／返回值及图片顺序、完整输出文件、失败 store、取消与不重放。

受管主会话在资源发现前初始化原生主题 schema validator；这一内部模块导出路径绑定已审查的 Pi 版本，不复制 schema。模型选择预检在保存的模型或新线程默认不可用时保留原生未选模型状态，完整目录和显式 set_model 仍可恢复；仅在 SDK 初始选择期间隐藏可用候选，真实目录与认证不变。

公开 prompt/sendCustomMessage 适配在原生调用前保留带 UUID、会话身份与导航 nonce 的启动所有权，通过原生串行 stdout 发送私有开始／完成帧。真实 Promise 完成或进程退出释放；原生 settled、读取快照及超时不能提前释放。命名 prompt section 保留普通用户／custom wake 的组合顺序和更早的 forceSystemPrompt。Pi 升级须重新验证这些公开方法的完成语义及内部 transport／theme seam。

pi-subagents 使用官方 child factory 与原生包解析；已移除旧 host alias 兼容层，Pivane 精确 MCP selector／授权仍保留。官方 calendar 模块需要根锁定的 Temporal polyfill；不安装 vendor 的开发依赖。记忆仍绑定 0.9.9。

## 验证与交付

1. 在隔离身份和目录中安装目标精确版本，保留依赖、锁文件、原生组件和恢复材料。
2. 先执行 SDK/RPC/原生会话探针，再运行受影响测试与完整交付检查；真实供应商另行验证，不继承开发者认证。
3. 原始会话、凭据和媒体不替换为测试数据。失败或响应不确定不自动重放用户请求。
4. 候选、安装、启动、数据恢复分别记录状态。验证结果绑定具体提交/归档及平台、Node/Pi 版本。
5. 发布或启用按已有授权和维护边界执行，不停止承载当前操作的服务。

常规代码重构沿用已验证的锁定依赖；升级 Pi、第三方包或系统 Node 是独立变更。记录已知不兼容点和验证依据，避免把阶段性限制写成永久禁止。

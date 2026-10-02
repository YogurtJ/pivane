# Pi 原生 MCP 与 Codemode

当前 **Pivane 1.5.0 开发源码绑定 Pi 1.0.0**。已公开的 1.4.0 仍使用 Pi 0.99.1，见[历史版本说明](releases/1.4.0.md)。源码、实际运行实例和公开发行分别核对；旧归档不被修改。

## 配置与使用

主线程加载 Pi 官方内置 `mcp`、`codemode`、`tool-search` 和 `llama.cpp` 扩展。全局服务器配置为 `<agentDir>/mcp.json`；受信项目可以使用 `.pi/mcp.json`，同名项目条目替换全局。项目不受信时不连接项目服务器。stdio 执行部署机器上的程序，HTTP 使用 Streamable HTTP；旧 SSE 不支持。

```json
{
  "mcpServers": {
    "local-tools": { "command": "node", "args": ["/absolute/server.js"] },
    "remote-tools": {
      "url": "https://example.invalid/mcp",
      "headers": { "Authorization": "Bearer ${TOOLS_TOKEN}" },
      "timeout": 60,
      "exposure": "codemode"
    }
  }
}
```

例子不是已配置服务。密钥用环境变量或经审查的命令引用，不在聊天中展示。OAuth 使用 Pi 自己的 `mcp-auth.json`；旧适配器凭据不能直接视为原生登录，需要用户通过原生流程重新授权。

- 默认 `codemode`：模型写 JavaScript，在 QuickJS 沙箱通过 `tools.<name>()` 编排工具，只返回有用输出。工具本身仍以部署用户权限执行，不是文件权限沙箱。
- `codemode-deferred` 在 Pi 1.0 中是 `codemode` 的兼容别名，网页统一显示 `codemode`；`deferred` 通过 `tool_search` 按需加载工具；`direct` 直接声明给模型；`hidden` 不可调用。`toolExposure` 可覆盖单项。所有调用，包括嵌套调用，仍经过 Pi 的工具事件与权限钩子。
- CLI 管理为 `pi mcp add/remove/list/login/logout`；会话命令 `/mcp` 在 RPC 中输出状态，`/mcp login <server>` 等使用原生对话流程。网页入口为“扩展 → MCP”，见下节。Pivane 不提供旧适配器的 MCP Apps 网页、安装网关或 `mcpScript` 工具。
- 原生工具名为 `mcp__<server>__<tool>`，其中连字符规范化为下划线；超长或冲突名由 Pi 加哈希。仅连字符／下划线不同的服务器名会冲突，须使用不同名称；网页保存拒绝新增冲突，已有配置中被原生加载跳过的冲突项显示无效。配置中的 `toolExposure` 和子任务选择器保留原始名称，以实际注册目录核对工具，不能自行拼接授权名称。
- 会话启动等待直接暴露的工具，其余服务器按原生按需机制连接。Codemode 提供 `searchTools()`、`describeTool()` 与 `describeNamespace()`，工具搜索也匹配描述；当前加载目录和调用权限仍分别校验。
- 安装或保存配置不等于当前 worker 已加载。完成任务后重载当前资源或重开 worker，并核对实际工具目录。

资源页列出 `builtin:mcp` 等内置扩展，可逐项关闭。`--no-extensions` 禁用内置扩展；侧聊保持无 MCP/Codemode 的严格隔离，媒体规划也不因升级取得外部工具或自动执行生成权限。

## 网页管理与工具设置

“扩展 → MCP”分别管理**已保存配置**与**所选会话运行状态**。打开页面和刷新配置只读取原生文件，不连接服务器、不执行环境或 header 命令、不启动 worker。

- 全局与项目配置分开列出；项目覆盖同名全局条目，仅受信项目参与运行。未受信项目可查看经过脱敏的配置，但不能保存。信任管理沿用原有项目入口。
- 可添加、编辑和移除 stdio／HTTP 条目，设置启用、四种暴露策略、秒单位超时、`toolExposure` 和 `autoEnableCodemode`。`toolExposure` 使用服务器原始工具名或 `*` 模式；精确名称优先，多个模式按原对象顺序匹配，不按网页排序。
- 现有 command、args、cwd、URL、env、headers 及 OAuth 字符串均不回显；只显示字段存在与否。默认保留，替换和移除必须明确选择；环境变量／命令引用原样保存，不在编辑器求值。未知字段保留且不开放随意编辑。不要把“已存在”提示或空占位作为新凭据提交。
- `description` 是普通文本，编辑上限 4096 个 JavaScript 字符，null 移除。OAuth 的 `clientName` 与 `authServerMetadataUrl` 同样只显示存在状态，使用明确的保留／替换／移除；URL、回调端口与回调 URL 一致性由原生校验。
- `auth.provider` 是非秘密的供应商标识，仅允许全局 HTTP 服务器，地址必须是 HTTPS 或原生允许的 loopback。它复用 Pi 供应商登录，优先于 OAuth；供应商返回 token 时会覆盖配置的 Authorization header。新增或改变 provider 时若仍有该 header，编辑器拒绝保存，须明确移除 header 后再改。既有原生支持的组合可做无关编辑，不自动删除 OAuth 或凭据。API 的 `auth:null` 明确移除整个认证块。
- 保存需确认与当前 revision；修订覆盖两范围 MCP、设置与信任。冲突、失败或结果不确定时不自动重试，先明确刷新核对；成功保存也不自动重载现有线程。文件写入私有、原子，拒绝符号链接、非普通文件与损坏 JSON。
- 先打开一个持久线程，才能明确读取该唯一 worker 的原生状态，或确认重连、OAuth 登录／退出。页面不另建 MCP 客户端；原生连接、授权、取消和清理由 Pi 官方扩展拥有。状态无法核实时显示未知，不能用工具曾注册过推断连接健康。
- OAuth 登录期间，回到聊天打开原生授权链接；浏览器无法访问部署机回调时，在原生待确认输入框粘贴重定向 URL。凭据保存在 Pi 的原生存储，不新增网页凭据副本。断开网页不等于取消，也不允许重放未确认的操作；需要取消时使用原生对话的取消入口。

“设置 → Pi 配置 → 工具”支持 `codemode`、`tool_search`、替换工具列表或按顺序输入 `+名称`／`-名称`。只有修饰符时改变继承选择；普通名称先替换，再应用修饰符；自定义工具名保留但不代表工具已加载或已获授权。Pivane 显式 `[]` 保持不默认启用任何工具的既有语义，项目修饰符叠加全局 `[]` 不会恢复默认工具。`codemode.mode=on|only` 控制模型看到的工具呈现；`codemode.inlineBudget`（0–1000000，默认 3000）是估算声明 Token 预算，**不是执行超时或权限边界**。执行超时仍是单个脚本的 `@options.timeout_ms`。

`autoEnableCodemode` 写在 `mcp.json`，不是 `settings.json`；是否实际启用仍以该 worker 的工具目录为准。关闭扩展、侧聊隔离和子任务授权边界保持不变。

## 嵌套调用与文件归属

聊天把原生 `parentToolCallId` 的实时调用放在父工具下，支持有界后代层级，不额外增加顶层调用计数。完成或重开后用父 `toolResult.nestedCalls` 替换实时展示；缺参数、错误、未完成、记录不完整均明确标注。

原生记录只保存调用 ID、名称、有界参数、状态、耗时和错误，**不保存嵌套工具输出**。历史编辑差异不能恢复，不读取当前文件伪造当时差异；“本轮文件”仅认定唯一父调用／结果关联下、各自状态成功且路径参数可核实的 `edit/write`。父脚本失败不抹掉此前成功子调用。嵌套 write 内容来自实际保留的调用参数；参数被省略、失败、未完成、ID 歧义或私密路径不建立文件成功归属。

原生摘要最多 256 调用、每项参数 8 KiB、总参数 32 KiB，网页另限制八层后代；大型 write 的参数可能不保留。实时输出仅是有界页面／worker 恢复预览，不建立额外持久聊天或文件版本库。修改过程和恢复限制见[文件查看](FILE_VIEWER.md)。

## 子 Agent 授权

Pivane 保留 pi-subagents 的任务生命周期，用适配边界把 `mcp:server/tool` 选择器解析到 **父会话已连接、由 Pi 注册的原生工具名**。不读取旧 `mcp-cache.json`。父会话先连接服务器，再启动需要该工具的子任务；配置或项目变化、未连接、隐藏工具、缺失名字均失败关闭。仅运行时注册且未持久配置的服务器暂不能交给子任务。当前父会话工具授权快照为 16 KiB／至多 1024 项，超过预算的 MCP 选择器失败关闭，不降级到旧缓存；工具连接前有 10 秒就绪窗口，超时不发送模型请求。

pi-subagents 0.74.0 的原生 MCP launch plan 使用同一经过校验的工具快照；子会话仅加载一份 Pivane 过滤后的 MCP／Codemode 工厂，并保留父会话传入的项目信任；未受信项目的上下文指令不进入子会话，身份级全局指令仍保留。严格子任务 `tools` 和 capability ceiling 同时限制直接调用与 Codemode 嵌套调用。仅准许 `codemode` 不等于准许它调用所有服务器。拒绝扩展的子任务不获得 MCP。后台子任务的连接由自身会话管理，并在结束时关闭；前台子任务默认仍不加载父会话环境扩展。

## 从 pi-mcp-adapter 迁移

Pivane 主／子运行时加载前过滤可识别的旧适配器包与路径，避免第三方 `/mcp` 替换原生实现；原文件保留，不自动卸载用户 CLI 包。发现页不再推荐安装适配器，管理 API 拒绝新增或更新旧适配器。

**不能仅复制旧 mcp.json 就宣称兼容。** 旧适配器可能从其他客户端导入传输、使用 `bearerToken`、毫秒超时、过滤和懒连接；原生默认只读全局与受信 `.pi/mcp.json`，没有旧闲置连接策略。

可由部署机器上的独立维护 Agent 显式运行：

```sh
# 只读转换检查，不写配置
node scripts/migrate-native-mcp.cjs --agent-dir /absolute/agent-dir \
  --legacy-defaults /absolute/reviewed-legacy-mcp.json

# 所有 Pi/Pivane/CLI 写入已结束，停机并完成整批备份后再执行
node scripts/migrate-native-mcp.cjs --agent-dir /absolute/agent-dir \
  --legacy-defaults /absolute/reviewed-legacy-mcp.json --apply
```

脚本仅处理明确给定的配置：合并经审查的传输、将 bearer token／环境引用／经审查的凭据命令转为原生完整 header（迁移时不求值）、毫秒超时转秒、移除旧适配器声明；未知顶层字段保留。写入前保存私有原字节备份，凭据不进入输出，未变化重复执行不再写入。SSE、socket、旧过滤、动态请求头和导入／plugin 规则需要人工转换，脚本先拒绝而不放宽权限。OAuth 存储、旧包、会话正文和模型身份不被删除或迁移。

正常安装不运行这个脚本。跨版本切换必须同时保留代码和数据备份；回退代码不能自动撤销已转换配置。具体停机和恢复边界见[更新](UPDATES.md)与[安装恢复](INSTALL_RECOVERY.md)。

## 其他 Pi 1.0 能力

支持官方虚拟模型与分类模型 SDK，是否提供 Auto 路由由用户加载的扩展决定；Pivane 不自动改用其他模型。OpenAI 新 ChatGPT 登录沿用原生安装 deviceId 和认证接口，旧 Codex 身份不自动转换。Pi 1.0 Codemode 增加 `models.generateImages()`；Pivane 主线程与子任务的官方 Codemode 工厂在模型注册表边界拒绝该直接生成入口，并提示使用已有媒体规划、确认与一次性执行票据。模型目录与分类接口保留原生行为。聊天供应商凭据不会因此成为媒体执行授权。

上游参考：[MCP](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/mcp.md)、[Codemode](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/codemode.md)、[虚拟模型](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/virtual-models.md)。

# 供应商登录与模型 Thinking

## 已有 Pi CLI 配置

普通安装使用与 CLI 相同的 Pi 身份目录，从原生模型配置和认证库读取供应商；没有额外的模型导入或认证复制层。`PI_CODING_AGENT_DIR` 非空时覆盖平台默认主目录。CLI 已配置而网页为空时，先核对身份路径、供应商环境变量/外部命令依赖及筛选状态，不直接要求重新登录。平台目录解析、现有空身份切换与共享限制见[已有 Pi 接入](PI_CLI.md)。

## 首次接入与会话模型目录（2026-09-11）

设置页模型测试与当前会话是不同运行实例。先打开无认证会话、再登录时，原生RPC的get_available_models只返回该worker缓存的目录；网页刷新也会复用同一worker，可能仍是空目录/unknown模型。modelCatalog标记补齐主连接refresh_models：只在空闲时通过私有扩展调用公开ModelRegistry.refresh({allowNetwork:false,signal})，重新读取模型和认证状态，不重载资源、不新开worker、不自动切换模型或发送草稿。

网页首次连接与供应商/模型设置完成后读取新目录，忙碌期间延后或明确提示。手动刷新入口位于未配置/模型不可用/目录错误的提示区，不常驻模型旁边占用顶栏；手机恢复紧凑布局，思考等级、上下文、侧聊和详情入口保持可见。没有可用模型时显示设置入口；已接入但本会话尚未选择时显示选择入口。原生恢复的会话模型优先于全局默认，新默认不自动改写已打开会话。未准备好时普通发送不进入模型，文字/附件保留；Shell和独立管理/扩展命令仍沿用其原流程。

缺少当前模型认证的原生preflight拒绝转为MODEL_AUTH_REQUIRED中文说明，避免把终端/login与安装目录路径作为网页主要报错。没有把远端401、网络故障等全部归为“未配置”；也不重放失败或不确定请求。选择与目录刷新按socket代次保护迟到结果，切线程不串模型/草稿。

服务端刷新与会话操作、登录/配置写入互斥，同一worker刷新合并；已在切换模型或切换结果不确定时拒绝刷新。8秒原生signal、12秒RPC等待、最多5000模型/1MiB，仅输出选择所需字段，不返回认证或headers；私有响应包括未知/迟到均截获。超时/失去确认时关闭预先空闲且受互斥保护的worker再重连，不释放仍可能改变目录的实例供继续发送。旧后端保留原生只读列表刷新，并提示必要时空闲退出/重开。

本功能通过 Pi 0.85.0 公开 ModelRuntime、SettingsManager 与 pi-ai 的 getSupportedThinkingLevels 接入，不修改 Pi 依赖包。代码已实现；生产是否启用以 `/api/pi/status.providerLogin`、`modelThinking` 为准。

## 设置入口

“供应商与模型”默认显示全部 Pi 原生供应商及本地自定义配置，已配置者排在前面。供应商默认折叠，展开后在同一处登录、移除凭据、浏览模型、测试、设置默认模型与 Thinking。搜索覆盖完整供应商名称/ID/模型目录，模型按供应商每页 20 项；“仅已配置”和“仅可用”均为可选筛选，初始关闭。无模型供应商仍显示登录入口，登录后可显式刷新远端目录。

“使用偏好”的[辅助模型](AUXILIARY_MODELS.md)集中管理标题生成和媒体规划（原模块 Agent），并保留独立的回复朗读配置。模型测试发送真实最小请求，最多 64 个输出 token，可能产生费用。配置保存不自动发测试请求。Model ID 支持 `/`、`:`、`@` 等真实供应商标识，按原值查找并编码到 REST 路径，不作为文件路径。新建自定义模型且未设置价格时，若 ID 精确匹配 Pi 内置官方供应商目录，自动填入其输入、输出、缓存单价和阶梯；保留已有显式价格。历史零费用的独立补算与持久账本见[用量统计](USAGE.md)。

## Pi 原生登录

服务端每次从 ModelRuntime 的 Provider 定义读取 API Key / OAuth 能力和标签。API Key 与 OAuth 共用原生 AuthInteraction，支持 secret、text、select、manual_code，以及 info 链接、授权 URL、设备码和进度。不能根据供应商名称猜测支持的方法；例如 OpenRouter OAuth 实际铸造 API Key，最终凭据类型由 Pi 决定。

OAuth 在 Pi 服务进程内运行供应商自己的授权协议，浏览器只渲染交互。Loopback callback、PKCE、设备轮询、token 交换和原生凭据保存/刷新均由 Pi 处理，不新增公开 OAuth 回调。手机或远程电脑的 localhost 不是 Pi 服务器；供应商支持时，用户可粘贴最终回调 URL/授权码。没有手动回调或设备码后备的供应商可能仍需要在服务器本机浏览器或终端完成认证，不能承诺所有网络环境下 OAuth 都成功。

网页登录不加载用户扩展；仅由扩展 registerProvider 注册的服务不会自动出现在管理目录。标准 API 的自定义服务应保存到原生 models.json；不得为获得任意扩展 OAuth 而在 Web 服务进程中执行用户扩展。

服务器一次允许一个登录，避免 Pi 内置 OAuth 的固定 loopback 端口冲突；登录期间拒绝其他凭据和模型配置写入。登录窗口使用随机私有句柄，只存在于发起页面内存，不跨浏览器列举或写入 session/localStorage。流程最多 10 分钟；关闭窗口/设置取消待完成登录，刷新或崩溃未送达取消时由过期清理。

每个输入步骤具有独立 ID；同一步只接受一次，旧 ID、无效选项和超过 32768 字符的回答被拒绝。Pi 的逐 prompt AbortSignal 能撤销被 callback 赢得的手动输入；不把迟到输入发送给后续步骤。轮询只读，不覆盖正在编辑的字段。答复失败或结果不确定不自动重发。

API Key 流程输入按 Pi config-value 字面量转义，`!`/`$` 不作为网页提供的 shell 命令或环境表达式执行。OAuth 授权输入原样交给 Pi。秘密输入框初始为空，回答和凭据不出现在快照、通知错误或日志。授权页/设备码是交互必需信息，属于发起页面的短期数据；链接只允许 HTTP(S)，采用 noreferrer/noopener，文字以安全 DOM 渲染。

取消可能与 Pi 的原生凭据提交相遇。原生成功时显示成功；CredentialSynchronizationError 显示“凭据已保存但状态同步失败”，要求刷新核对，不重复登录或回滚凭据。服务销毁等待登录清理；终态清除输入、交互事件及本地秘密引用。登录只是认证，不发送模型问题或生成媒体。

## Thinking 的两层含义

1. **默认等级**：按模型保存到 Pi 原生全局 `settings.json.modelThinkingLevels[provider/modelId]`；选“跟随全局”删除该模型的覆盖。只提供当前 Pi 判定支持的选项。新会话采用默认，恢复已有 session 仍保留原生历史状态；正在运行的 worker 不被强制终止。
2. **能力与映射**：高级表单编辑模型的 `thinkingLevelMap`。省略表示使用 Pi 定义，null 禁用等级，字符串为供应商参数值。自定义模型修改其 models 条目；内置模型修改 providers 下的 modelOverrides，保留其他能力、费用、兼容字段和未知配置。“恢复 Pi 原始能力”只删除该模型的本地 map。内置 overrides 按 Pi 原生规则合并，custom models 的 map 则属于模型本身。

当前版本的 map 协议键为 off/minimal/low/medium/high/xhigh/max，由服务端 schema 提供；每个模型的实际等级必须由官方 getSupportedThinkingLevels 解析，浏览器不写死支持范围。reasoning=false 的模型仅支持 off；自定义模型需要先在模型编辑器启用 reasoning。声明映射不会让远端服务获得原本不支持的能力。

提交时检查配置修订、模型存在、映射结构和有效等级。不能禁用全部等级，也不能留下已不受支持的该模型默认值；先修改/清除默认值再缩小支持范围。保存 map 后重新打开 Thinking 窗口可选择新等级。高级修改仅影响指定模型，不改 enabledModels、全局 thinkingBudgets、当前 session 或默认聊天模型。

修订覆盖 models.json 和全局 settings.json，旧页面保存返回 409。所有本服务配置写入互斥；models.json 使用 0600 backup 和原子替换，settings 使用原生 setter/flush。两个文件不是跨文件事务；文件 I/O 失败后应刷新检查，不能自动重放保存。

## REST

前缀 `/api/pi/settings`，复用 Pi Origin/可选 Bearer token；响应 `Cache-Control: no-store`。

| Method | Path | 内容 |
|---|---|---|
| GET | `/models` | 增加 providerLogin/modelThinking、revision、thinkingMapKeys；模型含 thinkingLevels/thinkingLevelMap；preferences 含全局默认与逐模型默认 |
| POST | `/providers/:id/login` | `{method:"api_key"或"oauth"}`，启动并返回私有状态 |
| GET | `/login/:id` | 只读轮询私有状态，不包含提交值或 credentials |
| POST | `/login/:id/answer` | `{promptId,value}`，回应一个仍有效步骤 |
| DELETE | `/login/:id` | 取消并返回状态；终态重复取消无新副作用 |
| PUT | `/models/thinking` | `{provider,modelId,expectedRevision,defaultThinkingLevel?,thinkingLevelMap?}`；默认 null 删除覆盖，map null 恢复原始能力 |

状态含 id/providerId/method/revision/status/expiresAt/finished/message/events/prompts。status 为 starting/waiting/cancelling/success/committed/cancelled/expired/error。非法输入 400，旧句柄 404，操作占用/过期步骤/修订冲突 409。初始 HTTP 200 仅表示流程已创建，必须读取终态判断认证结果。原 `/api-key` 单字段接口继续兼容，新的 Web 使用多步骤入口。

## 验证

`test/pi-provider-login.test.js` 使用独立 Agent 目录、真实原生 Cloudflare 多字段/API Key 持久化、官方 runtime 中的 OAuth fixture 与临时 CLI worker，覆盖取消、过期、回调竞态、秘密不回显、HTTP 鉴权/Origin/no-store、模型修订、内置 map 恢复和原生 thinking 默认/可选范围。无付费网络请求。

`test/browser/settings-provider-login.cjs` 使用系统 Chromium 和受控 REST/WebSocket，覆盖桌面、393px、320px 与三主题的统一目录、API Key/选择/回调/设备码、迟到启动取消、失败不重放、thinking 默认/映射/冲突、偏好/Packages/Skills 与内部宽度。原 `settings-model-catalog.cjs` 保留 400 项后的模型、分页、精确操作目标、搜索及键盘回归。真实账号 OAuth 和 iPhone Safari 真机授权尚需由用户使用自己的账户验证。

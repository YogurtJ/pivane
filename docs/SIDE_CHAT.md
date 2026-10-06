# BTW / Side Chat

能力与行为按当前运行接口核对。`GET /api/pi/status.sideChat` 表示侧聊可用；`sideChatContext=true` 表示有效上下文快照已启用，`sideChatRetention=true` 表示本页跨线程保留已启用。源码实现不等于生产已重启，以运行中的接口为准。

`sideChatTools=true` 表示新建侧聊可以使用工具。新页面默认提交 `toolMode=assist`；旧页面省略该字段仍使用无工具兼容模式。能力以实际运行实例为准。

## 延迟创建、过期与此前侧聊

实例提供 `sideChatLifecycle=true` 时，按钮只展开面板，输入、选模型或选背景不创建 worker。首次发送时捕获当时的主会话有效背景并启动；无该能力的旧后端保留点击创建兼容路径。发送失败保留草稿，未知投递不自动重试。

每轮回复完全 settled 后闲置 **12 小时**回收运行实例；新问题取消计时，下一轮结束重新计时。阅读、复制、写草稿和模型选择不延长计时。服务端到期前以原生互斥核对空闲，不回收生成、工具、重试、压缩或待确认的运行。创建但未发送的兼容实例从启动完成计时。回收前同步最终可见侧消息和统计，不传 inherited 背景；页面提示过期，记录仍可阅读复制，草稿仍可编辑，须点击“新开侧聊”后才能再发送。

“更新背景并新开”结束当前空闲段；旧记录折叠到此前侧聊，附时间、模型和原背景捕获时间。旧消息、工具结果、背景快照及授权 **不进入新 Agent 上下文**。未发送草稿和模型选择保留；下一次发送才重新捕获背景。更换背景范围采用相同新段流程，不直接替换旧段背景；取消确认保留原段。执行中及待确认时禁用新开/换背景，必须先停止并等完全空闲。

每个主线程本页保留最多 20 段此前侧聊，达到时明确阻止再开，不自动删除或摘要；本页最多同时运行 3 个侧实例，归档不占运行名额。此前记录只是浏览器内存展示，不建立第二个持久事实库，刷新、关页、退出登录后不恢复。运行断开亦保留已显示记录，不自动续接。

“结束并清空”确认后结束当前主线程的侧实例，并清除它的全部当前/此前记录、草稿、引用卡片和工具展示；其他主线程不受影响。已发生的文件副作用不回滚，精简用量账本不删除。消息只保留复制操作，移除“放入主输入框”按钮。

## 独立模型与思考等级

`sideChatModels=true` 时在侧聊设置独立选择模型和思考，初始继承主聊；空闲切换保留记录、冻结背景、草稿和用量，不修改主聊或全局偏好。等级取自模型能力，运行或待确认时禁止切换。

选择器复用[主聊模型交互](PROVIDER_SETTINGS.md#会话模型快速选择)，共享收藏与本浏览器最近列表；切线程关闭侧弹窗，选择仍只作用于侧聊。

切换前检查当前有效上下文、系统提示和工具 schema 的估算预算并预留回答空间；容量不足或目标不支持已有图片时拒绝，不静默截断。可保留原模型，或结束后选空白背景新开侧聊。未知结果不自动重试；配置 RPC 超时会结束侧连接，避免按未知模型继续发送。各轮费用保留实际模型归属，不按新模型重新计算历史。

## 当前行为

默认 `mode=context` 冻结主会话有效上下文，包括压缩／分支摘要、消息、工具参数和结果及当前系统提示；按模型容量预留回答空间，装不下明确拒绝。`mode=blank` 不带背景，引用选文只追加草稿，不改变背景。

入口及 `/btw` 在网页本地打开侧聊，不发送给主模型。持久线程切走后，启用 `sideChatRetention` 的页面保留侧聊和阅读位置；关闭面板不停止。临时主会话退出、删除原线程或显式 `/quit` 会结束关联侧聊，异常断开不自动重连或重发。

主侧共享文件，继承的工具记录只作背景、不重放；停止和关页不回滚已完成修改。生命周期及本页保留上限见上节。

不提供侧聊持久化、刷新恢复、文件上传、自动合并、后台委派或代码目录隔离。长期任务使用正式分叉线程。

## 工具与执行授权

支持 `read/grep/find/ls/edit/write` 和当前平台的命令工具（POSIX 使用 `bash`，Windows 使用 `powershell`）。读取和代码检索不需额外确认；命令可能写文件、访问网络或产生其他副作用，不能当作只读。没有自动继承主线程的任意扩展、MCP、Skills 或委派工具。

侧聊遵守行为约束：围绕侧问题讨论和调查，不主动继续主任务；明确要求修改后，先读当前文件、项目约定及差异，保留既有改动，避开与主 Agent 同时修改同一处。较大改动应使用正式任务或独立工作树。该约束不是文件锁，两个进程及外部编辑器之间不保证原子合并。

项目自有的单个显式 SDK 扩展在原生 `tool_call` 前请求 `ctx.ui.confirm`。确认面板显示首个操作的工具、完整参数和工作目录，并说明授权覆盖本次回复的后续修改与命令；模型没有从自然语言关键词自行获得授权的通道。原生工具 schema 始终可见，读取立即执行，写入不再永久禁用。状态显示“可读取 / 等待确认 / 本次可修改”。原生 run 完全 settled 后撤销授权；拒绝、超时、停止、未知/过期确认不得执行或自动重放。确认最长等待五分钟。

确认使用原有 Pi UI 协议与 worker pendingUi 表，侧连接仅能回答本段仍有效的确认 ID，不能通过该入口回答主线程或另一侧聊。切走时确认留在原侧聊，不在新线程弹出；返回后再处理。工具调用、参数、输出和失败以可展开的安全文本记录显示。界面中的执行成功以实际工具结果为准，授权本身不代表操作成功。

执行确认以独立卡片展示“仅本次回复”范围、待执行工具、工作目录与文件路径。命令按原始换行显示，编辑／写入内容可预览，完整原参数仍可展开核对；无法识别的旧确认格式原样作为安全文本显示。长内容在卡片内部滚动，底部取消／允许按钮保持可操作；允许按钮使用主色，提交时显示忙碌状态并禁用重复点击。同一确认的状态刷新保留参数展开与阅读位置，不改变逐回复权限或自动重试行为。

项目范围、访问验证及操作系统权限检查保持；`projectTrusted=false` 继续阻止项目资源自动加载，不代表 builtin 工具被沙箱隔离。shell、read 等工具具有当前服务用户的文件权限，执行授权不能用于绕过项目和用户约束。SDK 执行输出/取消沿用官方实现，无工具执行循环或 Pi package 补丁。

## 界面说明与必要提醒

顶部信息按钮按需说明背景、新段、12小时空闲、本页记录及执行确认；查看说明不捕获背景或启动运行实例。

设置折叠时保留当前模型摘要；准备、生成、错误、待确认和过期状态仍可见。

## 面板布局

桌面侧聊与主会话并排，分隔线支持拖动、键盘调宽和双击重置；普通宽度保存在浏览器，窗口缩小时限制实际宽度，恢复空间后沿用偏好。

窄桌面开右栏时暂藏线程列表；900 CSSpx及以下使用抽屉。调整宽度、收起、切页签和跨视口不重建侧聊、不发送消息或清空草稿。文件展开／全屏阅读见[文件面板](FILE_VIEWER.md)。

背景和模型控件位于折叠设置中；“更新背景并新开”需确认，新段首次发送才创建实例。待主任务确认的提示始终可见。

布局不改变侧聊能力；工具、上下文和生命周期分别核对后端标记。

## 上游与会话边界

所有适配在本项目，未修改 Pi package、依赖版本或维护补丁。仍然一个持久 session 文件只由一个 Supervisor worker 管理。

普通主会话、临时主会话继续使用官方 CLI/RPC。新默认侧聊通过本项目 `pi-side-runtime.mjs` 调公开 SDK：`SessionManager.inMemory`、`createAgentSessionRuntime`、`createAgentSessionServices`、`createAgentSessionFromServices`、`runRpcMode`。它是官方内存会话和官方 RPC 适配器，不是本项目重写 Agent loop，也不是第二个进程打开主 JSONL。

| 文件 | 职责 |
|---|---|
| `server/pi-web-session-extension.ts` | 已加载在主 worker 的内部命令增加同步只读 context snapshot |
| `server/pi-agent-supervisor.js` | 私有快照请求/响应关联、同一 source 并发读取合并、统一 worker 生命周期 |
| `server/pi-side-context.js` | 消息转换、只读工具记录、动态预算、原生内存 session 初始化材料 |
| `server/pi-side-runtime.mjs` | 私有管道接收背景、关闭自动资源发现、调用公开 SDK 与官方 RPC runner |
| `server/pi-side-tools.js` | 单个显式权限扩展、工具集合与本次回复的确认状态 |
| `server/pi-rpc-client.js` | 子进程启动、LF framing、可选的 side seed 私有管道 |
| `server/pi-side-chat.js` | 票据/父连接、模型核对、侧消息范围、独立统计、命令白名单 |
| `public/pi-side-chat.js`、CSS | 独立连接、引用范围/统计、侧聊正文与滚动 |

## 快照获取

通过当前主连接的受管 worker 调用 `captureContext()`，不再另读一次主 session 文件。

1. 验证原 Web 内部扩展及其 context snapshot 能力。
2. 使用已有受随机 token 保护的内部扩展命令读取快照。扩展命令在普通 prompt preflight 之前处理，可在主 Agent 运行时响应；不会调用模型、写消息或等待主任务结束。
3. 同一同步回调中用公开 `buildSessionContext(ctx.sessionManager.getBranch(), leafId)` 取得当前分支的有效上下文，读取 `ctx.getSystemPrompt()`、当前模型、思考等级和时间。
4. 私有 notify 结果在 Supervisor 内截获，未知/迟到的 context 响应也丢弃，不广播给浏览器。公开 prepare 响应只有票据和 metadata，没有完整正文、工具输出或系统提示。
5. 校验源连接仍有效，再签发 60 秒一次性票据。

取的是 Pi 原生有效上下文，不恢复 compaction 已删掉的原文，也不读取工具截断后另存的完整文件。正在生成、尚未进入 SessionManager 的 assistant delta 不在快照中；已记录但没有结果的工具调用保留，并标明结果不在该快照中。

公开 API 的边界：`ctx.getSystemPrompt()` 不包含 `before_provider_request` 的最终 wire payload 改写；原生 SessionManager 上下文也不复刻第三方 `context` hook 的临时改写。侧聊不加载这些扩展来重演逻辑，不能称为完全相同的 provider 请求复制。

## 消息与工具的保留方式

先调用公开 `convertToLlm()`，沿用 Pi 对 compactionSummary、branchSummary、customMessage 和 bashExecution 的转换；`excludeFromContext` 的 shell 消息仍排除。

- 普通用户/assistant 文字保留，带 toolCall 的 assistant 过程文字不再被整条删除。
- 历史 toolCall 转成只读文本记录：id、工具名、完整 arguments、结果是否在快照中。
- toolResult 转成带 toolCallId、工具名、isError 的用户引用记录，保留结果正文及可用图片；孤立结果也保留，不伪造执行成功。
- error/aborted assistant 中已有文字和 errorMessage 作为历史状态保留。
- 思考正文、签名和 provider 专有续传标识不移入新请求；metadata 显示省略的思考块数量。这保留可审阅的任务材料，不宣称转移完整私有 reasoning 状态。
- 图片在当前模型支持 image 时随背景带入；不支持时用占位说明并返回 omittedImages，页面明确显示。
- 工具的 details 私有 metadata 不作为额外背景传输；模型可见的 content 和 arguments 保留。

这样保留工具证据，同时避免把继承的 tool_use/tool_result 当作待执行调用；侧聊自己的新工具调用仍使用原生协议。Chat Completions、Responses、Anthropic Messages 的背景转换保留兼容回归。

## 系统提示、预算与传输

主 runtime 的当前系统提示后追加侧聊规则：继承内容只作背景，主任务由原 Agent 继续；新侧聊只回答边界之后的提问，不继续旧任务或执行旧工具。原生内存历史末尾另追加隐藏的侧聊边界消息。

不自动重新加载项目 AGENTS、Skills、模板、用户扩展或 APPEND_SYSTEM。assist 模式显式加载项目自有权限扩展和上述 builtin 工具；none 兼容模式使用 noTools='all'。资源发现关闭、项目不信任；全局设置只取 compaction/retry/transport/thinkingBudgets 到内存配置，不回写默认设置。需要时 Agent 可通过 read 主动读取项目规则。

- 动态引用预算 = contextWindow - outputReserve。
- outputReserve = min(model.maxTokens（未提供时 16384）, 16384, floor(contextWindow/4))。它是入场检查所留的空间，不修改模型生成默认值。
- 预算使用官方 estimateTokens，包括侧聊边界、系统提示和 assist 模式的原生工具定义（toolTokens）；仍是估算，不是精确 tokenizer 或计费值。
- 超预算明确拒绝，建议压缩主会话，或选择“单独问个问题”并手动粘贴所需文字；没有隐式截断、自动压缩主线程或静默换模型。之后侧聊自身仍由 Pi 原生 compaction 管理。
- 单份快照/初始化数据最大 32 MiB，待领取票据合计最大 64 MiB。超过传输/内存上限时拒绝，不静默删图片或结果。
- 完整 seed 经子进程独立 fd 3 管道传输，不写临时 session 文件、不拼 shell、不放 argv；避免大背景超过系统参数长度限制。
- 新 worker 再核对模型 provider/id、实际窗口与图片能力，不容纳时拒绝并关闭，不发送问题。

引用不会存到工作台偏好、浏览器持久存储或新聊天 JSON 文件。

## 侧聊显示和统计

继承消息已在侧 Pi 的原生内存 SessionManager 中，但不在侧 UI 重播。服务器用官方 `get_entries {since: boundaryId}` 读取边界之后的新消息；这个条目在原生 compaction 后仍存在，因此不依赖易变的数组下标，也不维护第二套侧聊历史。

计费、消息数和 token 总量扣除初始化时的继承基线，避免把主会话已经发生的费用算成侧聊消费。新建侧聊在回合/压缩完成及关闭时，从原生内存条目中选取边界之后的实际用量入持久账本；只保存精简事实和侧聊归属，不保存正文、引用或工具参数，重复回传不再累计。此功能启用前已经结束的侧聊无法补录；账本持续故障直到侧聊内存销毁时，未成功写入的调用可能遗失。上下文容量仍属于侧模型；第一次侧回复前显示未知实际用量，引用区单独显示估算，之后使用侧 runtime 的实际 contextUsage。压缩后未知用量继续显示未知。

## 连接、授权和故障

主 WS 发 prepare_side_chat，独立 WS 发 open_side_chat，二者均复用工作台访问控制/Origin 校验。侧连接独立登记到鉴权服务，登录失效/撤销会关闭失效侧连接。每主连接只能同时准备/创建一段侧聊，全服务最多四个名额（包括准备、票据、后台保留和关闭中）。

新增可选布尔参数 retainOnSwitch=true，仅允许持久主会话。它使已经领取票据的独立侧连接成为侧 runtime 的生命周期依托；主连接释放仍使待领取票据和未完成快照失效，但不销毁已经领取的 retained side。领取后即使还在初始化，也由侧连接负责清理；关闭侧连接始终销毁对应 worker。没有传该参数的旧页面保持原来的父连接清理规则。原主 worker 可以按原空闲规则回收，侧聊不占用它、不重新读取主 JSONL，回来重新打开主线程仍通过 Supervisor。

删除原线程或显式退出原 runtime 调用 releaseSource(cwd, sessionId)，覆盖已脱离父连接的侧聊及仍在准备的票据。清理前发 gateway_side_parent_ended（reason=deleted/quit）；删除时前端同时移除本页相应缓存。服务停止回收全部 SideConnection。不得仅遍历仍活跃的 parent map，否则会漏掉已切走的侧聊。

前端 PiSideChat 管理本页的 cwd/sessionId -> SideThread；各自持有独立连接、请求表、流式消息投影、草稿和滚动控制器。非当前段 DOM 脱离页面，只附着当前线程的 DOM，避免重复 ID 和迟到事件串入。返回不重新 prepare、不再次发送问题；只向已有侧 runtime 读取状态。缓存只在页面内存，不写 localStorage/IndexedDB、工作台偏好或平行历史文件。关闭/注销销毁全部缓存及滚动 observers，未成功建立且没有草稿的空项释放名额。

侧连接允许 prompt、abort、get_state、get_messages、get_session_stats、quit_side_chat，并在 assist 模式允许 answer_side_confirmation。后者只接受本段有效的 requestId 和布尔 confirmed，不能透传任意 extension_ui_response。prompt 只有普通文字，拒绝 images、streamingBehavior 和斜杠命令；原始 bash RPC、工具管理、任意模型管理及会话管理仍不开放；独立模型仅通过 get_side_models/set_side_model/set_side_thinking 专用校验接口选择，Agent 的工具调用由原生工具执行与确认协议处理。

成功确认后只清除仍匹配的输入；明确拒绝保留草稿，超时/断线保留并要求确认，不自动重放。回复只保留复制，不提供自动写入主草稿操作；切线程不会将旧侧结果写入新草稿。

## Provider 配置

标准 API Provider 必须登记在原生 models.json，凭据通过 ModelRuntime.login；侧 SDK 不自动执行用户扩展。仅由 registerProvider 定义或依赖自定义 stream/OAuth/运行 hook 的 Provider 不自动继承，不允许靠恢复全部扩展来绕过限制。

## 兼容 API

新默认 prepare：`{type:'prepare_side_chat', mode:'context', toolMode:'assist'}`；toolMode 可为 none/assist，省略时保留旧客户端的 none。context/quote/blank 均可使用 assist；此时统一走 SDK 内存 runtime。mode 省略时也为 context。另支持 quote/blank。响应 reference 包含消息、工具调用/结果、摘要、图像和省略计数、systemIncluded、estimatedTokens/tokenBudget/outputReserve、capturedAt 与 source 标识；完整模式 preview 为空。

旧客户端仍可明确提交 recent/count=6|12，继续旧正文摘录语义；新页面在 sideChatContext=true 时隐藏这些选项。在旧后端没有该标记时，新页面仍使用旧选项，不误报完整上下文已启用。quote 的 24000 字符及原预算兼容保留。

新连接仍发送 open_side_chat + ticket + token，收到 state/reference/limits/messages/stats 及 retainOnSwitch。只有 /status.sideChatRetention=true 时新页面才提交 retainOnSwitch=true（持久主线程）；缺少标记时使用原生命周期，不假称切线程可恢复。后台不接受重新接管任意侧 runtime 的标识，也不提供刷新恢复票据。新增 `state.toolMode/toolAccess/pendingUi` 与 `gateway_side_tool_access` 事件，仅用于侧执行状态；没有新增主会话管理命令。

`/btw`、选文引用与旧后端摘录模式保持兼容，普通打开不改变已有侧聊背景或草稿。

## 验证与部署

Node 与浏览器入口见[模块导航](development/MODULES.md)，按[开发流程](development/WORKFLOW.md)使用独立身份、真实 SDK/RPC 和本地合成服务。保留中的侧 worker 参与实例空闲检查；需要重启时先结束侧聊或关闭页面。平台和真实供应商结果分别记录。

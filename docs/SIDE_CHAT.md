# BTW / Side Chat

最后核对：2026-09-10。`GET /api/pi/status.sideChat` 表示侧聊可用；`sideChatContext=true` 表示有效上下文快照已启用，`sideChatRetention=true` 表示本页跨线程保留已启用。源码实现不等于生产已重启，以运行中的接口为准。

## 当前行为

- 工具栏图标、右栏侧聊页签和 Web 本地 `/btw [问题]` 打开独立临时侧聊；不把 `/btw` 发给主模型。2026-09-09 移除回复末尾“侧聊此回复”，普通入口不读取页面选中文字，也不会据此切换背景或重开已有侧聊。
- 默认“接着当前任务聊”（mode=context），继承主会话当前有效上下文，包括原生已有压缩/分支摘要、保留的用户/assistant 消息、带工具调用的过程文字、工具参数和结果、错误信息及主 runtime 当前系统提示中的项目约束。
- 不再对默认背景取最近 6/12 条，也不使用固定 8192-token 摘录上限。按模型窗口预留回答空间；装不下明确拒绝，不静默整条丢弃或自动新建背景摘要。
- 背景在准备时冻结；主任务继续独立运行。侧聊支持多轮、停止、复制和追加主输入框。追加保留已有草稿/附件，仍需用户手动发送。
- 另一个主要选项是“单独问个问题”（mode=blank），不携带主会话背景。要讨论一段文字，可自行复制粘贴进侧聊输入框；前端不再提供“所选文本”模式。API 的 quote 仍兼容旧页面。
- 更换背景／重新引用会沿用确认后开始新侧聊的流程，不会每轮同步主后续输出。取消切换保留原范围、记录和草稿；普通入口打开已连接侧聊会继续原对话，不强制改回默认背景。
- 桌面复用详情/侧聊右栏，手机复用抽屉；收起或切换详情页签不结束。sideChatRetention 启用后，持久主线程切走会在本页保留其独立侧聊、草稿、阅读位置和引用设置，回来继续原对话。已提交的侧回复可在后台完成，不混入当前其他线程。
- 本页最多保留 3 段（包含当前段）；达到上限时提示先回原线程结束一段，不能自动清掉旧对话。浏览其他线程不受限制，不会隐式创建侧聊。临时主会话仍随主会话退出而结束。
- 明确结束、刷新/关闭页面、退出登录、侧连接断开会结束相应侧 runtime；当前主连接异常断开会结束当前侧 runtime并保留可复制记录，不自动重连或重发。后台其他有效侧连接保持独立。Web 删除原线程会清理相关侧聊；显式 `/quit` 结束原线程对应的侧 runtime。
- 侧聊没有执行工具、管理模型/树或提交主任务的权限。源工具信息可以作为只读背景，不能成为待执行工具调用。

不提供侧聊持久化、刷新恢复、文件上传、自动合并、后台委派或代码目录隔离。长期任务使用正式分叉线程。

## 面板布局

2026-09-08 右侧详情／侧聊共用可拖拽分栏。桌面从左边界向左拖动扩大右栏，默认 372px，最小 280px、最大 800px，同时按当前左栏和窗口空间为主正文预留至少 360px。键盘左右键按分隔线方向移动，Shift 加大步长，Home/End 到边界，双击恢复默认。宽度保存于本浏览器 `pi.workspace.split:agent-inspector`，窗口缩小只限制显示宽度，恢复空间后还原偏好。

901–1199px 打开右栏会暂藏线程列表，详情与侧聊均与主正文并排；关闭右栏恢复。900px 以下继续遮罩抽屉并隐藏分隔条，回到桌面恢复原宽度。收起、切页签、拖动或切换视口不会重建侧聊、发送消息或清空草稿。

顶部仅保留页签、主任务状态／无工具／结束按钮及引用摘要三行，默认约 120px。移除 RUNTIME 装饰标题，模型信息、引用范围和重新引用按钮统一收入默认折叠的“设置”；展开区域有独立高度上限和滚动。折叠只改变 DOM 展示，不重新抓取背景；点击“重新引用”仍沿用原确认和新侧聊流程。等待主任务确认始终在外层可见并可返回主会话操作。

本轮仅修改静态资源，刷新页面生效，不重启生产服务。布局回归覆盖拖拽、键盘、限宽、双击、手机往返、关闭隐藏分隔条、折叠腾出正文及草稿/连接保持；原侧聊收发、引用更新、复制、停止和断线流程继续验证。

## 上游与会话边界

所有适配在本项目，未修改 Pi package、依赖版本或维护补丁。仍然一个持久 session 文件只由一个 Supervisor worker 管理。

普通主会话、临时主会话继续使用官方 CLI/RPC。新默认侧聊通过本项目 `pi-side-runtime.mjs` 调公开 SDK：`SessionManager.inMemory`、`createAgentSessionRuntime`、`createAgentSessionServices`、`createAgentSessionFromServices`、`runRpcMode`。它是官方内存会话和官方 RPC 适配器，不是本项目重写 Agent loop，也不是第二个进程打开主 JSONL。

| 文件 | 职责 |
|---|---|
| `server/pi-web-session-extension.ts` | 已加载在主 worker 的内部命令增加同步只读 context snapshot |
| `server/pi-agent-supervisor.js` | 私有快照请求/响应关联、同一 source 并发读取合并、统一 worker 生命周期 |
| `server/pi-side-context.js` | 消息转换、只读工具记录、动态预算、原生内存 session 初始化材料 |
| `server/pi-side-runtime.mjs` | 私有管道接收背景、禁用资源/工具、调用公开 SDK 与官方 RPC runner |
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

这样既保留工具证据，也不要求无工具请求携带原始 tool_use/tool_result 协议。Chat Completions、Responses、Anthropic Messages 均有本地 SSE 回归。没有授予 read/bash/edit/write 或其他工具权限。

## 系统提示、预算与传输

主 runtime 的当前系统提示后追加侧聊规则：继承内容只作背景，主任务由原 Agent 继续；新侧聊只回答边界之后的提问，不继续旧任务或执行旧工具。原生内存历史末尾另追加隐藏的侧聊边界消息。

不重新加载项目 AGENTS、Skills、模板、用户扩展或 APPEND_SYSTEM。SDK noTools='all'，资源发现全部关闭，项目不信任；全局设置只取 compaction/retry/transport/thinkingBudgets 到内存配置，不回写默认设置。

- 动态引用预算 = contextWindow - outputReserve。
- outputReserve = min(model.maxTokens（未提供时 16384）, 16384, floor(contextWindow/4))。它是入场检查所留的空间，不修改模型生成默认值。
- 预算使用官方 estimateTokens，包括侧聊边界及系统提示；仍是估算，不是精确 tokenizer 或计费值。
- 超预算明确拒绝，建议压缩主会话，或选择“单独问个问题”并手动粘贴所需文字；没有隐式截断、自动压缩主线程或静默换模型。之后侧聊自身仍由 Pi 原生 compaction 管理。
- 单份快照/初始化数据最大 32 MiB，待领取票据合计最大 64 MiB。超过传输/内存上限时拒绝，不静默删图片或结果。
- 完整 seed 经子进程独立 fd 3 管道传输，不写临时 session 文件、不拼 shell、不放 argv；避免大背景超过系统参数长度限制。
- 新 worker 再核对模型 provider/id、实际窗口与图片能力，不容纳时拒绝并关闭，不发送问题。

引用不会存到工作台偏好、浏览器持久存储或新聊天 JSON 文件。

## 侧聊显示和统计

继承消息已在侧 Pi 的原生内存 SessionManager 中，但不在侧 UI 重播。服务器用官方 `get_entries {since: boundaryId}` 读取边界之后的新消息；这个条目在原生 compaction 后仍存在，因此不依赖易变的数组下标，也不维护第二套侧聊历史。

计费、消息数和 token 总量扣除初始化时的继承基线，避免把主会话已经发生的费用算成侧聊消费。上下文容量仍属于侧模型；第一次侧回复前显示未知实际用量，引用区单独显示估算，之后使用侧 runtime 的实际 contextUsage。压缩后未知用量继续显示未知。

## 连接、授权和故障

主 WS 发 prepare_side_chat，独立 WS 发 open_side_chat，二者均复用工作台访问控制/Origin 校验。侧连接独立登记到鉴权服务，登录失效/撤销会关闭失效侧连接。每主连接只能同时准备/创建一段侧聊，全服务最多四个名额（包括准备、票据、后台保留和关闭中）。

新增可选布尔参数 retainOnSwitch=true，仅允许持久主会话。它使已经领取票据的独立侧连接成为侧 runtime 的生命周期依托；主连接释放仍使待领取票据和未完成快照失效，但不销毁已经领取的 retained side。领取后即使还在初始化，也由侧连接负责清理；关闭侧连接始终销毁对应 worker。没有传该参数的旧页面保持原来的父连接清理规则。原主 worker 可以按原空闲规则回收，侧聊不占用它、不重新读取主 JSONL，回来重新打开主线程仍通过 Supervisor。

删除原线程或显式退出原 runtime 调用 releaseSource(cwd, sessionId)，覆盖已脱离父连接的侧聊及仍在准备的票据。清理前发 gateway_side_parent_ended（reason=deleted/quit）；删除时前端同时移除本页相应缓存。服务停止回收全部 SideConnection。不得仅遍历仍活跃的 parent map，否则会漏掉已切走的侧聊。

前端 PiSideChat 管理本页的 cwd/sessionId -> SideThread；各自持有独立连接、请求表、流式消息投影、草稿和滚动控制器。非当前段 DOM 脱离页面，只附着当前线程的 DOM，避免重复 ID 和迟到事件串入。返回不重新 prepare、不再次发送问题；只向已有侧 runtime 读取状态。缓存只在页面内存，不写 localStorage/IndexedDB、工作台偏好或平行历史文件。关闭/注销销毁全部缓存及滚动 observers，未成功建立且没有草稿的空项释放名额。

侧连接只允许 prompt、abort、get_state、get_messages、get_session_stats、quit_side_chat。prompt 只有普通文字，拒绝 images、streamingBehavior 和斜杠命令；内部读取 get_entries 不意味着开放该命令给侧浏览器。SDK/CLI 存在的其他管理能力不会被透传。

成功确认后只清除仍匹配的输入；明确拒绝保留草稿，超时/断线保留并要求确认，不自动重放。复制/追加仍限定同一个主会话，切线程不会将旧侧结果写入新草稿。

## Provider 配置

标准 API Provider 必须登记在原生 models.json，凭据通过 ModelRuntime.login；侧 SDK 不自动执行用户扩展。仅由 registerProvider 定义或依赖自定义 stream/OAuth/运行 hook 的 Provider 不自动继承，不允许靠恢复全部扩展来绕过限制。

## 兼容 API

新默认 prepare：`{type:'prepare_side_chat', mode:'context'}`；mode 省略时也为 context。另支持 quote/blank。响应 reference 包含消息、工具调用/结果、摘要、图像和省略计数、systemIncluded、estimatedTokens/tokenBudget/outputReserve、capturedAt 与 source 标识；完整模式 preview 为空。

旧客户端仍可明确提交 recent/count=6|12，继续旧正文摘录语义；新页面在 sideChatContext=true 时隐藏这些选项。在旧后端没有该标记时，新页面仍使用旧选项，不误报完整上下文已启用。quote 的 24000 字符及原预算兼容保留。

新连接仍发送 open_side_chat + ticket + token，收到 state/reference/limits/messages/stats 及 retainOnSwitch。只有 /status.sideChatRetention=true 时新页面才提交 retainOnSwitch=true（持久主线程）；缺少标记时使用原生命周期，不假称切线程可恢复。后台不接受重新接管任意侧 runtime 的标识，也不提供刷新恢复票据。后续协议未增加模型执行或管理命令。

2026-09-09 入口收简只涉及静态页面，刷新生效，不重启后端。浏览器回归确认回复按钮移除、带选中文字时的 `/btw`/工具栏入口仍按所选背景准备、已有侧聊/草稿不被选择文字打断、显式 blank 切换和取消、手动粘贴提问、旧后端摘录兼容。

## 验证与部署

跨线程保留测试：新增 Node 验证主连接切走后继续回答、返回仍只有一个主 worker、主 JSONL 不变、显式退出/删除回收、已领取初始化保留、待领取票据失效与全局名额。浏览器六视口和旧后端兼容验证 A/B 独立、后台完成、草稿/阅读位置/冻结引用恢复、3 段上限、不自动删除、明确结束释放名额、启动迟到和关闭页面回收。

新生命周期需要运行实例支持sideChatRetention。保留中的侧worker也占空闲部署检查的runtime名额，需结束侧聊或关页后才可重启。

```bash
npm test
npm run check
npm audit --omit=dev
PLAYWRIGHT_MODULE=/path/to/playwright PI_SIDE_TEST_URL=http://127.0.0.1:3104 node test/browser/pi-side-chat.cjs
npm run pack:trial
```

新增测试覆盖超过 12 条/8192 tokens/argv 大小的背景、工具混合文字与完整结果、旧摘要/分支摘要、错误、隐藏思考/不支持图片、预算明确拒绝、原消息不变。真实官方 SDK/RPC + 本地 SSE 验证无工具、三个标准协议、私有管道、界面不重播父历史、费用基线与压缩后边界。

原侧聊集成改为在持久主任务运行中及临时主会话创建完整快照，验证系统提示继承、主文件不改、私有控制响应不广播、项目资源不重新加载、独立停止和连接清理。浏览器覆盖六视口/三主题、新默认范围/统计/更新、原复制/追加/停止/断线流程及旧后端降级。

更新须在实例空闲时进行；参考安装与恢复指南。

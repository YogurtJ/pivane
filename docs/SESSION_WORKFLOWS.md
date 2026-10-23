# Pi Session Workflows

实现日期：2026-09-07。只作用于 Pi Agent，媒体业务、参数和历史不变。生产后端是否已启用以 `/api/pi/status.sessionWorkflows === true` 为准；没有该标志时前端隐藏新入口。

## 已实现

- 一次性延迟普通消息：分钟数或浏览器本地日期时间；服务端按 Unix 毫秒时间投递。周期任务另见[定时任务](SCHEDULED_TASKS.md)。
- 待发送列表：编辑正文/附件/时间、暂停、立即发送、取消；投递结果不明时需要勾选确认才允许再次发送。
- 复制当前完整活动分支为独立线程；从历史用户问题之前分叉并回填该问题、图片与办公文档引用。只复制选中分支，原线程其他分支的旧版本入口不在新线程提供恢复。
- 每个用户问题段只在最终回复末尾显示复制/分叉，过程回复不生成操作行；当前运行尾段等待 agent_settled 后恢复最终按钮，工具结果之后没有最终文字时不把更早的过程说明当成最终回复。分叉位置精确包含该回复但不包含后续对话；有待执行 toolCall 的过程消息不可作为分叉点。问题头显示原生发问时间（浏览器本地时区）、复制问题和最近一条的编辑重试。此展示限制不改变后台回复候选、fork REST 或 `/copy` 的既有契约。
- 最近一条用户问题的编辑重试：确认发送时才回退，取消编辑不改变上下文。最后只保存了问题、尚无回复的空闲线程也会在替换前移除旧问题的上下文贡献；恢复该旧版本时保留原问题。
- 回退形成的旧版本可从右侧“历史” → 更多（⋯） → “恢复旧版本”恢复，不删除原始记录，不生成被放弃问答的摘要。
- 当前会话待发送数量及侧栏标记；过期、暂停、失败、不确定状态进入“需关注”筛选。
- 原线程未发送草稿在当前页面内存按线程保留，分叉草稿不覆盖原草稿；刷新页面不恢复未预约的草稿。
- 附件窗口与主框共用 `public/pi-attachments.js`：回形针/真实文件粘贴/拖放、PNG/JPEG/WebP/GIF 签名、UTF-8/二进制检查、单图 6 MiB/单文本 1 MiB 与 payload 总量校验。关闭/重开 editor 后不接受旧读取结果，读取中禁止确认，坏文件合并提示且保留同批有效项。已并入正文的文本附件仍在 textarea 中编辑，不新增原件存储。
- 主稿读取/提交中不能打开新预约；主稿上次投递不确定时，预约前先明确确认已核对会话，避免把未知是否已送达的内容再次预约。仅页面内存保护，不改变服务端预约状态机。

以上只支持持久会话。临时 `--no-session` 仍然断开即销毁，不提供预约、分叉或回退入口。

打开历史、待发送列表或消息详情时，面板立即显示加载提示；读取期间可关闭，关闭后不会被迟到结果重新打开。确认分叉、复制线程、回退重试、恢复版本、预约/修改预约、立即发送/取消时，按钮显示加载图标及当前动作文字，相关输入、关闭和重复提交暂时禁用。暂停预约也提供等待提示与防重复点击。请求失败会保留编辑内容并显示错误；请求超时继续提示先核对实际结果，不能据此认为操作已取消。操作已成功但列表未刷新时，会单独提示刷新查看。

## 网页入口（2026-09-10）

会话详情仅保留运行状态、上下文占用、累计用量与折叠的运行设置／会话信息／资源／扩展状态。压缩按钮和压缩进度保持直接可见；上下文用量与累计输入／输出分开标注。

- 左侧线程菜单与中间连接状态栏的“当前线程操作”（⋯）共用复制为新线程、重命名、删除等操作。打开当前线程的菜单与窗口不重新连接该线程。`/clone` 复制当前活动分支，`/new` 创建空线程，两者不同。
- 历史页在“搜索／会话树”同排右侧提供更多（⋯），只有“从历史问题分叉”“恢复旧版本”两项；点击才读取工作流并打开原窗口，浏览历史或展开菜单不预取工作流。菜单为浮层，不改变列表或正文高度，支持键盘、Escape、外部点击及切页／切线程关闭。
- 历史功能尚未启用的旧后端，当前线程菜单保留这两项兼容入口；没有 sessionWorkflows 时隐藏。临时会话不提供持久操作。
- 待发送消息从输入框上方状态行的“N 条待发送 · 最近时间”标签查看，与子任务、进度标签同行靠右；预约、修改或取消后立即更新，需关注时变为提醒色。线程菜单不再重复提供入口；侧栏的待发送数量与需关注提示保留，主框加号仍用于新增延迟发送。手机从输入框点按该入口时，聚焦摘要在点击完成后再收起，避免首次点击因按钮移动而丢失。正文区域的独立滚动不会关闭位置未变化的线程菜单。

纯静态更新，刷新页面生效。分叉位置、空闲互斥、确认和草稿保护仍按下文执行。

## 线程切换、删除与原文预览

初次进入或刷新后的自动连接可以被切线程取消。旧连接的取消与迟到结果不会覆盖新线程，也不作为 “Session changed” 错误提示；实际连接失败仍正常反馈。

删除线程时，确认弹窗显示名称及删除后果。执行期间按钮显示“正在删除”，暂时禁止重复提交和关闭；完成后窗口保留真实结果（移入回收站、永久删除，旧后端缺少标记时仅显示已删除），点击“完成”关闭。删除失败或等待结果不明时保留窗口，提示先核对列表，不自动重发删除请求。成功删除当前线程后清空其草稿、附件、选中状态和地址中的线程标识，普通及助手线程列表同步移除；项目文件和已独立保存到[成果库](ARTIFACTS.md)的文件保留。待保存的分支交付请先保存；删除线程不执行成果清理，成果回收站也不删除来源线程。

服务端在删除期间阻止新 worker 启动，已有 worker 停止后完成用量保留检查再删除文件。未打开的线程不需要启动 Pi。其他已打开此线程的页面会在确认删除后退出，删除失败可重新连接。

明确删除原生会话成功后才清理其持久排队意图；附带清理失败会返回独立警告，不能冒充原生删除失败或自动重试删除。办公原件保留，可通过[附件用量与清理](COMPOSER_TOOLS.md#附件用量与清理)另行确认处理。

分叉确认将原文放在带标签、背景和边框的独立区域：回复后分叉标明“原回复 · 分叉将保留到此处”，从历史问题分叉标明“原问题 · 将填入新线程草稿”。回复按钮使用页面中的完整原文，保留原始文字格式；长文在预览区域内部滚动。

带图消息收到原生回传后，按图片格式和内容替换对应的临时消息，不依赖对象字段排列顺序；重复事件不会再次添加同一条记录，用户主动发送的第二条相同消息仍保留。

后端支持创建回执时，复制／分叉的一次确认使用固定请求编号。响应丢失后按钮变为“查看创建结果”；关闭面板或刷新同一标签页后，再打开创建入口会先找回上次结果。已成功的请求打开原线程，服务器未收到的请求继续使用原编号；正在执行的请求等待结果，进程中断后的不确定请求不会再次创建。核对线程列表后，可点击“已核对线程列表，结束这次创建”，再开始一次新的操作。浏览器仅保存请求编号和选择位置，不保存问题或附件正文；禁用浏览器存储时只能在当前页面找回。旧后端保留原创建行为。

## 移动线程到其他项目

当前源码提供线程菜单的“移动到项目…”。服务端返回 `sessionMoves=true` 时显示入口。默认列表只显示当前未从列表移除且有会话的其他项目；零会话或已移出项目不列出，仍可选“其他项目路径…”填写允许范围内的服务器绝对路径（移动到已移出项目成功后自动恢复其侧栏可见性，回滚时保持原隐藏状态）。先“检查并预览”，通过后“确认移动”。普通 HTTP 地址也支持确认提交，请求标识使用 Web Crypto 随机字节生成。确认期间禁用输入、重复提交和关闭；断线或响应不明时先核对两边列表，不自动重试。

移动保留原生会话 ID、创建时间、文件名、完整历史树、活动位置、书签、压缩和模型记录，只改 header cwd 并移动原生文件。源项目中的项目文件不随线程移动，历史正文、工具参数与旧路径保留原文；后续运行从目标目录加载项目资源和指令。归档状态（包括原先随来源项目归档的状态）、完成提醒以及本线程和已入账侧聊的用量转到目标项目；总用量不重复入账。原生分支内的历史交付继续按移动证据和原会话 ID 校验，包括原生分叉继承的交付；旧项目只授权离开该项目之前已保存的交付引用，移动后新追加的旧项目引用不获得资格。证明的前缀哈希计算累计上限 256 MiB，超过预算会拒绝读取；核验只读取已绑定前缀和所需元数据，不再以当前文件总长限制合法续写。移动创建仍保持下文的 64 MiB 上限。快照字节与清单不改写。

已打开此线程的页面会收到移动事件，保留本页已读取草稿／附件并重新连接同一 ID 的目标线程；用户已切到其他线程时不抢回页面。旧地址通过经过校验的“旧 cwd + ID”移动记录定位目标，不使用 ID 的全局猜测。目标仍须通过 realpath、允许根与原生文件证明；旧目录删除后，仅已有提交记录的允许根内旧地址可以解析。

先移动线程、再通过网页复制或分叉时，新线程继承选中分支中已经验证的历史交付资格，可以继续预览、下载并在成果中心读取。嵌套分叉、删除父线程、服务重建和再次移动均保留这些资格；移动后新追加的外项目引用不会因此获得授权。原交付快照与清单保持不变。

首版仅支持同一身份、同一文件系统内、不超过 64 MiB 的完整原生 v3 持久会话。正在运行、标题生成、后台子 Agent、侧聊、尚未处理的预约、持久队列恢复内容、定时任务或主对话引用，以及助手档案／逻辑项目／扩展助手绑定会阻止移动。任务线程、任务回执、线程间消息关系和被其他线程的 header 引用为父会话的线程暂不支持单独移动，预览会列出原因。引用检查最多 10000 个 JSONL，通过 256 KiB 分块校验 JSON，只保留父会话和任务／消息关系所需字段，不累积正文；其他历史会话超过 64 MiB 不会因此阻止普通线程移动。原始扫描最多 1 GiB，投影元数据累计最多 256 MiB，每条所需元数据最多 1 MiB，JSON 嵌套最多 256 层。保留字段顺序、重复键和 data/details 回退的原生语义，核对描述符路径、完整身份及前后变化；超限或变化时明确拒绝，不能把未检查范围当成没有引用。此入口不改变逻辑助手项目分类。

原始字节和移动日志保存在私有 `<agentDir>/pivane-session-moves/`，位于原生 sessions 发现范围之外。每个请求有稳定 requestId 和来源字节修订；成功重查只返回现有结果，进入发布阶段的失败／未知请求不再次执行。可处理异常时恢复源文件、用量和偏好，并保留独立原始备份。进程中断或自动恢复失败后，来源和目标都拒绝打开／修改，需维护者结合 `records.json`、原始备份、两处文件及用量／偏好核对恢复；启动不自动重放迁移。日志最多保留 1000 次尝试，未提供自动清理接口。移动计入维护忙碌和统一停机等待，不需要停止整个服务；独立 CLI 不能同时写入同一会话。

## 自动标题与重新生成

新后端以 `/status.auxiliaryModels=true` 提供统一[辅助模型](AUXILIARY_MODELS.md)卡片，标题模型与自动命名开关分别位于标题行和该行齿轮选项。已有设置直接沿用，下面的专用标题 API 继续兼容；缺少统一能力时保留原独立卡片。

运行中 `/status.sessionTitles=true` 表示已启用标题接口；旧后端隐藏菜单/设置入口。`sessionTitleModels=true` 另标记可独立选择标题模型，只有旧开关能力时保留开关并隐藏模型选择。实例偏好 `pivane-workspace.json.sessionTitles`（既有 `pi5-workspace.json` 自动沿用） 保存 `enabled`（默认 true）、`provider/modelId`（默认均为空，跟随线程）与递增 `revision`，保留其他字段。专用模型供全部线程的自动/手动命名使用，与媒体规划及聊天默认值独立。配置保存不停止任务或供应商请求；关闭或更改设置后不应用尚在生成的自动结果，手动建议仍报告实际使用的冻结模型。

只有在功能开启时通过 POST `/sessions` 新建的未命名持久线程写入 `pivane-web-title` 原生 custom metadata（兼容旧 `pi5-web-title`）。自动命名等待成功最终回复及 `agent_settled`，跳过无标记的旧历史、有名称的线程和临时会话。标记绑定原生 session ID，复制/导入的标记不能使新身份自动命名。用户手动命名后即受保护，后续轮次不自动更新标题。

私有桥接同步读取当前原生分支，摘取最近最多 6 条问题/完整终态回答，每条最多 2000 字符，总计 8000 字符。不包含工具调用/结果、思考、图片、Shell、系统提示或被放弃分支。常见寒暄不请求模型；模型判断尚无具体话题时可等待新正文再尝试，最多 3 次。明确失败、超时、无效输出或结果过期不自动重放，仍可由用户主动重新生成。

生成使用独立 `ModelRuntime.completeSimple` 请求，请求开始时冻结标题模型设置；指定专用 provider/modelId 时仅使用该模型，未指定才跟随线程的 provider/model。最低支持的思考等级、最多 1024 输出 tokens、无工具/资源加载、无 SDK 自动重试保持不变。保存专用模型前通过公开 ModelRuntime 检查目录、文本输入与可用认证，排除 batch 模型；不生成测试请求。配置被移除、认证失效、请求失败或保存引用损坏时不能自动回退到线程模型。

模型可见摘录只在请求内存中存在，生成的标题通过 `pi.setSessionName` 保存为原生 `session_info`；自动尝试状态在请求前写入 custom entry，不进入主模型上下文。没有新聊天日志或标题数据库。手动成功建议额外返回 `model:{provider,id,name}` 与 `usage:{input,output,cacheRead,cacheWrite,totalTokens}`；用量只允许非负安全整数，缺失/无效值为 null，无任何有效字段时整个 usage 为 null，不透传供应商额外字段。页面只显示本次结果，不写累计用量日志，此额外用量不在原生持久会话统计中。仅由扩展注册或依赖运行时请求钩子的模型不能保证可用。

同线程一次、全服务最多 2 个生成请求，不排队批量执行；45 秒发出中止信号，底层未结束前仍占名额，不把超时当取消完成。标题请求不预占主聊天的 prompt 通道；原生元数据读取/条件写入在同步桥接中执行，提交前检查运行/导航状态。关页不影响已经触发的自动生成；worker 退出、删除和服务停机会中止相关请求。运维检查 `/activity.titleGenerations`，线程摘要另含 `titleGenerating`，生成期间不能空闲回收该 worker。

手动“重新生成标题”先生成建议，不修改历史；窗口可编辑并显式保存，取消无写入。当前名称或首条消息显示在有来源标签的独立预览卡片中，长文本在卡片内部滚动；生成说明、标题输入和状态反馈分区显示，错误有独立样式。底部重新生成与保存按钮等高对齐，窄屏仍保留可见操作区。保存校验最新 `session_info` 的 entry ID 与当前分支正文/导航修订，即使名称改回原值也不能接受旧建议。自动结果同样受名称/上下文修订及尝试 ID 保护。窗口关闭或切线程后丢弃迟到建议，不改其他线程或主草稿。

| Method | Path（前缀 `/api/pi`） | 契约 |
|---|---|---|
| GET | `/settings/session-titles` | 返回 `{enabled,provider,modelId,revision}`；默认 `true,"","",0` |
| PUT | `/settings/session-titles` | 可提交 `enabled` 和／或成对的 `provider,modelId`，推荐携带 `expectedRevision`；双空字符串恢复跟随线程 |
| POST | `/sessions/:id/title` | `{cwd}`，空闲时生成建议；返回 `{name,nameRevision,contextRevision,model,usage}`，不保存 |
| PUT | `/sessions/:id/title` | `{cwd,name,nameRevision,contextRevision}`，保存编辑后的建议；修订冲突 409 |

设置写入只允许表中字段，至少提交开关或模型引用；引用必须同时为空或均为有效字符串。旧客户端仅提交 `enabled` 时保留现有专用模型；省略 `expectedRevision` 时采用请求进入时的当前版本，仍在异步校验后重新比较。版本过期返回 409，所有保存递增 revision；校验期间另一页面更改开关会使旧模型保存冲突。选择控件保留未保存草稿和已移除模型，不静默换成首个可用选项。仅一个专用模型保存校验可同时进行，`/activity.nativeSettingsBusy` 包含此活动，服务停机等待它完成且禁止迟到保存。

上述接口均复用工作台身份、Origin、项目 realpath/根范围和 session ID 检查，不接受文件路径。建议请求失败 HTTP 400，不回显供应商原始响应。标题按问题语言生成，中文建议 10～20 字，模型输出最多 80 个字符；手动编辑最多 120 个 UTF-16 单元，拒绝控制字符/多行。只接受 JSON 标题结果，不将模型 HTML 注入 DOM。

成功自动命名、建议保存及网页重命名广播 `gateway_session_named {cwd,sessionId,name}`；全局 `/activity.titleRevision` 是进程随机代次与计数，供其他浏览器刷新已加载列表，不保存标题正文。私有 `pi5Title` 和资格通知在 Supervisor 截获，包括迟到/未知响应，不广播摘录。直接在外部 CLI 写同一活动文件仍不受支持。

## 不提供

- 文件、Git、数据库、远端请求、部署、生成媒体等工具副作用的撤销。
- worktree、目录复制或 A/B 代码环境隔离。新旧线程仍共享项目目录。
- 任意会话树编辑器。历史问题可以分叉，原地编辑重试只开放最近一条。
- 此处不提供周期调度、跨服务队列、自动补发过期消息或自动重发不确定消息；周期任务使用独立的[定时任务](SCHEDULED_TASKS.md)入口。
- 延迟或编辑重试斜杠命令。普通消息支持文本、图片与[办公文档引用](COMPOSER_TOOLS.md#上传办公文档与-pdf)，文本附件并入正文。

## 文件与所有权

| 文件 | 作用 |
|---|---|
| `server/pi-message-payload.js` | 新操作的普通消息、图片校验与分支遍历 |
| `server/pi-session-workflows.js` | 受保护的分叉、重试、恢复和预约 REST 接口 |
| `server/pi-deferred-messages.js` | 一次性持久待发送队列与投递状态 |
| `server/pi-web-session-extension.ts` | 仅 Web RPC worker 显式加载的原生树导航命令桥接 |
| `server/pi-agent-supervisor.js` | 会话互斥、runtime 生命周期和桥接结果 |
| `server/pi-session-store.js` | 官方 SessionManager 分支提取和空分叉落盘 |
| `server/pi-session-fork-access.js` | 分叉文件资格的不可变证明、身份与前缀核验、交付继承和草稿下载资格 |
| `server/pi-session-prefix-proof.js` | 有界的原生 header／标记、前缀哈希与投影读取，保留描述符身份和变化检查 |
| `server/pi-session-fork-requests.js` | 创建请求的私有回执、并发去重与原结果查询，不复制会话正文 |
| `server/pi-session-navigation.js` | 同一个受管原生 manager 的位置标记，区分编辑前回退与精确恢复 |
| `public/pi-session-workflows.js` | 模态编辑、历史列表、待发送列表和消息操作 |

Pi JSONL 仍是唯一聊天历史。队列只保存尚待确认/投递的消息，接受投递或取消后删除 payload，仅保留最多 100 条终态 metadata。工作台偏好不存这些正文。

未设置 `PORT` 时使用新默认端口 11408，队列为 `~/.pi/agent/pivane-deferred-messages-11408.json`。显式配置端口 3001 的实例继续使用 `~/.pi/agent/pivane-deferred-messages.json`，既有同位置的 `pi5-deferred-messages.json` 自动沿用；其他显式端口追加 `-<port>` 后缀。此前未设置 `PORT` 的旧版安装如需保留 3000 地址及 `-3000` 队列，应在升级前设置 `PORT=3000`；不会自动迁移旧队列。`PI_CODING_AGENT_DIR` 仍决定 Agent 数据根，`PI_WEB_DEFERRED_FILE` 可显式覆盖。一个队列文件只能由一个服务进程管理，不可让两个实例共享该文件或同一正在写入的 Pi session。

队列写入同目录 0600 临时文件，fsync、rename，再 fsync 目录；目录创建权限 0700。最多 50 条非终态消息，完整队列最多 64 MiB。单消息最多 400000 字符、6 张 PNG/JPEG/WebP/GIF、24 MiB base64；浏览器单图 6 MiB、文本附件 1 MiB。预约时间限未来一年。

## 延迟投递

状态：`scheduled -> waiting | dispatching -> sent | failed | uncertain`，并支持 `paused`、`expired`、`cancelled`。

- 每秒检查到期消息，不依赖浏览器或 WebSocket 订阅。
- 到期重新 realpath/根范围检查并解析 cwd/sessionId，通过 Supervisor 获取唯一 worker。
- 正在运行、压缩、重试、等待确认或队列未清空时继续等待，不 steer、不自动 abort。
- 空闲锁内重新校验消息与实际模型的图片输入能力；使用发送时的线程上下文和当前 runtime 模型，不冻结预约时的模型或上下文。
- 先持久化 `dispatching`，再调用原生 `prompt`。原生接受后标记 `sent`，这表示已投递，不表示模型任务成功完成。
- 明确的原生拒绝记 `failed`；超时/断开等不能确认接受与否的错误记 `uncertain`。二者都不自动重发。只有 `scheduled` / `waiting` 可暂停；不确定消息不能通过暂停清除其确认要求，修改并预约或立即发送仍须 `confirmUncertain=true`。
- 重启时过期的 scheduled/waiting 改为 expired，dispatching 改为 uncertain；未来 scheduled 保留。队列损坏时停止投递并在 activity/UI 报错，不覆盖坏文件。
- 编辑重试和恢复旧版本之前暂停该线程的未投递预约；原生扩展取消回退时也保持暂停，需用户重新确认。
- `/quit` 暂停该线程预约；单纯关网页或切换线程不暂停。
- 删除会话在 Supervisor 的会话删除互斥区内取消预约并移除 payload，之后停止 worker、完成用量保留检查、执行既有 trash/unlink；整个过程阻止新 worker 启动，失败释放互斥。
- 创建请求使用 UUID 防止重试创建重复任务；UUID 内容不一致时拒绝。修改必须携带 revision，防止多设备覆盖。

不承诺跨 Pi RPC 与文件系统的 exactly-once 事务。选择保守的不确定状态，避免不知情地重复执行工具副作用。

## 分叉与回退

分叉在 source worker 空闲互斥区内读取最新 entries/leaf，使用单独的官方 `SessionManager.open(...).createBranchedSession(...)` 提取选定路径。原 worker 不切换 session，不改变原文件，其他客户端不被带到新线程。新分支保留官方 parentSession；目标之前尚无 assistant 时，仍由原生分支提取保留 entry ID、时间、上下文编辑和压缩引用，再将公开原生 JSONL 导出写入私有临时目录，以不覆盖目标的硬链接发布，立即可见；保存 `pivane-web-fork-origin` metadata。真正空分支沿用立即创建空 header 的流程。

这是 SessionManager 层提取，不会触发原 runtime 的 `session_before_fork/session_shutdown` 钩子，也不执行扩展的代码检查点恢复。它不是直接放开会改变 worker 归属的原生 fork/clone RPC。

回退或会话树导航记录会随选中分支保留，但其中引用的旧 leaf 可能属于未复制的其他分支。工作流只列出当前会话文件中确实存在的旧版本；缺失目标的继承记录不阻止打开面板、再次分叉或编辑重试，也不因此修改原生历史。原线程仍保留其完整旧分支。

从带办公文档的问题之前分叉时，原问题与图片、办公文档一并恢复为新草稿的文字和附件卡，可以在发送前下载或移除文档，不重新上传或复制原件。分叉只授予所选问题中文档的草稿下载资格；发送前文档不会出现在分支文档列表，Agent 的 read_document 仍不能读取。用户发送并保存引用后按正常分支资格读取。原线程未发送草稿与附件保留。

上述文件资格由服务器在创建新分叉时登记：私有 `<agentDir>/pivane-session-moves/forks/` 保存不可变的精确引用与原生文件前缀证明，原生 `pivane-fork-access` 记录只保存目标会话 ID 和证明修订。证明绑定新线程身份、创建时间及原位置，再次移动须有已提交的移动证据；不依赖父线程持续存在，也不把同项目、parentSession 或任意文档 ID 当作授权。最多 500 个不同交付引用、5 份草稿文档，交付来源以通过修订校验的原清单为准，多次移动产生的重复来源资格只登记实际来源；单份证明 512 KiB；旧 v1 的初始前缀最多 64 MiB，新 v2 最多 1 GiB。核验按不超过 256 KiB 的分块只读取已绑定前缀及准确标记，后续合法追加不再因文件总长超过 64 MiB 失效；核验期间文件变化、身份不符或超预算仍拒绝。原生 header／标记最多 1 MiB，投影元数据单条 1 MiB、累计 64 MiB，树 ID 最多 1000000 个、嵌套最多 256 层。部分文档、交付和历史消费者仍有独立的 128 MiB 读取预算，原生 SDK 也可能整体载入历史；这不表示所有长会话操作都已无限制。证明随身份目录备份，单独导入 JSONL 不获得新 ID 的资格。旧分叉没有这份证明时不自动扩展权限，可从仍能读取原件的来源线程重新分叉。

原地回退由受管 SDK 边界 `pi-session-navigation` 区分编辑定位与精确恢复：编辑到用户问题之前；恢复到旧 leaf 的完整上下文，包括未答复问题及扩展消息。必要时通过同一个原生 SessionManager 追加 `pivane-web-navigation-anchor` 中性位置标记，使原生 `ctx.navigateTree(..., { summarize: false })` 不会对当前用户 leaf 提前返回，也不会把恢复误当成编辑。旧版本没有标记时按需追加，原始消息不变；原生取消钩子仍生效，取消时模型上下文保持原位。随后用 `pi.appendEntry('pivane-web-navigation', ...)` 记录原 leaf、目标 entry 和 retry/restore 模式。这些 custom entry 不进入 LLM 上下文，同时持久化活动位置；无摘要，不删 JSONL 记录。

Web worker 使用 `-e server/pi-web-session-extension.ts` 显式加载桥接。`pivane-web-navigate` 及旧兼容名称从 command catalog 隐藏，gateway 拒绝浏览器直接提交该命令；worker 通过一次性关联 ID 和进程内随机 token 调用，`ui.notify` 中的结构化结果仅在 worker 内消费，不进入浏览器通知或 session。它没有 LLM 可调用工具，也不修改全局 Packages 或上游 Pi package。

操作必须提供 `expectedLeafId`。互斥在 await 前预占，检查 prompt preflight、活动状态、压缩和原生待处理队列；其他修改请求拒绝，只读请求可继续。导航超时会关闭对应 worker 后重连，不放任可能仍在执行的导航与新 prompt 并发。

重试先验证新消息/模型，再回退，再发送。若发送被拒绝或断线，旧分支仍可恢复，编辑器保留新提示词；不能把失败理解为已自动恢复原上下文。`gateway_context_changed` 通知该 session 的所有订阅页面重读状态，迟到结果仍按已有 generation/revision 规则隔离。

## REST 契约

以下均为 `/api/pi` 下接口，复用 token、Origin、realpath/项目根和 session ID 查找，不接受任意 sessionPath。GET 必须带 cwd query，写入必须带 cwd body。

| Method | Path | Body/响应要点 |
|---|---|---|
| GET | `/sessions/:id/workflow` | leafId、lastUserId、历史问题/已完成回复(replies)预览、可恢复旧版本 |
| GET | `/sessions/:id/prompt/:entryId` | message、images、leafId；恢复原生用户内容 |
| POST | `/sessions/:id/fork` | expectedLeafId、可选 entryId/position/requestId；默认 before，at 仅用于完成回复；返回 session 与 draft/null，使用 requestId 时可找回原结果 |
| GET | `/sessions/:id/forks/:requestId` | 查询创建状态；completed 含原 result，不启动 worker，不创建线程 |
| POST | `/sessions/:id/retry` | expectedLeafId、最近问题 entryId、message、images；返回 accepted |
| POST | `/sessions/:id/restore` | expectedLeafId、旧版本 entryId；返回 restored |
| GET | `/sessions/:id/deferred` | `{revision,jobs}`；jobs 为预览与状态，`detail=true` 包含尚未移除的 payload |
| POST | `/sessions/:id/deferred` | id(UUID)、dueAt(Unix ms)、message、images |
| PATCH | `/sessions/:id/deferred/:jobId` | revision、action(save/send/pause/cancel)；pause 仅限 scheduled/waiting；save 另需 dueAt/message/images；uncertain 重发需 confirmUncertain=true |

`position=at` 必须提供完成的文本 assistant entryId，不能选择 user、toolResult、带 toolCall、pending/error/aborted 等记录；缺少原生 stopReason 的旧文本回复仍兼容。候选集和执行校验复用相同规则。位置在压缩之前时会重建该位置的原生上下文，不带入之后的压缩摘要或问答。源文件、worker 和其他订阅者不变，分叉正文不会预填为下一条用户问题。

`sessionForkRequests=true` 时可传 `requestId`（16–80 位字母、数字或连字符）。编号绑定来源 cwd、会话 ID／原生创建时间和完整选择参数指纹。同编号同参数的并发请求共用一次创建，已完成请求返回原结果，不要求来源仍位于原 leaf；同编号不同参数返回 409 `FORK_REQUEST_CONFLICT`。状态查询返回 `not_found`、`pending`、`completed`（含 `result:{session,draft,requestId}`）、`failed`（未进入创建）、`uncertain` 或 `unavailable`（原结果已删除／无法读取）。除 `not_found` 外不重建；失败／不确定编号再次 POST 返回 409 `FORK_REQUEST_UNCERTAIN`，已完成但结果不可用返回 `FORK_RESULT_UNAVAILABLE`。请求格式无效返回 400。未传编号的旧客户端保持一次调用创建一次的兼容行为。

回执存于私有 `<agentDir>/pivane-session-moves/fork-requests/`，每份最多 64 KiB，与会话和文件证明一并备份；创建前独占保存 pending，完成后原子保存目标原生身份。重建服务时没有活动所有者的 pending 视为 uncertain，不自动补建。回执不保存聊天／图片正文，分叉草稿按原生问题 ID 重读来源；来源会话必须仍可访问。原结果经已提交移动链解析，已删除的结果不会因查询而复活。回执没有自动过期清理。

只读 workflow/prompt 会启动当前线程的受管 worker，以 runtime 的活动位置为准；待发送列表和 activity 不会启动 worker。工作流快照在一次请求内复用节点索引和祖先解析，避免按旧版本数量反复遍历长分支，不跨修订缓存。大历史问题预览不含工具输出/图片 base64，但单问题详情会包含其图片；当前内部 RPC 仍读取完整 entries。

`GET /status` 增加 sessionWorkflows=true；回复后分叉另以 replyFork=true 标记。`GET /activity` 增加 deferred.sessions 的 cwd/sessionId/count/attention，仅 metadata；队列异常时包含通用 error。`deferred.revision` 与详情响应的 `revision` 是整个队列的不透明修订：进程启动和成功保存队列变更时更新，不持久化、不含正文；不能用于修改任务，修改仍使用各 job 的整数 revision。网页仅在已成功读取的详情修订与当前摘要相同、且仍属于同一线程和连接代次时跳过轮询详情；主动打开列表、操作后刷新和重连继续读取，无该字段的旧服务沿用原刷新。`get_state` 增加 webOperation 布尔值。新增自定义广播只有 gateway_context_changed 和关闭连接用的内部 gateway_reconnect；不开放 fork/clone/navigateTree 的任意透传。

## 验证与部署

测试入口见 [模块导航](development/MODULES.md)，执行范围见 [验证矩阵](development/WORKFLOW.md#验证矩阵)。工作流与待发送队列由隔离 Node/RPC 用例覆盖；浏览器工作流和消息操作专项需另行执行，不包含在 `npm test` 中。

运行外部 URL 型浏览器专项前，按 [隔离要求](development/WORKFLOW.md#浏览器与重型专项) 分开身份、媒体、项目与预约队列路径，并显式传入脚本支持的测试 URL。尤其要固定独立的 `PI_WEB_DEFERRED_FILE`，避免操作生产预约；只换端口和队列路径仍不足以隔离身份。

后端更新须在实例空闲时进行，按实际 status 核对能力；不能中断当前工作会话。

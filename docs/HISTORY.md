# 历史搜索与原生书签

原生上下文编辑只影响后续模型请求；历史搜索和预览保留原文，压缩前的问答可在正文上方回看（见下文），也可从历史面板查询。`context_edit` 和 `usage` 不作为聊天节点，恢复分支时按 Pi 原生规则恢复上下文。

侧栏“搜正文”跨线程只读搜索用户／助手文字，打开结果仅预览、不导航或发送。当前线程的搜索和书签仍通过唯一 worker；范围和预算见[跨线程搜索](NATIVE_COMPLETION.md#跨线程正文搜索)。

当前线程历史查询需要运行实例的 `/api/pi/status.historySearch=true`。

## 压缩前问答回看（2026-10-11）

上下文压缩后，Pi 只把摘要和最近的消息发给模型，较早的问答仍完整保存在原生会话文件中。主聊天区在“上下文已压缩”标记上方显示这些压缩前的问答，标题为“压缩前的 N 个问题 · 仅供回看，模型不会再读取这些原文”，和 Codex 的长对话一样可以一直向上翻看。

- **只读、不进入模型上下文**：压缩机制保持 Pi 原生行为不变。回看区只读取原生 SessionManager 的当前分支，不追加 entry、不建索引或缓存、不保存第二份历史；后续请求仍只携带压缩摘要和保留的消息。回看区的问题和回复可复制，问题可加书签；不提供编辑重发、重新生成或分叉，需要从旧问题继续时用历史页的会话树。
- **按需分段读取**：打开线程时只读取一份轻量目录（每个问题的标题、回复摘要和时间），不读正文。向上滚动接近顶部（滚轮、触摸拖动、方向键/PageUp/Home 或拖动滚动条）或点击“显示更早的 N 个问题”时，每次读取 12 个问题的正文，插入时保持当前阅读位置不跳动。从目录跳到较早的问题时只读取它附近的一段，与已读部分之间留下“显示中间的 N 个问题”，点击后从靠近阅读位置的一端继续读取。页面中同时最多保留 120 个问题，较远的部分会收起为可重新读取的占位。
- **对话目录与书签**：压缩前的问题与当前上下文的问题合并在同一条目录中，未读取正文的问题也能悬停预览标题和回复摘要；点击会先读取所在的一段再跳转。更早的压缩摘要也显示为小圆环。书签仍是原生 label，与当前上下文的问题相同。
- **执行过程**：每个问题下显示“用时 · N 次工具调用 · N 个错误”，展开后才读取步骤列表（每页 100 步），只显示工具名、命令或参数摘要和文字片段，不显示思考与工具结果原文；点击某一步在历史页预览该记录。
- **超长内容**：问题正文最多显示 12000 个字符，回复最多 20000 个字符，超过时显示“内容较长，在历史中查看全文”，在历史页预览中查看。原问题中的图片只显示数量。
- **压缩切开的一轮**：如果压缩恰好保留了某一轮的后半部分，回看区只显示这轮的问题和已压缩的步骤，并注明“这一轮后续的执行和回复在下方的当前上下文中”。
- **历史定位**：历史页预览压缩前的问题或回复时也提供“在对话中定位”，会读取所在的一段并滚动高亮；压缩前的工具步骤仍只在历史页查看。
- 只在线程已压缩且运行实例 `/api/pi/status.historyArchive=true` 时启用；临时会话、旧后端或读取失败时，回看区显示原因并可重试，不影响正文与发送。后台历史读取在页面内排队，一次最多占用 worker 的一个历史查询名额；打开线程时先等待自动模型列表刷新结束，再读取目录。历史查询名额已满或会话暂时处于命令／切换／重载操作时，后台只读查询自动重试一次；其他错误仍提供手动重试，书签写入不自动重试。
- 会话发生新的压缩或切换分支后，旧目录失效（`HISTORY_STALE`），页面重新读取目录；切换线程时迟到的响应被丢弃。

接口为主连接 `get_history_archive`（`view=index|turns|process`），说明见 [API](API.md#压缩前问答回看)。实现为 `server/pi-history-archive.js`（与 Pi `buildContextEntries` 相同规则的只读投影与预算）、`public/pi-transcript-archive.js`/`.css`（分段渲染、自动读取与目录数据），经 Supervisor 唯一 worker 的内部扩展桥接；扩展 marker 为 `history-archive-v1`，部署后需重新打开线程以加载新扩展。

## 对话目录与快捷书签（2026-10-11）

主聊天区左缘的“对话目录”是线程内找旧问题的主要入口：每个问题（用户消息、定时任务、Agent 任务或唤醒的 Agent 消息）一条短刻度，当前视口内的问题颜色较深，书签为强调色并略长。指向刻度时附近刻度放大，旁边的预览卡显示问题首行、该轮最后一条可读回复的纯文字摘要（只取回复开头的段落与列表，尽量略去代码块和表格）、发送时间及自定义书签名；点击刻度或卡片跳到该问题并短暂高亮，卡片右上角切换书签。滚轮经过目录时仍滚动对话；键盘可 Tab 到当前位置的刻度，用上下方向键、Home/End 浏览，Enter 跳转，Esc 收起卡片。鼠标操作不移动焦点，不打断正在编辑的草稿。

- 仅在主要输入为可悬停的精确指针（鼠标/触控板）、窗口宽度超过 680px、主聊天区至少 560×240px 且至少有两个刻度（问题或摘要标记）时显示；窄桌面会为刻度留出左侧边距（正文与输入框同时右移）。手机、触屏和 680px 及以下宽度不显示目录，问题标题行的书签按钮照常可用。
- 上下文压缩摘要和分支摘要显示为刻度间的小圆环：预览说明其含义，点击展开该摘要；压缩摘要的卡片提供“搜索历史”，直接打开历史搜索查找压缩前原文。摘要不能加书签。
- 目录只读取已渲染的正文和 `get_messages.webAnchors` 的原生 entry 映射，不保存第二份目录或历史。压缩前的问题来自上文的回看区目录；其他分支的记录不在目录中，可从下方历史搜索查看。
- 书签就是 Pi 原生 label（`pi.setLabel` 追加的 label entry），与历史页、终端 `/tree`（Shift+L 编辑、Ctrl+L 仅看标签）共享。问题标题行的书签按钮在桌面悬停时出现，已加书签时常显。快捷添加的名称默认取问题前 24 个字符，可在历史页预览的“书签与记录”中改名。
- 页面打开、重连或收到 `gateway_history_changed` 时用 `search_history`（`scope=all, filter=all, bookmarked=true`，按 revision 分页，最多 100 页）读取书签；超出页数时保留已知书签而不当作未标记。读取失败不影响目录，稍后在变更或会话空闲（间隔至少 30 秒）时再读，不循环重试。
- 写入只走既有 `set_history_bookmark` 并携带 `expectedBookmarkRevision`。修订未知（例如本页打开前已移除过的标签）时先用 `get_history_entry` 读取原生当前值；若已被他处加上书签，只更新显示、不覆盖。冲突、超时或未确认的写入只提示原因并重新读取书签，**不自动重试**；后端的待确认书签互斥保持不变。临时会话、无原生 entry 的未落盘消息和旧后端（无 `historySearch`）不显示书签按钮。
- 历史页预览中，属于当前分支且显示在正文里的记录，以及压缩前回看区的问题与回复，提供“在对话中定位”：展开折叠的本轮过程或执行记录（压缩前的记录先读取所在的一段），滚动到该记录并高亮；窄屏抽屉会先收起。其他分支或工具内嵌记录不显示此按钮。

实现为 `public/pi-transcript-timeline.js`/`.css`（目录、预览、书签状态与问题标题行按钮），`public/pi-chat.js` 只负责装配和统一的 `locateTranscriptNode`，`PiTranscriptView.reveal` 负责展开折叠的轮次与执行记录。没有新增 WebSocket/REST 字段或后端改动，旧运行实例静态刷新即可使用。

## 搜索结果的角色与回复阶段（2026-09-10）

搜索结果与会话树统一标明角色、回复阶段和本地时间；关键词片段保留命中上下文，工具与摘要单独区分。

`search_history.results[]` 与 `get_history_entry` 新增 `replyStage`（仅assistant）和 `summaryType`（仅摘要）。`server/pi-history-model.js` 调用树模块的同一个replyStages函数，对完整原生entries和当前branch计算后才做关键词/类型/书签/分页筛选；未命中的后续消息仍参与阶段判断，不能把搜索页最后一个结果猜成最终回复。空闲信息仍由内部扩展读取ctx.isIdle及pending messages，不接受浏览器传入的settled；旧响应无字段时保持通用AI回复。

搜索和树视图保留键盘焦点与内部滚动。

新后端由 `historyPresentation=true` 标记；旧worker须在空闲时重开以加载history-presentation-v1扩展。

## 会话树的角色、时间与回复阶段（2026-09-10）

时间来自原生消息或 entry，缺失时不展示，0为有效值。树节点显示短预览，点击读取原文；停止和失败分别标记，不把最后一条可见回复猜成最终回复。

在“搜索／会话树”之间切换，使用“定位当前”或刷新；单击节点仅预览，显式继续才导航。

`get_session_tree.rows[].replyStage` 为 `progress|final|pending|stopped|error|unknown`，只为assistant节点返回。服务端在折叠/分页之前按完整原生parent链反向计算下一条消息：后面仍有assistant或toolResult的文字是过程回复，toolUse/toolCall同样是过程。只凭stopReason=stop不能判为最终回复；无继续消息、具有stop/length终态且运行尾段已原生空闲（ctx.isIdle且无pending messages）时才标final。当前未结束尾段为pending；中断/失败分别为stopped/error。跨压缩/分支摘要或特殊消息边界、不足以确认的旧记录保留unknown，不从retainedTail、相邻分页或折叠后的可见列表推算。

标签描述当前读取的原生树快照；任务结束或树变化后刷新可重新读取。旧后端没有replyStage时显示通用AI回复，不在浏览器猜测阶段。新后端由 `treePresentation=true` 标记，按运行实例核对。

## 会话树与可读搜索（2026-09-10）

新后端由 `sessionTree` / `historyBody` 标记启用，须在空闲窗口重载。更新静态页不表示正在运行的旧 worker 已加载新接口。按当前实例状态确认能力。

右侧历史页增加“搜索 / 会话树”两个入口；`/tree`（无参数）与线程菜单“历史与记录 → 会话树”打开相同视图。树默认定位当前继续位置，以纵向分支连线呈现问题、回复、书签和两类摘要。纯工具、思考和内部 metadata 不铺进树；工具仍可在搜索中查找。可收起后续路径、定位当前和分页，每页最多100个节点，深层分支缩进有上限，父节点预览在按钮提示中。原生 parentId 关系经过不可见节点连接后投影，不重新推算或保存聊天树。

单击节点只预览。预览占用原列表空间，正文按共用 marked + DOMPurify 规则显示 Markdown，工具记录保持纯文本；正常短记录不显示无用分页按钮。返回列表保留筛选和树折叠；书签表单与继续方式默认折叠。

- 搜索默认“对话正文”（`filter=conversation`），包含问题、可读助手正文与摘要。`assistant` 排除只有工具调用的助手 entry，混合消息只匹配/显示文字；工具参数不能误命中“助手回复”。
- “工具记录”和“全部记录”仍搜索原工具参数/结果。工具型 assistant 归类 tool；混合消息的参数可在预览中点“查看工具参数”。没有从 JSONL 删除内容。
- `get_history_entry` 新增 `view=body|record`（默认 body），返回 projection 的 view、当前 revision/leafId 和可继续的 navigation 类型。工具节点始终使用 record；正文匹配偏移和预览使用相同投影。
- 用户问题提供“回到此问题前，修改后继续”；完成且无 toolCall 的文字回复、compaction/branch_summary 提供“从这里继续”。中间工具步骤、失败/停止回复仅查看。导航不自动发送。
- 原问题文字/图片只返回发起页面；主稿为空且未在读取/提交时可回填，否则显示显式追加入口，不覆盖原稿。追加仍校验附件预算。页面断开后不自动重投，原问题仍可从历史重新查看；临时草稿不持久化。
- “携带离开分支的摘要”默认关闭，勾选后才调用当前原生模型（或已安装扩展摘要钩子），可输入最多2000字符重点；原生按预算总结旧位置到共同祖先之间的离开路径，追加原生 branch_summary，不承诺无损合并或全量保留。
- 同一 session 的其他页面共享继续位置，导航完成后全部重读原生快照。所有导航需精确 expectedLeafId 和 revision，旧预览/书签变化拒绝。导航暂停该线程未投递预约，原生扩展取消时预约仍保持暂停。
- 导航不撤销项目文件、Shell、部署等副作用，也不建立 worktree。原生 session_before_tree / session_tree 钩子继续生效，第三方扩展自身副作用不由网页回滚。

实现为 `server/pi-session-tree.js` 的只读投影与校验、`server/pi-history-navigation.js` 的单项运行状态、`public/pi-session-tree.js` 的视图协调，沿用 Supervisor 唯一 worker 的内部扩展桥接。`tree-v1` marker 校验旧 worker 能力；不修改 Pi 依赖。原生 RPC command context 只返回 cancelled，草稿从选定原生 user entry 获取。

主连接新增 `get_session_tree`（`offset?,revision?,focus?:'current'|entryId,collapsed?:entryId[]`，折叠最多256项）、`navigate_history`（`entryId,expectedLeafId,revision,summarize,customInstructions?`）和 `cancel_history_navigation`（`navigationId`）。导航命令未知字段拒绝；临时/侧聊连接拒绝。读树仍使用 history 私有响应（256KiB/50000条/1.5秒），结构为分页 rows、leafId/currentId、revision、offset/pageSize/total/hasMore/collapsed。

导航在 await 前进入现有空闲互斥区，与发送、压缩、Shell、重载、书签和预约互斥。`get_state.webNavigation` 与 `gateway_navigation` 携带 runtimeId/revision/busy 和最新 job 的 ID/目标/状态/时间，不含草稿或摘要正文；不产生完成未读。取消走原生 abort，但只有原导航结果终态才释放占用。摘要重试遵循 Pi 原生设置；网关不重新提交导航。服务等待最多10分钟，浏览器11分钟；RPC超时关闭不确定worker后重新连接核对，不自动重放。错误后也通知页面重读位置，以覆盖导航后扩展钩子失败的情况。

成功导航通过公开 pi.appendEntry 追加 `pivane-web-navigation` metadata（兼容旧 `pi5-web-navigation`） 保持重启后的 leaf；不含聊天副本。已有原生 summary 保持原格式与 usage；当前状态仅内存。未知/迟到 pivaneNavigation 与 pivaneHistory 响应及其旧 pi5 别名在 Supervisor 截获。

## 用户交互

线程内浏览旧问题与快捷书签优先使用上文的对话目录。完整检索入口为线程菜单“历史与记录 → 搜索历史与书签”和右侧“历史”页签；会话详情不再重复放置入口。历史顶部“搜索／会话树”同排右侧的更多（⋯）只收纳“从历史问题分叉”和“恢复旧版本”，复用原工作流窗口与确认，不增加常驻操作卡片。菜单不挤压列表、预览正文，不触发额外历史读取；外部点击、Escape、切页或切线程收起，键盘关闭返回入口。分叉到新线程与会话树的原线程继续保持不同语义。此入口调整为静态刷新生效。

复用已有桌面分栏/手机抽屉，不增加输入框按钮。打开其他线程菜单的历史操作时，先按既有方式打开该线程；不会停止原持久线程中的任务。

- 默认搜索当前分支的对话正文，可以选择所有分支、用户问题、助手回复、工具记录、全部记录、摘要及“仅书签”。
- 匹配文字与标签，大小写不敏感、按字面量匹配；不是正则表达式执行入口。
- 显示在对话中的扩展消息（定时任务、Agent 消息等原生 `custom_message`）也可搜索、预览和加书签，归入“助手回复”；隐藏的扩展消息不检索。会话树仍只显示问题、回复与摘要。
- 读取 SessionManager 原生 entries 与 branch，因此包含当前分支中压缩前的旧消息。`get_messages` 的有效上下文不作为完整历史来源。
- 结果按原生追加顺序从新到旧显示，每页 30 条；同一工具的调用参数与结果可能作为不同原生节点各自命中。
- 点击结果只预览，不 fork、不 navigate、不填入或发送主草稿。其他分支结果明确标注。
- 正文分页约 16000 个 JS 字符。命中长正文中间时打开命中所在页，可看前/后段；有分页时复制按钮写明“复制本页”。
- 图片只显示数量，不传 base64 或图片原件；不搜索思考、签名、隐藏 custom 消息和内部控制 metadata。工具参数、可见结果正文、错误与摘要可检索。
- 已结束并进入原生记录的回复可检索，未结束的 streaming assistant 不拼接进历史结果。
- 临时 no-session 会话不开放本功能；持久线程首条 assistant 保存后才可添加书签，避免原生延迟落盘造成“已保存”假象。

每条可见记录可添加一个最多 80 字的书签、改名或移除。移除只清原生 label，原消息保留。超长既有 CLI 标签会标注截断；修改时需要输入新的名称。原生标签可在终端 `/tree` 中查看。

历史面板仅在当前页面内存保留查询/分页/预览，切线程清空；不写 localStorage、工作台偏好或独立历史文件。断线时禁用操作，重连获取新运行实例的数据；旧查询和预览不得串到新线程。书签通过原生 session JSONL 持久化，跨连接和重开恢复。

## 所有权与数据流

`server/pi-history-model.js` 对当前原生 SessionManager 做有预算的投影，提供 searchHistory、previewHistory、setHistoryBookmark。它不读写文件、不维护索引或第二份历史。

主 WebSocket 已绑定的唯一 worker 调用项目内 `pi-web-session-extension.ts` 的受保护内部命令；仅匹配正确 source path 和 history-v1 描述，不从浏览器接收任意命令名、session 文件路径或分支切换参数。扩展使用公开 `ctx.sessionManager` 和 `pi.setLabel`；没有第二个 worker，也没有模型请求。查询和修改在扩展 handler 内同步取值/检查/操作，避免原生事件在同一标签的比较和写入之间穿插。

结果通过 `pi5History` 私有 notify 返回 Supervisor，按随机 request ID 关联。未知、超时和迟到的私有结果都被截获，不能广播历史正文。仅调用者得到相关 response；成功书签修改向该 worker 的订阅者广播无正文的 `gateway_history_changed`（entryId），提示其他页面刷新。

`public/pi-history.js` 管理筛选、分页、预览和标签编辑，正文经共用 marked/DOMPurify 排版，工具文字与关键词高亮用安全 DOM。右栏页签协调仍归 PiSideChat.showPane；新增历史页不会重建侧聊或改变变更记录页。

## 书签语义与竞争处理

原生 `pi.setLabel` 追加 `label` metadata entry。它**会推进原生 leaf ID**，但不会把当前分支切到被标记的目标，也不改写旧消息。原活动路径中的消息顺序不变；后续分叉/恢复仍按既有 expectedLeafId 校验，旧工作流预览可能需要刷新。不能为了声称 leaf 不变而调用 branch/navigate 把它改回。

每条记录的 `bookmarkRevision` 是最近一条针对它的 label entry ID，无变更时为 `none`。保存比较 expectedBookmarkRevision；旧页面或终端已修改时拒绝，不能用旧标签覆盖新标签。相同当前标签值不重复追加；清除/重新添加也会产生新的修订，能识别 ABA。

每 worker 最多两项历史请求、一个待确认书签写入。搜索/预览可在模型运行时执行，书签也可在普通生成期间设置；已知压缩/停止处理期间拒绝新书签写入。书签写入与手动压缩、空闲分叉/导航/重载互斥，不中止已有主任务。

写请求超时不自动重放。若已收到私有完成结果，以它为准；否则保留书签待确认状态，允许查询但拒绝继续写书签或做冲突的空闲操作。迟到的明确结果释放状态；显式退出对应 runtime 也会销毁其内存等待。不会因超时自动杀死正在运行的 Agent。未完成历史请求和待确认书签阻止空闲回收，并计入部署所用 activity.busy。

## 主 WebSocket 接口

需要先认证并 open_session。侧聊连接与临时会话拒绝这些接口。沿用 token/Origin、项目根 realpath 和 session 查找；不新增裸 RPC 透传权限。

### search_history

输入：`{q?,scope?:'branch'|'all',filter?:'all'|'conversation'|'user'|'assistant'|'tool'|'summary',bookmarked?:boolean,offset?:number,revision?:string}`。

返回：`{revision,leafId,results,total,offset,hasMore,pageSize:30}`。每项含 entryId、kind、hasTools、images、timestamp、toolName、inCurrentBranch、label/labelTruncated、bookmarkRevision、canBookmark、matchOffset、snippet。

关键词最多 200 字符；offset 是结果偏移量。第一页不需要 revision；翻页必须带原查询快照 revision。revision 覆盖 session ID、leaf、entry 数量与最后一条 ID，期间有追加或标签变化时拒绝旧分页，提示重新搜索，不把不同快照混在一起。

### get_history_entry

输入：`{entryId,offset?:number,view?:'body'|'record'}`，offset 是正文字符位置。返回单条记录 metadata、text、offset、totalCharacters、hasMore、pageCharacters、nextOffset、previousOffset；正文分页不会切断 UTF-16 代理对。只预览当前 session 中允许显示的节点。

### set_history_bookmark

输入：`{entryId,label,expectedBookmarkRevision}`；label 去掉首尾空白，空字符串代表移除。返回 `{entryId,label,bookmarkRevision,leafId}`。不接收正文、parentId 或目标分支。

成功广播：`{type:'gateway_history_changed',entryId}`。它不是新助手回复，不创建未读完成标记，不写工作台偏好。

## 预算与限制

- 每次最多处理 50000 条原生 entries。
- 单条展开文本最多 8 MiB、参数最多 100000 个输出片段/32 层；单次匹配文本合计最多 64 MiB，搜索遍历时间预算 1.5 秒。
- 单次私有响应最多 256 KiB；列表只返回 30 条短预览，详情分段传输。
- 超限明确报错，不默默截断搜索后返回“没有匹配”。可以按分支、类型或仅书签缩小文本范围；超过 entries 总限额时明确不支持该大线程。
- 这是当前线程内的搜索和会话树，不包含跨项目全局搜索、任意树编辑或文件回滚。

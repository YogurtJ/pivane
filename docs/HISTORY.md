# 历史搜索与原生书签

2026-09-10：项目线程栏底部新增跨线程正文搜索入口（sessionSearch标记）。GET /sessions/search独立有界只读扫描原生用户/assistant文字，返回线程与命中片段；打开结果接入本页现有get_history_entry正文预览，不导航分支、不自动发送。当前线程搜索/书签继续经唯一worker执行。跨线程搜索的路径、取消、分页和覆盖限制见 [NATIVE_COMPLETION.md](NATIVE_COMPLETION.md)。

当前线程历史查询需要运行实例的 `/api/pi/status.historySearch=true`。

## 搜索结果的角色与回复阶段（2026-09-10）

“搜索”列表及记录预览头部与会话树共用 `PiHistoryPresentation`：用户问题蓝色，AI过程回复为中性卡片，最终回复绿色强调，显示阶段标签与本地时间；工具记录/摘要有独立图标。关键词命中高亮、正文/工具投影、分页与复制范围保持原契约，搜索片段不按会话树的三行规则裁切，以保留命中上下文。

`search_history.results[]` 与 `get_history_entry` 新增 `replyStage`（仅assistant）和 `summaryType`（仅摘要）。`server/pi-history-model.js` 调用树模块的同一个replyStages函数，对完整原生entries和当前branch计算后才做关键词/类型/书签/分页筛选；未命中的后续消息仍参与阶段判断，不能把搜索页最后一个结果猜成最终回复。空闲信息仍由内部扩展读取ctx.isIdle及pending messages，不接受浏览器传入的settled；旧响应无字段时保持通用AI回复。

历史面板内全宽文本框和select的focus-visible使用2px内侧轮廓（offset=-2px），保留键盘焦点提示；不再在滚动区域边缘画向外的绿色轮廓或阴影。输入尺寸、页面滚动和搜索投递时机不变。

新后端由 `historyPresentation=true` 标记；旧worker须在空闲时重开以加载history-presentation-v1扩展。

## 会话树的角色、时间与回复阶段（2026-09-10）

用户问题使用蓝色角色图标和浅色卡片，AI过程回复使用中性卡片，最终回复使用绿色强调及明确标签；停止/失败单独标记。卡片标题旁显示浏览器本地时间，非本年带年份，完整本地日期时间在time标题和无障碍标签中；使用原生消息timestamp，缺省时使用entry的原生timestamp，无有效时间则不展示，数值0是有效时间。预览摘要最多显示三行，点击仍读取原正文。

上方“搜索 / 会话树”为共用底板的分段视图切换，下方“定位当前 / 刷新”为轻量图标操作栏；选择态、焦点、手机触控尺寸和三主题保持明确区分。树视图不再显示旧搜索的结果计数。

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

成功导航通过公开 pi.appendEntry 追加 `pi5-web-navigation` metadata 保持重启后的 leaf；不含聊天副本。已有原生 summary 保持原格式与 usage；当前状态仅内存。未知/迟到 pi5Navigation 与 pi5History 响应在 Supervisor 截获。

专项 `test/pi-session-tree.test.js` 使用原生 SessionManager、真实RPC和loopback SSE，覆盖正文/工具投影、折叠/分页、无摘要/有摘要/取消/错误、图片草稿、修订冲突、双客户端、预约暂停及重启恢复。`test/browser/pi-session-tree.cjs` 验证1440/393/320px三主题、正文阅读面积、树操作、确认取消、草稿与迟到线程隔离；沿用原历史、工作流、附件、输入与文件查看回归。所有测试使用独立数据或mock，不操作用户线程或调用付费模型。

## 用户交互

入口为线程菜单“历史与记录 → 搜索历史与书签”和右侧“历史”页签；会话详情不再重复放置入口。历史顶部“搜索／会话树”同排右侧的更多（⋯）只收纳“从历史问题分叉”和“恢复旧版本”，复用原工作流窗口与确认，不增加常驻操作卡片。菜单不挤压列表、预览正文，不触发额外历史读取；外部点击、Escape、切页或切线程收起，键盘关闭返回入口。分叉到新线程与会话树的原线程继续保持不同语义。此入口调整为静态刷新生效。

复用已有桌面分栏/手机抽屉，不增加输入框按钮。打开其他线程菜单的历史操作时，先按既有方式打开该线程；不会停止原持久线程中的任务。

- 默认搜索当前分支的对话正文，可以选择所有分支、用户问题、助手回复、工具记录、全部记录、摘要及“仅书签”。
- 匹配文字与标签，大小写不敏感、按字面量匹配；不是正则表达式执行入口。
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

## 验证

`test/pi-history.test.js` 覆盖原生压缩前记录、其他分支、分页修订、工具参数、隐藏数据排除、label 改名/移除/冲突；真实 Pi RPC + loopback provider 验证无模型调用的历史查询、运行中持久化标签、双客户端冲突、重连、单 worker、私有迟到响应隔离，以及写超时不重放。测试使用独立 Agent/session 目录。

`test/browser/pi-history.cjs` 用 mock REST/WS 和原生内存 SessionManager，检查 1440/393/320px 三主题下筛选/分页、字面高亮和安全文本、其他分支、长正文、标签冲突、跨线程迟到结果及宽度。现有侧聊、变更记录、停止、会话工作流和输入框回归必须同时通过。

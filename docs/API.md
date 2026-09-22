# API Reference

2026-09-11 Windows原生支持补充：文件请求接受经过规范化校验的Windows盘符/分隔符路径，返回相对path使用网页斜杠表示；ADS、设备命名空间、保留设备名及盘符相对路径拒绝。fileViewer/sessionSearch/usageStats仍由实际后端可用性决定，Windows原生组件承担私密文件ACL与句柄检查，缺失时配置初始化也可能拒绝。没有增加任意句柄/路径写入REST或绕过已有身份/同源检查。范围见WINDOWS.md。

2026-09-11 媒体快速接入：GET `/api/pi/media/lab/connections` 新增 `providerTemplates`，协议模板含可选 `recommended/help`。HTTP response.type 增加仅图像可用的 `image-json`，path 指向含 `b64_json/url` 的对象；JSON 路径 `*` 查找数组内第一份匹配结果，不批量执行。GET lab 省略所有旧 zimage/flux2/minimax-video 项（包括configured=true），前端也过滤旧进程返回的这些项，内部兼容定义仍可被旧 API 使用。CRUD、Key、修订和票据确认契约保持；详见 [MEDIA_CONNECTIONS.md](MEDIA_CONNECTIONS.md)。

2026-09-10 新增 liveRecovery/extensionDrafts/sessionSearch/runtimeConfiguration 标记。主连接 get_messages.webLive 为有界partial/tool展示快照，广播增加webRuntimeId/webSequence；主WS新增 ack_extension_draft、get_runtime_configuration、restart_runtime（空闲持久线程，runtimeId/expectedRevision/confirmed）。GET /sessions/search?q&cwd?&offset?&searchId? 提供受保护、可取消、有界原生正文跨线程检索。完整字段、预算、实际信任、配置修订、重开互斥与接受ACK语义见 [NATIVE_COMPLETION.md](NATIVE_COMPLETION.md)。不添加裸导航/工具权限、不存持久聊天副本。

原生设置补齐：GET `/api/pi/settings/native` schema 增加 `defaultTools`（type=tools、choices/defaults/platform）与 `defaultProjectTrust`（ask/always/never、globalOnly）。原 PUT 接受工具名数组（允许 []，拒绝重复/未知名）、null 删除本层覆盖；项目数组整体替换全局数组。信任策略仅允许全局写入，项目范围即使 null 也拒绝。保存返回 requiresRuntimeRestart=true，不改变现有实例或逐项目信任决定；完整语义见 [NATIVE_SETTINGS.md](NATIVE_SETTINGS.md)。旧后端没有字段时网页隐藏对应分类，生产需空闲重载后检查实际 schema。

页面通知/提示音仅复用现有GET /api/pi/activity，不新增API；后台推送仍是显式可选功能，基础localhost通知无需调用订阅或VAPID接口。详见NOTIFICATIONS.md。

基准地址为用户实例自己的Host/端口；以下路径和供应商标识是中性示例。

本文件描述当前代码中的实际接口，不是未来设计。

工具结果的可选 `details.pi5ToolProvenance` 包含 `{version:1,toolName,toolCallId,source?:{source,path,scope,origin},skill?:{name,path}}`，由受管 worker 的调用前元数据生成，随原生 toolResult 和原有 WS 工具结果传递。缺失即未知，不通过设置清单补填；前端核对名称与调用 ID，仅作来源显示。扩展助手包确认取消时提供 `details.pi5PackageOperation.status='cancelled'`。不新增 REST 或改动原始正文、错误和用量，详见[执行来源](NATIVE_SETTINGS.md#执行记录中的技能与扩展来源)。

## 工作台访问验证（accessControl）

2026-09-09 新后端以 `/api/access/status.accessControl=true` 标记，公开接口仅返回 enabled/authenticated。设置/登录/退出/撤销与全部字段见 [ACCESS_CONTROL.md](ACCESS_CONTROL.md)。配置缺省免认证；开启后所有私人API、WebSocket和静态媒体均需要Cookie或Bearer，不能凭同源Origin或URL Token绕过。非空PI_WEB_TOKEN强制启用；网页配置可由用户修改且要求修订/确认。

`/api/access/{login,logout,revoke}` 为POST，`/settings` 为GET/PUT；写入要求JSON和X-Pi-Access:1。Cookie写请求保留同源/CSRF检查；Origin须匹配HTTP/HTTPS scheme与Host，HTTPS代理需配置PI_WEB_SECURE_COOKIE。直接图片/音频/视频、Range/HEAD和下载使用同一Cookie；后续文字中原Bearer/首消息Token方式仍兼容。新服务覆盖本文件第6节旧媒体API，旧业务协议不因鉴权而变成review票据接口。

## 1. 通用行为

- JSON request body 上限由 Express 设置为 32 MB。
- 私人 API 检查 Origin 与可选工作台身份；accessControl开启时使用HttpOnly Cookie或Bearer。相同Origin仅通过来源检查，不授予访问权。
- `PI_ALLOWED_ORIGINS` 是附加跨域白名单，不会取代上述同 Host 规则。
- `PI_WEB_TOKEN` 非空时，HTTP 使用 `Authorization: Bearer <token>`。
- WebSocket token 放在第一条 `open_session` 消息中，不放 URL。
- 错误通常返回 `{ "error": "..." }`。
- Agent session path 不接受浏览器直接指定，必须通过 `cwd + sessionId` 查找。

## 2. Pi REST API

所有路径前缀为 `/api/pi`。

### Agent 任务线程

`GET /status.agentThreads=true` 标记任务线程后端，`agentTaskResults=true` 标记来源线程结果回执。受管持久 Agent 的 `agent_thread` 工具通过私有 POST `/agent-threads/create|status|models|result` 创建任务、查询状态/模型或分页只读原生结果。身份绑定存活源 worker；工作台 Cookie/Token 不能代替。目录未完成时返回202及 `TASK_INDEXING`/coverage，不把未核实记录当作不存在。`/activity.agentThreadLaunches`、`agentTaskIndexing`、`agentTaskReturns` 分别报告创建、目录读取和交付工作，均进入维护空闲与停机等待。

工作台身份使用 `GET /agent-threads/results?cwd=...&sourceSessionId=...` 读取来源线程的任务与最近100份结果，返回 `status`、`tasks`、`results`、`coverage`、`total`、`truncated`。结果含 deliveryId、requestId、sourceSessionId、session、status、resultId、entryId、completedAt、preview、truncated、delivered、read。`POST /agent-threads/read` 接受 cwd/sourceSessionId/deliveryId，仅由当前来源 worker 在空闲时保存已读；忙碌或归属错误返回409。

来源忙碌或关闭不丢结果，重开后从原生任务状态和回执恢复；回传不触发新的模型轮次。任务参数、预算、旧任务兼容和失败语义见[Agent 任务线程](AGENT_THREADS.md)。

### `GET /status`

`modelCatalog=true`启用主WS `refresh_models`（仅id/type/token，不接收其他参数）。只在当前worker空闲互斥区刷新本地模型/认证目录并返回`{models}`，广播`gateway_models`同步其他订阅者；不自动选模型、发消息或重载资源。5000项/1MiB安全字段、8秒原生signal/12秒等待，同worker合并，未知/超时关闭该预先空闲worker。普通消息原生缺认证的preflight失败以`errorCode=MODEL_AUTH_REQUIRED`和中文设置引导返回；其他错误保留原分类。完整契约见PROVIDER_SETTINGS.md。

`fileViewer`、`usageStats`、`sessionSearch`以安全描述符后端为前提：Linux/proc、macOS F_GETPATH或Windows HANDLE组件。缺失/哈希不一致不回退为请求路径，Windows组件也用于私密写入，损坏可能导致配置初始化失败。系统native realpath规范文件身份，同一文件别名共享唯一受管worker；实际平台范围见WINDOWS.md和MACOS.md。

`projectRoots` 返回实际规范根目录。未设置或留空 `PI_PROJECT_ROOTS` 时，Linux/macOS 默认 `/`，Windows 在服务启动时枚举 A:–Z: 中存在的盘符根目录；新盘符需重启发现，UNC 共享须显式配置。非空配置仍作为完整覆盖，POSIX 使用冒号、Windows 使用分号分隔；配置的根全部失效时返回空范围，不自动扩大。此默认行为从 RC3 安装修订包提供，修订前的 RC3 实例以实际状态为准。

`defaultProject` 返回允许根内可读/可进入的规范默认目录，优先运行用户主目录，其次服务cwd与可用根；没有可用目录时为null。只供首次目录浏览和未选项目的全局设置上下文，不创建或打开项目/会话。项目列表不再为零会话身份注入WebUI源码cwd。显式项目根 `/` 可包含子目录，根校验和系统权限继续生效。

返回 gateway 状态；`version` 读取服务加载时实际安装的 Pi package metadata，不写死。`mediaLab=true` 表示当前进程已挂载新实验室接口；更新静态文件不会自动启用旧进程缺少的 API。

```json
{
  "ok": true,
  "version": "0.85.0",
  "authRequired": false,
  "projectRoots": ["/workspace"]
}
```

设置 token 后，本接口本身也需要有效 Cookie 或 Bearer token；未登录页面只读取最小的 `/api/access/status`。

`browserNotifications=true` 标记设备Web Push订阅与任务通知后端。`GET /notifications`、`POST /notifications/key`、`POST /notifications/status`、`PUT/DELETE /notifications/subscription`、`POST /notifications/test` 复用认证和Origin，响应no-store；只公开VAPID公钥，订阅绑定当前访问身份，关闭/撤销停止后续推送。参数、限额和HTTPS/手机要求见 [NOTIFICATIONS.md](NOTIFICATIONS.md)。

`/settings/subagents` 提供 pi-subagents 专属状态与模型/思考配置，`/settings/subagents/install` 确认后补装固定版本。未安装、停用或版本不匹配时不能保存，ready 不代表已加载进当前 worker。字段、修订、范围与安装限制见[子 Agent 专属设置](NATIVE_SETTINGS.md#子-agent-专属设置)。

`nativeSettings`、`nativeResources`、`projectTrust`、`modelAdvanced` 标记原生配置增强。设置 `/settings/native`、`/settings/native/trust`、`/settings/native/resources`、`/settings/native/packages`、`/settings/native/skill` 和 `/settings/models/advanced` 的方法、修订、范围和限额见 [NATIVE_SETTINGS.md](NATIVE_SETTINGS.md)。主连接新增 `get_native_resources` 返回当前 worker 的实际 trust/资源来源，不返回系统提示正文或工具 schema；最多3000项/512KiB，不扩展裸 RPC 白名单。`/activity.nativeSettingsBusy` 供空闲部署检查。受管扩展原生换会话或直接导航被取消，网页入口保持。

`systemPrompts=true` 标记系统提示词管理：GET `/settings/system-prompts?cwd` 返回 global/project × append/base 原生文件正文、推导来源、整体 revision 和 64 KiB 单文件预算；PUT 接受 `{cwd,scope,kind,content,expectedRevision}`，content=null 恢复默认/继承，成功返回 `{ok:true,requiresReload:true}`。修订覆盖四文件内容/身份和原生配置/trust，冲突409不覆盖，保存不重载或中断 worker。主连接 `get_system_prompt` 通过当前 worker 私有资源管道读取正文、基础/追加输入、上下文文件、Skills、实际工具、时间与运行身份，1 MiB 超限整体失败；`configured` 为当前文件与实际信任推导来源，`matchesSavedFiles` 仅比较基础/追加与信任，无法核对为 null，不表示最终供应商请求一致。原 `get_native_resources` 继续不返回正文；读取不调用模型、不写历史、不广播私有结果。完整失败、草稿与生效语义见 [NATIVE_SETTINGS.md](NATIVE_SETTINGS.md#系统提示词查看与编辑)。

`sessionTransfer=true` 标记原生会话导出和 Pi JSONL 新线程导入接口已启用，完整范围见 [SESSION_TRANSFER.md](SESSION_TRANSFER.md)。`POST /sessions/:id/export` 接受 `{cwd,format:'html'|'jsonl'}` 并返回 attachment/no-store 文件；不接受客户端源/输出路径。HTML 含会话树历史及原生系统提示/工具定义，JSONL 只含当前分支，空闲互斥、源和输出各64MiB上限。`POST /sessions/import` 接受 `{cwd,content,requestId}`，v2/v3 JSONL限16MiB/单条8MiB/50000条/64层，原生迁移后创建新ID线程，201返回`{session}`，不启动/切换当前worker。运行数由 `/activity.sessionTransfers` 返回，供部署空闲检查。重复成功请求只在本进程30分钟内复用结果，不是持久幂等；不确定提交不自动重放。

`historyPresentation=true` 表示search_history结果和get_history_entry增加replyStage（assistant）及summaryType（摘要），与会话树共用完整原生记录的阶段判定；先判定再做关键词/类型/书签/分页过滤，当前尾段只有原生空闲且无pending messages才可判final。旧响应缺字段时保持通用AI回复，原查询参数与正文投影不变。界面角色/时间/阶段共用，焦点轮廓改为内侧显示，不增加写入、导航或模型调用。

`treePresentation=true` 表示会话树增加原生回复阶段投影；`get_session_tree.rows[].replyStage` 为 progress/final/pending/stopped/error/unknown，完整树判定后再分页/折叠，运行尾段需原生空闲后才能标final，跨摘要或旧记录信息不足为unknown。timestamp优先消息时间并保留合法0，前端按本地时间显示；没有新写接口或权限。缺少字段的旧响应保持通用AI回复展示。

`sessionTree=true` / `historyBody=true` 标记可读会话树、受控导航和正文优先搜索。主WS新增 get_session_tree（有界分页/折叠/定位）、navigate_history（entryId/expectedLeafId/revision/summarize/customInstructions?）与 cancel_history_navigation（navigationId）；当前持久worker/空闲互斥，原生可选分支摘要，预约暂停、草稿仅调用者返回，无文件回滚或自动发送。get_state.webNavigation / gateway_navigation为无正文修订状态，取消ACK不提前解锁，错误后重读位置，超时不重放。搜索新增conversation筛选、详情新增view=body|record，助手筛选不搜索工具参数，纯工具型助手归tool。完整预算、持久化与失败语义见 [HISTORY.md](HISTORY.md)。

`historySearch=true` 标记主连接已开放原生历史搜索、分页预览和原生 label 书签。新命令 search_history/get_history_entry/set_history_bookmark 只作用于当前已打开的持久 worker，侧聊和 no-session 拒绝；不增加裸 RPC 透传或独立聊天历史。完整参数、修订和限额见 [HISTORY.md](HISTORY.md)。

`composerTools=true` 标记原生模板 CRUD、内置命令 Web 映射目录、项目文件搜索和主 WS `reload_resources` 已启用。REST 包括 `GET /composer/catalog?cwd`、`GET/PUT/DELETE /composer/template` 与 `GET /composer/files?cwd&q`，复用 token/Origin，响应 no-store。模板写入使用 scope/name/content/expectedRevision，修订冲突 409；重载成功广播 `gateway_commands`。完整字段、限制、命令映射及未接入项见 [COMPOSER_TOOLS.md](COMPOSER_TOOLS.md)。

`fileViewer=true` 标记已挂载 `GET /files/content?cwd&path`：按当前项目范围读取普通 UTF-8 文件，最大 2MiB、4 并发，返回 cwd/path/absolutePath/content/size/modifiedAt/readAt/revision，响应 no-store/nosniff。复用 token/Origin/realpath/项目根校验，拒绝凭据、越界软链接、非普通文件、二进制与读取中变化；不启动 worker、不写文件或历史。write 记录全文来自原生消息，当前磁盘全文仅用户选择/刷新时请求。字段、错误码及展示契约见 [FILE_VIEWER.md](FILE_VIEWER.md)。

`runtimeControls=true` 标记主 WS 已支持 stop_and_recover/take_queue/ack_recovery、get_state.webControls 与 gateway_controls；`extensionStatus=true` 标记扩展文字状态的内存快照。完整契约见 [NATIVE_CONTROLS.md](NATIVE_CONTROLS.md)。

`manualUnread=true` 标记已启用持久线程的手动未读接口；`projectIdentity=true` 标记项目路径 resolve 和 recent 别名归一化契约。需新后端启用，旧后端前端隐藏未读操作并保留原路径行为。

### 版本检查与 Pi 受管维护

`/status` 的 `appVersion` 表示 Pivane，原 `version` 继续表示实际 Pi 包版本。`GET /settings/updates?channel=stable或preview`只读当前版本与内存缓存；`POST /settings/updates/check`接受 JSON `{channel?}`，显式查询 GitHub/npm 并缓存 5 分钟，查询本身不安装。`POST /settings/updates/automatic`仅接受空 JSON `{}`，按持久 24 小时成功期限检查 Pi 正式版，失败按 1–24 小时指数退避；并发共享请求，不安装。`GET /settings/updates/notifications`返回 enabled、available、eligible、idle、currentVersion、version、lastSuccessAt/nextCheckAt（Unix 毫秒或 null）。`POST`同路径接受 `{enabled:boolean}` 或 `{action:"claim"或"snooze"或"ignore",version}`；claim 仅当前可提醒版本且空闲时返回 claimed:true，同版本仅一次，snooze 延后 3 天，ignore 仅忽略该版。过期版本动作 409、错误字段 400、存储/服务不可用 503。身份与 Origin 校验、no-store 沿用工作台；偏好保留无关字段，查询与提醒不会产生维护票据或执行请求。

`GET /settings/updates/maintenance`返回启动器能力、generation、busy、版本指针和最近维护结果；`POST /settings/updates/review`只接受 `{action:"update"或"backup"或"restart"}`，返回绑定服务端目标版本和进程代次的 10 分钟票据。`POST /settings/updates/execute`只接受 `{ticket,confirmed:true,draftsSaved:true,externalWritersStopped:true}`，再次检查空闲并暂停预约，接受返回 202。票据一次有效，不接受命令、URL、路径或版本覆盖；忙碌/过期/重复为 409，格式错误 400，不支持或交接失败 503。交接不确定不自动解锁或重试。

所有接口复用身份/Origin、响应 no-store。`maintenance.job`增加脱敏 `output`、`outputTruncated`、`exitCode`、`fromVersion`与`installedVersion`；输出按行回传并保留有界尾部，只有实际退出后才返回退出码，成功后刷新版本卡片。普通`node server.js`与`npm start`自动支持，无需改服务启动命令；`--direct`为不含自动维护的开发入口。维护期间拒绝普通 API/WS 新工作；关闭页面不取消已接受操作。Pi 精确依赖在独立快照中安装并验证，然后停机备份和启动；Pivane 应用更新使用 `action:"application"`、可选 `channel` 复用 review/execute，票据绑定服务器选择的版本和 SHA256；能力以 `maintenance.appUpdateSupported` 为准。兼容字段 `installMode:"manual"`不表示受管维护不可用。字段、文件权限、预算、失败处理及恢复边界见[版本与更新](UPDATES.md)。

### `GET /projects`

从 `SessionManager.listAll()` 聚合允许根目录内的项目。可选 `recent` 为 JSON 编码的路径数组，最多 64 项、每项最多 4096 字符；服务端对每项执行 realpath/项目根检查，额外返回 `projectAliases: [{ input, cwd }]`，无效或越界项的 cwd 为 null。不创建目录、启动 runtime 或保存最近项目。

只读 `GET /projects/resolve?cwd=<absolute-path>` 返回规范 `{ cwd }`，无效路径 HTTP 400；复用 token/Origin/根校验。

```json
{
  "projects": [
    {
      "cwd": "/workspace/demo",
      "name": "demo",
      "sessionCount": 1,
      "modified": "2026-08-27T08:00:00.000Z"
    }
  ],
  "roots": ["/workspace"]
}
```

### `GET /activity`

返回本服务管理的持久 runtime 内存摘要和有效项目置顶列表；复用 token/Origin 校验，`Cache-Control: no-store`。不启动 worker、不扫描 session 文件，不返回消息、工具参数、工具输出或原始错误。

```json
{
  "runtimes": [{ "cwd": "/workspace/demo", "sessionId": "01...", "phase": "running", "busy": true }],
  "pinnedProjects": ["/workspace/demo"],
  "replyNotices": [{ "cwd": "/workspace/demo", "sessionId": "01...", "completionId": "uuid", "completedAt": "ISO timestamp" }]
}
```

`phase` 为 `running`、`tool`、`compacting`、`retrying`、`waiting`、`idle`、`error` 或 `stopped`。`busy` 包含压缩/重试/工具执行及等待确认。`agent_end` 不代表完整任务结束，必须等 `agent_settled`。失败/停止标记只在 worker 生命周期内保留，不是持久任务记录。临时 runtime 和外部终端运行实例不在摘要中；不存在某 ID 不代表外部终端空闲。

页面可见时每 3 秒读取；失败显示未知。临时会话使用当前 WebSocket 本地状态。

前端默认“全部”保留项目管理/完整列表；“工作中”按需处理、处理中、最近会话分组，同一线程按此优先级只出现一次。最近默认6条可展开至12条，保留选中线程并高亮，前两组不截断。工作中一次浏览期间保留已有候选的排序快照，避免点击后重排，再次进入时更新；状态变化仍可换组。分组、展开及排序仅为页面状态，不改变本接口、任务执行或未读标记；刷新恢复全部与6条，后台元数据补读仍使用现有 GET sessions。

### 项目与线程归档

`/status.archives=true` 表示归档接口已启用，旧后端不显示归档/恢复和包含归档搜索入口。

- `PATCH /projects/archive`：JSON `{cwd, archived:boolean}`，cwd经系统native realpath与项目根检查，可以归档非空或运行中的项目。
- `PATCH /sessions/:id/archive`：JSON `{cwd, archived:boolean}`，先解析真实持久会话；临时、不存在、越界会话或非boolean参数返回400。
- 两接口复用认证/Origin；成功返回规范`cwd`和`archives`，线程接口另返回`sessionId`。只写工作台归档偏好，不启动或停止worker，不改目录、Pi JSONL、未读、置顶或hiddenProjects。

`archives`结构为`{revision,projects:[cwd],sessions:[{cwd,sessionId}]}`，随GET `/projects`、`/activity`和归档响应返回；仅返回仍在允许范围内的规范路径。修订随写入递增并持久化，浏览器丢弃旧修订响应。恢复项目不逐条恢复线程，恢复线程不改变项目归档。后端偏好原子写入，保留其他未知字段，前端不乐观删除列表项，不自动重放失败/不确定请求。

归档不是删除或访问限制。GET `/projects`仍列出归档项目（含空项目），GET `/sessions`仍列出归档线程，直接打开/导出沿用原生接口。界面默认折叠归档区、允许直接查看；运行/未读/失败/待确认继续进入工作中且标注归档，最近会话排除归档。搜索默认排除，显式包含见下段。

跨线程正文搜索GET `/sessions/search`新增`includeArchived=true|false`（默认false），结果中的归档项含`archived:true`。后台在读到原生会话头后应用归档筛选，原文件身份/类型/预算/前后变化检查保持；缓存键包含归档修订和包含选项，搜索期间归档变化或旧分页请求返回409并要求重新搜索。归档条目不改变hiddenProjects的排除规则。

### `PATCH /projects/visibility`

Body: `{ "cwd": "/srv/example", "hidden": true }`。`hidden` 必须是 boolean，cwd 经过 realpath/项目根检查。移除时重新通过 SessionManager 确认无会话，并检查无持久或临时 runtime；否则返回 409。成功只写工作台偏好 hiddenProjects，并取消该项目置顶，不删除目录、文件、未读标记或 session。

`hidden: false` 恢复侧栏可见。返回 `{ "cwd": "<canonical cwd>", "hiddenProjects": [...], "pinnedProjects": [...] }`。GET `/projects` 和 `/activity` 同步返回有效 hiddenProjects；`/projects` 的项目目录仍包含这些空项目，供选择器勾选“显示已移出”后恢复，默认侧栏及选择器均过滤。显式置顶以及 POST `/sessions` 成功新建会话时也恢复项目。移除不会自动删除不存在路径的旧偏好。

### `PATCH /sessions/:id/read`

Body: `{ "cwd": "/workspace/demo", "completionId": "uuid" }`。经过 token/Origin 和项目 realpath 白名单检查；只清除匹配线程及 completionId 的未读标记，返回 `{ "ok": true }`。旧 ID 不会清除新回复。不会启动 runtime 或修改 Pi JSONL。

`replyNotices` 是每线程最多一条的待阅 metadata，保存于工作台偏好，不含消息正文。成功最终回复自动记录，显式手动未读额外含 `manual: true`；不自动回填旧历史、不记录临时会话。跨浏览器共享已读状态，显式删除线程时移除对应标记。

### `PATCH /sessions/:id/unread`

Body: `{ "cwd": "/workspace/demo" }`。先经过 token/Origin/realpath 根检查并查找真实持久 session；不存在或临时 ID HTTP 400。服务器生成新的 completionId 和 completedAt，并以 manual=true 覆盖该线程的旧提醒，返回 `{ "notice": { "cwd", "sessionId", "completionId", "completedAt", "manual": true } }`。不复制消息正文、不启动 worker、不改 JSONL。旧 read completionId 无法清除这个标记；再次打开线程的原生快照捕获此标记后仍可经 read 接口清除。

### `PATCH /projects/pin`

```json
{ "cwd": "/workspace/demo", "pinned": true }
```

`pinned` 必须是 boolean；`false` 取消置顶。cwd 经过 realpath/项目根白名单检查。原子写入 0600 `pivane-workspace.json` 的 `pinnedProjects`（既有 `pi5-workspace.json` 自动沿用），保留其他配置；返回 `{ "pinnedProjects": [...] }`，最近置顶排在前面。不同浏览器通过 activity 轮询自动同步。不改 Pi JSONL。

`GET /projects` 也返回 `pinnedProjects`，并包含没有 session 的有效置顶项目；不存在或不再允许的路径不会返回，也不会因此删除原偏好。

### `GET /directories?path=<absolute-path>`

列举项目目录。省略 `path` 时返回允许根目录。隐藏目录不出现在子目录浏览列表中，但已存在的隐藏项目 session 仍可能出现在 recent projects。

```json
{
  "current": "/workspace",
  "parent": null,
  "directories": [{ "name": "demo", "path": "/workspace/demo" }]
}
```

### `GET /sessions?cwd=<absolute-path>`

返回该 cwd 的 Pi sessions，按修改时间倒序：

```json
{
  "sessions": [
    {
      "id": "01...",
      "path": "/home/example/.pi/agent/sessions/...jsonl",
      "cwd": "/workspace/demo",
      "name": "",
      "firstMessage": "...",
      "messageCount": 12,
      "created": "...",
      "modified": "..."
    }
  ]
}
```

`path` 供当前可信单用户 UI 展示和 gateway 内部使用。不要把该接口暴露给不可信多用户。

### 扩展助手会话

`/status.extensionAssistant=true` 时，`POST /extension-assistant/sessions` 接受 `{cwd,scope,language,returnSessionId?}`，创建独立原生会话并返回 `assistant` 元数据，不提交模型消息。`POST /extension-assistant/inventory` 和 `/extension-assistant/package` 为已打开的助手提供固定安装范围的配置读取与包操作，分别接受 `{cwd,sessionId}` 和附加的 `{action,source,expectedRevision,confirmed:true}`。包操作复用原生配置互斥、trust 和修订检查；独立进程凭据只授权这两个管理端点，不能用于其他 API，媒体规划凭据不能用于扩展管理。请求/响应、确认、取消、身份恢复和限制见[扩展助手契约](NATIVE_SETTINGS.md#扩展助手接口与持久化)。

### `POST /sessions`

Body：

```json
{ "cwd": "/workspace/demo", "name": "optional" }
```

创建立即可见的原生空 Pi session，返回单个 session object。HTTP 201。

### `PATCH /sessions/:id`

Body：

```json
{ "cwd": "/workspace/demo", "name": "New name" }
```

活跃 session 通过 worker `set_session_name`；非活跃 session 用 `SessionManager.open().appendSessionInfo()`。

### 辅助模型

`/status.auxiliaryModels=true` 表示已启用按用途管理的辅助模型设置。GET `/settings/auxiliary-models` 返回 `{version:1,revision,purposes}`；GET `/settings/models` 同时返回此快照，保留旧 preferences 字段。当前用途为 `session-title`（标题）和 `media-planner`（媒体方案及接入规划）。每项含显示标签、自动规则、说明和当前 settings。

PUT `/settings/auxiliary-models` 接受 `{expectedRevision,changes}`，changes 按用途 ID 提交成对的 provider/modelId，双空字符串恢复自动；标题额外支持 enabled。只允许已实现用途/字段，不接受任意插件名。一次校验并原子保存所有改动，修订冲突 409；旧标题/媒体设置变化同样会使修订失效。已选专用模型失效不自动回退，标题“自动”与媒体“自动”的规则不同。保存不执行模型任务，校验纳入 nativeSettingsBusy/停机边界。完整参数、存储、兼容与后续接入要求见[辅助模型](AUXILIARY_MODELS.md)。

### 会话标题

`/status.sessionTitles=true` 标记自动标题与建议接口；`sessionTitleModels=true` 标记独立标题模型选择。GET `/settings/session-titles` 与模型设置快照的 `preferences.sessionTitles` 返回 `{enabled,provider,modelId,revision}`，默认 `true,"","",0`。PUT 支持 `enabled` 和／或成对的 `provider,modelId`，双空字符串恢复跟随线程，可带 `expectedRevision` 防止并发覆盖；过期返回 409。旧客户端只更新 enabled 时保留模型引用；服务在异步核对专用模型/认证后再次检查版本。保存不执行生成。开启后 POST `/sessions` 新建的未命名持久线程可在首轮有效问答完成后自动命名；已有历史不自动迁移。

POST `/sessions/:id/title` 接受 `{cwd}`，使用请求开始时冻结的标题模型选择生成建议；未指定专用模型时跟随当前线程，指定模型失效不回退。返回 `{name,nameRevision,contextRevision,model,usage}`，其中 model 为实际使用的 `{provider,id,name}`，usage 仅含非负安全整数或 null 的 input/output/cacheRead/cacheWrite/totalTokens，无有效数据时为 null。此临时请求不修改名称或主上下文。PUT 同路径接受 `{cwd,name,nameRevision,contextRevision}`，显式保存；名称或分支版本变化返回 409。生成失败 400，不回显供应商原文。两接口复用身份/Origin、项目规范路径与原生 session ID 查找，仅通过 Supervisor 的唯一 worker 获取上下文/写原生名称。

`/activity` 另返回 `titleGenerations`（全服务未结束请求数）、`titleRevision`（进程代次与变更计数），`runtimes[].titleGenerating` 表示标题请求。标题生成不表示主任务 busy，但部署与回收必须考虑此活动。成功保存广播 `gateway_session_named {cwd,sessionId,name}`；其他页面据全局修订刷新线程列表。摘录、预算、延迟/失败、手动保护与持久化详见[会话工作流](SESSION_WORKFLOWS.md#自动标题与重新生成)。

### `DELETE /sessions/:id?cwd=<absolute-path>`

停止 worker 后删除。成功：

```json
{ "id": "01...", "trashed": true }
```

`trashed=false` 表示 `gio trash` 失败后永久删除。

### 会话工作流 REST

`/status.sessionWorkflows=true` 表示后端已启用一次性延迟消息、SessionManager 分叉/复制、最近一轮编辑重试和旧版本恢复。新接口位于 `/sessions/:id/{workflow,prompt/:entryId,fork,retry,restore,deferred}` 与 `/sessions/:id/deferred/:jobId`，完整请求、状态和限制见 [SESSION_WORKFLOWS.md](SESSION_WORKFLOWS.md#rest-契约)。所有接口仍复用 token/Origin/项目根与 session ID 校验。

`/status.replyFork=true` 标记已支持回复后分叉：`GET /sessions/:id/workflow` 增加 replies（entryId、timestamp、文本预览）；`POST /sessions/:id/fork` 新增可选 `position=at`，必须同时提供一个已完成且无工具调用的文本 assistant entryId，返回 draft=null。省略 position 仍从用户问题之前分叉，省略 entryId 仍复制当前活动分支。任意其他 position、错误角色、未完成/toolCall 消息会被拒绝，不退化为 clone。

`/activity.deferred` 仅含各线程 cwd/sessionId/count/attention 和可选通用存储错误，不含待发送正文。普通 `get_state` 另含 `webOperation` 布尔值。回退后向全部当前订阅者广播 `gateway_context_changed`，浏览器重读原生消息/状态。原生 fork/clone/navigate 命令没有直接加入透传白名单。

## 3. Pi WebSocket

路径：`/api/pi/ws`。

每条浏览器命令包含 request ID。第一条消息必须是 `open_session`、`open_ephemeral`，或持有已准备票据的独立侧聊 `open_side_chat`；认证失败使用 WebSocket close code `4401`。

### 3.1 打开持久 session

```json
{
  "id": "browser-1",
  "type": "open_session",
  "token": "optional",
  "cwd": "/workspace/demo",
  "sessionId": "01..."
}
```

成功 response：

```json
{
  "type": "response",
  "id": "browser-1",
  "command": "open_session",
  "success": true,
  "data": {
    "session": {},
    "state": {},
    "messages": { "messages": [] },
    "stats": {},
    "models": { "models": [] },
    "thinkingLevels": { "levels": [] },
    "commands": { "commands": [] }
  }
}
```

成功 response 的 snapshot 额外包含 `completion`（读取消息前捕获的当前未读标记或 null）和 `pendingUi`（此 runtime 尚未响应/超时的 extension 对话请求，含 `expiresAt` 或 null）。`get_messages` 成功 data 同样携带读取前捕获的 `completion`。Web 只确认已经渲染的对应标记，不将较新的标记误报已读。

### 3.2 打开临时 no-session runtime

```json
{
  "id": "browser-temp",
  "type": "open_ephemeral",
  "token": "optional",
  "cwd": "/workspace/demo"
}
```

服务端使用官方 `pi --mode rpc --no-session`。snapshot 与持久 session 结构相同，但：

- `session.ephemeral` 为 `true`。
- `session.path` 为 `null`。
- `state.sessionFile` 缺失。
- 不创建 session JSONL。
- WebSocket 断开时 worker 立即结束。

### 3.3 退出 runtime

```json
{ "id": "browser-quit", "type": "quit_session" }
```

这是 gateway 本地命令，不转发给 Pi prompt。持久 session 的 worker 被停止但 JSONL 保留；临时 worker 被销毁。成功返回：

```json
{ "quit": true }
```

### 3.4 允许转发的 Pi RPC 命令

gateway 当前白名单：

| 分类 | 命令 |
|---|---|
| 提示 | `prompt`, `steer`, `follow_up`, `abort` |
| 状态 | `get_state`, `get_messages`, `get_session_stats` |
| 模型 | `get_available_models`, `set_model`, `cycle_model` |
| 思考 | `get_available_thinking_levels`, `set_thinking_level`, `cycle_thinking_level` |
| 压缩/重试 | `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry` |
| Session 只读/命名 | `get_entries`, `get_tree`, `get_fork_messages`, `set_session_name` |
| 资源命令 | `get_commands` |

`get_tree` 保留原生只读透传；新会话树 UI 使用独立有界 `get_session_tree`，导航只走受控 `navigate_history`。原生 `clear_queue` 仍未作为裸命令开放；主会话改由 `stop_and_recover` 先取回再 abort，`take_queue` 仅取回，`ack_recovery` 按组 ID 移除结果。队列文字、取回列表、停止状态与扩展文字状态以 controls 快照/修订事件同步，详见 [NATIVE_CONTROLS.md](NATIVE_CONTROLS.md)。Pi 0.85.0 abort 允许取消压缩，runtimeControls 启用后压缩期间显示该入口。

浏览器本地分派内置 slash command 到对应 Web 操作，包括 `/model`、`/thinking`、`/settings`、`/session`、`/name`、`/new`、`/resume`、`/fork`、`/clone`、`/compact`、`/copy`、`/quit`、`/reload` 等。`/templates` 打开设置中的 Skills/提示词模板入口；命令/Skill/模板与项目文件直接通过输入框 `/`、`@` 联想，不另开资源面板。加号只协调既有附件选择与延迟发送窗口，不新增业务请求。未接入的分享命令明确标注，不转发给模型；`/tree` 在 sessionTree 启用后打开历史页会话树，只接收无参数入口，不直接导航或调用模型。新后端 `/trust` 打开当前项目的独立信任窗口，`/scoped-models` 打开 Pi 配置并展开常用模型所属分类。项目菜单可直接管理该项目的信任，不切换线程；会话详情按需读取 `get_native_resources`。Skills 页的可恢复启停复用 `/settings/native/resources`，不删除文件。模型高级 JSON 和手写 Skill 编辑器已从网页移除，相关 REST 继续兼容。导入/导出通过项目/线程菜单的 REST 实现；本地 `/import`、`/export` 同样打开对应窗口，不接收参数，不透传终端命令或文件路径。

这些 Web 操作命令不会作为普通用户 prompt 发送；`reload_resources` 只在空闲互斥区通过私有内部扩展调用公开 ctx.reload。模板和 Skill 的原始命令交给 Pi 展开，运行中仍用 steer/follow_up；扩展命令用 prompt 进入原生命令分派。完整映射见命令文档。

通用成功 response：

```json
{
  "type": "response",
  "id": "browser-2",
  "command": "get_state",
  "success": true,
  "data": {}
}
```

通用失败 response：

```json
{
  "type": "response",
  "id": "browser-2",
  "command": "get_state",
  "success": false,
  "error": "..."
}
```

### 3.5 Prompt

```json
{
  "id": "browser-3",
  "type": "prompt",
  "message": "Inspect this file",
  "images": [
    { "type": "image", "mimeType": "image/png", "data": "base64..." }
  ]
}
```

运行中消息使用 `steer` 或 `follow_up`，payload 相同。网页同时显示发送和停止按钮，选择投递模式后可点击发送；压缩/停止处理中或断线时禁发。原生消息 stopReason=aborted 的 errorMessage（例如 Request aborted）表示回复取消的原因，网页展示为“回复已停止”并保留可展开的原始原因；不能据此把失败的停止 RPC response 转为成功。

限制：

- `message` 最长 400000 字符。
- 图片最多 6 张。
- MIME 仅 PNG/JPEG/WebP/GIF。
- 图片 base64 字符串总长度最多 24 MB。
- WebSocket `maxPayload` 32 MB。

浏览器附件入口：加号中的“添加附件”/粘贴真实文件/拖放共用客户端校验，主框最多 8 个附件，最多 6 张单张 6 MiB 的 PNG/JPEG/WebP/GIF，文本附件单个 1 MiB 且必须 UTF-8。添加与发送前检查上述 message/images 总量，不再等 gateway 拒绝后丢失草稿。文本文件名 XML 转义后包入 `<attached_file>` 并并入 message；图片仍是既有 base64 block。未新增服务器上传接口/存储、未改变上述 gateway 限额。PDF/Office/压缩包/HEIC 及文件夹不支持。

发送成功确认才清除匹配主稿；错误保留，超时/断线结果不明时重发/预约前要求确认。该保护仅页面内存，不构成服务端幂等或刷新后草稿恢复。纯文件名剪贴板内容仍为普通文本，HTTP 下不调用主动 Clipboard API。

### 3.6 模型和思考

```json
{
  "id": "browser-4",
  "type": "set_model",
  "provider": "provider-id",
  "modelId": "model-id"
}
```

```json
{
  "id": "browser-5",
  "type": "set_thinking_level",
  "level": "medium"
}
```

可用思考等级必须先取 runtime 结果，不要假设所有模型支持完整等级。

### 3.7 Extension UI response

Pi extension 的 `extension_ui_request` 是事件。浏览器回复：

```json
{
  "type": "extension_ui_response",
  "id": "extension-request-id",
  "value": "selected value"
}
```

也可以使用 `confirmed` 或 `cancelled`。该消息单向写入 Pi stdin，不产生普通 correlated response。Gateway 只转发仍有效的待处理 ID，首次响应后移除；重复或已过期响应不会再次送入 Pi。

Gateway 在响应或 timeout 时向订阅者发送 `{ "type": "gateway_ui_resolved", "id": "extension-request-id" }`，关闭各浏览器中过期面板。待确认内容只在当前 runtime 内存/snapshot/订阅事件中出现，不进入全局 activity 或工作台偏好；runtime 销毁后不恢复。运行中发出的请求也在 `agent_settled` 时清理。当前 RPC UI 子协议不单独通知 extension 自定义 AbortSignal 撤销；独立于 Agent 运行的交互应提供 timeout，避免没有生命周期结束信号的悬挂请求。0.84.4 新增的 `ui_prompt_start/end` 是 extension 生命周期事件，不应当作已收到的 RPC UI 失效通知。

### 3.8 压缩状态与限制

`get_state` 及初始 snapshot 的 `state` 额外包含 `webCompaction`（null 或 object）：

```json
{
  "status": "success",
  "reason": "manual",
  "startedAt": 1788740000000,
  "finishedAt": 1788740005000,
  "tokensBefore": 60000,
  "estimatedTokensAfter": 4500,
  "willRetry": false
}
```

- status：`running`、`retrying`、`success`、`cancelled`、`unchanged`、`error`。`unchanged` 对应原生 Already compacted/Nothing to compact，RPC 本身仍返回原始失败 response。
- retrying 可含 `attempt`、`maxAttempts`、`delayMs`；error 可含 `errorMessage`。字段来自 RPC 事件，缺失时不推断。
- 只保留当前 worker 最新结果，不含摘要/消息正文，不写 preferences，不出现在全局 activity。worker 重建后返回 null。
- 手动压缩请求必须在 worker 空闲时执行；同时提交的压缩只转发第一条，其他返回失败。压缩期间拒绝 prompt/steer/follow_up 和模型/思考切换，避免中断或重入。
- `customInstructions` 可选，必须为最多 10000 字符的 string。`set_auto_compaction`、`set_auto_retry` 的 enabled 必须是 boolean。
- gateway compact 等待 10 分钟；超时不是取消，仍保留 runtime busy。浏览器等待 11 分钟并在错误后同步状态，不自动重发 compact。
- 0.85.0 原生 `abort` 可取消手动压缩并等待空闲；runtimeControls 后端通过 stop_and_recover 对应网页取消入口。`quit_session` 终止整个 runtime，不能描述为只取消摘要。
- `get_session_stats.contextUsage.tokens/percent=null` 表示压缩后尚无新 usage，必须显示未知，不是零；`estimatedTokensAfter` 只是摘要结果中的消息估计，不能冒充 provider 统计。

### 3.9 事件

除 gateway 自定义 `gateway_error`、`gateway_ui_resolved` 外，服务端原样转发 Pi RPC 事件。当前前端处理：

- `agent_start`, `agent_settled`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `queue_update`
- `compaction_start`, `compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `summarization_retry_scheduled`, `summarization_retry_attempt_start`, `summarization_retry_finished`
- `extension_ui_request`（另将 setStatus/setWidget/setTitle 当前文字状态保留于 controls，重连恢复；TUI 自定义组件仍不支持）
- `gateway_commands`（显式重载后同步当前可用命令，去除内部导航命令）
- `extension_error`（保留原生扩展错误，不冒充普通回复或执行成功）
- `gateway_controls`（主会话运行队列、取回列表和扩展状态的有修订内存快照）
- `gateway_error`

新增 Pi event 支持时，优先保持透传，在 `pi-chat.js` 增加渲染分支。

Web 的“正文 / 完整记录”是纯本地展示模式，不新增 REST/RPC，不影响模型输入或 Pi session。默认正文保留所有普通文字，连续 thinking/tool/bash 收为执行记录；工具结果按 toolCallId 填回调用详情，孤立结果仍可查看。失败工具不强制展开，最终失败/停止提示及待确认请求仍显示。`localStorage.pi.web.transcriptMode` 仅保存模式，展开状态不持久化。

“本轮文件”的操作记录派生自 get_messages/打开快照：按原生 user 分段，关联成功 edit 的 toolCallId/path 与 details.patch/diff，以及成功 write 的 path/content；实时尾段在 agent_settled 后重读快照才显示。bash、失败或孤立工具结果不计入，原执行记录仍保留。各次编辑行数为累计而非净变化；写入不能无基线标为新建。刷新从仍可用的快照重建，不创建持久文件审计。用户选择“当前文件”时另调用受控 GET `/files/content`，与历史工具内容分开标注；详见 [FILE_VIEWER.md](FILE_VIEWER.md) 和 [NATIVE_CONTROLS.md](NATIVE_CONTROLS.md#本轮编辑记录)。

### 3.10 BTW 临时侧聊

`GET /status.sideChat=true` 表示 Web 侧聊已启用，`sideChatContext=true` 表示新增的有效上下文快照路径。主连接成功打开后调用 `prepare_side_chat`：默认 mode=context，读取主原生上下文和系统提示；另有 quote/blank。旧客户端明确提交 recent、count=6/12 时保留旧摘录语义；新页面在新能力启用后隐藏这两个选项。

返回 60 秒一次性的 ticket、reference 与 limits。完整 reference 只有 source、capturedAt、messageCount、toolCalls/toolResults、summaryCount、systemIncluded、images/omittedImages/omittedThinking、estimatedTokens/tokenBudget/outputReserve、frozen 和 toolFormat metadata；preview 为空，不返回系统提示、工具正文或初始化 entries。

完整背景按模型窗口预留回答空间，取消固定 8192-token 限制；超限报错，不截断或单独生成摘要。单份 32MiB、待领取合计 64MiB，超过内存额度拒绝。当前 Pi 的 context/before_provider_request 临时 hook 改写不保证继承。

另开 `/api/pi/ws`，首条发 `open_side_chat`（ticket、普通 token、request id）；不能在现有主连接上打开侧聊。成功返回 state/reference/limits/messages/stats/retainOnSwitch，侧事件只发送到这条连接。每个主连接一次最多一段准备/创建，全服务最多四个名额，后台保留也计入。

`/status.sideChatRetention=true` 启用持久主会话的可选 `prepare_side_chat.retainOnSwitch` 布尔参数。true 表示已领取的侧聊可随其独立侧连接存活，主连接释放不销毁该段；未领取票据和准备中快照仍撤销。临时主会话请求 true 拒绝；省略时保持旧生命周期。侧连接关闭始终结束该 worker，不停止主 worker。前端本页按 cwd/sessionId 最多保留三段，只恢复已有连接，不提供跨页/刷新后重接 API。

Web 删除源线程及显式 quit_session 清理该源的全部侧聊（含脱离父连接者），并在关闭前发送 `{type:'gateway_side_parent_ended', reason:'deleted'|'quit'}`；deleted 时前端清理对应页面缓存。鉴权仍逐侧连接验证与撤销；没有新增历史存储、模型执行权限或自动投递。

侧连接允许 prompt、abort、get_state、get_messages、get_session_stats、quit_side_chat；assist 模式另允许 answer_side_confirmation。prompt 仅含普通文本（不接受 images/streamingBehavior），拒绝斜杠命令。超时/不确定投递后再次提交需 confirmUncertain=true，仍不能在忙碌期间重复提交。失败可带 errorCode。原始 bash/extension_ui_response 和其他管理/排队命令、嵌套侧聊均拒绝；Agent builtin 工具通过原生执行与下面的确认机制运行。

`/status.sideChatTools=true` 表示支持 `prepare_side_chat.toolMode='assist'|'none'`。新页面默认 assist；省略字段保持旧客户端 none。assist 下 context/quote/blank 均通过 SDK 内存会话运行，模型可见 read/grep/find/ls/edit/write 和平台命令工具。修改/命令的本次回复授权通过原生 `tool_call` + `ctx.ui.confirm` 发起，读取不额外确认。

`state` 增加 toolMode、toolAccess（none/read/write）和 pendingUi（本侧有效确认）；权限更新事件 `{type:'gateway_side_tool_access', access:'read'|'write'}`。回答确认发送 `{type:'answer_side_confirmation', requestId, confirmed:boolean}`，只接受本段 worker pendingUi 中未过期的确认，返回 accepted:true 只表示交付确认，不能视为工具成功。过期/重复/伪造 ID 拒绝，不能回答主会话或其他侧聊的确认。原生 gateway_ui_resolved/agent_settled 清除界面状态，五分钟未处理按拒绝，不重放。每段独立渲染确认和工具结果；后台确认不会借用当前其他线程弹窗。

Web `/btw [问题]` 本地路由到侧聊，不进入主 prompt/steer/follow_up；网关同样阻止这种误透传。2026-09-09 前端只提供“接着当前任务聊”（context）和“单独问个问题”（blank）两个主要选择，旧后端仍显示明确标为旧版的 recent 选项；不再有回复末尾入口或选中文字自动引用。quote API 保留兼容既有页面，协议和票据不变。引用冻结，更新引用重新创建临时 runtime，不改主 session。新默认由 SDK 内存 SessionManager + 官方 RPC runner 承载，旧模式继续 CLI no-session；新 get_messages 只返回隐藏边界之后的侧消息，计费/计数扣除继承部分。内部 get_entries 和快照控制命令不开放给侧浏览器，compaction retainedTail 不透传。全部字段与生命周期见 [SIDE_CHAT.md](SIDE_CHAT.md)。

### 3.11 历史搜索与书签

- `search_history`：`{q?,scope?:'branch'|'all',filter?:'all'|'conversation'|'user'|'assistant'|'tool'|'summary',bookmarked?:boolean,offset?:number,revision?:string}`；返回 revision/leafId/results/total/offset/hasMore/pageSize=30。翻页需要原快照 revision，追加记录或标签变化后旧分页拒绝。
- `get_history_entry`：`{entryId,offset?:number,view?:'body'|'record'}`；返回文字分页与图片数量、分支归属、书签和修订，不返回图片原件或隐藏思考/签名。
- `set_history_bookmark`：`{entryId,label,expectedBookmarkRevision}`；label 最多80字，空字符串移除；返回 entryId/label/bookmarkRevision/leafId。首次没有标签的修订为 `none`，随后为最新原生 label entry ID。冲突保留原标签，不自动覆盖。
- `gateway_history_changed`：仅 `{entryId}` 的书签更新通知，不是助手回复，不创建未读完成标记。正文响应只返回请求者；内部 pi5History notify 不透传。

原生 setLabel 追加 metadata，因此 leaf ID 会推进，但原活动路径的消息顺序不变。预览不导航，标签不回滚文件。写超时不重试，查询仍可用于核对；运行中任务不被自动中断。预算与第一条 assistant 保存前的限制见完整历史文档。

### 3.12 手动 Shell 与队列投递模式

`userShell=true`启用主连接的受控`bash`/`abort_bash`，`queueModes=true`启用`set_steering_mode`/`set_follow_up_mode`。这些命令不加入裸RPC白名单；只在已打开且已认证的主会话处理，侧聊拒绝。

- bash接受`{command,excludeFromContext?:boolean}`，非空且最多32768字符，未知字段/NUL拒绝。成功data为服务器接收时的Shell快照，原生执行结果之后通过gateway_shell/原生历史同步；不是完成响应。
- abort_bash接受`{executionId}`，必须匹配当前running命令；停止ACK不解除占用。get_state增加webShell，gateway_shell含shell快照；runtimeId/revision、busy、当前job和有限输出尾部见完整文档。
- set_steering_mode/set_follow_up_mode接受`{mode:'all'|'one-at-a-time',runtimeId,revision}`。成功返回webQueueModes形状并广播gateway_queue_modes.modes，原生setter同步当前实例并保存全局默认，项目覆盖仍有效，其他已启动实例不自动更新。

Shell仅空闲单项执行，期间消息/压缩/导航/重载及预约投递互斥；activity.busy与回收同样计入。内部原生执行请求无普通30秒等待超时，断线/超时不重放，完整输出路径不授予下载权。字段、预算、扩展与临时生命周期见 [WEB_SHELL.md](WEB_SHELL.md)。

## 4. Web 设置 API

所有路径前缀为 `/api/pi/settings`，复用 `/api/pi` 的 Origin 和可选 token 校验。任何 response 都不会包含 API Key、OAuth token、credential 内容、models.json headers 或 inline key。

### 持久会话用量

`/api/pi/status.usageStats=true` 启用 `GET /api/pi/settings/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&timeZone=Asia%2FShanghai`。日期包含两端，最多366天，时区缺省UTC；非法或未知参数400、其他筛选扫描中429、线程失败503，复用Origin/Bearer与no-store。返回 total/daily/providers/models/projects/sessions、generatedAt、coverage及partial，不含聊天正文。原生副本去重、所有分支/摘要用量、缺失字段、15秒缓存及读取预算见 [USAGE.md](USAGE.md)。不创建RPC worker、不读客户端指定路径或持久保存统计。

### Provider 和模型

| Method | Path | 用途 |
|---|---|---|
| GET | `/models` | Provider auth 状态、脱敏模型目录、默认值、自定义配置摘要 |
| POST | `/providers/:id/api-key` | 通过 `ModelRuntime.login(..., "api_key")` 持久保存新 Key |
| DELETE | `/providers/:id/credential` | 通过 `ModelRuntime.logout()` 删除 stored credential |
| POST | `/models/refresh` | 强制刷新已配置动态 Provider catalog |
| POST | `/models/preferences` | 设置完整 Pi Agent 的全局默认 Provider/模型和可选 enabledModels |
| PATCH | `/media-agent` | 设置模块 Agent 的 Provider/模型；下一次 plan 立即生效 |
| POST | `/models/test` | 发起真实最小模型请求，返回 latency/text/usage |

保存 Key body：

```json
{ "apiKey": "new-secret-value" }
```

Key 只作为 request body 进入服务端，现有值永不回显。此单字段 API 兼容保留；新网页使用下列 Pi 原生多步骤登录入口，API Key 输入按 Pi config-value 字面量转义。

新增 API（由 `/status.providerLogin`、`modelThinking` 标记）：

| Method | Path | 用途 |
|---|---|---|
| POST | `/providers/:id/login` | `{method:"api_key"或"oauth"}` 启动原生 AuthInteraction，返回私有登录状态 |
| GET | `/login/:id` | 轮询状态/交互，含 revision 和有效 prompt ID，无已提交回答或 credential |
| POST | `/login/:id/answer` | `{promptId,value}` 回应一个有效步骤；旧步骤/重复提交 409 |
| DELETE | `/login/:id` | 取消未完成登录，返回真实状态；取消可能与原生凭据提交相遇 |
| PUT | `/models/thinking` | `{provider,modelId,expectedRevision,defaultThinkingLevel?,thinkingLevelMap?}` |

一次最多一个登录、10 分钟过期；私有随机句柄仅保留在发起页面内存。支持 secret/text/select/manual_code、授权 URL、设备码、info 链接和进度；单回答最多 32768 字符，选择必须匹配官方选项。未知句柄 404，流程占用/修订冲突 409，非法字段 400。原生逐 prompt AbortSignal 撤销已被 callback 完成的手动输入，旧回答不转发。初始 200 不代表凭据已保存；终态包括 success/committed/cancelled/expired/error，committed 表示凭据已提交但模型同步失败，禁止自动重放。所有 settings 响应 no-store。

`GET /models` 新增 providerLogin/modelThinking、revision、thinkingMapKeys；模型含官方实际 thinkingLevels/thinkingLevelMap，preferences 含全局 defaultThinkingLevel 与逐模型 modelThinkingLevels。Thinking 默认 null 删除逐模型覆盖；map null 删除本地 map 恢复 Pi 原始能力，object 使用字符串映射/null 禁用，省略键沿用 Pi 定义。能力通过官方 getSupportedThinkingLevels 校验；不能禁用全部等级或留下失效的逐模型默认。保存内置模型到 modelOverrides、自定义模型到 models，保留未知字段、费用、兼容配置及 0600 backup；默认写原生 SettingsManager。完整协议、失败及远程 OAuth 限制见 [PROVIDER_SETTINGS.md](PROVIDER_SETTINGS.md)。

模块 Agent preference body：

```json
{ "provider": "my-provider", "modelId": "planner-model" }
```

服务端只接受 `ModelRuntime.getAvailable()` 中当前已认证的模型，并原子写入 0600 的 `~/.pi/agent/pivane-workspace.json`（已有旧 `pi5-workspace.json` 时沿用）。它不会修改 Pi Agent 默认模型，response 不包含 credential。

模型测试 body：

```json
{
  "provider": "provider-id",
  "modelId": "model-id",
  "prompt": "Reply with exactly: OK"
}
```

测试使用真实 Provider，会产生少量 token/费用；无工具，最大输出 64 token，90 秒超时。

### 回复朗读默认配置

`/status.replyTts=true` 启用最终回复 TTS 入口。`GET /api/pi/settings/reply-tts` 返回动态语音 models/textFields、defaults、revision、hasSavedDefaults 和失效提示 warning。`PUT` 只接受 `{modelId, textParameter, parameters, expectedRevision}`，parameters 禁止包含正文对应字段；动态模型/参数验证后写入工作台 replyTts 偏好，0600 原子保存，不产生媒体或更改聊天模型。非法参数 400，缺失／过期修订或并发覆盖 409；沿用 Origin/token，响应不缓存、不含凭据。完整字段见 [REPLY_TTS.md](REPLY_TTS.md)。

朗读按用户喇叭点击授权当前回复和默认参数，前端自动调用 `/api/pi/media/lab/review` 和 `/execute`，仍只传服务器票据，不增加直连 TTS 执行接口；其他实验室生成继续保留清单确认。正常朗读无需再次弹窗，生成中可继续聊天，完成后尝试自动播放；浏览器拦截时手动播放已有音频。生成音频进入原语音历史，不写 Pi session。

### 自定义 models.json

| Method | Path | 用途 |
|---|---|---|
| POST | `/custom-providers` | 新增/更新自定义 Provider |
| DELETE | `/custom-providers/:providerId` | 删除 Provider 及其模型配置 |
| POST | `/custom-providers/:providerId/models` | 新增/更新模型 |
| DELETE | `/custom-providers/:providerId/models/:modelId` | 删除模型 |

Provider body：

```json
{
  "id": "my-provider",
  "baseUrl": "https://api.example.com/v1",
  "api": "openai-completions",
  "authHeader": true
}
```

支持的 models.json API：`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`。

模型 body 支持 `id`、`name`、`reasoning`、`imageInput`、`contextWindow`、`maxTokens`、可选 `api` 和 `thinkingLevelMap`。Model ID 最多 500 字符，允许 `/`、`:`、`@` 等供应商标识但拒绝空白/控制字符；作为模型标识，不是路径。Provider base URL 只允许 HTTP(S)，拒绝 userinfo/query/fragment。写入保留未知字段，建立 0600 backup 后原子替换。删除内置 Provider 的本地覆盖仅删配置，保留其原生凭据。

### Packages 和 Skills

| Method | Path | 用途 |
|---|---|---|
| GET | `/resources?cwd=<path>` | Packages、resolved resources、Skills 和 diagnostics |
| POST | `/packages/action` | 全局 install/remove/update |
| POST | `/skills` | 创建 `~/.pi/agent/skills/<name>/SKILL.md` |
| DELETE | `/skills/:name` | 删除 Web 可管理的用户 Skill |
| PATCH | `/skill-commands` | 开关全局 `/skill:name` command |

Package action body：

```json
{
  "action": "install",
  "source": "npm:@scope/package@1.0.0",
  "cwd": "/workspace/demo"
}
```

`action` 仅允许 `install`、`remove`、`update`。该兼容端点管理global scope；项目scope使用原生设置API，见NATIVE_SETTINGS.md。Package安装可能运行任意代码，UI必须确认。

Skill 创建 body：

```json
{
  "name": "my-skill",
  "description": "What it does and when to use it.",
  "body": "# Instructions"
}
```

设置写入通常只对新 runtime 生效，API 返回 `requiresRuntimeRestart=true`。服务端不会因此自动终止正在运行的 Agent。

## 5. 多媒体实验室与 Media Agent

### 实验室 API

以下完整路径均复用 Pi Origin/可选 token 校验，响应不缓存；POST 需要 JSON 对象。

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/pi/media/lab` | 动态模型目录、参数和要求，不含连接/凭据 |
| POST | `/api/pi/media/lab/models` | `{model, confirmed:true}` 添加本地 manual/HTTP JSON 模型，不覆盖已有 ID |
| GET | `/api/pi/media/lab/docs` | 接入协议 Markdown，仍需 token |
| POST | `/api/pi/media/lab/plan` | `{kind, selectedModelId, instruction, parameters, cwd?}`，受限 Pi 单项规划 |
| POST | `/api/pi/media/lab/review` | `{modelId, parameters, source?:{imageData?,imageUrl?}}`，返回规范参数、warnings、source 和 10 分钟 ticket |
| POST | `/api/pi/media/lab/execute` | 只接受 `{ticket, confirmed:true}`，执行该服务器票据 |
| GET | `/api/pi/media/lab/history?kind=image\|video\|tts` | 只读旧、新媒体记录，不自动导入或改写 |
| DELETE | `/api/pi/media/lab/history/:kind/:id` | 明确删除选中的本地文件和记录 |

plan 不生成、不取得 ticket；review 不生成。两者都验证实时模型定义和参数类型/范围/固定值。浏览器可修改清单，修改后原生成按钮失效，需要重新 review。execute 不接受参数覆盖，不能通过重复同一票据再次生成；运行中 409，完成后返回原结果，失败/不确定 409，缺票据 404，未配置执行器 503，并发/容量满 429。服务最多两项执行、100 条票据，保留 payload 总计 64MiB；票据不落盘，重启失效。

HTTP JSON adapter 返回值与原执行器一起置于 `{ok, kind, modelId, result}`，result 含 asset、image、video 或 historyItem。history API 增加统一 kind/url，不重写原记录。后端超时/断线不代表远端任务取消，不自动重新提交。完整字段、模型接入限制和错误语义见 [MEDIA_LAB.md](MEDIA_LAB.md)。

`mediaConnections=true` 表示已启用媒体 Provider/模型/Key 管理、HTTP 输出/轮询与文档接入草稿；`GET /api/pi/media/lab` 同样提供该标志供旧前端降级。完整 CRUD、probe、connection-plan 和 execution 状态契约见 [MEDIA_CONNECTIONS.md](MEDIA_CONNECTIONS.md)。

`GET /api/pi/media/lab/activity` 只返回 `{running, connectionMutation, connectionOperations}` 内存计数，供部署空闲检查；不包含参数、Key 或媒体历史。配置操作需要 expectedRevision 与 confirmed=true，冲突或执行期间改配置返回 409。Key 不回显，域名变化需重新绑定；新托管模型编译为 `media:<providerId>:<modelId>`。

### 旧受保护 planner API（兼容）

路径使用 `/api/pi/media` 前缀，继承 Pi Origin/Token 校验。

| Method | Path | 用途 |
|---|---|---|
| GET | `/capabilities/:kind` | 返回 `image`、`video` 或 `tts` 当前 capability |
| POST | `/plan` | 启动受限 no-session Pi planner，返回 canonical MediaPlan |

Plan request：

```json
{
  "kind": "image",
  "instruction": "生成两张雨夜电影感肖像",
  "cwd": "/workspace/demo",
  "current": {
    "model": "z-image-turbo",
    "width": 480,
    "height": 832
  }
}
```

可选 `provider`/`modelId` 显式指定已认证 planner，优先于已保存的媒体规划辅助模型。显式或已保存的专用模型不可用/失败时不换模型。两者均未指定时，按 `PI_MEDIA_PLANNER_MODEL`、Pi default 和可用模型采用原有自动候选规则；没有内置个人 Provider。

成功 response：

```json
{
  "ok": true,
  "plan": {
    "version": 1,
    "id": "plan-uuid",
    "kind": "image",
    "summary": "...",
    "jobs": [{}],
    "execution": { "mode": "manual", "count": 2, "concurrency": 1 },
    "warnings": [],
    "createdAt": "..."
  },
  "plannerModel": { "provider": "my-provider", "modelId": "planner-model", "name": "Planner Model" },
  "fallbackUsed": false,
  "failedAttempts": []
}
```

`failedAttempts` 只包含 provider、modelId 和截断错误，不包含 credential。所有 planner worker 在成功、失败或 timeout 后 dispose。

### Pi Package 只读/校验 API

新accessControl后端同样保护本组接口；“只读/校验”描述副作用，不表示匿名开放。内部进程凭据仅允许指定规划端点，独立CLI配置自己的工作台Token，见访问控制文档。

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/media-agent/capabilities/:kind` | Pi extension 读取当前 capability |
| POST | `/api/media-agent/validate` | Pi extension 提交 raw tool plan，服务端返回 canonical plan |

Validate body：

```json
{ "kind": "video", "plan": {}, "current": {} }
```

这些接口没有生成、删除或历史写入副作用。capabilities 增加 lab.models；validate 根据 plan.modelId 分派新实验室或旧 MediaPlan 校验，均不签发执行票据。旧工具的多项 jobs 不表示已支持批量执行。

完整 MediaPlan 和字段范围见 `docs/MEDIA_AGENT.md`。

## 6. 媒体和历史 REST API

这些接口保留历史业务格式；新accessControl后端已将它们与静态媒体统一纳入访问验证和Origin检查。旧进程在重载前仍没有该保护。

### 图像和 prompts

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/history` | 图像历史，最新在前 |
| DELETE | `/api/history/:id` | 删除图像历史及本地文件 |
| GET | `/api/runpod/config` | Z-Image/Flux 2 Dev 模型 profile、默认值和 Flux base URL |
| GET | `/api/runpod/health?model=<id>&baseUrl=<url>` | Z-Image worker 或 Flux ComfyUI nodes/weights 状态 |
| GET | `/api/runpod/models` | `z-image-turbo`、无 LoRA 变体和 `flux-2-dev` |
| GET | `/api/runpod/loras` | Z-Image LoRA 列表；Flux 不使用该列表 |
| POST | `/api/runpod/generate` | 按 model 分派 Z-Image worker 或 Flux 2 Dev ComfyUI workflow |
| POST | `/api/sd` | 旧 shell SD 路径，HTTP 410 |
| GET | `/api/models/sd` | 空兼容列表 |
| GET | `/api/models/lora` | 空兼容列表 |
| GET | `/api/prompts` | 已保存提示词 |
| POST | `/api/prompts` | 保存提示词 |
| DELETE | `/api/prompts/:id` | 删除提示词 |

### 视频

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/video/config` | MiniMax H3/H3 Max、分辨率、时长、画幅和脱敏 configured 状态 |
| GET | `/api/video/health` | MiniMax credential 可用状态，不回传 Key |
| GET | `/api/video/history` | 新旧统一视频历史 |
| POST | `/api/video/generate` | 创建 H3 V2 任务、轮询、下载并记录本地历史 |

生成 body：

```json
{
  "model": "MiniMax-H3",
  "prompt": "A slow cinematic push in",
  "resolution": "768P",
  "duration": 8,
  "ratio": "9:16",
  "imageData": "data:image/png;base64,...",
  "imageUrl": "/images/existing.png"
}
```

`imageData`/`imageUrl` 均可省略，此时是文本生成视频。首帧存在时 ratio 强制规范为 `adaptive`。上传限 PNG/JPG/WEBP、20MB；本地 URL 只允许 `/images/`。成功后返回本地 `/videos/...mp4`。

旧 `/api/runpod/video/config`、`health`、`generate` 返回 HTTP 410；旧 history 路径 307 到 `/api/video/history`。旧 Wan/LTXV 文件和历史不删除。完整协议见 `docs/MINIMAX_H3.md`。

### TTS

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/tts/config` | 动态 Provider、模型、音色、语言、限制和控件；adapter settings/凭据不返回 |
| GET | `/api/voices?provider=<id>&model=<id>` | 兼容音色查询，按 Provider/模型返回 |
| GET | `/api/tts/providers/:providerId/docs` | 返回该 Provider 的 Markdown 说明文档 |
| POST | `/api/tts` | 使用指定 Provider/模型生成并保存音频 |
| GET | `/api/tts/history` | 音频历史；`limit` 为 1-300 |
| DELETE | `/api/tts/history/:id` | 删除历史和音频文件 |

生成 body 示例（需在本地 registry 配置对应模型与音色）：

```json
{
  "text": "需要朗读的内容",
  "provider": "breeze-gpu",
  "model": "BreezeBlue/breeze-tts-2",
  "voice": "my-voice",
  "language": "chinese",
  "speed": 1,
  "options": {
    "instruction": "使用清晰、自然的标准普通话。",
    "cfgScale": 4,
    "seed": 17
  }
}
```

server 根据 config allowlist 校验 provider/model/voice/language/options。动态控件支持单行文本、多行文本和数值类型，数值由服务端检查范围及整数约束，浏览器不能提交任意远端参数。

Breeze 当前只接入 Voice Design：支持中文/英文、1200 字符、最长 150 字符 instruction、`0.5–6` CFG 和非负 32-bit seed。adapter 通过 stdin 发送 multipart，接收裸 24 kHz PCM 并封装 WAV；数值语速转换为自然语言 instruction。Voice Clone 的参考音频上传尚未实现。

当前 fast warmup profile 的 text encoder/backbone prefill 只声明到 batch 2/token bucket 512。`/api/tts` 会将长文本优先按标点拆成最多 120 Unicode 字符的段，逐段保持同一 recipe 生成，段间插入 160ms 静音并返回一个 WAV。成功分段时 `warning` 会说明段数，`extraInfo` 增加 `chunkCount`、`maximumChunkCharacters`、`chunkPauseMs` 和每段字符数。直接绕过 Pi 调用原生 8240 不具有这层保护。

Qwen3 继续限制 1200 字符并返回 WAV；MiniMax 配置模型限制为 10000 字符并通常返回 MP3。成功响应和历史包含 `provider`、`providerName`、`model`、`voice`、`voiceName`、`language`、`languageName`、`mimeType` 和 `audioUrl`。Breeze 的 `extraInfo` 还包含实际 instruction、CFG、seed、sample rate、生成耗时、音频时长、RTF、实时倍数及 fast 状态。

媒体 payload 由实时实验室目录和各 adapter 定义。`public/media-lab.js` 只收集字段；Z-Image/Flux 执行在 `server.js`，H3 在 `server/minimax-video-service.js`，TTS 在 `server/tts-provider-service.js`，确认执行控制在 `server/media-lab-service.js`。旧 API 保留兼容，不获得新的 ticket 保护。

## 7. 已删除接口

以下旧聊天接口必须保持不存在，避免形成第二套 Agent 数据：

- `/api/chat`
- `/api/llm/*`
- `/api/models/ollama`
- `/api/chat-sessions*`
- `/api/system-prompts*`

恢复这些路径属于架构回退，除非用户明确要求新的兼容层且不复制 session 状态。

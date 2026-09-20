# Pi 原生配置与扩展接入

## 子 Agent 专属设置

设置 → **模型与能力** 包含多模态与子 Agent 两个分区，子 Agent 适配 `pi-subagents@0.69.0`。`npm ci` 的可选安装阶段单独下载插件，失败不阻断 Pivane；保留已有版本与配置，失败、跳过或卸载后不自动重放。详见[默认可选能力](INSTALL_RECOVERY.md#默认可选能力)。

直接管理全局/项目 settings.json 的 `subagents.defaultModel/defaultThinking` 和 `subagents.agentOverrides.<name>.model/thinking`，只修改提交字段，null 删除本层覆盖，保留工具、提示词、供应商覆盖和未知字段。模型及思考选项来自可用模型目录。本层保存值不是最终运行映射，角色定义、供应商覆盖和单次运行参数仍参与插件优先级。

角色列表是已安装包的随附原生角色与已配置覆盖，可按名称添加自定义角色覆盖；这不创建角色定义，也不完整列举其他包、扫描目录或运行时注册的角色。外部 CLI 角色和完整运行映射应通过插件核对。

网页以可展开角色卡片显示配置，中文名称和用途说明只影响显示，提交的角色标识保持原值。模型选择通过可搜索、可筛选供应商的原生 dialog 完成，结果每批40项，完整可用目录参与搜索。选择暂存于当前范围草稿，保存才提交；“自动选择”对应 null 恢复继承。“撤销修改”仅清除当前范围草稿；关闭选择器、切分类不提交请求。失去可用性的已保存模型继续显示原值，保存成功但后续读取失败时只提示读取失败并允许刷新，不声称已核对状态。接口保持不变。

| 方法 | 路径 | 内容 |
|---|---|---|
| GET | `/api/pi/settings/subagents?cwd` | version/cwd/revision/trust、plugin 状态与版本、defaults、roles；仅返回模型和思考字段 |
| PUT | `/api/pi/settings/subagents` | `{cwd,scope,expectedRevision,changes}`；changes 为 defaultModel/defaultThinking 或 agentOverrides.角色.model/thinking 的扁平键 |
| POST | `/api/pi/settings/subagents/install` | `{cwd,expectedRevision,confirmed:true}`；只补装固定来源到全局，不接受任意包或版本 |

状态为 missing/disabled/unsupported/ready，ready 只表示版本匹配且配置启用，不代表当前 worker 已加载。未就绪时写设置失败；缺失且没有冲突来源时可补装。写入复用 nativeSettingsBusy、身份/Origin、修订和配置互斥；设置保存使用原生 settings 锁、私有备份与原子写入，项目写入要求 trust。

保存不启动子任务或重启服务，任务结束后显式重开运行实例并从当前加载资源核对。关闭页面不取消安装；失败或结果不确定先刷新核对，不自动重放。当前页草稿按项目/范围保留，冲突刷新仍保留草稿，浏览器刷新会丢失草稿。


## 扩展中心

桌面导航、手机项目／线程抽屉顶部与空白会话探索区提供独立的“扩展”入口；手机底栏保持原有布局。扩展中心以精选、已安装扩展包、已安装技能三个页面展示，共用原设置资源控制器与对话框生命周期；设置原资源入口跳转到同一视图，关闭后保留会话、草稿与附件。

精选由 `public/pi-extensions.js` 内的双语元数据目录提供，包含名称、作者、来源、用途、前提与示例，不自动抓取外部内容。收录 PPT Master、pi-mcp-adapter、pi-web-access、pi-computer-use、pi-subagents 和 pi-hermes-memory。每次打开精选、切换核对范围或点击刷新，复用认证 fetch 读取 status 和原生资源清单；默认全局，选定项目时可核对当前项目（含全局）。精确匹配 npm 包身份（忽略版本限定）或已知 GitHub 仓库身份，保留 scope/installed 的实际语义，不依据展示名称或本地目录名猜测安装。

清单包含已安装、已登记但文件未就绪、在所选可见范围未安装，以及无法确认的状态；手动技能来源和未信任项目中的缺失项保持未知。读取失败不保留旧安装标签，刷新不重放写操作。请求序号、当前项目及页面生命周期共同拒绝迟到响应；关闭页面和访问锁定使旧请求失效。状态只在内存展示，不持久化第二套资源库存，也不表示会话已加载或插件已验证。来源链接仅打开原项目；“了解与配置”和“添加自定义”复用扩展助手需求 dialog，并带入所选范围。旧服务没有 extensionAssistant 能力时禁用配置按钮并提示；无法读取原生清单时显示状态待核对。

扩展助手保留办公文档、分析 Excel、排查扩展三个需求气泡；办公文档使用中英文通用 Word/PDF 检查与安装方案文案，制作 PPT 由精选入口提供。

此入口不新增 REST/WS，不执行包安装或模型调用，不改默认安装清单。原范围、trust、revision、确认、忙碌和迟到保护保持；会话加载状态仍需空闲后显式核对。`test/browser/pi-extension-assistant.cjs` 覆盖中英文桌面／手机入口、搜索、来源需求、只读发现、实际子项宽度以及原草稿附件恢复。

## 扩展助手

输入框加号 → **添加能力…**，或设置 → **Packages / Skills → 让助手帮我配置**，可以打开独立的扩展助手会话。包或技能卡片的问号提供“了解这个包 / 技能”和“排查问题”，将准确名称、来源、资源所属范围及当前管理范围带入需求草稿。了解入口要求先只读说明用途、场景、示例和依赖，不安装或执行脚本；这是模型请求约束，不是工具沙箱。选择所有项目或当前项目，填写需求或 GitHub/npm 链接；未选项目时使用默认项目上下文，仅提供所有项目范围。

入口以需求输入为中心，示例为轻量标签；安装范围位于下方，“安装位置与项目”按需展开。底部突出“进入助手”按钮，短屏幕时正文内部滚动，按钮保留在底栏。点击后只创建原生会话，需求放入输入框后由用户发送，不自动调用模型或安装。助手使用正常会话的模型选择与工具权限；已有会话的草稿和附件保留在当前页面内存。“返回原会话”恢复原对话；刷新页面会丢失未发送草稿，但可以从会话列表重新打开扩展助手并继续。返回、关闭或停止不会撤销已经发生的安装。

安装发生在运行 Pivane 的机器上，不是访问网页的电脑或手机。助手先检查已有资源，再检索和比较来源、许可、依赖、平台兼容性。官方来源不等于已适配或获得使用授权；公开下载不自动授予修改或分发权。助手只应在许可允许时适配技能，无法访问来源或验证失败时说明限制。

Pi 包操作使用 `extensions_inventory` 和 `extensions_package`：读取真实配置与修订，展示来源、范围和计划供用户确认，复用设置页的原生安装/更新/移除服务。项目安装仍要求信任；配置冲突或结果不确定时应先刷新核对，不自动重放。独立技能文件和系统依赖由已启用的常规工具在用户授权后配置，未提供统一依赖事务或一键回滚。许可检查、来源审查和这些常规工具操作由 Agent 指引约束，不是工具沙箱。

安装文件、依赖就绪和任务验证分别报告。设置页刷新可查看配置清单；当前已打开的会话需在空闲后显式重新加载资源，不能只凭安装成功认定已加载。凭据通过对应配置/授权入口录入，不发送到聊天里。自动搜索和配置效果取决于所选模型、已启用工具及网络，不保证任意第三方包都能自动安装。

### 扩展助手接口与持久化

`GET /api/pi/status` 的 `extensionAssistant=true` 启用入口；旧后端隐藏按钮。

| 方法 | 路径 | 内容 |
|---|---|---|
| POST | `/api/pi/extension-assistant/sessions` | `{cwd,scope:'global'或'project',language:'zh-CN'或'en',returnSessionId?:string或null}`；拒绝未知字段，验证项目和返回会话，201 返回原生 session 与 assistant 元数据，不调用模型 |
| POST | `/api/pi/extension-assistant/inventory` | `{cwd,sessionId}`；只服务已打开的扩展助手，返回其固定范围的原生资源快照与 revision |
| POST | `/api/pi/extension-assistant/package` | `{cwd,sessionId,action,source,expectedRevision,confirmed:true}`；范围取自原生助手身份，不由调用方覆盖；复用原生包服务的预算、锁、信任与冲突检查 |

原生 `pi5-extension-assistant` custom entry 保存版本、当前 sessionId、安装范围、界面语言和可选返回会话 ID，不保存第二份对话。身份绑定 sessionId，分叉或导入新身份不会因复制旧 marker 自动成为助手。Web 打开会话快照的 `session.assistant` 返回身份元数据；恢复、压缩或资源重载后，扩展按该身份重新加载工具，并在每轮开始追加助手指引，不改全局 SYSTEM/APPEND_SYSTEM 文件。

管理工具使用独立的进程凭据，只授权 inventory/package 两个 POST 端点，禁止重定向；媒体规划凭据的范围不变。REST 仍检查 Origin、实例访问验证及实际会话/worker，返回 no-store。该凭据不进入模型提示、工具结果或 JSONL。它不隔离同一系统用户下的恶意扩展。包确认通过原有 RPC UI；取消不提交，请求中断不表示服务端取消。包写入计入 `nativeSettingsBusy`，不另开同会话 worker。

验证：`test/pi-extension-assistant.test.js` 使用独立身份、合成模型与本地测试包，覆盖原生身份、真实工具调用、确认取消/执行、普通会话工具隔离、凭据范围、Origin、修订冲突及项目 trust。`test/browser/pi-extension-assistant.cjs` 使用合成 REST/WS 覆盖 320/393/1440 宽度、中英文、无项目入口、重复点击、迟到取消、返回后的草稿附件及身份恢复。未进行真实第三方下载或其他平台实机验收。

## 执行记录中的技能与扩展来源

实际工具调用沿用原执行记录，不为设置页读取或启动加载额外生成聊天条目。`read` 请求 `SKILL.md` 时显示“读取技能文件”；这是文件名提示，不证明技能已加载。内置 read 的请求路径若精确匹配本轮 `before_agent_start.systemPromptOptions.skills` 清单，工具结果携带技能名称和路径，显示“读取技能 · 名称”。读取失败仍显示失败，不声称已读完或已遵循技能。

工具调用前从公开 `pi.getAllTools().sourceInfo` 获取注册来源，工具完成时以可选 `details.pi5ToolProvenance` 保存到原生 toolResult，绑定 toolName/toolCallId。包来源显示为轻量“来自…”标记，独立扩展显示“扩展工具”；展开查看完整来源路径和原始工具名。不复制提示正文、工具参数 schema、凭据或完整资源清单。旧记录不通过当前安装状态补造历史来源，未知来源保持原工具名称。元数据是来源说明，不是防篡改审计凭证。

新增 `pi-tool-provenance.js` 在受管 RPC worker 注册只读事件钩子：暂存最多512个调用；来源/path/name有长度预算；结束或关闭时清理。不读取文件、不改变工具参数、正文、错误或用量；特殊 details 类型及同名字段冲突时跳过，不改变第三方结果结构。skills 仅按内置 read 的已加载路径精确匹配，别名路径或自定义 read 不推定归属。工具结果 details 由 Pi 持久化，元数据不进入模型正文，不建第二套历史。

扩展助手的 `extensions_inventory` 与 `extensions_package` 分别显示“检查扩展清单”和安装/更新/移除操作；取消确认时结果提供 `details.pi5PackageOperation.status='cancelled'`，执行记录显示“已取消”。其他状态仍来自真实工具生命周期。正文视图保持原折叠规则，完整视图可逐条核对。

前端刷新后可改善原有工具名称；调用来源采集需要会话 worker 加载新扩展，新建运行实例或空闲时重新加载资源后生效。不会改写以前的 JSONL。`test/pi-tool-provenance.test.js`、真实扩展助手工具测试与 `test/browser/pi-tool-labels.cjs` 覆盖来源快照、字段兼容、持久化、取消、历史/流式同一行、未知来源、安全文本及手机宽度。

## 系统提示词查看与编辑

当前源码以 `/api/pi/status.systemPrompts=true` 启用此功能。设置 → **系统提示词** 提供所有项目/当前项目范围，默认展示追加指令，基础替换折叠在高级区域。支持 Markdown 编辑、清理后的预览、修改区域差异及恢复默认/继承；未选项目时使用合法默认上下文，仅提供全局范围。草稿在本页内存中按项目与范围保留，切换设置分类不丢弃；刷新页面前会提示未保存修改，不保存到浏览器存储。

文件沿用 Pi 原生位置：全局为实际 Agent 配置目录的 `APPEND_SYSTEM.md`/`SYSTEM.md`（默认 `~/.pi/agent`，可由 `PI_CODING_AGENT_DIR` 指定），项目为 `<cwd>/.pi/` 下同名文件。项目文件仅在有效信任下参与加载，项目追加文件优先于全局追加文件，二者不自动叠加。替换基础提示仍可能追加项目上下文和 Skills，工具权限由独立工具配置控制。没有新增会话提示词数据库或线程级覆盖。

每次保存一个文件，文本非空、合法 UTF-8、无 NUL、最多 64 KiB。恢复按钮先形成可检查的移除草稿，点击保存后移除本层文件，原文保留在同目录 `.web-backups/*.txt` 私有备份中。读取已有空文件会保留其原生语义；保存新内容不能使用空白冒充恢复继承。写入使用私有临时文件、原子替换及 POSIX fsync/Windows 写透替换，备份不参与 Pi 资源发现。固定服务器路径经过项目 realpath/范围、普通文件、内核描述符路径、完整身份、预算和前后变化检查，拒绝链接目录/最终链接及无效编码；不会回传其他配置文件正文。

GET 快照含 `cwd/revision/maxBytes/trust/files/selected`；`files` 为 global/project × append/base 的 `{path,content,revision}`，不存在时 content/revision 为 null。`selected` 仅为配置与信任推导，不代表某个运行实例已加载。整体 revision 覆盖四个文件的内容与身份，以及原生配置/trust/启动信任覆盖；保存需此 revision，409 保留草稿、不覆盖外部修改。显式“刷新并核对草稿”读取最新磁盘内容作为差异基线并保留编辑内容，检查后可再次保存。成功后读取失败或结果不确定时，需先刷新核对，不能直接重放保存。

保存不会中断当前任务或自动重载。**重新加载并核对** 只在当前项目有已连接、空闲的主会话时可用，复用原生资源 reload，更新该会话的全部原生资源后重新读取提示快照；其他已打开会话需分别加载。新建运行实例会按当时文件和信任加载。信任状态仍可能需要重新打开运行实例应用，刷新网页不保证获得新 worker。重载完成但快照读取失败时明确区分两步结果，提示只刷新核对。

会话详情 → 当前加载的资源 → **查看系统提示词** 提供来源/提示正文视图，显示读取时间、实际信任、基础/追加文本、加载时的上下文文件正文与 Skills/工具清单，支持正文搜索和复制。基础/追加编辑入口跳到对应范围设置；合成正文只读，不整体写回。资源清单原接口继续只返回元数据，正文仅在显式 `get_system_prompt` 时通过当前唯一 worker 的私有资源管道获取，单份快照最多 1 MiB，超限整体失败而非截断。查看不调用模型、不写 JSONL、不另开 worker；迟到/未知私有结果不会广播，切线程/断线清空快照。

正文来自公开 `ctx.getSystemPrompt()`，基础组成来自 `ctx.getSystemPromptOptions()`。原生接口没有在该快照中给出 SYSTEM/APPEND 文件的确定来源，因此路径明确标为按当前文件与实际信任推导；内容比较不能识别相同文本的 CLI/扩展来源。`matchesSavedFiles` 仅比较基础与追加文本及配置推导信任，无法读取时为 null，不声称所有上下文文件、工具或最终请求都一致。扩展可逐轮改变提示，`before_provider_request` 的供应商 payload 改写不包含在视图中。

| 方法 | 路径/命令 | 内容 |
|---|---|---|
| GET | `/api/pi/settings/system-prompts?cwd` | 原生提示文件、推导来源、整体修订、预算 |
| PUT | `/api/pi/settings/system-prompts` | `{cwd,scope:'global'或'project',kind:'append'或'base',content:string或null,expectedRevision}`，拒绝未知字段；返回 `{ok:true,requiresReload:true}` |
| WS | `get_system_prompt` | 当前主连接的提示正文、组成、来源核对、runtimeId/sessionId/capturedAt |

REST 复用工作台身份、Pi token、Origin 和 no-store，以及配置/登录互斥；写入计入 `nativeSettingsBusy`。WS 使用同一主连接鉴权，正文不会进入通知广播、自动补全、持久历史或普通配置保存事件。旧后端隐藏编辑入口，旧 worker 缺少扩展 marker 时明确要求空闲后退出重开。

`test/pi-system-prompts.test.js` 覆盖范围、信任、修订冲突、私有备份、恢复、编码/链接/预算、HTTP 身份/Origin/no-store，以及真实无模型调用的原生 worker 快照、重载和私有事件隔离。`test/browser/pi-system-prompts.cjs` 使用独立静态服务和合成 REST/WS，覆盖中英文 320/393/1440 宽度、Markdown 清理、实际子项宽度、冲突与跨分类草稿、读取失败、运行中编辑/重载互斥、正文搜索/复制、线程代次隔离与聊天附件保留。未进行本功能的 macOS/Windows 实机部署验收。

2026-09-11 首次未选项目时，Pi配置、Packages和Skills仍可管理全局范围。页面使用status.defaultProject提供的合法上下文，不把空cwd发给原生服务，也不自动选择目录或启动线程；未选项目时隐藏项目范围。选定项目后恢复原有全局/项目覆盖、trust、修订和迟到结果保护。

2026-09-10 新增配置生效核对、实际未信任项目提示和空闲持久线程显式重开。get_runtime_configuration 的 matchesSavedConfig 只比较settings/trust及启动覆盖，不冒充完整最终模型请求配置；资源文件内容变化仍需显式reload。restart_runtime校验runtimeId/revision并拒绝忙碌、队列/建议/侧聊，保留session和网页草稿；需runtimeConfiguration后端标记。Packages页补充RPC/TUI兼容范围，启动期阻塞交互明确失败。详细契约和验证见 [NATIVE_COMPLETION.md](NATIVE_COMPLETION.md)。

实现日期：2026-09-09。后端由 `/api/pi/status` 的 `nativeSettings`、`nativeResources`、`projectTrust`、`modelAdvanced` 标记启用。源码完成不代表运行中的服务已经加载，按当前实例能力核对。

## 网页入口

- 设置 → **Pi 配置**：消息与模型、工具、项目信任、上下文、图片、连接与重试、隐私与诊断七个默认关闭的分类；项目信任默认策略只在全局范围展示。字段、取值和限制仍来自服务器；先选所有项目/当前项目，再按需展开，保存仅提交改动。
- 项目菜单 → **更多操作 → 项目信任**，或 `/trust`：独立居中的紧凑窗口；明确绑定菜单所选项目，可操作非当前项目，不切项目、不打开线程。继承和生效说明按需展开。
- 会话详情 → **当前加载的资源**：默认折叠，首次展开才通过当前连接读取。可以刷新清单，或空闲时显式重新加载资源；切线程清空，迟到结果不能串入。
- 设置 → **Packages**：全局/项目安装、更新、移除，以及单个 extension/skill/prompt/theme 的配置开关。主视图展示包名称、范围、安装状态和常用操作；“从链接安装”和“高级设置”默认折叠。后者保留按类型统计的配置启用数/总数及资源列表，刷新与保存后保留本页展开状态。资源名称优先取现有 Skill 元数据，读取失败或停用项缺少元数据时回退文件/目录名，SKILL.md 与 index.ts 等入口使用父目录区分；路径兼容两种分隔符，来源路径按需展开。名称不作为资源身份或写入参数，开关仍使用服务器 resourceId。默认逐批显示 40 项，搜索覆盖完整返回清单。刷新为只读，读取失败后可以重新刷新；旧快照的修改按钮保持禁用直到成功读取。包操作仍有确认、scope/trust/revision 和迟到响应保护。
- 设置 → **Skills**：按名称/来源搜索、所有项目/当前项目范围、启用/停用及项目覆盖恢复继承。停用项继续显示，文件保留。来源路径折叠；命令显示和提示词模板放在“其他选项”。需要创建或编辑 Skill 时可让 Agent 协助。
- 模型高级 JSON、原生 Skill 全文编辑和旧“新建 Skill”网页编辑器已移除。相关受保护后端接口保留兼容，`modelAdvanced` 仍表示接口能力；模型目录原 Thinking、测试和默认模型操作继续保留。
- `/scoped-models` 直达 Pi 配置并展开常用模型所在分类；`/trust` 不接收路径/操作参数，不直接授予信任。

所有保存保持当前任务和会话。资源过滤或 Skill 保存可在空闲时显式重新加载；trust、运行偏好、模型高级参数提示退出并重新打开线程后生效。关闭或换页不自动重试写请求。

## 受管会话保护

每个持久 worker 仍只对应一个 session 文件。项目自带 CLI 扩展 `server/pi-web-session-extension.ts` 使用原生 `session_before_switch` 和 `session_before_fork` 取消扩展触发的 switch/new/fork/clone；通过 `session_before_tree` 取消没有经过本项目私有导航入口的树导航，并发回明确提示。

网页新建/打开/分叉继续由 Store/Supervisor 协调；网页历史重试/恢复使用互斥区和私有 token 调原生 navigateTree，保留原生扩展取消语义。不能在普通扩展里直接替换受管 session。网页 SessionManager 分叉不触发源 runtime 的 fork hooks，这一限制不冒充终端原生分叉。

新 worker 在启动完成前核对保护扩展 marker 及原生 sessionFile/sessionId；不符合绑定身份拒绝启动。后续 get_state 发现持久会话身份偏离，或临时 runtime 出现持久文件，会关闭异常 worker，不把另一个会话的数据继续作为原线程状态。它不是恶意扩展沙箱；第三方扩展仍以当前系统用户运行。

## 项目信任与实际加载

信任保存调用 Pi 公开 `ProjectTrustStore.set()`，当前目录必须经过 realpath/PI_PROJECT_ROOTS。支持当前项目允许/拒绝/清除本层决定，展示最近父目录继承来源。网页不会隐式信任整个父目录。

配置推导顺序为 `PI_WEB_APPROVE_PROJECTS` 显式覆盖、原生最近 trust 决定、全局 defaultProjectTrust。该推导不执行用户 `project_trust` hooks，因此与已运行线程的有效状态分别展示。主 runtime 的实际 trusted 状态来自 `ctx.isProjectTrusted()`，保存信任不会中断或替换现有 worker。

不信任项目会阻止项目设置和受信资源的加载，但不等于禁止 AGENTS.md/CLAUDE.md 等上下文文件，也不是工具权限隔离。

设置资源目录使用带有效 trust 的公开 SettingsManager/DefaultPackageManager，Skill 只从解析出的启用路径加载，不再通过 includeDefaults 绕过项目 trust。该目录表示配置解析结果，不冒充当前线程快照。

主 WS `get_native_resources` 经已有内部扩展读取：

- ctx.getSystemPromptOptions 的上下文路径、自定义/追加提示存在标志及 Skill 名称/路径；不返回正文。
- pi.getCommands 的命令名、类型与官方 sourceInfo。
- pi.getAllTools/getActiveTools 的工具名、来源和启用状态；不返回工具参数 schema。
- 当前 cwd、sessionId 和实际 projectTrusted。

不启动新的 runtime、不重新执行资源发现、不写 JSONL。仅注册 hooks 而没有命令或工具的扩展不在来源清单中，网页明确说明此范围，不能称为完整扩展加载清单。系统提示的临时 provider payload 改写也不包含在来源快照中。

清单总计最多 3000 项、私有正文 512 KiB；同 worker 一次读取。Supervisor 截获所有 pi5Resources 响应，包括迟到/未知响应，不向其他订阅者广播私有结果。读取参与回收保护和活动计数；刷新结果检查 socket generation，不串线程。

## 原生设置

GET 快照只投影允许字段，分别返回 global、project、配置有效值和来源。生效值与默认值由原生 SettingsManager getters 读取，不提供任意 JSON 文件编辑器。

支持 defaultTools、仅全局的 defaultProjectTrust，以及 steeringMode/followUpMode、transport、compaction.enabled/reserveTokens/keepRecentTokens、retry.enabled/maxRetries/baseDelayMs/provider.timeoutMs/provider.maxRetryDelayMs、HTTP 流空闲超时、WebSocket 连接超时、图片自动缩放/阻止图片、enabledModels，以及仅全局的 enableInstallTelemetry。

保存只提交修改的字段。null 移除当前范围覆盖；项目保存要求明确配置为可信。未知字段、非法枚举和范围拒绝。网页数值预算由响应 schema 提供：压缩预留/保留各 1024–1000000、Agent 重试 0–20、基础等待 100–600000ms、Provider 请求超时 1000–3600000ms、最大等待/HTTP idle 0–3600000ms、WS connect 0–600000ms。enabledModels 最多 200 项、每项 500 字符。没有改变 Pi 默认值。

配置修订涵盖 cwd、全局/项目 settings、trust 文件及启动 trust 覆盖。写入前比较，409 不自动覆盖。普通设置写入与原生 settings.json.lock 目录锁协作，保留未知 JSON，0600 备份和原子 rename；只管理原生位置，拒绝符号链接/非普通文件/损坏 JSON，单文件 1 MiB。文件内容不进入 API 错误或模型提示。

运行偏好保存不改变已创建 runtime 的配置快照。Pi Web worker 原有 PI_SKIP_VERSION_CHECK=1 只关闭版本检查，遥测独立；页面展示 PI_TELEMETRY/PI_OFFLINE 的布尔覆盖，不暴露环境值或凭据。

## 默认工具与全局信任策略（2026-09-10）

设置 → Pi 配置 → 工具使用 `defaultTools`，候选名由公开 Pi 工具工厂在服务器构造，返回 schema.choices/defaults/platform；不会启动 runtime、发现扩展或执行工具。本版本包含 read/bash/edit/write/grep/find/ls/powershell，PowerShell 需要相应运行环境。未设置使用 Pi 标准默认；全局恢复“Pi 默认”和项目恢复“继承全局”均提交 null 删除本层字段。自定义全部不选提交 []，明确表示不默认启用内置工具；项目数组整体替换全局数组，未信任项目的设置不参与生效。API 拒绝非数组、重复和未知工具名，不把空数组当作未限定。

此选择只影响初始内置工具，扩展及 SDK 自定义工具仍可启用，扩展也可调整活动工具；不同于 CLI --tools 对所有工具的严格 allowlist。它不控制手动 !/!! Shell，不提供只读或安全模式。实际启用工具通过会话详情 → 当前加载的资源核对。

设置 → Pi 配置 → 项目信任提供 defaultProjectTrust=ask/always/never，globalOnly；项目范围提交该字段（包括 null）拒绝。null 恢复 Pi 默认 ask。策略仅作兜底，不覆盖已有项目或父目录的允许/拒绝；启动覆盖和 project_trust hooks 仍由原生 runtime 处理。RPC 的 ask 不弹启动询问，未决项目受信资源暂不加载，用户可从项目菜单或 /trust 授权。项目独立信任窗口展示默认策略并链接到全局设置，入口不切换所选项目或启动会话。

配置推导与当前 runtime 实际信任分开说明；不信任不隔离工具权限，也不阻止所有上下文文件。两项保存均复用原接口/修订/锁/0600备份与原子写入，不改写 trust.json 的已有逐项目决定。设置和信任保存均提示新运行实例生效；仅切线程或刷新页面可能复用旧 worker，需要任务结束后 /quit 再重新打开。保存不自动停止/重载资源。写入期间锁定设置表单和范围；写入成功但重读失败只允许刷新核对，避免重放已成功的保存。

新入口由 GET /settings/native 的 schema.defaultTools/defaultProjectTrust 是否存在决定，旧后端继续显示原有分类。本轮代码完成后仍需服务空闲重载；刷新静态页面不使旧后端自动支持字段。

## Package 与 Skill

Package 的安装/移除使用公开 installAndPersist/removeAndPersist，local 与网页范围相符；更新使用 update。原生 update(source) 可能匹配多个范围，同一来源存在多个安装范围时网页拒绝模糊更新，要求在终端处理，不静默更新另一个实例。

资源选择由服务端重新解析后的 ID 决定，不接受浏览器提供任意文件/模式。单项启用/停用/恢复默认写原生 +path/-path 与 package object filters。项目对全局 package 使用 autoload:false delta；恢复继承移除对应 delta，不覆盖其他资源/类型。[] 停用整类后只启用一项时，保留其他项目停用。资源写入使用公开 SettingsManager setters 和 flush，错误要求核对；保留原配置备份。

新 Package 和资源写入要求 expectedRevision/confirmed:true。与原设置写入和登录流程互斥；不在后台静默安装、不调用模型。旧 Package API 保留兼容，界面在新后端使用新范围接口。

Skills 页复用上述 GET/PUT 资源接口，不新增禁用配置或改写 SKILL.md。配置清单包含已停用项；名称/说明优先使用现有 Skill 元数据，未加载时以文件或目录名显示，来源路径可展开核对。停用会保存到所选范围并持续至再次启用，不声称仅作用于当前一轮或立即清除当前会话中的已有指令。其作用是资源发现与加载过滤，不是文件访问沙箱。单项写入期间禁止重复操作，409 保留原状态、提示刷新，不自动重试；当前项目范围可恢复继承而不覆盖全局设置。

以下 Skill 编辑契约保留为兼容 API，网页不再提供编辑器。Skill 仅管理 `<agentDir>/skills/<name>/SKILL.md` 或 `<cwd>/.pi/skills/<name>/SKILL.md`。名称小写字母数字和短横线、最多 64 字符；完整文本 64 KiB，frontmatter.name 必须匹配、description 非空且最多 1024。读取后以内容哈希比较修订，原子 0600 保存，备份在该 Skill 的隐藏 `.web-backups/*.txt`，不会被发现为另一个 Skill。拒绝符号链接，Package 内文件应在包来源维护。保存不自动运行脚本或授予项目 trust。

## 模型高级参数（兼容 API，无网页编辑器）

独立 GET/PUT 使用原 models.json/settings.json 修订，不回传 apiKey、headers 或其他凭据。已声明的 custom model 修改对应项；内置或继承模型写 modelOverrides，保留未知字段和其他模型。

- compat：支持网页 schema 列出的常见布尔兼容项、maxTokensField、thinkingFormat、thinkingTokenBudgetField。单项 null 删除覆盖；整个 compat=null 只清除网页支持的键，保留未知键。
- samplingParams：仅 temperature/top_p/top_k/min_p/presence_penalty/frequency_penalty/repetition_penalty/seed 的有界数字，不允许 messages/tools 等请求覆盖。仅原生支持的 OpenAI compatible APIs 开放；以模型实际 api 判断。
- cost：input/output/cacheRead/cacheWrite 的每百万 token 美元费率，0–100000 的有限数。部分更新保留其他费率与既有 tiers；cost=null 明确恢复原生价格。阶梯价格本轮只保留和显示，未实现编辑。

价格更新不追溯改写会话历史费用。零费率可能代表未配置，不代表免费。自定义 Provider 的高级 JSON 不是任意协议自动兼容保证；凭据继续走 ModelRuntime.login/logout。

## API

全部复用 Pi token/Origin 和 no-store。

| 方法 | 路径 | 内容 |
|---|---|---|
| GET | `/api/pi/settings/native?cwd` | trust、schema、允许设置的范围/来源、revision |
| PUT | `/api/pi/settings/native` | cwd/scope=global或project/values/expectedRevision |
| PUT | `/api/pi/settings/native/trust` | cwd/decision=true或false或null/confirmed/expectedRevision |
| GET | `/api/pi/settings/native/resources?cwd&scope` | 配置包/资源清单、revision |
| PUT | `/api/pi/settings/native/resources` | cwd/scope/resourceId/state=on或off或inherit/confirmed/expectedRevision |
| POST | `/api/pi/settings/native/packages` | cwd/scope/source/action=install或remove或update/confirmed/expectedRevision |
| GET | `/api/pi/settings/native/skill?cwd&scope&name` | 完整 content 与内容 revision，不存在返回空草稿和 null revision |
| PUT | `/api/pi/settings/native/skill` | cwd/scope/name/content/confirmed/expectedRevision |
| GET | `/api/pi/settings/models/advanced?provider&modelId` | 允许参数 schema、本地覆盖及有效价格 |
| PUT | `/api/pi/settings/models/advanced` | provider/modelId/expectedRevision/compat?/samplingParams?/cost? |
| WS | `get_native_resources` | 只读当前主连接 worker 的原生资源来源 |

`GET /api/pi/activity.nativeSettingsBusy` 表示原生配置或原模型设置写入正在进行，不包含配置内容。部署空闲检查应同时要求该值为 false。

## 验证与部署

新增 `test/pi-tools-trust.test.js` 使用独立 Agent/项目和真实无模型调用的 Pi worker，验证空列表保留扩展工具、CLI严格allowlist、项目数组替换/恢复、已有worker不变、三种默认信任、保存/父目录/启动覆盖、非法字段和修订拒绝。浏览器原专项补齐复选框尺寸、空数组/默认/继承、全局策略与项目隐藏、冲突保留和成功后重读失败。

`test/pi-native-integration.test.js` 使用独立 Agent/项目、公开 Pi RPC、合成模型和扩展；覆盖会话替换/导航拒绝、临时会话、实际 trust 来源、私有元数据、配置范围/修订、资源 filters/delta、Skill 编辑、模型参数和价格、HTTP token/Origin/锁/符号链接；不调用真实模型。

前端在资源范围加载期间禁用旧列表的开关与操作；请求序号防止迟到范围快照覆盖新范围。原设置 Skill 目录按 cwd 缓存并校验请求身份，切换项目后重读，旧响应与错误不覆盖当前列表。

`test/browser/pi-native-settings.cjs` 使用受控 REST/WebSocket，检查桌面与手机三主题的折叠配置、保存与冲突草稿、Skill 启停/保留/项目继承和范围迟到返回、非当前项目菜单信任、居中 dialog、移除旧编辑入口、当前 worker 资源按需读取/重载互斥/切线程迟到隔离及内部宽度。无位移的根滚动事件不再误关刚打开的项目菜单，真实外部滚动仍关闭。既有 Provider 登录、模型目录、输入框、项目菜单、原生控制、会话工作流、附件和正文浏览器回归仍需通过。

普通配置验证使用隔离实例和合成服务；保存和实际runtime加载分别核对，不能凭页面出现字段推断当前线程已经应用。

原生后端已于 2026-09-09 20:58 CST 完成空闲启用，四项标记为 true，部署结果 verified。2026-09-09 的界面收简仅涉及静态页面，刷新即可生效；本次工具/全局信任新增字段仍需要后端空闲重载。旧后端继续隐藏不支持的新入口。测试使用独立配置或受控 REST/WS，不操作用户会话、凭据或媒体。

# Pi 原生配置与扩展接入

2026-09-11 首次未选项目时，Pi配置、Packages和Skills仍可管理全局范围。页面使用status.defaultProject提供的合法上下文，不把空cwd发给原生服务，也不自动选择目录或启动线程；未选项目时隐藏项目范围。选定项目后恢复原有全局/项目覆盖、trust、修订和迟到结果保护。

2026-09-10 新增配置生效核对、实际未信任项目提示和空闲持久线程显式重开。get_runtime_configuration 的 matchesSavedConfig 只比较settings/trust及启动覆盖，不冒充完整最终模型请求配置；资源文件内容变化仍需显式reload。restart_runtime校验runtimeId/revision并拒绝忙碌、队列/建议/侧聊，保留session和网页草稿；需runtimeConfiguration后端标记。Packages页补充RPC/TUI兼容范围，启动期阻塞交互明确失败。详细契约和验证见 [NATIVE_COMPLETION.md](NATIVE_COMPLETION.md)。

实现日期：2026-09-09。后端由 `/api/pi/status` 的 `nativeSettings`、`nativeResources`、`projectTrust`、`modelAdvanced` 标记启用。源码完成不代表运行中的服务已经加载，按当前实例能力核对。

## 网页入口

- 设置 → **Pi 配置**：消息与模型、工具、项目信任、上下文、图片、连接与重试、隐私与诊断七个默认关闭的分类；项目信任默认策略只在全局范围展示。字段、取值和限制仍来自服务器；先选所有项目/当前项目，再按需展开，保存仅提交改动。
- 项目菜单 → **项目信任**，或 `/trust`：独立居中的紧凑窗口；明确绑定菜单所选项目，可操作非当前项目，不切项目、不打开线程。继承和生效说明按需展开。
- 会话详情 → **当前加载的资源**：默认折叠，首次展开才通过当前连接读取。可以刷新清单，或空闲时显式重新加载资源；切线程清空，迟到结果不能串入。
- 设置 → **Packages**：全局/项目安装、更新、移除，以及单个 extension/skill/prompt/theme 的配置开关。默认逐批显示 40 项，搜索覆盖完整返回清单。
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

# Media Agent Integration

主入口是聊天中的生成卡片（见下文“聊天生成卡片”）；多媒体实验室保留生成记录、模型接入和完整参数编辑，参数与执行契约见 [MEDIA_LAB.md](MEDIA_LAB.md)。

## 当前范围

聊天使用 `media_models` 读取配置、`media_generate` 提交单项方案；实验室支持直接编辑参数及可选受限 Agent 规划。两者复用服务器校验和执行票据。聊天首次执行受“设置 → 模型与能力 → 对话自动生成”的类型偏好控制：图像与语音默认自动执行，视频默认等待确认，自动执行也可能收费。实验室和需要手动确认的卡片仍由用户确认后执行。规划工具、模型说明和 Skill 均不能代替执行授权。

旧 `media_plan_image`、`media_plan_video`、`media_plan_tts` 以及 `/api/pi/media/plan` 保留兼容。它们可生成多项 MediaPlan，未接入批量执行；统一实验室使用 `media_plan_request` 单项规划。

## 聊天生成卡片

受管的普通会话（Pi Agent、助手对话、任务线程和定时任务所用的持久 worker）由 `pi-web-session-extension` 注册三个工具，不依赖用户安装 `media-workbench` 包；侧聊和临时会话没有这三个工具。

| 工具 | 作用 |
|---|---|
| `media_models` | 读取实验室目录中的图像/视频/语音模型，只返回 id、名称、可执行状态、要求和精简参数定义；预设、音色默认值和文档链接留在实验室 |
| `media_results` | `{limit?:1–30,offset?:0–500}` 读取当前分支最近 500 张卡片，默认最近 10 张、每张最近 3 次尝试；返回状态、任务编号、提示词摘要和完成结果的固定引用，支持分页；只读本地记录，不提交或恢复远端任务，也不分析视频内容 |
| `media_generate` | `{modelId, summary, parameters}` 经 `/api/media-agent/validate` 准备规范方案，先由当前 worker 保存原生 `pivane-media-plan` 来源，再提交首次执行；对开启“对话媒体卡片自动生成”的类型（默认开启图像与语音，关闭视频，单轮最多自动触发 4 张）启动执行并等待短任务结果，卡片保留完整尝试与参数记录 |

自动执行的四个单轮名额在提交请求前预占，并发调用也共用该上限；只有响应明确证明没有提交才释放名额，断线、取消等待、失败或不确定结果不视为未执行。轮次和会话切换后的迟到准备／响应不会取得或释放新一轮名额。

这些工具使用受管进程的内部规划凭据，不能直接调用实验室执行或聊天卡片接口；符合已保存自动生成偏好的首次执行由服务器触发，仍经 review/execute 票据。`validate` 的 `prepare` 阶段只规范方案并返回固定 plan.id 与私有一次性 executionToken；原 worker 同步 `appendEntry` 并从当前分支确认来源后，才请求 `execute` 阶段。服务器在首次 await 前消费 token，重复提交只查同一方案状态，不再次生成。准备最多 100 项、10 分钟、方案合计 8 MiB；token 不进入方案、原生记录或模型输出。

前端从当前原生分支恢复卡片，也兼容已有 `media_generate` 和 `media_plan_request` 成功工具结果的 `details.plan`。同一 plan.id 只显示一张卡片，原生来源优先；错误或取消的工具结果不会隐藏已保存来源。卡片不属于过程折叠，三种显示模式都可见。刷新、重开 worker 或压缩后仍可读取当前分支来源；导航到来源之前或其他分支时不沿用旧卡片。

取消等待或执行响应丢失后，先用原卡片／`media_results` 查询，不能据工具失败再次生成。来源已保存但执行尚未提交、token 过期或服务重启时，原卡片保留待确认状态，不自动补交生成；用户可在原卡片明确确认。无 stage 的旧 `/validate` 永远只规划；旧受管 worker 自动生成降级为待确认卡片，在线程空闲后重开才能加载新协议。

需要手动确认的卡片流程：

```text
card confirm (user session) -> POST /api/pi/media/chat/requests {key, modelId, parameters, confirmed:true, again?}
  -> MediaLabService.review: canonical parameters + ticket
  -> canonical != submitted: return {status:"changed", parameters}, nothing executed
  -> slot free and nobody waiting: journal "running" (persisted) -> MediaLabService.execute(ticket) in background
  -> otherwise journal "queued", discard the ticket; when a slot frees: review again, start if unchanged
  -> done {asset} | failed (not submitted) | uncertain | cancelled (queued, never sent)
```

`MediaChatRequests`（`server/media-chat-requests.js`）以方案 id 为键，把每次尝试保存到媒体数据目录的 `media_chat_requests.json`（私有权限、原子替换、最多 2000 张卡片、每张最多 20 次）。已有尝试时必须带 `again:true`，同一张卡片提交中或运行中返回 409；服务启动时把遗留的 running 改为 uncertain，遗留的 queued 改为 failed（从未发送）。票据只在内存中，不写入记录；参数超过 64KiB（含附件）时记录中省略参数。执行失败且票据从未开始，或服务已明确返回配置中的失败／取消终态时记为 failed；超时、断线等未确认结果记为 uncertain，均不重试。旧 uncertain 记录若已有 remoteTerminal:true，卡片和结果查询按 failed 展示，不改写原记录。生成文件和历史仍由实验室存储负责。

执行名额由 `MediaLabService.canExecute` 统一判断（实验室直接生成也使用）：远程服务（`http-provider`、`http-json`、`minimax-video`）合计 4 项，其中视频最多 2 项；本机 GPU/本地语音后端 1 项。远程请求在服务器上主要是等待网络，单项输出上限 64MiB；视频单独限额以控制内存峰值。名额已满时卡片进入服务器内存中的先进先出队列（最多 20 项、参数合计 64MiB），显示排队位置并可取消；有名额释放时按确认顺序重新 review，参数或配置变化则记为 failed 而不执行。排队转运行必须先成功保存 running 状态；保存失败时不派发，丢弃尚未执行的票据，将该卡片标为明确未提交的失败并显示错误，其他等待项仍可继续处理。存储恢复后，用户需在失败卡片重新确认才能创建新尝试；已提交或不确定尝试不自动重放。排队项计入维护空闲判定。队列不跨重启保存，重启后排队项标记为未发送。

## 聊天图片编辑与参考素材

Pi Agent 和助手对话中，先上传 PNG/JPEG/WebP 图片并说明修改要求，例如“用已配置的图片编辑模型，保留主体，把背景改成夜景”。Agent 选择声明了图片输入的模型（编辑接口可能单独列为模型），把当前原生会话分支的图片交给生成卡片。卡片展示原图缩略图、修改要求和模型；需要手动确认时可先核对后执行；“修改参数”也能替换参考图。可接着要求“把刚生成的图再改成水彩风格”。没有图片输入的文生图模型不能代替编辑模型。

`media_generate` 的 image/video 参数接受下列引用；multiple 字段使用有序数组：

| 引用 | 来源 |
|---|---|
| `chat-image:-1` | 当前分支最近一张用户图片；-2 为倒数第二张，1 为第一张，多图消息按附件顺序计数 |
| `chat-result:-1` | 当前分支最近 500 张生成卡片中最后完成的图片；只选已完成结果，排除失败和不确定结果 |
| `media-result:<plan-id>/<attempt-id>` | `media_results` 返回的指定已完成图片或视频，绑定当前分支及具体尝试；首尾帧和分镜优先使用，避免完成时间改变素材顺序 |
| `chat-video:-1` | 当前分支最近 100 张视频卡片中最后完成的视频；正负索引规则同图片 |
| `file:<path>` | 当前项目内 PNG/JPEG/WebP 或 MP4 文件；复用项目隐私规则、描述符身份与完整读取校验 |

引用仅解释模型声明的 image/video 字段，不改变普通提示词。上传图来自原生 SessionManager 当前分支；不创建聊天副本，不读取其他分支或会话。GIF 不作为编辑参考图，需先转换格式；聊天原有上传大小限制不变。具体多图、蒙版或首尾帧能力以模型字段为准，不额外提供画笔蒙版编辑器。

素材存入媒体数据目录下的 `media_references/`，用 `mediaref:<sha256>` 放入方案和卡片记录，避免把 base64 重复写入聊天。图库图片和视频也先固定为同样的引用。读取时验证实际打开的文件路径、完整身份、预算与哈希；数据为私有权限，不进入 Git 或发行包。每项及单次参考素材总计最多 20 MiB，实例最多 5000 个文件／4 GiB；相同字节去重，不自动清理或过期，迁移与备份媒体数据时一并保留该目录。卡片刷新、服务重启和再次生成继续使用该引用。Agent 的引用存储与结果查询仅用于准备方案；执行仍使用服务器票据，由已保存的自动生成偏好或用户本次卡片确认触发。

## 聊天视频与分阶段创作

视频能力来自配置模型的参数定义：普通文字、`image`/`video` 字段、`role`（如 first_frame/last_frame）、`multiple` 及数量限制。不按模型品牌、名称或字段名称猜测接口，也不启动 GPU 服务。

例如先说“为这个场景分别生成首帧和尾帧”，按卡片要求确认并等待图片完成，再说“用这两张图做一个镜头推进的视频”。Agent 用 `media_results` 核对哪张是首帧、哪张是尾帧，再把固定引用放入所选视频模型的对应字段。多张参考图和视频使用有序数组。参考视频可选当前分支已经生成的视频、项目内 MP4，或在卡片“修改参数”中上传；普通聊天输入区的附件能力不因此扩大。单次参考素材仍合计 20 MiB。

视频完成后卡片提供播放器和下载。Agent 可在后续对话读取卡片结果、继续引用视频；状态查询不等于观看或理解视频内容，不会在后台循环调用 Agent。每个阶段按该类型的自动生成偏好执行，需要确认时在对应卡片确认；未完成的图片不能提前作为视频素材。

通用 HTTP 视频模型的默认等待为 2 小时，可配置到 24 小时；已保存的显式等待值保持不变。等待在服务器进行，关闭页面不会停止任务。异步模型接受任务后，将任务编号、固定查询地址、连接契约指纹和输入元数据保存到私有卡片记录；地址不暴露给卡片或 Agent。超时、查询断线或重启后，卡片提供“继续查询原任务”：用户确认后只 GET 原任务并下载结果，不再次 POST 生成，使用当前等待预算并占用同样的执行名额。调整等待时长或查询间隔可继续使用原任务；更换模型、服务地址、参数或结果契约会拒绝恢复。服务明确返回配置中的终态失败后显示“失败”，不能恢复；没有任务编号的同步请求仍需到服务端核对，不能凭超时判断取消。排队中的未提交请求仍不跨重启执行。

## 数据流

以下是实验室的受限规划流程；聊天自动生成的入口与授权见[聊天生成卡片](#聊天生成卡片)。

```text
selected model + editable fields + natural-language request
  -> POST /api/pi/media/lab/plan
  -> restricted pi --mode rpc --no-session
  -> media_get_capabilities(kind), then media_plan_request
  -> POST /api/media-agent/validate
  -> MediaLabService.plan: live definitions + canonical parameters
  -> editable laboratory fields
  -> explicit review: canonical checklist + ticket
  -> user confirmation: execute the server-bound ticket
```

Pi 仍是上游依赖。本功能通过官方 CLI/RPC、extension registerTool 和 Pi Package 接入，不修改 Pi 源码或依赖包。专用 planner 关闭用户/项目 extensions、skills、prompt templates 和 context files，仅显式加载本项目工具 extension，并固定 `projectApproval:false`。激活工具只有 `media_get_capabilities` 和本次 plan tool，无文件、shell、执行或确认工具。使用 no-session，不写 JSONL。

模型 requirements 作为任务资料送入 planner；不能提升工具权限或跳过参数验证。完整 Agent 的文件/shell 权限是独立的系统用户权限，不把受限 planner 的保证扩大为整个工作台的工具沙箱。

## 模型定义和当前参数

实验室按实时模型定义直接编辑常用和专属参数，固定值不可修改。自然语言要求经可选规划后应用，不从 Agent 自由文本猜参数；必填项可直接补齐。修改参数使旧票据失效。见[完整参数编辑](MEDIA_LAB.md#直接生成与完整参数编辑)。

实验室目录列出用户配置的模型和动态 TTS registry，不自动展示旧 Z-Image、Flux 和 MiniMax 视频固定执行器；底层定义供兼容接口使用。公开目录包含参数、要求和可执行状态，不包含连接 URL、认证变量、固定请求 body 或 adapter 私有 settings。

`instructionsFile` 只能读取配置目录中经 realpath 校验的相对 Markdown 文件，最大 32KB。字段支持 text、textarea、number、select、boolean、json；顶层未知字段、类型、范围、固定值均拒绝。JSON 对象/数组的嵌套厂商语义需 adapter 继续验证。

TTS 的字段来自 `TtsProviderService.getPublicConfig()`；已配置模型复用 `resolveRequest()` 返回规范化文本、音色、语言、语速和专属 options。模型无执行后端仍可规划，提交按钮禁用。

## Pi Package

位置为 `pi-packages/media-workbench/`，包含 `extensions/media-tools.ts` 和 `skills/media-workbench/SKILL.md`。终端/完整 Pi Agent 可通过设置中心的公开 PackageManager 安装这个本地 package；专用实验室 planner 会显式加载它，不要求用户先全局安装。

| 工具 | 副作用 |
|---|---|
| `media_get_connection_schema` | 只读支持的接入协议和中性模板 |
| `media_plan_connection` | 校验文档接入草稿或不支持原因，不保存/探测/生成 |
| `media_get_capabilities` | 只读该 kind 的实时目录，包括 `lab.models` |
| `media_plan_request` | 校验指定 modelId 与结构化 parameters，返回单项方案 |
| `media_plan_image` | 旧图像 MediaPlan 兼容 |
| `media_plan_video` | 旧视频 MediaPlan 兼容 |
| `media_plan_tts` | 旧语音 MediaPlan 兼容 |

每次 plan 前读取 capability。plan tools 返回 `terminate:true`，canonical plan 存于 `details.plan`，文本 content 供 LLM/TUI 阅读。任何 plan tool 都不创建 review ticket。

## Planner 模型

设置 → 使用偏好 → [辅助模型](AUXILIARY_MODELS.md)的“媒体规划”行管理原来的模块 Agent 选择，已有值直接保留。显式 request provider/modelId 优先于偏好；明确选择的模型必须可用且支持文本，无法使用或规划失败时仅报告失败，不自动换成其他模型。

没有显式或已保存模型时采用“自动”：`PI_MEDIA_PLANNER_MODEL`、Pi 默认模型形成候选；没有匹配项时选第一个可用非 batch 模型。候选来自 `ModelRuntime.getAvailable()`，保留既有默认候选尝试及结果报告，不内置个人 Provider/模型名称。

偏好仍保存于选定 Pi Agent 目录下的 `pivane-workspace.json.mediaAgent`（既有 `pi5-workspace.json` 自动沿用），不改变 Pi 对话默认模型。保存后下一次 plan 生效，response 返回实际 `plannerModel`、`fallbackUsed` 和截断的失败尝试；只有自动默认候选可在失败后切换，不重试媒体执行。

## API 和连接

统一accessControl后端会保护这些能力/校验端点。受管进程使用仅允许规划端点、绑定本实例origin的内部凭据；独立CLI Package使用显式PI_WORKSPACE_BASE_URL和PI_WORKSPACE_ACCESS_TOKEN。Package不跟随重定向，不把内部Token送到其他origin或模型输入；旧业务执行仍需各自授权。见 [ACCESS_CONTROL.md](ACCESS_CONTROL.md)。

- `/api/pi/media/lab/plan` 受 Origin/token 与项目 realpath 校验保护。
- `/api/media-agent/capabilities/:kind` 只读目录；`/api/media-agent/validate` 的无 stage／prepare 调用只规划，图库图片引用可保存私有素材快照。持久 worker 的 execute 阶段仅消费已准备的一次性授权，并按当前自动生成偏好走原有卡片执行流程。
- extension 在存在内部进程身份时使用所属实例的实际绑定地址/端口；独立CLI使用 `PI_WORKSPACE_BASE_URL`，无配置时 fallback `http://127.0.0.1:11408`。隔离实例仍须覆盖可能继承的生产地址，并使用独立身份/媒体/项目目录。
- 旧 `/api/pi/media/capabilities/:kind` 保留旧返回结构；新代码使用实验室目录。

实验室方案增加 modelId/parameters，仍保留 version、id、kind、summary、jobs、warnings、createdAt，`execution={mode:"manual",count:1}`。旧 MediaPlan 的多项字段不表示已经支持队列。

## 媒体连接规划

新接入规划与生成参数规划是两个入口。`POST /api/pi/media/lab/connection-plan` 固定已选择 Provider，输入 kind、remoteModel 和 API 文档文本；专用 no-session runtime 只启用 `media_get_connection_schema` 与 `media_plan_connection`。已知 Key/常见认证字段值会从文档移除，配置凭据不会放入提示词。原始文档不是执行指令。

草稿必须通过 `normalizeModel` 和 HTTP 合约校验后才能返回；模型不受支持则返回 unsupported 原因，不保存、探测、生成或取得票据。用户在管理页继续编辑并明确保存，生产生成仍需单独 review/execute。详情见 [MEDIA_CONNECTIONS.md](MEDIA_CONNECTIONS.md)。

## 后续

聊天卡片已支持有界内存排队、未提交取消和执行阶段展示；队列不跨重启恢复。尚无持久恢复队列、旧 MediaPlan 批量执行、运行中远端取消或跨模块流水线。失败及不确定请求不自动重试，不能循环调用执行接口绕过确认。

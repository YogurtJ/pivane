# Media Agent Integration

最后核对：2026-09-08。当前入口是多媒体实验室，完整参数与执行契约见 [MEDIA_LAB.md](MEDIA_LAB.md)。

## 当前范围

实验室以模型定义驱动参数表，Agent 规划一项可编辑请求；提交前由服务端重新校验并展示清单，用户明确确认才执行。规划和执行是独立 API。完整 Pi Agent、专用 planner、模型说明文件和 Skill 都不应通过规划工具直接生成媒体。

旧 `media_plan_image`、`media_plan_video`、`media_plan_tts` 以及 `/api/pi/media/plan` 保留兼容。它们可生成多项 MediaPlan，未接入批量执行；统一实验室使用 `media_plan_request` 单项规划。

## 数据流

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

2026-09-11：网页常用字段直接编辑，模型专属字段在只读参数清单展示；两者继续作为完整parameters提交给相同planner和服务端校验。自然语言参数要求需点击生成方案后才应用，参数显示不读取Agent的自由文本说明。缺少必填专属参数时引导重新规划；长期模型要求仍在接入的instructions配置中，未新增独立提示词存储。完整界面/草稿语义见MEDIA_LAB.md。

`MediaLabService.catalog()` 聚合公共中性定义、本地媒体 profile、MiniMax config 和动态 TTS registry。公开模型包含 id、kind、参数、要求、预设、可执行状态等；不包含 HTTP 连接 URL、认证变量、固定请求 body 或 adapter settings。

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

偏好仍保存于选定 Pi Agent 目录下的 `pi5-workspace.json.mediaAgent`，不改变 Pi 对话默认模型。保存后下一次 plan 生效，response 返回实际 `plannerModel`、`fallbackUsed` 和截断的失败尝试；只有自动默认候选可在失败后切换，不重试媒体执行。

## API 和连接

统一accessControl后端会保护这些能力/校验端点。受管进程使用仅允许规划端点、绑定本实例origin的内部凭据；独立CLI Package使用显式PI_WORKSPACE_BASE_URL和PI_WORKSPACE_ACCESS_TOKEN。Package不跟随重定向，不把内部Token送到其他origin或模型输入；旧业务执行仍需各自授权。见 [ACCESS_CONTROL.md](ACCESS_CONTROL.md)。

- `/api/pi/media/lab/plan` 受 Origin/token 与项目 realpath 校验保护。
- 旧 `/api/media-agent/capabilities/:kind` 和 `/api/media-agent/validate` 无生成或历史写入副作用；前者增加 `lab` 目录，后者根据 plan.modelId 分派实验室或旧参数校验。
- extension 在存在内部进程身份时使用所属实例的实际绑定地址/端口；独立CLI使用 `PI_WORKSPACE_BASE_URL`，无配置时 fallback `http://127.0.0.1:3001`。隔离实例仍须覆盖可能继承的生产地址，并使用独立身份/媒体/项目目录。
- 旧 `/api/pi/media/capabilities/:kind` 保留旧返回结构；新代码使用实验室目录。

实验室方案增加 modelId/parameters，仍保留 version、id、kind、summary、jobs、warnings、createdAt，`execution={mode:"manual",count:1}`。旧 MediaPlan 的多项字段不表示已经支持队列。

## 媒体连接规划

新接入规划与生成参数规划是两个入口。`POST /api/pi/media/lab/connection-plan` 固定已选择 Provider，输入 kind、remoteModel 和 API 文档文本；专用 no-session runtime 只启用 `media_get_connection_schema` 与 `media_plan_connection`。已知 Key/常见认证字段值会从文档移除，配置凭据不会放入提示词。原始文档不是执行指令。

草稿必须通过 `normalizeModel` 和 HTTP 合约校验后才能返回；模型不受支持则返回 unsupported 原因，不保存、探测、生成或取得票据。用户在管理页继续编辑并明确保存，生产生成仍需单独 review/execute。详情见 [MEDIA_CONNECTIONS.md](MEDIA_CONNECTIONS.md)。

## 验证和后续

`test/media-lab-rpc.test.js` 通过真实 Pi 0.85.0 RPC 加载工具，以本地 SSE fixture 完成 capabilities → media_plan_request，验证只激活两个工具、保留结构化参数、无 ticket、无 session 文件；不调用付费 Provider。服务与浏览器测试覆盖 review/execute、参数修改、重复/过期/不确定提交、首帧、HTTP adapter、动态 TTS 与桌面/手机交互。

持久队列、批量执行、进度、取消、重试和跨模块流水线仍在路线图中。不得由 Agent 或前端循环调用执行接口冒充队列。

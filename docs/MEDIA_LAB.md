# 多媒体实验室

## 常用输入与只读参数清单（2026-09-11）

图像、视频、语音页及提交窗口只为少量常用字段显示输入控件：图像提示词/尺寸/画幅，视频提示词/时长/分辨率/画幅，语音文本/音色/语言/语速。只有模型实际定义的字段才显示，JSON 和固定值归入只读清单；未匹配常用字段名的参数也只读。模型接入配置和回复朗读设置的原参数编辑器保持不变。

“本次生成参数”按模型定义统一展示全部参数的名称、原字段名和值，包括迭代次数、种子、布尔值和嵌套 JSON。值来自当前结构化草稿和实际定义的默认值，不从 Agent 自然语言说明推断；未指定字段明确标注，不能猜测远端默认值。输入常用参数、应用方案/预设、音色默认值变化及历史复用都会更新清单。清单文本不作为参数输入来源；专属值由本页内存保存，切模型/媒体类型按原模型草稿恢复，不另存持久配置。

修改专属参数时，在创作要求中补充“这次迭代用10次”等要求，再点击生成方案。修改要求本身尚未改变参数，页面明确提示；迟到方案不覆盖更新后的草稿。缺少必填专属参数时，提交前提示由 Agent 补充，不能在不可见控件上卡住校验。长期规则仍可在模型接入的高级“模型使用要求”中保存，不需要每次调整都修改模块 Agent 设置。

主页面标注“当前参数草稿”；提交窗口按服务端规范参数显示“已校验”，完整请求映射仍在原“请求参数 JSON”中核对，包括固定请求字段。主页面不声称已知未公开的请求映射或服务默认值。提交窗口修改常用值后票据失效，必须重新校验；执行仍只发送已确认票据。参数清单有独立有界滚动、键盘焦点和长值换行。

这次只改变静态参数展示与草稿读取，刷新即生效，无后端重启、生成默认值或用户媒体改动。

当前实现：一个工作区，图像、视频、语音三个页签。界面从服务端模型目录生成常用参数输入和完整只读参数清单。Agent 使用同一模型定义规划单项请求，用户可以修改参数；检查清单后仍须显式确认生成。

## 手机布局与验证

图像页的模型和参数下拉框按所在容器确定宽度，避免原生选项的固有宽度参与撑宽。参数、结果、历史及大图预览均受工作区宽度约束；手机主滚动区限制横向边界回弹，保留纵向浏览、原图查看及预览操作换行。共用布局也覆盖视频/语音，不改变字段值、规划或确认生成流程。

`test/browser/media-lab.cjs` 在 320/393/412/768/1440px 和三个主题下检查实际内部容器的 `scrollWidth/clientWidth/scrollLeft`、控件边界、长模型/预设/选项、4096px 图片和提交清单。历史标题有意省略，不据其单独的文本 scrollWidth 推断整页溢出。所有 API/媒体使用 fixture，生成操作只落在 mock；Google Fonts 在该测试中禁用，使用系统回退字体避免截图等待外网。

```bash
PI_LAB_TEST_URL=http://127.0.0.1:3001 PLAYWRIGHT_MODULE=/path/to/playwright node test/browser/media-lab.cjs
```

iOS Safari的回弹效果仍需真机验证；Chromium宽度检查不代替目标浏览器测试。

## 实例与私人配置

每个使用者运行独立实例，不共享 Pi 凭据、项目、会话或媒体数据。此功能不是多用户权限隔离或工具沙箱。

- 公共默认值：`config/media-lab.json`，只包含中性模型定义。
- 本地覆盖：`~/.pi/agent/media-lab/profile.json`。
- 网页托管的服务/模型：同目录 `connections.json`；媒体 Key 位于 Pi 凭据库的独立命名空间，不写此文件。
- TTS registry：同目录 `tts-providers.json`；不存在时使用公共空 registry。现有 TTS adapters 的字段契约见 `tts-providers/README.md`。
- `PI_MEDIA_CONFIG_DIR` 可以覆盖本地配置目录；否则跟随 `PI_CODING_AGENT_DIR`。
- `PI_MEDIA_PROFILE=clean` 忽略本地媒体配置和项目 `.env`，用于干净预览；该模式不接受配置写入。
- `PI_MEDIA_DATA_DIR` 指定独立数据根，包含四个历史/提示词 JSON 及 `public/images`、`public/videos`、`public/audio`。未设置时沿用原位置。指定后静态媒体 404 不会回落到原目录。

分享源码时不要打包自己的本地配置、`.env`、备份或生成目录。仓库外配置也不是秘密沙箱，同一系统用户的完整 Agent 仍然可以读取它。

## 模型接入

2026-09-11：设置 → 媒体模型与实验室共用接入管理。新安装仅显示用户配置的模型；旧 Z-Image/Flux/MiniMax 视频无论是否 configured 都从公开实验室目录省略；前端对旧后端也应用同一过滤，刷新即可去掉固定列表。内部兼容定义和旧 API 保留。可用的本地接入、用户托管模型和历史不删除。空模型页提供直接接入入口。常用服务预填地址/认证，服务 ID 自动生成；模型仅常显四项基本信息，高级协议与参数映射默认折叠。新常用协议、可选参数省略、标准图像响应自动识别及实际支持范围见 [MEDIA_CONNECTIONS.md](MEDIA_CONNECTIONS.md)。后端目录和模板变化需空闲重载；静态布局刷新生效。

实验室右上角现在提供媒体 Provider、模型和 Key 的网页管理，支持常见协议模板、GET 连接测试/模型列表，以及 Agent 从 API 文档生成接入草稿。配置保存到独立的 `connections.json`，Key 通过 Pi 官方凭据接口保存；正常配置不需要编辑 `.env`。完整说明见 [MEDIA_CONNECTIONS.md](MEDIA_CONNECTIONS.md)。生产新入口由 `/api/pi/status.mediaConnections=true` 标记。

既有 `manual` 和 `http-json` 定义仍兼容，位于本地 profile。旧定义的 ID 不覆盖，编辑旧文件需在空闲时重启；新托管模型在网页新增、编辑、删除后即时生效。不要在说明、参数默认值、固定字段或 URL 中填写密钥。

模型要求可以内联于 `instructions`，也可以通过 `instructionsFile` 引用配置目录下的相对 `.md` 文件。读取会检查 realpath、目录范围和 32KB 限额。说明经 capabilities 提供给 Agent，不启用任意项目 Skill 或 shell。私人 Skill 可管理你的配方知识，但不能替代服务器参数验证。

示例，仅规划的模型：

```json
{
  "id": "custom-illustration",
  "name": "Custom Illustration",
  "kind": "image",
  "adapter": "manual",
  "instructions": "Describe the model requirements here. Use quality=standard for drafts.",
  "parameters": {
    "prompt": { "type": "textarea", "label": "Prompt", "required": true, "maxLength": 3000 },
    "quality": { "type": "select", "label": "Quality", "choices": ["standard", "high"], "default": "standard" },
    "transparent": { "type": "boolean", "label": "Transparent", "default": false },
    "settings": { "type": "json", "label": "Settings", "default": { "style": "flat" } }
  }
}
```

参数类型为 `text`、`textarea`、`number`、`select`、`boolean`、`json`。支持 required、default、const、maxLength、数字 min/max/step/integer，以及选项 choices；step 从 min 开始计数，未设 min 时从 0 开始，与 HTML 数字字段一致。未知字段、错误类型和越界值会被拒绝，不静默过滤或夹紧。JSON 控件校验对象/数组格式和大小，不是任意厂商的完整 JSON Schema 校验器；嵌套业务规则由模型说明与后端适配器负责。

## 旧 HTTP JSON 执行协议（兼容）

新托管 `http-provider` 执行器另支持 URL 下载、直接媒体文件、异步轮询及路径参数，参见接入文档。本节描述原 `http-json` 合约。

适用于同步返回一份 base64 媒体的服务或自建 bridge。给上述定义设置 `adapter=http-json`，再添加：

```json
{
  "connection": {
    "url": "http://127.0.0.1:8200/generate",
    "tokenEnv": "MY_MEDIA_API_KEY",
    "parameterKey": "input",
    "fixedBody": { "model": "custom-illustration" },
    "outputPath": ["data", 0, "b64_json"],
    "mimeType": "image/png",
    "timeoutMs": 180000
  }
}
```

提交为 `POST {"input": <用户确认参数>, "model": "custom-illustration"}`。省略 parameterKey 则参数直接放在 body 顶层；固定字段不能覆盖可编辑字段或参数 envelope。tokenEnv 可省略，存在时从服务端环境读取并构造 Bearer header；Key 不返回浏览器。连接 URL、固定请求配置和认证变量不进入 Agent capability 或公开模型响应。URL 不接受 userinfo、query 或 fragment，也不跟随重定向。

输出按 outputPath 取 base64；支持 PNG/JPEG/WebP、MP4、WAV/MP3，最大解码后 64MiB，检查基础文件签名并保存到对应历史。失败不自动重试，不从响应下载任意 URL。配置状态不等于已经完成真实网络健康检查。

旧 `http-json` 不支持 multipart、异步轮询、URL-only 输出、签名认证或流式 PCM。需要 URL/二进制/轮询时优先使用新托管服务；其他协议仍需 adapter/bridge。没有 shell adapter、自动模型安装或自动批量执行。

## 内置执行器

- Z-Image：沿用显式配置的 GPU worker。身份前缀、LoRA 文件名、权重、配方和 worker 路径来自本地配置，不在公共 UI 植入个人配方。前缀规范化后的完整提示词出现在提交清单；负面提示词仅记录的限制明确显示。
- Flux 2 Dev：设置 `FLUX2_COMFY_BASE_URL` 和需要覆盖的权重环境变量。生成前检查 ComfyUI 节点和权重；不使用其他 worker 的 LoRA。
- MiniMax H3：沿用动态 config、原生 Pi credential store、文本/可选首帧、轮询和下载。清单显示首帧，图生视频将 ratio 规范为 adaptive。
- TTS：从本地 registry 动态显示 provider、模型、音色、语言及专属选项；执行时继续复用 `TtsProviderService.resolveRequest()`。Breeze/Qwen 的 stdin bridge 和原历史兼容。

## 回复朗读复用

Pi Agent 的最终回复 TTS 入口复用本实验室的动态语音目录、字段表单和 review/execute。独立默认配置保存在工作台偏好，不覆盖实验室草稿或原 TTS registry；按用户要求，回复喇叭点击授权当前回复与默认参数，自动校验票据后单项生成并尝试自动播放，普通实验室提交仍保留清单确认。生成结果仍进入既有语音历史。自定义服务可映射顶层 text/textarea 字段接收回复，详见 [REPLY_TTS.md](REPLY_TTS.md)。

## 提交与故障语义

`review` 只做校验并返回 10 分钟的一次性票据，不调用模型生成。参数修改后浏览器禁用生成，须重新检查。`execute` 只接受 `{ticket, confirmed:true}`，不能带新参数覆盖票据。票据在第一个 await 之前占用；相同票据在运行中被拒绝，已完成则返回原结果，失败/不确定不再次执行。每服务最多两项并发，最多 100 个在内存保留的清单；payload 合计最多 64MiB，已结束结果保留 30 分钟供同票据读取。

票据和执行摘要不落盘，服务重启后失效。它们不构成外部 API 的 exactly-once 事务。断线、超时、服务重启不代表后端取消，应核对历史和服务方任务后再决定是否生成新的请求。不存在伪取消按钮，也不自动重新提交。浏览器草稿和未提交清单仅在当前页面内存。

## API

全部 `/api/pi/media/lab*` 路由复用 Pi Origin/token 校验：

- `GET /api/pi/media/lab`：脱敏模型目录和动态参数。
- `POST /api/pi/media/lab/models`：`{model, confirmed:true}`，显式添加本地模型定义。
- `GET /api/pi/media/lab/docs`：本文。
- `POST /api/pi/media/lab/plan`：`{kind, selectedModelId, instruction, parameters, cwd?}`；独立受限 no-session planner，只启用 capabilities 与 `media_plan_request`。
- `POST /api/pi/media/lab/review`：`{modelId, parameters, source?: {imageData?, imageUrl?}}`，返回规范清单与 ticket。
- `POST /api/pi/media/lab/execute`：`{ticket, confirmed:true}`。
- `GET /api/pi/media/lab/history?kind=image|video|tts`：只读旧、新记录，不自动导入或改写历史。
- `DELETE /api/pi/media/lab/history/:kind/:id`：仅用户明确选择的记录及对应本地文件。

既有只读 capabilities 增加 lab.models；Pi Package 的 `media_plan_request` 仍走无生成副作用的 `/api/media-agent/validate`，不会取得执行票据。旧三种 plan tools 保留兼容。旧 shell SD 生成接口退役为 410；Wan 路由保持 410，旧视频文件与历史保留。

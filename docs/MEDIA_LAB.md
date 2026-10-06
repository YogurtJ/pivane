# 多媒体实验室

聊天中的生成卡片是主要入口（见 [用户指南](USER_GUIDE.md#在聊天里生成图片视频和语音) 与 [MEDIA_AGENT.md](MEDIA_AGENT.md#聊天生成卡片)），卡片执行复用本页的 review/execute 票据并写入同一生成记录。实验室保留生成记录、模型接入和完整参数编辑。

## 参考图片与参考视频

模型参数声明为 `image` 或 `video` 时，图像和视频页会显示对应附件上传、预览与移除控件，提交窗口也可以更换附件。图片支持 PNG/JPEG/WebP，视频支持 MP4，单次所有附件合计最多 20MiB。服务端检查 MIME、基础文件签名、base64 和总量；服务方仍可能有更小的尺寸、时长或文件限制。图片/视频参数可声明 `multiple: true` 与 `maxItems`（默认8，最多16），显示可多选、拖放、粘贴、预览、逐项移除和调整顺序的素材区；也可使用单独的首帧、尾帧或蒙版字段。单次最多20个附件，仍共享20MiB总预算。

图片随“生成方案”传给可读图的辅助模型；文字规划中只传临时附件引用，方案不能替换用户选择的文件。参考视频当前仅提交生成模型，辅助 Agent 不解析或观看视频；需要理解视频内容时，请在创作要求里说明片段、动作和用途。附件正在读取时不能提交；更换、移除附件或修改参数都会使旧确认票据失效，迟到读取和规划不会覆盖切换后的草稿。

“接入模型”提供 OpenAI 兼容单图/多图编辑（multipart）、Gemini/Seedream 文生图与多图参考、Seedance 首帧、首尾帧、图片/视频参考模板。模型配置的“模型参考输入”直接展示上传字段，并可调整字段类型与是否多选；高级请求映射仍按服务文档设置。没有声明附件字段时，点击“配置此模型的参考输入”可直接打开该模型配置。已有文生图接口不会自动变成编辑接口；远端模型必须支持所选模板、媒体格式和输入组合。参考视频模板只适用于文档明确支持内联视频和 reference_video 角色的服务，不会自动上传到云端文件服务。

附件保留在当前页面的模型草稿和服务器短期规划/确认票据中，不保存为公共上传文件。生成历史只保留附件类型、大小及普通参数，不嵌入原始 base64；复用历史时重新选择参考附件。导出参数 JSON 会包含当前参考文件，按包含原始素材的文件保管。

## 直接生成与完整参数编辑

填写提示词、上传参考素材后即可点击“检查提交清单”，再确认生成，不需要先调用 Agent。Agent 辅助规划默认折叠，是可选步骤。常用字段直接展示，其余模型参数放在“更多参数 · 可直接编辑”中，包括种子、迭代次数、布尔值和 JSON；固定值仍不能修改。只有模型实际定义的字段才显示。

“本次生成参数”按模型定义统一展示全部参数的名称、原字段名和值，包括迭代次数、种子、布尔值和嵌套 JSON。值来自当前结构化草稿和实际定义的默认值，不从 Agent 自然语言说明推断；未指定字段明确标注，不能猜测远端默认值。输入常用参数、应用方案/预设、音色默认值变化及历史复用都会更新清单。清单文本不作为参数输入来源；专属值由本页内存保存，切模型/媒体类型按原模型草稿恢复，不另存持久配置。

专属参数可直接编辑，也可展开 Agent 辅助规划描述需求。修改创作要求本身不改变参数；迟到方案不会覆盖更新后的草稿。缺少必填参数时自动展开其所在区域并定位输入，用户可以直接补齐。长期规则仍可在模型接入的高级“模型使用要求”中保存。

主页面标注“当前参数草稿”；提交窗口按服务端规范参数显示“已校验”，完整请求映射仍在原“请求参数 JSON”中核对，包括固定请求字段。主页面不声称已知未公开的请求映射或服务默认值。提交窗口修改常用值后票据失效，必须重新校验；执行仍只发送已确认票据。参数清单有独立有界滚动、键盘焦点和长值换行。

费用由所选后端决定，当前不提供可靠报价。

## 手机布局与验证

参数、结果与素材预览保持容器内滚动和换行。`test/browser/media-lab.cjs` 使用独立服务与合成媒体核对宽度和交互；Chromium 仿真不代替 iOS Safari 真机验证。

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

设置与实验室共用[媒体接入管理](MEDIA_CONNECTIONS.md)，新托管模型即时进入目录，Key 通过原生凭据接口保存。旧 Z-Image／Flux／MiniMax 固定定义不显示在公开目录，兼容执行器和历史仍保留；能力标记为 `mediaConnections`。

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

参数类型为 `text`、`textarea`、`number`、`select`、`boolean`、`json`、`image`、`video`。附件参数使用 data URL 字符串，不允许 default/const；它们在紧凑表单中保持可编辑。支持 required、default、const、maxLength、数字 min/max/step/integer，以及选项 choices；step 从 min 开始计数，未设 min 时从 0 开始，与 HTML 数字字段一致。未知字段、错误类型和越界值会被拒绝，不静默过滤或夹紧。JSON 控件校验对象/数组格式和大小，不是任意厂商的完整 JSON Schema 校验器；嵌套业务规则由模型说明与后端适配器负责。

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

`review` 只做校验并返回 10 分钟的一次性票据，不调用模型生成。参数修改后浏览器禁用生成，须重新检查。`execute` 只接受 `{ticket, confirmed:true}`，不能带新参数覆盖票据。票据在第一个 await 之前占用；相同票据在运行中被拒绝，已完成则返回原结果，失败/不确定不再次执行。执行名额：远程服务合计 4 项（视频最多 2 项），本机 GPU/本地语音后端 1 项，名额已满返回 429（聊天卡片改为排队，见 [MEDIA_AGENT.md](MEDIA_AGENT.md#聊天生成卡片)）；最多 100 个在内存保留的清单；payload 合计最多 64MiB，已结束结果保留 30 分钟供同票据读取。

实验室票据和执行摘要仅在内存，重启后失效；聊天卡片另存尝试记录，但不保存票据或恢复队列。断线、超时和重启不证明远端取消，核对历史及服务方任务后再决定新请求。失败或不确定提交不自动重放，仅尚未提交的卡片排队项可取消。浏览器草稿仅在当前页保留。

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

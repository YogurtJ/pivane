# 媒体服务与模型接入

2026-09-11 Windows进程边界：声明式HTTP接入协议保持；旧GPU桥接适配器在Windows可使用明确的.js/.cjs/.mjs脚本，由当前Node启动。远端命令保持单个参数，正文/作业继续走stdin，不交给cmd解析；仅合成bridge验收，无真实GPU请求。私有连接、模型和凭据配置使用Windows受限ACL，详见WINDOWS.md。

当前代码提供独立的媒体Provider、模型和Key管理，以及Agent辅助接入。运行实例由 `/api/pi/status.mediaConnections=true` 标记能力，实际服务和模型须用户配置。

## 快速接入（2026-09-11）

设置 → **媒体模型** 提供图像、视频、语音入口，与实验室右上角使用同一管理窗口。Z-Image、Flux 和 MiniMax 视频不再自动注入实验室目录，即使旧本地 adapter 已配置也不显示；用户添加的模型即时进入实验室。前端兼容尚未更新的后端，刷新即可移除旧固定列表。已有可用的本地 adapter 和历史继续保留，内置协议定义仅作兼容，不代表默认已安装模型。

新增服务时可选择 OpenAI、Google Gemini、火山方舟、阿里云百炼，自动填写地址和认证方式；也可填写自己的兼容 API。服务 ID 自动生成，认证、GET 探测和下载来源放在高级连接设置中。地址可以修改为自己的代理或区域地址；预设地址不保证代理或其他区域使用相同协议。百炼预设包含文档中列出的两个中国内地音频下载来源，保存前可在高级设置核对。

添加模型常显媒体类型、协议模板、可选显示名称和服务端模型 ID。显示名称留空使用 ID；接口/输出/轮询、参数映射/模型要求默认折叠。切换已保存模型的协议或应用 Agent 草稿，仍编辑同一模型 ID。省略没有默认值的可选文本/数值字段时，不向服务发送空字符串或任意默认值；已有默认参数不变。

| 常用协议 | 基础接入与范围 |
|---|---|
| OpenAI / 兼容 Images | Base URL 通常以 `/v1` 结尾；填写用户自己的模型 ID。POST `/images/generations`，不强制 `response_format`，自动识别 `data[0].b64_json` 或 `data[0].url`；尺寸/质量选填。适用于 GPT Image 及匹配此结构的兼容服务。 |
| Gemini 生图 | Base URL `https://generativelanguage.googleapis.com/v1beta`，`x-goog-api-key` 认证。模型 ID 不带 `models/`；POST `generateContent`，从可混有文本的 parts 中取第一份 inlineData 图像。只含文本输入。 |
| 方舟 Seedream | Base URL `https://ark.cn-beijing.volces.com/api/v3`，填写模型或推理接入点 ID；Images API 返回下载 URL，尺寸选填，不启用组图。 |
| 方舟 Seedance | 同上；POST `/contents/generations/tasks`，GET 同路径的任务 ID，读取 `content.video_url`。时长/画幅/分辨率选填，具体支持值取决于模型。只含文本输入。 |
| OpenAI 兼容语音 | POST `/audio/speech`，填写模型及其支持的音色，返回完整 MP3/WAV。 |
| Qwen 原生语音 | 百炼原生非流式 JSON 请求和 WAV URL，详见下一节。 |

旧的显式 base64/URL、通用异步视频和自定义 JSON 模板继续可选。**通用异步视频是需要按文档调整的结构示例，不是所有视频服务都支持的标准协议。** 对特殊参数或其他协议，展开 Agent 文档接入；草稿和保存均不生成媒体。不支持的多步骤上传、multipart、签名或流式协议仍需专门适配。

URL 输出仍检查准确的下载来源；需要的 CDN 在高级连接设置中登记，不能用通配符或自动信任响应域名。模板不代表已验证具体账户、模型权限或付费生成。当前新增协议通过合成 HTTP 响应和隔离服务回归，真实供应商生成由使用者确认后验证。

协议参考：[OpenAI Images](https://platform.openai.com/docs/api-reference/images/create)、[Gemini 图像生成](https://ai.google.dev/gemini-api/docs/image-generation)、[火山方舟 API](https://www.volcengine.com/docs/82379/)、下方 Qwen 官方文档。提供常用协议结构，不承诺每个模型的全部参数。

## Qwen 原生语音与音色（2026-09-11）

DashScope 的聊天兼容地址不等于TTS也兼容OpenAI `/audio/speech`。将该模板直接拼到 `https://dashscope.aliyuncs.com/compatible-mode/v1` 会请求错误端点，404不是音色ID错误的证明。

中国内地非流式Qwen TTS可使用新增“Qwen 原生语音 · WAV 链接”模板：

1. 媒体Provider的Base URL设为 `https://dashscope.aliyuncs.com`，不带 `/compatible-mode/v1`；域名未变化时核对已有Key状态，Key栏留空保留。GET连接测试/模型列表只是另外的探测路径，必须按该服务实际文档配置，不能用GET测试代替合成成功。
2. 编辑模型，保留所需的 `qwen-tts` 或明确选择 `qwen3-tts-flash`，选择上述模板。它提交 `/api/v1/services/aigc/multimodal-generation/generation`，正文为 `model` 和 `input:{text,voice,language_type}`；返回 `output.audio.url` 的WAV下载链接。
3. Provider允许下载来源须按所用区域明确填写。官方旧qwen-tts示例是 `http://dashscope-result-wlcb.oss-cn-wulanchabu.aliyuncs.com`，qwen3-tts-flash示例是 `http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com`；如返回HTTPS，再添加相应HTTPS来源，不用通配符，跨来源不带Provider Key。
4. 模板提供四个常用音色：`Cherry`（芊悦）、`Serena`（苏瑶）、`Ethan`（晨煦）、`Chelsie`（千雪）。**Cherry是有效的系统音色ID**。其他音色及其模型支持范围见官方[非实时音色表](https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list)。
5. 保存模型后，到设置→使用偏好→回复朗读重新保存该模型的参数；旧OpenAI模板的speed/response_format应移除。新表单使用voice/language_type，文本参数仍为input。

官方[qwen-tts API文档](https://help.aliyun.com/zh/model-studio/qwen-tts-api)规定旧qwen-tts最多512 Token，qwen3-tts-flash最多600字符。本模板设保守的512字符上限，不能代替旧模型的服务端Token检查；长回复不自动截断或拆分。仅有新模板和配置保存不能证明真实语音已生成，须由使用者以短文本校验清单并明确确认。此前失败票据不能重放。

模板只填模型表单并显示配置提示，不自动修改Provider、Key或默认朗读偏好，也不执行任何生成请求。

## 从网页接入自己的服务

1. 打开多媒体实验室，点击右上角的接入按钮，选择“新增服务”。
2. 填写服务名称、ID、Base URL 和认证方式。支持 Bearer Key、自定义 Key Header，以及无需 Key 的本地服务。
3. 填写自己的 API Key 并保存。已有 Key 不回显，留空保留；改变服务来源后必须重新保存 Key。
4. 在该服务下点击“添加模型”。可以手动填写服务端模型 ID，也可从 GET 模型列表中选择。
5. 选择图像、语音或异步视频等协议模板；核对接口路径、结果形式和模型要求，保存后即可在实验室选择。
6. 按正常流程填写生成参数、检查清单、确认生成。

常见模板可以通过表单配置；复杂的参数定义与请求映射在“高级”中编辑 JSON。模板描述常见协议结构，不保证任意同名兼容 API 接受完全相同的参数。对参数差异较大的模型，可用 Agent 接入草稿。

内置 Z-Image、Flux、MiniMax H3 和本地 TTS registry 继续保留原配置。新增 HTTP 媒体服务不会修改它们，也不会将媒体模型加入 Pi 的聊天模型列表。

## Agent 辅助接入

在模型编辑页展开“让 Agent 根据 API 文档生成接入草稿”，粘贴 API 说明、请求/响应示例，或选择 UTF-8 文档文件。不要包含 Key。

专用 planner 只允许 `media_get_connection_schema` 与 `media_plan_connection`，使用官方 `--no-session`，没有文件、shell、保存、连接测试或媒体执行权限。选择的 Provider 及认证方式固定，Key 不进入提示词。服务端会移除已知 Key 和常见凭据字段值；仍应检查所粘贴文档不含其他秘密。

Agent 返回的草稿自动填入表单，用户可继续修改，再明确保存。没有保存就不会新增模型；保存本身也不会生成媒体。文档协议超出支持范围时，planner 返回 unsupported 原因，不伪造可执行配置。用户修改字段或关闭/切换编辑页后，迟到的草稿不会覆盖新内容。

## 支持的执行协议

| 流程 | 配置 |
|---|---|
| JSON POST → 标准图像 JSON | `type=image-json`；path 指向含 `b64_json` 或 `url` 的对象，优先非空 base64；仅图像模型可用 |
| JSON POST → JSON base64 | `http.response.type=base64` 与结果字段路径 |
| JSON POST → JSON URL → 下载 | `type=url`；下载来源必须已允许 |
| JSON POST → 媒体文件 | `type=binary`，常用于 MP3/WAV TTS |
| JSON POST → 任务 ID → GET 轮询 → base64/URL | 配置 `http.poll`、状态字段及状态值 |

创建请求使用 POST，只提交一次，不跟随重定向、不自动重试。轮询是同一 Provider 来源的 GET；查询 URL 可以由路径模板组成，也可读取提交响应中的 URL。失败、未知状态或超时后保留已有 taskId 供排查，不重新创建任务。

结果支持 PNG/JPEG/WebP、MP4、WAV/MP3，按文件签名验证，单项最大 64MiB。`mimeType=auto` 根据内容识别格式，并检查与所选媒体类型一致。下载允许最多三次重定向，每一跳都检查来源。Key 仅发送到 Provider 自身来源，不发送到另一个 CDN 来源；也拒绝输出 URL 中夹带当前 Provider Key。

结果字段路径中的 `*` 可选择数组内第一个存在的匹配字段，例如 `candidates.0.content.parts.*.inlineData.data` 可跳过 Gemini 的文本 part。它不表示批量下载，仍只保留第一份输出。

来源包含协议、主机与端口。例如 `https://api.example.com` 与 `https://cdn.example.com` 是不同来源。额外 CDN 来源在 Provider 编辑页逐项登记，不支持通配符。允许从已明确配置的本地 HTTP 服务下载。

## 请求映射

接口路径始终追加到 Base URL 的路径前缀后。例如 Base URL 为 `https://api.example.com/v1`，路径 `/images/generations` 会请求 `/v1/images/generations`，不要重复填写 `/v1`。

路径支持 `{model}`、`{param:字段名}`；查询模板另支持 `{id}`。插入值经过 URL 编码，参数必须是标量。下面可用于把音色 ID 放在路径中的语音服务：

```json
{
  "path": "/text-to-speech/{param:voice}",
  "body": {
    "model_id": { "$model": true },
    "text": { "$param": "text" },
    "voice_settings": { "$param": "voice_settings" }
  },
  "response": { "type": "binary", "mimeType": "audio/mpeg" },
  "timeoutMs": 180000
}
```

请求体是普通 JSON 模板，只支持三个引用：

- `{"$param":"name"}`：插入该字段的类型化值，未提供的可选参数会省略。
- `{"$model":true}`：插入服务端模型 ID。
- `{"$params":true}`：插入全部参数对象。

没有脚本、表达式求值或任意代码。单份模板上限 32KB，展开后的请求体上限 4MiB，递归层数受限。凭据不能放在请求模板或 API URL 中。

参数沿用实验室的 text、textarea、number、select、boolean、json 定义；类型、选项、范围、固定值、未知字段和大小在服务端重验。嵌套厂商规则仍需由参数说明和适配器约束，不是完整通用 JSON Schema 引擎。

## 异步轮询

```json
{
  "path": "/video/generations",
  "body": { "model": { "$model": true }, "prompt": { "$param": "prompt" } },
  "poll": {
    "idPath": ["id"],
    "path": "/tasks/{id}",
    "statusPath": ["status"],
    "pending": ["queued", "running"],
    "succeeded": ["succeeded"],
    "failed": ["failed", "cancelled"],
    "intervalMs": 5000
  },
  "response": { "type": "url", "path": ["output", "url"], "mimeType": "video/mp4" },
  "timeoutMs": 1800000
}
```

也可用 `urlPath:["urls","get"]` 代替 poll.path，查询 URL 必须仍在 Provider 来源中。状态组支持字符串、布尔值、数字或 null，组间不重复；null 可表示响应暂缺状态字段。例如 `pending:[false,null]`、`succeeded:[true]`。表单中使用 JSON 数组表达非字符串状态。

查询间隔 1–60 秒，总等待 1–1800 秒。创建、轮询和下载共用该总超时。生成状态显示提交、查询及下载阶段和已有 taskId；状态只在服务器票据内存中，不是持久任务队列。

## 配置与凭据

- 新服务与模型：`<媒体配置目录>/connections.json`，版本 1，0600 原子替换与备份。
- 每个服务可有多种媒体模型，最多 40 个服务、合计 60 个托管模型，配置文件上限 2MiB。
- Key 通过 Pi 官方 `ModelRuntime.login/logout` 保存到选定 Pi Agent 凭据库，ID 使用 `pi5-media:<服务ID>`。
- 凭据 runtime 使用公开 `registerNativeProvider` 注册无聊天模型的认证入口，不更改 `models.json` 或聊天模型偏好。
- Key 按 Pi config-value 语法编码为字面量，`!`、`$` 不会被当作用户要求执行的命令或环境变量。
- 配置响应、模型目录、导出和 planner 都没有 Key；网页只显示是否已保存和是否需重新绑定。
- 保存服务配置和保存 Key 是两次有序操作。Key 保存失败时界面说明服务已保存，要求刷新状态，不把整个流程伪装为成功。

配置修改校验 expectedRevision，拒绝旧页面覆盖新配置。托管执行和连接探测期间拒绝修改配置/Key；修改配置或 Key 会让旧 review 票据失效，必须重新检查。即使持久化失败，本进程也使旧配置修订失效。删除服务/模型仅删除接入配置和相应凭据，原历史/媒体继续保留。

## 连接测试与限制

“连接测试”仅对配置的 probePath 发 GET，不生成媒体。“读取模型列表”支持根数组或 data/models 数组中的 id/name；不支持列表接口时可手动填写模型 ID。GET 成功只表示该接口可访问，不证明 Key 具备生成权限、模型参数正确或输出下载可用。

尚不支持任意 multipart、流式 PCM、复杂请求签名、OAuth、多步骤上传工作流或任意 ComfyUI workflow 导入。这些需要专门 adapter/bridge，不能仅添加模型名称就宣称可执行。已有首帧上传仍由 MiniMax adapter 处理；通用模型可配置 URL 参数，但尚未增加通用文件上传控件。

## API

全部位于 `/api/pi/media/lab`，继承 Origin/可选 token 验证：

| Method | 后缀 | 请求/用途 |
|---|---|---|
| GET | `/activity` | 媒体执行/连接操作的内存计数，供空闲部署检查 |
| GET | `/connections` | 服务/模型、修订、Key 状态、协议模板 |
| POST | `/providers` | `{provider, create?, expectedRevision, confirmed:true}` |
| DELETE | `/providers/:id` | `{expectedRevision, confirmed:true, removeModels?}` |
| POST | `/providers/:id/key` | `{apiKey, expectedRevision, confirmed:true}` |
| DELETE | `/providers/:id/key` | `{expectedRevision, confirmed:true}` |
| POST | `/providers/:id/probe` | `{mode:"connection"或"models", confirmed:true}`，只执行 GET |
| POST | `/providers/:id/models` | `{model, expectedRevision, confirmed:true}`，新增/编辑 |
| DELETE | `/providers/:id/models/:modelId` | `{expectedRevision, confirmed:true}` |
| POST | `/connection-plan` | `{providerId, kind, remoteModel, documentation, instruction?, cwd?}` |
| GET | `/execution/:ticket` | 票据状态及阶段/taskId，无正文或凭据 |

纯 schema/draft 工具接口为 `GET /api/media-agent/connection-schema` 与 `POST /api/media-agent/connection/validate`，不读 Provider Key、不保存、不测试服务、不创建执行票据。

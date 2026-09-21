# 回复朗读（TTS）

朗读入口由运行实例的 `/api/pi/status.replyTts=true` 提供。可执行模型取决于用户配置；新安装没有默认语音服务。

## 使用

Pi Agent 每个用户问题段的最终文字回复，在复制／分叉所在操作行提供扬声器按钮。沿用最终回复判定，运行中、思考和工具过程不新增朗读操作。

1. 点击“朗读回复（TTS）”即授权按当前默认配置生成这一条回复。后台读取默认值、校验并取得票据，然后单项执行；正常流程没有参数或确认弹窗。默认取正文，移除 Markdown 标记、代码块和图片，保留行内代码、链接显示文字、标题与列表；不读取思考、工具记录或其他轮次。
2. 生成中在输入框上方显示紧凑状态栏，原回复喇叭显示进度；不禁用输入、发送、附件或其他工作区。完成后尝试自动播放，可原地暂停、拖动进度、下载或收起。浏览器拒绝自动播放时显示提示，点击原生播放器即可播放已有音频，不重新生成。
3. 参数统一在“设置 → 使用偏好 → 回复朗读（TTS）”配置，也可从播放器的设置按钮进入。共用实验室动态模型与字段，不写死 Provider、模型、音色或专属参数；自定义服务可指定 text/textarea 字段接收正文。保存只写模型、文本字段名与其余参数，不包含回复正文，不生成语音。
4. 默认偏好在此实例跨设备使用，下一次点击喇叭读取，不改变聊天模型或实验室草稿。没有独立默认偏好时直接使用语音目录中 preferred 且可执行的模型及其默认参数，不自动保存选择；无可用默认或已有保存配置失效时才引导到设置，不自动执行任意其他模型。
5. 本页最多保留八条任务／音频引用。同一条生成中重复点击不重复提交；已生成的回复再次点击为播放／暂停，不重复合成。刷新后可从既有语音历史找回音频，不在 Pi JSONL 建立额外记录。

模型字符限制来自实时参数定义。超长正文在状态栏明确报错，不提交；可在设置选择支持更长文本的模型，或去语音实验室编辑文本。不会自动截断、摘要、跨模型回退或批量拆分。已有 TTS adapter 内部分段保持原契约。

## 选区朗读

在主对话或侧聊的单条消息正文中选中文字，点击选区菜单中的“朗读选区”，即授权使用当前默认配置生成这一段文字。只提交所选的可见文字，不重新解析 Markdown，不读取整条回复、思考或工具记录。菜单在后端尚未启用回复朗读时禁用该项。

选区与整条回复共用播放器、实时模型限额、单项生成互斥和错误处理；同线程同来源的相同选区可复用本页音频引用，不自动重试、不分段批量提交。没有默认配置时打开设置，保存后仍需重新点击朗读。切换线程和迟到结果隔离沿用下述生命周期。

## 执行与生命周期

- 2026-09-08 用户明确要求一键生成并自动播放，喇叭点击作为当前回复与默认配置的单项执行授权。继续通过 `/review` 和 `/execute`，只提交 `{ticket, confirmed:true}`；不新增直连合成端点或放开 Agent 生成工具，实验室其他生成流程仍保留清单确认。
- 当前页面最多一项未完成的合成请求，不增加队列或自动批量执行。设置弹窗独立于播放器，关闭设置不影响生成／播放。收起播放器暂停播放；已提交的远端生成仍会完成并保存历史。
- 主连接切换或播放器收起使尚未执行的迟到 review 失效，已经提交的迟到结果可以保留音频引用，但不重新打开播放器或自动播放到新线程。继续发送同线程消息不会停止生成或清空草稿。
- 失败、超时或无有效音频返回在状态栏显示；没有自动重试。“重新生成”是用户显式操作，不确定提交仍要求先核对历史／服务方任务。刷新不能视作取消或确认未提交。
- 点击音频播放时暂停本页其他 audio，避免多条语音同时播放。浏览器原生播放器负责暂停和播放速度等其支持的功能；不依赖浏览器 `speechSynthesis`。

## 默认偏好 API

全部接口复用 `/api/pi` 的 Origin 和可选 Bearer token，响应 `Cache-Control: no-store`，不返回服务连接或凭据。

`GET /api/pi/settings/reply-tts` 返回：

```json
{
  "models": [{ "id": "my-speech-model", "kind": "tts", "parameters": {}, "textFields": ["input"] }],
  "defaults": { "modelId": "my-speech-model", "textParameter": "input", "parameters": { "voice": "my-voice" } },
  "revision": "opaque-sha256-revision",
  "hasSavedDefaults": true,
  "warning": ""
}
```

models 使用实验室公开模型结构，仅列有可编辑文本字段的语音模型。无保存配置时 defaults=null；失效的保存配置同样返回 null，但保留 hasSavedDefaults=true 并给出 warning。

`PUT /api/pi/settings/reply-tts` 接受且只接受：

```json
{
  "modelId": "my-speech-model",
  "textParameter": "input",
  "parameters": { "voice": "my-voice" },
  "expectedRevision": "revision-from-get"
}
```

- parameters 不得包含 textParameter 对应的正文值；不保存测试文本或回复内容，未知字段拒绝。
- 复用 `validateParameters()` 的动态规则和 `MediaLabService.validate()`；内置 adapter 继续通过 `TtsProviderService.resolveRequest()` 规范化。验证用单字符占位仅在内存，不创建票据或合成。
- 请求最多 64000 字符；缺少／冲突 revision 返回 409，非法模型、字段或参数返回 400。异步验证后再同步检查 revision，两个浏览器同版并发保存最多一个成功。
- revision 覆盖实时公开模型目录与当前 replyTts 偏好。保存到 `pivane-workspace.json.replyTts`（既有 `pi5-workspace.json` 自动沿用），0600 原子替换并保留其他偏好；不写 models.json、auth.json 或 Pi session。
- 成功返回 `{defaults, revision}`，下一次打开生效；不重启聊天 worker。

## 实现与验证

- `server/pi-reply-tts-service.js`：偏好读写边界、动态校验、修订冲突。
- `public/pi-reply-tts.js`：默认配置窗口、一键后台生成、正文转换、页面内播放器及迟到结果隔离。
- `public/media-fields.js`：从实验室提取的共享动态字段渲染／读取，支持 text/textarea/number/select/boolean/json。
- `public/pi-chat.js` 仅提供最终回复按钮、能力标志和主连接关闭回调。

Node 专项 `test/pi-reply-tts.test.js` 使用临时偏好与模拟服务；实验室 gateway 用例检查鉴权与非法类型拒绝。浏览器 `test/browser/pi-reply-tts.cjs` 使用 mock REST/WebSocket 和 WAV，验证三视口／主题一键生成、生成时继续输入并发送、草稿保持、自动播放／浏览器拦截兜底、缓存播放／暂停、默认保存／冲突、已有 registry 默认、超限、失败／显式重试及切线程／收起期间迟到响应；不创建真实 session 或发起真实合成。此交互调整只修改静态资源，刷新生产页面生效，无需重启。

真实 GPU／付费 TTS smoke 未执行。浏览器为系统 Chromium 仿真，未替代 Safari 真机播放验证。

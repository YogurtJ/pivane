# TTS Provider Contract

TTS provider 的模型、音色、语言、字符限制和专属控件维护在实例本地 `media-lab/tts-providers.json`。路径跟随 `PI_MEDIA_CONFIG_DIR` 或 `PI_CODING_AGENT_DIR`；公共 `config/tts-providers.json` 是空 registry。浏览器通过 `/api/tts/config` 或实验室动态目录读取脱敏元数据，不保存静态音色表。

## 增加 Provider

1. 在本地 `tts-providers.json` 增加 provider 和 model metadata。
2. 在 `server/tts-provider-service.js` 增加或复用 adapter；凭据只能从服务端环境读取。
3. 在本目录增加 provider 文档，并通过 provider 的 `documentation` 字段关联。
4. 为配置解析、校验与 adapter 协议增加隔离 fixture 测试；真实收费生成须用户明确授权。
5. 更新架构、API、运维、路线图和 CHANGELOG。

配置中的 `settings` 只在服务端使用，不会通过 config API 返回。文档读取被限制在本目录内。新增 adapter 时不得把用户文本拼进 shell 命令；命令型 provider 应通过 stdin 或临时文件传结构化 payload。

## 当前通用字段

- Provider 和模型选择。
- 音色 preset 和语言选择。
- 语速与原生音频播放器。
- Provider/model 定义的单行文本、多行文本与数值型专属参数；服务端按 metadata 做长度、范围和整数校验。
- 本地音频历史、播放、复用、下载和删除。

历史记录保留 provider、model、voice、language、speed、provider options 和可选性能 metadata。旧 MiniMax 记录没有这些新增字段时仍可读取。

当前 adapter：

- `breeze-gpu`：multipart 通过 stdin 发送，裸 PCM 封装为 WAV；默认 Voice Design，Voice Clone 尚未接入 Web 上传契约。
- `qwen3-gpu`：JSON 通过 stdin 发送，返回 WAV。
- `minimax`：服务端 Key 的兼容 HTTP adapter。

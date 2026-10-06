# TTS Provider Contract

本目录说明旧 `tts-providers.json` registry adapter，路径跟随 `PI_MEDIA_CONFIG_DIR` 或 `PI_CODING_AGENT_DIR`。公共 registry 为空，模型、音色、语言、限额和控件由实例配置提供，API 只返回脱敏 metadata。网页托管 HTTP TTS 另见[媒体连接](../MEDIA_CONNECTIONS.md)，配置和凭据路径不混用。

## 增加 Provider

1. 在本地 registry 登记 Provider 和模型 metadata。
2. 在 `server/tts-provider-service.js` 增加或复用 adapter；registry 凭据从服务端环境读取，正文经 stdin，不能拼入 Shell。网页 HTTP 服务另走原生凭据生命周期。
3. 在本目录新增说明并通过 `documentation` 关联，登记公开文档。
4. 添加隔离协议测试，更新实际受影响的契约；真实收费请求需授权。

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

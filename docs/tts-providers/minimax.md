# MiniMax TTS

## 当前状态

本地 registry 包含并启用 MiniMax 条目时才显示该 Provider；公共空 registry 不自动注入模型。服务端读取 `MINIMAX_API_KEY` 或兼容旧拼写 `MIMIMAX_API_KEY`，均缺失时禁止生成，历史播放保留。

## 配置

```env
MINIMAX_TTS_BASE_URL=https://example.invalid/v1
MINIMAX_TTS_MODEL=speech-2.8-hd
MINIMAX_TTS_VOICE=Chinese (Mandarin)_IntellectualGirl
MINIMAX_API_KEY=
```

兼容旧拼写 `MIMIMAX_API_KEY`，新配置不得继续使用该拼写。Key 只由服务端读取，不返回浏览器。

## 接口约定

adapter 请求 `${MINIMAX_TTS_BASE_URL}/audio/speech`，接受直接音频或 MiniMax hex audio JSON。旧实现首次响应未形成可用音频且请求含 `speed` 时，会移除 `speed` 及其他未保留可选字段再提交一次，条件不只限于“不支持语速”。此兼容重试不等同统一票据的不重放保证；排障需核对服务任务和费用。

模型和音色 metadata 维护在本地 `media-lab/tts-providers.json`。配置或更换服务后，以真实接口核对模型 ID、音色 ID、字符限制和返回格式，再更新本地配置。

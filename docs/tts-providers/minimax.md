# MiniMax TTS

## 当前状态

MiniMax adapter 保留用于以后续费恢复。没有 `MINIMAX_API_KEY` 时 provider 会出现在网页中，但标记为未配置并禁止生成；历史播放不受影响。

## 配置

```env
MINIMAX_TTS_BASE_URL=https://example.invalid/v1
MINIMAX_TTS_MODEL=speech-2.8-hd
MINIMAX_TTS_VOICE=Chinese (Mandarin)_IntellectualGirl
MINIMAX_API_KEY=
```

兼容旧拼写 `MIMIMAX_API_KEY`，新配置不得继续使用该拼写。Key 只由服务端读取，不返回浏览器。

## 接口约定

adapter 请求 `${MINIMAX_TTS_BASE_URL}/audio/speech`，接受直接音频响应或 MiniMax hex audio JSON。若中转接口拒绝 `speed`，会移除语速参数自动重试一次。

模型和音色 metadata 维护在本地 `media-lab/tts-providers.json`。配置或更换服务后，以真实接口核对模型 ID、音色 ID、字符限制和返回格式，再更新本地配置。

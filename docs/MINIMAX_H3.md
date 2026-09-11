# MiniMax H3 Video

最后核对：2026-09-04。

## 当前实现

本文描述兼容的MiniMax H3官方V2执行器；新实验室只显示用户添加的模型，不自动提供固定视频模型列表。旧Wan2.2/RunPod ComfyUI视频生成入口退役，历史保留。

支持：

- `MiniMax-H3`：768P / 2K，4–15 秒。
- `MiniMax-H3-Max`：480P / 768P，5–15 秒。
- 纯文本生成视频。
- 可选首帧图生视频。
- `adaptive`、21:9、16:9、4:3、1:1、3:4、9:16 画幅。
- Agent 自然语言规划和第一项表单映射。
- 异步任务轮询、临时 CDN 视频下载、本地历史保存。

首帧存在时，官方 API 会从图片决定画幅，服务端固定发送 `ratio=adaptive`。纯文本请求不能使用 `adaptive`，服务端默认规范为 16:9。

## 认证

优先顺序：

1. `MINIMAX_VIDEO_API_KEY`
2. `MINIMAX_API_KEY`
3. Pi credential store 中的 `minimax` Provider

推荐在工作台 `设置 > Provider > MiniMax > 设置 Key` 中配置。Key 通过 Pi `ModelRuntime.login()` 写入 credential store，现有值不会发送到浏览器。视频 adapter 通过服务端 `ModelRuntime.getAuth('minimax')` 解析。

设置后不需要重启服务；重新检查视频 Provider 即可。

可选环境配置：

```env
MINIMAX_VIDEO_BASE_URL=https://api.minimax.io
MINIMAX_VIDEO_MODEL=MiniMax-H3
# MINIMAX_VIDEO_API_KEY=
MINIMAX_VIDEO_POLL_MS=5000
MINIMAX_VIDEO_TIMEOUT_MS=1800000
```

## API 流程

```text
POST https://api.minimax.io/v2/video_generation
  -> task_id
GET  https://api.minimax.io/v2/query/video_generation/{task_id}
  -> queued | running | succeeded | failed | cancelled
succeeded -> task.content.url
  -> Pivane 立即下载到 public/videos/
  -> video_history.json
```

请求使用官方 multimodal `content`：

```json
{
  "model": "MiniMax-H3",
  "content": [
    { "type": "text", "text": "A slow cinematic push in" },
    {
      "type": "image_url",
      "image_url": { "url": "data:image/png;base64,..." },
      "role": "first_frame"
    }
  ],
  "resolution": "768P",
  "duration": 5,
  "ratio": "adaptive"
}
```

首帧可来自浏览器上传或 `/images/` 本地图库。浏览器限制 PNG/JPG/WEBP 和 20MB；服务端不接受任意外部图片 URL。

## 本地历史

新记录：

- `source=minimax-h3-v2`
- `provider=minimax`
- `taskId`
- `model`、`resolution`、`duration`、`ratio`
- `prompt`、`hasSourceImage`、可选 `sourceImageUrl`
- `usage`
- 本地 `videoUrl`

旧 Wan/LTXV 历史不迁移、不删除，仍能播放。旧 `/api/runpod/video/config`、`health`、`generate` 返回 410；history 会重定向到统一的新历史接口。

## 费用边界

`POST /api/video/generate` 是真实高成本请求。模块 Agent 的 `media_plan_video` 仍只有规划副作用，不会调用该接口。持久队列完成前，MediaPlan 固定为 `execution.mode=manual`。

官方 H3 需要 Pay-as-you-go API。未配置 Key 时生成按钮禁用，health 返回 `configured=false`。

# Breeze TTS 2 adapter

当前 adapter 接入 `BreezeBlue/breeze-tts-2` 的 Voice Design。服务、音色和默认值由实例本地 `media-lab/tts-providers.json` 配置，公共源码不附带个人音色配方或 GPU 地址。

## 协议

- Provider adapter：`breeze-gpu`，通过显式 `GPU_EXEC` bridge 连接远端服务。
- 先读取 settings.healthUrl；未启动时调用 settings.startScript，按 startupTimeoutMs 等待。
- 在本地构造 text、instruction、cfg_scale、seed 的 multipart body，通过 child stdin 发送到固定 curl 命令。
- 接收 base64 的 24 kHz、s16le 单声道 PCM，在本地验证并封装为 WAV。
- 用户 text/instruction 不拼进 shell。服务单并发时可能返回 HTTP 409，不能把它当作成功。

settings 的 healthUrl、speechUrl、startScript 可分别被 `BREEZE_TTS_HEALTH_URL`、`BREEZE_TTS_SPEECH_URL`、`BREEZE_TTS_START_SCRIPT` 覆盖。settings 不返回浏览器。

## 动态参数

音色只是本地 registry 中的一组命名 options。instruction、CFG、seed 的默认值与限制由模型 controls/voices 提供，不在前端写死。Breeze 支持中文/英文，instruction 描述音色、节奏和表达方式；seed 影响声线与生成变化。语速为自然语言语义控制，不保证精确倍速。

实验室以 `option_instruction`、`option_cfgScale`、`option_seed` 展示，校验后映射为原 `/api/tts` 的 options。清单显示规范化后的实际参数；历史继续保存 options 和性能 metadata。

## Fast 长文本

已验证的 fast profile 只预热到 batch 2/token bucket 512。长输入可能在 HTTP 200 streaming headers 后中断，得到半截 PCM。因此 adapter 根据本地 settings 的 maxChunkCharacters、maxCombinedCharacters、chunkPauseMs：

1. 按标点优先拆分正文，每段满足字符预算。
2. instruction 和语速指令计入合并预算。
3. 各段以相同 options 串行生成。
4. 插入指定静音后拼接一个 WAV。

分段长度与静音间隔由部署者按实际fast profile验证，不在公共配置中提供个人配方。history 的 extraInfo 包括分段、耗时、音频时长、RTF 和 fast 状态。fast/eager 输出不保证逐字节等价，修改远端模式时同步本地 registry 的 fastMode。HTTP headers 的 TTFA 不能冒充首个 PCM 字节延迟。

## 范围

远端可能支持参考音频，但本项目尚未实现 Voice Clone 上传契约。模型权重/GPU 服务不随试用包安装。模型许可和部署条件应查阅 [Breeze 官方模型说明](https://huggingface.co/BreezeBlue/breeze-tts-2)；使用自己的服务与音色配置。

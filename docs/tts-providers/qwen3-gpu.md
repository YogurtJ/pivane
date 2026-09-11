# Qwen3-TTS GPU adapter

这是自建Qwen3服务的兼容adapter，不是DashScope托管Qwen语音HTTP模板。托管服务接入见[媒体连接](../MEDIA_CONNECTIONS.md)。

## 前提与协议

- adapter标识`qwen3-gpu`，使用Qwen3-TTS-12Hz-1.7B-CustomVoice。
- 服务目录、健康检查地址、语音地址与bridge由实例本地registry/settings和相应环境变量配置，发布包不安装模型或提供远端主机。
- 通过显式GPU_EXEC传输JSON，远端返回base64 WAV；正文经stdin，不进入shell命令。
- 健康检查及按需启动遵循adapter设置；部署者应核对启动脚本、tmux会话和GPU资源，不能假定已有常驻服务。

可覆盖QWEN3_TTS_HEALTH_URL、QWEN3_TTS_SPEECH_URL、QWEN3_TTS_REMOTE_ROOT和QWEN3_TTS_SERVICE_SESSION。不要复制他人的SSH主机、目录、设备选择或凭据。

## 模型参数

字符上限、音色、语言和instruct限制来自实际registry。常见CustomVoice音色包括Vivian、Serena、Uncle Fu、Dylan、Eric、Ryan、Aiden、Ono Anna和Sohee，语种能力以模型和服务实际版本为准。

语速滑杆会转换为附加风格指令，属于语义控制，不保证精确倍速。实际控件由服务端目录提供，前端不固定音色列表。

当前只接入CustomVoice；VoiceDesign和Voice Clone需要不同输入契约与资源策略，不能仅添加一个配置项就称为可用。模型/生成许可和运行环境由部署者核对；真实生成使用用户自己的服务。

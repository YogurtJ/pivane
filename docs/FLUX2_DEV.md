# Flux 2 Dev Image Backend

最后核对：2026-09-08。

## 当前实现

保留Z-Image与`flux-2-dev`旧执行器兼容；它们不自动出现在新的实验室目录。Flux使用官方ComfyUI workflow，不复用其他worker的LoRA或个人提示词前缀。

默认参数：

- 1024×1024
- 20 steps
- Flux guidance 4
- Euler sampler
- Flux 2 scheduler
- 随机 seed

范围：

- width/height 256–2048，64 对齐
- steps 4–50
- guidance 1–10

## ComfyUI 要求

需要当前版 ComfyUI 和以下官方模型文件：

```text
models/diffusion_models/flux2_dev_fp8mixed.safetensors       35.46 GB
models/text_encoders/mistral_3_small_flux2_fp8.safetensors   18.03 GB
models/vae/flux2-vae.safetensors                              0.34 GB
```

来源：`Comfy-Org/flux2-dev`。使用者须自行提供ComfyUI与模型文件；只有实际节点/权重检查通过才算后端就绪。

实验室的 Flux 地址来自服务端环境，不在浏览器保存连接配置：

```env
FLUX2_COMFY_BASE_URL=https://xxxx-8188.proxy.runpod.net
FLUX2_DIFFUSION_MODEL=flux2_dev_fp8mixed.safetensors
FLUX2_TEXT_ENCODER=mistral_3_small_flux2_fp8.safetensors
FLUX2_VAE=flux2-vae.safetensors
```

## Workflow

`server/flux2-workflow.js` 使用官方节点：

- `UNETLoader`
- `CLIPLoader(type=flux2)`
- `VAELoader`
- `CLIPTextEncode`
- `FluxGuidance`
- `EmptyFlux2LatentImage`
- `Flux2Scheduler`
- `RandomNoise`
- `BasicGuider`
- `KSamplerSelect(euler)`
- `SamplerCustomAdvanced`
- `VAEDecode`
- `SaveImage`

健康检查与生成前检查都读取 `/object_info`，验证全部 workflow 节点和三个权重文件。缺项不提交；POST `/prompt` 不自动重试，避免不确定响应导致重复生成。

生成通过 ComfyUI `/prompt`、`/history/{promptId}`、`/view` 完成，输出立即保存到 `public/images/` 并追加现有 `generation_history.json`：

- `source=runpod-comfyui-flux2`
- `model=flux-2-dev`
- `engine=Flux 2 Dev FP8 (ComfyUI)`

## GPU 约束

三个FP8文件约53.8GB，尚未包含推理激活与ComfyUI开销。部署前核对自己的GPU容量、其他任务和资源调度，不能凭模型出现在目录中宣称常驻可用。发布包不自动下载权重或停启其他GPU工作负载。

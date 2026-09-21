# 辅助模型

“设置 → 使用偏好 → 辅助模型”集中管理已经实现的辅助任务模型。按用途选择供应商和模型，点击“保存更改”后用于后续任务。保存只核对配置和认证，不会生成标题、规划媒体、执行媒体或安装资源。

## 当前用途

| 用途 | 作用 | “自动”的含义 |
|---|---|---|
| 标题生成 | 新线程自动命名、手动重新生成标题 | 使用该线程当前的聊天模型 |
| 媒体规划 | 实验室图像/视频/语音参数，以及模型接入方案 | 依次参考服务器媒体规划配置、Pi 默认模型及可用模型 |

两项可以选择同一个便宜模型，也可以分别选择适合各自任务的模型。模型目录来自实际 Pi 配置，只提供已接入且可用的文本模型；被移除或暂不可用的已保存选择仍保留显示，不自动替换为第一项。

媒体规划的“自动”沿用既有规则：`PI_MEDIA_PLANNER_MODEL` 与 Pi 默认模型形成候选，均无匹配时选第一个可用非 batch 模型。方案失败可以尝试其他默认候选，响应报告实际模型及回退情况。标题与媒体都明确指定了模型时，配置失效或请求失败不会偷偷换成其他模型。媒体 API 兼容显式 provider/modelId 覆盖单次请求，该显式选择同样不回退。

齿轮按钮展开该用途的说明及已实现选项。标题行提供“自动生成会话标题”开关；关闭后仍可手动生成。标题仅发送最多 8,000 字符问答摘录，不携带完整历史或主线程系统提示，不进入主聊天上下文。媒体规划只产生可编辑方案，执行仍需在实验室单独确认。详细范围见[会话工作流](SESSION_WORKFLOWS.md#自动标题与重新生成)与[媒体 Agent](MEDIA_AGENT.md)。

“全部设为自动”先清除各行的专用模型选择，点击保存后生效；不重置自动标题开关，也不修改主聊天默认模型、媒体执行模型或凭据。保存不会重定向或重发正在进行的请求。配置变更会使正在生成的旧自动标题失效；手动标题建议仍标明本次模型并等待保存。

## 兼容与存储

已有标题模型和媒体“模块 Agent”选择直接显示在新卡片中，不进行开机迁移或重复保存。原来的两张独立配置卡片在新后端隐藏；缺少辅助模型能力的后端仍使用原入口。

Pi 原生会话仍是唯一聊天事实来源。工作台使用所选偏好文件的 `sessionTitles` 和 `mediaAgent`，新文件默认 `pivane-workspace.json`，已有 `pi5-workspace.json` 自动沿用，不另存第二套路由或聊天历史。`sessionTitles.revision` 与媒体配置变更计数供并发检测，未知配置和无关偏好保持。界面开关、模型路由、媒体执行参数是独立状态。

原 `/settings/session-titles` 和 `/settings/media-agent` API 保留；从旧入口保存的变化会使新入口的旧修订失效。新入口一次保存所有改动；异步模型校验期间，另一页面改了相关设置则整次拒绝，不部分覆盖。失败后保留未保存选择并读取最新修订，由用户核对后再保存。标题请求的本次 Token 显示与持久用量统计口径不变。

## REST 契约

前缀 `/api/pi`，复用工作台身份、Origin 和 no-store。模型配置不需要 cwd，不启动会话 worker。

- `GET /status` 增加 `auxiliaryModels:true`。
- `GET /settings/models` 增加 `auxiliaryModels` 快照，既有 `preferences.sessionTitles/mediaAgent` 保留。
- `GET /settings/auxiliary-models` 返回 `{version:1,revision,purposes}`。revision 为不透明 SHA-256；每项包含 id、label、description、automaticLabel、help、可选 enabledLabel 以及 settings。当前 id 为 `session-title` 和 `media-planner`。
- `PUT /settings/auxiliary-models` 接受 `{expectedRevision,changes}`，只允许已登记用途与字段。每个用途可以提交成对的 provider/modelId；双空字符串恢复自动。标题另可单独提交 enabled 布尔值。至少一项修改，拒绝未知用途及参数。

示例：

```json
{
  "expectedRevision": "<读取时的 revision>",
  "changes": {
    "session-title": { "provider": "example", "modelId": "small-model" },
    "media-planner": { "provider": "", "modelId": "" }
  }
}
```

提交前与校验后都检查修订；冲突或已有保存操作返回 409，非法参数/不可用模型返回 400。校验通过后仅一次私密原子写入，保留其他偏好。GET 不含认证值；校验失败不回传供应商原始错误。`/activity.nativeSettingsBusy` 包含辅助配置校验，停机等待它结束且禁止迟到保存。

## 开发接入与验证

`server/pi-auxiliary-models-service.js` 的用途登记是当前支持能力的明确清单。新增用途需先实现真正的调用方、默认模型规则、参数/预算与执行边界，再添加描述和经过校验的存储适配。前端 `public/pi-auxiliary-models.js` 根据用途描述渲染行及布尔选项，统一处理草稿、刷新、冲突和整体保存。

当前没有额外的视觉、网页提取、上下文压缩、批准、MCP 或 Packages/Skills 辅助模型用途。Packages 和 Skills 的现有安装/管理不因为配置辅助模型而运行 AI 或自动安装资源。将来的 AI 搜索、推荐或审查可以使用这一入口，但必须先有对应实现；不能仅登记一行就声称已具备该能力。

Node 用例 `test/pi-auxiliary-models.test.js` 验证无迁移读取、单次原子写入、重置、旧入口冲突、模型失效不回退、认证/Origin、无 worker 与停机迟到保护。标题及媒体的原有真实 Pi RPC + 本地模型回归继续验证实际调用。浏览器 `test/browser/pi-auxiliary-models.cjs` 覆盖中英文 1440/768/393/320px、三主题、齿轮选项、草稿/冲突/迟到读取、移除模型、主草稿/附件/工具和无执行副作用。旧后端由原标题与双语浏览器用例验证。所有测试使用独立身份和合成服务。

# 辅助模型

“设置 → 使用偏好 → 辅助模型”集中管理已经实现的辅助任务模型。按用途选择供应商和模型，点击“保存更改”后用于后续任务。保存只核对配置和认证，不会生成标题、运行学习、规划媒体、执行媒体或安装资源。

## 当前用途

| 用途 | 作用 | “自动”的含义 |
|---|---|---|
| 标题生成 | 新线程自动命名、手动重新生成标题 | 使用该线程当前的聊天模型 |
| 媒体规划 | 实验室图像/视频/语音参数，以及模型接入方案 | 依次参考服务器媒体规划配置、Pi 默认模型及可用模型 |
| 明确纠错 | 新完成的原生问答中优先提取明确纠正或“记住以后”的持久偏好 | 无自动模型；未配置专用模型则等待配置 |
| 增量复盘 | 有新原生内容且空闲时逐轮复盘；明确纠错/偏好不再重复收费 | 无自动模型；未配置专用模型则等待配置 |
| 边界提炼 | 成功压缩或 worker 退出登记边界前未覆盖的原生问答 | 无自动模型；未配置专用模型则等待配置 |

两类原有用途和三类学习用途可以选择相同模型，也可以分别选择适合各自任务的模型。模型目录来自实际 Pi 配置，只提供已接入且可用的文本模型；被移除或暂不可用的已保存选择仍保留显示，不自动替换为第一项。

重新进入“使用偏好”时会重新读取本地模型目录，保留未保存的选择，并丢弃被较新读取取代的旧响应；不会自动请求供应商远端目录。子 Agent 设置同样读取原生设置目录。会话扩展通过 `registerProvider` 注册或覆盖的模型可能与原生 `models.json` 不同；独立辅助任务不加载会话扩展，因此仅修改扩展中的模型列表不会同步到这里。标准 API 模型应在“供应商与模型”或原生模型配置中维护；已有重复扩展注册时需一并核对，不能把浏览器刷新当作模型导入。

媒体规划的“自动”沿用既有规则：`PI_MEDIA_PLANNER_MODEL` 与 Pi 默认模型形成候选，均无匹配时选第一个可用非 batch 模型。方案失败可以尝试其他默认候选，响应报告实际模型及回退情况。标题与媒体都明确指定了模型时，配置失效或请求失败不会偷偷换成其他模型。媒体 API 兼容显式 provider/modelId 覆盖单次请求，该显式选择同样不回退。

齿轮按钮展开该用途的说明及已实现选项。标题行提供“自动生成会话标题”开关；关闭后仍可手动生成。标题仅发送最多 8,000 字符问答摘录，不携带完整历史或主线程系统提示，不进入主聊天上下文。媒体规划只产生可编辑方案，执行仍需在实验室单独确认。详细范围见[会话工作流](SESSION_WORKFLOWS.md#自动标题与重新生成)与[媒体 Agent](MEDIA_AGENT.md)。

“全部设为自动”先清除各行的专用模型选择，点击保存后生效；学习用途清空后停在待配置状态，不会改用主会话模型。此操作不重置学习开关、自动标题开关，也不修改主聊天默认模型、媒体执行模型或凭据。保存不会重定向或重发正在进行的请求。配置变更会使正在生成的旧自动标题失效；手动标题建议仍标明本次模型并等待保存。

## 兼容与存储

已有标题模型和媒体“模块 Agent”选择直接显示在新卡片中，不进行开机迁移或重复保存。原来的两张独立配置卡片在新后端隐藏；缺少辅助模型能力的后端仍使用原入口。

Pi 原生会话仍是唯一聊天事实来源。工作台使用所选偏好文件的 `sessionTitles`、`mediaAgent` 和 `memoryModels`，新文件默认 `pivane-workspace.json`，已有 `pi5-workspace.json` 自动沿用，不另存第二套路由或聊天历史。旧 profile `runtime.json.reviewModel` 仅只读解析，已不传给 worker 执行旧的三轮复盘。`sessionTitles.revision` 与媒体配置变更计数供并发检测，未知配置和无关偏好保持。界面开关、模型路由、媒体执行参数是独立状态。

原 `/settings/session-titles` 和 `/settings/media-agent` API 保留；从旧入口保存的变化会使新入口的旧修订失效。新入口一次保存所有改动；异步模型校验期间，另一页面改了相关设置则整次拒绝，不部分覆盖。失败后保留未保存选择并读取最新修订，由用户核对后再保存。标题请求的本次 Token 显示与持久用量统计口径不变。

## REST 契约

前缀 `/api/pi`，复用工作台身份、Origin 和 no-store。模型配置不需要 cwd，不启动会话 worker。

- `GET /status` 增加 `auxiliaryModels:true`。
- `GET /settings/models` 增加 `auxiliaryModels` 快照，既有 `preferences.sessionTitles/mediaAgent` 保留。
- `GET /settings/auxiliary-models` 返回 `{version:1,revision,purposes}`。revision 为不透明 SHA-256；每项包含 id、label、description、automaticLabel、help、可选 enabledLabel 以及 settings。当前 id 为 `session-title`、`media-planner`、`memory-correction`、`memory-review`、`memory-extraction`。学习三项必须明确选择可用文本模型；双空表示待配置，不使用主模型。
- `PUT /settings/auxiliary-models` 接受 `{expectedRevision,changes}`，只允许已登记用途与字段。每个用途可以提交成对的 provider/modelId；双空字符串使原有标题/媒体用途恢复自动，学习用途则保持待配置。标题另可单独提交 enabled 布尔值。至少一项修改，拒绝未知用途及参数。

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

当前没有额外的视觉、网页提取、上下文压缩、批准、MCP 或 Packages/Skills 辅助模型用途。边界提炼在压缩**之后**登记作业，不取代 Pi 原生压缩模型或其上下文。Packages 和 Skills 的现有安装/管理不因为配置辅助模型而运行 AI 或自动安装资源。将来的 AI 搜索、推荐或审查可以使用这一入口，但必须先有对应实现；不能仅登记一行就声称已具备该能力。

Node 用例 `test/pi-auxiliary-models.test.js`、`test/pi-profile-learning-runtime.test.js` 验证专用路由、原生来源、去重、预算、重启、取消和停机；不代表真实供应商可用。标题及媒体的原有真实 Pi RPC + 本地模型回归继续验证实际调用。浏览器 `test/browser/pi-auxiliary-models.cjs` 覆盖标题、媒体和三个学习用途。所有测试使用独立身份和合成服务。

## 后台学习 REST 与边界

学习开关独立于模型路由，默认关闭。`GET /api/pi/profiles/:id/learning` 返回 `{version:1,status,revision,settings,jobs,recentRuns,capabilities}`，revision 是整数。`capabilities` 明示可用动作、专用模型、物理 profile/cwd 范围、输入/输出上限、`limits`、`capacity`（队列、游标、动作剩余额度与被阻断的分支）及价格报告状态。`PUT` 同路径提交 `{expectedRevision,changes}`；开关为 `enabled`、`correctionEnabled`、`reviewEnabled`、`extractionEnabled`，额度为 `maxRunsPerDay` (1..20)、`maxTokensPerDay` (6000..200000)，可选 `periodicReviewMinutes` (0..10080)。默认 UTC 日额度 4 次、24000 保留 Token；每次预占 6000。保存设置本身不执行作业。

`POST /api/pi/profiles/:id/learning/actions` 提交 `{requestId,action:'review-now'|'cancel',jobId?}`；取消需要作业 ID。手动复盘必须有已验证的原生来源。返回最新快照；请求 ID 同参幂等，异参冲突；动作 ID 有效期 7 天，过期后同一 ID 被拒绝而不会重跑；最多保留 256 条活动记录与 1024 条已退役 ID，达到上限时明确拒绝，不静默遗忘旧键。压缩、完成与退出登记每个已完成的原生用户/助手问答引用，不持久化聊天正文；每个用途有持久游标和滑动去重窗口，周期扫描补采已知会话的遗漏。队列最多 64 项，游标最多 128 个；满额不推进未覆盖位置。旧字符串游标升级时保留旧最新 pair 去重并回扫更早问答。无法在窗口内证明安全的深分支改写会阻断该游标，`capacity.blockedBranches` 报告数量；不把旧分支重试成新模型费用。过大（超过 8 MiB）的会话不参与后台学习。复盘由独立服务在空闲时读原生分支，重新核验绑定、问答正文摘要、模型设置、学习开关及知识修订，再由知识服务的受信 `mutateFromNative` 提交；内部来源来自原生 entryId，HTTP 不能伪造。后台模型输入限制为最多约 2400 字符摘录，系统提示加摘录不超过 5000 UTF-8 字节，最多 320 输出 token，无工具、无 CLI/subagent 回退；这不是供应商精确 tokenizer 的承诺。取消和超时要求中止但仍等待实际完成，重启后的执行中作业为 `uncertain`，不自动重放。近期作业只返回原因、时间、状态、模型、报告的用量/费用和回执 ID；缺失价格标记 `unknown`，不当作零费用。额度按保留量限流，不是供应商账单上限。明确纠错可在受界限的旧记录中匹配并以 CAS 替代；找不到可靠旧项则只建新项。用户明确描述可复用流程时，辅助模型只能提出不生效的 profile 技能草稿，需另行审查启用；没有受信写接口时不退回无来源写入。

运行中的 worker 在每轮注入前从磁盘重读 profile 和物理 cwd 记忆，原生 `pivane-profile-memory-read` 条目记录已提供的适配器 generation、时间、范围及是否有内容。`get_runtime_configuration.memoryRead` 只返回上一次已记录的提供行为（`last-provided`）、`not-recorded` 或 `unavailable`，不把上次记录当作本轮已遵守或与当前保存修订一致；过大的原生会话返回 `unavailable`。有受信知识服务时，主 Agent 全局/物理项目记忆与 profile-owned 技能的创建、更新（update/edit/整节 patch）和删除使用同一 CAS 和原生来源回执；确定拒绝以失败的工具结果返回，结果不确定时报错，不回退旧写路径。已安装技能仍只读。逻辑助手项目隔离未实现。

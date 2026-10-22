# 原生运行控制、edit 差异与扩展状态

本页说明停止、队列取回和扩展状态；文件展示另见[文件查看](FILE_VIEWER.md)。

由运行实例的 `/api/pi/status.runtimeControls`、`extensionStatus`标记提供；后端更新需在空闲时进行。

## 停止与取回

引导（steer）和后续（queue）消息的入口位于输入框上方，与子 Agent、任务进度和延迟发送共用状态标签行；有内容时显示数量，全部处理后隐藏。点击打开“消息队列”，按“引导 · 本轮工具执行后”和“后续 · 当前任务完成后”分组查看，取回记录单独列出。空间不足时标签换行，打开队列会收起其他状态浮层。

队列窗口提供“全部取回”（旧运行实例为“全部取回文字”），不会停止当前任务；取回记录可追加到草稿、复制文字或移除。普通保存与兼容性说明收在底部“取回与保存说明”，持久化失败和不确定结果仍直接显示。窗口更新保留说明的展开状态和阅读位置。关闭时回到队列入口，入口消失时回到输入框；用户已明确选择其他控件时保留该焦点。没有运行控制能力的旧后端仅显示队列内容，不提供取回操作。

用户 prompt 与触发运行的 custom wake 在 before_agent_start 开始前即保持受管 busy 所有权，包括慢 hook 和 settled 后的延迟 wake。原生调用完成／失败或 worker 实际退出才释放；读取到 idle、原生 settled 或 RPC 超时不代表整项启动结束。持久和临时主会话的启动期间同样阻止手动压缩、回收和维护切换，避免压缩操作中断尚未完成的启动；临时会话的原生 ID 只用于当前运行实例，不变成持久会话地址。

主会话停止按钮调用网关 `stop_and_recover`：服务器在 await 前预占操作，先取回原生队列，再调用 `abort` 并等待返回。持久队列适配通过带操作编号的私有命令调用公开 `clearQueue()`；旧运行实例沿用 `clear_queue`。压缩期间按钮改为取消压缩；不退出 worker。队列窗口的 `take_queue` 只取回队列，不停止当前任务。原生 `abort` 的透传行为不变。

运行时空草稿显示停止，有文字、引用或附件时显示发送；引导／后续方式在加号菜单选择。停止不退出 worker，也不撤销副作用，见[输入区](COMPOSER_TOOLS.md#输入框入口)。

原生 assistant 的 stopReason=aborted 显示中性“回复已停止”，errorMessage（包括 Request aborted）收在停止详情；stopReason=error 和实际停止 RPC 失败仍显示错误。这里仅调整 Web 展示，不修改 Pi 历史或把请求失败转换成成功。

`durableQueueRecovery=true` 的后端为持久主线程保存排队意图：先保存经过校验的原始文字、图片和文档引用，再提交原生 RPC。退出运行实例、服务重建和浏览器断线不会清除未处理记录。打开线程后可查看取回清单，明确追加时才读取完整图片载荷；追加合并最新草稿，先验证正文与附件总量，超限不改草稿、不确认移除。切线程后的迟到读取不会填入新草稿。确认移除失败时同一页面不重复追加；这不是跨浏览器 exactly-once，也不替代普通草稿自动保存。

原生队列仍负责执行，JSONL 仍是唯一聊天历史。适配层通过同一个原生消息对象关联排队、清空和 appendMessage；只在物理文件 header、原生身份与实际保存的对应条目均核验通过后移除意图，不能用相同文字或空队列推断完成。原始载荷和可证明的模板／扩展变换结果分开保存；变换结果超过恢复预算时保留完整原稿并提示证据不完整，附件清理随之禁用。此处不承诺原生 JSONL 在断电后的 fsync 持久性。

不确定内容可能已经执行，追加前必须再次确认；没有自动补发、单项撤回或批量重发。清空操作带独立编号和代次，迟到证明只更新对应候选与兼容文字记录。RPC 超时不表示取消：停止互斥及原生状态核对沿用原规则；消息提交在原生开始事件之前超时，还会保持独立的提交不确定标记，普通 idle 快照不能解除。此时需退出运行实例，再重新打开并核对会话。显式退出不再依赖无响应进程的 get_state 回复；停止中的 owner 与同一个 disposal Promise 保留到 Shell/RPC 实际终止，失败不冒充空闲或启动第二个 writer。定时运行和后台子 Agent 须先在对应入口处理。

私有恢复清单位于 `<agentDir>/pivane-queue/intentions.json`，随身份目录备份，不进入源码包；原子保存、fsync 与私有权限沿用服务器文件机制。实例最多 1024 条／256 MiB，每线程最多 32 条／64 MiB，额度包含保存载荷与元数据，达到上限在提交前拒绝。原生条目核验目前仍有 128 MiB 文件上限，无法证明时保留不确定记录供人工处理。普通立即发送不创建排队恢复记录；分叉不继承待执行意图，移动前须处理未完成恢复；明确删除会话成功并停止 worker 后才移除该线程恢复记录，失败保留，附带清理失败会单独提示。

临时会话和旧运行实例仍使用内存文字取回：原生 `clear_queue` 不返回图片，窗口提示重新添加。每 worker 最多 32 组／32 MiB，退出或服务重建后不恢复；结果不确定时仅供核对／复制。这些兼容记录不能被描述为完整图片恢复。

停止/取回期间拒绝新 prompt、steer、follow_up、模型变更和工作流互斥操作；全局 activity 将其标为 busy。扩展本身仍在 Pi 进程中运行，任意第三方扩展的外部副作用不由网关取消。

多设备同时打开同一持久线程时，一端执行 `/quit`，服务端在确认 Shell 和 RPC 进程结束后通知其他已连接页面退出。页面清除旧的 Shell 运行卡片、停止按钮和连接状态，收到确认退出后不自动重开运行实例；未发送文字和附件仍保留在本页，重新打开线程后可继续编辑。这些草稿仍只在页面内存中，刷新或离开页面前需要自行保存。

## 网关契约

主 WS 在成功 open_session/open_ephemeral 后支持：

- `{type:"stop_and_recover", id}`：取回队列后停止；返回当前 controls。
- `{type:"take_queue", id}`：仅取回队列；返回当前 controls。
- `{type:"get_recovery_payload", id, recoveryId, runtimeId, revision}`：按当前运行实例与 controls 修订读取完整恢复载荷，返回 `{payload,original,...}`；不发送或移除记录。
- `{type:"ack_recovery", id, recoveryId, runtimeId?, revision?}`：移除已处理结果；新页面携带身份和修订。仍在排队／提交中的记录不可当作已取回移除，旧客户端保留既有参数兼容。

复用既有 token/Origin/项目/session 检查；侧聊不开放这些命令。浏览器等待停止最多 150 秒；服务器原生 clear_queue 30 秒、abort 120 秒。无自动重放。

`get_state.webControls`、打开快照的 `controls` 和新事件 `{type:"gateway_controls",controls}` 提供：

```json
{
  "runtimeId": "worker-uuid",
  "revision": 4,
  "queue": { "steering": [], "followUp": [] },
  "recoveries": [{ "id": "recovery-uuid", "status": "recovered", "steering": ["text"], "followUp": [] }],
  "stopping": false,
  "extension": { "title": "", "statuses": [["key", "text"]], "widgets": [["key", {"lines":"text", "placement":"aboveEditor"}]] }
}
```

revision 是 worker 内存单调修订，runtimeId 区分 worker 重建；持久后端另返回 `durable`、`persistenceError`、`intentions`，恢复摘要包含 `durable/hasPayload/legacy/imageCount/originalOnly/effectiveComplete/state`，不在每次快照发送图片 base64。前端拒绝同一 runtime 旧修订和旧连接响应，切线程关闭队列窗口、清空旧展示。打开快照末尾取得最新 controls，避免启动时扩展事件丢失。原生 queue_update 继续透传，旧后端页面仅显示原文字队列与原 abort 行为。

## 手动 Shell 与投递方式

主输入框的!/!!、独立命令停止/输出/重连和Bash历史状态见 [WEB_SHELL.md](WEB_SHELL.md)，由userShell标记。命令执行期间现有停止/队列取回与工作流不能绕过Shell占用，Agent停止按钮与命令停止按钮目标明确区分。

queueModes标记详情区引导/后续的逐条/全部控制；输入框选择何时送达，详情选择每次取几条。原生setter同步当前实例并保存全局默认，项目覆盖与其他已启动实例保持原生范围，不能称为仅当前会话临时偏好。

## edit 差异

`public/pi-tool-diff.js` 只对名称为 edit 且返回原生 details.patch/diff 的工具渲染差异。优先标准 patch，显示文件路径、增删行、双行号和完整 patch 复制。旧记录只有 details.diff 时显示原始差异，不把它冒充标准 patch。原始修改参数放在工具内部折叠区，结果文字和错误继续显示。

大于 500000 字符或 4000 行时用单一文本节点显示完整差异，避免创建大量行元素；没有删去 patch 内容。代码可在内部滚动，长文件名换行。全部文本通过安全 DOM 写入，不运行扩展的 TUI 渲染器，不把模型内容注入 HTML。正文/完整记录、流式 authoritative 替换、重连与原 details 阅读锚点共用现有逻辑。

write、bash 和自定义工具不推算文件前后差异；不是工作目录变更总览、Git 检查点或文件回滚。

## 本轮编辑记录

本轮文件的来源、轮次、差异和阅读状态统一见[文件查看](FILE_VIEWER.md)。edit 按可核对的原生 patch 累计行数，write 不推算差异或“新建”；不从当前磁盘伪造历史，也不是文件回滚。

## 扩展状态

`server/pi-runtime-controls.js` 在原生事件入口保存 setStatus、字符串数组 setWidget、setTitle 当前值；按 key 替换，字段省略/null 清除。最多 64 个状态、32 个 widget；key 256 字符，标题 512 字符，状态文字 16000 字符，widget 最多 100 行/32000 字符。超限不会无限增长内存，显示长度有上限。

会话详情的“扩展状态”默认折叠；widget 自身可折叠。setTitle 更新当前浏览器标题，切线程/断开重建时恢复工作台标题。全局 activity 不返回这些内容。仅显示 RPC 支持的文字数据；组件式 widget、ui.custom、自定义 footer/editor 等 TUI 专属 API 不受支持。原 confirm/select/input/editor 和私有侧聊上下文拦截不变。

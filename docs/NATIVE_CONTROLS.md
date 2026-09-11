# 原生运行控制、edit 差异与扩展状态

2026-09-09 增加纯前端的本轮编辑记录与右侧变更页签，刷新静态页面生效，不需要重启 runtime。

由运行实例的 `/api/pi/status.runtimeControls`、`extensionStatus`标记提供；后端更新需在空闲时进行。

## 停止与取回

主会话停止按钮调用网关 `stop_and_recover`：服务器在 await 前预占操作，调用原生 `clear_queue` 后再调用 `abort` 并等待返回。压缩期间按钮改为取消压缩；不退出 worker。队列窗口的 `take_queue` 只取回队列，不停止当前任务。原生 `abort` 的透传行为不变。

主会话运行中同时显示发送与停止按钮；选择引导/后续后可点击发送，空稿、断线、压缩和停止处理中禁用发送。手机运行时操作区另起一行，保留正文输入宽度。切线程首先使旧连接代次失效并清除 connected/streaming，再等待新会话快照，旧停止按钮和迟到响应不得控制新线程。

原生 assistant 的 stopReason=aborted 显示中性“回复已停止”，errorMessage（包括 Request aborted）收在停止详情；stopReason=error 和实际停止 RPC 失败仍显示错误。这里仅调整 Web 展示，不修改 Pi 历史或把请求失败转换成成功。

取回结果放在本 worker 的内存列表，通过 snapshot/状态事件同步订阅者。用户显式追加到当前草稿后再发送；追加使用最新草稿并验证附件与正文总量，不覆盖原草稿或附件。复制和移除也由用户操作。追加后的确认失败不会在同一页面重复追加；不同浏览器可各自复制文字，不能把本页保护描述为跨设备 exactly-once。

原生 clear_queue **只返回文字，不返回图片**。文字附件此前已经并入正文，仍在取回文字里；图片需要重新添加，窗口明确提示。列表保留原生已展开文字，不伪造原始模板、附件文件名或逐条撤回语义。没有单项撤回、排序、批量重发或队列持久化。

取回组先预留 pending 快照，再按原生 clear_queue 成功结果替换。清空结果不确定时保留 uncertain 的操作前文字供核对/复制，不提供直接追加按钮，不自动重试。已成功取回的文字不受随后 abort 失败影响。RPC 超时后保持停止互斥，直到原生 settled 或超时后新发出的 get_state 明确确认没有运行、压缩及队列；同时检查操作代次与当前活动状态，停止前迟到的旧空闲快照不能解锁。超时本身不解锁。

每 worker 最多 32 组，取回列表与即将取回的队列文字预算 32MiB，满时在 clear_queue 前拒绝。未处理取回组阻止 worker 空闲回收，但不能跨退出 worker、服务重启或临时连接断开恢复；窗口明确显示此生命周期。用户仍可显式退出/删除会话。此列表是临时未发送内容，不写 JSONL、工作台偏好或浏览器持久存储。

停止/取回期间拒绝新 prompt、steer、follow_up、模型变更和工作流互斥操作；全局 activity 将其标为 busy。扩展本身仍在 Pi 进程中运行，任意第三方扩展的外部副作用不由网关取消。

## 网关契约

主 WS 在成功 open_session/open_ephemeral 后支持：

- `{type:"stop_and_recover", id}`：取回队列后停止；返回当前 controls。
- `{type:"take_queue", id}`：仅取回队列；返回当前 controls。
- `{type:"ack_recovery", id, recoveryId}`：按组 ID 移除已处理结果，重复/无效 ID 拒绝；pending 不可移除。

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

revision 是 worker 内存单调修订，runtimeId 区分 worker 重建；前端拒绝同一 runtime 旧修订和旧连接响应，切线程关闭队列窗口、清空旧展示。打开快照末尾取得最新 controls，避免启动时扩展事件丢失。原生 queue_update 继续透传，旧后端页面仅显示原文字队列与原 abort 行为。

## 手动 Shell 与投递方式

主输入框的!/!!、独立命令停止/输出/重连和Bash历史状态见 [WEB_SHELL.md](WEB_SHELL.md)，由userShell标记。命令执行期间现有停止/队列取回与工作流不能绕过Shell占用，Agent停止按钮与命令停止按钮目标明确区分。

queueModes标记详情区引导/后续的逐条/全部控制；输入框选择何时送达，详情选择每次取几条。原生setter同步当前实例并保存全局默认，项目覆盖与其他已启动实例保持原生范围，不能称为仅当前会话临时偏好。

## edit 差异

`public/pi-tool-diff.js` 只对名称为 edit 且返回原生 details.patch/diff 的工具渲染差异。优先标准 patch，显示文件路径、增删行、双行号和完整 patch 复制。旧记录只有 details.diff 时显示原始差异，不把它冒充标准 patch。原始修改参数放在工具内部折叠区，结果文字和错误继续显示。

大于 500000 字符或 4000 行时用单一文本节点显示完整差异，避免创建大量行元素；没有删去 patch 内容。代码可在内部滚动，长文件名换行。全部文本通过安全 DOM 写入，不运行扩展的 TUI 渲染器，不把模型内容注入 HTML。正文/完整记录、流式 authoritative 替换、重连与原 details 阅读锚点共用现有逻辑。

write、bash 和自定义工具不推算文件前后差异；不是工作目录变更总览、Git 检查点或文件回滚。

## 本轮编辑记录

本节描述 edit 差异记录。后续“本轮文件”已增加成功 write 的写入全文，并可从文件链接打开或显式读取当前磁盘文件；两类全文来源、读取接口和生产启用标记见 [FILE_VIEWER.md](FILE_VIEWER.md)。write 不参与下面的 patch 行数统计，不因一次写入就声称文件为新建。

每个已结束的用户问题段下方显示紧凑文件卡片，前三个文件直接显示，其余折叠；无可关联的编辑差异时不占位。点击文件后在现有右侧分栏的“文件”页签查看，轮次和文件选择收在默认关闭的“切换文件”浮层中。默认展开该文件的第一次编辑，其余点击后加载；同一文件先改后还原的两次 patch 分别保留，不合成为净差异。停止、失败和只有工具结果的已结束问题段也保留此前成功编辑。

数据只来自已经加载的 Pi 原生消息快照：按 user 消息分段，用 toolCallId 关联名称为 edit 的调用与成功 toolResult，并要求调用包含非空 path、结果包含非空 details.patch 或 details.diff。重复结果按 ID 只计一次，调用 ID 有歧义、结果失败、孤立结果和无路径记录不纳入卡片；完整执行记录仍保留原信息。路径按调用中的原始字符串分组，不推断相对/绝对路径或符号链接等价性。write/bash/自定义工具的文件副作用不推算。

尾段运行中不显示完成卡片，等 agent_settled 后重新读取权威快照；message_end/agent_end 不作为完成信号。轮次按原生 user 消息划分，包含已实际投递的引导/后续消息；未投递队列不算一轮。当前段继续生成时移除旧卡片，之前已结束的问题段保持可查看。

行数仅对可完整核对 hunk 长度的标准 patch 统计，显示的是各次编辑累计新增/删除行数；旧 details.diff 或不完整 patch 显示行数未知并保留原文，旧差异不能复制为标准 patch。共享 PiToolDiff 安全 DOM 渲染器提供颜色、行号与完整 patch 复制；大于 500000 字符或 4000 行使用完整文本节点，避免大量 DOM，折叠的后续编辑按需创建。

卡片的原生操作记录从快照重建，本层不新增 API、磁盘读取、文件基线、浏览器持久历史或 Pi JSONL 写入。刷新后可从仍加载的原生记录重新生成；压缩、分支导航后不跨摘要关联工具，也不从缺失上下文臆造旧轮次。快照不再包含的记录从页签移除，因此不是独立持久的完整文件审计。点击历史 patch 不读取当前磁盘文件，不会把当前版本冒充当时差异。

桌面共用详情/侧聊的可拖拽右栏；手机使用距视口边缘 12px 的宽抽屉和统一 diff。查看变更不自动启动或结束侧聊，切换页签保留侧聊连接、文字与草稿；页签支持左右方向键、Home/End。关闭/Esc 返回来源文件按钮；切线程立即清空旧选择与差异，迟到快照继续沿用主 WS 代次保护。相同轮次/文件内容重绘、重连时保留差异滚动与展开状态，卡片“其余文件”展开状态复用主消息阅读控制器，只保留在本页。

## 扩展状态

`server/pi-runtime-controls.js` 在原生事件入口保存 setStatus、字符串数组 setWidget、setTitle 当前值；按 key 替换，字段省略/null 清除。最多 64 个状态、32 个 widget；key 256 字符，标题 512 字符，状态文字 16000 字符，widget 最多 100 行/32000 字符。超限不会无限增长内存，显示长度有上限。

会话详情的“扩展状态”默认折叠；widget 自身可折叠。setTitle 更新当前浏览器标题，切线程/断开重建时恢复工作台标题。全局 activity 不返回这些内容。仅显示 RPC 支持的文字数据；组件式 widget、ui.custom、自定义 footer/editor 等 TUI 专属 API 不受支持。原 confirm/select/input/editor 和私有侧聊上下文拦截不变。

## 验证

```bash
node --test test/pi-native-controls.test.js
PLAYWRIGHT_MODULE=/path/to/playwright PI_NATIVE_TEST_URL=http://127.0.0.1:3106 node test/browser/pi-native-controls.cjs
```

Node 测试使用隔离 Agent/project/deferred 目录和 loopback SSE，无付费模型，验证真实队列/停止、双客户端、取回重连、确认 ID、压缩取消、超时互斥和原生 edit patch。浏览器使用受控 REST/WS，覆盖 1440/393/320px、三主题、代码与插件文本安全、取回草稿、确认失败不重复追加、停止期间新草稿、刷新恢复和迟到线程响应。原附件/阅读/滚动/侧聊/工作流/媒体浏览器回归仍需通过。

# Pi Session Workflows

实现日期：2026-09-07。只作用于 Pi Agent，媒体业务、参数和历史不变。生产后端是否已启用以 `/api/pi/status.sessionWorkflows === true` 为准；没有该标志时前端隐藏新入口。

## 已实现

- 一次性延迟普通消息：分钟数或浏览器本地日期时间；服务端按 Unix 毫秒时间投递，无 cron 或重复任务。
- 待发送列表：编辑正文/附件/时间、暂停、立即发送、取消；投递结果不明时需要勾选确认才允许再次发送。
- 复制当前完整活动分支为独立线程；从历史用户问题之前分叉并回填该问题及图片。
- 每个用户问题段只在最终回复末尾显示复制/分叉，过程回复不生成操作行；当前运行尾段等待 agent_settled 后恢复最终按钮，工具结果之后没有最终文字时不把更早的过程说明当成最终回复。分叉位置精确包含该回复但不包含后续对话；有待执行 toolCall 的过程消息不可作为分叉点。问题头显示原生发问时间（浏览器本地时区）、复制问题和最近一条的编辑重试。此展示限制不改变后台回复候选、fork REST 或 `/copy` 的既有契约。
- 最近一条用户问题的编辑重试：确认发送时才回退，取消编辑不改变上下文。
- 回退形成的旧版本可从右侧“历史” → 更多（⋯） → “恢复旧版本”恢复，不删除原始记录，不生成被放弃问答的摘要。
- 当前会话待发送数量及侧栏标记；过期、暂停、失败、不确定状态进入“需关注”筛选。
- 原线程未发送草稿在当前页面内存按线程保留，分叉草稿不覆盖原草稿；刷新页面不恢复未预约的草稿。
- 附件窗口与主框共用 `public/pi-attachments.js`：回形针/真实文件粘贴/拖放、PNG/JPEG/WebP/GIF 签名、UTF-8/二进制检查、单图 6 MiB/单文本 1 MiB 与 payload 总量校验。关闭/重开 editor 后不接受旧读取结果，读取中禁止确认，坏文件合并提示且保留同批有效项。已并入正文的文本附件仍在 textarea 中编辑，不新增原件存储。
- 主稿读取/提交中不能打开新预约；主稿上次投递不确定时，预约前先明确确认已核对会话，避免把未知是否已送达的内容再次预约。仅页面内存保护，不改变服务端预约状态机。

以上只支持持久会话。临时 `--no-session` 仍然断开即销毁，不提供预约、分叉或回退入口。

## 网页入口（2026-09-10）

会话详情仅保留运行状态、上下文占用、累计用量与折叠的运行设置／会话信息／资源／扩展状态。压缩按钮和压缩进度保持直接可见；上下文用量与累计输入／输出分开标注。

- 左侧线程菜单与中间连接状态栏的“当前线程操作”（⋯）共用复制为新线程、待发送消息、重命名、删除等操作。打开当前线程的菜单与窗口不重新连接该线程。`/clone` 复制当前活动分支，`/new` 创建空线程，两者不同。
- 历史页在“搜索／会话树”同排右侧提供更多（⋯），只有“从历史问题分叉”“恢复旧版本”两项；点击才读取工作流并打开原窗口，浏览历史或展开菜单不预取工作流。菜单为浮层，不改变列表或正文高度，支持键盘、Escape、外部点击及切页／切线程关闭。
- 历史功能尚未启用的旧后端，当前线程菜单保留这两项兼容入口；没有 sessionWorkflows 时隐藏。临时会话不提供持久操作。
- 待发送消息继续从输入框上方的数量／管理入口和线程菜单查看；主框加号仍用于新增延迟发送。

纯静态更新，刷新页面生效。分叉位置、空闲互斥、确认和草稿保护仍按下文执行。

## 不提供

- 文件、Git、数据库、远端请求、部署、生成媒体等工具副作用的撤销。
- worktree、目录复制或 A/B 代码环境隔离。新旧线程仍共享项目目录。
- 任意会话树编辑器。历史问题可以分叉，原地编辑重试只开放最近一条。
- 周期调度、跨服务队列、自动补发过期消息、自动重发不确定消息。
- 延迟或编辑重试斜杠命令。此版本只接受普通文本与图片，文本附件并入正文。

## 文件与所有权

| 文件 | 作用 |
|---|---|
| `server/pi-message-payload.js` | 新操作的普通消息、图片校验与分支遍历 |
| `server/pi-session-workflows.js` | 受保护的分叉、重试、恢复和预约 REST 接口 |
| `server/pi-deferred-messages.js` | 一次性持久待发送队列与投递状态 |
| `server/pi-web-session-extension.ts` | 仅 Web RPC worker 显式加载的原生树导航命令桥接 |
| `server/pi-agent-supervisor.js` | 会话互斥、runtime 生命周期和桥接结果 |
| `server/pi-session-store.js` | 官方 SessionManager 分支提取和空分叉落盘 |
| `public/pi-session-workflows.js` | 模态编辑、历史列表、待发送列表和消息操作 |

Pi JSONL 仍是唯一聊天历史。队列只保存尚待确认/投递的消息，接受投递或取消后删除 payload，仅保留最多 100 条终态 metadata。工作台偏好不存这些正文。

端口3001默认队列：`~/.pi/agent/pi5-deferred-messages.json`；非 3001 端口默认追加 `-<port>` 后缀，未设置 PORT 时视为开发 3000。`PI_CODING_AGENT_DIR` 仍决定 Agent 数据根，`PI_WEB_DEFERRED_FILE` 可显式覆盖。一个队列文件只能由一个服务进程管理，不可让两个实例共享该文件或同一正在写入的 Pi session。

队列写入同目录 0600 临时文件，fsync、rename，再 fsync 目录；目录创建权限 0700。最多 50 条非终态消息，完整队列最多 64 MiB。单消息最多 400000 字符、6 张 PNG/JPEG/WebP/GIF、24 MiB base64；浏览器单图 6 MiB、文本附件 1 MiB。预约时间限未来一年。

## 延迟投递

状态：`scheduled -> waiting | dispatching -> sent | failed | uncertain`，并支持 `paused`、`expired`、`cancelled`。

- 每秒检查到期消息，不依赖浏览器或 WebSocket 订阅。
- 到期重新 realpath/根范围检查并解析 cwd/sessionId，通过 Supervisor 获取唯一 worker。
- 正在运行、压缩、重试、等待确认或队列未清空时继续等待，不 steer、不自动 abort。
- 空闲锁内重新校验消息与实际模型的图片输入能力；使用发送时的线程上下文和当前 runtime 模型，不冻结预约时的模型或上下文。
- 先持久化 `dispatching`，再调用原生 `prompt`。原生接受后标记 `sent`，这表示已投递，不表示模型任务成功完成。
- 明确的原生拒绝记 `failed`；超时/断开等不能确认接受与否的错误记 `uncertain`。二者都不自动重发。
- 重启时过期的 scheduled/waiting 改为 expired，dispatching 改为 uncertain；未来 scheduled 保留。队列损坏时停止投递并在 activity/UI 报错，不覆盖坏文件。
- 编辑重试和恢复旧版本之前暂停该线程的未投递预约；原生扩展取消回退时也保持暂停，需用户重新确认。
- `/quit` 暂停该线程预约；单纯关网页或切换线程不暂停。
- 删除会话在互斥区内取消预约并移除 payload，之后才停止 worker、执行既有 trash/unlink。
- 创建请求使用 UUID 防止重试创建重复任务；UUID 内容不一致时拒绝。修改必须携带 revision，防止多设备覆盖。

不承诺跨 Pi RPC 与文件系统的 exactly-once 事务。选择保守的不确定状态，避免不知情地重复执行工具副作用。

## 分叉与回退

分叉在 source worker 空闲互斥区内读取最新 entries/leaf，使用单独的官方 `SessionManager.open(...).createBranchedSession(...)` 提取选定路径。原 worker 不切换 session，不改变原文件，其他客户端不被带到新线程。新分支保留官方 parentSession；目标之前尚无 assistant 时，沿用 Web 的立即可见空 header 流程，通过公开 append API 保留消息/模型/思考/自定义记录，并保存 `pi5-web-fork-origin` metadata。

这是 SessionManager 层提取，不会触发原 runtime 的 `session_before_fork/session_shutdown` 钩子，也不执行扩展的代码检查点恢复。它不是直接放开会改变 worker 归属的原生 fork/clone RPC。

原地回退使用项目内扩展的 `ctx.navigateTree(..., { summarize: false })`，遵守原生 `session_before_tree` 的取消，随后用 `pi.appendEntry('pi5-web-navigation', ...)` 记录原 leaf、目标 entry 和 retry/restore 模式。该 custom entry 不进入 LLM 上下文，同时让新活动 leaf 在刷新/重启后可恢复；无摘要，不删 JSONL 记录。

Web worker 使用 `-e server/pi-web-session-extension.ts` 显式加载桥接。`pi5-web-navigate` 从 command catalog 隐藏，gateway 拒绝浏览器直接提交该命令；worker 通过一次性关联 ID 和进程内随机 token 调用，`ui.notify` 中的结构化结果仅在 worker 内消费，不进入浏览器通知或 session。它没有 LLM 可调用工具，也不修改全局 Packages 或上游 Pi package。

操作必须提供 `expectedLeafId`。互斥在 await 前预占，检查 prompt preflight、活动状态、压缩和原生待处理队列；其他修改请求拒绝，只读请求可继续。导航超时会关闭对应 worker 后重连，不放任可能仍在执行的导航与新 prompt 并发。

重试先验证新消息/模型，再回退，再发送。若发送被拒绝或断线，旧分支仍可恢复，编辑器保留新提示词；不能把失败理解为已自动恢复原上下文。`gateway_context_changed` 通知该 session 的所有订阅页面重读状态，迟到结果仍按已有 generation/revision 规则隔离。

## REST 契约

以下均为 `/api/pi` 下接口，复用 token、Origin、realpath/项目根和 session ID 查找，不接受任意 sessionPath。GET 必须带 cwd query，写入必须带 cwd body。

| Method | Path | Body/响应要点 |
|---|---|---|
| GET | `/sessions/:id/workflow` | leafId、lastUserId、历史问题/已完成回复(replies)预览、可恢复旧版本 |
| GET | `/sessions/:id/prompt/:entryId` | message、images、leafId；恢复原生用户内容 |
| POST | `/sessions/:id/fork` | expectedLeafId、可选 entryId/position；默认 before，at 仅用于完成回复；返回新 session 与 draft/null |
| POST | `/sessions/:id/retry` | expectedLeafId、最近问题 entryId、message、images；返回 accepted |
| POST | `/sessions/:id/restore` | expectedLeafId、旧版本 entryId；返回 restored |
| GET | `/sessions/:id/deferred` | jobs 预览与状态；`detail=true` 包含尚未移除的 payload |
| POST | `/sessions/:id/deferred` | id(UUID)、dueAt(Unix ms)、message、images |
| PATCH | `/sessions/:id/deferred/:jobId` | revision、action(save/send/pause/cancel)；save 另需 dueAt/message/images；uncertain 重发需 confirmUncertain=true |

`position=at` 必须提供完成的文本 assistant entryId，不能选择 user、toolResult、带 toolCall、pending/error/aborted 等记录；缺少原生 stopReason 的旧文本回复仍兼容。候选集和执行校验复用相同规则。位置在压缩之前时会重建该位置的原生上下文，不带入之后的压缩摘要或问答。源文件、worker 和其他订阅者不变，分叉正文不会预填为下一条用户问题。

只读 workflow/prompt 会启动当前线程的受管 worker，以 runtime 的活动位置为准；待发送列表和 activity 不会启动 worker。大历史问题预览不含工具输出/图片 base64，但单问题详情会包含其图片。

`GET /status` 增加 sessionWorkflows=true；回复后分叉另以 replyFork=true 标记。`GET /activity` 增加 deferred.sessions 的 cwd/sessionId/count/attention，仅 metadata；队列异常时包含通用 error。`get_state` 增加 webOperation 布尔值。新增自定义广播只有 gateway_context_changed 和关闭连接用的内部 gateway_reconnect；不开放 fork/clone/navigateTree 的任意透传。

## 验证与部署

```bash
npm test
npm run check
npm audit --omit=dev
PLAYWRIGHT_MODULE=/path/to/playwright node test/browser/pi-session-workflows.cjs
```

- `test/pi-deferred-messages.test.js`：持久化/权限/重复 ID、到期等待、过期恢复、不确定结果、暂停/取消/修改冲突、损坏与写失败、投递期间失败编辑竞态。
- `test/pi-session-workflows.test.js`：真实官方 CLI + loopback SSE，压缩历史的 fork/clone/首轮分叉、原文件保留、图片/重试上下文、旧版本重启恢复、双 WebSocket 通知、互斥、无浏览器真实延迟投递、会话删除取消预约。全部临时 Agent 目录，不请求付费 Provider。
- `test/browser/pi-session-workflows.cjs`：1440x1000、393x852、412x915 模拟 REST/WS；草稿、附件、编辑取消/冲突、延迟修改/暂停/取消、分叉/复制/版本恢复、移动抽屉、键盘、pageerror 和溢出。截图在 `/tmp/pi-workflows-*`，不创建真实会话/媒体。

- `test/browser/pi-message-actions.cjs`：桌面及 393/412/320px 四视口，三主题；回复 footer/问题时间布局、原文复制与 HTTP fallback、消息/图片/工具安全、流式结束、重连、回复后分叉位置、过期操作及旧后端降级。所有 REST/WS 都是 fixture，截图位于 `/tmp/pi-message-actions-*`。

隔离启动必须显式区分队列路径，避免操作生产预约：

```bash
PORT=3101 PI_WORKSPACE_BASE_URL=http://127.0.0.1:3101 PI_WEB_DEFERRED_FILE=/tmp/pi-workflows-3101-deferred.json node server.js
```

后端更新须在实例空闲时进行，按实际status核对能力；不能中断当前工作会话。

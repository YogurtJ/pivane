# 手动 Shell 与原生投递模式

后端由 `/api/pi/status.userShell`、`queueModes` 启用；更新后按运行实例核对。

## 使用

在主输入框开头输入 `!命令` 执行 Shell，输出进入 Pi 原生上下文，后续提问时供模型使用；执行本身不会发起模型回答。`!!命令` 同样执行，但原生 `excludeFromContext=true` 将该记录从正常模型上下文转换中排除。两者均保留原生 Bash 记录，`!!` 不是无痕模式或文件副作用隔离。Markdown 图片起始 `![` 保持普通文本。

输入框显示模式说明，发送按钮的图标与无障碍名称改为执行 Shell。只处理原稿开头的前缀，不展开模板/Skill 或拼接附件。命令为空、超过32768字符、包含NUL或带上传附件时拒绝，保留草稿。Shell 不支持延迟发送；加号预约入口明确拒绝这样的草稿。侧聊没有 Shell 执行入口，既有受限协议保持。

命令默认在 Pi 服务器当前项目目录、以服务系统用户权限运行，使用原生 shellPath/shellCommandPrefix；user_bash 扩展仍可接管本地/远程执行。项目白名单和 trust 不是工具沙箱。每次是独立非交互命令，`cd`、`export` 不作为持久终端状态；不提供stdin/PTY、交互密码输入、终端编辑器或并发命令面板。

首版只允许会话空闲时执行，同一会话一次一条。运行期间可以编辑草稿，普通 prompt/steer/follow_up、模型切换、压缩、资源重载和预约投递被互斥阻止；其他会话不受影响。卡片在正文模式下直接可见，显示输出、运行状态、终态耗时、退出码和独立停止按钮。点击停止只请求取消，显示“正在停止”，等待原执行终态。`abort_bash` 不能替代 Agent 的停止/取回队列操作。

成功接收才清除仍匹配的原稿，过程中编辑的新稿保留。明确拒绝保留草稿；断线/超时结果不明不自动重试，再次发送前先核对。命令失败可能已产生副作用。切线程只解除对持久运行实例的订阅，命令继续；临时会话断开或显式退出先尽力请求原生取消，再销毁worker。扩展自管远端操作或自行脱离的后台进程不承诺能被取消。

## 运行与历史

`server/pi-shell-execution.js` 由每个 AgentWorker 持有，始终复用当前唯一 Pi RPC worker。Shell 在第一个await前预占，原生状态复查后提交一次 `bash`，保留原生user_bash扩展链路。网页得到服务器接收响应；原生最终response由内部长期请求接收。该请求没有普通30秒等待超时，仅在明确终态或worker退出时结束；不会由于浏览器离线自动重新执行。

原生 `bash_execution_update.id` 通过 PiRpcClient 内部回调关联执行ID，Supervisor截获原始片段，发布有界 `gateway_shell` 快照。运行卡片使用文本节点，既不执行HTML也不转为Markdown；无需PTY依赖。每worker仅保留当前/最近一条执行状态与最多65536个UTF-16字符的输出尾部，不切断代理对；原生历史仍由Pi写入。快照最多每150ms广播一次，开始/停止/终态立即广播。单连接Shell推送前若WebSocket待发量超过1MiB，关闭该慢连接，使其重新读取快照；持久命令继续。

Shell状态参与activity.busy、空闲回收、工作流互斥和空闲部署判断。`agent_settled`、`get_state.isStreaming=false` 或停止请求成功均不解除Shell占用。执行结果未知保持占用，用户仍可在输入框发送`/quit`显式退出运行实例；worker退出/重建后的不可恢复部分不冒充完整日志。期间扩展的正常站内确认仍可响应。

打开/重连快照及get_state提供有runtimeId/revision的webShell；页面拒绝旧修订和旧socket代次结果。持久会话刷新恢复当前状态和输出尾部，临时会话遵循原断线结束契约。完成事件独立触发get_messages/state/stats同步，不等待agent_settled；历史由原生BashExecutionMessage渲染接替临时卡片，避免双份记录。

历史卡片增强取消、退出码、是否排除上下文、原生截断及fullOutputPath展示。fullOutputPath只作纯文本路径，没有新增任意文件读取/下载。最终输出采用Pi原生结果，可能比直播期间看到的输出更短；显示预算与Pi原生截断分开标注。只展示原生记录，不推算命令修改了哪些文件，不纳入本轮edit/write差异汇总。

当前Web新建空会话经原有SessionManager.open即时写入header，真实测试确认首次Bash无assistant也会追加落盘。外部CLI尚未落盘的会话不因此获得新的保证；不修改Pi包或手工追加JSONL。

## 主 WebSocket 契约

只在已认证且已打开的主持久/临时连接处理；复用本站访问身份、Origin、project realpath和session查找。侧连接保持原白名单。所有新增字段由服务端严格校验，拒绝自定义cwd、输出路径及未知参数。

- `bash`：`{id,type:'bash',command,excludeFromContext?:boolean}`。成功data是接收时的Shell快照，表示已提交，不是命令完成。原生底层RPC仍等待最终BashResult；此差异只在Web网关边界。
- `abort_bash`：`{id,type:'abort_bash',executionId}`。仅接受当前running执行ID，旧ID、重复停止或已结束拒绝。成功data为当前快照，不表示进程已结束。
- `get_state`：增加`webShell`及`webQueueModes`。
- `gateway_shell`：`{type:'gateway_shell',shell:{runtimeId,revision,busy,job}}`；job为null或当前执行，含id/command/excludeFromContext/status/startedAt/output/displayTruncated，终态可含finishedAt/exitCode/cancelled/truncated/fullOutputPath/recorded/error。
- status为starting/running/stopping/uncertain/completed/failed/cancelled/rejected；前四项busy。rejected是提交前拒绝；failed不代表没有副作用；recorded=true表示原生已记录结果，持久性遵循会话类型。

不开放裸Bash转发，不接受浏览器覆盖内部RPC ID；请求接收不是持久幂等票据，没有自动重放或跨服务重启的任务恢复。

## 详情区队列投递控制

“引导消息投递”“后续消息投递”各自支持逐条（one-at-a-time）/全部（all）。输入框既有“引导/后续”决定这条消息何时送达；详情选项决定每次取几条。初始值来自实际get_state，不替用户重置默认。

`set_steering_mode` / `set_follow_up_mode` 接受`{mode,runtimeId,revision}`，与webQueueModes快照匹配后调用原生setter，并重读当前状态，返回/广播`gateway_queue_modes`的`modes`。同一运行实例变更预占操作，旧页面修订拒绝；设置保存与原生配置/供应商登录互斥。正常Agent生成期间允许修改队列策略；Shell、压缩、停止或其他冲突操作期间拒绝。

原生setter立即修改当前agent，并交给SettingsManager保存全局默认，不写工作台偏好或会话历史。项目设置覆盖仍遵循Pi规则，其他已启动worker不自动改值；详情文案必须说明此范围。冲突、失败或等待超时后重读核对，不能自动重复写入。保存成功后的全局落盘由原生SettingsManager负责，不把RPC响应当成独立的持久事务回执。

## 验证

```bash
node --test test/pi-shell.test.js test/pi-shell-state.test.js
PLAYWRIGHT_MODULE=/path/to/playwright PI_SHELL_TEST_URL=http://127.0.0.1:3131 node test/browser/pi-shell.cjs
npm test -- --test-concurrency=1
npm run check
npm audit --omit=dev
```

原生专项使用独立Agent/project/deferred配置，没有付费模型请求。覆盖双客户端互斥、Unicode/LF流式、活动/回收、冲突RPC/工作流、持久重连/重启、取消、!!排除、user_bash扩展直接返回、大输出原生截断、全局队列设置落盘及临时断开取消。状态专项验证停止ACK仍保持占用、未知结果不解锁、不重放以及其他请求片段不泄入当前输出。

浏览器使用系统Chromium及mock REST/WS，覆盖1440/393/320px、三主题、旧后端、正文可见、执行/停止/完成去重、刷新恢复、草稿与附件、设置冲突和迟到线程输出；测量内部卡片/输出/详情实际宽度，检查pageerror。不在当前工作会话发送测试消息，不写生产配置或媒体。手机为Chromium仿真，不声称Safari真机键盘验证。

部署前检查Agent、侧聊、Shell、媒体、配置、预约和导出活动，处理完毕再停机更新。真实Shell专项test/browser/pi-shell-live.cjs有隔离URL与临时项目保护，不用于用户正在工作的会话。

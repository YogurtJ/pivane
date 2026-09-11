# 原生功能收尾：运行恢复、扩展交互、跨线程搜索与配置生效

2026-09-11 跨线程扫描已接入Windows原生句柄路径、完整文件身份与BigInt stat，保留根/隐藏项目/载荷/预算/前后变化检查。Windows11 x64原生搜索/恢复、单worker、Shell和侧聊验证通过，具体OS/文件系统范围见WINDOWS.md。

2026-09-11 跨线程搜索的macOS描述符验证已接入共享F_GETPATH组件，Linux仍用/proc；所有预算、角色排除、路径/身份与前后检查保持。组件不可用则不启用sessionSearch，并拒绝扫描，不把漏扫当零结果。Mac大小写与/tmp通过native realpath规范，完整平台范围见MACOS.md。

2026-09-10 源码实现。后端需空闲启用，以实际 `/api/pi/status` 的 `liveRecovery`、`extensionDrafts`、`sessionSearch`、`runtimeConfiguration` 为准。没有修改上游 Pi 包或新增持久聊天历史。

## 运行现场恢复

`server/pi-live-state.js` 由当前唯一 AgentWorker 持有。缓存正在生成的 assistant content、尚未成为原生 toolResult 消息的工具执行状态；message_end/agent_settled 释放对应缓存。每次广播增加 `webRuntimeId` 与单调 `webSequence`。

`PiRpcClient.request` 的内部同步 response mapper 在解析原生响应的同一调用栈执行。受管主会话的 `get_messages` 附带 `webLive`，在这个精确边界复制 partial/tools 和序号；同一边界内部捕获 controls、pendingUi、Shell、导航和压缩状态，打开响应只传一份对应快照，不在webLive重复大队列。打开快照最后读取 messages，前端先缓冲初始化事件，恢复快照后只接续同 runtime 中序号更大的事件；通知和扩展错误单独保留。旧后端无字段时沿用已有快照并重放初始化期间事件。

仅保存有界展示信息：partial 最多 512Ki 字符；单工具普通快照最多 64Ki 字符，超限改为参数预览和输出尾部；最多32条未归档工具。恢复预览截断明确提示，最终仍以原生完整消息校正。初始化事件队列最多8Mi字符/10000事件，超过则停止本次连接并提示重开，不自动补发模型问题。持久 worker 断线继续，服务重启无法恢复未落盘 partial；临时线程原断线销毁规则不变。

## 扩展草稿与启动兼容

`set_editor_text` 不再无条件覆盖输入框。新后端将最多8条、每条65536字符的建议保存在 controls.drafts；超限通过 draftOverflow 明示。空文字不作为清空网页草稿的指令。空稿且无附件/读取/提交时可直接填入；已有文字或附件时在输入框上方提供追加、替换文字、忽略。替换需要确认，附件保留，不自动发送。

`ack_extension_draft {runtimeId,draftId}` 只处理当前受管实例的建议。前端先记录本页已应用 ID，再确认移除，确认失败不重复追加；线程切换和断线清空本页展示并丢弃迟到结果。建议随 worker 销毁，不写 JSONL/工作台偏好。未处理建议阻止空闲回收，显式退出仍会丢失。旧后端的实时建议也经过同一草稿保护，无法提供服务端重连恢复。

当前 Pi 0.85.0 在绑定 session_start 后才安装 RPC stdin 处理，启动阶段阻塞对话无法响应。PiRpcClient 在启动阶段发现 select/confirm/input/editor 时返回 `STARTUP_UI_UNSUPPORTED`，不替用户确认；启动失败返回 `RPC_STARTUP_FAILED`。Supervisor 清理未就绪实例，前端停止自动重连并保留错误、重试连接和管理扩展入口；浏览器主动关闭使用应用关闭码4000/4008，避免浏览器拒绝1011/1008引发二次异常。正常任务中的基础对话框沿用原 pendingUi 协议。

Packages 页面明确说明安装/配置发现不等于已验证 Web 兼容。基础工具/命令/对话框/文字状态可用；TUI custom、终端编辑器/快捷键、组件式 widget 不自动转换。不对未知 Package 虚构兼容认证。

assistant stopReason=length 显示达到输出上限，用户自行决定是否发送继续消息。

## 跨线程正文搜索

`GET /api/pi/sessions/search?q&cwd?&offset?&searchId?` 复用工作台认证/Origin，no-store。关键词2–200字符，普通大小写不敏感字面量查询，不提供任意正则。默认所有可见允许项目，可限制当前项目。搜索原生v2/v3 JSONL全部历史分支的用户/assistant文字块，排除thinking、工具参数/结果、隐藏custom和图片原件。

单 Worker Thread、最多1000文件/每文件64MiB/单行8MiB/合计256MiB/200000记录/10秒扫描；宿主15秒截止、192MiB堆上限。文件/目录不跟随软链接，校验header cwd realpath/项目根，以及已打开描述符范围、前后状态；读取中变化的文件跳过并明确提示。扫描不会启动 RPC、改写 JSONL 或建立持久索引。当前范围为原生默认 sessions/<project>/*.jsonl 布局，自定义 sessionDir 尚未覆盖。

结果最多200个线程，每线程一个命中正文片段和原生 entryId；20条分页。单份60秒有效的有界内存结果供后续翻页，查询/隐藏项目范围/修订不匹配时409；另一查询占用时429。关闭窗口、修改关键词或新搜索会取消本页请求并终止对应扫描，迟到结果丢弃。分页再次校验项目范围。

入口在项目线程栏底部放大镜。点击结果打开对应原生线程，并衔接已有右侧历史正文预览；不导航分支或自动发送。已有主草稿按原线程保留，离开临时线程需确认。预览目标被删除/变化时明确报错。

## 配置与信任生效

受管 worker 启动前尽力记录原生全局/项目settings、trust及启动覆盖的整体哈希修订；检查受限或读取失败不阻止原生启动，比较结果为未知。不返回原文件或秘密。`get_runtime_configuration` 返回当前runtimeId、最新配置revision、matchesSavedConfig、实际projectTrusted与配置推导trust，以及待处理恢复/建议计数。实际信任来自同一worker公开扩展接口。

会话连接后核对一次；详情资源区可再次核对，网页保存原生设置/资源后通知当前页面重新检查。`matchesSavedConfig` 只表示配置文件与启动时一致，不保证资源文件内容未变、扩展没有修改工具/模型或最终请求payload一致。资源内容修改使用原有显式reload；设置/信任差异提示重新打开实例。其他设备或终端变更在显式核对/重新连接时检测，没有持续读盘轮询。

首次连接含受信资源、全局ask、无决定/启动覆盖且当前实例实际未信任的项目，显示可关闭的项目信任提示；不自动授权。项目菜单和/trust保持可用，配置页增加查看当前实例入口。

`restart_runtime {runtimeId,expectedRevision,confirmed:true}` 仅持久线程：在唯一worker空闲互斥内复核配置，拒绝运行、压缩、工具、等待确认、待发队列、未处理取回/建议以及关联侧聊。与设置保存互斥；暂停该线程预约后返回接受ACK，Supervisor发布replacement promise，关闭旧订阅、完整结束旧进程，再启动同一session文件的新worker。其他连接通过原重连取得新快照，不能并行创建第二个worker。ACK不是新实例启动成功；最终由重连和配置核对确认，不自动重放重开请求。当前网页草稿和附件保留。

## 验证与启用

- `node --test --test-concurrency=1 test/pi-native-completion.test.js`：实际Pi与loopback SSE验证流式恢复、响应边界、建议、配置差异、忙碌拒绝、同session唯一worker重开和历史保留；只读搜索边界；启动交互拒绝。
- `PLAYWRIGHT_MODULE=... PI_COMPLETION_TEST_URL=http://127.0.0.1:3001 node test/browser/pi-native-completion.cjs`：生产静态资源+mock API/WS，1440/393/320px验证事件边界、恢复、草稿确认失败不重复、搜索预览、配置反馈与重开，无真实模型或写请求。
- 既有跨线程浏览器用例在选线程前明确切换“全部”，兼容共享目录同期的“工作中”默认视图，不改变产品默认或删除原断言。启动失败专项发现并修复了浏览器不接受1011/1008主动关闭码的问题，初次失败日志保留在本轮快照。
- 最终验证：147/147项Node、check、audit（0漏洞）、试用包清单，以及新增功能/原生设置/队列控制/历史/会话树/Shell/附件/正文阅读/会话工作流/侧聊/供应商登录共11组Chromium回归全部通过，validation.json为validated且源码哈希一致。新增界面覆盖1440/393/320px与三主题；手机为Chromium视口仿真。没有真实模型或生产会话写入。
- 候选包验证记录应绑定版本与SHA256；运行能力以实例status为准，不把等待部署写成启用。

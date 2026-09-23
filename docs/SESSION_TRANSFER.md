# Pi 会话导入与导出

## 当前实现与入口

`/api/pi/status.sessionTransfer=true` 才启用网页入口。线程更多菜单的“历史与记录”二级菜单提供“导出记录”；项目菜单的“更多操作”二级菜单与顶部项目选择器提供“导入 Pi 会话”。旧后端隐藏这些入口。临时 `--no-session` 会话暂不支持导出。

| 格式 | 范围与用途 |
|---|---|
| HTML | 原生 `export_html`，包含该会话树已保存的记录、历史分支、压缩前消息、思考和工具内容；原生导出还携带 runtime 系统提示与工具定义。内嵌脚本/样式和记录，离开工作台可独立阅读。 |
| Pi JSONL | 原生 `AgentSession.exportToJsonl`，仅当前活动分支上的记录。可导入 Pi 继续对话，不是完整会话树备份。 |

两种格式均不是当前屏幕正文的截图，也不会打包项目文件、工具输出引用的外部文件、凭据配置或运行环境。历史消息中已经出现的私密内容仍可能随记录导出，分享前应检查。HTML 只作为下载附件提供，不在工作台 origin 内预览或执行。

导入仅接受 UTF-8 的 Pi v2/v3 JSONL；允许 BOM、CRLF、空行，错误行明确拒绝，不静默跳过。HTML、其他 harness 日志和未来未知格式不自动转换。上传内容若含完整会话树会保留其全部 entries；由原生 JSONL 导出得到的文件通常只有一个活动分支。支持 Pi 0.87 的 `context_edit`（省略或替换模型上下文）、`firstKeptEntryId` 为压缩自身 ID 的无保留压缩，以及独立 `usage` 记录。上下文编辑目标必须是同分支的早期用户、助手、工具结果或自定义消息；替换内容按目标角色校验。原始正文、用量和时间不随上下文编辑改写。

选择目标项目后，原生 `SessionManager.forkFrom` 创建新的会话 ID 和目标 cwd，已有线程保留。原会话名称、消息时间、工具记录、模型记录、分支和书签随 entries 保留；v2 先通过原生迁移到 v3。消息正文中的旧路径不改写，文件中的 cwd 不授予访问权。导入不启动 runtime、不发送模型请求、不自动切线程，完成后用户可点击“打开新线程”。继续对话时仍使用正常 Pi 模型、项目资源和 trust 策略；缺少原模型/环境时遵循原生加载行为。

## 网关契约

复用 `/api/pi` 的 Origin/Bearer token 检查，所有响应 `Cache-Control: no-store`。

### `POST /api/pi/sessions/:id/export`

JSON body：`{ cwd, format: "html" | "jsonl" }`。

- 通过 store 以 cwd/sessionId 找到原生会话，客户端不指定源文件或输出路径。
- 只经 Supervisor 当前唯一 worker 的空闲互斥区执行，运行、压缩、等待确认和冲突操作拒绝；不会为了导出停止任务。
- HTML 调用原生 RPC。JSONL 用原生 `get_entries` 的 entries/leafId 建立仅存内存的 SessionManager，并委托公开 `AgentSession.exportToJsonl` 方法；该无状态方法显式绑定 sessionManager，不创建第二个 Agent 或改写序列化协议。
- 首次取得 worker 仍可能触发 Pi 正常启动 metadata；导出本身不导航或写入源历史。
- 服务端源文件与最终下载各最多 64 MiB。输出写入随机 0700 临时目录，读取下载后在 finally 清除；不放 public 或允许客户端下载任意路径。
- 成功返回文件正文，`Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`、响应 CSP `sandbox; default-src 'none'`；文件名为 `pi-session-<id>.html/jsonl`。
- 忙碌 HTTP 409；格式、路径、大小、导出错误 HTTP 400。前端不自动重试；关闭窗口丢弃迟到下载结果。

### `POST /api/pi/sessions/import`

JSON body：`{ cwd, content, requestId }`。

- content 为 JSONL 文本，最多 16 MiB；单记录最多 8 MiB，最多 50000 条 entries，JSON 嵌套最多 64 层。仍受全局 32 MB JSON 请求体限制。
- 校验 header/version、消息/内容块类型、记录字段、唯一 entry ID、父节点顺序及摘要引用；拒绝循环、重复和断裂父链。未知格式明确拒绝。
- 项目必须经过 realpath/PI_PROJECT_ROOTS 校验，导入只写原生 sessions 目录，新文件权限 0600。先在同文件系统的随机 0700 私有目录中完成原生迁移/复制，设为0600后以不覆盖目标的硬链接原子发布完整文件，再清理临时目录；没有半写入的可见线程、平行聊天历史或长期上传原件。
- 原生 forkFrom 会在新 header 的 parentSession 留下已清理的临时源路径；它仅是来源 metadata，不是可恢复的原文件或跨实例链接。原生 JSONL 的分支外 label target 可能缺失，保留 metadata，不补造外部分支。
- requestId 为 16–80 位字母/数字/连字符。单进程最多保留 100 个、30 分钟的 hash/状态/新线程结果，不保存上传正文。相同 ID 和相同文件/目标成功后返回原结果；相同 ID 改参数、正在执行或不确定拒绝。不构成跨进程/重启后的持久幂等。
- 成功 HTTP 201：`{ session: <标准 session object> }`。失败 HTTP 400。上传后不自动重试；网页移除此次提交按钮，断线/超时先刷新目标项目核对，重新导入必须是新的显式操作。
- 导入到已移出的项目时恢复其可见性；列表刷新失败仍保留已创建的线程并明确提示。

每进程最多两项会话文件操作。`GET /api/pi/activity.sessionTransfers` 为运行操作数，供空闲部署检查，不含正文。导入/下载不改变原主框草稿、附件或当前 worker；仅显式打开新线程才走正常切换流程。

原生终端 `/import <path>` 会替换当前 runtime，因此网页使用 SessionManager 的新 ID 复制流程，不裸透传 `switch_session`。网页 `/export` 打开当前持久线程的导出窗口，`/import` 打开导入窗口并默认选中当前项目，均与菜单共用流程。只接受不带参数的命令，文件在窗口中选择，不读取终端路径，也不把命令发送给模型。成功打开窗口后仅清除仍匹配的命令草稿；未启用、带参数、临时线程导出或窗口正忙时保留输入。运行中可打开窗口，实际下载继续由后端检查空闲。没有打开会话时仍可使用项目入口导入。

## 验证与部署

```bash
node --test test/pi-session-transfer.test.js
PLAYWRIGHT_MODULE=/path/to/playwright PI_TRANSFER_TEST_URL=http://127.0.0.1:3112 node test/browser/pi-session-transfer.cjs
```

Node 使用临时 Agent/项目、真实原生 SessionManager 和 RPC：校验全树/单分支范围、独立 ID/cwd、书签/摘要/图片保留、空会话、旧版本、原文件不变、鉴权/来源/越界/忙碌拒绝和不启动导入 worker。浏览器用 mock API/WS 验证 1440/393/320px、三主题、真实下载、无自动切线程、草稿保留、失败/迟到结果和旧后端降级；可使用 Node 生成的测试 HTML 核对离线阅读。

生产需要空闲切换后才会出现 `sessionTransfer=true`；仅刷新静态资源不启用旧后端。部署前须同时确认 Agent、临时 runtime、媒体及 `activity.sessionTransfers`均无活动；旧后端缺字段须结合其实际操作能力核对，不能把未知直接当零。不能中断当前工作会话来上线。



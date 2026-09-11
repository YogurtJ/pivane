# 持久会话用量统计

2026-09-11 Windows句柄后端与所有平台BigInt stat接入：先校验长度预算再转Number分配buffer，Windows额外核对路径当前对象的完整卷/128位File ID；无描述符后端不静默返回零。Windows11 x64原生持久用量、跨线程正文搜索及恢复后正数用量验证通过，平台限制见WINDOWS.md。

2026-09-11 macOS适配：扫描器通过共享描述符边界使用F_GETPATH，Linux继续/proc；原有目录、文件身份、预算与前后变化检查保留。缺失安全后端在扫描前拒绝，不伪报零用量。系统原生realpath处理Mac路径大小写和/tmp别名；原生JSONL仍是唯一来源，不改历史费用。详见MACOS.md。

设置 → 用量统计提供今天、最近 7 天、本月及自定义日期（最多 366 天），包含输入、输出、缓存读写、总 Token 和估算美元费用。每日趋势可切换指标，点击或键盘聚焦日期查看数值；供应商、模型、项目和可展开的会话明细按总 Token 降序排列，每张明细表分批显示 20 行。手机表格与长时间图表在各自区域横向滚动。

## 页面布局

筛选区使用统一高度的范围/日期/刷新控件，桌面横排，平板两行；480px 以下范围与刷新同排，起止日期各自一行。日期继续使用浏览器原生选择器，其显示格式由浏览器/系统地区设置决定；提交仍为 YYYY-MM-DD。读取时刷新图标转动，减弱动态效果时关闭转动，不改变原有请求生命周期。

外层统计页不提供横向浏览空间；长表格和多日趋势在各自容器内滚动，大额数字和长标识可换行。UI 回归要同时检查面板、结果、卡片及日期字段的实际边界，不能仅验证 body 宽度。设置中的“使用偏好”同时加固原生模型 select 的轨道宽度，并说明模块 Agent 用于多媒体实验室生成方案。

## 数据来源与口径

唯一来源是当前 Pi Agent 目录下 `sessions/<project>/*.jsonl` 的原生 v2/v3 记录。读取并严格解析 JSON，复用原生文档的数据结构；不调用可能迁移落盘的 SessionManager.open，不创建第二个 RPC worker、模型请求、数据库或聊天历史。旧 v1、损坏、非 UTF-8、超限、扫描中变化的文件跳过并显示统计不完整。

- 只包含 header.cwd 经 realpath、目录存在性和当前 PI_PROJECT_ROOTS 校验的项目。已移出侧栏的项目若仍有有效记录，按同一根规则统计；目录已不存在或范围外的项目不纳入。
- 累加所有分支的 assistant usage、明确上报 usage 的 toolResult，以及 compaction/branch_summary 的 usage；不递归累加 retainedTail 中的旧消息。没有 usage 的普通工具结果不视为额外模型消耗，摘要/assistant 缺少完整 usage 则标明未知。
- 总 Token 为 input + output + cacheRead + cacheWrite；与当前上下文占用独立。失败或停止记录只要包含用量也计入。
- 以原生 entry.timestamp 在所选 IANA 时区的日期分组，首尾日期均包含。默认浏览器当前时区；无有效日期不推算，报告 invalidDates。
- 跨文件按 entry ID、entry timestamp 和规范化载荷的 SHA-256 去重，忽略可能被分支导出改动的 parentId；ID 相同但载荷不同仍分别计数。原生复制、分叉、导入保留这些字段时只计一次，不追随 header.parentSession 读取任意路径。手工修改 ID/时间/载荷的副本无法可靠去重。
- 重复记录归属最早创建的现存会话（相同时间按文件路径稳定排序）。原文件删除后可由存活副本承接，因此这是现存记录的归属统计，不是不可变账本。各项目/会话小计可加和到总量。
- 模型按 assistant.provider 和 responseModel（没有时 model）归属；工具/摘要用量单列“工具与摘要”，不猜测模型。
- 费用使用原生记录当时的 usage.cost.total，不重新按当前目录价格回算。缺少费用和零费用分开计数；订阅、代理折扣或未配置价格时不能当作真实账单。
- 不覆盖临时会话、BTW 侧聊、媒体 planner、模型测试、外部未落盘请求及已删除记录；不新增长期临时用量日志。

返回结果只含数值、日期、供应商/模型标识、项目路径与会话 ID/显式名称；无 firstMessage、正文、思考、工具参数、摘要或 session 文件路径。没有显式名称的会话显示 ID，不读取首条问题作为标题。

## API

`/api/pi/status.usageStats=true` 标记后端启用。

`GET /api/pi/settings/usage?from=2026-09-01&to=2026-09-09&timeZone=Asia%2FShanghai`

复用 Pi Origin/Bearer 验证、no-store。from/to 必须为真实 `YYYY-MM-DD`，包含两端且最多 366 天；timeZone 缺省为 UTC，必须为 Intl 支持的 IANA 时区。未知字段拒绝，不接收客户端文件路径或额外项目根。

响应字段：

- from/to/timeZone/generatedAt/scope（固定 persistent-sessions）。
- total：input/output/cacheRead/cacheWrite/total/cost/records/missingUsage/missingCost/zeroCost。
- daily：连续日期含零记录日，每项 date 加上述统计。
- providers/models/projects/sessions：归属标识加上述统计，仅有记录的组返回。
- coverage：scannedFiles/skippedFiles/excludedProjects/duplicates/invalidDates/limited。
- partial：跳过文件、无日期、扫描限额或缺失完整 usage 时为 true；缺少价格另以 missingCost 显示。

非法筛选 400，鉴权 401/403，不同筛选并发扫描 429，线程异常/超时 503。空目录成功返回零条记录，错误不能回填假零数值。页面修改日期、关闭设置或切分类后取消并忽略迟到请求；服务扫描可继续完成但不会自动重放。

## 读取预算与性能

一个服务最多一个扫描 Worker Thread，相同查询复用进行中的 Promise；只缓存最近一个汇总结果 15 秒，无定时后台扫描，无磁盘缓存。源文件不修改，数据变化可能在这 15 秒内尚未反映，页面显示结果时间。

目录只访问上述两层结构，不跟随项目目录或文件软链接；文件采用 O_NOFOLLOW/O_NONBLOCK 和真实描述符边界检查，前后检查 inode、大小、mtime/ctime 和项目路径。每次按 LF 串行读取 64KiB 块，允许 CRLF 与 JSON 字符串内的 U+2028/U+2029，非法 UTF-8 拒绝。

限额：2000 文件、单文件64MiB、单条8MiB、扫描总量512MiB、250000原生行、100000范围内用量记录、扫描20秒。达到限额时返回已完整读完文件的部分结果并标明 limited；线程总等待30秒、V8 old generation192MiB，线程失败不返回假完整结果。只返回一份汇总，避免在 Express 主线程解析大量聊天记录。

## 验证与部署

```bash
node --test test/pi-usage.test.js
PLAYWRIGHT_MODULE=/path/to/playwright PI_USAGE_TEST_URL=http://127.0.0.1:3123 node test/browser/pi-usage.cjs
PLAYWRIGHT_MODULE=/path/to/playwright PI_SETTINGS_LAYOUT_URL=http://127.0.0.1:3001 node test/browser/pi-settings-layout.cjs
```

Node 验证真实原生创建/分叉身份、摘要与 retainedTail、日期边界、未知用量/费用、异常/越界文件、预算、并发和鉴权，断言无 worker 创建或源文件改动。浏览器使用 mock API，覆盖1440/393/320px与三主题、筛选/图表/分页、空状态/错误/旧后端和迟到响应，不发送模型或媒体请求。

后端需usageStats能力及可用描述符组件，缺少时页面显示未启用，不伪造已有数据。更新遵循停机备份流程，核对主/侧会话、预约、导入导出和媒体活动，不能中断运行中的任务。

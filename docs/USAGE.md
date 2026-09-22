# 持久会话用量统计

设置 → 用量统计提供今天、最近 7 天、本月及自定义日期（最多 366 天），包含输入、输出、缓存读写、总 Token 和估算美元费用。趋势可以按日、周和自然月查看；周从周一开始，周期只累计所选日期范围，不把范围外的日期算入。供应商、模型、项目和会话明细按 Token 降序，每批显示 20 行。

## 持久账本

用量保存于 Pi Agent 身份目录的 `pivane-usage/ledger.sqlite`。这是只有用量事实、去重指纹、定价依据和归属信息的独立账本，不是聊天副本，不含正文、思考、工具参数或摘要。原生 SessionManager/JSONL 仍是唯一对话事实来源；统计不会修改 JSONL，也不会创建 RPC worker 或请求模型。

- 首次同步从 `sessions/<project>/*.jsonl` 补录原生 v2/v3 用量，后续按完整文件身份、大小和纳秒 mtime/ctime 跳过未变化文件，只重新解析变化的文件。
- 服务每分钟进行有界同步，打开统计时也同步；同一查询保留 15 秒内存缓存。服务关闭时等待进行中的账本操作退出。休眠或停机不依赖跨日定时任务，恢复后补录仍存在的历史文件。
- 每笔事实和各时区日汇总在同一 SQLite 事务内提交，重复导入不再次累计；重启、会话删除或历史文件缩短不会扣回已入账用量。
- 日汇总入账即更新，周/月直接相加，不必等到周期结束才能保住用量。新时区首次使用从精简事实建立日汇总，以后直接读取日汇总；保留最多 32 个时区，包括默认 UTC。
- 网页删除会话先停止对应 worker，再确认该文件的当前修订已完整入账；入账失败、文件损坏、日期无效或超限时拒绝删除。通过外部 CLI/文件管理器删除时没有此检查，应先确认统计同步完成。
- 首次入账之前已经删除且没有副本的记录无法恢复。外部删除尚未同步的新增记录也无法事后补录。

账本不再是可以随意丢弃的缓存。删除原生会话后，账本是这些用量的保留凭据；备份、恢复和迁移身份目录时必须包含整个 `pivane-usage/`。实例停机整批备份涵盖该目录。使用 SQLite 完整同步事务、私密目录与文件权限，损坏或不可读时返回错误，不伪报零数据。需要 Node.js 22.19 或更新版本的 `node:sqlite`；部分 Node 版本会打印实验性模块提示。

## 统计范围与去重

新增入账仍严格校验 header.cwd 的 realpath、目录存在性、系统访问权限和当前项目根范围。已入账项目按当时验证的规范 cwd 保留；项目目录随后删除也不会丢失已入账数据，但查询仍按当前允许项目根筛选。

累计所有分支的 assistant usage、明确上报 usage 的 toolResult，以及 compaction/branch_summary 的 usage；不递归计算 retainedTail。没有 usage 的普通工具结果不算额外模型消耗，摘要/assistant 缺少完整 usage 标明未知。失败或停止记录只要有用量也计入。总 Token 为 input + output + cacheRead + cacheWrite，与当前上下文占用独立。

以原生 entry.timestamp 和所选 IANA 时区分日，首尾日期均包含；无有效日期不推算。跨文件按 entry ID、timestamp 和规范化载荷的 SHA-256 去重，忽略 parentId。原生复制、分叉、导入保留这些字段时只计一次，不追随 parentSession 读取任意路径；手工修改 ID/时间/载荷不能可靠去重。

首次批量入账按会话创建时间和路径排序确定归属，后续保留第一次入账的归属。删除原始会话不会将用量转给副本。会话明细包括已删除会话的显式名称或 ID，各归属小计可以加和到总量。

模型按 assistant.provider 和 responseModel（缺省 model）归属；工具与摘要单列，不猜测模型。临时会话、BTW 侧聊、标题生成、媒体 planner、模型测试和未落盘请求暂不在本账本范围。标题生成窗口的一次请求用量展示不等于累计标题日志。

## 官方参考价格

保留原始 `usage.cost.total`。有完整用量且原始费用为零或缺失时，精确匹配随 Pi 安装的 OpenAI、Google、xAI、Anthropic 官方供应商目录，按每百万 Token 单价补算。包含长上下文阶梯和已记录的一小时缓存写入量。目录读取不加载认证、不发网络或模型请求。

不模糊匹配显示名，不删除模型后缀，不把 `gpt-5.6` 猜成 `gpt-5.6-sol`，也不把 `grok-4.6-build` 猜成 `grok-4.6`。未知型号、价格字段不足或有缓存写入但目录没有写入价时保留原始费用并标明仍无确认价格。非零原始费用保留。新建自定义模型在 ID 精确匹配且尚未设置价格时使用官方目录价（包括阶梯）；已有显式价格不自动覆盖。

每条补算事实保存官方供应商、模型 ID、参考链接、单价内容哈希、完整价格表和本笔适用阶梯，便于追溯。之后目录更新不会自动重估已经入账的费用。它是按补录时目录价计算的参考估算，不代表消费当日价格、中转站实际扣款、订阅费用、折扣、税或音视频及搜索工具额外收费。目录可能滞后于官网，未知费用不能当作免费。

参考：[OpenAI](https://openai.com/api/pricing/) · [Google](https://ai.google.dev/gemini-api/docs/pricing) · [xAI](https://docs.x.ai/developers/models) · [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)。页面明确区分补算记录数、没有确认价格的非零用量记录数和原有缺失/零费用计数。

## API

`/api/pi/status.usageStats=true` 标记统计可用，`usageLedger=true` 标记持久账本能力。

`GET /api/pi/settings/usage?from=2026-09-01&to=2026-09-30&timeZone=Asia%2FShanghai`

沿用 Origin/Bearer 验证和 no-store。from/to 必须是真实 YYYY-MM-DD，包含两端且最多 366 天；timeZone 缺省 UTC，必须为 Intl 支持的 IANA 时区。未知参数拒绝，不接受客户端文件路径和额外项目根。

- `from/to/timeZone/generatedAt/scope` 保留，scope 为 `persistent-sessions`，增加 `ledger:true`。
- `total`、`daily`、`providers/models/projects/sessions` 保留 `input/output/cacheRead/cacheWrite/total/cost/records/missingUsage/missingCost/zeroCost`。
- 各汇总增加 `recordedCost`（原始费用合计）、`estimatedRecords`（官方价补算笔数）、`unpricedRecords`（非零用量但仍无确认价格的笔数）。
- 增加 `weekly/monthly`，date 分别为周一日期或 YYYY-MM；只合计筛选内日期。
- `coverage` 为本次同步的 `scannedFiles/cachedFiles/skippedFiles/excludedProjects/duplicates/invalidDates/limited/syncedAt`。cachedFiles 表示身份和修订未变化；duplicates 表示本次读取中已入账的指纹数，并非账本历史副本总数。
- `partial` 在跳过文件、日期异常、达到限额或用量缺失时为 true；价格缺失另行显示。总数包括早先已保存的数据，不能将 partial 报告当作本次完整补录证明。

非法筛选 400，不同筛选或后台同步并发时 429，线程/账本失败或超时 503。空来源目录仍返回已有账本；首次空目录才是零。页面取消或关闭不会撤销已经开始的事务，也不会自动重放请求。

## 读取预算与平台

一个服务最多一个统计 Worker Thread，30 秒线程限时、192 MiB old generation。最多枚举 100000 个来源路径；单批解析最多 2000 个变化文件、512 MiB、250000 行或 100000 条用量事实，扫描阶段 20 秒。后续批次跳过已核实修订继续推进；单文件 64 MiB、单条 8 MiB。超限、损坏、旧 v1、非 UTF-8 或读取中变化的文件不作为完整入账文件。

目录只读原生两层布局，不跟随目录或文件软链接。O_NOFOLLOW/O_NONBLOCK、BigInt stat、描述符路径、完整身份及前后校验保留；Linux 使用 /proc，macOS 使用 F_GETPATH，Windows 使用 HANDLE 最终路径和完整卷/File ID。缺少安全后端不降级为不安全扫描。新账本事务已通过 Linux 合成验证，既有 Mac/Windows 扫描后端验收不代表新账本已完成当地实机验证。

## 页面与验证

桌面筛选横排，手机日期字段至少 16px；长表格和图表在内部滚动，外层统计面板不产生横向滚动。只使用安全 DOM 显示模型、项目、会话标识。

```bash
node --test test/pi-usage.test.js test/pi-usage-ledger.test.js
PLAYWRIGHT_MODULE=/path/to/playwright PI_USAGE_TEST_URL=http://127.0.0.1:3123 node test/browser/pi-usage.cjs
```

Node 覆盖原生复制去重、持久化/删除/重启、日周月和时区、阶梯价、事务失败回滚、损坏存储、项目范围、增量推进、删除检查、源文件不变、鉴权和并发。浏览器采用独立身份及 mock API，在桌面/手机核对图表、周期、边界宽度、空状态/错误、迟到响应和 pageerror，不向真实会话发测试消息。

# 可选助手档案

助手档案用于保存名称、头像、行为说明（SOUL）、记忆和已学习技能设置。Pi Agent 页面新建无身份线程，继续使用原有项目指令、工具和已配置 Skills；助手对话页面从项目栏顶部选择档案，新线程自动使用该档案。一个档案可以用于多个项目，学科或任务方式不必分别创建档案。

本文说明当前源码行为；各正式归档的功能与验收见[版本说明](releases/1.6.1.md)。组件安装、设置保存和会话实际加载分别核对。

## 使用入口

在助手档案页面左侧选择或新建档案，右侧保持固定的详情区。名称最多80字符，描述500字符，行为说明最多32 KiB UTF-8；最多保存50个档案。图片头像先保存档案后上传：网页转换为受限 PNG 后单独提交，编辑器就地显示上传进度和成功／失败，上传期间不能提交档案设置；普通修改仍需另点“保存身份”。可以使用普通新线程向 Agent 讨论草稿，专用 `profile_draft` 工具只生成提案，不自动保存；回到编辑器后由用户确认导入并显式保存。新档案的记忆和自动学习默认关闭，已学习技能默认允许使用。记忆与技能设置独立，开启记忆不会自动开启学习。

新建按钮旁不再提供身份选择器，临时会话入口在项目菜单中。项目默认身份仍服务于旧版/API省略身份参数的客户端。已有线程的归属不随项目默认变化；要使用另一档案，请进入对应助手区域另建线程。旧会话不会自动绑定档案。

关闭档案保留原有数据，使它不能用于新建或新加载。已运行会话保留其已加载配置，保存不会打断任务。详情页分别核对保存的档案和当前运行实例确认加载的ID、版本；配置已变化时需要空闲后重开运行实例。仅刷新网页可能继续连接原来的 worker；资源重载不能更新进程环境中的设置。

档案的“学习与技能”入口浏览并管理此档案的记忆与已学习技能：按类型搜索/翻页、读取受限正文、核对当前修订与未保存草稿，以及查看近期回执的前后版本号；历史正文不由该接口提供，不能把修订号当成可查看的历史全文。可新建、编辑、删除与恢复服务端允许的条目，并通过仍可撤销的回执撤销最近变更。项目范围条目在没有服务端已验证写入能力时只读；技能名称必须以小写字母开头且不超过64位，仅管理档案拥有的技能，原生已安装技能仍在扩展页。存储、检索索引同步和当前会话生效分别显示，任何保存都不证明模型已经遵守。待修复、接口不可用和 revision 缺失时不开放写入；409 冲突保留草稿供核对，网络结果不确定时保留请求 ID 并先查回执，不自动重放。

可对全局 `USER.md`、`MEMORY.md` 显式编辑原生文档（记忆需开启；USER 可独立初始化），使用文档和档案双修订避免覆盖 Agent 或其他编辑者的更新。原有文档编辑器与逐项知识管理分别核对修订。学习设置独立于辅助模型路由：可分别设置后台启用、纠错识别、复盘、候选提取、每天次数（1..20）、预留 tokens（6000..200000）和复盘间隔（0..10080 分钟）。保存只更新配置，不启动模型；专用辅助用途没有模型时不回退到主聊天模型。作业状态与费用仅按服务端报告显示，未知费用不是零。聊天中的“纠错与记忆回执”只对当前有档案的持久线程显示；手动纠错不冒充原生聊天来源，线程来源回执仅展示服务端确认且 sessionId 匹配当前线程的记录。撤销使用回执 ID，并再次由服务端核对当前修订。

学习开关在“学习与技能”页单独保存；档案编辑器保留旧 `memory.autoLearn` 字段的兼容读写，但不再显示旧复盘开关。未安装适配组件、未配置相应用途模型时，快照会显示能力缺失，保存设置不触发作业也不会回退主聊天模型。费用、频率、检索限额和错误状态见[记忆适配](PROFILE_MEMORY.md)。

## 助手会话分类

助手对话支持同一真实目录下的多个分类，各分类可以保存自己的附加指令。普通 Pi Agent 按项目目录组织，不提供分类选择。

助手线程菜单在当前助手、当前目录有未归档分类时显示“更改分类…”，替换不适用的“移动到项目…”入口；没有可选分类时隐藏。窗口显示当前归属，只列同一助手、同一目录的未归档分类（包括空分类），也可选“未分类”。原分类预选，没有修改时不能保存；取消或 Esc 不保存，提交中显示等待提示并禁用关闭与重复提交。

更改分类保留原生会话 ID、完整历史、书签、助手身份和工作目录，记忆范围不变。分类的附加指令从重新连接后的后续对话生效；服务端只在会话、标题生成及后台任务空闲时停止旧 worker 后保存，打开的页面重新连接，保留本页草稿和已读取附件。有关联侧聊时需先关闭侧聊。修订冲突保留选择，重新打开核对最新归属；断线、超时或未知保存结果不自动重试。

较早版本已打开的页面可能在保存时提示“分类变更参数无效”。更新后先保留草稿并刷新页面，再重新打开分类窗口选择目标；被参数校验拒绝的请求没有更改会话分类。

复制或分叉默认继承来源会话当前分类和助手身份，侧栏立即同步新线程；未分类来源保持未分类，不弹出分类选择。

## 身份页与编辑

身份列表显示名称、描述、启用状态和学习状态，支持按名称或描述搜索。桌面上列表与详情分别滚动；手机先显示列表，进入详情后可用左箭头返回列表，并通过“继续编辑”回到保留的草稿。重复选择当前身份不会清空修改。

- **概览**：基本信息、图片／表情头像、能力开关和文档容量分组展示。头像上传单独保存，其他设置由底部“保存身份”提交；未修改的已有身份无需重复保存。
- **个性与行为（SOUL）**：编辑角色、语气和协作原则，与概览设置一起保存；保存后停留在当前页。
- **用户偏好（USER）／长期记忆（MEMORY）**：编辑原生 Markdown 文档，显示字符用量、超限和未保存状态，底部提供刷新核对与单独保存。未启用记忆时提供返回概览的入口。刷新期间继续输入的内容会保留，保存会使此前发出的读取失效，冲突仍须核对服务器版本后提交。保存按钮旁持续显示“正在保存”或服务器确认结果，检索待同步单独提示；请等服务器确认后再刷新。刷新／关闭浏览器时，有未保存内容或正在保存会触发浏览器离页提醒（以浏览器支持为准）。重新进入没有草稿的文档页会读取服务器最新内容。
- **学习与技能**：知识条目与后台学习设置分区展示，可从顶部直接定位学习设置；默认只看未删除条目，点击“查看已删除条目”查看或恢复删除记录，删除不是清除历史。记忆和技能的详情及编辑器就在所选条目下方展开，可“收起详情”，无需滚动到所有条目之后；关联项目以项目名称、目录和描述显示。

身份设置和文档支持 Ctrl/Cmd+S。切换身份或关闭编辑器会对未保存的设置／文档显示站内确认窗口；选择“继续编辑”或按 Esc 保留草稿。知识条目切换和删除也使用站内确认。网页内切换功能页会保留编辑器草稿，但刷新或关闭浏览器不保存草稿。上述交互不改变档案、文档和知识条目的修订核对规则。

## 新增、更新与重复内容

身份助手新增记忆或技能时，Pivane 先返回相关旧内容供比较，本次不保存。已有事实或流程可跳过；明确补充或纠正先读取完整旧条目并更新，独立新内容才继续新增。这个内部比较无需用户再次确认，服务仍核对身份、目录、参数和修订；不会把新增请求悄悄改成覆盖。

后台学习在原有一次专用辅助模型调用中比较 USER/MEMORY 和现有技能，明确选择跳过、新增、补充、纠正或提出合并方案。补充保留原文并追加新细节，纠正需要用户明确表述；多条合并保留原条目，审核后才应用。个人事实与偏好进入 USER，资料入口与有日期的长期经历进入 MEMORY；后台不会自动改写成品技能，新流程仍只生成待审草稿。相近内容的判断由模型完成，有界候选检索不保证识别所有改写；精确查重和范围／版本核验由 Pivane 保证。具体工具协议与限制见[记忆适配](PROFILE_MEMORY.md#agent-write-time-comparison)。

## 主线程与定时任务

身份创建时不强制生成线程。可从概览的“主线程与定时任务”进入管理，在任务目标中指定已有的同身份线程，或在明确工作目录中创建普通主线程。每身份最多一个主线程引用；已有线程归属与历史不变，删除主线程暂停相关任务而不自动重建。具体调度、模型、静默和预算见[定时任务](SCHEDULED_TASKS.md)。

## 数据与会话归属

私有档案注册表位于 `<Pi agentDir>/pivane-profiles/profiles.json`，档案数据位于 `data/<id>/`。部署或迁移前备份完整 Pi 身份目录。SOUL 保存协作方式，长期记忆保存稳定事实，动态学习进度和知识收藏仍以项目资料为准。

注册表可选 `avatar` 为 null、`{kind:'emoji',value}` 或 `{kind:'image',version}`。图片作为独立的私有 PNG 资产保存，不在注册表嵌入数据或引用外部 URL。可选 `memory.memoryCharLimit`、`memory.userCharLimit` 分别默认 16000 和 8000 字符，允许范围分别为 256..65536 和 256..32768。缩小上限不删除旧数据，旧内容仍可读取并如实显示超限；运行 worker 的旧上限在重新加载前继续生效。

会话归属通过 Pi 原生 `pivane-agent-profile` custom entry 保存，数据为 `{version:1,sessionId,profileId}`，必须匹配实际原生会话ID。缺失、无效、复制的旧ID或当前ID冲突标记不启用档案。网页分叉为新会话显式继承源档案；导入保留原生历史，但不会仅凭复制的旧标记获得档案，导入结果仍为无身份。

扩展助手明确使用无身份；Agent任务线程使用目标项目的新线程默认值，不自动继承来源线程档案。首版临时线程和侧聊不参与档案记忆或自动学习。档案划分是应用的数据归属规则，不是操作系统工具沙箱。

## 记忆组件安装与实例配置

Pivane 随包提供 pi-hermes-memory 0.9.9 的选定组件。`node scripts/install.cjs` 安装依赖并构建当前应用目录的记忆 bundle，正常安装不再需要手动填写 `pivane-profiles/runtime.json`。平台 SQLite 依赖和故障补全步骤见[内置能力包](BUNDLED_CAPABILITIES.md)。

已有 `runtime.json.bundlePath` 保留；可用的内置组件优先，缺少可用内置组件时才按旧校验规则尝试该绝对路径。记忆数据目录不变。旧 `reviewModel` 配置只读兼容，不再供旧的三轮复盘调用。后台学习需要在“设置 → 辅助模型”按纠错、复盘、提取分别指定可用模型，并在档案的学习设置显式开启；保存两类设置本身均不发送模型请求。

服务核对 bundle 和本机 SQLite 后，`/api/pi/status.profileMemory` 说明组件安装，`/api/pi/status.profileLearning` 表示新接口已装配；实际可写状态、专用模型、队列与限额来自相应档案的 `/knowledge` 和 `/learning` 快照。组件安装、内容保存、索引同步、当前 worker 加载与模型实际遵守是不同事实。

仅符合条件的持久会话会获得插件环境参数。无档案会话会清除这些参数。不要再全局启用上游默认扩展，其历史扫描范围不同于这里的档案适配。扩展精选区显示“档案适配已安装”时，表示独立组件已核对，不代表原版插件已全局加载。

## 接口契约

所有接口使用现有工作台身份／Origin校验并返回 `Cache-Control: no-store`。档案保存与默认值变更参与原生设置互斥、维护空闲判断和停机等待；`/api/pi/activity.profilesBusy` 表示保存尚未完成。

| 接口 | 行为 |
|---|---|
| `GET /api/pi/profiles?cwd` | 返回档案、opaque revision、profileRevisions（每个档案自身修订）、规范项目路径和项目默认身份；不传 cwd 时项目和默认值为 null |
| `PUT /api/pi/profiles` | `{expectedRevision,profile:{id?,name,description,soul,enabled,avatar?,memory?,skills?}}`；无ID创建，有ID更新；emoji/null可直接保存，图片只允许保留本档案已上传版本；冲突409 |
| `PUT /api/pi/profiles/default` | `{cwd,profileId,expectedRevision}`；null清除默认，仅允许已启用的档案 |
| `POST /api/pi/sessions` | 原接口增加可选 profileId；省略使用项目默认，显式null创建无身份线程，不可用ID失败而非回退 |
| `GET /api/pi/profiles/:id/knowledge` | `kind=memory|skill`、query、offset、`state=present|deleted|draft|all` 可选（省略 state 保持全部状态）；返回有界条目、近期回执、opaque revision 和真实 operations/limits；pending 的 revision 可为 null，禁止写入 |
| `GET /api/pi/profiles/:id/knowledge/items/:itemId` | 返回受限正文、条目修订与 readOnly/truncated 状态；非本档案 ID 不可读 |
| `POST /api/pi/profiles/:id/knowledge/mutations` | `{requestId,expectedRevision,operation,kind,...}`；按服务器能力创建、更新、删除、恢复和撤销，undo 仅附 `receiptId` 且 kind 取回执；HTTP 不接受客户端伪造的 source/projectKey |
| `GET/PUT /api/pi/profiles/:id/learning` | GET 返回整数 revision、设置、任务与 capabilities.actions/limits；PUT `{expectedRevision,changes}` 只保存学习开关与预算，不启动模型 |
| `POST /api/pi/profiles/:id/learning/actions` | `{requestId,action:'review-now'|'cancel',jobId?}`，按服务端 actions 调用并核对实际作业状态；不确定结果保留 requestId，不自动重放 |
| `GET /api/pi/profiles/:id/memory` | 旧版兼容只读入口：`kind=memories或skills`，可选 query、offset，页面新管理入口使用 `/knowledge` |
| `GET /api/pi/profiles/:id/skills/:skillId` | 仅接受技能列表的不透明ID；详情返回正文、修订和scope/source；无任意路径读取 |
| `GET/PUT /api/pi/profiles/:id/documents` | GET 用 `target=user|memory`；PUT 用 `{target,content,expectedRevision,expectedProfileRevision}` 整篇提交；返回原生原文及 `usage:{used,limit,unit:'characters'}`，冲突409；禁用记忆时 MEMORY 为 disabled。若文档已发布但检索未同步则503携带`documentSaved:true,indexSynced:false`，GET显示待修复；不可盲目重试创建 |
| `POST /api/pi/profiles/:id/avatar` | `{expectedRevision,dataUrl}`，仅最多1 MiB 的受校验 PNG；返回 `{ok,profile,revision}`；保存旧头像直到注册表CAS成功 |
| `GET /api/pi/profiles/:id/avatar?version=hash` | 只返回注册表当前引用的本档案 PNG；无外部 URL |
| `POST /api/pi/profiles/authoring-sessions` | `{cwd?,profileId:null|UUID,language:'zh-CN'|'en',draft?}` 创建原生无身份辅助线程并返回 `{session,prompt}`，不会触发模型请求或保存档案 |
| `GET /api/pi/profiles/authoring-sessions/:id/draft?cwd=` | 返回当前原生分支最后一份经验证草稿；状态 ready/missing，只有用户选择导入后才进入编辑器。以完整原生文件身份和修订核对读取，超过64 MiB明确返回413 |

结果不确定时先刷新核对，不自动重试创建。界面保留编辑草稿和项目默认选择；如果刷新后发现同名记录，需核对保存结果再继续，避免重复创建。

辅助会话创建与档案设置保存共用维护互斥；正在停机或维护时拒绝创建，停机会等待已预占的创建完成。头像私有图片写入与档案注册表修订保存也在同一维护预占和注册表互斥内，冲突不会先发布新图片；已保存头像不会因新上传失败而丢失。

`session.agentProfile` 为 null 或 `{id,name,avatar,enabled,available}`，只描述保存的身份。WebSocket `get_runtime_configuration.agentProfile` 返回 `saved`、`savedProfileRevision`、`loadedProfileId`、`loadedProfileRevision`、`loadedConfirmed`、`matchesSavedProfile`，区分身份相同但SOUL／设置版本已变化的情况。缺少确认时保持未验证。

Supervisor在启动前核对原生会话身份，向符合条件的worker提供不含凭据的 `PIVANE_AGENT_PROFILE_CONTEXT`，包括version、profileId、sessionId、cwd、sessionPath、profileRoot、sessionsRoot和memory／skills开关。扩展再次验证会话归属，并将SOUL追加到Pi现有提示词；原生会话JSONL仍是唯一对话事实来源。

模块与持久化边界见[档案架构](development/AGENT_PROFILES.md)。

## 起草与检索状态

“与 Agent 起草”会创建一个普通的原生持久会话并填入可见草稿；用户发送后才调用所选模型。会话中的“查看档案起草建议”可返回档案页，提案仅在显式导入后进入未保存草稿。页面使用服务端档案修订核对提案，不依赖局域网 HTTP 上可能不可用的浏览器摘要接口。

USER/MEMORY 页面分别显示内容与检索状态。文档保存成功但索引待同步时，使用“同步检索索引”核对并提交服务器当前内容；此操作保留本地未保存草稿，随后仍需核对差异后保存。关闭记忆或未安装适配器时，可以保存 USER，但不会声称内容已进入检索。长期存储的更新不会抹去已有聊天记录，也不代表当前 worker 的提示词快照已重新加载。

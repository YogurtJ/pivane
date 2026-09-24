# 可选助手档案

助手档案用于保存名称、头像、行为说明（SOUL）、记忆和已学习技能设置。Pi Agent 页面新建无身份线程，继续使用原有项目指令、工具和已配置 Skills；助手对话页面从项目栏顶部选择档案，新线程自动使用该档案。一个档案可以用于多个项目，学科或任务方式不必分别创建档案。

本功能属于未发布源码候选。实际实例需完成安装与安全切换；已安装文件、服务支持以及会话已加载是不同状态。

## 使用入口

在助手档案页面左侧选择或新建档案，右侧保持固定的详情区。名称最多80字符，描述500字符，行为说明最多32 KiB UTF-8；最多保存50个档案。图片头像先保存档案后上传：网页转换为受限 PNG 后单独提交，编辑器就地显示上传进度和成功／失败，上传期间不能提交档案设置；普通修改仍需另点“保存身份”。可以使用普通新线程向 Agent 讨论草稿，专用 `profile_draft` 工具只生成提案，不自动保存；回到编辑器后由用户确认导入并显式保存。新档案的记忆和自动学习默认关闭，已学习技能默认允许使用。记忆与技能设置独立，开启记忆不会自动开启学习。

新建按钮旁不再提供身份选择器，临时会话入口在项目菜单中。项目默认身份仍服务于旧版/API省略身份参数的客户端。已有线程的归属不随项目默认变化；要使用另一档案，请进入对应助手区域另建线程。旧会话不会自动绑定档案。

关闭档案保留原有数据，使它不能用于新建或新加载。已运行会话保留其已加载配置，保存不会打断任务。详情页分别核对保存的档案和当前运行实例确认加载的ID、版本；配置已变化时需要空闲后重开运行实例。仅刷新网页可能继续连接原来的 worker；资源重载不能更新进程环境中的设置。

档案的“学习与技能”入口提供该档案记忆与已学习技能的只读浏览，技能可展开查看正文；扩展页只展示精选与原生已安装资源。可对全局 `USER.md`、`MEMORY.md` 显式编辑原生文档（记忆需开启；USER可在新建档案后独立初始化），使用文档和档案双修订避免覆盖 Agent 或其他编辑者的更新。项目记忆、扩展记忆和已学习技能不通过此编辑器修改。保存值不表示当前会话已重新加载。

自动学习只有在服务确认适配组件已安装、并配置专用复盘模型时才能新启用。已有设置为开启但支持暂时失效时，界面保留其保存值并允许关闭，不会声称复盘正在正常执行。费用、频率、检索限额和错误状态见[记忆适配](PROFILE_MEMORY.md)。

## 数据与会话归属

私有档案注册表位于 `<Pi agentDir>/pivane-profiles/profiles.json`，档案数据位于 `data/<id>/`。部署或迁移前备份完整 Pi 身份目录。SOUL 保存协作方式，长期记忆保存稳定事实，动态学习进度和知识收藏仍以项目资料为准。

注册表可选 `avatar` 为 null、`{kind:'emoji',value}` 或 `{kind:'image',version}`。图片作为独立的私有 PNG 资产保存，不在注册表嵌入数据或引用外部 URL。可选 `memory.memoryCharLimit`、`memory.userCharLimit` 分别默认 16000 和 8000 字符，允许范围分别为 256..65536 和 256..32768。缩小上限不删除旧数据，旧内容仍可读取并如实显示超限；运行 worker 的旧上限在重新加载前继续生效。

会话归属通过 Pi 原生 `pivane-agent-profile` custom entry 保存，数据为 `{version:1,sessionId,profileId}`，必须匹配实际原生会话ID。缺失、无效、复制的旧ID或当前ID冲突标记不启用档案。网页分叉为新会话显式继承源档案；导入保留原生历史，但不会仅凭复制的旧标记获得档案，导入结果仍为无身份。

扩展助手明确使用无身份；Agent任务线程使用目标项目的新线程默认值，不自动继承来源线程档案。首版临时线程和侧聊不参与档案记忆或自动学习。档案划分是应用的数据归属规则，不是操作系统工具沙箱。

## 记忆组件安装与实例配置

Pivane 使用独立的 pi-hermes-memory 适配组件。按[安装说明](PROFILE_MEMORY.md)取得已验证版本及原生 SQLite 依赖后，配置实际 Pi 身份目录中的 `pivane-profiles/runtime.json`：

```json
{
  "version": 1,
  "bundlePath": "/absolute/installation/package/profile-memory-bundle.mjs",
  "reviewModel": {
    "provider": "your-provider",
    "modelId": "your-review-model"
  }
}
```

`bundlePath` 为已核对的独立安装 bundle 的绝对路径；`reviewModel` 必须选自当前 Pi 实际模型目录，省略或设置为 null 时不启用自动复盘支持。不要把凭据写入这个文件；模型认证继续由 Pi 管理。此配置只读加载，不通过浏览器接收任意执行文件路径。

服务核对 bundle 和本机 SQLite 后，通过 `/api/pi/status.profileMemory` 返回 `{installed,autoLearn}`。`autoLearn` 表示具备适配支持且已配置模型，不证明模型供应商请求成功；实际调用还会检查模型可用性和预算。配置读取失败不会回退到高价聊天模型。

仅符合条件的持久会话会获得插件环境参数。无档案会话会清除这些参数。不要再全局启用上游默认扩展，其历史扫描范围不同于这里的档案适配。扩展精选区显示“档案适配已安装”时，表示独立组件已核对，不代表原版插件已全局加载。

## 接口契约

所有接口使用现有工作台身份／Origin校验并返回 `Cache-Control: no-store`。档案保存与默认值变更参与原生设置互斥、维护空闲判断和停机等待；`/api/pi/activity.profilesBusy` 表示保存尚未完成。

| 接口 | 行为 |
|---|---|
| `GET /api/pi/profiles?cwd` | 返回档案、opaque revision、profileRevisions（每个档案自身修订）、规范项目路径和项目默认身份；不传 cwd 时项目和默认值为 null |
| `PUT /api/pi/profiles` | `{expectedRevision,profile:{id?,name,description,soul,enabled,avatar?,memory?,skills?}}`；无ID创建，有ID更新；emoji/null可直接保存，图片只允许保留本档案已上传版本；冲突409 |
| `PUT /api/pi/profiles/default` | `{cwd,profileId,expectedRevision}`；null清除默认，仅允许已启用的档案 |
| `POST /api/pi/sessions` | 原接口增加可选 profileId；省略使用项目默认，显式null创建无身份线程，不可用ID失败而非回退 |
| `GET /api/pi/profiles/:id/memory` | `kind=memories或skills`，可选query、offset；只读分页，状态区分missing、disabled、unsupported、ready、error。技能项含scope、source和可选projectKey，不返回正文 |
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

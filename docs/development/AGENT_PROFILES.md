# 助手档案与项目分类

`pi-profile-state.js` 的 `readProfileBinding(manager)` 读取原生 custom entries，只接受唯一且匹配当前原生会话 ID 的档案标记。树导航不改变会话身份；复制的旧 ID 标记不生效，冲突或无效标记使档案能力保持未启用。档案是数据归属规则，不是阻止任意本地代码访问文件的操作系统沙箱。

`pi-profile-registry.js` 拥有档案、兼容项目默认值及修订。名称、头像引用、SOUL、记忆字符上限和技能设置保存在同一私有注册表；图片内容单独保存。读写复用 no-follow 描述符、内核路径、完整身份和前后状态核对；保存使用进程间锁、私密权限、原子替换及目录刷盘。未知持久字段保留。`profiles.reserve()` 在异步工作前预占设置互斥，覆盖档案、项目分类、头像发布、文档编辑和起草会话创建；维护与 disposal 观察同一占用状态。

`pi-session-store.js` 在原生会话暴露前保存身份和分类标记。新建区分省略 profileId 与显式 null；网页 Pi Agent 使用 null，助手对话传入当前档案与分类。服务端专用同步 initializer 仅供受信任的内部创建流程使用，HTTP JSON 不能传入函数。列表与定点查找核对原生文件及解析时修订；worker 仍按唯一规范 sessionPath 管理。列表额外保留最多 32 个 cwd 的可丢弃展示缓存：`pi-session-list-revision.js` 每次重新枚举目录成员，并核对各文件 no-follow 描述符、内核路径、完整身份、类型、大小、mtime/ctime 与前后变化；超过 5,000 个文件或核实失败时不复用缓存。只有原生文件集合、档案和项目修订及服务实例均相同时才复用投影，缓存不参与原生会话恢复。分叉保留原生历史并为新会话 ID 显式重新绑定；导入不会仅凭历史标记激活档案、分类或起草权限。

## 分类与运行配置

`pi-assistant-project-registry.js` 保存独立于 cwd 的逻辑分类。多个分类可以关联同一真实目录，保存各自的名称、附加指令和关联档案；cwd 创建后不可修改。分类不复制文件或会话，也不将原有按档案／真实 cwd 保存的记忆及技能重新分组。

`pi-assistant-project-state.js` 的原生标记包含 `{version,sessionId,projectId,cwd}`；会话投影同时核对实际档案绑定与分类绑定。旧档案会话没有分类标记时保持未分类。分类归档阻止新建归属线程，不改变已有会话或 worker。

`pi-agent-routes.js` 在核对规范会话文件和 ID 后传入档案及分类上下文；`pi-web-session-extension.ts` 注册对应运行扩展。运行扩展重新核对原生标记、已保存配置及修订，并在原生系统提示词后追加 SOUL／分类指令。Supervisor 接收绑定当前会话的加载确认；`get_runtime_configuration` 分别投影保存值、加载 ID／修订及匹配状态。保存成功不意味着已有 worker 已重新加载；普通、临时和侧聊 worker 不继承不适用的私有上下文变量。

## 文档、技能与辅助起草

`profile-memory/extension.ts` 在每次索引、检索、注入、技能发现及写入时校验有效档案与原生会话。环境 JSON 本身不是授权令牌。适配器使用已核对的独立 bundle，按档案和真实 cwd 保存资源；不会全局注册上游默认扩展或扫描其他档案。`background-index.js` 持有每个启用记忆 worker 的历史索引工作线程；`index-worker.js` 串行执行原有来源核实、事务替换和检索，不写原生会话。启动与 settled 只调度可合并的派生工作，搜索等待在途刷新并继续前后核实，退出等待线程关闭；详情见[索引边界](../PROFILE_MEMORY.md#source-index-and-bounds)。

`pi-profile-documents.js` 提供 USER/MEMORY 文档及双修订编辑，使用与 worker 写入相同的变更锁和代次。`profile-memory/document-index.js` 只同步旧／新 Markdown 对应的准确 SQLite 身份，保留不相关的扩展记忆。重复候选或冲突身份拒绝保存。待同步标记保护文件发布与索引间的中断；未发布计划只有在旧内容被验证后才可清除，已发布计划按当前修订修复，未知内容继续拒绝。文件保存、索引状态与失败结果分开返回，不能用 HTTP 超时推断回滚或自动重放修改。

`profile-memory/management.js` 提供只读列表和按不透明 ID 读取的单条技能正文。来源说明表示受控的助手技能库位置，不推断实际作者；正文读取仍执行范围、描述符及预算检查。

`pi-profile-authoring.js` 创建专用的无档案原生会话，`pi-profile-authoring-extension.ts` 仅在当前 ID 的有效起草会话中提供 `profile_draft`。工具只记录提案，不写档案或文档。网页创建后填入可见草稿，用户发送才调用模型；审核提案时核对服务端 `profileRevisions`，导入后仍需显式保存。普通会话、分叉和导入不会继承此工具权限。

网页页面路由、分类视图、档案编辑和扩展列表的职责见[模块导航](MODULES.md)。助手页启动时并行请求逻辑项目和全局项目发现，已关联 cwd 的线程先加载；每个 cwd 的列表只取一次，再按原生归属分类。全局发现完成后，其他目录的未分类线程逐目录补充，失败只报告该读取错误，不清空已就绪的项目；身份/页面代次与请求预占阻止迟到结果串入其他助手。原生历史仍是唯一对话事实来源；头像、分类和索引元数据不能成为另一份聊天历史。接口及限制见[助手档案](../AGENT_PROFILES.md)、[记忆适配](../PROFILE_MEMORY.md)和[API](../API.md)。

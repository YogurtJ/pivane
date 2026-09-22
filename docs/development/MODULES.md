# 模块导航

按任务查阅相关行，再读取对应功能契约。入口文件负责连接模块；状态、持久化和异步互斥由服务或组件本身管理。

| 任务 | 实现入口 | 契约与验证入口 |
|---|---|---|
| HTTP 服务、身份和静态入口 | [server.js](../../server.js)、[workspace-access-service](../../server/workspace-access-service.js) | [访问控制](../ACCESS_CONTROL.md)、workspace-access 用例 |
| 主会话 REST/WS 与服务装配 | [pi-agent-routes](../../server/pi-agent-routes.js) | [API](../API.md)、pi-native-integration、pi-activity-api |
| 已保存的设置与媒体 HTTP 接口 | [settings routes](../../server/routes/settings.js)、[media routes](../../server/routes/media.js) | [模型设置](../PROVIDER_SETTINGS.md)、[媒体实验室](../MEDIA_LAB.md)，对应 HTTP/服务用例 |
| worker 唯一性、启动、停止与回收 | [supervisor](../../server/pi-agent-supervisor.js)、[worker lifecycle](../../server/pi-worker-lifecycle.js)、[RPC](../../server/pi-rpc-client.js) | [运行控制](../NATIVE_CONTROLS.md)、pi-worker-lifecycle、pi-runtime-activity、pi-maintenance |
| 会话身份、列表、分叉和历史导航 | [session store](../../server/pi-session-store.js)、[workflows](../../server/pi-session-workflows.js)、[history navigation](../../server/pi-history-navigation.js) | [会话工作流](../SESSION_WORKFLOWS.md)、[历史](../HISTORY.md)、pi-session-workflows、pi-history、pi-session-tree |
| 项目路径迁移 | [session relocation](../../server/pi-session-relocation.js) | [命名与迁移](NAMING.md)、pi-session-relocation；真实迁移另做停机验证 |
| 任务线程、侧聊和扩展助手 | [agent threads](../../server/pi-agent-threads.js)、[side chat](../../server/pi-side-chat.js)、[extension assistant](../../server/pi-extension-assistant.js) | [任务线程](../AGENT_THREADS.md)、[侧聊](../SIDE_CHAT.md)、[原生设置](../NATIVE_SETTINGS.md) |
| 任务目录与来源结果回执 | [task catalog](../../server/pi-task-catalog.js)、[task returns](../../server/pi-task-returns.js)、[browser results](../../public/pi-task-results.js) | [任务线程](../AGENT_THREADS.md)、pi-task-catalog、pi-task-returns、pi-agent-threads 和对应浏览器用例 |
| Provider、原生配置与资源 | [settings service](../../server/pi-settings-service.js)、[native service](../../server/pi-native-service.js)、[resource service](../../server/pi-resource-service.js) | [模型](../PROVIDER_SETTINGS.md)、[原生设置](../NATIVE_SETTINGS.md)，对应 settings/provider/resource 用例 |
| 文件、搜索与用量 | [file service](../../server/pi-file-service.js)、[session search](../../server/pi-session-search.js)、[usage](../../server/pi-usage-service.js) | [文件](../FILE_VIEWER.md)、[用量](../USAGE.md)，相关 descriptor/search/usage 用例 |
| 媒体模型、规划、票据与执行 | [media lab](../../server/media-lab-service.js)、[provider service](../../server/media-provider-service.js)、[HTTP protocol](../../server/media-http-protocol.js) | [接入协议](../MEDIA_CONNECTIONS.md)、media-connections、media-lab、reply-tts |
| 安装、更新、备份和恢复 | [managed launcher](../../server/pi-managed-launcher.js)、[update installer](../../server/pi-update-installer.js)、[maintenance files](../../server/pi-maintenance-files.js) | [更新](../UPDATES.md)、[发布](RELEASING.md)、pi-maintenance、pi-application-update、test/release |
| 前端线程选择、连接和状态协调 | [pi-chat](../../public/pi-chat.js) | [API](../API.md)、test/browser 中 onboarding、sidebar、live、controls 场景 |
| 正文、滚动、工具和文件展示 | [transcript view](../../public/pi-transcript-view.js)、[scroll](../../public/pi-transcript-scroll.js)、[tool labels](../../public/pi-tool-labels.js)、[file viewer](../../public/pi-file-viewer.js) | 对应 transcript、turn-edits、file-viewer、extension-assistant 浏览器场景 |
| 旧命名兼容与启动配置 | [pivane compat](../../server/pivane-compat.js)、[local env](../../server/pi-local-env.js) | [命名与迁移](NAMING.md)、pivane-compat、media-connections |
| 检查与发行文件发现 | [source files](../../scripts/source-files.cjs) | [开发流程](WORKFLOW.md)、source-files、public-documentation |

## 新增功能时的检查点

- 谁拥有数据和状态？复用原生事实或现有配置服务，避免在路由和前端另存一份业务状态。
- 谁负责超时后的不确定结果？不能用浏览器断线、Promise 超时或 agent_end 推断整项操作已结束。
- 是否影响 worker 空闲、回收或停机？由 worker 生命周期与相关服务给出状态，避免在路由复制字段列表。
- 是否引入新文件类型、目录、脚本入口或配置名称？同步源码发现、访问清单、兼容层和相应文档。
- 哪一个有代表性的行为测试能发现回归？先覆盖正常行为和关键失败边界，避免仅断言源码中存在某段字符串。

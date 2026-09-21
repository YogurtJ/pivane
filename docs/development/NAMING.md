# Pivane 命名与迁移

## 名称的责任

产品显示名为 **Pivane**，应用目录、仓库、服务和新工作台标识使用 `pivane`。Pi Coding Agent、其包名、原生 SessionManager、JSONL 格式和原生环境变量属于上游接口，继续使用 Pi 的真实名称。`pi-*.js` 中负责 Pi 适配的模块名称不表示产品仍叫旧名称。

新写入的工作台 custom entry、内部桥接、工具来源元数据和本地媒体包采用 Pivane 名称。`server/pivane-compat.js` 集中识别旧 `pi5-*` 会话标记和私有桥接响应；前端展示兼容旧工具来源和任务回执。迟到或未知的旧私有响应同样截获，不能因改名进入浏览器或模型正文。

既有 REST/RPC 路径和浏览器 `pi.web.*` 偏好键仍是兼容接口。需要改变时作为独立协议迁移处理；产品改名不要求用户清空浏览器设置。

## 配置名称

新建实例默认采用 `pivane-workspace.json`、`pivane-access.json`、`pivane-notifications.json` 和 `pivane-deferred-messages*.json`。如果同一位置已经存在旧 `pi5-*` 文件，继续使用旧文件，不在读取时复制或迁移。两套名称同时存在时拒绝猜测，先备份并明确哪一份有效。

旧访问配置保留其 Cookie 身份。若人工改动访问配置的实际文件名或位置，浏览器可能需要重新验证；不能只改文件名就宣称登录状态也已迁移。配置文件迁移与项目会话迁移分别核对。

媒体凭据的新保存使用 `pivane-media:` 命名；旧 `pi5-media:` 凭据继续通过原生 ModelRuntime 读取。新凭据优先，状态按逻辑 Provider 去重；移除时经原生 logout 清理两种名称。读取不改写 auth.json，不复制凭据来制造另一套认证存储。

以下 Pivane 启动配置支持 `PIVANE_` 前缀；同后缀的 `PI_` 旧名称继续有效：

| 用途 | 后缀 |
|---|---|
| 项目与访问 | `PROJECT_ROOTS`、`ALLOWED_ORIGINS`、`WEB_TOKEN`、`WEB_SECURE_COOKIE` |
| worker 与项目资源 | `WEB_IDLE_MS`、`WEB_APPROVE_PROJECTS`、`WEB_CLI` |
| 实例数据与媒体 | `WEB_DEFERRED_FILE`、`MEDIA_CONFIG_DIR`、`MEDIA_DATA_DIR`、`MEDIA_PROFILE`、`MEDIA_PLANNER_MODEL` |
| 实例 URL 与独立媒体 CLI | `WORKSPACE_BASE_URL`、`WORKSPACE_ACCESS_TOKEN` |

由标准启动入口加载 `.env` 时解析这些别名，再向既有适配边界传递对应配置。继承环境优先于 `.env` 中任一拼写；同一来源同时提供冲突的非空值时拒绝启动，错误仅列变量名。`PIVANE_MEDIA_PROFILE=clean` 与旧 clean 模式一样跳过本地 `.env`。

`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`、`PI_OFFLINE`、`PI_TELEMETRY` 等原生变量保持原名。直接使用内部服务模块的调用者应先完成环境规范化。独立媒体 Package 同样接受 `PIVANE_WORKSPACE_BASE_URL` / `PIVANE_WORKSPACE_ACCESS_TOKEN`，旧 `PI_WORKSPACE_*` 环境仍有效，冲突的双拼写会拒绝使用。

## 项目目录改名

目录改名涉及源码 Git 工作区、服务启动路径、运行版本位置、Package 路径、项目信任、项目偏好、预约以及原生会话，不能用一次目录移动代替完整迁移。

原生会话通常位于 Pi 身份目录的 `sessions/--编码后的项目路径--/`，不在项目源码目录。以实际原生 header ID 和文件路径识别会话；文件名中的 ID 可能不同。`cwdOverride` 只影响运行对象，`forkFrom` 会产生新的 header 时间与父关系，都不能直接等同于保留身份的目录迁移。

`server/pi-session-relocation.js` 提供维护代码使用的离线会话迁移函数，不是 HTTP 接口，也不自动移动安装目录。调用方负责确认独立 Pi CLI 和其他写入者已经停止，并处理其余路径引用。它会：

1. 取得与受管启动器相同的安装锁，拒绝已有目标目录、路径编码碰撞、非普通文件和不支持的会话格式。
2. 检查其他项目是否引用将被迁移的父会话；有交叉引用时拒绝部分迁移，要求扩展迁移范围。
3. 使用已有描述符/身份/预算边界备份原始文件，在私有目录准备新文件。仅支持完整 v3 会话；修改头部 cwd 和范围内的 parentSession 路径，保留 header ID、时间和其他字段。
4. 头部之后的全部字节保持一致。通过原生内存 SessionManager 核对 entries、活动分支、leaf、书签、名称和上下文；以树连接关系验证深长会话，避免递归溢出。
5. 重新核对源文件与文件清单，再发布新会话目录。完整原件保存在身份目录中、会话发现范围之外；写入带哈希与映射的结果记录。在能处理异常时恢复原目录，不报告成功；进程中断时须根据 plan、备份及两处目录核对后恢复，不能自动重放。

历史消息、工具参数、系统提示词记录和摘要中的旧路径保留原文。后续 runtime 从新项目加载资源并产生正常的新检查点。历史引用需要可达时，可保留经过核对的旧项目路径别名；别名不是第二个源码工作区。

这是同一机器上的受控目录迁移，不是任意跨平台、跨身份或跨文件系统的恢复器。会话检查通过后，还要验证项目列表、继续会话、分支/书签、任务回执、项目偏好和维护入口。当前执行所依赖的服务应在本轮结束后从独立维护通道切换，不能中断自身来完成改名。

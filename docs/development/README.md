# Pivane 开发文档

这些文档随源码版本管理，保存可复用的设计、契约和流程。机器地址、当前部署、有效授权和验证日志属于私有维护资料，源码入口通过可选的 `AGENTS.local.md` 指向本机资料。

## 新线程的阅读路径

1. 读根目录 [AGENTS.md](../../AGENTS.md) 与 [贡献指南](../../CONTRIBUTING.md)，确认任务范围和已有改动；本机入口存在时按 `AGENTS.local.md` 找到维护仓。
2. 在 [模块导航](MODULES.md) 选择本次任务的职责组，只读对应实现、功能契约和测试；需要理解跨模块数据流时查 [架构](ARCHITECTURE.md)。
3. 用 [开发流程](WORKFLOW.md#验证矩阵) 确定验证范围。涉及本机运行状态时查维护仓与实际实例；涉及公开发行时查 [发布流程](RELEASING.md)。

源码行为、实际部署、公开发行是三个独立状态。版本与依赖分别查当前树的 `package.json` / `package-lock.json`、运行实例状态和正式 Release；历史验收与旧计划只证明其记录时的范围。

## 按任务查找

| 需要了解什么 | 入口 |
|---|---|
| 一类功能应该修改哪里、相关契约在哪 | [模块导航](MODULES.md) |
| 系统边界、数据流、设计取舍与已知技术债 | [架构](ARCHITECTURE.md) |
| 模块协作、具体生命周期、缓存与失败边界 | [运行与界面实现细节](RUNTIME.md) |
| 开发步骤、验证范围、文档责任 | [开发流程](WORKFLOW.md) |
| 助手身份、分类与档案记忆的实现边界 | [助手档案实现](AGENT_PROFILES.md) |
| Pivane 名称、旧版本兼容、项目迁移 | [命名与迁移](NAMING.md) |
| Pi/第三方依赖、公开 API 和升级验证 | [依赖与上游适配](DEPENDENCIES.md) |
| 候选包、发布与恢复演练 | [发布流程](RELEASING.md) |
| 字段和协议 | [API](../API.md)、对应功能文档（索引见 [文档目录](../README.md)） |
| 平台原生组件 | [native](../../native/README.md) |

用户可见行为以功能文档为准；实现细节以本目录为准；两者都不记录某台机器的部署状态。文档与实现不一致时核对对应源码和测试，修正文档；现有约束的调整按 [约定的修改](WORKFLOW.md#约定的修改) 处理。

## 仓库地图

| 路径 | 查找内容 |
|---|---|
| `server.js`、`server/` | 启动装配、HTTP/WS、原生会话与 worker、配置和持久化服务 |
| `public/` | 网页入口、页面组件、样式、国际化和渲染 |
| `scripts/` | 安装、验证、发行与迁移入口 |
| `test/`、`test/browser/`、`test/release/` | Node 行为测试、浏览器脚本、准确归档验收 |
| `native/` | 平台文件身份组件、二进制与 manifest |
| `pi-packages/`、`vendor/manifest.json` | 本项目能力包与明确登记的上游发布内容 |
| `docs/`、`docs/development/`、`docs/releases/` | 功能契约、开发设计、历史版本说明 |

精确文件位置以 [模块导航](MODULES.md) 为索引；源码与发行文件发现由 `scripts/source-files.cjs` 统一管理。资料归属与合并/归档原则见 [文档责任](WORKFLOW.md#文档责任)。

## 验证入口

统一的 [验证矩阵](WORKFLOW.md#验证矩阵) 区分本机部署（只跑相关测试）和公开发布（全量与准确包验收）；[结果复用](WORKFLOW.md#验证结果复用与失效) 定义证据和失效条件；[Node 测试入口](WORKFLOW.md#node-测试入口与计时) 提供定向运行、清单与耗时报告。

Node 用例递归发现 `test/` 下的 `.test.js`；浏览器回归位于 `test/browser/`（`npm run test:browser`），归档演练位于 `test/release/`，两者不由 `npm test` 执行。依赖、手动脚本和隔离要求见 [浏览器与重型专项](WORKFLOW.md#浏览器与重型专项)。

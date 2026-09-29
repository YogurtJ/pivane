# Pivane 开发文档

这些文档随源码版本管理，保存可复用的设计和流程。机器地址、当前部署、有效授权和完整验证日志放在私有维护资料中；源码入口通过可选的 `AGENTS.local.md` 指向本机资料。

| 需要了解什么 | 入口 |
|---|---|
| 系统边界、数据和运行过程 | [架构](ARCHITECTURE.md) |
| 一类功能应该修改哪里 | [模块导航](MODULES.md) |
| 开发步骤、验证范围、文档责任 | [开发流程](WORKFLOW.md) |
| Pivane 名称、旧版本兼容、项目迁移 | [命名与迁移](NAMING.md) |
| 当前结构的检查结论和后续关注点 | [架构检查记录](REVIEW.md) |
| Pi/第三方依赖、公开 API 和升级验证 | [依赖与上游适配](DEPENDENCIES.md) |
| 候选包、发布与恢复演练 | [发布流程](RELEASING.md) |
| 通用参与方式 | [贡献指南](../../CONTRIBUTING.md)、[源码 Agent 入口](../../AGENTS.md) |
| 字段和协议 | [API](../API.md)、对应功能文档 |
| 平台原生组件 | [native](../../native/README.md) |

## 验证入口

统一的 [验证矩阵](WORKFLOW.md#验证矩阵) 定义日常迭代、源码交付和正式发行所需检查；[Node 测试入口](WORKFLOW.md#node-测试入口与计时) 提供定向运行、清单与耗时报告。

Node 用例递归发现 `test/` 下的 `.test.js`；浏览器专项位于 `test/browser/`，归档演练位于 `test/release/`，两者不由 `npm test` 执行。运行前按 [浏览器与重型专项](WORKFLOW.md#浏览器与重型专项) 核对依赖、URL 和隔离身份，不能把测试默认地址当成可安全操作的实例。

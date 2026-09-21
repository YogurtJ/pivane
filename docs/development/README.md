# Pivane 开发文档

这些文档随源码版本管理，保存可复用的设计和流程。机器地址、当前部署、有效授权和完整验证日志放在私有维护资料中；源码入口通过可选的 `AGENTS.local.md` 指向本机资料。

| 需要了解什么 | 入口 |
|---|---|
| 系统边界、数据和运行过程 | [架构](ARCHITECTURE.md) |
| 一类功能应该修改哪里 | [模块导航](MODULES.md) |
| 开发步骤、验证范围、文档责任 | [开发流程](WORKFLOW.md) |
| Pivane 名称、旧版本兼容、项目迁移 | [命名与迁移](NAMING.md) |
| 当前结构的检查结论和后续关注点 | [架构检查记录](REVIEW.md) |
| 候选包、发布与恢复演练 | [发布流程](RELEASING.md) |
| 通用参与方式 | [贡献指南](../../CONTRIBUTING.md)、[源码 Agent 入口](../../AGENTS.md) |
| 字段和协议 | [API](../API.md)、对应功能文档 |
| 平台原生组件 | [native](../../native/README.md) |

## 验证入口

```bash
npm test
npm run check
npm run check:docs
npm audit --omit=dev
npm run pack:trial
```

Node 用例递归发现 `test/` 下的 `.test.js`；浏览器专项位于 `test/browser/`，真实归档演练位于 `test/release/`。专项脚本支持的 URL、CHROMIUM_PATH 和 PLAYWRIGHT_MODULE 以该脚本为准，不能把测试默认地址当成用户部署地址。

测试必须使用独立身份、合成服务与哨兵保护。日常迭代、源码交付和正式发行需要的检查范围见 [验证矩阵](WORKFLOW.md#验证矩阵)。

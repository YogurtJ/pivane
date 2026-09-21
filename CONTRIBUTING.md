# 参与 Pivane 开发

从 [源码 Agent 入口](AGENTS.md)、[模块导航](docs/development/MODULES.md) 和 [开发流程](docs/development/WORKFLOW.md) 找到本次任务的实现、契约与验证入口。整体数据边界见 [架构](docs/development/ARCHITECTURE.md)。

## 源码与实例

在一个正式 Git 工作区开发，沿用项目提交历史；使用分支组织功能与重构，用标签和 Release 标记发行版本。发布包从明确的源码提交构建。开发源码、实际运行版本与公开 Release 分别核对，源码提交不会自动改变运行实例或推送到 GitHub。

公开源码仓库包含应用代码、测试、用户指南和可复用的开发契约。实例地址、有效维护授权、临时交接和完整验证结果放在独立私有维护仓库；本地可选 `AGENTS.local.md` 只保留简短入口。也兼容已有被忽略的 `docs/local/` 布局。私有资料不是用户安装前提，不纳入公开链接或发行包；凭据、会话正文、媒体和原始备份不进入维护 Git 仓库。

## 开发环境

使用锁定依赖和受支持的 Node 版本，运行 `npm ci`。普通安装基线推荐 Node 22.x；运行与验证时记录实际版本，不能把另一版本的结果当作本机验收。

测试实例使用独立的 Agent、媒体、预约、项目路径与实例 URL。只换端口不能隔离身份；不继承真实供应商认证。完整 Node 测试入口会去掉供应商环境凭据和 Pivane 实例别名变量，再串行执行所有被发现的测试。

```bash
npm test
npm run check
npm run check:docs
npm audit --omit=dev
npm run pack:trial
```

日常迭代可以先跑相关用例，交付和发布要求见 [验证矩阵](docs/development/WORKFLOW.md#验证矩阵)。UI 使用独立 Chromium/Playwright 桌面与手机回归；平台组件变更须在目标系统验证，浏览器模拟或容器不能代替原生实机验收。

## 提交与文档

保持一个改动批次可解释、可回退。先确认跟踪清单，再显式暂存所需文件；不要把运行目录、私有记录或用户数据纳入提交。跨源码与私有维护仓库的任务，在本地交接记录关联各自提交。

每类信息有一个主要维护位置：使用方式在用户指南，字段和错误在 API/功能契约，模块责任和设计理由在开发文档，当前实例事实在私有维护仓库。其他入口使用链接，避免复制整段说明。新增公开文档登记到 `docs/public-files.json`；文档检查验证覆盖、链接和私有路径，事实是否符合代码仍需人工审查。

版本与归档要求见 [发布流程](docs/development/RELEASING.md)，命名和旧版本兼容见 [命名与迁移](docs/development/NAMING.md)。

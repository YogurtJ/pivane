# 参与 Pivane 开发

源码修改约定见 [AGENTS.md](AGENTS.md)。公开文档有两类：`docs/`面向使用者、运维者与其Agent；`docs/development/`保存可复用的架构和开发流程，两者都应随代码版本管理。

机器地址、当前部署状态、临时交接与完整日志放在被忽略的`docs/local/`、`AGENTS.local.md`或`backups/`。这些目录不进入候选包。不要将所有开发文档忽略：未来贡献者和用户的Agent需要准确的安全约束与接口契约。

## 本地开发

使用Node22.x和锁定依赖，运行`npm ci`。单独配置PI_CODING_AGENT_DIR、PI_MEDIA_DATA_DIR、PI_WEB_DEFERRED_FILE、PI_PROJECT_ROOTS与PI_WORKSPACE_BASE_URL；只改端口不能隔离身份。不要从携带真实Provider/GPU认证的环境跑空身份测试。

```bash
npm test
npm run check
npm run check:docs
npm audit --omit=dev
npm run pack:trial
```

UI变更还需系统Chromium/Playwright桌面和手机回归，含pageerror、内部宽度、动态抽屉/工具/附件；测试只用合成数据与独立实例。平台修改要在实际原生系统验证；不将容器或浏览器模拟称为目标系统验收。

## 文档维护

- 用户可见变化更新用户指南与CHANGELOG。
- 协议和限制更新API及相关功能契约。
- 架构/原生组件变更更新development和native文档。
- `docs/public-files.json`明确列出公开文档；新增文件须分类并加入清单，`check:docs`检查文档覆盖、相对链接和被排除路径。
- 不让公开文档链接到只存在于维护机器的记录，不把临时waiting状态写成已启用。

发布准备与具体平台范围见 [开发文档](docs/development/README.md) 和 [平台验证范围](docs/RELEASE_INSTALL_VALIDATION.md)。

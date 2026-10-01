# Pivane 内置能力包

当前源码 **1.4.0 候选锁定 Pi 0.99.1**，随应用交付 **pi-subagents 0.71.0** 和 **pi-hermes-memory 0.9.9**。版本由 Pivane 验证后统一更新；不改变已经发布的旧归档。

## 安装与配置

在当前源码或包含内置组件的新归档目录运行 `node scripts/install.cjs`（仅生产依赖可加 `--omit=dev`），即可安装锁定依赖、准备 esbuild、校验上游文件、构建档案记忆 bundle，并检查当前 Node 的 SQLite FTS5/trigram 支持。两个上游包已经在归档的 `vendor/` 中，不再单独安装到 Pi 身份目录。vendor 不作为 npm workspace 安装：执行所需依赖由应用根 lockfile 锁定，不安装上游开发依赖及旧 Pi 副本。安装失败会明确返回非零退出码，不能当作组件已就绪。此前已发布且没有该脚本的归档仍按其原安装说明使用 `npm ci`。

记忆依赖 `better-sqlite3@13.0.3` 随 npm 包提供的原生二进制。在 Windows、macOS 和 Linux 的受支持目标上优先使用这些文件。普通 `npm ci` 的生命周期推断可能忽略该包的 `gypfile:false`，无谓调用 node-gyp；统一安装入口使用 `npm ci --ignore-scripts` 后显式准备所需组件，因此不会为已有可用二进制的 Windows 安装要求 Visual Studio C++。不修改第三方文件。切换 Node 或平台后重新安装依赖，不复制其他平台的 `node_modules`。

手动使用 `npm ci --ignore-scripts` 后，需依次运行：

```sh
npm rebuild esbuild --foreground-scripts
node scripts/install-bundled-capabilities.cjs
```

没有可用 SQLite 二进制的目标会在就绪检查时明确失败；若要自行支持该目标，需准备 Python 与该平台的 C/C++ 工具链，并执行上游的 `npm --prefix node_modules/better-sqlite3 run build-release`，再重新运行内置组件准备。应用更新和 Pi 受管更新也执行上述组件准备，再进行隔离探测。旧 `PI_SKIP_DEFAULT_CAPABILITIES` 和身份中的安装尝试记录不控制内置组件；`PI_OFFLINE` 不代替 npm 的依赖准备。

- 子 Agent 默认可用，模型与角色覆盖继续保存在原生 `settings.json` 的 `subagents` 字段。安装和保存设置不启动子任务。扩展页可以逐项启用、停用内置扩展、技能和提示词；开关保存为 `pivaneBuiltins.subagents` 的资源过滤，不写入版本目录绝对路径。
- 档案记忆默认使用当前应用目录的 `server/profile-memory/upstream-bundle.mjs`。仍需在相应助手身份启用记忆或学习技能；后台学习模型和开关沿用原规则。无身份和临时会话不会因此获得记忆工具。
- Packages 中的内置子 Agent 显示 Pivane 与版本，不提供独立更新或移除。内置包的安装、更新、移除 API 请求返回管理说明。升级整个 Pivane 才会切换组件版本。

## 旧安装兼容

原有 npm、Git 和可识别的本地同名包声明及文件保留，CLI 继续使用自己的安装。Pivane 在加载前将子 Agent 来源映射到内置版本，并保留资源过滤和全局／受信项目优先级；旧上游记忆默认扩展不加载。子 Agent 的后台与前台子会话也使用这套资源选择规则。父会话和子任务都不会因为两个来源同时存在而重复执行旧包工厂。

原来的 `pivane-profiles/runtime.json` 不重写。可用的内置记忆 bundle 优先；没有可用内置 bundle 时，仍按旧校验规则尝试已配置的独立 bundle。数据继续位于原 Pi 身份的 `pivane-profiles/data/`，原生 JSONL 仍是会话事实来源。旧的独立安装目录可以保留作回退，本次安装不删除它。

已打开的 worker 继续运行原先代码；在任务完成后重开运行实例，才能核对新版本。恢复旧应用版本前，核对记忆数据库兼容性；不能用代码回退替代数据备份与迁移验证。

## 上游与适配边界

`vendor/manifest.json` 记录官方 npm 发布包 URL、版本、SHA256、许可证以及逐文件 SHA256。子 Agent 官方发布包为编译后的 JavaScript、声明、source map、文档和资源；记忆包含 TypeScript 源码。目录内容保持发布包原样。`scripts/vendor-files.cjs` 校验字节和普通文件身份，发行和受管源码快照均使用同一清单；不会递归收集 vendor 下的依赖、缓存或用户文件。

`server/pi-bundled-capabilities.js` 是 Pivane 的接入清单；`pi-bundled-resources.js` 在内存中生成受管资源视图；`pi-managed-runtime.mjs` 使用 Pi 的公开 SDK 与原生 RPC，保留 Supervisor 的唯一 worker 和原生身份。资源重载复用同一个原生 ResourceLoader 及其缓存清理生命周期。RPC 的会话和工具接口使用公开 SDK；代理与 HTTP 空闲超时初始化复用当前 Pi 的 `dist/core/http-dispatcher.js`，这一 CLI 初始化接口也需随 Pi 升级复核。

`pi-bundled-subagents.mjs` 和 `pi-subagent-child-factory.mjs` 对接上游 0.71.0 的 child-session factory 注入接口。该接口当前位于上游内部模块，版本升级时必须重新检查；Pivane 替换子会话 SDK 资源加载器，并用 Node 同步模块 hook 对上游单个旧 MCP 解析模块进行精确 import 映射，转向已连接的 Pi 原生工具目录；主线程和 detached runner 使用同一映射。子任务工具钩子同时约束嵌套调用。上游继续拥有任务分配、会话存储、控制、通知和结束清理。原生 MCP 配置／名称 helper 的内部路径同样绑定 Pi 0.99.1 复核，详见[原生 MCP](MCP.md)。没有修改上游文件或 `node_modules`。

记忆适配继续只导出选定的存储、检索和工具组件，禁止调用上游默认 factory；生成 bundle 必须匹配已审查 SHA256，所有上游许可证随包保留。

## 维护更新

1. 下载精确的官方发布包，核对来源与完整性；在独立目录导入原始文件，更新逐文件清单，保留许可证。
2. 审查上游差异、Pi 协议、child-session factory 接口和数据库结构；只在 Pivane 适配层调整。
3. 更新接入清单、锁定依赖与 bundle 校验值，验证干净安装、旧声明过滤、资源重载、前后台子任务、记忆读写／检索／隔离及数据恢复。
4. 完成 Node、语法、文档、生产依赖审计、打包和相关桌面／手机回归，从准确归档执行独立安装；目标平台范围单独记录。
5. 随 Pivane 发布，保留上一版本及数据备份。未来包可加入接入清单，但需明确采用原生包加载还是组件适配，不自动加载所有 vendor 内容。

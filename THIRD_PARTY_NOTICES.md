# 第三方软件与资源

Pivane自身的代码使用[ISC许可证](LICENSE)。第三方软件、字体、图标及其原有版权声明继续适用各自许可证，不因Pivane改名或发行而改变。

## 随源码包直接分发的资源

| 资源 | 版本 | 许可证与随包文件 |
|---|---|---|
| Mermaid | 11.17.2 | MIT；[许可证](public/vendor/mermaid-LICENSE.txt) |
| KaTeX及字体 | 0.18.7 | MIT；[许可证](public/vendor/katex-0.18.7/LICENSE) |
| Font Awesome Free | 6.4.0 | 图标CC BY 4.0、字体SIL OFL 1.1、代码MIT；[完整声明](public/brand/fontawesome-6.4.0/LICENSE.txt) |

保留库文件中的嵌入版权/许可注释。Pivane蓝色π星光品牌资源随本项目分发，不属于Font Awesome图标。

## 通过npm安装的直接依赖

发布归档不包含node_modules。npm ci按package-lock.json取得以下依赖及其传递依赖，安装目录保留各自的许可证。下表列出本候选版本直接依赖的声明，不把传递依赖归为同一种许可。

| 依赖 | 版本 | 声明的许可证 |
|---|---|---|
| @earendil-works/pi-ai、pi-coding-agent、pi-server、pi-tui、pi-agent-core（及原生 pi-mcp / pi-codemode） | 0.99.1 | MIT |
| @highlightjs/cdn-assets | 11.11.1 | BSD-3-Clause |
| cors | 2.8.6 | MIT |
| dompurify | 3.4.16 | MPL-2.0 OR Apache-2.0 |
| express | 5.2.1 | MIT |
| https-proxy-agent | 7.0.6 | MIT |
| marked | 18.0.11 | MIT |
| node-fetch | 2.7.0 | MIT |
| web-push | 3.6.7 | MPL-2.0 |
| ws | 8.21.3 | MIT |

网页从安装的依赖提供marked、DOMPurify和highlight.js资源，未将其许可证改为ISC。另行制作包含node_modules的二进制分发包、容器镜像或安装器时，应保留该分发内容的完整第三方许可和必要声明。

## 内置第三方能力

[pi-subagents](https://github.com/nicobailon/pi-subagents) 0.71.0（Nico Bailon，MIT）官方 npm 发布内容原样保存于 `vendor/pi-subagents/`，包含 JavaScript、声明、source map、角色、技能、提示词和文档；原始 LICENSE 随包保留。Pivane 的安装与运行适配独立于上游文件，版本随应用更新。

## 可选档案记忆组件

[pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory) 0.9.9 使用 MIT 许可证。官方 npm 发布源码原样保存于 `vendor/pi-hermes-memory/`，原始 LICENSE 随包保留；Pivane 从选定组件生成档案记忆 bundle，不加载其默认扩展。`vendor/manifest.json` 记录两个包的来源、版本和逐文件哈希；运行依赖的许可证由 npm 安装保留，版本图由根 lockfile 锁定。安装、SQLite 平台要求和维护边界见[内置能力包](docs/BUNDLED_CAPABILITIES.md)与[档案记忆适配](docs/PROFILE_MEMORY.md)。

## 平台与外部服务

随包macOS/Windows原生文件系统组件为项目自有代码，使用ISC；构建输入及哈希记录在native目录。Node.js、操作系统、Bash、ripgrep与浏览器由用户另行安装，不随本源码包分发。

模型权重、GPU服务和用户的供应商账户不包含在发布包内，其许可及服务条款由相应提供者规定。可选在线字体由浏览器从Google Fonts加载，访问失败时使用系统字体。

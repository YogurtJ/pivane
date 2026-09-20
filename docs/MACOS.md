# macOS 原生安装与运行

当前已在 **Apple Silicon M2、macOS 26.5.1、Node 22.23.2、Google Chrome** 完成原生基线验收。其他平台见[验证范围](RELEASE_INSTALL_VALIDATION.md)。Intel切片虽已编译，尚不等同于Intel硬件验收。Safari/Finder系统剪贴板及真实媒体服务分别保留实际设备/账户验证。

## 安装前提

当前源码的 `npm ci` 默认尝试安装可选 pi-subagents，下载失败不影响 Pivane。独立身份必须在安装前设置 `PI_CODING_AGENT_DIR`；跳过、已有插件与补装规则见[默认可选能力](INSTALL_RECOVERY.md#默认可选能力)。

- Node 22.x、npm、系统ripgrep。可以保留已有其他版本Node，为本实例指定独立Node22。
- 安装包必须包含`native/pi-darwin-fd.node`、对应C源码与manifest；它们为同一批构建。正常安装不需要Xcode、Python或现场编译。缺失或不匹配时不启用全文/搜索/统计，不回退为较弱的路径检查。
- 本轮实测使用独立Node22官方Darwin ARM64归档，并用官方SHASUMS256核对；没有替换原全局Node。也可通过自己的Node版本管理器或Homebrew提供Node22，启动前用`node --version`核对。
- 若缺少rg，可用`brew install ripgrep`；不要因系统已装Node25而认为该版本已在本项目验收。

## 安装前先核对当前 Node

在将要安装和启动的同一终端运行：

```sh
node --version
node -p 'process.execPath'
npm --version
rg --version
```

若使用已安装并加载的 nvm，可执行 `nvm install 22 && nvm use 22`，成功后重新核对上述结果。切换失败先处理错误，不继续安装；无需修改系统默认 Node。下面的安装命令链会在 Node 不为22.x或任一步失败时停止，防止切换失败后仍用旧 Node 安装。这是按推荐基线安装的检查，不代表所有其他版本均不兼容。

## 新安装示例（复用 Pi 身份）

先将发布包和同名.sha256下载到Downloads，并核对下载来源。以下为新实例示例，BASE必须尚不存在：

```sh
ARCHIVE="$HOME/Downloads/pivane-1.0.0-rc.3.tar.gz"
(cd "$(dirname "$ARCHIVE")" && shasum -a 256 -c "$(basename "$ARCHIVE").sha256")
BASE="$HOME/pivane"
test ! -e "$BASE" || { echo "此目录已存在，请按更新流程操作或选择新的BASE"; exit 1; }
umask 077
mkdir -p "$BASE/releases/1.0.0-rc.3" "$BASE/data/media" "$BASE/projects/demo" "$BASE/backups"
tar -xzf "$ARCHIVE" -C "$BASE/releases/1.0.0-rc.3" --strip-components=1 &&
cd "$BASE/releases/1.0.0-rc.3" &&
node -e 'if (process.versions.node.split(".")[0] !== "22") { console.error("请先切换到 Node 22.x；当前 " + process.version); process.exit(1); } console.log(process.version, process.execPath)' &&
npm --version &&
rg --version &&
npm ci
```

先确认校验结果成功，再解包；`npm ci` 成功后，取得当前用户实际 Pi 目录：

```sh
AGENT_DIR=$(node scripts/pi-agent-dir.cjs) || exit 1
printf 'Pi identity: %s\n' "$AGENT_DIR"
```

命令只报告路径，优先读取 `PI_CODING_AGENT_DIR`，未设置时使用 Pi 原生主目录规则，macOS 通常为 `/Users/<用户>/.pi/agent`。已有目录直接复用，没有目录则由 Pi 启动初始化；不要求重新登录或复制认证。请在原 CLI 的配置环境运行，alias/服务覆盖、环境变量认证及共享范围见[已有 Pi 接入](PI_CLI.md)。仅需隔离身份时，显式改用 `AGENT_DIR="$BASE/data/agent"`。

创建固定的实例配置。这里使用终端heredoc展开BASE，写入的是真实绝对路径；.env读取器本身不展开变量：

```sh
cat > "$BASE/instance.env" <<EOF
PORT=3001
HOST=127.0.0.1
PI_WORKSPACE_BASE_URL=http://127.0.0.1:3001
PI_CODING_AGENT_DIR=$AGENT_DIR
PI_MEDIA_CONFIG_DIR=$BASE/data/media-lab
PI_MEDIA_DATA_DIR=$BASE/data/media
PI_WEB_DEFERRED_FILE=$BASE/data/pi5-deferred-messages.json
PI_PROJECT_ROOTS=/
EOF
chmod 600 "$BASE/instance.env"
cp "$BASE/instance.env" .env
env -i PATH="$PATH" HOME="$HOME" USER="$USER" LANG=en_US.UTF-8 npm start
```

最小启动环境保留配置中明确选定的 Pi 身份，但不会继承终端中的 Provider Key、代理或 NODE_OPTIONS。若认证依赖环境变量或外部命令，需向本实例显式提供相同依赖，或通过网页原生登录保存认证；不要输出 Key。以后在同一release目录使用相同启动方式，关闭终端后再启动不需要重复npm ci。

打开`http://127.0.0.1:3001`。保持终端运行；Ctrl+C停机。启动目录必须是对应release目录。端口已被占用时同时修改PORT和PI_WORKSPACE_BASE_URL。

另一个终端先用 `curl -fsS http://127.0.0.1:3001/api/access/status` 核对访问状态；需要认证时先在浏览器完成认证，再检查 Pi 状态。没有访问验证阻挡时，可用 `curl -fsS http://127.0.0.1:3001/api/pi/status` 检查 `ok=true`、Pi 版本与实际 `projectRoots`。网页可打开、只读状态正常即完成基础启动；普通安装无需运行全量测试、浏览器回归或打包。模型登录与真实请求另行验证。

关闭终端后继续运行属于可选常驻配置，当前指南没有提供已验收的 LaunchAgent 安装器。自行配置时使用 Node 绝对路径执行 `scripts/start-managed.cjs`，显式设置 PATH、HOME 和 WorkingDirectory，等待 HTTP 就绪，并记录日志与停止/卸载方式；不依赖交互终端的 nvm 初始化，也不以 launchd 的 running 状态代替健康检查。

已有 Pi 身份时先核对“供应商与模型”中的原生配置；只有缺少可用认证时才需要登录。Pi配置、Packages、Skills可先管理全局范围。默认浏览位置优先用户主目录，不预填开发者目录。`PI_PROJECT_ROOTS=/`允许选择该系统用户可访问的服务器目录；也可改为主目录或多个冒号分隔的范围。系统权限与macOS隐私控制继续生效，目录白名单不是工具沙箱。

`/tmp`规范为`/private/tmp`、大小写别名规范为磁盘实际名称均属正常行为。项目、Agent目录别名不会因此产生第二个受管worker。不改写原生JSONL中的历史来冒充迁移。

当前会话删除仍先尝试`gio trash`，不可用时永久删除；macOS默认没有gio，本轮未接入Finder回收站。网页确认框会明确这一行为，并按实际删除结果提示。需要保留的线程请先导出或备份。

## 更新、备份、恢复

通用数据范围与同路径恢复流程见[INSTALL_RECOVERY.md](INSTALL_RECOVERY.md)。macOS默认不安装systemd或launchd服务：先暂停预约，等待线程/工具/设置/媒体操作空闲，再在启动终端Ctrl+C；确认本实例停止后整批保存Agent目录、媒体配置/文件/历史、项目和启动配置。用`tar -czf`保存完整目录，保留原路径恢复；默认共享的 Pi 目录通常在 BASE 之外，必须按[共享身份备份](PI_CLI.md#备份和恢复共享身份)另存完整身份，并同时停止使用该身份的 CLI，不能只保存实例 data。跨路径恢复不能批量替换JSONL字符串冒充完整迁移。

更新时解压到新的release目录，`npm ci`，复制本实例的启动配置，并继续指向同一数据与项目目录。保持native源码、二进制、manifest一起更新；旧代码目录可留作回退。不要清空身份或把测试合成Provider复制进正式身份。重启后核对模型认证、原生会话、文件全文、跨线程搜索、用量以及预约状态；结果不确定的生成任务不要自动重试。

macOS上的`npm run pack:trial`使用系统BSD tar，并逐项允许清单打包；不会把实例数据、node_modules、私人模型或备份带入。开发者重建native组件的说明见[native/README.md](../native/README.md)。Windows原生操作另见[WINDOWS.md](WINDOWS.md)。

# macOS 原生安装与运行

当前已在 **Apple Silicon M2、macOS 26.5.1、Node 22.23.2、Google Chrome** 完成原生基线验收。其他平台见[验证范围](RELEASE_INSTALL_VALIDATION.md)。Intel切片虽已编译，尚不等同于Intel硬件验收。Safari/Finder系统剪贴板及真实媒体服务分别保留实际设备/账户验证。

## 安装前提

- Node 22.x、npm、系统ripgrep。可以保留已有其他版本Node，为本实例指定独立Node22。
- 安装包必须包含`native/pi-darwin-fd.node`、对应C源码与manifest；它们为同一批构建。正常安装不需要Xcode、Python或现场编译。缺失或不匹配时不启用全文/搜索/统计，不回退为较弱的路径检查。
- 本轮实测使用独立Node22官方Darwin ARM64归档，并用官方SHASUMS256核对；没有替换原全局Node。也可通过自己的Node版本管理器或Homebrew提供Node22，启动前用`node --version`核对。
- 若缺少rg，可用`brew install ripgrep`；不要因系统已装Node25而认为该版本已在本项目验收。

## 独立实例示例

先将发布包和同名.sha256下载到Downloads，并核对下载来源。以下为新实例示例，BASE必须尚不存在：

```sh
ARCHIVE="$HOME/Downloads/pivane-1.0.0-rc.2.tar.gz"
(cd "$(dirname "$ARCHIVE")" && shasum -a 256 -c "$(basename "$ARCHIVE").sha256")
BASE="$HOME/pivane"
test ! -e "$BASE" || { echo "此目录已存在，请按更新流程操作或选择新的BASE"; exit 1; }
umask 077
mkdir -p "$BASE/releases/1.0.0-rc.2" "$BASE/data/agent" "$BASE/data/media" "$BASE/projects/demo" "$BASE/backups"
tar -xzf "$ARCHIVE" -C "$BASE/releases/1.0.0-rc.2" --strip-components=1
cd "$BASE/releases/1.0.0-rc.2"
node --version   # 验收基线为22.23.2
rg --version
npm ci
```

创建固定的实例配置。这里使用终端heredoc展开BASE，写入的是真实绝对路径；.env读取器本身不展开变量：

```sh
cat > "$BASE/instance.env" <<EOF
PORT=3001
HOST=127.0.0.1
PI_WORKSPACE_BASE_URL=http://127.0.0.1:3001
PI_CODING_AGENT_DIR=$BASE/data/agent
PI_MEDIA_CONFIG_DIR=$BASE/data/agent/media-lab
PI_MEDIA_DATA_DIR=$BASE/data/media
PI_WEB_DEFERRED_FILE=$BASE/data/agent/pi5-deferred-messages.json
PI_PROJECT_ROOTS=/
EOF
chmod 600 "$BASE/instance.env"
cp "$BASE/instance.env" .env
env -i PATH="$PATH" HOME="$HOME" USER="$USER" LANG=en_US.UTF-8 npm start
```

最小启动环境避免继承其他实例的Provider Key、PI_*或NODE_OPTIONS；如需代理等额外环境，显式加入本实例所需的配置。以后在同一release目录使用相同启动方式，关闭终端后再启动不需要重复npm ci。

打开`http://127.0.0.1:3001`。保持终端运行；Ctrl+C停机。启动目录必须是对应release目录。端口已被占用时同时修改PORT和PI_WORKSPACE_BASE_URL。

初次没有身份或项目时先在网页配置自己的供应商；Pi配置、Packages、Skills可先管理全局范围。默认浏览位置优先用户主目录，不预填开发者目录。`PI_PROJECT_ROOTS=/`允许选择该系统用户可访问的服务器目录；也可改为主目录或多个冒号分隔的范围。系统权限与macOS隐私控制继续生效，目录白名单不是工具沙箱。

`/tmp`规范为`/private/tmp`、大小写别名规范为磁盘实际名称均属正常行为。项目、Agent目录别名不会因此产生第二个受管worker。不改写原生JSONL中的历史来冒充迁移。

当前会话删除仍先尝试`gio trash`，不可用时永久删除；macOS默认没有gio，本轮未接入Finder回收站。网页确认框会明确这一行为，并按实际删除结果提示。需要保留的线程请先导出或备份。

## 更新、备份、恢复

通用数据范围与同路径恢复流程见[INSTALL_RECOVERY.md](INSTALL_RECOVERY.md)。macOS默认不安装systemd或launchd服务：先暂停预约，等待线程/工具/设置/媒体操作空闲，再在启动终端Ctrl+C；确认本实例停止后整批保存Agent目录、媒体配置/文件/历史、项目和启动配置。用`tar -czf`保存完整目录，保留原路径恢复；跨路径恢复不能批量替换JSONL字符串冒充完整迁移。

更新时解压到新的release目录，`npm ci`，复制本实例的启动配置，并继续指向同一数据与项目目录。保持native源码、二进制、manifest一起更新；旧代码目录可留作回退。不要清空身份或把测试合成Provider复制进正式身份。重启后核对模型认证、原生会话、文件全文、跨线程搜索、用量以及预约状态；结果不确定的生成任务不要自动重试。

macOS上的`npm run pack:trial`使用系统BSD tar，并逐项允许清单打包；不会把实例数据、node_modules、私人模型或备份带入。开发者重建native组件的说明见[native/README.md](../native/README.md)。Windows原生操作另见[WINDOWS.md](WINDOWS.md)。

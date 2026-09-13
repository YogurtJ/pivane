# 干净安装、更新与数据恢复

本指南的命令以 **Linux Bash** 为主，面向独立实例；[macOS](MACOS.md)与[Windows](WINDOWS.md)另有原生步骤。支持范围为Linux、已验收的Apple Silicon Mac及Windows11 x64，统一使用Node22.x；完整OS/磁盘/浏览器与未验收范围见[平台验证](RELEASE_INSTALL_VALIDATION.md)。不要把POSIX命令直接粘贴到Windows cmd，Windows项目路径列表使用分号。

## 1. 安装前提

- Node.js **22.x** 与随附 npm（用 `node --version`、`npm --version` 核对）。其他 Node 主版本应单独验证。
- Linux Bash、tar、gzip、sha256sum、curl、ripgrep（命令名 `rg`）、CA 根证书。Debian/Ubuntu 可运行 `sudo apt-get update && sudo apt-get install -y bash tar gzip coreutils curl ripgrep ca-certificates`；Node.js 22 按 Node 官方发行说明安装。
- npm registry 的 HTTPS 网络访问；首次安装需要下载依赖，发布包不包含 `node_modules`。界面图标随包本地提供；可选 Inter 字体通过 Google Fonts 加载，不可达时使用系统字体。无需全局安装 Pi、前端构建、GPU、Python、ComfyUI、systemd 或维护者的媒体 Package。
- 运行 Agent 所需的项目命令另行安装，例如 Git、编译器、Python。安装 Git/npm 类型 Package 也可能需要 Git或额外构建工具。`gio` 是可选回收站命令，缺少时网页删除会永久删除选中的文件。
- 自己的供应商账户/API Key，或可访问的兼容模型服务。目录中出现模型不代表已经获得使用额度。

建议用独立 Linux 用户运行实例，不使用 root。独立目录防止误用旧数据，并不隔离同一系统用户的工具权限。全新机器/用户不继承其他安装的 Pi 身份。并排演练还应清除继承的模型 Key、代理、GPU、`NODE_OPTIONS` 和 `PI_*` 等进程变量；`PI_MEDIA_PROFILE=clean` 只是只读预览模式，**不要用于需要保存配置的正式安装**。

## 2. 从源码发布包安装

先下载`pivane-1.0.0-rc.3.tar.gz`及同名.sha256到Downloads，核对发布来源，然后检查哈希：

```bash
ARCHIVE="$HOME/Downloads/pivane-1.0.0-rc.3.tar.gz"
(cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256")
```

采用固定数据/项目路径与独立版本目录。以下为新实例，BASE必须尚不存在；已有实例使用更新流程：

```bash
BASE="$HOME/pivane"
test ! -e "$BASE" || { echo "此目录已存在，请按更新流程操作或选择新的BASE"; exit 1; }
umask 077
mkdir -p "$BASE/releases/1.0.0-rc.3" "$BASE/data/agent" "$BASE/data/media" "$BASE/projects/demo" "$BASE/backups"
tar -xzf "$ARCHIVE" -C "$BASE/releases/1.0.0-rc.3" --strip-components=1
cd "$BASE/releases/1.0.0-rc.3"
npm ci
```

不要省略 optional dependencies 或复用其他 CPU/操作系统的 `node_modules`。不要执行 `npm audit fix --force` 来改变发布包依赖。部分 npm 镜像不提供 audit 接口，404 不表示存在漏洞或审计通过；可以单次运行 `npm audit --omit=dev --registry=https://registry.npmjs.org`，不改全局 registry。官方接口也失败时保留失败结果，不把它算作0漏洞。

创建本实例配置，路径使用绝对路径。应用的 `.env` 读取器不会展开 `$HOME`、`${变量}` 或 `~`；下面的 Bash heredoc 在写文件前展开 BASE，因此得到正确的绝对路径：

```bash
cat > "$BASE/instance.env" <<EOF
PORT=3001
HOST=127.0.0.1
PI_CODING_AGENT_DIR=$BASE/data/agent
PI_MEDIA_CONFIG_DIR=$BASE/data/agent/media-lab
PI_MEDIA_DATA_DIR=$BASE/data/media
PI_PROJECT_ROOTS=$BASE/projects
PI_WEB_DEFERRED_FILE=$BASE/data/agent/pi5-deferred-messages.json
PI_WORKSPACE_BASE_URL=http://127.0.0.1:3001
EOF
chmod 600 "$BASE/instance.env"
cp "$BASE/instance.env" .env
```

首次启动使用最小环境，保留当前用户自己的 HOME（没有把 HOME 改成别人的目录）：

```bash
env -i PATH="$PATH" HOME="$HOME" USER="$USER" LANG=C.UTF-8 npm start
```

Node/npm 必须可由 PATH 找到；使用版本管理器时保留其 Node 所在路径。非交互 SSH 和 systemd 通常不加载 nvm 的交互初始化，应在服务中明确 Node 的绝对路径和 PATH；不要因 `node: command not found` 就覆盖机器上已有的 Node。最小环境不会带入原 shell 的 API Key、代理或 GPU 配置；如网络必须走代理，请明确添加本实例所需代理。之后也应使用同样的启动方式或专用服务用户/环境，非空进程变量优先于 `.env`。前台运行时 Ctrl+C 退出，等命令返回再复制数据；systemd 是可选的后续运维方式。

另一个终端检查：

```bash
curl -fsS http://127.0.0.1:3001/api/pi/status
```

预期 `ok=true`，`projectRoots` 只有本次项目根，实际 Pi `version` 对应发布包依赖。浏览器打开 `http://127.0.0.1:3001`。从其他设备访问需要修改 HOST、重启并配置自己的地址/防火墙/访问验证；localhost 指浏览器所在机器。远程管理凭据请使用可信 HTTPS 或受信网络。

## 3. 首次网页使用

1. 首次打开会显示“打开项目”窗口，可先选择项目，或关闭窗口再配置模型。打开设置 → **供应商与模型**。首次应无你的私人供应商/凭据，媒体语音目录为空；内置供应商/公共模型名称仍会显示。
2. 展开自己的供应商，选择 API Key 或 OAuth 登录，按步骤提交。OAuth 回调中的 localhost 指服务器，远程浏览器需要服务方支持的设备码/手动回调。Key 只在网页输入，不发到聊天或截图。
3. 自定义兼容服务通过“新增供应商”配置 ID、Base URL 与 API 类型，再添加模型；填真实模型 ID、窗口和输入能力。保存 Key 后选择一个模型设为默认。点击“测试”会产生一次小额真实请求；认证状态不等于请求已测试成功。
4. 关闭设置，点击项目入口，选择已经存在的 `$BASE/projects/demo`；也可输入其绝对路径。项目框从服务器的有效默认目录开始，按钮可进入子目录、返回上级或返回可选位置，不再预填维护者路径。网页不创建服务器项目目录，浏览器本机路径不能代替服务器路径。未选择项目时，Pi配置、Packages和Skills只管理全局范围。
5. 点击新建线程，确认连接完成、模型正确，发送“只回复 OK”。刷新网页，确认该线程与回复仍在；可将线程命名为“安装验收”。
6. 在项目中放一个普通 UTF-8 文本，输入 `@` 搜索文件，再让 Agent 读取测试文件；不使用私人项目作为首次验收。

如果希望选择其他现有目录，在本实例的启动配置中扩大 `PI_PROJECT_ROOTS` 并空闲重启；例如设置为用户主目录可浏览其下全部项目。个人Linux实例也可以明确设置 `PI_PROJECT_ROOTS=/`，从用户主目录向上浏览整棵服务器目录树；系统用户的读/进入权限仍生效，目录范围不是工具沙箱。多个根使用冒号分隔。不要把只用于隔离测试的狭窄项目根当作所有使用者的固定部署范围。

如果项目或会话为空，先确认绝对路径存在、在 `PI_PROJECT_ROOTS` 内，且启动读取的是本实例配置。模型保存后已有 runtime 不自动重载，空闲时 `/quit` 再打开线程。项目资源是否信任由项目菜单 `/trust` 管理；未信任并不等于工具沙箱。

### 媒体的安装前提

实验室内的“生成方案”显式加载发布包内 `pi-packages/media-workbench/extensions/media-tools.ts`，**不依赖预先全局安装 Package**。它仍需要一个已配置的聊天模型。普通 Pi Agent 中如需这些规划工具，才在设置 → Packages 安装本发布目录下的 `pi-packages/media-workbench`，阅读并确认 Package 风险。使用版本目录更新后，要把这个本地 source 改到新版本，或将 Package 单独保留在固定路径并自行更新。

无媒体服务时图像/视频可显示未配置，TTS 为空，这是正常首次状态。托管 HTTP 媒体可在实验室管理页配置；GPU bridge、Z-Image worker 文件/LoRA、ComfyUI 权重、Breeze/Qwen 远端脚本以及 curl/Python/SSH 等是所选 adapter 的额外前提，未附带在发布包中。详见 [媒体接入](MEDIA_CONNECTIONS.md)、[Flux](FLUX2_DEV.md) 与 [TTS](tts-providers/README.md)。不要复制维护者的本机路径或配方来“修复”空目录。

## 4. 备份范围与一致性

| 类别 | 本指南布局 | 恢复含义 |
|---|---|---|
| 代码/依赖清单 | `releases/1.0.0-rc.3`、原发布包及哈希 | 重解压并 `npm ci`；不跨平台复制 node_modules |
| Pi 会话 | `data/agent/sessions/` 原生 JSONL | 完整原生树与活动位置；网页当前分支导出不等于完整备份 |
| Pi 凭据/模型/设置 | 整个 `data/agent/` 中的原生配置、存储与备份 | 含 auth、models、settings、trust 等；不要只挑 auth.json 或手工改写它 |
| 工作台配置 | Agent 目录内 `pi5-workspace.json`、`pi5-access.json`、`pi5-notifications.json` | 偏好、访问校验/登录、通知订阅；均作为私人数据处理 |
| 预约 | 明确指定的 `pi5-deferred-messages.json` | 包含未发送内容；备份前暂停，恢复后核对，禁止自动补发 |
| 媒体配置与 Key | `data/agent/media-lab/` + Pi 凭据库 | 配方、connections、registry、说明文件和 Key 必须配套 |
| 媒体历史与文件 | 整个 `data/media/` | 三类 history JSON、prompts.json 与 public/images、videos、audio 必须同批恢复 |
| 项目和项目资源 | `projects/` | 源码、未提交修改、`.pi`、项目模板/Package；会话不会替你备份项目文件 |
| 启动环境 | `instance.env` 及实际服务配置 | 可能含秘密；自定义外置目录/证书/凭据命令的依赖也要另行备份 |

浏览器草稿、未发送附件、临时会话、BTW 侧聊、未确认媒体票据、未处理的内存取回/扩展建议不在磁盘备份中。先复制需要保留的内容。外置 Package source、符号链接指向的目录、系统钥匙串/外部凭据命令、远端媒体任务和外部数据库不由下述 tar 自动包含；单独登记并备份。

备份步骤：

1. 停止提交新任务；等全部主/侧回复、Shell、摘要、媒体、导入导出和设置操作结束，处理等待确认，**在网页暂停所有待发送预约**，记录其状态。
2. 结束临时/侧聊，保存草稿。停止拥有这些目录的服务和任何正在使用同一 Pi 身份/会话的 CLI，等进程完全退出。HTTP activity 不能证明外部 CLI 或远端任务停止。
3. 对已停止的数据做一次完整快照，备份文件放在 data/projects 以外：

```bash
BASE="$HOME/pivane"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="$BASE/backups/data-$STAMP.tar.gz"
umask 077
tar -czf "$BACKUP" -C "$BASE" instance.env data projects
(cd "$BASE/backups" && sha256sum "data-$STAMP.tar.gz" > "data-$STAMP.tar.gz.sha256")
chmod 600 "$BACKUP" "$BACKUP.sha256"
(cd "$BASE/backups" && sha256sum -c "data-$STAMP.tar.gz.sha256")
```

只保存哈希不能防止备份内容泄露；把包存放于加密且有另一份副本的存储中。不要上传到源码仓库、release 或 public/downloads。确认备份无误后可按原方式启动原实例。

## 5. 更新演练

可先在设置 → [版本与更新](UPDATES.md)检查 Pivane/Pi 版本，取得官方发布说明、发布包和校验文件。Pivane 应用仍按本节更新；普通 `node server.js` 或 `npm start` 启动后，工作台内的 Pi 还可在设置中单独更新，并执行停机备份或重启。全局 Pi CLI 的更新不改变工作台内核。

受管 Pi 版本位于原安装目录的 `.pivane-runtime` 中，始终从原目录启动。升级 Pivane 应用采用新的发布目录并沿用原数据配置，不将旧受管快照覆盖到新发布目录。备份、恢复及源码开发与受管快照的关系见[维护说明](UPDATES.md)。

先阅读目标版本的变更及迁移要求。首版当前没有历史格式迁移脚本；未来版本如有迁移应遵循该版本说明，不假设任意降级兼容。

1. 按上一节暂停预约、停止服务、备份；保留旧版本目录与对应的更新前备份。
2. 解压目标包到**新的空目录**，安装其锁定依赖：

```bash
BASE="$HOME/pivane"
NEXT_ARCHIVE="/absolute/path/to/new-release.tar.gz"
mkdir "$BASE/releases/r2"
tar -xzf "$NEXT_ARCHIVE" -C "$BASE/releases/r2" --strip-components=1
cd "$BASE/releases/r2"
npm ci
cp "$BASE/instance.env" .env
env -i PATH="$PATH" HOME="$HOME" USER="$USER" LANG=C.UTF-8 npm start
```

3. 只有新服务使用固定 data/projects；不要同时启动旧服务。使用服务管理器时同步修改 WorkingDirectory/ExecStart，并保持原用户/数据路径。
4. 新浏览器/刷新页面，核对版本、原线程 ID/名称/正文/分支、项目文件、供应商认证状态/默认模型、工作台偏好、媒体记录与文件可下载。预约保持暂停，核对后逐项决定是否恢复。真实凭据请求测试由用户自行执行。
5. 如失败，停止新进程，保留失败后的数据副本。若目标版本未改变数据格式，可用旧代码核对；存在迁移或不确定时，将**匹配旧版本的完整更新前备份**恢复后再运行旧代码。不要混合不同时点的会话、配置和媒体。

采用外置数据后不用把旧 public 目录覆盖到新代码上。旧安装把媒体留在代码目录时，先停机把三类历史、prompts.json 和三个媒体文件目录迁入独立媒体根，逐文件核对，再改 `PI_MEDIA_DATA_DIR`；旧目录在验收前保留。

## 6. 从备份恢复

恢复演练优先使用新 Linux 容器/虚拟机，在其内部保持与原实例相同的**绝对项目路径**。不要启动第二个进程共用原来的 data；即使只打算浏览，预约也可能触发投递。

1. 校验备份 SHA-256；停止目标服务，保留已有目标目录副本。对可信的自己备份先 `tar -tzf` 检查成员，再解压到新的空 BASE。不要把不可信 tar 解压到系统目录。
2. 恢复同一套 `instance.env`、data 和 projects，恢复文件所有者为运行用户，限制 Agent/备份/配置权限；不要把所有项目文件 chmod 为600而破坏可执行权限。
3. 重新解压匹配版本源码，`npm ci`，复制 instance.env 到代码目录 `.env`，启动。服务器只能有一个进程拥有该数据目录。
4. 如果备份时未确认预约已暂停，**首次恢复启动必须隔离出站网络**，先在待发送列表核对/暂停。旧快照中的 scheduled 可能仍是未来时间，不能依靠“过期不补发”保证不会重放。不要手工把 uncertain/dispatching 改为 scheduled。
5. 核对与更新相同的数据清单；恢复前后对 JSONL/媒体/项目文件做哈希对照。首次打开 Pi runtime 可能追加原生状态条目，应在启动前比较字节，启动后检查语义与会话 ID。

参考解压步骤（RESTORE_BASE 必须是目标系统中的新空目录；保持原项目绝对路径时将它设为原 BASE）：

```bash
RESTORE_BASE="/absolute/path/to/pivane"
BACKUP="/absolute/path/to/data-<时间戳>.tar.gz"
(cd "$(dirname "$BACKUP")" && sha256sum -c "$(basename "$BACKUP").sha256")
mkdir -p "$RESTORE_BASE"
tar -tzf "$BACKUP"
tar -xzf "$BACKUP" -C "$RESTORE_BASE"
```

凭据恢复后不回显 Key。OAuth 可能已过期或被服务方撤销，需要重新登录；通知订阅可能绑定旧浏览器/来源，需要重新启用。恢复访问控制文件也会恢复旧登录状态，实际切换机器后可撤销设备登录。禁止两个独立副本同时使用同一个可刷新的 OAuth 身份执行请求。

如果项目绝对路径改变，原 session header 与项目索引不会自动改写；先恢复原路径，或通过网页把当前分支 JSONL 导入新项目（新 ID、仅当前分支）。完整历史树跨路径迁移尚未提供，不用文本替换 JSONL 冒充迁移。外部 Package source 路径、trust、置顶和媒体连接也须分别核对。

## 7. 发布验收记录

每次候选包记录：包名/SHA-256、OS/CPU、Node/npm、安装日志、首次无凭据状态、浏览器流程结果、更新前后与恢复后数据核对，以及尚未验证的平台/真实账户。容器上的受控供应商成功只证明接入与持久化链路；不能计为真实供应商 OAuth 或 Mac/Windows 原生服务器验收。

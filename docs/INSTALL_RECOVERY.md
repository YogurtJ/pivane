# 干净安装、更新与数据恢复

本指南的命令以 **Linux Bash** 为主，面向个人安装；[macOS](MACOS.md)与[Windows](WINDOWS.md)另有原生步骤。支持范围为Linux、已验收的Apple Silicon Mac及Windows11 x64，统一使用Node22.x；完整OS/磁盘/浏览器与未验收范围见[平台验证](RELEASE_INSTALL_VALIDATION.md)。不要把POSIX命令直接粘贴到Windows cmd，Windows项目路径列表使用分号。

## 1. 安装前提

- Node.js **22.x** 与随附 npm（用 `node --version`、`npm --version` 核对）。其他 Node 主版本应单独验证。
- Linux Bash、tar、gzip、sha256sum、curl、ripgrep（命令名 `rg`）、CA 根证书。Debian/Ubuntu 可运行 `sudo apt-get update && sudo apt-get install -y bash tar gzip coreutils curl ripgrep ca-certificates`；Node.js 22 按 Node 官方发行说明安装。
- npm registry 的 HTTPS 网络访问；首次安装需要下载依赖，发布包不包含 `node_modules`。界面图标随包本地提供；可选 Inter 字体通过 Google Fonts 加载，不可达时使用系统字体。无需全局安装 Pi、前端构建、GPU、Python、ComfyUI、systemd 或维护者的媒体 Package。
- 运行 Agent 所需的项目命令另行安装，例如 Git、编译器、Python。安装 Git/npm 类型 Package 也可能需要 Git或额外构建工具。`gio` 是可选回收站命令，缺少时网页删除会永久删除选中的文件。
- 自己的供应商账户/API Key，或可访问的兼容模型服务。目录中出现模型不代表已经获得使用额度。

建议使用运行 Pi CLI 的同一普通系统用户安装，不使用 root。普通安装复用当前用户的 Pi 原生身份；模型和认证已配置时无需重新登录，目录识别与 Windows/WSL 差异见[已有 Pi 接入](PI_CLI.md)。只有独立实例或隔离验收才另建身份。并排演练还应清除继承的模型 Key、代理、GPU、`NODE_OPTIONS` 和 `PI_*` 等进程变量；`PI_MEDIA_PROFILE=clean` 只是只读预览模式，**不要用于需要保存配置的正式安装**。

## 选择项目范围

Pivane 媒体和预约数据按实例保存，Pi 身份默认与 CLI 共用；`PI_PROJECT_ROOTS` 决定网页可以选择哪些服务器项目，两者分别配置。普通安装默认开放电脑上系统用户可访问的目录，Linux/macOS 使用 `/`，Windows 使用各盘符根目录。无需让用户先选择最小范围，也不要自行限制到 Documents 或 demo 目录；用户明确要求缩小时再配置：

| 使用范围 | Linux/macOS 配置示例 |
|---|---|
| 个人电脑上所有系统用户可访问的目录，包括已挂载外置磁盘 | `PI_PROJECT_ROOTS=/` |
| 仅当前用户主目录 | `PI_PROJECT_ROOTS=/absolute/path/to/home` |
| 多个指定目录 | `PI_PROJECT_ROOTS=/absolute/projects:/absolute/other-projects` |

以下 Linux 和 macOS 安装示例统一采用 `/`。路径必须存在并使用真实绝对路径，`.env` 不展开 `~` 或 `$HOME`。Windows 使用分号分隔的盘符路径，见[Windows指南](WINDOWS.md)。系统权限继续生效；目录范围不是工具沙箱。

## 2. 从源码发布包安装

先下载`pivane-1.0.0-rc.4.tar.gz`及同名.sha256到Downloads，核对发布来源，然后检查哈希：

```bash
ARCHIVE="$HOME/Downloads/pivane-1.0.0-rc.4.tar.gz"
(cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256")
```

采用固定的媒体/预约路径与独立版本目录，Pi 身份沿用当前用户的原生目录。以下为新实例，BASE必须尚不存在；已有实例使用更新流程：

```bash
BASE="$HOME/pivane"
test ! -e "$BASE" || { echo "此目录已存在，请按更新流程操作或选择新的BASE"; exit 1; }
umask 077
mkdir -p "$BASE/releases/1.0.0-rc.4" "$BASE/data/media" "$BASE/projects/demo" "$BASE/backups"
tar -xzf "$ARCHIVE" -C "$BASE/releases/1.0.0-rc.4" --strip-components=1
cd "$BASE/releases/1.0.0-rc.4"
npm ci
```

只在所有前置检查成功后安装依赖。使用 nvm 等版本管理器时，版本切换与安装用 `&&` 连接，切换失败不要继续；用 `node -p 'process.execPath'` 核对实际 Node 路径。上述流程使用 Release 发布包；如果用户明确选择 Git checkout，记录 commit 并保留包内原生组件，同样配置独立数据与项目范围，不因源码安装自动运行开发验收。

不要省略 optional dependencies 或复用其他 CPU/操作系统的 `node_modules`。不要执行 `npm audit fix --force` 来改变发布包依赖。部分 npm 镜像不提供 audit 接口，404 不表示存在漏洞或审计通过；可以单次运行 `npm audit --omit=dev --registry=https://registry.npmjs.org`，不改全局 registry。官方接口也失败时保留失败结果，不把它算作0漏洞。

在与原 Pi CLI 相同的用户和配置环境中取得实际身份目录。此命令只报告路径；不要在安装前把 `PI_CODING_AGENT_DIR` 改成新空目录。若 CLI 通过 alias 或启动脚本设置覆盖变量，先使用其实际绝对路径，见[已有 Pi 接入](PI_CLI.md)。

```bash
AGENT_DIR=$(node scripts/pi-agent-dir.cjs) || exit 1
printf 'Pi identity: %s\n' "$AGENT_DIR"
```

创建本实例配置，路径使用绝对路径。应用的 `.env` 读取器不会展开 `$HOME`、`${变量}` 或 `~`；下面的 Bash heredoc 在写文件前展开 BASE，因此得到正确的绝对路径：

```bash
cat > "$BASE/instance.env" <<EOF
PORT=3001
HOST=127.0.0.1
PI_CODING_AGENT_DIR=$AGENT_DIR
PI_MEDIA_CONFIG_DIR=$BASE/data/media-lab
PI_MEDIA_DATA_DIR=$BASE/data/media
PI_PROJECT_ROOTS=/
PI_WEB_DEFERRED_FILE=$BASE/data/pivane-deferred-messages.json
PI_WORKSPACE_BASE_URL=http://127.0.0.1:3001
EOF
chmod 600 "$BASE/instance.env"
cp "$BASE/instance.env" .env
```

首次启动使用最小环境，保留当前用户自己的 HOME（没有把 HOME 改成别人的目录）：

```bash
node scripts/install-service.cjs
```

Node/npm 必须可由 PATH 找到；使用版本管理器时保留其 Node 所在路径。非交互 SSH 和 systemd 通常不加载 nvm 的交互初始化，应在服务中明确 Node 的绝对路径和 PATH；不要因 `node: command not found` 就覆盖机器上已有的 Node。常驻服务不会自动继承安装终端的 API Key、代理或 GPU 配置；已保存在 Pi 身份中的认证仍可读取，依赖环境变量或外部命令的认证需为此实例提供相同依赖。如网络必须走代理，请明确添加本实例所需代理。之后也应使用同样的启动方式或专用服务用户/环境，非空进程变量优先于 `.env`。前台 `npm start` 仅用于试用和排障。正式安装默认配置[后台常驻](BACKGROUND_SERVICE.md)，Linux 服务器须核对用户服务的 linger 或等价系统服务，确保注销和重启后仍可启动。

另一个终端检查：

```bash
curl -fsS http://127.0.0.1:3001/api/pi/status
```

预期 `ok=true`，`projectRoots` 为本次配置的 `/`，实际 Pi `version` 对应发布包依赖。浏览器打开 `http://127.0.0.1:3001`。从其他设备访问需要修改 HOST、重启并配置自己的地址/防火墙/访问验证；localhost 指浏览器所在机器。远程管理凭据请使用可信 HTTPS 或受信网络。

## 默认可选能力

当前源码的 `npm ci` 在必需依赖安装后尝试安装 `npm:pi-subagents@0.69.0`，使用 Pi 公开包管理接口写入当前用户的 Pi 配置，与 CLI 共用。下载失败只产生提示，Pivane 仍可安装和运行。默认安装不会自动委派任务。插件按自身 MIT 许可单独下载，不将其源码复制进 Pivane 仓库。

如使用独立身份，必须在 `npm ci` **之前**设置 `PI_CODING_AGENT_DIR`（或准备应用 `.env`），避免把可选插件安装到默认身份。已有 Pi 用户保持原来的身份环境。设置 `PI_SKIP_DEFAULT_CAPABILITIES=1`、`PI_OFFLINE=1` 或使用 npm 的 `--ignore-scripts` 可跳过自动安装；前两种方式记录跳过，`--ignore-scripts` 不运行安装器也不写记录。

每个 Pi 身份的 `pivane-default-capabilities.json` 保存能力安装尝试状态；成功、失败、中断、跳过或发现已有配置后，不会在后续启动或 `npm ci` 自动重放。已安装的其他版本保留，用户卸载后不会自动装回。缺失插件可在“设置 → 模型与能力 → 子 Agent”确认补装，异常或结果不确定先刷新核对。停用、版本调整与移除通过 Packages 管理。

默认能力清单用于后续扩展其他包/Skills，目前只包含 pi-subagents；并非自动安装任意第三方能力。首次添加的新清单项会在下一次执行安装脚本时单独尝试。

## 3. 首次网页使用

1. 首次会显示“打开项目”窗口，可先选择项目，或关闭窗口再配置模型。打开设置 → **供应商与模型**。复用 Pi 身份时应能看到原生配置中的供应商和认证；只有新身份才需要首次配置。
2. 没有可用认证时，展开自己的供应商，选择 API Key 或 OAuth 登录，按步骤提交。OAuth 回调中的 localhost 指服务器，远程浏览器需要服务方支持的设备码/手动回调。Key 只在网页输入，不发到聊天或截图。
3. 自定义兼容服务通过“新增供应商”配置 ID、Base URL 与 API 类型，再添加模型；填真实模型 ID、窗口和输入能力。保存 Key 后选择一个模型设为默认。点击“测试”会产生一次小额真实请求；认证状态不等于请求已测试成功。
4. 关闭设置，点击项目入口，选择已经存在的 `$BASE/projects/demo`；也可输入其绝对路径。项目框从服务器的有效默认目录开始，按钮可进入子目录、返回上级或返回可选位置，不再预填维护者路径。网页不创建服务器项目目录，浏览器本机路径不能代替服务器路径。未选择项目时，Pi配置、Packages和Skills只管理全局范围。
5. 点击新建线程，确认连接完成、模型正确，发送“只回复 OK”。刷新网页，确认该线程与回复仍在；可将线程命名为“安装验收”。
6. 在项目中放一个普通 UTF-8 文本，输入 `@` 搜索文件，再让 Agent 读取测试文件；不使用私人项目作为首次验收。

本例默认 `PI_PROJECT_ROOTS=/`，可从用户主目录向上浏览服务器目录树，无需为 Documents 之外的项目另改配置。只有用户希望缩小范围时才改为主目录或多个冒号分隔的指定目录，并空闲重启；系统用户的读/进入权限仍生效，目录范围不是工具沙箱。

如果项目或会话为空，先确认绝对路径存在、在 `PI_PROJECT_ROOTS` 内，且启动读取的是本实例配置。模型保存后已有 runtime 不自动重载，空闲时 `/quit` 再打开线程。项目资源是否信任由项目菜单 `/trust` 管理；未信任并不等于工具沙箱。

### 媒体的安装前提

实验室内的“生成方案”显式加载发布包内 `pi-packages/media-workbench/extensions/media-tools.ts`，**不依赖预先全局安装 Package**。它仍需要一个已配置的聊天模型。普通 Pi Agent 中如需这些规划工具，才在设置 → Packages 安装本发布目录下的 `pi-packages/media-workbench`，阅读并确认 Package 风险。使用版本目录更新后，要把这个本地 source 改到新版本，或将 Package 单独保留在固定路径并自行更新。

无媒体服务时图像/视频可显示未配置，TTS 为空，这是正常首次状态。托管 HTTP 媒体可在实验室管理页配置；GPU bridge、Z-Image worker 文件/LoRA、ComfyUI 权重、Breeze/Qwen 远端脚本以及 curl/Python/SSH 等是所选 adapter 的额外前提，未附带在发布包中。详见 [媒体接入](MEDIA_CONNECTIONS.md)、[Flux](FLUX2_DEV.md) 与 [TTS](tts-providers/README.md)。不要复制维护者的本机路径或配方来“修复”空目录。

## 项目选择器找不到目录

当前网页不能修改实例的 `PI_PROJECT_ROOTS`。目标目录存在却不在可选范围时，先检查 `/api/pi/status` 返回的 `projectRoots`，再核对实例启动配置。这个问题不能通过创建线程、刷新网页或修改 Pi 项目信任解决。

1. 在服务器实际加载的 `.env` 或服务环境中修改 `PI_PROJECT_ROOTS`；如按本指南保留了 `instance.env`，同步修改该配置源和当前 release 的 `.env`，避免下次升级恢复旧范围。非空进程环境优先于 `.env`，服务管理器中的旧值也要同步。
2. 例如个人 macOS 实例可改为 `PI_PROJECT_ROOTS=/`；仅开放主目录则填真实绝对路径，不能写 `~/Documents` 或 `$HOME`。无需移动项目、会话或数据目录。
3. 保存草稿、暂停预约、等待 Agent/Shell/侧聊/媒体/配置与导入导出操作空闲，再按实例原有方式重启。不能从承载当前操作会话的服务内部停掉自身，应使用独立管理终端或通道。
4. 重新检查 `projectRoots` 并打开目标目录。范围已包含目标但仍无法进入时，再检查目录是否存在、系统读/进入权限与 macOS 隐私控制；扩大根范围不会绕过这些权限。

## 4. 备份范围与一致性

| 类别 | 本指南布局 | 恢复含义 |
|---|---|---|
| 代码/依赖清单 | `releases/1.0.0-rc.4`、原发布包及哈希 | 重解压并 `npm ci`；不跨平台复制 node_modules |
| Pi 会话 | 实际 `PI_CODING_AGENT_DIR` 下的 `sessions/` 原生 JSONL | 完整原生树与活动位置；网页当前分支导出不等于完整备份 |
| Pi 凭据/模型/设置 | 整个实际 Pi 身份目录，通常在 BASE 之外 | 含 auth、models、settings、trust 等；不要只挑 auth.json 或手工改写它 |
| 工作台配置 | Agent 目录内所选的 workspace、access、notifications 配置（新名称为 `pivane-*`，既有 `pi5-*` 沿用） | 偏好、访问校验/登录、通知订阅；均作为私人数据处理 |
| 预约 | 明确指定的预约 JSON 文件，例如 `pivane-deferred-messages.json` | 包含未发送内容；备份前暂停，恢复后核对，禁止自动补发 |
| 媒体配置与 Key | `data/media-lab/` + 实际 Pi 身份的凭据库 | 配方、connections、registry、说明文件和 Key 必须配套 |
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

上面的 BASE 归档不包含其外的 Pi 身份。普通安装还须在同一次停机期间备份实际身份目录，`AGENT_DIR` 填已经核对的启动配置路径（不要重新用另一个终端的默认身份代替）：

```bash
AGENT_DIR="/absolute/path/from/instance-config"
AGENT_BACKUP="$BASE/backups/pi-agent-$STAMP.tar.gz"
tar -czf "$AGENT_BACKUP" -C "$AGENT_DIR" .
chmod 600 "$AGENT_BACKUP"
(cd "$BASE/backups" && sha256sum "pi-agent-$STAMP.tar.gz" > "pi-agent-$STAMP.tar.gz.sha256")
chmod 600 "$AGENT_BACKUP.sha256"
(cd "$BASE/backups" && sha256sum -c "pi-agent-$STAMP.tar.gz.sha256")
```

记录原身份绝对路径，将两份归档按同一时间戳配套保存。若显式隔离身份已完整位于 BASE/data 内，可省略第二份；外置链接与自定义会话目录仍须另行备份。

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
2. 恢复同一套 `instance.env`、data 和 projects；若 Pi 身份在 BASE 外，必须先将配套 `pi-agent-<时间戳>.tar.gz` 校验并解压到记录的原身份绝对路径（目标目录需已停止使用，并保留原内容副本）。BASE 的 tar 不包含这部分，不能先启动生成空身份。恢复文件所有者为运行用户，限制 Agent/备份/配置权限；不要把所有项目文件 chmod 为600而破坏可执行权限。
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

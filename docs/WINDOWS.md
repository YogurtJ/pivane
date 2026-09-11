# Windows 原生安装与验证

2026-09-11 已在 Windows 11 x64（build 26200、NTFS）完成原生适配及安装/更新/同路径恢复验证。使用官方 Node 22.23.2、包内 Pi 0.85.0、Git for Windows、ripgrep 和原生 Chrome，未使用 WSL。

## 安装前提

- Node 22.x x64、npm、Git for Windows（含 Git Bash）、ripgrep 在运行进程 PATH 中可用。Pi 使用项目锁定依赖，不需要全局安装。
- 普通安装使用随包的 Node-API 8 组件，无需 Visual Studio、编译器或安装时下载原生库。仅维护者重建组件时需要指定编译工具和已核对的 Node 输入文件，见 native/README.md。
- 每个实例使用独立、绝对路径的 Pi 数据目录、媒体目录与预约文件。不要将 Pi 数据目录指向驱动器根目录或整个用户主目录。
- Git Bash 用于内置 Bash 和手动 `!`/`!!`。Pi 的可选 PowerShell 工具沿用原生设置。创建文件符号链接仍受 Windows 的开发者模式/权限限制；本项目不自动开启开发者模式。

下面使用普通用户目录中的新实例。先将发布包和同名.sha256下载到Downloads；PowerShell执行：

```powershell
$archive = Join-Path $env:USERPROFILE 'Downloads\pivane-1.0.0-rc.2.tar.gz'
$expected = (Get-Content -LiteralPath ($archive + '.sha256') -Raw).Trim().Split()[0]
if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $expected) { throw '发布包校验失败' }
$base = Join-Path $env:USERPROFILE 'Pivane'
if (Test-Path -LiteralPath $base) { throw '此目录已存在，请按更新流程操作或选择新的base' }
$app = Join-Path $base 'releases\1.0.0-rc.2'
@($app, "$base\data\agent", "$base\data\media", "$base\projects\demo", "$base\backups") | ForEach-Object { New-Item -ItemType Directory -Path $_ -Force | Out-Null }
tar.exe -xzf $archive -C $app --strip-components=1
if ($LASTEXITCODE -ne 0) { throw '解包失败' }
Set-Location -LiteralPath $app
node.exe --version
rg.exe --version
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
```

保存实例启动配置，使用正斜杠绝对路径，避免手动替换用户名。这里的PowerShell字符串会展开变量，.env读取器本身不展开变量：

```powershell
$dataRoot = $base.Replace('\', '/')
$config = @"
HOST=127.0.0.1
PORT=3001
PI_WORKSPACE_BASE_URL=http://127.0.0.1:3001
PI_CODING_AGENT_DIR=$dataRoot/data/agent
PI_MEDIA_CONFIG_DIR=$dataRoot/data/agent/media-lab
PI_MEDIA_DATA_DIR=$dataRoot/data/media
PI_WEB_DEFERRED_FILE=$dataRoot/data/agent/pi5-deferred-messages.json
PI_PROJECT_ROOTS=$dataRoot/projects
"@
[IO.File]::WriteAllText((Join-Path $base 'instance.env'), $config, [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $base 'instance.env') -Destination (Join-Path $app '.env')
npm.cmd start
```

打开http://127.0.0.1:3001。以后只需进入该release目录再运行npm.cmd start；首次安装成功后不用每次重装依赖。运行进程已有环境变量优先于.env，启动前核对并清除本进程不需要的旧PI_*、Provider Key及NODE_OPTIONS，不输出其秘密值，也不修改其他应用的系统环境。

项目根在Windows使用分号分隔，例如`C:/Projects;D:/Work`；实际目录必须存在，仍经过系统realpath、目录与权限检查。按需要修改instance.env并同步复制到当前代码目录，端口变更需同时修改PORT和PI_WORKSPACE_BASE_URL。上例只监听本机；开放远程访问需要相应监听地址、防火墙及访问验证配置。运行窗口保持打开，先在网页结束任务；需要备份时暂停预约，再在启动窗口按 Ctrl+C 停机。普通关闭与远端/脱离进程不是事务性撤销。

## 更新、备份与恢复

备份前暂停预约、处理未保存草稿并等所有任务结束，Ctrl+C后确认本实例进程退出。用用户自己的备份工具整批保存data、projects、instance.env、实际服务配置及发布包/校验文件；不要只备份会话JSONL，也不要把备份放进公开下载目录。使用支持NTFS权限的备份方式；恢复后核对Agent目录的受保护DACL。

升级时把新版本解压到另一个releases子目录，进入新目录执行npm.cmd ci，复制固定的instance.env为.env，再启动新版本。旧版本必须已经停止，新旧版本不能同时打开同一身份或预约文件。数据绝对路径保持不变；不要复制旧node_modules或重建空身份。

恢复时先停机，将data、projects和启动配置整批恢复到原绝对路径，启动前比较文件SHA256，启动后核对会话、模型、搜索、用量与暂停预约。备份时不能确认预约已暂停的，首次恢复须隔离出站网络后先核对队列。详细数据清单和回退要求见[安装与恢复](INSTALL_RECOVERY.md)，其中Bash命令需使用本页的Windows原生等价操作。

## 实现边界

- 文件最终路径通过 Node 导出的公开 libuv fd/HANDLE 转换和 `GetFinalPathNameByHandleW` 查询，避免不同 CRT 描述符表。组件不自带 CRT；仅导入 Node、Kernel32、Advapi32 API。
- 最终文件打开使用 `FILE_FLAG_OPEN_REPARSE_POINT` 并拒绝重解析点，避免检查后的末尾链接替换。路径、根目录、私密目录、类型、大小和读取前后变化检查保留。
- Windows 额外比较完整卷标识与 128 位 File ID，扫描器使用 BigInt stat，预算检查后才转换文件长度。大小写敏感目录使用规范路径精确边界，不用 win32.relative 的大小写折叠判断安全归属。
- 拒绝 ADS、设备命名空间、保留设备名、盘符相对路径及含糊的末尾点/空格；网页文件链接支持盘符、反斜杠和行号。真实规范路径仍由后端核对。
- 私密文件创建时携带受保护 DACL，只允许当前用户、SYSTEM 与管理员；专用 Pi 目录、项目原生配置目录和私有导出目录同步保护。不会用 POSIX mode 数值冒充 Windows ACL，也不修改系统临时目录权限。
- 预约/访问/通知文件先通过可写句柄刷盘，再用 `MoveFileExW(REPLACE_EXISTING|WRITE_THROUGH)` 替换。Windows 不执行目录 fsync。打开文件导致系统拒绝替换时明确报错，不吞掉失败或重放外部请求。
- 常见 HTTP 媒体连接保持原协议。Windows 的 GPU bridge 可指向明确的 Node 脚本（.js/.cjs/.mjs）或可执行文件；Node 脚本通过当前 runtime 启动，远端命令仍是单个参数，用户正文仍经 stdin，不启用 cmd shell 解析。真实 GPU 服务未在本轮调用。

## 验证结果

- Windows、Linux、Apple Silicon macOS 全量 Node 各 **161/161**，无跳过。
- 未提权用户的核心配置、ACL、认证、模型目录及预约等 **24/24**；该用户不能创建文件符号链接是系统权限限制。完整平台安全场景由有权限的测试会话创建测试链接。
- 原生 Chrome 桌面/手机宽度：空身份网页接入合成供应商、真实 Pi RPC 聊天、刷新恢复、文件预览/链接与主题/布局回归通过。没有真实模型账户或付费请求。
- 文件全文、跨线程正文搜索、正数持久用量、Shell/停止、历史/书签/树、侧聊、HTML/JSONL 导出导入、单 worker 及独立数据根通过。
- 同路径更新保留数据；停机备份/恢复 **16 个文件逐项哈希一致**，再验证模型凭据、偏好、暂停预约、媒体解码和搜索。不能用改写 JSONL 路径冒充跨路径迁移。
- npm run check 已改为 Node 文件枚举；Windows 原生 tar 打包、check、audit 通过。

Windows 10、Windows Server、ARM64、ReFS/exFAT、网络共享/映射盘及真实供应商/硬件未在本轮验收。打开文件时系统可能拒绝父目录移动；测试分别记录系统拒绝及可执行的路径竞争场景，不把无法发生的重命名算成成功移动。

平台基线、最新候选包与尚未验收范围见[RELEASE_INSTALL_VALIDATION.md](RELEASE_INSTALL_VALIDATION.md)。

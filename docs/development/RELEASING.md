# Pivane 发布准备

## 版本边界

package.json的应用版本、Pi依赖版本和快照时间戳是不同概念。npm run pack:release生成按应用版本命名的包，TRIAL_MANIFEST.json含appVersion/piVersion，保留原文件名与version=1格式。`/api/pi/status.version`表示加载的Pi版本；它不能单独证明网页和后端属于同一候选包。用压缩包SHA256及TRIAL_MANIFEST逐文件核对构建内容。

版本下载与发布时间以[GitHub Releases](https://github.com/YogurtJ/pivane/releases)为准，不能把本地pack成功称为已公开发布。v1.0.0-rc.1标签固定已验收源码，主分支可继续更新项目介绍与文档；不要据主分支README的变化推断发行包被替换。Pivane改名不要求迁移环境变量、数据文件、服务名称或已有安装目录。

## 候选包

1. 冻结源码与公开文档，完成所需的Node、语法、文档、audit及浏览器回归。
2. 运行npm run pack:release（开发快照仍用pack:trial）。相同版本包存在时拒绝覆盖；冻结包变化须重新验收，已公开版本不能悄悄替换。代码允许清单与docs/public-files.json决定内容；LICENSE、第三方声明和原生manifest随包；AGENTS.local.md、docs/local、身份、媒体和备份禁止纳入。构建后核对manifest/hash，不能仅检查.gitignore。
3. 从该包在独立目录npm ci，不继承维护者的node_modules、Provider环境或Pi身份；做必要的平台/浏览器安装、更新和恢复回归。
4. 更新公开平台范围与CHANGELOG，将测试结果绑定到准确的包SHA256。后续代码变化需按影响补验并重新生成包。
5. 准备下载包、SHA256、版本说明、安装/恢复步骤与已知限制。发布仓库/渠道和外部上传作为独立明确操作。

Git忽略不删除已经跟踪的内容或历史。新仓库初始化时检查暂存清单；如果别处已有仓库，先检查git ls-files和历史是否包含私有文件，不能据ignore宣称历史已经清理。

## 可复跑的隔离验收

使用独立Node22、系统Bash/rg/tar，以及自行安装的Playwright 1.58.2和对应平台Chrome/Chromium。Playwright不属于用户安装的必要依赖。下列参数都替换为自己已核对的绝对路径与哈希，output目录必须尚不存在：

```sh
node test/release/acceptance.cjs --archive /path/pivane-1.0.0-rc.1.tar.gz --sha256 SHA256_VALUE --browser /path/to/chrome --playwright /path/to/playwright --output /path/to/new-report-directory
```

Windows用自己的node.exe和带引号的Windows路径传递相同参数。可选--previous-archive和--previous-sha256用于真正的旧包升级验收；没有旧包时结果只表示同包重开与恢复，不称跨版本升级。不要将来自未知来源的压缩包交给此脚本。

脚本新建系统临时目录，使用随机run ID、哨兵、独立Agent/媒体/项目/预约路径和最小环境，从归档解包npm ci；npm配置也独立。固定loopback8089只用于合成Provider，占用时失败，不结束已有进程；Web使用独立随机loopback端口。仅该标记临时目录允许测试脚本运行，普通安装不调用此入口。

验收包含npm test、check、check:docs、audit、目标系统打包、桌面/手机安装与刷新、真实Pi RPC/Shell/历史/侧聊/导入导出，以及停机更新、原路径逐文件恢复、正数用量、搜索和媒体解码。16×16一秒黑色视频为随包合成fixture，不调用媒体生成服务。服务器通过测试父进程的私有IPC触发原SIGINT关闭逻辑，没有新增HTTP退出接口。RC各阶段必须退出码0；旧包的已知signal-exit问题只在结束全部worker后单独记录，不计作RC正常停机或放宽新包断言。

成功后删除合成身份，保留指定output中的日志与result.json；失败保留隔离目录供诊断。不会更新任何用户实例，不设置开机启动或端口转发。完整本地日志可能包含测试路径，公开时只提取平台、版本、检查结果和包SHA256，形成同名validation.json；不得为了把验收哈希写回包内而产生循环重打包。

## 兼容与恢复

新版本使用固定数据绝对路径、独立代码目录和锁定依赖。备份前暂停预约、处理未保存草稿、等待所有冲突操作结束并停机；恢复比对字节应在启动Pi前完成，启动后再核对会话ID和语义。不要文本改写JSONL路径冒充完整树迁移。

原生组件更新要绑定源码/binary/manifest并在目标系统验证。编译了某架构不等于其真机通过；平台范围以[验证说明](../RELEASE_INSTALL_VALIDATION.md)为准。真正使用供应商账户的请求与合成服务验收分开，不自动调用付费生成。

源码Agent的更多约束见[AGENTS.md](../../AGENTS.md)。

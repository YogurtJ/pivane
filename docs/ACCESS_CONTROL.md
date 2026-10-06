# 网络与访问

设置 → **网络与访问**（原“访问控制”）集中管理访问安全、监听范围、出站代理及远程接入指引。模型页和版本页的“网络代理设置”直接定位到出站代理，不新增设置子页面。旧的 `tab=access` 地址继续有效。

## 网络设置

- **访问安全**保留 Token 和网页登录管理。这是单实例共享权限，不是多用户账户隔离。
- **访问范围**提供“仅本机访问”和“允许其他设备连接”。新实例未配置 HOST 时默认 IPv4 回环 `127.0.0.1`；允许其他设备绑定 `0.0.0.0`，不是“仅限局域网”，公网接口也可能接受连接。明确的部署 HOST 优先，页面只读提示；若要交由网页管理，由管理员移除部署覆盖后安全重启。已有受管 release 且原先未指定 HOST 的安装保留旧监听范围并提示确认；旧的非受管安装在升级前应显式填写 HOST，避免无法识别的远程部署失联。第一次启动将默认范围记入私有网络配置，后续更新不会重新扩大。
- **出站代理**提供运行环境、直连、自定义 HTTP/HTTPS 地址。首版不支持 SOCKS、PAC 或含账号密码的自定义地址；已有部署环境的代理凭据仍由部署端管理，网页不回显。直连仅禁用受管请求的应用层代理，不能绕过系统 VPN/TUN。
- **远程访问**仅提供 Tailscale、HTTPS 反向代理与本机隧道指引，不安装工具、不登录第三方、不开放防火墙、不创建公网入口。

网络写入与草稿连接测试需要先开启登录验证并登录。扩大监听前必须启用验证；当前或待生效监听仍非本机时拒绝关闭验证。已有免认证远程部署不会被自动设置 Token，但应先整改。网页展示实际监听及候选地址，不将 `0.0.0.0` 当访问地址，不声称候选地址已可达；容器内 localhost 不代表宿主机，端口映射需另外配置。

### 保存与生效

监听和代理分区分别保存，**下次安全重启整个服务生效**；保存不修改当前监听、连接池或 worker 环境。页面区分当前生效与待生效状态，并可撤销本次启动后的待生效配置。不会自动重启或仅重开 worker 冒充全局生效。请先完成任务、保存草稿、处理侧聊、Shell、媒体与预约，再从部署端安全重启；刷新网页不等于应用配置。访问 Token 的即时生效和断线语义仍见下文。

配置保存在 Agent 私有目录的 `pivane-network.json`，不改写 `.env`、服务配置或 Pi 原生 `settings.json.httpProxy`。私有文件原子保存、修订检查、文件描述符验证及 Windows DACL 沿用本项目边界；文件不可读取或损坏时拒绝启动/操作，不回退成开放访问或静默直连。需要本机恢复时，停止对应实例并备份网络配置，再由管理员修复；可显式设置 `HOST=127.0.0.1` 收回监听，但不能绕过损坏文件的检查。不要输出带凭据的代理环境。

### 代理覆盖范围

运行环境模式沿用 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY（含小写）及 NO_PROXY；已有 Pi 原生 httpProxy 补充未设置的 HTTP/HTTPS 变量。直连和自定义模式覆盖 Pivane 受管请求，不改写独立 Pi CLI 的配置。默认绕过本机回环及内部管理地址，保留已有 NO_PROXY；可追加逗号分隔的主机/IP/端口规则，不支持 CIDR。

接入范围包括更新检查、保留的受管发布下载/安装环境、主会话与侧聊、辅助模型和后台学习、内置媒体/ASR 的 HTTP 请求与结果下载。不同供应商的 HTTP/SSE/WebSocket 实际能力仍需对应验证；不保证任意第三方扩展、独立 CLI 或 Shell 使用代理。保存不会改变已发请求，不增加失败后自动换线路重发。

“测试草稿连接”只访问固定 GitHub/npm 目标，有超时和频率限制，不保存、不调用生成模型；HTTP 错误与无法连接分开显示。能到达更新源不证明模型服务或账号可用。浏览器打开发布链接、独立 Agent 执行下载仍使用各自网络，不会自动继承网页设置。

### 远程接入

- **Tailscale**：直接访问服务器 Tailscale IP 需要相应监听；同机 [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve) 可转发到回环地址，Pivane 可保持仅本机监听。
- **HTTPS 反向代理**：同机 Caddy/Nginx 等可转发到 `http://127.0.0.1:11408`，需保留原 Host、支持 WebSocket 和长连接；启用 PIVANE_WEB_SECURE_COOKIE，限制后端直接入口。程序不自动信任 X-Forwarded-*；该配置也影响 HTTPS Origin 校验，不能假设原 HTTP 登录入口继续适用。不同机器的代理不能直接连接服务器回环地址。
- **SSH/本机隧道**：例如从客户端执行 `ssh -N -L 11408:127.0.0.1:11408 user@server`，再访问客户端 `http://127.0.0.1:11408`。服务器端 Pivane 仍可仅本机监听；自行处理端口冲突，保持 Token 验证。其他同机隧道亦可使用回环目标，但可能公开服务，须核对服务商访问策略、TLS 和凭据。

网络能力以实际服务返回的状态为准。

平台私密存储采用 POSIX 私密模式或 Windows 受保护 DACL，关键写入刷盘后原子替换；恢复备份同样受保护，不修改系统临时目录权限，不以降低校验绕过原生组件故障。见[Windows](WINDOWS.md)及[原生组件](../native/README.md)。

能力由 `/api/access/status.accessControl=true` 与认证后的 `/api/pi/status.accessControl=true` 标记。

## 使用方式

默认保持免认证，兼容个人受信网络。设置 → 网络与访问 → 访问安全可以开启/关闭验证、自行设置 16–256 位英文字符、数字或符号（ASCII、不含空格）的 Token，或生成 32 字节随机 Token。开启/更换成功后当前设备自动登录；生成的 Token 仅在本次成功响应和当前设置页展示，离开后清除。已有 Token 永不回显，也不保存到网页 storage、URL 或 Pi 原生 Provider 凭据库。

开启验证后，网页使用 HttpOnly、SameSite=Strict、host-only、Path=/ 的 Cookie；Cookie 名按实例配置路径区分。同一 Host 的不同端口不构成浏览器安全隔离，应只共同托管受信服务。普通登录服务器有效期 12 小时，Cookie 不设 Max-Age；勾选“记住此设备”为 30 天。浏览器可能恢复会话 Cookie，因此普通登录不能承诺关浏览器立即退出。有效登录可跨服务重启恢复。

Token 修改撤销全部旧 Cookie 和旧 Token；“撤销所有登录”只撤销 Cookie，程序 Bearer Token 继续可用。“退出当前登录”只撤销当前 Cookie。开启、关闭或换 Token 会改变认证修订，旧 WebSocket 失效；服务器在消息接收、输出与每15秒检查登录有效性。失效网页连接会关闭，但持久 worker 继续原任务；临时会话和 BTW 侧聊按原断线语义结束。已接受的 HTTP/远端生成任务不因此取消，也不会自动重放。

重新登录不刷新整个页面，不清理主输入框未发送草稿。登录覆盖层使其他界面不可交互、暂停媒体，并关闭当前原生 dialog；不代替用户回答扩展确认。已下载或已在浏览器内存中的内容不能远程撤回。新浏览器只取得公开页面资源，私人数据请求需认证。

登录页支持 Token 显隐、提交反馈和错误提示；重新锁定时恢复隐藏。

## 认证和同源边界

开启时：有效 Cookie 或 `Authorization: Bearer <Token>` 才授权私人请求。显式错误 Authorization 不回退到 Cookie。同源 Origin 本身不授予访问权，URL 中的 token 参数不授权。

关闭时：可以连接服务的客户端均可免 Token 调用接口。Origin/Fetch Metadata 检查继续拒绝常规跨站网页请求，但任意程序可自行构造请求，关闭验证不是“只允许官方网页”或工具沙箱。仍应通过监听地址、防火墙或受控网络决定访问范围。

所有私人请求检查 Origin；显式 Origin 与实际 HTTP/HTTPS scheme 和 Host 匹配才属于本站。无 Origin 的普通程序请求仍可使用 Bearer。Cookie 写请求需同源 Origin 或 `X-Pi-Access: 1`；登录、退出、访问设置和撤销要求该自定义 Header，防止普通跨站表单提交。`PI_ALLOWED_ORIGINS` 是额外集成来源，跨来源必须显式提供 Token，不能使用环境 Cookie 绕过。CORS 仅返回允许的来源和 Header，不使用通配来源或跨站 Cookie。

错误登录/Token 校验限制为每源地址每分钟10次、全局60次；成功验证缓存指纹，不反复计算 scrypt。请求地址取连接的 remoteAddress，不信任外部 X-Forwarded-For。反向代理下共享同一源限额，这是个人实例的有意保守行为。WS最多128连接，认证首条最多16KiB、等待10秒；后续原32MiB协议限额保持。

## 保护范围

统一中间件先于业务和静态媒体挂载，覆盖：

- `/api/pi/*`，包括设置、项目、会话、文件读取、导入/导出、媒体实验室。
- 遗留 `/api/history`、`/api/prompts`、`/api/tts*`、`/api/video*`、`/api/runpod*` 等全部 API。
- `/api/media-agent/*`，包括能力读取和规划校验。
- `/images/`、`/videos/`、`/audio/` 及旧兼容页面、`/downloads/`。
- `/api/pi/ws` 的首条认证、后续输入、输出和撤销。

公共内容限首页 shell、固定的无同源权限 Mermaid 渲染框架、顶层前端 JS/CSS、固定 vendor 与品牌资源、manifest，以及只返回 enabled/authenticated 布尔状态的 `/api/access/status`。私有响应 no-store/nosniff；原生静态 Range/HEAD/下载行为保留。未认证无法通过媒体 URL、同源头或编码别名绕过。

遗留业务协议兼容保留并统一鉴权；它们仍不是实验室 review 票据接口。正常实验室与回复朗读继续原 review/execute 流程，身份验证不取代执行清单或扩展确认，不新增 Agent 自动生成权。

## 配置与恢复

网页新配置位于 `<PI_CODING_AGENT_DIR 或 ~/.pi/agent>/pivane-access.json`；既有 `pi5-access.json` 自动沿用，两者同时存在时拒绝猜测。文件使用0600、同目录临时文件、fsync后原子rename；不写工作台普通偏好或原生 auth.json。仅保存盐与scrypt校验值、配置修订、最多64条登录标识的SHA-256与期限，不保存原 Token 或原 Cookie。一个配置文件只由一个服务进程管理。

文件不存在表示默认免认证；关闭网页验证会清除原Token校验值，再次开启需重新设置或生成。损坏、非法结构、非普通文件或符号链接返回503并阻止私人访问，不悄悄关闭验证。更改设置需认证、confirmed和expectedRevision，旧页面409，不自动重放失败写入。Cookie登录元数据不改变设置修订。

- `PI_WEB_TOKEN` 非空时强制启用，优先于网页开关，网页不能修改部署 Token。服务端现有 Token 可直接用于 Bearer 或网页登录，不新增最小长度限制破坏旧配置；新网页设置要求16字符以上。
- `PI_WEB_SECURE_COOKIE=true` 用于 HTTPS 反向代理，使 Cookie 带 Secure，并按 HTTPS 验证 Origin。代理必须终止TLS、转发原 Host，并限制后端入口。程序不自动信任任意 X-Forwarded-*。HTTP个人网络保持默认false。
- Token、认证状态文件、登录 Cookie 和配置备份不得进入分享包或日志。

忘记 Token 或配置损坏时，在服务器运行，明确使用和服务相同的 Agent 目录：

```bash
PI_CODING_AGENT_DIR=/absolute/path/to/instance-agent npm run access:reset -- --disable --confirm
```

默认目录实例可以省略该变量。命令不加载项目 `.env`，保留原文件为0600的 `.reset-<time>-<id>`，然后关闭网页管理的验证并清空登录。服务器下次校验读取新修订；不修改 Provider 身份、Pi 会话或媒体。若服务 `.env`/systemd 仍设置 `PI_WEB_TOKEN`，它依旧强制启用，应在该部署配置中修改后空闲重启。脚本拒绝符号链接并不输出凭据。

## Agent 与 CLI Package

主服务生成仅进程内使用的 `PI_WORKSPACE_INTERNAL_TOKEN`，并在监听成功后按实际绑定地址/端口确定 `PI_WORKSPACE_INTERNAL_ORIGIN`（通配监听使用loopback）。受管Package优先使用该所属实例地址，不受外层shell遗留的PI_WORKSPACE_BASE_URL影响。受管 Pi 子进程继承它，只可访问列出的 GET能力/协议以及 POST规划/接入校验端点，不能访问会话、配置、媒体、生成或删除。它独立于用户访问 Token，更换网页登录 Token 不破坏已有 planner。该环境凭据不进入模型输入，但完整 Agent 与同系统用户并非OS沙箱。

Package 只有目标 origin 精确匹配当前内部 origin 才携带内部凭据，fetch拒绝重定向。独立 CLI 使用显式 `PI_WORKSPACE_BASE_URL` 和 `PI_WORKSPACE_ACCESS_TOKEN` 配置自己的访问 Token；不在未配置 base URL 时将凭据发到默认服务，也不将 Token 放入命令参数或工具结果。给另一服务设置环境时不要复制本实例内部凭据。从受管Agent启动面向另一工作台的独立CLI时，应显式移除两个PI_WORKSPACE_INTERNAL_*变量，再设置目标地址与用户Token。

## API

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/access/status` | 公共最小状态 `{accessControl,enabled,authenticated}`；不返回项目、版本目录或凭据 |
| GET | `/api/access/settings` | 已授权设置状态、source、editable、revision、hasToken、Cookie期限策略 |
| POST | `/api/access/login` | `{token,remember?}`；成功Set-Cookie，不回传Token/Cookie |
| POST | `/api/access/logout` | `{}`；撤销当前Cookie，并清除浏览器Cookie |
| POST | `/api/access/revoke` | `{}`；撤销全部Cookie，保留Bearer Token |
| PUT | `/api/access/settings` | `{enabled,token?或generate:true,confirmed:true,expectedRevision}`；开启/更换自动登录当前浏览器，生成时仅本次返回generatedToken |

所有写入上述 API 要求 `X-Pi-Access: 1` 和 JSON body。无授权401、Origin/CSRF或环境锁403、修订冲突409、限流429、配置读取/保存失败503。成功后响应丢失可能表示写入已完成，应先核对状态，不自动重新生成或重发。

## 验证

访问控制专项覆盖认证、同源/CSRF、撤销、配置失败、内部凭据和恢复，入口见[模块导航](development/MODULES.md)。测试使用独立身份和合成媒体；planner fixture 必须覆盖内部 origin/Token，不能继承真实实例地址。发布范围见[平台验证](RELEASE_INSTALL_VALIDATION.md)。

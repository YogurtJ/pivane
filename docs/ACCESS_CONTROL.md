# 工作台访问控制

2026-09-11 Windows存储补充：访问/通知/预约文件在创建时携带受保护DACL，允许当前用户、SYSTEM和管理员；关键写入用可写句柄fsync与MoveFileEx写透替换。专用Pi目录和私有导出目录单独保护，不修改系统Temp的ACL。POSIX模式验证继续保留，Windows以实际ACL及反向开放测试验证；恢复命令的备份也必须私有。范围见WINDOWS.md。

实现日期：2026-09-09。统一入口由 `/api/access/status.accessControl=true` 与已认证的 `/api/pi/status.accessControl=true` 标记；代码完成不等于生产进程已加载。

## 使用方式

默认保持免认证，兼容个人受信网络。设置 → 访问控制可以开启/关闭验证、自行设置 16–256 位英文字符、数字或符号（ASCII、不含空格）的 Token，或生成 32 字节随机 Token。开启/更换成功后当前设备自动登录；生成的 Token 仅在本次成功响应和当前设置页展示，离开后清除。已有 Token 永不回显，也不保存到网页 storage、URL 或 Pi 原生 Provider 凭据库。

开启验证后，网页使用 HttpOnly、SameSite=Strict、host-only、Path=/ 的 Cookie；Cookie 名按实例配置路径区分。同一 Host 的不同端口不构成浏览器安全隔离，应只共同托管受信服务。普通登录服务器有效期 12 小时，Cookie 不设 Max-Age；勾选“记住此设备”为 30 天。浏览器可能恢复会话 Cookie，因此普通登录不能承诺关浏览器立即退出。有效登录可跨服务重启恢复。

Token 修改撤销全部旧 Cookie 和旧 Token；“撤销所有登录”只撤销 Cookie，程序 Bearer Token 继续可用。“退出当前登录”只撤销当前 Cookie。开启、关闭或换 Token 会改变认证修订，旧 WebSocket 失效；服务器在消息接收、输出与每15秒检查登录有效性。失效网页连接会关闭，但持久 worker 继续原任务；临时会话和 BTW 侧聊按原断线语义结束。已接受的 HTTP/远端生成任务不因此取消，也不会自动重放。

重新登录不刷新整个页面，不清理主输入框未发送草稿。登录覆盖层使其他界面不可交互、暂停媒体，并关闭当前原生 dialog；不代替用户回答扩展确认。已下载或已在浏览器内存中的内容不能远程撤回。新浏览器只取得公开页面资源，私人数据请求需认证。

2026-09-10 登录界面静态优化：使用本地π品牌图标和独立卡片布局，输入框、复选框及按钮不再混用旧弹窗尺寸；浅色/薄荷/深色主题共用结构。提供输入提示、Token显示/隐藏、登录中反馈和可展开帮助；解锁或再次要求登录时恢复隐藏。窄屏/低高度窗口允许滚动，键盘焦点循环包含帮助入口。刷新页面即可生效，不改变认证、保存或会话规则。

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

网页配置位于 `<PI_CODING_AGENT_DIR 或 ~/.pi/agent>/pi5-access.json`。文件使用0600、同目录临时文件、fsync后原子rename；不写工作台普通偏好或原生 auth.json。仅保存盐与scrypt校验值、配置修订、最多64条登录标识的SHA-256与期限，不保存原 Token 或原 Cookie。一个配置文件只由一个服务进程管理。

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

`test/workspace-access.test.js` 覆盖开关、同源与Cookie CSRF、Token/登录持久化、轮换/退出/撤销、过期、修订、损坏/断链文件、权限、内部凭据范围、限流与本地恢复。`test/workspace-access-http.test.js` 在独立完整服务检查旧API/媒体/编码路径、公共资源、Range/no-store、原生Cookie WS与撤销后持久worker保留。`test/media-lab-rpc.test.js` 用原生受限Pi＋本地模型fixture验证已鉴权规划、无票据/JSONL/模型凭据泄漏。

接入planner的RPC fixture同样必须显式覆盖内部origin/Token，不能从运行测试的受管Agent继承真实工作台地址。

`test/browser/workspace-access.cjs` 只允许隔离实例，验证1440/393/320px、三主题、登录开关/设置、随机Token一次展示、免storage Cookie、全新浏览器登录页、退出/撤销、草稿保持、字段对比度与内部宽度。登录页另检查卡片实际留白、复选框宽高、品牌图片、显示/隐藏、帮助焦点循环和420px低高度滚动，并保存三视口×三主题截图 `/tmp/pi-login-ui-*`。截图在 `/tmp/pi-access-*`。既有设置/附件/正文/实验室/朗读/导出回归仍需通过。附加隔离浏览器验收用合成PNG/WAV/MP4，实际验证启用Cookie认证后的图片解码、音视频播放/跳转、下载、退出拒绝和sandbox Mermaid渲染，不调用模型或生成服务。

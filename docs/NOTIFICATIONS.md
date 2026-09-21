# 系统通知

通知入口位于设置 → 使用偏好 → 通知与提醒。默认提供页面系统通知和提示音，后台 Web Push 为默认折叠的可选增强；所有开关默认关闭，不自动申请权限。

## 页面提醒（2026-09-10 优化）

`public/pi-page-notifications.js` 独立管理本浏览器的页面系统通知与提示音。localhost/127.0.0.1 或可信HTTPS可申请Notification权限，桌面直接调用Notification，Android/iOS主屏幕使用Service Worker.showNotification；不创建PushSubscription、不请求VAPID、不连接外部推送服务。iOS普通标签页不提供系统通知开关。局域网HTTP可以使用站内提醒及用户开启的页面提示音；标签隐藏时在标题增加提醒计数，返回可见时清除。

当前线程的原生打开/结束消息快照在已读确认前同步completion标记，和轮询共用去重，避免本页已读抢先消除提醒。页面打开且至少一个本地开关开启时，每5秒只读现有 `/api/pi/activity`，不因隐藏标签停止主动轮询（浏览器仍可节流/休眠）。第一次成功响应仅建基线，不重报旧回复；随后按completionId/完成时间及已观察runtime的waiting/error状态变化提醒。manual未读不触发；失败请求保留上次基线，不制造任务失败。一次轮询多个事件合并为一条，seen最多512条。快速变化后已消失的状态、另一设备迅速已读的回复可能无法观察到，不是必达事件队列。

仅保存desktop/sound布尔偏好和最近一次提醒时间戳到localStorage，不保存正文/路径或平行历史。安全上下文通过Web Locks串行竞争提醒，并用4.5秒时间戳避免多个标签同时响铃；HTTP退化为尽力的共享时间戳抑制。后台推送订阅有效时本页抑制自动本地提醒，测试仍可显式触发。登录失效丢弃迟到轮询，重新登录重建基线。

提示音用本地Web Audio短音，不用TTS或生成API；开关/测试点击尝试解锁，刷新后可能需再次点击，系统可阻止播放。页面系统通知不依赖推送服务，但仍要求页面在运行；关闭/休眠/锁屏不可承诺送达。点击仅聚焦工作台，不导航或自动已读。

新UI使用独立 `public/pi-notifications.css`，标题、两条开关、状态/测试分别成行；后台推送与帮助默认折叠，移动端操作为两列。后台状态仅展开或检测已有订阅时读取，普通首次访问不初始化通知密钥。此优化是静态文件变化，已有activity后端可用；Web Push仍需browserNotifications后端及浏览器条件。

## 通知范围

服务管理的持久 Pi 会话在成功最终回复的 `agent_settled`、最终失败、收到 confirm/select/input/editor 待确认请求时发送通知。过程消息、单个工具失败、自动重试中间态、正常停止、手动标记未读不触发通知；临时会话、BTW、媒体生成及外部终端任务暂不通知。

以下为可选后台推送的行为。启用推送的设备都会收到通知，包括正在看网页的设备。不把通知视为已读确认，也不改变站内未读。通知只包含通用状态和随机事件 ID，不发送正文、项目路径、会话名称、工具参数或错误详情。点击通知优先聚焦已有工作台窗口，保留其草稿和当前线程；没有窗口时打开首页，需登录时正常登录。不会自动发送消息或响应 Agent 确认。

## 手机与电脑

- 使用可信 HTTPS 地址；服务器本机的 localhost 是浏览器开发例外。局域网或 Tailnet 的 HTTP 地址不能启用 Web Push，网络隧道加密不改变浏览器的安全上下文要求。
- 电脑使用支持 Web Push 的新版 Chrome、Edge、Firefox 或 Safari。Android 使用支持 Web Push 的新版浏览器。
- iPhone / iPad 需要 iOS / iPadOS 16.4 或更新版本；在 Safari 打开 HTTPS 网站并“添加到主屏幕”，再从主屏幕启动并点击启用。普通 Safari 页签不能代替此安装步骤。
- 在浏览器弹出的权限提示中允许通知，并允许系统对该浏览器／主屏幕应用显示通知。拒绝后需要在网站或系统设置中恢复，网页不能强行再次弹窗。
- 锁屏或页面关闭后由推送服务唤醒 Service Worker。设备、Pi 服务器都需能联网访问浏览器推送基础设施；强制退出浏览器、省电、勿扰、系统策略可能延迟或阻止显示。声音由系统控制，没有网页自定义提示音。
- 测试接口成功只表示推送服务接受请求，不是手机已显示的回执。真实手机授权、锁屏显示仍需在目标设备验证。

## 后端与数据

`server/pi-notification-service.js` 接收 Supervisor 的 metadata 事件。独立 `pivane-notifications.json`（既有 `pi5-notifications.json` 自动沿用）位于工作台访问配置的同一 Agent 目录，保存 VAPID 密钥对、订阅 endpoint/加密公钥以及授权身份摘要；0600、临时文件原子替换。首次显式启用才生成密钥文件，不写 Pi auth.json、session 或聊天历史。最多64台设备；该文件是私人配置，不分享、不通过文件查看器读取。不能同时由多个服务进程管理。

订阅绑定当前登录身份；每次发送重新检查授权与订阅修订。退出对应 Cookie 登录、登录过期、撤销或更换访问配置后旧订阅不再发送，重新登录后显式启用即可重新绑定。免认证实例订阅只在原免认证修订仍有效时工作。已交给远端推送服务的通知无法撤回，最多保留300秒；关闭通知会停止后续服务器发送并取消浏览器订阅，不撤销系统权限。

推送 endpoint 只允许 HTTPS 的 FCM、Mozilla、Apple 和 Windows 浏览器服务域名，不允许用户自定义 URL、凭据、端口、重定向或内网地址。固定 `web-push@3.6.7` 实现标准加密与 VAPID；subject 为中性应用 URL，不需要个人邮箱。404/410订阅移除；其他失败不重试、不记录远端正文或私有 endpoint。事件 ID 有界内存去重512条；最多4个事件并行、每事件4设备并行、单请求10秒。过载事件可能丢弃，不提供持久投递队列或必达保证，站内未读仍是可靠的待阅入口。

`public/pi-notification-sw.js` 只处理 push／notificationclick，不拦截 fetch、不缓存页面、API或媒体，不提供离线模式。通知设置不自动替换其他应用的 Service Worker。新文件受静态资源允许清单管理，后端新进程 `/api/pi/status.browserNotifications=true` 才表示上线。

## API

前缀 `/api/pi/notifications`，复用全站认证、Origin／CSRF。响应 `Cache-Control: no-store`。浏览器写请求带 JSON 和 `X-Pi-Access: 1`，不允许内部 planner 身份调用。

| 方法 | 路径 | 参数／返回 |
|---|---|---|
| GET | `/` | `{supported:true}`，不创建密钥 |
| POST | `/key` | 显式初始化并只返回 `{publicKey}` |
| POST | `/status` | `{subscription}`，返回当前订阅是否有效 |
| PUT | `/subscription` | `{subscription}`，规范化并绑定当前身份，返回 `{enabled:true}` |
| DELETE | `/subscription` | `{subscription}`，只移除对应 endpoint，返回 `{enabled:false}` |
| POST | `/test` | `{subscription}`，仅测试已保存且有效的订阅，每端点10秒一次；返回 `{accepted:true}` |

subscription 是浏览器 PushSubscription.toJSON() 的 endpoint 与 keys.p256dh/auth。不返回已保存订阅列表、其他设备密钥、身份摘要或 VAPID 私钥。错误请求400，未登录401，访问来源拒绝403，配置不可读503；损坏配置不会被自动覆盖。

## 部署与验证

更新后端需要实例空闲。按[访问控制](ACCESS_CONTROL.md)配置独立HTTPS来源、安全Cookie、代理和来源验证；不要覆盖其他应用的入口。401不代表实例空闲。

验证命令：

```bash
node --test test/pi-notifications.test.js
PLAYWRIGHT_MODULE=/path/to/playwright PI_NOTIFICATION_TEST_URL=http://127.0.0.1:3131 node test/browser/pi-notifications.cjs
node --test --test-concurrency=1 test/*.test.js
npm run check
npm audit --omit=dev
```

单元测试使用临时配置和模拟推送发送器；浏览器专项使用模拟权限／PushManager和API，覆盖桌面1440px、手机393/320px的启用、关闭、测试、拒绝和内部宽度。自动化不代表 Safari 真机或外部推送服务实测。

专项覆盖通知设置三视口/三主题、桌面Notification与Android showNotification模拟、无VAPID初始化、旧/手动完成标记排除，以及正文/工具/重连；系统授权和真机锁屏需在目标设备验证。

# Pivane 开发文档

这些文档保存可复用的技术约束，应与源码一起版本管理。维护者机器地址、临时部署脚本、会话交接和原始测试日志使用被忽略的本地记录目录。

- [架构与数据流](ARCHITECTURE.md)
- [中英文界面文案与浏览器偏好](../I18N.md)
- [版本与发布流程](RELEASING.md)
- [贡献约定](../../CONTRIBUTING.md)
- [源码Agent约定](../../AGENTS.md)
- [API契约](../API.md)
- [原生文件系统组件](../../native/README.md)

## 验证入口

```bash
npm test
npm run check
npm run check:docs
npm audit --omit=dev
npm run pack:trial
```

Node用例位于test/，浏览器专项位于test/browser/。浏览器脚本的URL/CHROMIUM_PATH支持情况应查看该脚本；PLAYWRIGHT_MODULE可指定已安装的Playwright。不要把测试脚本的默认地址当成用户部署地址。模拟API的浏览器测试不代表真实供应商或Safari真机验收。

测试实例必须指定独立Agent/媒体/预约/项目路径和本实例URL，并清除不需要的继承认证。真实安装演练使用test/release的合成Provider与哨兵保护；未满足保护条件不要绕过执行。默认npm test通过Node枚举文件并串行执行，不依赖shell通配符，Windows和POSIX执行同一组用例。

公开功能文档中的“实现与验证”部分是相应模块契约的补充。新增参数、预算或错误状态时同时维护，避免只改代码或只更新入口文案。

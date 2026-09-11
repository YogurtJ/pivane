# 数学公式渲染

Pi WebUI 的主聊天回复、BTW 侧聊回复与 Markdown 文件预览共用本地 KaTeX 0.18.7。刷新页面生效，无需重启服务。已有会话仍保存原始 Markdown，重新打开后按新渲染器显示。

当前 Pi 0.85.0 的终端 Markdown 组件内置 `renderLatex` 和 LaTeX tokenizer，用终端字符布局展示公式；RPC 传递文本而非终端布局。WebUI 使用独立浏览器排版，不修改 Pi 依赖或原生 JSONL。原生 HTML 导出仍由上游模板决定，不因这次网页更新自动增加 KaTeX。

## 写法

- 行内：`$E=mc^2$` 或 `\(\frac{a}{b}\)`。
- 独立公式：`$$ ... $$` 或 `\[ ... \]`，允许多行。
- 完整 `math` / `latex` 围栏：整块按独立公式排版。普通代码围栏和行内代码保留源码；完整 LaTeX 文档应使用普通 `tex` 围栏查看源码。
- 支持 KaTeX 的分式、根式、上下标、积分、求和、矩阵和 aligned 等数学环境；不是完整 TeX 文档编译器。
- 单美元公式内部首尾不能是空白，闭合美元后不能紧接数字，以避免常见 `$5 和 $10` 价格误判。文字中的美元建议写成 `\$`；有歧义时公式使用 `\(...\)`。

流式未闭合公式不提前排版；闭合后和最终快照自动渲染。语法错误、未知命令和超限保留可读源码；不受信任的链接/HTML/图片命令被禁用，可能由 KaTeX 显示为不支持的命令。长公式在自身区域横向滚动，不撑宽主消息区。明暗主题继承正文颜色。回复与文件复制继续使用原始 Markdown/LaTeX，不从排版 DOM 反推内容。用户问题、工具、思考与历史搜索纯文本预览沿用原展示。

## 实现与边界

`public/pi-math.js` 为每次共用 Markdown 渲染创建独立 Marked 实例和公式 token，避免 Markdown 提前吃掉 TeX 的反斜杠、下划线或尖括号。普通 Markdown 仍经原 DOMPurify 策略，禁止模型提供 style、事件与 iframe。清理后只替换本次 renderer 创建的公式槽位；KaTeX 生成的 HTML/MathML/SVG 单独清理后才插入，只有库的排版结果允许样式。不放宽原 Markdown 的权限，不加载公式指定的图片、链接或外部资源。

固定 `trust=false`、`strict=error`、独立 macros 对象、`maxExpand=200`、`maxSize=20`。单公式最多10000字符，单次扫描最多20004字符，每份 Markdown 最多排版128项；超出按原文展示。生成标记上限256000字符。页面缓存最多128项且 key/HTML 总计最多1000000个UTF-16代码单元，不落盘、不保存浏览器历史。代码不执行命令或模型调用。

本地静态文件来自 npm 官方 `katex@0.18.7` 的 dist JS/CSS/fonts，许可证为 MIT，保留在 `public/vendor/katex-0.18.7/LICENSE`。不改变主项目依赖或 Pi 版本；浏览器从当前实例加载全部字体。打包脚本显式包含 JS/CSS/LICENSE 与该版本目录内的 KaTeX 字体文件。

SHA-256：

```text
10a91b479cd927446ceb60409fb0d72b5d0d05eaf446c9e52fafd64058c84540  katex.min.js
50d9c78e03da144a021001b7de679133355179bcb06fd11e9e309223056a03dd  katex.min.css
```

更新时在独立临时 npm 目录安装精确版本并 audit，复制官方 dist 与许可证，修改版本路径/允许清单和哈希，再运行专项及 Markdown 相关回归。

## 验证

```bash
PLAYWRIGHT_MODULE=/path/to/playwright PI_MATH_TEST_URL=http://127.0.0.1:3001 node test/browser/pi-math.cjs
npm test -- --test-concurrency=1
npm run check
npm audit --omit=dev
npm run pack:trial
```

专项使用系统 Chromium 与 mock API/WebSocket，检查1440/393/320px、三主题、分式/积分/矩阵/围栏、代码与货币排除、共享侧聊/预览渲染、流式闭合/settled、注入/递归/超长输入、公式预算及内部横向宽度；不操作真实会话或调用模型。截图位于 `/tmp/pi-math-*.png`。手机测试是 Chromium 仿真，未进行 Safari 真机验证。

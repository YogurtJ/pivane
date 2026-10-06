# 数学公式渲染

Pivane 主聊天、侧聊回复与 Markdown 文件预览共用本地 KaTeX；会话保留原始 Markdown，浏览器负责排版。版本与许可证见[第三方声明](../THIRD_PARTY_NOTICES.md)。

网页排版不修改 Pi 依赖或原生 JSONL；HTML 导出是否支持公式由上游模板决定。

## 写法

- 行内：`$E=mc^2$` 或 `\(\frac{a}{b}\)`。
- 独立公式：`$$ ... $$` 或 `\[ ... \]`，允许多行。
- 完整 `math` / `latex` 围栏：整块按独立公式排版。普通代码围栏和行内代码保留源码；完整 LaTeX 文档应使用普通 `tex` 围栏查看源码。
- 支持 KaTeX 的分式、根式、上下标、积分、求和、矩阵和 aligned 等数学环境；不是完整 TeX 文档编译器。
- 单美元公式内部首尾不能是空白，闭合美元后不能紧接数字，以避免常见 `$5 和 $10` 价格误判。文字中的美元建议写成 `\$`；有歧义时公式使用 `\(...\)`。

流式未闭合公式不提前排版；闭合后和最终快照自动渲染。语法错误、未知命令和超限保留可读源码；不受信任的链接/HTML/图片命令被禁用，可能由 KaTeX 显示为不支持的命令。长公式在自身区域横向滚动，不撑宽主消息区。明暗主题继承正文颜色。回复与文件复制继续使用原始 Markdown/LaTeX，不从排版 DOM 反推内容。用户问题、工具、思考与历史搜索纯文本预览沿用原展示。

## 实现与边界

`public/pi-math.js` 为每次共用 Markdown 渲染创建独立 Marked 实例和公式 token，避免 Markdown 提前吃掉 TeX 的反斜杠、下划线或尖括号。普通 Markdown 仍经原 DOMPurify 策略，禁止模型提供 style、事件与 iframe。清理后只替换本次 renderer 创建的公式槽位；KaTeX 生成的 HTML/MathML/SVG 单独清理后才插入，只有库的排版结果允许样式。不放宽原 Markdown 的权限，不加载公式指定的图片、链接或外部资源。

固定 `trust=false`、`strict=error`、独立 macros、`maxExpand=200`、`maxSize=20`。单公式最多10000字符、扫描最多20004字符、生成标记最多256000字符；每份 Markdown 的 TeX 总量限100000字符、排版输出限4000000字符，超限保留原文，不按公式数量截断。页面缓存最多128项且 key/HTML 合计不超过1000000个UTF-16代码单元，不落盘、不执行命令或模型调用。

本地静态文件来自 npm 官方 `katex@0.18.7` 的 dist JS/CSS/fonts，许可证为 MIT，保留在 `public/vendor/katex-0.18.7/LICENSE`。不改变主项目依赖或 Pi 版本；浏览器从当前实例加载全部字体。打包脚本显式包含 JS/CSS/LICENSE 与该版本目录内的 KaTeX 字体文件。

SHA-256：

```text
10a91b479cd927446ceb60409fb0d72b5d0d05eaf446c9e52fafd64058c84540  katex.min.js
50d9c78e03da144a021001b7de679133355179bcb06fd11e9e309223056a03dd  katex.min.css
```

更新时在独立临时 npm 目录安装精确版本并 audit，复制官方 dist 与许可证，修改版本路径/允许清单和哈希，再运行专项及 Markdown 相关回归。

## 验证

专项为 `test/browser/pi-math.cjs`，使用独立静态服务及合成 API/WS，检查公式、流式闭合、注入、预算和内部滚动。通用执行范围见[开发流程](development/WORKFLOW.md)，平台结果见[验证范围](RELEASE_INSTALL_VALIDATION.md)。

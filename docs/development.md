# Development

Local preview shell, screenshot scripts and the file map.

`preview/` 是一个不连 Miniflux、不依赖 Harness 的假数据外壳：用 Harness 的真实主题变量（`preview/tokens.css` 从 `dsh-client-ui-theme` 生成）把 `client.js` 渲染出来，方便在浏览器里点着改。

```bash
node preview/server.mjs        # http://127.0.0.1:5577
# 暗色：http://127.0.0.1:5577/?theme=dark
```

- 假数据在 `preview/data.mjs`：4 个分类、20 个虚构订阅源、131 条未读，分类/订阅源计数与条目数一致。
- `window.__ModuleLoader__` 与 `/rss-miniflux/api/*` 由 `preview/server.mjs` 模拟，图标用带首字母的 SVG 方块代替。
- 主题变量变了就重新从 `dsh-client-ui-theme/lib/client.js` 里取 `body{--dsw-static-*}` 和 `body{--dsw-alias-*}` 两段，覆盖 `tokens.css`；暗色取 `[data-ds-dark-theme]{--dsw-alias-*}` 一段，覆盖 `tokens-dark.css`。
- `?theme=dark` 给 `<body>` 加 `data-ds-dark-theme`，样式与 Harness 暗色一致，改界面时明暗各看一遍。
- 条目接口按 `limit/offset` 分页、支持 `order=created`，和 Host 的行为一致，能直接验「滚到底加载」。
- 示例正文现在由真清洗器（`lib/html.js`）过一遍：带相对路径图片、`language-js` 代码块、两条脚注和页内链接，所以预览里看到的就是 Host 实际会发出的 HTML。
- 要截图而不想手点：`node tests/reader-shot.mjs --out /tmp/ringo --theme light --surface paper --note --settings`，会打开首条（或 `--row` 命中的那条）、滚到图片与代码块、按需弹脚注与设置页，并打印文章盒/图片边界/脚注卡片尺寸。
- 只是开发工具，不参与插件打包（`package.json` 的 `files` 不含 `preview`）。

## 文件

```
index.js            Host：设置、Miniflux 访问、HTTP API、六个工具、对话简报（工具）
client.js           Client：侧栏入口 + 三栏面板 + Manage / Accounts 弹层（React，无构建步骤，英文界面）
lib/cache.js        Host 端 TTL + stale-while-revalidate 缓存（可按前缀精确保留）
lib/miniflux.js     Miniflux v1 客户端（条目、分类、计数、已读、收藏、刷新）
lib/digest.js       未读分析：分布、时间线、标题呼应、推荐打分
lib/html.js         清洗 / 纯文本 / Markdown / 目录 / 阅读时长
lib/briefing.js     简报 prompt、输入拼装、JSON 解析
lib/demo.js         未连接时的示例条目
tests/              单元测试、假 Miniflux 端到端测试、reader-shot 截图脚本
locale/             插件元数据（名称 Miniflux digest）
preview/            假数据预览外壳（server.mjs + data.mjs + tokens.css/tokens-dark.css），不打包
docs/               Nextflux 能力对照、Ringo 阅读主题取舍与补齐计划
```

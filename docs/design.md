# Design notes

Why the panel works the way it does, and how it compares with Nextflux.

- **分类图标来自 Lucide。** `https://lucide.dev/icons/` 的 ISC 许可图标以内联 SVG 嵌进 `client.js`，按分类名关键词映射；未命中用 `folder`。不引外部图标字体或运行时请求。

- **只做 Miniflux，不自建订阅源。** 抓取、去重、全文抽取、已读状态都交给 Miniflux；插件只负责「读得明白」和「推荐得有理」，不会出现两套未读状态。
- **底稿是启发式，不假装 AI。** 分类/来源/时间分布、标题相似度、体裁词表都是可解释的规则；真正的综述由对话里的模型基于工具返回的条目来写。工具说明里明确要求「不要编造条目之外的事实」。
- **视频只取三家的官方地址。** YouTube / Bilibili 从条目 URL 或原文 iframe 提取 `provider + id`，客户端用带 sandbox 的 iframe 重建（`youtube-nocookie.com`、`player.bilibili.com`），sanitizer 仍然丢弃所有 iframe。X 不嵌卡片：Host 调 `cdn.syndication.twimg.com` 取推文的最高码率 mp4（5 分钟内存缓存），客户端用原生 `<video>` 播放，正文仍用 feed 自带的文字。X 视频保持原始比例但不放大、居中显示，高度上限 `min(380px, 55vh)`，竖屏视频不会撑满阅读区；feed 正文里自带的 `<video>` 也套同一上限，并在清洗时补上 `controls` / `playsinline` / `preload=metadata`。
- **图标永远有东西可画。** 每个源的真图标要么来自本地图标库，要么来自 `/icons` 批量接口，两者都没有时画首字母色块（色相由标题哈希决定，同一个源永远同色），真图标到了淡入覆盖。这样既没有空洞、没有跳动，也不会因为侧栏有 200 个源就打 200 个慢请求——只有滚到视野附近（提前 240px）的才会去取。
- **先画后更新，不先空白。** 客户端把上一帧（账号、目录、一页条目、当前正文）写进 localStorage，模块加载时同步读回来当首帧；挂载后在 `requestIdleCallback` 里静默重取一次，界面原地更新、不跳滚动。冷启动（没有快照）画骨架而不是空状态。这是照 Nextflux「先读 IndexedDB 再同步」的做法搬过来的，区别是面板只能用 localStorage：它的读取是同步的，正好能避免首帧先渲染空壳。
- **面板自带 border-box reset。** 宿主没有全局 `box-sizing` 重置（它的组件各自 opt in），所以 `client.js` 在 `.mrss-root` 子树里补了一条；否则搜索框、列表行会按 padding 撑宽，超出列表栏。
- **HTML 在 Host 侧清洗。** 阅读器用 `innerHTML` 渲染，所以清洗只有一处：标签白名单、属性白名单、链接只允许 http(s)/mailto/页内 fragment、`img` 加 `loading=lazy` 与 `referrerpolicy=no-referrer`。
- **排版标记在 Host 侧生成，客户端只认 `data-mrss-*`。** 正文里的 `class` 一律被清洗器丢掉，所以「这段是脚注」「这个代码块是 Python」这类判断只能在 Host 侧做一次：id 改写成 `mrss-N` 并同步改写 fragment 链接，脚注标 `data-mrss-fn` / `data-mrss-note`，代码块标 `data-lang`，空段落与重复标题直接删掉。客户端不做二次猜测，也不会因为源站换了 class 就失效。
- **暗色正文比标题暗一档。** 借自 Ringo：全亮正文在长文里会晃眼，所以暗色下正文按 88% 混入底色，标题保持最亮；`prefers-contrast: more` 时再拉回满对比。
- **令牌不进配置文件。** API 令牌写进本机凭据记录（`ctx.credentials`），面板只显示连接状态；也支持环境变量与 `config` 覆盖。
- **读接口用 resource，写接口用 handler。** 浏览器 HTTP 层只把 GET/HEAD 交给 resource 路由，所以 `POST /action`、`POST|DELETE /settings` 单独注册为 handler 路由。

## 对照 NextFlux 的能力

| NextFlux 能力 | 本插件 |
| --- | --- |
| 侧栏分类树：分类可展开看订阅源 | ✅ 改为横向分类 tab + 当前分类的订阅源列表；All tab 列出全部订阅 |
| 顶部刷新 + 添加订阅 | ✅ 侧栏右上角只剩刷新 / 新增两个按钮；设置收进底部账号菜单的 `Settings`（`?` 仍直达快捷键页）；新增出 New feed / Import OPML / New category 三项 |
| 多 Miniflux 账号保存与切换 | ✅ 每个账号独立凭据记录，切换后条目/分类全部换源 |
| 订阅管理（添加、改名、换分类、刷新、全部已读、删除） | ✅ 添加走独立弹框；其余都在侧栏订阅源/分类的右键菜单 |
| 分类管理（新建、改名、删除） | ✅ `+ → New category` 新建；分类 tab 右键改名/删除 |
| OPML 导入 / 导出 | ✅ 导出走 Miniflux `/v1/export`，导入提交原始 OPML |
| 站点图标 | ✅ Host 代理 Miniflux 图标；批量 `/icons` + Host 缓存（命中 7 天 / 无图标 1 天）+ 本地图标库 + 字母块占位，列表与侧栏显示 |
| 阅读偏好（字号、行宽、列表摘要） | ✅ 存在浏览器本地，随时可调 |
| 已读行为（打开即已读、滚动到底已读） | ⚠️ 仍在代码里生效（默认打开即已读），但新版设置面板未暴露开关 |
| 自动同步间隔 | ✅ 0 / 1 / 3 / 5 / 10 / 30 分钟 |
| 键盘快捷键 + 帮助 | ✅ `?` 打开 Shortcuts；`j k m s r g l /` |
| 明暗主题切换 | 跟随 Harness 主题，不自带主题选择器 |
| 多语言界面 | 面板固定英文（NextFlux 有四种语言） |
| PWA / 离线缓存 | 不适用：插件运行在 Harness Web 面板里 |
| 图片画廊手势、保存到第三方服务 | 未做 |
| 订阅源发现 / 目录搜索 | ✅ 粘贴站点地址即可发现该站点上的 Feed（`Find feeds`）；按关键词搜目录仍需第三方服务 |

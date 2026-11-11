# Known limitations

Edge cases worth knowing before you rely on a feature.

- 未配置时展示内置示例条目（10 篇、5 个示例源），顶部显示 `Demo data` 角标，方便先看面板效果。
- 图标另有本地库：`rss-miniflux:icons:v1`，按账号存，最多 300 个 / 1.2 MB，超出先丢最旧的；换账号会清空。没图标的源永远显示首字母色块，不会再出现空洞。
- 某个源图标第一次取要 0.4–2 秒（Miniflux 自己没抓过这个站时更慢），且要等 Host 之后才有缓存；这段时间显示字母块，不会跳动。
- 快照只保留第一页（60 条）：滚到很后面再离开，回来是第一页 + 总数，需要再滚；列表/正文滚动位置随快照恢复，但快速滚动后立刻重载页面可能差几行。
- `miniflux_briefing`（对话工具）需要 profile 里有可用模型；没有模型时工具会报错。
- `miniflux_briefing` 的输出语言跟随条目本身（多数条目用什么语言就用什么语言，混排时用中文）；面板文案固定英文。
- 列表一次加载 60 条，滚动或点 `Load more` 递增；没有做虚拟滚动，单次上万条的场景要等 P2。
- 封面图取正文第一张 `http(s)` 图片；正文只有相对路径或没有图片时不显示。
- 推理强度默认取最快档；要更深的综合分析，把它调到 high 或 max，代价是 2-3 倍耗时。
- 体裁估计是词表规则，只做「观点 / 资讯 / 混合 / 未判定」四档提示，不是分类器。
- 抓取原文（Readability 按钮或 `g`）依赖 Miniflux 的 scraper（`/fetch-content`），首次调用可能较慢；失败时回退到已存正文。
- `All` 与 `Starred` 用 `status=unread&status=read` 两次过滤实现全状态；Miniflux 默认只返回未读。
- 账号记录存在本机凭据服务里（索引一条 + 每账号一条）；旧版单账号记录会在首次读取时自动迁移，原记录保留作为回退。
- 删除订阅会连同该源的条目一起从 Miniflux 消失；删除分类会把其下订阅移到未分类。两个操作都会先弹确认。
- 批量收藏需要 Miniflux ≥ 2.3.2（`PUT /v1/entries` 的 `starred`）；更早版本自动退化为书签切换。分类未读数需要 ≥ 2.0.46（`?counts=true`）。
- Starred 过滤下侧栏的源按最多 1000 条星标条目统计，超出部分不计入；`/feed-stats` 结果缓存 60 秒，星标/取消星标后会重新拉取。
- `Find feeds` 依赖 Miniflux 的 `POST /v1/discover`（v2.0.0+）。发现失败、超时或站点没有任何 Feed 时，弹框会退化为直接订阅输入的地址；地址不是 Feed 时由 Miniflux 在订阅时报错，错误显示在弹框里。
- 面板界面固定英文（不随 Harness 语言切换）；Agent 工具说明与返回文本仍是中文。
- `miniflux_briefing` 只覆盖一个分类的未读，不会自动刷新；需要新结果就再调用一次。
- 面板按桌面宽度设计；窄屏下阅读栏会被挤到 300 px 上下，此时排版照旧（媒体出血也只剩 20 px）。
- 脚注只在「marker 能指向文中存在的 id，且形状像脚注」时启用（`fn*`、`_ftn*`、`#fn1`、上标数字、`↩` 返回链接）；自定义写法当普通页内链接处理，不做猜测。
- 代码块语言只认 `class="language-x"` / `lang-x` / 纯 token 这几种写法；认不出就只显示「代码」，不猜语言，也不做语法高亮。
- 媒体出血的上限是正文的内边距（宽栏 32 px、窄屏 20 px），不会铺到整个窗口；竖图仍然按比例缩到栏内。
- 「阅读底色：纸面」只换表面色、文字层级与链接色，不改 Theme color 选的主色；两者可以叠加。
- 视频只识别 YouTube / Bilibili / X：`b23.tv` 短链、需登录或受版权限制的视频仍会失败；X 的视频地址依赖它的 syndication 接口（取不到时只显示 feed 正文，不显示卡片）；嵌入内容都需要联网。
- 订阅栏的收起状态存在面板内存缓存里：切到对话再回来还是收起的，刷新页面会恢复展开。
- 颜色全部走 Harness 的 alias token（主按钮/激活页签 = `brand-primary` + `label-primary-foreground`，开关滑块 = `label-primary-foreground`，toast = `toast-bg`/`toast-label`）。暗色下 `brand-primary` 会翻成近白色，所以**不要**再给主按钮写死 `#fff` 文字；单选圆点用自定义 `.mrss-radio`，不依赖原生 `accent-color`。
- DSH 侧栏折叠后，窗口红绿灯和侧栏开关会浮在面板左上角。面板在 `[data-sidebar-collapsed]` 下按 `--dsh-frame-top-clearance`（48px）留出一条标题栏带，标题行不会被这些按钮压住；展开时不留这条带。
- RSSHub 推荐是模型给的路由，插件不预先逐个验证；公共实例可能限流或不可达，订阅失败会在添加弹框里显示 Miniflux 的错误。
- AI digest 的回答里的文件链接由面板自己的预览打开（文本 / 图片 / PDF）；Office、压缩包等二进制格式不内嵌预览，用「用默认应用打开」。只有 digest 会话被拦截，主会话仍走 Harness 右侧栏。
- AI digest 的条目数据由 Agent 通过 `miniflux_timeline` 等工具现取，因此会话里的内容会随 Miniflux 变化，不是打开那一刻的冻结快照。

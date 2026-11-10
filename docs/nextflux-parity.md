# Nextflux 能力对照与补齐计划

对照对象：[electh/nextflux](https://github.com/electh/nextflux) @ `6fe3f83`（2026-10-17，README + `src/` 全量读过）。
本插件：`rss-miniflux-deepread`。

另一份对照（阅读主题与交互细节）见 [ringo-reading-design.md](ringo-reading-design.md)，对象是 NetNewsWire 的 [nnw-ringo](https://github.com/jonastaedcke/nnw-ringo) 主题。

原则：**运行环境不同，不追求像素级复刻**。Nextflux 是独立 Web 应用（自带路由、IndexedDB 离线缓存、PWA、主题、i18n）；本插件是 Harness 里的面板，主题跟随 Harness、界面固定英文、数据只走 Host。矩阵里 `N/A` 的项是刻意不做，不是遗漏。

## 1. 侧栏与订阅源

| 能力 | Nextflux | 本插件 | 说明 |
| --- | --- | --- | --- |
| 顶部刷新 + 添加订阅 | `FeedListSidebar.jsx`（SyncButton / AddFeedButton） | ✅ 已有 | 标题下方小字显示同步时间；`+` 出 New feed（弹框）/ Import OPML（直接选文件）/ New category（弹框） |
| 同步状态文案（Syncing… / 上次同步） | `SyncStatus` | ✅ 已有 | 标题下一行：`Updated 16:24`（跨天带月-日），刷新时 `Syncing…`；未读合计留在 `All articles` 行 |
| 添加订阅（URL → 发现 Feed → 分类） | `AddFeedModal` + 外部 discover 服务 | ✅ 已补 | 独立弹框，不进设置；用 Miniflux 自带的 `POST /v1/discover`，不依赖第三方服务；发现失败回退直接订阅 |
| Articles 组随过滤条件变（Unread / Starred / All） | `ArticlesGroup.jsx` | ⚠️ 改为固定 All articles + 底部过滤条 | 底部 Tabs 已能切换三种过滤，避免两处状态重复 |
| 分类树 + 展开订阅源 | `FeedsGroupContent.jsx` | ✅ 改为横向分类 tab | 顶部一行 `All` + 分类 tab（按名称关键词映射 Lucide 图标，未命中用 folder；等分填满宽度，hover 显示名称/未读），点 tab 后在下方列出该分类的订阅源；没有折叠树 |
| 分类默认展开 | `defaultExpandCategory` 设置 | N/A | 不再有折叠/展开，当前分类的订阅源始终展示 |
| 打开某源时滚动到可见 | `FeedsGroupContent` 的 `scrollIntoView` | ✅ 已补 | 用 `p/n` 切换订阅时把当前源滚进视野 |
| 订阅源右键菜单（刷新 / 全部已读 / 编辑 / 退订） | `FeedItem.jsx` | ✅ 已补 | 右键或行尾 `···`；编辑弹层含标题、分类、Feed URL（只读、可一键复制），以及「Open in Miniflux」跳转 `{base}/feed/{id}/entries` |
| 订阅管理（编辑 / 换分类 / 全部已读 / 退订 / OPML） | 设置里的 Feeds 页 | ✅ 已补 | 都在侧栏：订阅源行右键/`···`，OPML 在 `+` 菜单（导入直接弹文件框、导出直接下载）；没有独立管理弹框 |
| 分类右键菜单（重命名） | `FeedsGroupContent.jsx` | ✅ 已补 | 另加「本分类全部已读」 |
| 解析错误标记 | `FeedItem` 的 warning 图标 | ✅ 已改 | 源名称紧跟一枚黄色三角（Lucide `triangle-alert`，12px）；tooltip 两行：`The last refresh of this feed failed` + Miniflux 返回的报错原文；长名称截断后图标贴在省略号后面 |
| 隐藏订阅源（`hide_globally`） | 设置项 `showHiddenFeeds` | ⏳ P2 | 需要 Miniflux ≥ 2.2.6，且要改 feeds 列表字段 |
| 订阅源发现 / 搜索 | `AddFeedModal` + 外部服务 | ⚠️ 部分 | 按站点 URL 发现 Feed 已用 Miniflux `/v1/discover` 实现；按关键词搜 Feed 目录仍需第三方服务，不在 Host 内做 |
| 多账号切换 / 注销 | `AddAccountModal` / `LogoutModal` | ✅ 已补 | 侧栏底部 Switch account 菜单切换；Accounts 弹框添加/删除账号（删除本机凭据），设置里不再有 Account 页 |

## 2. 列表

| 能力 | Nextflux | 本插件 | 说明 |
| --- | --- | --- | --- |
| 分页 / 无限滚动 | `ArticleListContent.jsx` 的 `endReached` + `currentPage` | ✅ 已补 | 滚到底自动加载下一页，另有 `Load more · N` 兜底；列表头不再显示 `120 / 207`（侧栏已有计数） |
| 虚拟列表 | `Virtuoso` | ⏳ P2 | 一次最多 60 条递增，DOM 可控；上千条时再上虚拟化 |
| 卡片封面图 | `ArticleCardCover.jsx`（none/small/large） | ✅ 已补 | Host 从正文提取首图（`cover`），列表按偏好渲染 |
| 标题 / 摘要行数 | `titleLines` / `textPreviewLines` | ✅ 已补 | 1–4 行可调 |
| 收藏 / 未读过滤 | 底部 Tabs | ✅ 已有 | Starred / Unread / All；与侧栏订阅清单联动，只列有对应条目的源，计数也跟着变 |
| 已读弱化 | 卡片 opacity | ✅ 已补 | Dim read entries |
| 显示站点图标 | `showFavicon` | ✅ 已补 | |
| 条目右键菜单（已读 / 收藏 / 以上全部已读 / 复制链接 / 原文） | `ArticleCard` ContextMenu | ✅ 已补 | 行尾 `···` 同菜单 |
| 打开即已读 | `handleArticleClick` | ✅ 已有 | 偏好开关，默认开 |
| 滚动经过即已读 | IntersectionObserver | ✅ 已有 | 偏好开关；实现为阅读到 85% 标记 |
| 顶部范围菜单（订阅源：刷新/编辑/退订；分类：重命名） | `MenuButton.jsx` | ✅ 已有（侧栏） | 列表头不再放 `···`，让位给折叠/范围名/全部已读/搜索四个控件；订阅源行 `···`/右键、分类 tab 右键仍承载全部操作 |
| 排序字段（发布时间 / 抓取时间） | `sortField` | ✅ 已补 | Preferences 的 `Sort by` 里选发布时间 / 抓取时间；方向固定 Newest，面板不提供方向切换 |
| 全部已读 | `MarkAllReadButton`（图标 + 下拉） | ✅ 已有 | 列表头图标 + 文案按钮；Starred 下置灰（收藏不是未读队列），Unread / All 可用 |
| 多选 / 批量操作 | 无 | — | 不做 |

## 3. 阅读区

| 能力 | Nextflux | 本插件 | 说明 |
| --- | --- | --- | --- |
| 正文清洗 / 目录 / 进度条 | `ArticleBody` / `ArticleReadingRail` | ✅ 已有 | 目录 ≥3 个标题才出现 |
| 阅读导轨（分节刻度） | `ArticleReadingRail.jsx` | ✅ 已补 | 右侧刻度，点击跳转；偏好开关 |
| 字号 / 行高 / 行宽 / 字体 / 两端对齐 / 标题字号 | `Readability.jsx` | ✅ 已补 | 字体给了系统/黑体/宋体/等宽四档，不引外部字体文件 |
| 上一条 / 下一条 / 关闭 | `ArticleNavigationControls` | ✅ 已有 | 工具栏最左是关闭按钮（与 `Esc` 同一条路径），旁边是上/下一条；图标 + hover 文字 |
| 分享 / 复制链接 | `ArticleExternalActions` | ✅ 已补 | 工具栏 Share 只走 `navigator.share`（取消不误报）；不支持时回退复制 URL；「复制链接」在条目右键菜单里始终复制 |
| Readability / 无干扰阅读 | 无（Nextflux 只有自动隐藏工具栏） | ✅ 已补 | Readability 抓 Miniflux 原文正文并在原地替换（不闪白）；Full view 隐藏侧栏 + 列表，`Esc` 先退 Full view |
| 打开原文 | `ActionButtons` | ✅ 已有 | 工具栏 `Open in browser` 外链 + `v` |
| 抓取原文正文 | 内容切换 `g` | ✅ 已有 | 工具栏 Readability（与 `g` 同义）；原地刷新，失败只 toast |
| 图片画廊 + 手势缩放 | `ArticleImage` / `useZoom` | ⏳ P2 | 面板内手势与 Harness 冲突，先不做 |
| 音视频 / 附件播放 | `MediaPlayer` / `Attachments` | ⚠️ 部分 | YouTube / Bilibili 用官方 iframe 播放器（16:9）；X 取最高码率 mp4 用原生 `<video>` 播放、不渲染推文卡片；enclosure 附件、播客音频与其它站点播放器仍属 P2 |
| 单篇 AI 摘要 | `AISummary.jsx`（OpenAI 直连） | ❌ 不做 | 本插件用 Harness 的 `miniflux_briefing` 做分类简报，不另存 API key |
| 保存到第三方 | `integrations.js` | ⏳ P2 | 依赖 Miniflux integrations 配置 |
| 自动隐藏工具栏 | `useAutoHideToolbar` | ⏳ P2 | 面板高度小，隐藏后不易找回 |

## 4. 交互与全局

| 能力 | Nextflux | 本插件 | 说明 |
| --- | --- | --- | --- |
| 快捷键（j/k/m/s/f/v/g/p/n/Esc/Shift+N） | `useHotkeys.js` | ✅ 已补 | 另保留 `?` 帮助；面板没有 Briefing/列表切换键 |
| 搜索 | `SearchModal.jsx` | ⚠️ 已有内联搜索 | 服务端 `search` 参数，范围跟随当前过滤；不单独做弹窗 |
| 设置备份 / 恢复 | `Settings/Backup.jsx` | ✅ 已补 | 只导出阅读偏好（JSON），不含账号令牌 |
| 主题 / 明暗 | `themeStore` | N/A | 跟随 Harness |
| 多语言 | i18n 四语 | N/A | 面板固定英文（与 Harness 英文界面并列） |
| PWA / 离线缓存 | `sw.js` + Dexie（按账号分库，先读本地再同步） | ⚠️ 部分 | 不注册 Service Worker（面板不接管页面），但照它的思路做了「先画快照再后台更新」：账号 + 目录 + 首屏条目 + 当前正文存 localStorage，Host 侧目录走 stale-while-revalidate。差异与实测见 [loading-performance.md](loading-performance.md) |
| 移动端手势 | `useSwipeGesture` | N/A | 面板按桌面宽度设计 |
| 背景自动同步 | `syncService` | ✅ 已有 | 0/1/3/5/10/30 分钟，可见时才跑 |

## 5. 侧栏头部（2026-11-09）

- 单行四块：标题（下行小字是同步时间）→ 刷新 → 新增订阅菜单 → 设置；底部只剩账号行。
- 新增订阅三项都离开设置：New feed 开发现弹框，New category 开单字段弹框，Import OPML 直接触发隐藏的 file input。
- 侧栏收窄到 235px 以下时隐藏标题图标、按钮缩到 26px，标题不再被截断。
- 订阅与分类管理整体移出设置：订阅源右键/`···`、分类 tab 右键、`+` 菜单（New feed / New category / Import OPML / Export OPML）承载全部操作；不再有 Subscriptions 弹框；账号在侧栏底部 Switch account，设置只剩 Preferences / Shortcuts。
- 导航重构：去掉 `Briefing` / `All articles` 两行，改为横向分类 tab（All + Lucide 分类图标）+ 当前分类的订阅源列表；面板不再有 Briefing 页面，简报只保留为对话工具 `miniflux_briefing`。
- DSH 侧栏折叠时外壳把红绿灯和开关浮在面板左上角：面板按 `[data-sidebar-collapsed]` 留 48px 标题栏带（取自 `--dsh-frame-top-clearance`），展开时不占位。

## 6. 列表头（2026-11-10）

- 一行四个控件，从左到右：折叠/展开订阅栏 → 分类名（不带计数）→ `Mark all read`（只有 ✓，hover 浮出 `Mark all as read`）→ 搜索。
- 计数不进列表头：侧栏分类行已经显示未读/星标数，头部只留范围名。
- `Mark all read` 在 Starred 下置灰（`disabled` + 0.45 透明度）；Unread / All 下可用，作用域仍是当前订阅源 / 分类 / 全部。hover 提示做在按钮外层 `span` 上（`:disabled` 的原生 `title` 在 Safari 里不弹），Starred 下提示换成 `Not available in Starred`。
- 头部不再放刷新与 `···`：刷新在侧栏右上角与 `r`，订阅源/分类操作在侧栏行菜单。排序方向不在界面出现（固定 newest），字段在 Preferences 的 `Sort by` 里选。
- 折叠按钮收起的是面板自己的订阅栏（不是 DSH 侧栏）：收起后拖拽条一起消失，按钮变成展开入口，状态存在 `PANEL_CACHE` 里。

## 7. 布局、工具栏与嵌入（2026-11-10）

- **自带 `border-box`**：DSH 没有全局 reset（宿主组件用 `.X_card,.X_card *` 自己 opt in），插件此前只给 `.mrss-root` 设了 `box-sizing`。补上 `.mrss-root, .mrss-root *` 后，搜索框不再因为 100% 宽 + 18px padding/border 越出列表栏（实测越界 8px、高 40px），列表行也不再越出 24px 的内边距；宿主日后加 reset 也只是无操作。
- **搜索框**：`width:100%` + `max-width:100%`，在 336px 栏宽下左右各留 9–10px，28px 高。
- **阅读区工具栏**：从左到右 Close → Prev → Next → Read/Unread → Star → Share → Readability → Full view → Open in browser；全部纯图标，hover 用 `.mrss-tip` 浮出文字（`align="start"` 给左侧三个，避免盖住列表）。
- **Read/Unread 图标**：未读用空心圆 `circle`，已读换成 `circle-check`；Star 收藏后 `filled` 实心。状态由图标表达，tooltip 说明动作（Mark read / Mark unread）。
- **Readability**：调 Miniflux 的 `/fetch-content` 抓原文正文；`loadArticle(..., true)` 不再切到 `Opening…`，正文留在屏幕上，按钮转圈 + 禁用，失败只 toast（保留旧正文）。
- **Full view**：隐藏 feeds 侧栏与列表（`data-collapsed` / `data-hidden`，不卸载，列表滚动位置保留），正文在整栏居中；`Esc` 先退出 Full view，再按一次才关闭正文；关正文时状态自动复位。
- 右侧按钮组包进 `.mrss-reader-actions`（`flex-wrap:wrap` + `margin-left:auto`），980px 仍单行，900px 两行。
- **Copy / Fetch / Wide 不再占工具栏**：绑定 `c` / `g` / `w`，在 Shortcuts 表里可查；Copied / Fetching 的 toast 保留。
- **视频嵌入**：`extractEmbeds(html, entryUrl)`（lib/html.js）从原文 iframe 与条目 URL 提取 `{provider,id}`，最多三条；Host 把 `embeds` 放进 article payload，sanitizer 仍丢弃所有 iframe。YouTube / Bilibili 由 `ArticleEmbed` 重建 iframe（`youtube-nocookie.com/embed/<id>`、`player.bilibili.com/player.html?bvid|aid`，带 `sandbox` 与 `allowfullscreen`）。
- **X 不嵌卡片**：Host 用 `lib/tweet.js` 把 `cdn.syndication.twimg.com` 的响应归一成 `{text, videos[], images[]}`（最高码率 mp4、只允许 twimg 域名、5 分钟内存缓存）；客户端只渲染推文视频（无视频时什么都不加），正文继续用 feed 里的文字；正文为空时才用推文文字补位。视频不放大、居中，`max-height:min(380px,55vh)`，竖屏 1080×1920 落到 215×380，16:9 在 591px 栏宽下是 591×333；feed 正文自带的 `<video>` 套 `.mrss-article video` 同一上限，sanitizer 为它补 `controls` / `playsinline` / `preload=metadata`。
- 多档宽度实测：1440 / 1200 / 1100 / 980 / 900 下侧栏、列表、tabs 的 `scrollWidth` 均等于 `clientWidth`。

## 8. 上一轮补齐的内容

1. **Host**：`/entries` 支持 `order=created`；列表项带 `cover`（正文首图，绝对 URL）。
2. **侧栏**：订阅源/分类右键 + 行尾 `···` 菜单（刷新、全部已读、编辑、退订、重命名）；定位当前源；同步中文案。
3. **列表**：分页与自动加载、`n / total` 计数、封面图、标题/摘要行数、站点图标、已读弱化、范围菜单、条目右键菜单、排序字段。
4. **阅读**：分享、阅读导轨、字体/行高/两端对齐/标题字号。
5. **设置**：分成 Reading / Article list / Behaviour 三段，加偏好导出/导入/重置。
6. **键盘**：对齐 Nextflux 的映射，`?` 帮助表同步更新。

## 9. 下一轮（P2）

按优先级：虚拟列表（1000+ 条场景）→ 隐藏订阅源 → 附件与媒体播放 → 第三方保存 → 图片画廊 → 自动隐藏工具栏。

每一项都需要单独改动（前两项动 Host 与 Miniflux 版本兼容，后几项是纯前端组件），不与本轮混在一起。

## 10. 验证

- `node tests/digest.test.mjs`、`node tests/client-smoke.mjs` 通过。
- `preview/` 假数据里逐项点过：分页（60 → 120 / 207）、条目菜单、订阅源菜单、编辑弹层、Preferences 三段、封面图、阅读导轨、`f` 聚焦搜索。
- 侧栏在 headless Chromium 里点过：5 个分类 tab（All + 4 个 Lucide 分类图标）切换后标题与订阅清单同步、点订阅源后 tab 停在其分类；`p/n` 跨分类/订阅切换时订阅源滚进视野；200px 宽下 tab 可横向滚动；面板内没有 Briefing 页面或入口。
- 列表头在 headless Chromium 里点过：Starred 下 `Mark all read` 的 `disabled` 为 true，Unread / All 为 false；hover 时 `::after` 的 `content` 为 `Mark all as read`（Starred 下为 `Not available in Starred`）；头部没有计数字符串；暗色下 tooltip（toast token）与图标可辨。
- 折叠：点列表头最左按钮后订阅栏 `display:none`、拖拽条消失，再点恢复；`aria-expanded` / `aria-controls` 跟着状态变。
- 布局：模拟宿主 content-box 后搜索框仍贴合（右边缘距栏边 10px、高 28px），item 宽 = 栏宽 − 滚动条；阅读区工具栏 900px 下 `scrollWidth === clientWidth`、高度 117px（两行）。
- client bundle 更新交给宿主的插件热更新；设置弹层已移除 `Reload page` 按钮（2026-11），极少数情况才需要手动 `Cmd+R`。

## 10.5 分类图标改为手动配置（2026-11 追加）

- 取消按分类名正则猜图标（原 `CATEGORY_ICONS` 20 组中文/英文关键词匹配已删）。未配置的分类一律用默认图标 `folder`，新建分类同理。
- 入口：侧栏分类 tab 右键 → `Choose icon`；弹框标题带分类名，内含搜索框和 8 列网格。
- 图标库：`LUCIDE_ICONS` 扩到 94 枚（`lucide-static` 的 svg 内联进来，ISC 授权，见文件内声明），挑选顺序按主题分组写在 `CATEGORY_ICON_CHOICES`。
- 存储：`prefs.categoryIcons[`${accountId}:${categoryId}`] = 'icon-name'`，走 localStorage（随 Preferences 的 Export/Import 一起搬迁）；键含 accountId，换账号互不影响；图标名失效时回退默认。
- 交互：点图标即保存并关框；`Use default icon` 删掉该分类的映射；搜索框回车选中第一个匹配项；网格打开时自动把当前图标滚进视野。

## 10.6 订阅源排序与计数位置（2026-11 追加）

- 侧栏分类名右侧换成排序按钮：`arrow-down-a-z`（按名称）↔ `arrow-down-1-0`（按未读数降序，同数按名称），点击切换并写入 `prefs.feedSort`，随偏好导出/导入。
- `All` 视图不再按分类聚簇，整份列表统一按当前模式排序；选中某个分类时只排该分类下的源。
- 未读总数从侧栏分类名旁移到文章列表头的范围名右侧，并改为跟随**列表范围**而非侧栏分类：订阅源 → 该源未读数，分类 → 该分类合计，All → 全部合计；Starred 过滤下显示星标数。

## 10.7 底部账号区与 Logout（2026-11 追加）

- 折叠态：头像圆标（品牌色底 + 账户名首字母，未连接时为 `?`）+ 账户名 + 服务器域名两行（域名由 `baseUrl` 取 host），去掉原 `SWITCH ACCOUNT` 小标签；`title` 与 `aria-label` 仍带完整 URL。
- 菜单：标题 + 当前账户（`check` 图标、两行显示用户名与完整 URL）+ 其它账户 + `Add another account`（账号弹框）+ `Settings`（Preferences）+ `Logout`（danger）。菜单项新增 `sub` 字段支持第二行，`openMenu` 的高度估算按行高分别累加。
- `Logout` 走 Host 新增的 `accounts/action: logout`：删掉当前账户的 token 与索引项；有其它账户时自动接管；同时把 `baseUrl` 记进 `runtime.lastBaseUrl`，通过 bootstrap 的 `status.lastBaseUrl` 回传，账号弹框在未连接时预填该地址。token 来自 config / 环境变量时无法登出，Host 会返回 `not_connected`。
- 未连接时：底部只显示一行 `Not connected`，菜单不渲染前导分隔线。

## 10.8 Add account 弹框（2026-11 追加）

- 两种登录方式共用一个表单：默认 Basic Auth（Server URL + Username + Password），点 `API Token Auth` 切换成 Server URL + API token（带 `Miniflux → Settings → API Keys` 提示），分割线下方的按钮在 `API Token Auth` / `Basic Auth` 之间切换。
- Basic Auth 不在本地保存密码：Host 用 HTTP Basic（Miniflux `validateBasicAuth`，`store.CheckPassword`）验一次 `GET /v1/me`，再 `POST /v1/api-keys {"description":"Miniflux digest (DeepSeek Harness)"}` 换一枚 API key，密码用完即弃（`lib/miniflux.js` 的 `createApiKeyWithPassword`）。
- API key 的 description 在 Miniflux 里按用户唯一，第二次登录会撞名；撞名时回退到 `GET /v1/api-keys` 里读回同名 key 的 token，仍取不到才报错。
- `normalizeBaseUrl` 现在接受不带协议的输入（`example.com/v1/` → `https://example.com`），并继续剥掉尾部 `/v1`。
- 弹框不再列已存账号（切换在底部菜单、登出在 `Logout`）；因此删掉 `manage.accounts` / `manage.noAccounts` / `manage.switch` / `manage.active` / `account.add` / `account.manage` / `account.removed` / `manage.connect` 等不再使用的文案。

## 10.9 顶部设置按钮移除（2026-11 追加）

- 侧栏头部只剩刷新与 `+` 两个按钮；Preferences 从底部账号菜单的 `Settings` 进入，`?` 快捷键仍直接打开快捷键页。

## 10.10 设置面板重构 + 双语 + 主题（2026-11 追加）

- 六个页签：General（默认）/ Appearance / Reading / Data / Shortcuts / About，顺序与行序按需求给定；旧的两页签（Preferences/Shortcuts）与三段式分组已删除。
- 新增偏好：`locale`（en/zh）、`theme`（system/light/dark）、`accent`（default/blue/green/amber/red/violet）、`faviconShape`（rounded/circle）、`faviconColor`（normal/grayscale）、`titleAlign`（left/center）、`showHiddenFeeds`；`autoRefreshMinutes` 的取值改为 0/5/15/30/60（0 = Manually）。
- 语言：`EN` + `ZH` 两套字典（305 键一一对应，`makeT(locale)` 逐键回退到英文），面板自行持有 `t`，切换即时生效；宿主层标签也从同一字典取，因此侧栏入口名跟随语言。
- 主题：`.mrss-root[data-mrss-theme="light|dark"]` 覆盖本面板用到的 19 个 `--dsw-alias-*` token，因此可以违背宿主主题；`accent` 覆盖 `--dsw-alias-brand-primary` / `--dsw-alias-button-primary-hover` / `--dsw-alias-label-primary-foreground`。
- Favicon 形状/颜色、标题对齐分别由 `[data-mrss-favicon]`、`[data-mrss-favicon-color]`、`[data-mrss-title-align]` 三个根属性驱动。
- 移除 UI 但仍生效的旧偏好：`showExcerpt`、`dimRead`、`titleLines`、`previewLines`、`showReadingRail`、`markReadOnOpen`、`markReadOnScroll`、`sortField`（值保留在 prefs 里，代码照旧读取）。
- 版本号统一到 1.4.0（`package.json` 与 `index.js` 的 `VERSION`，About 页显示的就是它）。

## 10.11 设置弹层移除 Reload page（2026-11 追加）

- 头部只留标题与关闭按钮；`setup.reload` / `setup.reloadHint` 两条文案一并删除。client 更新由宿主热更新完成。

## 11. 编辑弹层的地址来源（2026-11 追加）

- `/bootstrap` 现在带 `feedUrl`，弹层直接用，不再额外请求。只显示 Miniflux 抓取的订阅地址；站点首页（`site_url`）不展示。
- Host 半还没更新（bootstrap 里没有这两个字段）时，弹层先显示 `Reading the address from Miniflux…`，同时用一次 `GET /feeds` 填进 `FEED_URLS` 缓存（按 feed id，整个面板会话复用，含并发去重），拿到后原地刷新；`/feeds` 也失败就显示 `Could not read this feed’s address from Miniflux.`。
- 跳转地址按 Miniflux 真实路由表（2.1.0 / 2.2.0 / 2.3.0 一致，见 `internal/ui/ui.go`）：`/feed/{id}/entries` 是条目页，`/feed/{id}/edit` 是编辑页；**没有**裸的 `/feed/{id}`。
- 复制反馈就在按钮旁：点复制后按钮变绿勾、左侧出现 `Copied`（1.6s 后自动消失），失败则显示红色 `Copy failed`，不再弹面板底部 toast。

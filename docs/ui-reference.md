# UI reference

What every part of the panel does, control by control. Useful when changing the layout.

| 区域 | 内容 |
| --- | --- |
| Sidebar 顶部 | 从左到右：插件名（下方小字是最近同步时间，刷新时变成 `Syncing…`）、刷新（转圈表示正在拉取）、新增订阅（New feed / New category 开各自弹框；Import OPML 直接弹文件选择框）。设置入口在底部账号菜单里 |
| Sidebar 导航 | 顶部一行横向分类 tab（等分填满宽度，44px 高）：第一个是 `All`（layout-grid），后面每个分类一个图标，默认是中性 `folder`，右键 tab → `Choose icon` 从 Lucide 里挑一个（存在 `prefs.categoryIcons`，按账号隔离）；每个 tab 带淡色底，hover 显示「分类名 · 未读数」。点 tab 切到该分类并向下列出它的订阅源（All 则列出全部）。tab 下方一行是当前分类名与排序按钮（A–Z / 未读数，点击切换，存在 `prefs.feedSort`）；分类 tab 右键可全部已读/重命名/删除，订阅源行右键或行尾 `···` 可刷新/全部已读/编辑/退订 |
| Sidebar 底部 | 账号区：头像 + 账户名 + 服务器域名，点开菜单含当前账号（勾选、带完整 URL）、其它账号、`Add another account`、`Settings`、`Logout` |
| List | 顶部一行从左到右：折叠/展开订阅栏、范围名 + 未读总数（Starred 下换成星标数）、`Mark all read`（只有勾选图标，hover 提示 `Mark all as read`；Starred 下置灰）、搜索；底部 Starred / Unread / All，与侧栏订阅清单联动；条目可显示封面图、来源图标、标题/摘要行数，已读可弱化，右键或 `···` 出条目菜单 |
| 翻页 | 滚到底自动加载下一页（每页 60），兜底按钮 `Load more · N`，不会一次拉光几百条 |
| Reader | 页眉自上而下：kicker（标题里冒号/dash 前的短前缀，CJK 超过 12 字不拆）→ 标题 → 一行 meta（feed 图标 + 订阅名 + 作者（超过 2 位折叠成「等 N 位」）+ 相对时间（点一下切完整时间）+ 阅读分钟 + 分类）；正文顶部按来源嵌 YouTube / Bilibili 播放器（16:9）；X 条目不渲染推文卡片，有视频时用原生播放器；顶部工具栏从左到右：关闭、上一条/下一条、Read/Unread（圆圈，已读变勾圈）、Star（收藏后实心）、Share（`navigator.share` 弹原生 share sheet）、Readability（抓 Miniflux 原文正文，原地刷新）、Full view（无干扰阅读：隐藏侧栏与列表）、Open in browser；按钮只有图标，hover 浮出文字；复制 Markdown / 抓取原文 / 宽栏阅读用快捷键 `c` / `g` / `w`；正文、目录、进度条与阅读导轨；字号/行高/行宽/字体/对齐/标题字号可调 |
| 设置弹层 | 六个页签，左侧导航自上而下：**General**（Language / Sync / Show hidden feeds）、**Appearance**（Theme / Reading surface（默认 / 纸面）/ Theme color / Favicon shape / Favicon color / Article list 的图片预览·favicon·阅读时间）、**Reading**（标题对齐与字号、正文字体/对齐/行高/字号/行宽 + Reset）、**Data**（Export OPML、设置导出导入、Miniflux 备份 FAQ 链接）、**Shortcuts**、**About**（版本、made with ♥ by wjloven → wjloven.com、致谢 Miniflux / Lucide / Nextflux / DeepSeek Harness） |
| 侧栏底部账号区 | 折叠态是头像圆标（账户名首字母）+ 账户名 + 服务器域名（`rss.example.com`），点开菜单自上而下：标题 `Switch account`、当前账户（对勾 + 完整 URL）、其它已存账户、`Add another account`、`Settings`、`Logout` |
| Add account 弹框 | `Add another account`（或首次运行）打开，自上而下：标题、Server URL（占位 `example.com/v1/`）、Username、Password、`Or continue with` 分割线、`API Token Auth` 按钮、Cancel / Confirm。点 `API Token Auth` 后 Username/Password 换成 API token 输入框 + `Miniflux → Settings → API Keys` 提示，分割线下变成 `Basic Auth` 可以切回。已登出时地址预填上次的服务器 |
| New category 弹框 | `+ → New category`：填分类名 → `Add category`，创建后就地关闭并刷新侧栏，不进设置 |
| Add feed 弹框 | 独立于设置：填站点或 Feed 地址 → `Find feeds`（Miniflux 发现该站点上的 Feed）→ 选 Feed、选分类（默认跟随当前分类或订阅源的分类）→ `Subscribe`；发现失败时回退成直接订阅输入的地址 |

键盘（对齐 Nextflux）：`j`/`k` 上下条并标已读，`m` 标已读/未读，`s` 收藏，`c` 复制 Markdown，`v` 开原文，`g` 抓取原文正文，`w` 宽栏阅读，`f` 或 `/` 搜索，`p`/`n` 上一个/下一个订阅或分类，`r` 刷新，`Esc` 退出 Full view / 关闭阅读区，`Shift+N` 添加订阅，`?` 快捷键帮助。输入框内不拦截。

**订阅栏可以收起**：列表头最左边的按钮收起/展开左侧订阅栏，图标随状态切换（面板左侧不再占 256px，正文直接变宽）；收起后同一个按钮就是展开入口，状态在面板内保留。

**切走再回来不丢状态**：面板在切到对话时会卸载，所以视图状态放在组件外的一份内存缓存里——选中的分类 tab、订阅源筛选、搜索词、选中的条目、正文滚动位置、列表滚动位置都会保留；同一份状态还写进 localStorage，所以刷新页面也回到原处（分类、筛选、选中的文章、正文）。重新进入不自动重取数据，只在快照超过 45 秒或切回前台时静默更新。

**手动刷新有按钮**：侧栏右上角的刷新按钮（和 `r` 键）会重取分类、订阅源、条目，并让 Miniflux 拉取新文章。列表头不再重复放刷新，收起订阅栏时用 `r`。设置弹层不再放 `Reload page`：client 侧更新由宿主的插件热更新接管，必要时再手动刷新页面。

**换列表是一次切换**：点订阅源或分类后，阅读区回到空态，范围名、侧栏订阅清单与新一页列表各自淡入 160 ms，整页列表像一张纸出现，不会让人误以为旧行原地变成了新行；打开文章时正文从下方 6 px 落定 180 ms。只在用户操作时播放——面板切走再回来、刷新页面恢复快照时内容直接就在；`prefers-reduced-motion: reduce` 下全部关闭，只保留最终状态。

**正文图片等解码完再出现**：图片先按 `width`/`height` 占好位置（宽图可出血到栏外内边距，窄图不放大），在 `load` + `decode()` 前不可见，完成后一次性淡入 240 ms；加载失败露出 alt 文本。等待期间预留位置上盖着一块同尺寸的浅色块，带一道 1.5 s 的扫光，图好了就撤掉——不是空白洞，也没有「先糊后清」的中间帧，下面的文字也不会被顶下去。

### 空文章页 → AI digest 栏（原生会话）

- 空文章页保持原样：inbox 图标 + `Pick an entry to start reading`，下方多一枚小气泡入口 `Continue with AI digest`。空页不调用模型。
- 点入口：第三栏切到 AI digest——顶部 `AI digest` + `+`（New chat）+ `X`（Close），主体是**嵌入的原生 DSH 对话**（不是自绘聊天）。插件用 `sessions.create/retain` 建会话，`SessionProvider` 包住 session 作用域的子 slot，渲染 `conversation.content`（embedded）；消息、输入框、模型选择、工具都是 DSH 自己的。
- Host 的 `/digest` 把当前时间线整理成草稿（首行 `My Miniflux digest timeline “{标题}” ({篇数} articles).`，随后是标题列表或上下文文件路径，以及一句可编辑指令），客户端用 `uiSession.bindingSource(...).props.inputActions.setDraft` 放进**原生输入框**；草稿不会自动发送。
- **推荐问句是提示词构建器**：原生空白会话的 hero（`Into the Unknown`）被关掉；对话框完全不动（空白会话保留原生 workspace 选择器，只隐藏 hero headline）；空页图标为 40px 书标（无圆形底），入口和标题前是 DeepSeek 鲸鱼 mark，问候上方是书页/星芒/波纹插画；对话区空白处居中是问候标题（`What should we dig into?`）+ 当前范围行（`All articles · 207 unread`）+ 两行 chips（分析：这屏来了什么 / 挑 3 篇慢读 / 按主题归组 / 这周有什么变化 / 推荐 RSSHub 源；范围：只看收藏 / 只看未读 / 全部）。点选组合后，面板把完整提示词填进原生输入框：一句自然语言的时间线上下文（名称、类型、过滤、篇数）+ 工具用法 + 选中的分析句 + 回答语言；再点取消，`Clear` 清空。提示词不含 scope 术语、不预取、不落盘。
- **Agent 用 `miniflux_timeline` 现取**：工具接受 `kind`/`title`/`filter`/`query`，用 `limit`/`offset` 翻页，返回总数、来源分布、带 id 的标题；需要正文用 `miniflux_read`。
- **回答里的文件在面板预览**：嵌入式会话不是右侧栏的 on-screen session，壳的文件页挂不上 surface；面板只对 digest 会话拦截 `dsh-resource://file/...`，用 `.mrss-file-view` 打开文本 / 图片 / PDF，其他格式给「用默认应用打开」。主会话不受影响。
- `+`：释放当前会话，用同一份草稿开新会话；`X`：释放会话回到空页。切换订阅源/分类/过滤/搜索或打开文章会自动关闭。
- 失败（时间线为空、会话服务未就绪）只弹 toast；入口在请求期间显示 `Preparing…`。

### 新增订阅（Add feed）### 新增订阅（Add feed）

1. 侧栏 `+` → `New feed`（或 `Shift+N`）打开独立弹框，不会进设置。
2. 填站点地址或 Feed 地址，回车或点 `Find feeds`；Host 调 Miniflux 的 `POST /v1/discover`，返回该地址上的 Feed 列表（标题、URL、rss/atom/json 类型）。
3. 选一条 Feed（只有一个时自动选中），选分类；分类默认取当前正在看的分类，或当前订阅源所属的分类。
4. `Subscribe` 调 `feed_add` 建订阅，成功后就地关闭弹框、刷新侧栏计数与列表。
5. 发现不到 Feed 或发现接口报错时，弹框保留输入的地址作为「Direct URL」一项，仍可直接订阅；错误在弹框内显示，不关闭。

### 订阅与分类管理（侧栏）

- 订阅源：在分类 tab 下方的清单里点开；行尾 `···` 或右键可刷新该源、全部已读、编辑（标题 + 换分类 + Feed URL 一键复制 + 跳到 Miniflux 该源的 `/feed/{id}/entries` 页面）、退订（确认后删除）。
- 分类：右键分类 tab 可全部已读、重命名、**Choose icon**、删除（删除后该分类下的订阅移到未分类）；`+ → New category` 直接新建。
- 分类图标：不再按分类名猜，默认是中性 `folder`；右键 tab → `Choose icon` 打开 94 枚 Lucide 图标的网格（带搜索框，回车选第一个匹配），点一下即生效，`Use default icon` 清除。选择存在 prefs 的 `categoryIcons`（键 `${accountId}:${categoryId}`），随偏好导出/导入走，换账号各用各的。
- OPML：`+ → Import OPML` 直接弹文件选择框；`+ → Export OPML` 直接下载整份订阅。
- 新增订阅：`+ → New feed` / `Shift+N`，见上一节。

### 过滤联动

- `Unread`：侧栏只列出有未读的订阅源，行尾数字是未读数；`Starred`：只列出有星标的源，数字换成星标数；`All`：列出全部源，行尾不显示数字。
- 切换订阅源或分类时保持当前过滤，不再重置回 Unread；`p/n`、分类 tab、订阅源点击都遵守同一条。
- 换订阅源或分类时第三栏回到空白：打开的文章属于刚离开的列表，留着它就会在新列表里显示上一篇的内容；重复点当前分类、或只换 Unread / Starred / All 过滤，都不清空。
- 侧栏当前分类那一行的数字与 tab 的 hover 文案也跟着过滤变（未读数 / 星标数 / 源数量）。
- 星标按订阅聚合没有现成 API：Host 的 `GET /feed-stats` 会抓最多 1000 条星标条目统计每个源的星标数，缓存 60 秒；星标条目更多的账号会截断，只有更早星标的源可能不出现在 Starred 清单里。

### 新建分类（New category）

- 侧栏 `+` → `New category` 弹出单字段弹框，填名字回车或点 `Add category`。
- 创建后关闭弹框、刷新侧栏分类与计数；改名/删除在分类 tab 的右键菜单。

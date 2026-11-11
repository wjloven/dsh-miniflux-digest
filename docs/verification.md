# Verification log

What was tested, on which setup, and what is still unverified.

| 项 | 结果 |
| --- | --- |
| 阅读区排版 | 通过（preview + headless Chromium，`tests/reader-shot.mjs`）：1280 px 面板下文章盒 655 px，图片左右边界 613–1269，正好是「栏宽 + 两侧 32 px」；图注仍居中在栏内；窄图不放大；「慢读实验：我把未读变成了三个入口」拆出 kicker 且标题只剩后半句，CJK 超过 12 字的前缀不拆 |
| 页眉 | 通过：feed 图标（14 px 灰度）+ 订阅名 + 作者 + 相对时间 + 阅读分钟 + 分类；点时间切到绝对时间（`2026-11-10 11:35` 形态），再点切回；作者超过 2 位折叠成「等 N 位」 |
| 代码块 | 通过：`class="language-js"` → `data-lang="JavaScript"`，header 左侧语言、右侧「复制」；复制走 `navigator.clipboard`，成功显示「已复制」1.6 s，失败显示「复制失败」；没有 pre 包裹的 `code` 不受影响 |
| 脚注 | 通过：marker 点击弹出 popover（368×120），背板只压暗面板、不压宿主外壳；Esc / × / 「回到正文」都能关；「回到正文」把 marker 滚回视口中央；`↩` 返回链接保持普通页内链接，不会被误标成 marker |
| 页内跳转 | 通过：正文里的 `#h2` 先被改写为 `#mrss-N`，点击在阅读区内滚动，不再整页跳走；标题 id 与目录条目一致（同一 id 不被 TOC 覆盖） |
| 阅读底色 | 通过：`data-mrss-surface="paper"` 下 `--dsw-alias-bg-base` = `#f5f1e8`、layer-1 = `#fcf9f2`、`--mrss-link` = `#0066cc`；暗色（`data-ds-dark-theme` 或 `data-mrss-theme="dark"`）= `#1b1b1b` / `#6cb0ff`；`prefers-contrast: more` 有更强的一档；设置弹层里「阅读底色」在 Appearance 第二行 |
| 暗色正文 | 通过：暗色下正文 `color-mix(label-primary 88%, bg-base)`，标题保持 `label-primary`；`prefers-contrast: more` 回到满对比 |
| 遮罩 | 通过：设置弹层、脚注背板改用黑色 22% / 28% / 30%，不再出现纸面底色糊出的白雾 |
| 减少动效 | 通过：目录、脚注返回、阅读导轨的滚动都走 `scrollBehavior()`，`prefers-reduced-motion: reduce` 时为 `auto` |
| 单元测试 `node tests/digest.test.mjs` | 通过：底稿结构、推荐理由、HTML 清洗（script/onerror/javascript: 全部移除）、Markdown 转换、阅读时长 |
| 接口端到端 `node tests/live-api.mjs` | 通过：假 Miniflux 上完成连接测试、bootstrap、digest、entries、entry、mark_read、star、fetch-content、清理凭据（discover 路由已加入该脚本，待下次对着运行中的 Host 复跑） |
| miniflux_briefing 实测（示例） | 通过：10 篇示例条目，`deepseek-flash`，18.2 秒，概要 + 6 个话题 |
| miniflux_briefing 实测（真实分类） | 通过：`Articles` 分类 20 篇 / 21 秒 / 6 个话题；加量到 44k 字符（33 篇）仍为 29.8 秒、5 个话题，未截断 |
| miniflux_briefing 失败路径 | 通过：3000 tokens 预算的空回复、裸换行导致 `JSON.parse` 失败的假「截断」均已复现并修复；修复后同一输入 `parsed: true / partial: false` |
| 状态保持 | 面板状态改为组件外缓存：筛选、搜索、选中条目、正/列表滚动位置都跨挂载保留；进入时不重取，侧栏刷新按钮 / `r` 才更新（无浏览器控制，未做交互级验证） |
| 推理强度 | 通过：`GET /efforts` 对两个 provider 返回各自声明的档位；同一请求 off 7.6s / low 21.0s，元信息正确记录所选档位 |
| 侧栏头部 | 通过（headless Chromium）：`+` 菜单的 New feed / New category 各开独立弹框，Import OPML 直接触发隐藏的 file input（不打开设置）；齿轮落在 Preferences；200px 侧栏下标题与时间不截断 |
| 切换动效 | 通过（headless Chromium，`tests/motion.mjs`）：打开文章时 `.mrss-article` 带 `mrss-article--enter` 且 180 ms 后不透明；切分类后列表页 `mrss-list-in`、范围名 `mrss-fade`、空态 `mrss-void-in`、侧栏订阅行 `mrss-list-in`，400 ms 后都不透明；刷新页面恢复文章时**不**重播进场动画（无 class、`animation-name: none`）；模拟 `prefers-reduced-motion: reduce` 后全部为 `none` 且内容可见 |
| 正文图片 | 通过（headless Chromium，`tests/reader-images.mjs`，CDP Fetch 暂停图片请求制造真实等待）：等待中 `data-mrss-image="pending"`、`opacity: 0`、按 1440×900 预留 655×409（比例 1.6），占位块与图片盒四边完全重合（653/676/655×409）；放行后 `ready`、不透明、占位块移除、内联宽度/比例清空、自然宽 1440，尺寸与预留一致 |
| 图片占位视觉 | 通过（截图 `image-pending.png` / `image-ready.png`）：暂停请求时预留位置是一块浅灰圆角块 + 慢扫光，不是空白；放行后同一位置出现图片，文章其余内容没有位移 |
| 切换范围清空阅读区 | 通过（headless Chromium，`tests/scope-switch.mjs`）：在 All 打开第 0 行后点订阅源 → 阅读区回到空态、无高亮行、快照记 `selectedId: null`；在订阅源内打开文章后切分类同样清空；重复点当前分类保留文章与选中行；点 All 也清空；点开文章后在请求返回前切走，正文不再出现（`Opening…` 期间切走，1.8 s 后仍是空态） |
| 过滤联动 | 通过（headless Chromium）：Unread 19 个源、数字为未读、头部 `207 unread`；Starred 13 个源、数字为星标数、头部 `36 starred`；All 20 个源、无行尾数字、头部 `20 feeds`；在 Starred 下切到 Articles 仍保持 Starred（5 个源、头部 `8 starred`），点订阅源也不重置 |
| feed-stats | 预览 mock 上验证客户端联动；Host 按星标条目聚合每个源，`live-api.mjs` 已加断言，需重启 Host 后复跑；真实账号的星标量/耗时尚未实测 |
| Switch account | 通过（预览双账号 mock）：底部显示 `SWITCH ACCOUNT / 当前账号`；点开菜单向上弹出，含账号列表、`Add account…`、`Manage accounts…`；切到 work 后底部与 `boot.status` 一起变；Accounts 弹框可切换/删除/添加，设置只剩 Preferences / Shortcuts |
| 侧栏 tab | 通过（headless Chromium）：All + 4 个分类 tab（Lucide 图标 + 淡色底，等分填满 256px，hover 标题带未读数）；切 tab 后列表标题与订阅清单同步；点订阅源后 tab 停在其分类；`p/n` 切换时 tab/清单一起变；All 显示全部 20 个订阅 |
| 折叠外壳 | 通过（模拟 `data-platform=darwin` + `data-sidebar-collapsed` + 假 leading seat）：折叠时根节点 `padding-top: 48px`，标题行顶边 48px，高于按钮底边 39px；展开时 padding 为 0 |
| 暗色模式 | 通过（`preview/?theme=dark`，Harness 暗色 alias token）：主按钮/激活页签/头像文字转为深色，开关滑块深色，单选圆点与未选项可区分，toast 白字深底，滑块改用 brand 色；明色下对照无回退 |
| Add feed 弹框 | 通过（预览 + headless Chromium）：`+ → New feed` 只开弹框不进设置；3 个发现结果、分类默认跟随当前分类；订阅后弹框关闭并提示 `Feed added`；无效 URL 就地报错；发现接口 500 时回退 Direct URL；Esc 关闭 |
| 订阅/分类菜单 | 通过（headless Chromium）：分类 tab 右键出现「全部已读 / 重命名 / 删除」，删除弹确认框；订阅源行菜单保留刷新/已读/编辑/退订；`+` 菜单新增 Export OPML，点击下载 `/api/opml` |
| New category 弹框 | 通过：`+ → New category` 只开单字段弹框、输入框自动聚焦、创建后关闭并提示 `Category created`，不打开设置 |
| OPML | 通过：`+ → Import OPML` 直接触发隐藏 file input；`+ → Export OPML` 打桩到 `/api/opml` 的下载 |
| discover | `client.discover` 用假 Miniflux 单测通过（POST `/v1/discover`、body 正确）；弹框全流程跑在预览 mock 上；真实 Miniflux 实例的 discover 返回尚未实测 |
| 槽位注册 | `sidebar.panellist` 与 `main` 均出现 `rss-miniflux`，`active: true` |
| 客户端加载 | `node tests/client-smoke.mjs`：在 Node 里加载 client.js，确认工厂返回 `apply` 并注册两个槽位 |
| 账号迁移 | 旧凭据迁移为 `default` 账号，`source: account`，用户名回填 `demo` |
| 订阅/分类 | 真实实例上 `GET /feeds` 返回 400+ 个订阅；分类新建 + 删除往返成功；`GET /opml` 返回 OPML；`GET /icon` 返回 32×32 PNG |
| 多账号写路径 | 未用真实第二实例验证（需要另一个 Miniflux 的令牌）；切换/删除的错误分支已验证 |
| 排序 | Host 的 `GET /entries?sort=newest|oldest` 仍可用；面板不再提供方向切换，固定 newest（字段在 Preferences 的 `Sort by` 选） |
| 全部已读 | 仅做代码审查与权限确认，未在真实账号上执行（会不可逆地清空未读） |
| 凭据修复 | `repair-credentials.mjs` 在合成的重复 key 文件上验证：备份、注释重复块、`--check` 退出码正确；当前真实文件 `--check` 通过 |
| 崩溃恢复 | 按 runbook 重装插件、从注释块恢复账号：`source: account`、用户名 `demo`、`miniflux_overview` 正常 |
| 视觉与交互 | 用 `preview/` 假数据逐屏点过：侧栏刷新/添加、分类 tab 切换与订阅清单、列表头、阅读区空态与正文、Manage 弹框、分类/订阅右键菜单；256px / 200px 侧栏、270px 列表下不溢出 |
| 阅读区工具栏 | 通过（headless Chromium）：9 个按钮顺序为 Close → Prev → Next → Read/Unread → Star → Share → Readability → Full view → Open in browser，全部纯图标 + hover tooltip；点 Readability 后正文不闪白、保持原样直到新内容返回，按钮在取数期间禁用并转圈（取数失败只 toast，不清空正文）；点 Full view 后侧栏与列表 `display:none`、正文居中，再点恢复，`Esc` 先退 Full view 再关正文；Read/Unread 圆圈 ↔ 勾圈、Star 变实心；980px 单行、900px 两行、无横向溢出 |
| 视频嵌入 | 通过（preview + 真实网络）：YouTube 条目渲染 16:9 播放器（Big Buck Bunny，可播放、有 Watch on YouTube）；Bilibili 条目渲染播放器（默认不自动播放，00:01 暂停态、控制条可用）；X 条目不再出现推文卡片，正文仍是 feed 文字，有视频时在正文上方渲染原生 `<video>`（960×540 加载后 591×333，控制条可用）；尺寸约束实测：16:9 为 591×333，竖屏 1080×1920 被压到 215×380 并居中，不放大；feed 正文自带的 `<video>` 同样受约束（16:9 591×332、竖屏 214×380），且清洗后自动带 `controls`；X 无视频时只显示正文。Host 的 `tweetFromSyndication` 单测覆盖最高码率 mp4、跳过 HLS、拒绝非 twimg 域名、`note_tweet` 长文 |
| 布局细节 | 通过（preview + 模拟宿主 content-box）：注入 `*{box-sizing:content-box}` 后搜索框仍贴合列表栏（右边缘距栏边 10px、高 28px），列表行不溢出；1440 / 1200 / 1100 / 980 / 900 五档宽度下侧栏、列表、底部 tabs 均无横向溢出；阅读区工具栏在 980px 以下改为工具组内部换行，不再把按钮挤出可视区 |
| 列表头 | 通过（headless Chromium + preview 假数据）：一行四个控件，顺序为折叠按钮 → 分类名（不显示计数）→ `Mark all read` 勾选图标 → 搜索；hover 勾选图标浮出 `Mark all as read`（Starred 下浮出 `Not available in Starred`）；Starred 下按钮置灰不可点（`disabled` + 0.45 透明度），Unread / All 可用；264px 列表宽也不换行不溢出；暗色正常 |
| 首帧（有快照） | 通过（headless Chromium + preview `--delay 1200`）：`data-mrss-hydrated=true`，root/账号/首行条目都在 **28–74 ms** 出现，比网络快 1200 ms，全程没有骨架、没有「Not connected」 |
| 首帧（无快照） | 通过（同上）：51–59 ms 出侧栏/列表/账号/分类 tab 骨架，期间不出现「Not connected / Add your first feed / No entries match」；1.3 s 后数据填满 |
| Host 缓存 | 通过（`tests/host-cache.mjs`，进程内 stub + 慢速假 Miniflux）：冷 bootstrap 4 个上游请求、暖 bootstrap 0 个；同一页 entries 只请求 1 次；标已读后 bootstrap 只补 counters，不再拉 feeds/categories/me；`refresh` 才整体失效 |
| 图标 | 通过：`GET /icons` 一次返回多条 data URL，无图标的源不出现在 `icons` 里；同一批第二次请求 0 个上游调用；`/icon?id=` 复用同一份缓存、无图标回 204（`tests/host-cache.mjs`）；浏览器侧刷新后首帧 91 ms 出图标、单图标请求 0 次（headless Chromium 对真实账号）；侧栏 200 行只请求视野内约 16 个 |
| 缓存语义 | 通过（`tests/cache.test.mjs`）：TTL 内复用、过期阻塞重取、陈旧先返回 + 单个共享后台刷新、后台失败保留旧值、超过 stale 窗口重取、按前缀精确失效（`feed-stats` 不会误删 `feeds`） |
| 订阅栏折叠 | 通过（同上）：点列表头最左按钮后 `.mrss-side` 不显示、拖拽条消失、展开按钮留在原位；再点恢复，列表选择与滚动位置不变 |

复跑：

```bash
cd miniflux-deepread
node tests/digest.test.mjs      # 底稿 / 清洗 / Markdown
node tests/client-smoke.mjs     # client.js 在 Node 里能加载并注册槽位
node tests/cache.test.mjs       # Host 缓存语义（SWR、共享刷新、按前缀失效）
node tests/host-cache.mjs       # Host 端到端：冷/暖 bootstrap、已读只失效一部分、entries 去重
node tests/first-paint.mjs      # 首帧对照（headless Chromium + preview 慢速 mock）
node tests/reader-shot.mjs --out /tmp/ringo --theme light --surface paper --note --settings  # 阅读区截图与实测尺寸
node tests/live-api.mjs http://127.0.0.1:57791   # 需要另起的 Harness，会临时改写连接配置
```

## 与 Nextflux 的差距

逐项对照表在 [docs/nextflux-parity.md](docs/nextflux-parity.md)：按「侧栏 / 列表 / 阅读区 / 交互」四块列出 Nextflux 的实现位置、本插件状态（✅ / ⚠️ / ⏳ / N/A）和取舍理由。改界面或加功能前先看这张表，避免又漏项。

这一轮补齐：分页与自动加载、订阅源/分类/条目的右键菜单与编辑弹层、封面图与行数偏好、排序字段、分享、阅读导轨、字体与行高、偏好导出导入、Nextflux 全套快捷键。

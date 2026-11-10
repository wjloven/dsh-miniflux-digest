# 加载性能与缓存（v1.5.0 → v1.6.0）

对照对象：[electh/nextflux](https://github.com/electh/nextflux) 的 `src/db/*`、`src/stores/authStore.js`、`docs/synchronization.md`。

## 之前为什么慢

| 现象 | 原因 |
| --- | --- |
| 点进去先看到「Not connected / 没有订阅」 | 面板首帧渲染时 `boot = null`，而账号、分类、订阅、条目都要等 `/bootstrap` 返回；空状态在这期间先画了出来 |
| 要等 1.5–2 秒内容才出现 | `/bootstrap` 冷启动要向 Miniflux 发 4 个请求（categories / feeds / counters / me），本机实测 **1.96s**，返回 113 KB；`/entries` 另算 **0.5–0.9s** |
| 每次刷新页面都重新慢一遍 | 视图状态只存在内存 `PANEL_CACHE`，页面重载即丢；没有落盘的快照 |
| 标一条已读后侧栏要转一下 | `handleAction` 里任何写操作都 `invalidate()` 清空整个缓存，于是下一次 bootstrap 又是 4 个请求的冷路径 |
| 隔一会儿再打开又变慢 | 目录类缓存 TTL 只有 60 秒，过了就重新走网络 |

## Nextflux 的做法（读过的源码）

- `docs/synchronization.md`：「已有缓存直接读取 IndexedDB，不等网络」——先渲染本地库，再后台同步。
- `src/db/database.js`：按账号分库（`minifluxReader:<account>`），articles / feeds / categories / feedIcons 四张表，写库只写变化的记录。
- `src/stores/authStore.js`：账号身份用 `persistentAtom('accounts:v1')` 存在 localStorage，**同步**可读，所以首帧就知道「我是谁」，不会先画「未登录」。
- 侧栏计数用索引扫描算，不为每个源单独发请求；同步任务单飞 + Web Locks，页面隐藏时暂停。

## 这一版改了什么

### 客户端：先画再更新（stale-while-revalidate）

| 改动 | 位置 | 效果 |
| --- | --- | --- |
| 落盘快照 `rss-miniflux:cache:v1`：账号状态 + 分类 + 订阅 + 一页条目 + 视图（filter/scope/选中项） | `client.js` 的 `readSnapshot` / `persistSnapshot` | 页面重载后首帧就是上次的画面 |
| 当前正文单独存 `rss-miniflux:cache:v1:article` | `persistArticle` / `readCachedArticle` | 回来时还在读同一篇，正文不闪「Opening…」；超过 400 KB 自动不存，避免挤掉目录 |
| 模块加载时同步 `adoptSnapshot()` | `client.js` | localStorage 是同步 API，所以第一帧就带着账号名、分类、条目，而不是等 Promise |
| 挂载后空闲时静默重取一次 | `Panel` 的 revalidate effect | 数据在屏幕上原地更新，不出现骨架、不跳滚动位置 |
| 静默模式 `loadEntries({ silent })` | `client.js` | 不改 loading 状态、不重置滚动、内容没变就完全不 setState |
| 冷启动画骨架（侧栏行 / 列表行 / 账号 / 分类 tab） | `SidebarSkeleton` / `ListSkeleton` / `AccountSkeleton` | 没有快照时也不再闪「Not connected」「Add your first feed」「No entries match」 |
| 侧栏入口预热 | `RssPanelIcon` → `warmSnapshot()` | 侧栏图标随应用启动就挂载，空闲时先把 Host 缓存和快照备好；5 分钟冷却，快照 2 分钟内新鲜则跳过 |
| 回到前台补一次同步 | `visibilitychange` | 隔很久回来不用等下一个定时器 |
| 账号列表缓存 30 秒 | `ACCOUNTS_CACHE` | 面板重新挂载不再每次都请求 `/accounts`（该接口会在 Host 侧强制重读凭据） |
| 后台同步与已读计数刷新改为 silent | 定时器 / `toggleRead` | 侧栏不再因为一次标记已读而闪 loading 或弹错误 |

### Host：慢的东西只算一次

| 改动 | 位置 | 效果 |
| --- | --- | --- |
| 目录类缓存改 stale-while-revalidate（60s 新鲜 / 15min 可陈旧） | `lib/cache.js` 的 `runSWR` | 过期目录立即返回旧值并在后台刷新，不再把过期等同于冷启动 |
| `/bootstrap` 不再 `resolveSettings(true)` | `index.js` | 不必每次打开面板都重读凭据文件；账号增删/切换本来就会把 `runtime.settings` 置空 |
| 写操作按需失效 | `handleAction` 的 `expire([...])` | 标已读只让 counters / feed-stats / entries 过期，分类和订阅留在内存里 |
| `/entries` 加 8 秒内存缓存 | `listEntriesCached` | 重挂载或第二个面板请求同一页不再打 Miniflux |
| `server-timing` 响应头 | `/bootstrap`、`/entries` | devtools / curl 直接看 Host 花了多久 |

## favicon（v1.5.1）

第一版的快照方案没管图标：每个源一个 `<img src="/rss-miniflux/api/icon?id=…">`，而 Miniflux 取一个图标要 **0.4–2 秒**（它自己没抓过这个站时更慢）。真实账号侧栏有 200 个源、列表一页 60 条，等于几十上百个慢请求，图标一个个蹦出来，没图标的源 `onError` 之后直接留个洞。

| 改动 | 位置 | 效果 |
| --- | --- | --- |
| 图标批量接口 `GET /icons?ids=1,2,3` | `index.js` | 一次请求换回一组 data URL，不再一个源一个请求 |
| Host 图标缓存：命中 7 天、无图标 1 天；同一个源的并发请求合并 | `index.js` 的 `iconLoad` | 第一次之后是内存命中；实测同一批 20 个图标 **8.3 s → 2.6 ms** |
| 批量按 16 个一批、渐进返回 | `client.js` 的 `flushIcons` | 先到的那批先显示，不用等最慢的那一个 |
| 图标按账号存进 `localStorage`（`rss-miniflux:icons:v1`，≤300 个 / ≤1.2 MB） | `client.js` 的 `restoreIcons` / `persistIcons` | 刷新页面后首帧就有图标，实测首帧 **42–64 ms** 出图标，且不再单独发 `/icon` |
| 可见才请求（IntersectionObserver，提前 240px） | `FeedIcon` | 侧栏 200 个源只请求视野内那十几个，第一屏填得快，滚动再补 |
| 字母色块占位 + 真图标淡入 | `.mrss-favicon--tile` / `--in` | 没有「空洞」、没有跳动；无图标的源永远显示字母块 |
| 只通知变化的那批行 | `notifyIcons(changed)` | 200 行的侧栏不会因为一批图标到达就整片重渲染 |
| `oversize`（>48 KB 的图标）走 `/icon?id=` | `index.js` / `client.js` | 大图标不进 JSON，交给浏览器缓存 |

实测（真实账号，`/tmp` 的临时预览壳代理线上 Host，headless Chromium）：

```
首次访问（Host 图标缓存空）：1 批请求 / 16 个图标，7 秒内视野内基本填满；
                             侧栏 200 行里只请求了 ~16 个，其余保持字母块
刷新页面（图标已落盘）：      item 64 ms、icon 91 ms，/icon 单独请求 0 次
线上 Host 实测（20 个图标一批）：冷 2.44 s → 暖 2.7 ms
```

真实实例上的一屏：上排是真图标，下面是还没取到的字母块（侧栏 200 行里只有视野附近的会去取）。

## 列表与详情（v1.6.0）

首帧修好之后，剩下的慢在**每一次点击**上。2026-11-10 在一个 400 源量级的真实实例上量的数（未读 1000 条以上）：

| 请求 | 耗时 | 说明 |
| --- | --- | --- |
| `/entries` 冷 | **1.8–5.7 s** | 和 `limit` 无关：`limit=10` 也要 2.6 s，是 Miniflux 那边的聚合查询慢 |
| `/entries` 暖（8 s 内存缓存内） | 1–2 ms | 但缓存只有 8 秒，过了就重新等 |
| `/entry` 冷 | **0.7–15 s**（多为 0.7–1.5 s，偶发 6.6 / 14.9 s） | 完全没缓存，每次点都重新问 |
| `/entry` 带 X 推文 | 再多 **1.4–3 s** | `enrich` 在返回前 `await` 了 syndication 接口（超时 3 s） |
| 标一条已读之后的列表 | 又回到冷路径 | 写操作 `expire(['entries'])` 把整张表清掉了 |

也就是说：列表每次切换范围、详情每次点开，都要重新付一次上游的时间。

### 改法

| 改动 | 位置 | 效果 |
| --- | --- | --- |
| `/entries` 改 stale-while-revalidate（60 s 新鲜 / 30 min 可陈旧） | `index.js` 的 `listEntriesCached` | 过期不再等于冷启动：先给旧页，后台刷 |
| `/entry` 加缓存（10 min 新鲜 / 2 h 可陈旧，上限 240 篇） | `loadArticleCached` | 回退、上一篇/下一篇、预取命中都是 1 ms 级 |
| 写操作按条目打补丁，不清整表 | `patchEntryRows` + `lib/cache.js` 的 `patch` | 标已读只改那一行；`unread` 页里删掉、`All`/`Starred` 页保留并改状态 |
| X 推文移出关键路径：`GET /tweets?ids=` | `index.js` | 正文先出来，卡片后补；不再为一条推文等 3 s |
| 文章内存缓存（最近 16 篇）+ 列表多页缓存（最近 8 页，5 min） | `client.js` 的 `rememberArticle` / `rememberPage` | 切回看过的分类、重新打开文章都是同步命中 |
| 悬停预取（停留 140 ms 才发，优先插队） | `prefetchAfterDwell` / `prefetchArticle` | 鼠标停一下再点，正文已经在了 |
| 阅读时预热相邻两篇（空闲车道，一次一个） | 邻居预取 effect | `j/k` 连续读不用等 |
| 侧栏源悬停预取第一页 | `feedRow` | 切源不再先是骨架 |
| 同一篇的请求合并 | `fetchArticle` 的 `inflightArticles` | 预取和点击共用一次请求，不会发两遍 |
| 列表刷新时只画一条 2 px 进度线 | `.mrss-list-head[data-loading]` | 有旧内容时不再闪骨架，也不再像卡住 |

预取是**节制的**：悬停停留才发、同一时刻最多 2 个、已缓存的跳过、空闲预热单独一条车道（有优先请求就把排队的丢掉）。所以它不会把 Miniflux 打满，也不会让点击排在预取后面。

### 实测

`tests/warm-paths.mjs`（preview 壳 + mock 每请求延迟 1200 ms，页面内 `performance.now()` 计时）：

| 动作 | 耗时 | 走的是什么 |
| --- | --- | --- |
| 第一次打开一篇文章 | 1248 ms | 付一次网络 |
| 再打开第二篇 | 16 ms | 相邻预取已经落地 |
| 回到第一篇 | 18 ms | 内存副本 |
| `j` 到下一篇 | 17 ms | 空闲预取 |
| 悬停一下再点 | 21 ms | 悬停预取 |
| 第一次切到一个分类 | 1216 ms | 付一次网络（只此一次） |
| 切回原分类 | 10 ms | 记住的整页，且没有出现刷新条 |

线上 Host（同一个真实实例）：

```
/entry 冷 4.27 s → 暖 1.1 ms（server-timing: entry;dur=0）
/entries 冷 4.63 s → 暖 1.9 ms
/tweets 不再阻塞 /entry，单独一条请求
```

### 怎么复跑

```bash
node tests/warm-paths.mjs          # 交互暖路径：切范围、重开、预取（需要 Chromium）
node tests/warm-paths.mjs --delay 1600
```

`--delay` 是 mock 的每请求延迟。断言分两类：**第一次**必须付网络（`>= delay * 0.8`），**第二次**必须 < 400 ms。

## 实测

环境：本机 Host 连真实 Miniflux（约 400 个订阅 / 200 未读），preview 假数据用于首帧对照。

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| `/bootstrap` 冷（Host 缓存空） | 1.96 s / 113 KB | 1.96 s（冷启动本身没变，但每次点开不再都走冷路径） |
| `/bootstrap` 暖 | 2.5 ms | 2.5 ms |
| `/bootstrap` 60 秒后（目录过期） | 1.96 s 冷路径 | 立即返回旧值 + 后台刷新 |
| `/entries` 同一页第二次 | 0.53–0.81 s | 2–3 ms（8 秒缓存内） |
| 标已读后的下一次 bootstrap | 4 个上游请求（整表冷刷） | 1 个（只刷 counters）；`tests/host-cache.mjs` 断言 |
| 首帧：账号名出现 | 等 `/bootstrap`（预览 mock 延迟 1200 ms 时 ≈ 1.3 s） | 有快照时 **28–74 ms** |
| 首帧：列表首行出现 | 同上 ≈ 1.3 s | 有快照时 **28–74 ms**，比网络快 1200 ms |
| 图标：单个请求 | 0.39–0.56 s（Miniflux 冷）/ 1.0–2.0 s（更冷的源） | 批量 + 缓存后同一批 **2.6 ms** |
| 图标：刷新页面后出现 | 每个源各自等 0.4–2 s，没图标的留空洞 | 首帧 **91 ms**（localStorage 图标库），单图标请求 0 次 |
| 冷启动（无快照） | 空白 + 「Not connected」/「Add your first feed」 | 骨架屏，51–59 ms 出现 |

首帧数据来自 `tests/first-paint.mjs`（headless Chromium + `preview/server.mjs --delay 1200`，时间戳是页面内 `performance.now()`，相对 navigationStart）：

```
[cold] marks: {"root":52,"listSkeleton":52,"sidebarSkeleton":52,"account":1279,"item":1297}
[warm] marks: {"root":28,"hydrated":28,"account":28,"item":28}
```

冷启动（无快照，网络 1200 ms 未回）：骨架顶着，不出现空状态文案。

![冷启动骨架](../preview/shots/cold-early.png)

有快照：29 ms 就是完整画面（分类、订阅清单、60 条、账号），网络还没回来。

![快照首帧](../preview/shots/warm-early.png)

## 怎么复跑

```bash
cd miniflux-deepread
node tests/cache.test.mjs        # 缓存语义：SWR、共享后台刷新、按前缀失效
node tests/host-cache.mjs        # Host 端到端：冷/暖 bootstrap、已读只失效一部分、entries 去重
node tests/first-paint.mjs       # 首帧：cold 出骨架、warm 从快照直接画（需要 Chromium）
node tests/first-paint.mjs --shots /tmp/shots --theme dark   # 顺手存图看明暗两版
node tests/warm-paths.mjs        # 交互暖路径：切范围、重开、预取（需要 Chromium）
```

`--delay` 控制 mock 网络延迟（默认 1200 ms），`--chromium` 指定浏览器路径；没有 Chromium 时该脚本会跳过而不是失败。

## 回滚

客户端缓存是纯增量：删掉 `localStorage` 里的 `rss-miniflux:cache:v1*` 两个键即回到「每次重载都重新拉」。Host 侧若要回到旧行为：

```js
// index.js
cacheRunSWR -> cacheRun        // bootstrap 的四个调用
// handleAction 里 expire([...]) -> invalidate()
```

不想动代码就停用插件（`plugin_manager` 关掉 `rss-miniflux` 这一行），凭据与快照都不受影响。

## 已知边界

- 快照只存**第一页**（60 条）。滚到第 300 条再离开，回来是第一页 + `total`，需要再滚。
- 阅读位置（列表/正文滚动）跟着快照存，但只随视图变化写入；快速滚动后立刻重载页面可能丢几行偏移。
- 快照按账号写入，切换 / 登出 / 添加账号时会主动清掉，避免把上一个账号的内容画给新账号。
- 存储超限时先丢条目页、保留目录；再不行整体删除，下次冷启动重建。
- Host 缓存仍在进程内存里，Host 重启后的第一次是冷路径——此时由客户端快照兜住首帧。
- 星标过滤的 `feed-stats` 仍是最多 1000 条聚合，缓存 60 秒，未改。

v1.6.0 之后：

- 列表缓存是**按查询串**存的，`filter` / 分类 / 源 / 搜索词不同就是不同的一页。滚了很多页之后切走再回来，只记得前 8 个查询的第一页与滚过的部分。
- 写操作只打补丁，所以别处（另一个客户端、Miniflux 自己的定时刷新）改的已读状态要等下一次真正重取（60 s 后，或切换范围触发）才会出现在列表上。
- 预取占用真实的上游请求：悬停停留 140 ms 才发，空闲预热一次只跑一个。网络很慢时它只是把等待挪到点击之前，并不会让总请求变少。
- `/entry` 的缓存按 id 存，读完标记已读只是改头部状态；正文本身在 Miniflux 那边若被 `fetchContent` 更新过，要等 10 min 新鲜期过后才刷新。
- X 推文是第二次请求：正文先出，媒体卡片晚一点补上；syndication 接口失败时卡片保持无媒体，1 分钟后才重试。

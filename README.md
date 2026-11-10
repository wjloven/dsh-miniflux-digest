# Miniflux digest

**Elegant Miniflux RSS digest for your DeepSeek Harness.**

Your feeds live in Miniflux. This plugin brings them into DeepSeek Harness as a proper reading panel, so you can skim the unread, read the long ones, and ask your assistant what is worth your time — without opening another tab.

![List and sidebar](preview/shots/panel-list.jpg)

## Screenshots

| Reading | Paper surface |
| --- | --- |
| ![Reader](preview/shots/reader-light.jpg) | ![Paper](preview/shots/reader-paper.jpg) |

| Dark | Media and code |
| --- | --- |
| ![Dark](preview/shots/reader-dark.jpg) | ![Figure](preview/shots/reader-figure.jpg) |

| Footnotes open in place | Settings → Appearance |
| --- | --- |
| ![Footnote](preview/shots/reader-footnote.jpg) | ![Settings](preview/shots/settings-appearance.jpg) |

## What it does

- **One panel, three columns.** Categories and feeds on the left, the article list in the middle, the article itself on the right. Nothing opens a new tab.
- **Built for reading.** Adjustable type size, line height and measure; a paper surface for long sessions; dark mode; images that may run past the column; footnotes that open where you clicked them; code blocks labelled with their language.
- **Picks up where you left off.** Reopen the panel and you are on the same article, at the same scroll position, with the content already there instead of a blank screen.
- **Filters that stay in sync.** Starred / Unread / All filters the feed list and the article list together.
- **English and 简体中文.** Switch any time in Settings → General.
- **Video plays inline** for YouTube, Bilibili and X posts.
- **Keyboard first.** `j` / `k`, `m`, `s`, `c`, `v`, `g`, `w`, `f` — the keys a reader expects.
- **Your assistant can read along.** Ask for a digest, a briefing on one category, or "read this one"; the tools below share the same account and unread state.

## Requirements

- DeepSeek Harness 0.2 or newer
- A Miniflux instance (2.0+ is fine; 2.3.2+ enables batch starring)

## Install

```bash
dsh plugin --profile desktop add /path/to/dsh-miniflux-digest
```

Then enable the `rss-miniflux` row in the plugin manager. The panel appears in the sidebar.

To update, pull the repo and toggle that row off and on again.

## Connect your Miniflux

The first time you open the panel it asks for two things: your server address and an API token (Miniflux → Settings → API keys). It checks the connection right away.

If you would rather not type it, set `MINIFLUX_BASE_URL` and `MINIFLUX_API_TOKEN`, or pass them as plugin config. Config wins over the saved credential, which wins over the environment.

```yaml
- id: rss-miniflux
  name: 'rss-miniflux-deepread'
  config:
    baseUrl: https://rss.example.com
    timeoutMs: 15000
```

No account at hand? Close the dialog and browse the built-in demo entries.

## Use it from the assistant

| Tool | What it gives you |
| --- | --- |
| `miniflux_overview` | Connection status, unread counts by category and feed |
| `miniflux_digest` | A brief of the unread: time window, distribution, recurring stories, what is worth a slow read and why |
| `miniflux_briefing` | A model-written briefing for one category, in the conversation |
| `miniflux_read` | The full text of one article, as Markdown |
| `miniflux_search` | Search your entries by keyword |
| `miniflux_act` | Mark read or unread, star, refresh a feed or category |

Things worth asking:

> Brief me on the Tech category and tell me the three topics that come up most.

> What is in my unread right now, and which three pieces deserve a slow read?

## Your data

- **The token stays local.** It lives in the credential store of your Harness profile — not in a config file, and never in this repository.
- **Traffic goes where you point it.** The only network calls are to your own Miniflux server. X posts additionally pull their video from `cdn.syndication.twimg.com`.
- **Caches are disposable.** A short-lived cache on the host and a snapshot in the browser make reopening feel instant. Disconnecting, logging out or switching accounts clears them.

## Limitations

- Needs a reachable Miniflux instance; there is no offline mode.
- The panel is designed for a desktop-width window. On narrow windows the reading column gets tight.
- Full-text fetching, feed discovery and batch starring depend on the Miniflux version behind you.
- The Starred view counts stars over the most recent 1000 starred entries, so very large archives are partial.
- Demo mode ships fictional sample entries so you can look around before connecting anything.

The detailed list — indentation rules, code-block detection, video edge cases and so on — is in [docs/limitations.md](docs/limitations.md).

## Documentation

| Document | Contents |
| --- | --- |
| [docs/ui-reference.md](docs/ui-reference.md) | Every control in the panel, region by region |
| [docs/design.md](docs/design.md) | Why it works this way; comparison with Nextflux |
| [docs/limitations.md](docs/limitations.md) | Edge cases and version requirements |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Credentials, recovery, logs |
| [docs/verification.md](docs/verification.md) | What was tested and what was not |
| [docs/development.md](docs/development.md) | Local preview, screenshots, file map |
| [docs/loading-performance.md](docs/loading-performance.md) | How the first frame stays instant |
| [docs/ringo-reading-design.md](docs/ringo-reading-design.md) | Reading-surface decisions |

## License

MIT, see [LICENSE](LICENSE).

Demo data in `preview/data.mjs` and `lib/demo.js` is invented: the feed names, headlines and article bodies do not refer to real publications. Screenshots in `preview/shots/` are generated from that demo data. Please keep it that way — no real account name, server address or subscription list belongs in this repository.

---

# 中文说明

你的订阅都在 Miniflux 里，但每次想读的时候，还是得打开浏览器，在网页里点来点去。这个插件把未读直接搬进 DeepSeek Harness 的侧栏，看列表、读长文、问助手，都在同一个界面里完成。

面板分成三栏。左边是你的分类和订阅源，中间是文章列表，右边是文章正文。点一下文章标题就能开始读，不会跳到新的标签页。字号、行高、行宽都可以调；界面有明亮和暗色两套配色，还有一个纸面风格的阅读底色；图片会稍微伸出文字栏外；点一下脚注，它会在原地展开，不用翻到文末；代码块上标着这段代码是什么语言。

关掉面板再打开，你还在刚才那篇文章、刚才那个位置，内容已经显示好了，不用对着空白等它加载。筛选条件也不会自己重置，你选了「未读」，换个分类继续看，仍然是「未读」。

面板界面有中英文两种，在设置里随时切换。YouTube、Bilibili 和 X 的视频可以直接在文章里播放。常用的操作都配了快捷键，`j` / `k` 上下切换文章，`m` 标为已读，`s` 收藏，`c` 复制成 Markdown。

助手也能看到你的未读。你可以让它整理一份速览，按分类写一份简报，或者把某篇文章读完，再把要点讲给你听。

## 安装

你需要先装好 DeepSeek Harness（0.2 以上），并且有一个自己的 Miniflux 服务器（2.0 以上就行；想要批量收藏，需要 2.3.2 以上）。

```bash
dsh plugin --profile desktop add /path/to/dsh-miniflux-digest
```

装好之后，在插件管理里把 `rss-miniflux` 这一行打开，侧栏就会出现面板。以后更新时，先把仓库更新到最新，再把这一行关掉重新打开即可。

## 连接

第一次打开面板，它会问你的 Miniflux 地址和 API 令牌（在 Miniflux 里打开「设置 → API 密钥」就能创建）。填完会当场测试一次，连不上会直接告诉你原因。

不想手填的话，也可以设置环境变量 `MINIFLUX_BASE_URL` 和 `MINIFLUX_API_TOKEN`，或者写进插件的配置项。优先级从高到低是插件配置、保存过的凭据、环境变量。

暂时没有账号也没关系，关掉对话框，先看看内置的示例条目。

## 助手工具

这六个工具用的是同一个账号、同一份未读数据。

| 工具 | 用来做什么 |
| --- | --- |
| `miniflux_overview` | 查看连接状态，以及每个分类、每个订阅源还有多少篇没读 |
| `miniflux_digest` | 生成一份未读速览，写清时间跨度、内容都来自哪儿、哪几篇值得慢慢读，并附上理由 |
| `miniflux_briefing` | 按分类让模型写一份简报，直接在对话里给你 |
| `miniflux_read` | 取出一篇文章的全文，Markdown 格式 |
| `miniflux_search` | 按关键词搜索条目 |
| `miniflux_act` | 标为已读或未读、收藏、刷新某个订阅源或分类 |

平时可以这样问：

> 帮我按「科技」分类写份简报，说说出现最多的三个话题。

> 看一眼我的未读，挑三篇值得慢慢读的。

## 你的数据

API 令牌保存在这台机器的 DeepSeek Harness 配置里，不会写进插件配置文件，也不会出现在仓库里。

除了你自己的 Miniflux 服务器，插件唯一的外部请求是 X 条目的视频地址（`cdn.syndication.twimg.com`），只取一次，不会存到硬盘上。

插件在后台留的短期缓存，和浏览器里存的快照，作用只是让你下次打开时快一点。断开连接、退出登录或者切换账号，这些缓存都会被清空。

## 限制

- 你需要有自己的 Miniflux 服务器，没有联网就用不了。
- 面板是按桌面宽度设计的，窗口变窄以后，右侧的阅读栏会被挤得很小。
- 抓取原文、发现订阅来源、批量收藏这几个功能，能不能用取决于你的 Miniflux 版本。
- 「星标」视图只统计最近 1000 条星标，如果你收藏得特别多，清单会显示不全。
- 内置的示例条目是虚构的，方便你在连上服务器之前先看看界面长什么样。

关于段落缩进、代码块识别，以及视频在哪些情况下会失败，这些细节都写在 [docs/limitations.md](docs/limitations.md)。

## 许可

本项目使用 MIT 许可，见 [LICENSE](LICENSE)。

`preview/data.mjs` 和 `lib/demo.js` 里的源名、标题、正文都是虚构的，截图也由这份数据生成。请不要把真实的账号名、服务器地址和订阅清单带进仓库。

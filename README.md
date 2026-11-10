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

**Elegant Miniflux RSS digest for your DeepSeek Harness.**

订阅都躺在 Miniflux 里，可真要读的时候，还是得开网页、点来点去。这个插件把未读直接搬进 DeepSeek Harness 的侧栏，翻列表、读长文、问助手，都在同一个地方。

面板分三栏，左边是分类和订阅源，中间是文章列表，右边就是正文。点一下列表就开始读，不会跳去新标签页。字号、行高、行宽都能调，有明暗两套配色，还有一个纸面底色。图片会稍微伸出栏外，脚注点了就地展开，代码块上标着是什么语言。

关掉面板再回来，还是刚才那篇文章、那个位置，内容已经在，不用盯着空白等它加载。筛选也不会自己跳回去，星标、未读、全部，换个分类还是原来那个。

界面有中英文两套，在设置里随时换。YouTube、Bilibili 和 X 的视频能直接在文章里播。常用的操作都配了快捷键，`j` / `k` 上下条，`m` 标已读，`s` 收藏，`c` 复制成 Markdown。

还有一件事挺省心，助手看得到你的未读。可以让它做一份速览，按分类写份简报，或者把某篇读完，讲要点给你听。

## 安装

需要 DeepSeek Harness 0.2 以上，再加一台能连上的 Miniflux（2.0 以上就够，2.3.2 以上才支持批量收藏）。

```bash
dsh plugin --profile desktop add /path/to/dsh-miniflux-digest
```

装好之后，在插件管理里把 `rss-miniflux` 这一行打开，侧栏就会出现面板。以后更新，拉一下仓库，把这一行关掉再打开就行。

## 连接

第一次打开面板，它会问你的 Miniflux 地址和 API 令牌（在 Miniflux 里找 设置 → API 密钥）。填完当场测一次，连不上会直接告诉你。

不想手填也可以，设 `MINIFLUX_BASE_URL` 和 `MINIFLUX_API_TOKEN`，或者写进插件 config。优先级是 config 最高，其次是保存过的凭据，最后才是环境变量。

暂时没有账号也没什么，关掉对话框，先看看内置的示例条目。

## 助手工具

这六个工具用的是同一个账号、同一份未读。

| 工具 | 用来做什么 |
| --- | --- |
| `miniflux_overview` | 看连接状态，以及每个分类、每个源还有多少没读 |
| `miniflux_digest` | 一份未读速览，写清时间跨度、都来自哪儿、哪几篇值得慢慢读，并附上理由 |
| `miniflux_briefing` | 按分类让模型写一份简报，直接在对话里给你 |
| `miniflux_read` | 取一篇文章的全文，Markdown 格式 |
| `miniflux_search` | 按关键词搜条目 |
| `miniflux_act` | 标已读 / 未读、收藏、刷新某个源或分类 |

平时可以这样问：

> 帮我按「科技」分类写份简报，说说出现最多的三个话题。

> 看一眼我的未读，挑三篇值得慢慢读的。

## 你的数据

令牌存在这台机器的 Harness profile 里，不进配置文件，也不会出现在仓库里。

除了你自己的 Miniflux，唯一的外部请求是 X 条目的视频地址（`cdn.syndication.twimg.com`），只取一次，不落盘。

Host 上的短期缓存和浏览器里的快照，作用只是让下次打开快一点。断开连接、退出登录或者换账号，都会清空。

## 限制

- 得有一台能连上的 Miniflux，没有离线模式。
- 面板按桌面宽度做的，窗口一窄，阅读栏就挤。
- 抓取原文、发现订阅、批量收藏，要看你背后的 Miniflux 版本。
- 星标视图只统计最近 1000 条星标，收藏特别多的账号会显示不全。
- 示例条目是编的，用来在连上之前先看看样子。

缩进怎么处理、代码块怎么认、视频在哪些情况下会失败，这些细节写在 [docs/limitations.md](docs/limitations.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。

`preview/data.mjs` 和 `lib/demo.js` 里的源名、标题、正文都是编的，截图也由这份数据生成。真实账号名、服务器地址和订阅清单，请不要带进仓库。

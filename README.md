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

订阅在 Miniflux，阅读放在 DeepSeek Harness 里。这个插件把两者接起来：一个面板看完未读，长文就地读完，也可以直接问助手哪几篇值得花时间。

## 它能做什么

- **一个面板三栏**：左边分类与订阅源，中间文章列表，右边正文，不跳新标签页。
- **为长时间阅读做的**：字号、行高、行宽可调；纸面底色；暗色模式；图片可以伸进页边；脚注就地弹出；代码块标出语言。
- **回来还在原处**：再打开还是那篇文章、那个滚动位置，内容已经在，不会先白一下。
- **筛选联动**：星标 / 未读 / 全部同时作用于订阅清单和文章列表。
- **中英双语**：设置 → 通用里随时切换。
- **视频内嵌播放**：YouTube、Bilibili、X。
- **键盘优先**：`j` / `k`、`m`、`s`、`c`、`v`、`g`、`w`、`f`。
- **助手读同一份数据**：可以要一份未读速览、某个分类的简报，或者让它直接读某篇。

## 安装

```bash
dsh plugin --profile desktop add /path/to/dsh-miniflux-digest
```

然后在插件管理里打开 `rss-miniflux` 这一行，侧栏就会出现面板。

## 连接

第一次打开会问两件事：Miniflux 地址和 API 令牌（Miniflux → 设置 → API 密钥），填完立刻验证。不想手填就用 `MINIFLUX_BASE_URL`、`MINIFLUX_API_TOKEN`，或写进插件 config；三者优先级是 config > 已保存凭据 > 环境变量。

没有账号也可以先关掉弹框，看内置的示例条目。

## 助手工具

`miniflux_overview` 看连接与未读分布，`miniflux_digest` 要一份未读速览，`miniflux_briefing` 按分类生成简报，`miniflux_read` 读全文，`miniflux_search` 搜条目，`miniflux_act` 标已读、收藏、刷新。

## 你的数据

- **令牌只在本机**：存在 Harness profile 的凭据记录里，不写配置文件，也不会进这个仓库。
- **只有一个方向的网络请求**：只连你自己的 Miniflux；X 条目额外向 `cdn.syndication.twimg.com` 取一次视频地址。
- **缓存随时可丢**：Host 上的短期缓存和浏览器里的快照只是让重开更快，断开连接或换账号就清空。

## 限制

需要能访问的 Miniflux 实例，没有离线模式；面板按桌面宽度设计；抓取原文、发现订阅、批量收藏都依赖 Miniflux 版本；星标视图只统计最近 1000 条星标。更细的边界情况见 [docs/limitations.md](docs/limitations.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。`preview/data.mjs` 与 `lib/demo.js` 里的源名、标题、正文全部虚构，截图也由这份示例数据生成——真实账号名、服务器地址和订阅清单不要出现在仓库里。

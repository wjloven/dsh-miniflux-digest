# 让桌面宿主为 YouTube 提供 Referer

YouTube 的 [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality#embedded-player-api-client-identity) 要求嵌入方向 YouTube 提供 `Referer` 做身份识别，并明确写了：

> In environments where `HTTP Referer` is empty by default and not automatically set by the browser, API Clients must take action to provide their identity through alternative means. **In WebView integrations such as a mobile app or desktop app, `HTTP Referer` is empty by default.**

插件这一侧能做的已经做满：
- 播放器页 `/rss-miniflux/player?id=…` 自己发 `Referrer-Policy: strict-origin-when-cross-origin`（响应头 + `<meta>` 双保险），并自检能不能发出 Referer；
- 发不出时降级成缩略图卡片，而不是黑底 Error 153。

**发不出 Referer 的环境只能由宿主补**——这正是 NetNewsWire 7.1.2 做的事（`loadHTMLString:baseURL:` 换成文章真实站点），也是本文要交给 DSH 的改动。

实测证据（headless Chromium，响应头 `Referrer-Policy: no-referrer` 的页面）：

| 请求方式 | 服务端看到的 Referer |
| --- | --- |
| `fetch()`，未指定策略 | 空 |
| `fetch(..., { referrerPolicy: 'strict-origin-when-cross-origin' })` | `http://127.0.0.1:5630/noref` |
| `<iframe>`，无 `referrerpolicy` | 空 |
| `<iframe referrerpolicy="strict-origin-when-cross-origin">` | 带上（且 YouTube 能播） |

所以：**页面内能做的只剩"不抑制"**；"凭空造一个"只能由发请求的一方做。

## 改动一：给 YouTube 域的请求补 Referer（最小改动）

在 Electron 主进程（`app.whenReady()` 之后）加：

```js
const { session } = require('electron')

const YOUTUBE = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:youtube\.com|youtube-nocookie\.com|youtu\.be|googlevideo\.com|ytimg\.com)\//i

app.whenReady().then(() => {
  const ses = session.defaultSession
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders }
    if (!headers.Referer && !headers.referer) {
      // 必须是合法、可解释的 https 源；不要伪造他人域名。
      headers.Referer = 'https://deepseek-harness.app/'
      headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    }
    callback({ requestHeaders: headers })
  })
})
```

要点：

- **只在缺失时补**，不覆盖页面自己发出的 Referer（插件已经会发）。
- 值用**自有域名**，不要伪装成别人的站点。
- 同时下发 `Referrer-Policy: strict-origin-when-cross-origin`，避免下游再把头砍掉。

## 改动二：文章本身就是 youtube.com 时的回退（NetNewsWire Phase 2）

对应 NetNewsWire 的 `24b2b1f`（7.2）：当 RSS 条目的链接本身指向 `youtube.com` / `youtu.be` 时，**不要用文章 URL 当 baseURL/Referer**（会触发 `Error 152-4`，来源与目标同域的自引用），回退到一个固定的自有 https 源。

在插件侧，这条已经天然满足：播放器页永远是我们自己的路径，YouTube 拿到的 Referer 是宿主的固定源，而不是某个 `youtube.com` 文章地址。宿主侧只需保证上面的 Referer 是**稳定的自有域名**，不要按文章 URL 动态生成。

## 实测：补上 Referer 就能播

用 CDP 在 headless Chromium 里**模拟一个剥掉所有 Referer 的宿主**（`Fetch.requestPaused` 时删掉 `Referer` 再放行），两种条件各跑一次：

| 条件 | 播放区 |
| --- | --- |
| 只剥不补 | 全黑，播不了 |
| 给 `*.youtube.com` / `*.youtube-nocookie.com` 注入 `Referer: https://deepseek-harness.app/` | 正常播放 |

截图：`preview/shots/youtube-153-shell-strip.png`、`preview/shots/youtube-153-shell-inject.png`。

这说明补丁的位置和值都对：**缺的是请求层的头，不是页面里的属性**。

## 验证

改完重启应用，打开一篇带 YouTube 的视频文章：

1. 播放器能播 → 成功；
2. 仍显示缩略图卡片 → 说明头还没补上，检查 `onBeforeSendHeaders` 是否命中 `*.youtube-nocookie.com`（播放器用的是 nocookie 域）。

插件侧的探针也会变：卡片只在**播放器页自己也发不出 Referer**时出现，改动生效后卡片会自动消失。

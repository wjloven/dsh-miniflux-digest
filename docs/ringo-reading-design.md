# 从 nnw-ringo 借阅读主题：取舍与落地

> 对照对象：[jonastaedcke/nnw-ringo](https://github.com/jonastaedcke/nnw-ringo)（Apache-2.0），NetNewsWire 的阅读主题，设计上照 Reeder Classic 的文章排版。本文只记录"借了什么、没借什么、改在哪"；没有复制它的样式表代码。

## 结论

- **值得借的核心是三件事**：媒体出血（图片伸进页边、图注留在栏内）、页眉信息分层（feed 图标 + 相对日期 + kicker）、就地脚注（popover 而不是跳到文末）。
- **主题层借的是"暖纸面 + 正文比标题暗一档"**：它在暗色下把正文压到 `#b9b9b9`、标题留在 `#e2e2e2`，长文久读不刺眼。本插件做成了一个可选底色，而不是替换宿主主题。
- **不能照搬的是它的 class 选择器**：Ringo 依赖 NetNewsWire 保留 `wp-caption`、`kg-bookmark` 这类 class；本插件的清洗器只发白名单标签、丢掉全部 class，所以同类判断必须在 Host 侧做（`lib/html.js`），客户端只认我们自己打的 `data-mrss-*` 标记。

## Ringo 是什么

| 项 | 事实 |
| --- | --- |
| 形态 | NetNewsWire 主题包：`Info.plist` + `stylesheet.css`（约 105 KB）+ `template.html`（约 212 KB，含 Article JavaScript） |
| 许可 | Apache-2.0 |
| 设计基线 | 单一基准字号 + 全 rem 比例；亮 / 暗 / 高对比三套 token；`font-synthesis:none` |
| 迭代史 | CHANGELOG 有 48 个版本、近 300 条修复，本身就是一份"阅读细节清单"（相对日期、脚注 popover、代码复制、kicker、空段落清理…） |
| 关键结构 | 文章 = `article-header`（feed 图标 / kicker / 标题 / dateline / byline）+ `articleBody`；媒体用 `position:relative` + `translate` 从栏里"长出去" |

## 借了什么

| 维度 | Ringo 的做法 | 本插件的落地 | 代码位置 |
| --- | --- | --- | --- |
| 阅读底色 | 亮 `#f7f6f4` / 暗 `#1b1b1b`，层与边框同色系 | 新增 **Appearance → 阅读底色：默认 / 纸面**；纸面亮 `#f5f1e8`、暗 `#1b1b1b`，链接转蓝 `#0066cc` / `#6cb0ff` | `data-mrss-surface="paper"` |
| 暗色正文降亮 | 正文 `#b9b9b9`，标题 `#e2e2e2` | 暗色下正文按 88% 混入底色，标题保持最亮；`prefers-contrast: more` 再拉回 | `--mrss-reading-color` |
| 媒体出血 | 图片/视频宽出栏，图注留栏内 | 媒体 `inline-size` 上限 = 栏宽 + 2×内边距，`inset-inline-start:50%` + `translate:-50%` 居中；窄图不放大 | `.mrss-article-body :is(img,video):not(figure *)` |
| 页眉分层 | feed 图标（灰度）+ kicker + 相对日期（点击切完整）+ 作者折叠 | 同左；CJK 前导超过 12 字不拆 kicker，西文 28 字 | `splitKicker` / `authorsOf` / `fullDate` |
| 链接 | 外链下划线取 40% 当前色，hover 变实 | 同左；`href^="#"` 的页内锚点不加下划线 | `.mrss-article-body a` |
| 代码块 | header 左侧语言、右侧复制，1.5s 反馈 | 同左；Host 从 `class="language-x"` 推语言名并写 `data-lang`，客户端补 header 与复制按钮 | `annotateCodeLanguages` + `.mrss-code` |
| 脚注 | 就地 popover、背板变暗、可返回正文 | 同左；Host 把 `#fn1` / `#_ftn1` / 数字上标统一改写成 `mrss-N` 并标 `data-mrss-fn` / `data-mrss-note` | `rewriteIds` + `.mrss-fn-pop` |
| 宽表格 | 横向滚动，不撑破栏 | `table{display:block;overflow-x:auto}` | CSS |
| 空段落 / 重复标题 | 隐藏占位段、隐藏与标题重复的首个 h1 | Host 侧 `tidyArticle`：空 `<p>`、标题重复、紧跟标题的 `<hr>` 一起清掉 | `lib/html.js` |
| 高对比 / 减少动效 | `prefers-contrast`、`prefers-reduced-motion` 两套兜底 | 同左，且程序化滚动（目录、脚注、导轨）也读 `prefers-reduced-motion` | CSS + `scrollBehavior()` |
| 遮罩 | 变暗，而不是糊一层白 | 设置弹层 / 脚注背板改成黑色 22–30% | `.mrss-manage` / `.mrss-dialog-layer` / `.mrss-fn-veil` |

## 没借的

| 项 | 理由 |
| --- | --- |
| 语法高亮（highlight.js） | 要引第三方运行时；Miniflux 正文里代码块占比很低，语言标签 + 复制已经够用 |
| 脚注的 provider 适配 | Ringo 针对 Substack / WordPress 等具体输出写适配器；我们只认通用形状（`fn*` / `_ftn*` / 上标数字），不为单个博客加特例 |
| 发邮件分享 / 主题自更新角标 | NetNewsWire 生态特有，DSH 面板里没有对应位置 |
| 图片 `mix-blend-mode` 融入页面 | 对截图、透明 logo 有效，对照片会误伤；判断成本高于收益 |
| 标题自链接 `#` | 阅读器里有目录和导轨，鼠标划过标题出现 `#` 属于网站 SEO 习惯 |
| 缩写 tooltip | 需要维护词典与定位逻辑，收益低于脚注 |
| Sphinx / MkDocs admonition 上色 | 判定要靠 `class="admonition"`，而清洗器丢 class；要做也得先在 Host 白名单里加一档标记，留到下一轮 |

## 需要记住的约束

- **class 进不来**：`lib/html.js` 只保留白名单标签，属性只认 `href/title/src/alt/width/height/...` 与我们自己生成的 `id="mrss-*"`、`data-mrss-*`、`data-lang`。所以"按源站 class 排版"这条 Ringo 的主路径不可用，所有判断只能在 Host 侧做一次、结果写成 data 属性。
- **id 必须改写**：正文里的 `#fn1`、`#section-2` 原来会被 `safeUrl` 绝对化成整页 URL（点了就整页跳走）。现在先收集 id、映射成 `mrss-N`，再改写所有 fragment 链接，最后才允许白名单放行——页内跳转和脚注返回因此在阅读区内部完成。
- **脚注只在"能配对"时启用**：marker 的 href 必须能指向文中存在的 id，且形状像脚注（`fn*`/数字上标/`↩`）。配对不上就保持普通链接，不做猜测。

## 在预览里看

```bash
node preview/server.mjs        # http://127.0.0.1:5577
node tests/reader-shot.mjs --out /tmp/ringo --theme light --surface paper --note --settings
```

`tests/reader-shot.mjs` 会打开首条（或 `--row` 命中那条）、滚到图片与代码块、按需打开脚注 popover 与设置页，并打印实测尺寸（文章盒宽、图片左右边界、代码头、脚注卡片宽高）。

| 截图 | 内容 |
| --- | --- |
| `preview/shots/reader-light.jpg` | 默认底色 + kicker 标题 + 页眉 |
| `preview/shots/reader-paper.jpg` | 纸面底色 |
| `preview/shots/reader-dark.jpg` | 纸面暗色 |
| `preview/shots/reader-figure.jpg` | 媒体出血 + 代码块头 + 脚注上标 |
| `preview/shots/reader-footnote.jpg` | 脚注 popover 与背板 |
| `preview/shots/settings-appearance.jpg` | Appearance 里的「阅读底色」 |

实测（1280 px 面板、16 px 字号）：文章盒 655 px，图片左右边界 613–1269，正好等于"栏宽 + 两侧 32 px 内边距"；脚注卡片 368×120。

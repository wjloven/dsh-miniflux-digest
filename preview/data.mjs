/**
 * Preview data for the side-by-side UI work: a catalog shaped exactly like
 * `/rss-miniflux/api/bootstrap` plus entries and article bodies.
 */
import { sanitizeArticleHtml } from '../lib/html.js'

const C = { articles: 4, arts: 2, community: 5, video: 6 }

/**
 * Invented feeds. Names, ids and counts here are fictional so the public repo
 * does not publish anyone's subscription list; keep it that way when adding
 * samples.
 */
const feeds = [
  // Articles (8)
  { id: 1, title: '北岸周刊', categoryId: C.articles, unread: 12 },
  { id: 2, title: 'Orbit Review', categoryId: C.articles, unread: 3 },
  { id: 3, title: '慢速互联网', categoryId: C.articles, unread: 4 },
  { id: 4, title: 'Kernel Notes', categoryId: C.articles, unread: 2 },
  { id: 5, title: 'Aperture Weekly', categoryId: C.articles, unread: 1 },
  { id: 6, title: 'The Long Read', categoryId: C.articles, unread: 19 },
  { id: 7, title: '字里行间', categoryId: C.articles, unread: 7 },
  { id: 8, title: 'Paper & Pixel', categoryId: C.articles, unread: 0 },
  // Arts (4)
  { id: 9, title: 'Studio Field', categoryId: C.arts, unread: 9 },
  { id: 10, title: '铅字与墨', categoryId: C.arts, unread: 3 },
  { id: 11, title: 'Frame Studio', categoryId: C.arts, unread: 1 },
  { id: 12, title: 'Colophon', categoryId: C.arts, unread: 5 },
  // Community (4)
  { id: 13, title: '街角通讯', categoryId: C.community, unread: 4 },
  { id: 14, title: 'Signal Chain', categoryId: C.community, unread: 2 },
  { id: 15, title: '小院电台', categoryId: C.community, unread: 1 },
  { id: 16, title: 'The Commons', categoryId: C.community, unread: 24 },
  // Video (4)
  { id: 17, title: 'Buffer Notes', categoryId: C.video, unread: 4 },
  { id: 18, title: 'Weekly Reel', categoryId: C.video, unread: 2 },
  { id: 19, title: 'Night Shift', categoryId: C.video, unread: 22 },
  { id: 20, title: 'Elsewhere Daily', categoryId: C.video, unread: 6 },
]

const categoryMeta = [
  { id: C.articles, title: 'Articles' },
  { id: C.arts, title: 'Arts' },
  { id: C.community, title: 'Community' },
  { id: C.video, title: 'Video' },
]

export const categories = categoryMeta.map((category) => {
  const own = feeds.filter((feed) => feed.categoryId === category.id)
  return {
    id: category.id,
    title: category.title,
    totalUnread: own.reduce((sum, feed) => sum + feed.unread, 0),
    feedCount: own.length,
  }
})

/** A few sources whose last crawl failed, so the warning flag is visible. */
const FEED_ERRORS = {
  2: 'The requested resource is not found. Please, verify the URL.',
  10: 'The website is not available at the moment due to a server error.',
  16: 'The feed returned a 404. Please, verify the URL.',
  19: 'This feed is empty or does not contain any item.',
}

export const catalog = feeds.map((feed) => ({
  ...feed,
  categoryTitle: categoryMeta.find((category) => category.id === feed.categoryId)?.title || '',
  feedUrl: `https://example.com/feeds/${feed.id}.xml`,
  disabled: false,
  lastError: FEED_ERRORS[feed.id] || '',
}))

const MINUTE = 60_000

const TITLES = [
  '慢读实验：我把未读变成了三个入口',
  'Pixel 10 的 Tensor G5 跑分泄露，能效比仍是短板',
  'The iPad Pro Is a Computer, Just Not the One You Want',
  '技术周刊（第 330 期）：把复杂留给自己',
  'Aggregation Theory in the Age of Agents',
  '谁在买下 AI 应用层',
  '用 Claude 写了一个月的代码，我改掉了这些习惯',
  'The quiet joy of a well-made list',
  '这些新锐设计师把字体做成了主角',
  '字体的呼吸：中文排版里的行距与字距',
  '台北街头的招牌美学，正在消失吗',
  '一位陶艺家的 40 年：把泥土烧成时间',
  'AI 时代，我们还怎么写作',
  '信息过载的另一个解法：少订阅，慢阅读',
  '我为什么不再追热点',
  '本周事实核查：三张被误读的图表',
  'What I learned shipping an AI product to 10k users',
  '设计工具的新一轮竞赛',
  'The Case Against Optimization',
  '为什么东南亚的创作者在搬到 YouTube 之外',
  'A small town newspaper went digital and survived',
  '关于睡眠的七个常见误解',
  '把博客从 WordPress 搬到 Astro 之后',
  'The messy middle of building a design system',
  '一本书的封面是怎么被做出来的',
  '为什么我们总在高估短期、低估长期',
  'Notes on writing every day for a year',
  '手冲咖啡的水温，到底重要吗',
  'A field guide to slow software',
  '这周我关掉了 12 个通知',
  '城市里的第三空间正在消失',
  'How to read a chart that disagrees with you',
  '从报纸到 newsletter：一份内容产品的十年',
  'The economics of a one-person newsletter',
  '为什么好的排版让人愿意读完',
  '用 40 个源替代 400 个源之后',
  'A visit to the last type foundry in town',
  '播客做到第 200 期，我学到了什么',
  '把阅读器做成自己的工作台',
  'The art of leaving things out',
]

const EXCERPTS = [
  '真正难的不是把 RSS 拉下来，而是如何在不打扰用户的前提下，让未读变成一个可以执行的清单。',
  '这一代芯片把重心放在 NPU 上，但日常使用的续航并没有明显改善。',
  'Apple keeps insisting the iPad is a computer. The hardware agrees; the software still disagrees.',
  '本期聊了播客、字体、以及为什么我又换回了 RSS 阅读器。',
  'The internet is being reorganized around agents, and the companies that own the demand will own the supply.',
  '一份关于 AI 应用层并购的清单，附带我们听到的估值口径。',
  '模型写代码越来越像实习生：能跑通，但需要你指出它没想清楚的地方。',
  'A list is a form of care: it tells the reader what you decided to leave out.',
  '一组来自伦敦的新锐工作室，把可变字体做成了会呼吸的封面。',
  '中文排版最容易被忽略的是标点挤压和行首行尾的避头尾规则。',
  '招牌是城市最直接的字体样本，也是最先被标准化抹平的东西。',
  '在景德镇的一个小院子里，他做了四十年同样的器型。',
  '写作的门槛从来不是工具，而是你有没有值得说的东西。',
  '把订阅从 400 个砍到 40 个之后，我的阅读时间反而变多了。',
  '热点是别人的节奏，慢下来才有自己的判断。',
  '同一份数据，在三个平台被读出了三种结论。我们回到原始表格。',
  'A year of building in public, with the numbers we usually hide.',
  '本周值得关注的 9 个设计工具更新。',
  'Why doing less, deliberately, is the only sustainable advantage left.',
  'Creator economies outside the US are growing faster than the platforms are ready for.',
]

export const entries = []
let nextId = 9000
for (const feed of catalog) {
  const total = Math.max(feed.unread, 1)
  for (let index = 0; index < total; index += 1) {
    const seed = nextId
    const unread = index < feed.unread
    entries.push({
      id: seed,
      title: TITLES[(seed + index) % TITLES.length],
      url: `https://example.com/${seed}`,
      author: index % 5 === 0 ? '编辑部' : '',
      publishedAt: new Date(Date.now() - (12 + index * 37 + (seed % 11) * 13) * MINUTE).toISOString(),
      readingMinutes: 2 + ((seed + index) % 9),
      starred: index % 6 === 2,
        status: unread ? 'unread' : 'read',
      cover: index % 3 === 0 ? `/mock-cover.svg?i=${seed % 12}` : '',
      feedId: feed.id,
      feedTitle: feed.title,
      categoryId: feed.categoryId,
      categoryTitle: feed.categoryTitle,
      excerpt: EXCERPTS[(seed + index) % EXCERPTS.length],
      textLength: 2400 + index * 120,
    })
    nextId += 1
  }
}

// Provider video samples: the reader reframes these from the entry URL alone,
// so the preview exercises YouTube / Bilibili / X without a Host payload.
const X_VIDEO = 'https://x.com/example/status/1234567890123456789'
const EMBED_SAMPLES = [
  ['https://www.youtube.com/watch?v=aqz-KE-bpKQ', 'Big Buck Bunny · Blender (YouTube)'],
  ['https://www.bilibili.com/video/BV1GJ411x7h7', 'Bilibili 示例视频'],
  ['https://x.com/jack/status/20', 'jack on X（纯文本）'],
  [X_VIDEO, 'X 视频示例'],
]
entries
  .filter((entry) => entry.feedId === 17)
  .slice(0, EMBED_SAMPLES.length)
  .forEach((entry, index) => {
    entry.url = EMBED_SAMPLES[index][0]
    entry.title = EMBED_SAMPLES[index][1]
  })

export function article(id, origin = '') {
  const item = entries.find((entry) => entry.id === Number(id))
  if (!item) return null
  const base = String(origin || 'http://127.0.0.1:5577').replace(/\/+$/, '')
  // Written in feed shape on purpose: relative image, language class on the
  // code, footnote markers + notes with ids. The real sanitizer runs over it, so
  // the preview exercises the Host pipeline rather than a hand-made payload.
  const body = `
    <p>${item.excerpt}</p>
    <p>这一段带一个<a href="https://example.com/notes">外部链接</a>，以及一个指向<a href="#h2">第二节</a>的内部跳转。</p>
    <figure>
      <img src="${base}/mock-photo.svg" alt="山间的雾">
      <figcaption>山间的雾，示意图（preview 本地生成）。</figcaption>
    </figure>
    <h2 id="h1">一、问题从哪里开始</h2>
    <p>把这件事拆开看，其实只有三步：先承认信息已经过载，再承认自己不可能全部读完<sup id="fnref1"><a href="#fn1">1</a></sup>，最后设计一个能在十分钟内完成的阅读路径。</p>
    <p>这三步听起来简单，但每一步都会遇到阻力。比如第二步——承认读不完——很多人会用「稍后读」来回避，结果稍后读变成了永久未读。</p>
    <p>真正起作用的不是工具，而是判断标准<sup><a href="#fn2">2</a></sup>。</p>
    <pre class="language-js"><code>const feeds = await miniflux.feeds()
const unread = feeds.reduce((sum, feed) =&gt; sum + feed.unread, 0)
console.log(unread)</code></pre>
    <h2 id="h2">二、我把未读变成了什么</h2>
    <p>我把它变成了三个入口：一个按分类生成的简报、一个只放未读的列表、一个可以随时展开的订阅源树。</p>
    <ul><li>简报负责回答「最近发生了什么」。</li><li>列表负责回答「哪一篇值得现在读」。</li><li>订阅源树负责回答「这个分类里到底有哪些源」。</li></ul>
    <h3>关于分类的取舍</h3>
    <p>分类不需要很多，四到六个刚好。太多会让左侧栏变成一棵需要打理的树。</p>
    <h2 id="h3">三、结果</h2>
    <p>一周之后，我每天花在阅读器里的时间从 40 分钟降到 15 分钟，但记住的东西变多了。原因大概是：读之前就知道为什么读。</p>
    <blockquote>工具的价值不在于它能装下多少内容，而在于它敢不敢替你丢掉一些。</blockquote>
    <hr>
    <ol>
      <li id="fn1">第一条脚注：信息过载的统计口径见作者的年度回顾。<a href="#fnref1">↩</a></li>
      <li id="fn2">第二条脚注：这里的「判断标准」指读之前能说出为什么读。<a href="#fn1">↩</a></li>
    </ol>
  `
  const baseUrl = item.url || `${base}/`
  const { html, toc, notes } = sanitizeArticleHtml(body, baseUrl, { title: item.title })
  // The Host enriches X entries with tweet media; the preview mocks the video
  // case so the media block can be checked without calling X.
  const embeds = item.url === X_VIDEO
    ? [{
      provider: 'x',
      id: '1234567890123456789',
      tweet: {
        text: '',
        name: 'Example User',
        screenName: 'example',
        createdAt: '',
        images: [],
        videos: [{ src: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', poster: '' }],
      },
    }]
    : []
  return {
    embeds,
    item: {
      id: item.id,
      title: item.title,
      url: item.url,
      author: item.author,
      publishedAt: item.publishedAt,
      readingMinutes: item.readingMinutes,
      starred: item.starred,
      status: item.status,
      feedId: item.feedId,
      feedTitle: item.feedTitle,
      categoryTitle: item.categoryTitle,
    },
    html,
    toc,
    notes,
    markdown: `# ${item.title}\n\n${item.excerpt}`,
    textLength: item.textLength,
    excerpt: item.excerpt,
  }
}

export const models = {
  models: [
    { id: 'deepseek::flash', provider: 'deepseek', model: 'flash', label: 'DeepSeek-V4.1-Flash', providerLabel: 'DeepSeek' },
    { id: 'deepseek::pro', provider: 'deepseek', model: 'pro', label: 'DeepSeek-V4.1-Pro', providerLabel: 'DeepSeek' },
  ],
  defaultId: 'deepseek::flash',
  error: '',
}

export const efforts = {
  efforts: [
    { id: 'off', name: 'Off', description: 'Fastest' },
    { id: 'low', name: 'Low', description: '' },
    { id: 'high', name: 'High', description: '' },
    { id: 'max', name: 'Max', description: '' },
  ],
  defaultId: 'high',
}

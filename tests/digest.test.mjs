import assert from 'node:assert/strict'
import { demoEntries } from '../lib/demo.js'
import { buildDigest, normalizeEntry } from '../lib/digest.js'
import { extractEmbeds, markdownFromHtml, sanitizeArticleHtml, textFromHtml, estimateMinutes } from '../lib/html.js'
import { tweetFromSyndication } from '../lib/tweet.js'

const entries = demoEntries(Date.now()).map((entry) => normalizeEntry(entry, { demo: true }))
const digest = buildDigest(entries, { demo: true, total: entries.length })

console.log('--- digest ---')
console.log(JSON.stringify({
  counts: digest.counts,
  window: digest.window,
  echoes: digest.echoes.map((echo) => ({ label: echo.label, size: echo.size })),
  recommendations: digest.recommendations.map((item) => ({ id: item.id, score: item.score, minutes: item.minutes, reasons: item.reasons })),
  stance: digest.stance,
  timeline: digest.timeline,
}, null, 2))

assert.equal(digest.counts.unread, entries.length)
assert.ok(digest.counts.minutes > 20, 'expected a meaningful reading load')
assert.ok(digest.recommendations.length >= 3, 'expected recommendations')
assert.ok(digest.recommendations[0].reasons.length >= 2, 'top recommendation explains itself')
assert.ok(Array.isArray(digest.echoes), 'echoes is always present')
assert.ok(digest.counts.feeds === 5, `expected 5 feeds, got ${digest.counts.feeds}`)

// Sanitizer: scripts, handlers and javascript: URLs must disappear.
const dirty = `<div onclick="x()"><script>alert(1)</script><p style="color:red">hi <b>there</b></p>
<a href="javascript:alert(1)">bad</a><a href="/rel?a=1&amp;b=2">rel</a>
<img src="https://example.com/a.png" onerror="x()" alt="pic">
<iframe src="https://evil"></iframe><h2>标题 一</h2><h3>Sub</h3></div>`
const sanitized = sanitizeArticleHtml(dirty, 'https://example.com/post/1')
console.log('--- sanitized ---')
console.log(sanitized.html)
assert.ok(!/script/i.test(sanitized.html))
assert.ok(!/onclick|onerror|style=/i.test(sanitized.html))
assert.ok(!/javascript:/i.test(sanitized.html))
assert.ok(sanitized.html.includes('href="https://example.com/rel?a=1&amp;b=2"'))
assert.ok(sanitized.html.includes('<img loading="lazy"'))
assert.equal(extractEmbeds('', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x')[0].provider, 'youtube')
assert.equal(extractEmbeds('', 'https://youtu.be/dQw4w9WgXcQ')[0].id, 'dQw4w9WgXcQ')
assert.equal(extractEmbeds('', 'https://www.youtube.com/shorts/dQw4w9WgXcQ')[0].id, 'dQw4w9WgXcQ')
assert.equal(extractEmbeds('<iframe src="//player.bilibili.com/player.html?bvid=BV1GJ411x7h7"></iframe>', '')[0].id, 'BV1GJ411x7h7')
assert.equal(extractEmbeds('', 'https://www.bilibili.com/video/av170001/')[0].id, 'av170001')
assert.equal(extractEmbeds('', 'https://x.com/NASA/status/1234567890123456789?s=20')[0].provider, 'x')
assert.equal(extractEmbeds('', 'https://platform.twitter.com/embed/Tweet.html?id=1234567890')[0].id, '1234567890')
assert.equal(extractEmbeds('', 'https://example.com/post').length, 0, 'plain pages have no embeds')
assert.equal(extractEmbeds('<iframe src="https://evil.example/embed"></iframe>', '').length, 0)
assert.ok(!sanitized.html.includes('evil'), 'provider-less iframes stay dropped')
const feedVideo = sanitizeArticleHtml('<video src="https://video.twimg.com/a.mp4"></video>', 'https://x.com/a/status/1')
assert.ok(feedVideo.html.includes('controls'), 'feed videos get controls')
assert.ok(feedVideo.html.includes('preload="metadata"'), 'feed videos get a preload hint')
assert.ok(!/autoplay/i.test(feedVideo.html), 'feed videos never autoplay')
assert.equal(sanitized.toc.length, 2)

// Reader enrichments: ids are rewritten to mrss-*, footnote markers and their
// notes are tagged, code blocks carry a language, and spacer paragraphs go.
const rich = sanitizeArticleHtml(`
  <p>&nbsp;</p>
  <h1>标题：副标题</h1>
  <p>正文<sup id="fnref1"><a href="#fn1">1</a></sup>，见<a href="#sec">下文</a>。</p>
  <pre class="language-python"><code>x = 1</code></pre>
  <ol><li id="fn1">注释 <a href="#fnref1">↩</a></li></ol>
  <h2 id="sec">下文</h2>`, 'https://example.com/a', { title: '标题：副标题' })
console.log('--- rich ---')
console.log(rich.html)
assert.ok(!/<p>\s*<\/p>/.test(rich.html), 'spacer paragraphs are dropped')
assert.ok(!rich.html.includes('<h1>'), 'leading heading that repeats the title is dropped')
assert.ok(rich.html.includes('data-lang="Python"'), 'code language label is set')
assert.ok(/<a href="#mrss-\d+" data-mrss-fn="1">1<\/a>/.test(rich.html), 'footnote marker points at its rewritten note')
assert.ok(/<li id="mrss-\d+" data-mrss-note="1">/.test(rich.html), 'note carries its index')
assert.ok(/href="#mrss-\d+">下文<\/a>/.test(rich.html), 'in-page links are rewritten')
assert.equal(rich.notes, 1)
assert.equal(rich.toc.length, 1)
assert.ok(rich.html.includes(`id="${rich.toc[0].id}"`), 'heading keeps the id in-page links use')
// A return link is not a marker: it must stay a plain link.
assert.ok(!/<a[^>]*data-mrss-fn="[^"]*">↩/.test(rich.html), 'return links are not markers')
// Fragments that the sanitizer generated stay relative.
assert.ok(rich.html.includes('href="#mrss-'), 'fragments stay relative instead of being absolutised')

// A fetched original page keeps its <figure><img width height>. The attributes
// survive sanitizing on purpose: they give the reader the intrinsic ratio to
// reserve space with. The panel must not let them dictate the used size, which
// is what squashed 9to5Google's 1440x810 hero into 655x810.
const fetched = sanitizeArticleHtml(
  '<figure class="img-border"><img width="1440" height="810" src="https://example.com/hero.jpg" alt=""></figure>',
  'https://example.com/a',
)
console.log('--- fetched figure ---')
console.log(fetched.html)
assert.ok(/<figure>/.test(fetched.html), 'the figure wrapper survives')
assert.ok(/width="1440"/.test(fetched.html) && /height="810"/.test(fetched.html), 'the intrinsic size is kept for the aspect ratio')
assert.ok(!/class="img-border"/.test(fetched.html), 'the source class is still stripped')

// X syndication: pick the highest-bitrate mp4, skip HLS and non-twimg hosts.
const tweet = tweetFromSyndication({
  text: 'short text',
  note_tweet: { note_tweet_results: { result: { text: 'long note text' } } },
  user: { name: 'Nevo', screen_name: 'wickedguro' },
  mediaDetails: [
    { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/a.jpg', ext_alt_text: 'alt' },
    {
      type: 'video',
      media_url_https: 'https://pbs.twimg.com/thumb.jpg',
      video_info: {
        variants: [
          { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/x.m3u8' },
          { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/low.mp4' },
          { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/high.mp4' },
          { content_type: 'video/mp4', bitrate: 999, url: 'https://evil.example/x.mp4' },
        ],
      },
    },
  ],
})
assert.equal(tweet.text, 'long note text')
assert.equal(tweet.videos.length, 1)
assert.equal(tweet.videos[0].src, 'https://video.twimg.com/high.mp4')
assert.equal(tweet.videos[0].poster, 'https://pbs.twimg.com/thumb.jpg')
assert.equal(tweet.images[0].alt, 'alt')
assert.equal(tweetFromSyndication(null), null)
assert.equal(tweetFromSyndication({ mediaDetails: [{ type: 'photo', media_url_https: 'https://evil.example/a.jpg' }] }).images.length, 0)
assert.equal(sanitized.toc[0].text, '标题 一')

const markdown = markdownFromHtml('<h2>标题</h2><p>你好 <a href="https://example.com">链接</a></p><ul><li>一</li><li>二</li></ul>', 'https://example.com')
console.log('--- markdown ---')
console.log(markdown)
assert.ok(markdown.includes('## 标题'))
assert.ok(markdown.includes('[链接](https://example.com/)'))
assert.ok(markdown.includes('- 一'))

assert.equal(estimateMinutes('中'.repeat(760)), 2)
assert.ok(textFromHtml('<p>a</p><p>b</p>').includes('a'))

console.log('digest tests passed')

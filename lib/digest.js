/**
 * Deterministic unread analysis: what is happening, which sources are busy,
 * which terms and titles recur, and which entries deserve a slow read.
 *
 * Everything here is heuristic and explains itself in `reasons`; the model adds
 * judgement on top, it does not get fabricated facts from this module.
 */

import { excerptFromHtml, estimateMinutes, firstImageFromHtml, textFromHtml } from './html.js'

const MAX_ITEMS = 240

const CJK_STOP = new Set([
  '我们', '你们', '他们', '一个', '一些', '这个', '那个', '可以', '没有', '已经', '因为', '所以',
  '但是', '如果', '这是', '就是', '不是', '还是', '这样', '那样', '什么', '怎么', '以及', '对于',
  '关于', '通过', '进行', '需要', '可能', '目前', '现在', '今天', '昨天', '最近', '文章', '作者',
  '内容', '问题', '时候', '东西', '这里', '那里', '其中', '而且', '并且', '虽然', '然后', '这些',
  '那些', '自己', '大家', '很多', '非常', '真的', '其实', '只是', '比较', '一直', '开始', '结束',
  '事情', '方面', '情况', '方式', '方法', '部分', '第一', '第二', '第三', '如何', '为何', '一次',
  '两个', '三个', '不会', '不能', '还有', '为了', '成为', '开始', '之后', '之前', '同时',
])

const LATIN_STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'your', 'about', 'into',
  'more', 'than', 'what', 'when', 'how', 'why', 'are', 'was', 'were', 'has', 'had', 'not', 'you',
  'they', 'their', 'its', 'our', 'can', 'all', 'new', 'one', 'two', 'out', 'get', 'use', 'using',
  'after', 'before', 'over', 'under', 'also', 'just', 'like', 'now', 'today', 'week', 'year',
  'says', 'said', 'who', 'his', 'her', 'but', 'with', 'that', 'these', 'those', 'there', 'here',
  'been', 'being', 'does', 'did', 'doing', 'make', 'made', 'much', 'many', 'some', 'such', 'only',
  'then', 'them', 'very', 'well', 'even', 'still', 'back', 'down', 'up', 'it', 'is', 'of', 'to',
  'in', 'on', 'at', 'by', 'as', 'be', 'or', 'an', 'a', 'do', 'if', 'so', 'we', 'i', 'my', 'me',
])

const OPINION_SIGNAL = /(我认为|我觉得|我们说|观点|评论|反思|复盘|经验|教训|思考|为什么|凭什么|是否|该不该|真相|神话|误区|质疑|回应|访谈|对话|专栏|笔记|手记|opinion|essay|review|why|thoughts|take|lessons|analysis)/i
const NEWS_SIGNAL = /(发布|上线|推出|宣布|融资|收购|裁员|起诉|获批|开源|更新|报告|数据显示|增长|下跌|release|launch|announc|acquire|raise|report|survey|update|ships)/i
const DEPTH_SIGNAL = /(深度|长文|详解|拆解|复盘|访谈|对话|研究|报告|指南|原理|本质|end[- ]to[- ]end|deep dive|explained|guide|inside|how .* works|teardown|retrospective)/i

function splitCjk(text) {
  const out = []
  for (const run of String(text || '').match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) || []) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const bigram = run.slice(i, i + 2)
      if (!CJK_STOP.has(bigram)) out.push(bigram)
      if (i + 2 < run.length) {
        const trigram = run.slice(i, i + 3)
        const left = run.slice(i, i + 2)
        const right = run.slice(i + 1, i + 3)
        if (!CJK_STOP.has(left) && !CJK_STOP.has(right)) out.push(trigram)
      }
    }
  }
  return out
}

function splitLatin(text) {
  return (String(text || '').toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || [])
    .filter((word) => !LATIN_STOP.has(word) && !/^\d+$/.test(word))
}

/** Terms with weights: the title dominates, the excerpt corroborates. */
function docTerms(title, excerpt) {
  const weights = new Map()
  const add = (tokens, weight) => {
    for (const token of tokens) weights.set(token, (weights.get(token) || 0) + weight)
  }
  add(splitCjk(title), 3)
  add(splitLatin(title), 3)
  add(splitCjk(excerpt), 1)
  add(splitLatin(excerpt), 1)
  return weights
}

export function normalizeEntry(raw, { demo = false } = {}) {
  const feed = raw.feed || {}
  const category = feed.category || {}
  const content = String(raw.content || '')
  const text = textFromHtml(content)
  const minutes = Number(raw.reading_time) > 0 ? Number(raw.reading_time) : estimateMinutes(text)
  return {
    id: Number(raw.id),
    title: String(raw.title || '(无标题)').trim(),
    url: String(raw.url || ''),
    author: String(raw.author || ''),
    publishedAt: String(raw.published_at || raw.created_at || new Date().toISOString()),
    readingMinutes: minutes,
    starred: Boolean(raw.starred),
    status: String(raw.status || (demo ? 'unread' : 'unread')),
    feedId: Number(feed.id) || 0,
    feedTitle: String(feed.title || '未知订阅'),
    categoryId: Number(category.id) || 0,
    categoryTitle: String(category.title || '未分类'),
    textLength: text.length,
    bodySample: text.slice(0, 1400),
    excerpt: excerptFromHtml(content, 220),
    cover: firstImageFromHtml(content, String(raw.url || '')),
    demo,
  }
}

function hoursSince(iso, now) {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return 999
  return Math.max(0, (now - time) / 3_600_000)
}

function stanceOf(item) {
  const haystack = `${item.title}\n${item.excerpt}`
  const opinion = OPINION_SIGNAL.test(haystack)
  const news = NEWS_SIGNAL.test(haystack)
  if (opinion && news) return 'mixed'
  if (opinion) return 'opinion'
  if (news) return 'news'
  return 'unknown'
}

function depthSignalOf(item) {
  return DEPTH_SIGNAL.test(item.title) || item.readingMinutes >= 9
}

const ACRONYMS = new Set(['ai', 'rss', 'api', 'llm', 'gpu', 'cpu', 'sdk', 'css', 'sql', 'html', 'url', 'ui', 'ux', 'vpn', 'ceo', 'cto'])

const TERM_NOISE = /[的了是在和与就都也把被让给对从会能要有不很更最着过吗呢吧啊哦嗯这那我你他她它]/

function readableTerm(term) {
  if (/^[a-z]+$/.test(term)) return ACRONYMS.has(term) ? term.toUpperCase() : term[0].toUpperCase() + term.slice(1)
  return term
}

/**
 * Entries whose titles share enough terms that they are plausibly about the
 * same event or argument. Titles only: body overlap would join unrelated
 * articles that happen to discuss the same category.
 */
function findEchoes(items, now) {
  const docs = items.map((item) => {
    const tokens = new Set([...splitCjk(item.title), ...splitLatin(item.title)])
    return { item, tokens }
  })
  const groups = []
  const used = new Set()
  for (let i = 0; i < docs.length; i += 1) {
    if (used.has(i) || docs[i].tokens.size < 2) continue
    const members = [i]
    let shared = new Set(docs[i].tokens)
    for (let j = i + 1; j < docs.length; j += 1) {
      if (used.has(j)) continue
      const overlap = [...docs[j].tokens].filter((term) => shared.has(term))
      if (overlap.length < 2) continue
      const ratio = overlap.length / Math.min(docs[i].tokens.size, docs[j].tokens.size)
      if (ratio < 0.34) continue
      members.push(j)
      shared = new Set(overlap)
    }
    if (members.length < 2) continue
    for (const index of members) used.add(index)
    const groupItems = members.map((index) => docs[index].item)
    const label = [...shared].sort((a, b) => b.length - a.length || b.localeCompare(a))[0] || groupItems[0].title.slice(0, 12)
    groups.push({
      label: readableTerm(label),
      size: groupItems.length,
      feeds: [...new Set(groupItems.map((item) => item.feedTitle))],
      minutes: groupItems.reduce((sum, item) => sum + item.readingMinutes, 0),
      newestAgeHours: Math.round(Math.min(...groupItems.map((item) => hoursSince(item.publishedAt, now)))),
      items: groupItems
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
        .slice(0, 4)
        .map((item) => ({
          id: item.id,
          title: item.title,
          feed: item.feedTitle,
          minutes: item.readingMinutes,
          publishedAt: item.publishedAt,
        })),
    })
  }
  return groups.slice(0, 5)
}

function buildTimeline(items, now, buckets = 8) {
  const spanHours = 48
  const size = spanHours / buckets
  const counts = new Array(buckets).fill(0)
  for (const item of items) {
    const age = hoursSince(item.publishedAt, now)
    if (age > spanHours) continue
    const index = Math.min(buckets - 1, Math.floor((spanHours - age) / size))
    counts[index] += 1
  }
  return counts.map((count, index) => {
    const start = new Date(now - (spanHours - index * size) * 3_600_000)
    const pad = (value) => String(value).padStart(2, '0')
    return {
      label: `${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${pad(start.getHours())}h`,
      count,
    }
  })
}

function interestTerms(titles) {
  const weights = new Map()
  for (const title of titles) {
    for (const term of splitCjk(title)) weights.set(term, (weights.get(term) || 0) + 1)
    for (const term of splitLatin(title)) weights.set(term, (weights.get(term) || 0) + 1)
  }
  return new Set([...weights.entries()].filter(([, count]) => count >= 1).map(([term]) => term))
}

function recommend(items, now, interests) {
  const scores = []
  for (const item of items) {
    let score = 0
    const reasons = []
    const minutes = item.readingMinutes
    if (minutes >= 12) {
      score += 34
      reasons.push(`约 ${minutes} 分钟长文`)
    } else if (minutes >= 7) {
      score += 27
      reasons.push(`约 ${minutes} 分钟，需要完整读`)
    } else if (minutes >= 4) {
      score += 15
    } else {
      score += 4
    }

    if (item.textLength >= 2600) {
      score += 20
      reasons.push('正文完整，不是摘要')
    } else if (item.textLength >= 1100) {
      score += 12
    } else if (item.textLength < 420) {
      score -= 8
      reasons.push('正文偏短，可能只有摘要')
    }

    const age = hoursSince(item.publishedAt, now)
    if (age <= 12) {
      score += 16
      reasons.push('12 小时内更新')
    } else if (age <= 36) {
      score += 9
    } else if (age <= 96) {
      score += 4
    }

    if (DEPTH_SIGNAL.test(item.title)) {
      score += 10
      reasons.push('标题指向深度内容')
    }

    const stance = stanceOf(item)
    if (stance === 'opinion') {
      score += 7
      reasons.push('含观点/评论线索')
    } else if (stance === 'mixed') {
      score += 4
    }

    if (item.starred) {
      score += 16
      reasons.push('你已收藏')
    }

    if (interests.size > 0) {
      const own = new Set([...splitCjk(`${item.title} ${item.excerpt}`), ...splitLatin(`${item.title} ${item.excerpt}`)])
      const overlap = [...own].filter((term) => interests.has(term))
      if (overlap.length >= 2) {
        score += Math.min(14, 6 + overlap.length * 2)
        reasons.push(`与收藏主题相关：${overlap.slice(0, 3).join('、')}`)
      }
    }

    if (item.textLength < 160 && item.readingMinutes <= 2) {
      reasons.push('很短，可稍后扫读')
    }

    scores.push({
      id: item.id,
      title: item.title,
      feed: item.feedTitle,
      category: item.categoryTitle,
      url: item.url,
      minutes,
      publishedAt: item.publishedAt,
      stance,
      score: Math.max(0, Math.min(100, Math.round(score))),
      reasons: reasons.slice(0, 4),
    })
  }
  return scores.sort((a, b) => b.score - a.score || Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
}

/**
 * @param {Array<object>} rawEntries Miniflux entry objects (or demo entries).
 * @param {{ now?: number, demo?: boolean, source?: string, interests?: string[], starred?: string[] }} options
 */
export function buildDigest(rawEntries, options = {}) {
  const now = options.now ?? Date.now()
  const demo = Boolean(options.demo)
  const items = (Array.isArray(rawEntries) ? rawEntries : [])
    .map((entry) => (entry && typeof entry.textLength === 'number' && typeof entry.feedTitle === 'string'
      ? entry
      : normalizeEntry(entry, { demo })))
    .slice(0, MAX_ITEMS)

  const interests = interestTerms([...(options.interests || []), ...(options.starred || [])])
  const times = items.map((item) => Date.parse(item.publishedAt)).filter(Number.isFinite)
  const newest = times.length ? Math.max(...times) : now
  const oldest = times.length ? Math.min(...times) : now

  const byCategory = new Map()
  const byFeed = new Map()
  for (const item of items) {
    const category = byCategory.get(item.categoryTitle) || { title: item.categoryTitle, unread: 0, minutes: 0, entries: [] }
    category.unread += 1
    category.minutes += item.readingMinutes
    category.entries.push(item)
    byCategory.set(item.categoryTitle, category)

    const feedKey = `${item.feedId}:${item.feedTitle}`
    const feed = byFeed.get(feedKey) || { id: item.feedId, title: item.feedTitle, category: item.categoryTitle, unread: 0, minutes: 0, newest: item.publishedAt }
    feed.unread += 1
    feed.minutes += item.readingMinutes
    if (Date.parse(item.publishedAt) > Date.parse(feed.newest)) feed.newest = item.publishedAt
    byFeed.set(feedKey, feed)
  }

  const recommendations = recommend(items, now, interests)
  const stance = { opinion: 0, news: 0, mixed: 0, unknown: 0 }
  for (const item of items) stance[stanceOf(item)] += 1

  const categories = [...byCategory.values()]
    .sort((a, b) => b.unread - a.unread)
    .map((category) => ({
      title: category.title,
      unread: category.unread,
      minutes: category.minutes,
      topTitles: category.entries
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
        .slice(0, 3)
        .map((item) => item.title),
    }))

  const feeds = [...byFeed.values()]
    .sort((a, b) => b.unread - a.unread)
    .slice(0, 14)
    .map((feed) => ({ ...feed }))

  const quickScan = recommendations
    .filter((item) => item.minutes <= 2)
    .slice(0, 5)
    .map((item) => ({ ...item, reasons: ['碎片时间即可读完'] }))

  return {
    generatedAt: new Date(now).toISOString(),
    demo,
    source: options.source || (demo ? 'demo' : 'miniflux'),
    window: {
      hours: Math.max(1, Math.round((now - oldest) / 3_600_000)),
      newest: new Date(newest).toISOString(),
      oldest: new Date(oldest).toISOString(),
    },
    counts: {
      unread: items.length,
      total: options.total ?? items.length,
      categories: byCategory.size,
      feeds: byFeed.size,
      minutes: items.reduce((sum, item) => sum + item.readingMinutes, 0),
      longReads: items.filter((item) => item.readingMinutes >= 8).length,
    },
    categories,
    feeds,
    timeline: buildTimeline(items, now),
    echoes: findEchoes(items, now),
    recommendations: recommendations.slice(0, 8),
    quickScan,
    stance,
    topFeed: feeds[0]?.title || '',
    topCategory: categories[0]?.title || '',
  }
}

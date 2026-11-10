/**
 * End-to-end check of the reader API against a fake Miniflux instance.
 *
 * Usage: node tests/live-api.mjs [harnessBaseUrl]
 * It points the installed plugin at a local fake Miniflux through
 * POST /settings, exercises bootstrap/digest/entries/entry/action, then
 * removes the temporary credential so the panel is left unconfigured.
 */

import http from 'node:http'
import assert from 'node:assert/strict'

const HARNESS = process.argv[2] || 'http://127.0.0.1:57791'
const API = `${HARNESS}/rss-miniflux/api`
const TOKEN = 'test-token-123'
const PORT = 18765

const now = Date.now()
const iso = (hoursAgo) => new Date(now - hoursAgo * 3_600_000).toISOString()

const feeds = [
  { id: 42, title: 'Fake Tech', category: { id: 7, title: 'Tech' } },
  { id: 43, title: 'Fake Product', category: { id: 8, title: 'Product' } },
]
const entries = [
  {
    id: 101,
    title: '上下文预算怎么砍：一次工程复盘',
    url: 'https://fake.example/a',
    author: 'Alice',
    content: '<p>我们把默认上下文预算砍了一半。</p><script>alert(1)</script><h2>方法</h2><p>先检索再拼装。</p><img src="https://fake.example/x.png" onerror="steal()">',
    published_at: iso(2),
    reading_time: 7,
    status: 'unread',
    starred: false,
    feed: feeds[0],
  },
  {
    id: 102,
    title: '模型的上下文预算为什么值得砍',
    url: 'https://fake.example/b',
    author: 'Bob',
    content: '<p>上下文越长不一定越准。</p>',
    published_at: iso(5),
    reading_time: 4,
    status: 'unread',
    starred: true,
    feed: feeds[1],
  },
  {
    id: 103,
    title: 'Short note',
    url: 'https://fake.example/c',
    author: '',
    content: '<p>tiny</p>',
    published_at: iso(30),
    reading_time: 1,
    status: 'unread',
    starred: false,
    feed: feeds[1],
  },
]

const calls = []

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  calls.push(`${req.method} ${url.pathname}${url.search}`)
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.headers['x-auth-token'] !== TOKEN) return json(401, { error_message: 'bad token' })

  if (url.pathname === '/v1/me') return json(200, { id: 1, username: 'tester' })
  if (url.pathname === '/v1/version') return json(200, { version: '2.2.15' })
  if (url.pathname === '/v1/categories') {
    return json(200, [
      { id: 7, title: 'Tech', total_unread: 1, feed_count: 1 },
      { id: 8, title: 'Product', total_unread: 2, feed_count: 1 },
    ])
  }
  if (url.pathname === '/v1/discover' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const target = JSON.parse(body || '{}').url || ''
      json(200, [{ url: `${String(target).replace(/\/$/, '')}/feed.xml`, title: 'Discovered Feed', type: 'rss' }])
    })
    return undefined
  }
  if (url.pathname === '/v1/feeds') return json(200, feeds)
  if (url.pathname === '/v1/feeds/counters') return json(200, { reads: {}, unreads: { 42: 1, 43: 2 } })
  if (url.pathname === '/v1/feeds/refresh') { res.writeHead(204); return res.end() }

  if (url.pathname === '/v1/entries' && req.method === 'GET') {
    const status = url.searchParams.getAll('status')
    const starred = url.searchParams.get('starred')
    const search = (url.searchParams.get('search') || '').toLowerCase()
    let list = entries.filter((entry) => (status.length === 0 ? true : status.includes(entry.status)))
    if (starred === 'true') list = list.filter((entry) => entry.starred)
    if (search) list = list.filter((entry) => `${entry.title} ${entry.content}`.toLowerCase().includes(search))
    const limit = Number(url.searchParams.get('limit') || 100)
    const offset = Number(url.searchParams.get('offset') || 0)
    return json(200, { total: list.length, entries: list.slice(offset, offset + limit) })
  }

  if (url.pathname === '/v1/entries' && req.method === 'PUT') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const payload = JSON.parse(body || '{}')
      for (const id of payload.entry_ids || []) {
        const entry = entries.find((candidate) => candidate.id === id)
        if (!entry) continue
        if (payload.status) entry.status = payload.status
        if (typeof payload.starred === 'boolean') entry.starred = payload.starred
      }
      res.writeHead(204)
      res.end()
    })
    return undefined
  }

  const single = /^\/v1\/entries\/(\d+)$/.exec(url.pathname)
  if (single && req.method === 'GET') {
    const entry = entries.find((candidate) => candidate.id === Number(single[1]))
    return entry ? json(200, entry) : json(404, { error_message: 'not found' })
  }
  const content = /^\/v1\/entries\/(\d+)\/fetch-content$/.exec(url.pathname)
  if (content) {
    const entry = entries.find((candidate) => candidate.id === Number(content[1]))
    return json(200, { id: entry?.id, content: '<p>Fetched original body.</p><h2>More</h2><p>extra</p>' })
  }
  const bookmark = /^\/v1\/entries\/(\d+)\/bookmark$/.exec(url.pathname)
  if (bookmark && req.method === 'PUT') {
    const entry = entries.find((candidate) => candidate.id === Number(bookmark[1]))
    if (entry) entry.starred = !entry.starred
    res.writeHead(204)
    return res.end()
  }
  return json(404, { error_message: `unhandled ${url.pathname}` })
})

async function api(path, options) {
  const response = await fetch(`${API}${path}`, {
    method: options?.method || 'GET',
    headers: options?.body ? { 'content-type': 'application/json' } : {},
    body: options?.body ? JSON.stringify(options.body) : undefined,
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))
console.log(`fake Miniflux on :${PORT}`)

try {
  const before = await api('/bootstrap')
  console.log('bootstrap before:', before.body.status.configured ? 'configured' : 'unconfigured')

  const saved = await api('/settings', { method: 'POST', body: { baseUrl: `http://127.0.0.1:${PORT}`, apiToken: TOKEN } })
  console.log('save settings:', JSON.stringify(saved.body))
  assert.equal(saved.body.ok, true)
  assert.equal(saved.body.check.ok, true, 'connection check should pass')

  const bootstrap = await api('/bootstrap')
  console.log('bootstrap configured:', bootstrap.body.status.configured, 'feeds:', bootstrap.body.feeds.length)
  assert.equal(bootstrap.body.status.configured, true)
  assert.equal(bootstrap.body.status.user, 'tester')
  assert.equal(bootstrap.body.feeds.length, 2)
  assert.equal(bootstrap.body.feeds.find((feed) => feed.id === 43).unread, 2)

  const discovered = await api(`/discover?url=${encodeURIComponent('https://example.org')}`)
  console.log('discover:', JSON.stringify(discovered.body))
  assert.equal(discovered.body.feeds.length, 1)
  assert.equal(discovered.body.feeds[0].type, 'rss')
  assert.equal(discovered.body.feeds[0].url, 'https://example.org/feed.xml')
  const badDiscover = await api('/discover?url=example.org')
  assert.equal(badDiscover.status, 400, 'discovery rejects a URL without a scheme')

  const feedStats = await api('/feed-stats')
  assert.equal(feedStats.body.starred['43'], 1, 'starred counts group by feed')
  assert.equal(feedStats.body.capped, false)

  const digest = await api('/digest?force=1')
  console.log('digest counts:', JSON.stringify(digest.body.counts))
  console.log('digest top:', digest.body.recommendations.slice(0, 2).map((item) => `${item.id}:${item.score}`).join(' '))
  console.log('digest echoes:', digest.body.echoes.length)
  assert.equal(digest.body.demo, false)
  assert.equal(digest.body.counts.unread, 3)
  assert.ok(digest.body.recommendations[0].id === 101, 'the 7-minute full text ranks first')

  const list = await api('/entries?filter=unread&limit=10')
  assert.equal(list.body.entries.length, 3)
  const all = await api('/entries?filter=all&limit=10')
  assert.equal(all.body.entries.length, 3, 'status=unread+read returns everything')
  console.log('entries all:', all.body.total)

  const article = await api('/entry?id=101')
  assert.ok(article.body.html.includes('<h2 id="sec-1">'), 'heading ids exist')
  assert.ok(!/script|onerror/i.test(article.body.html), 'sanitizer removed script and handlers')
  assert.equal(article.body.toc.length, 1)
  assert.ok(article.body.markdown.includes('## 方法'))
  console.log('article toc:', JSON.stringify(article.body.toc))

  const marked = await api('/action', { method: 'POST', body: { action: 'mark_read', id: 101 } })
  assert.equal(marked.body.ok, true)
  assert.equal(entries.find((entry) => entry.id === 101).status, 'read', 'fake server saw the write')

  const starred = await api('/action', { method: 'POST', body: { action: 'star', id: 103 } })
  assert.equal(starred.body.ok, true)
  assert.equal(entries.find((entry) => entry.id === 103).starred, true)

  const second = await api('/entry?id=102&fetch=1')
  assert.ok(second.body.html.includes('Fetched original body'), 'fetch-content replaced the body')
  assert.equal(second.body.item.title, '模型的上下文预算为什么值得砍', 'title came from the entry, not the fetch payload')
  console.log('fetch original:', second.body.textLength, 'chars')

  const removed = await api('/settings', { method: 'DELETE' })
  assert.equal(removed.body.ok, true)
  const after = await api('/bootstrap')
  assert.equal(after.body.status.configured, false, 'credential removed again')
  console.log('cleanup ok; calls:', calls.length)
  console.log('LIVE_API_OK')
} finally {
  server.close()
}

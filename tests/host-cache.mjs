/**
 * Host-half cache behaviour, end to end and in process.
 *
 * Mounts the plugin with a stub Harness context, points it at a slow fake
 * Miniflux and counts the upstream requests. It pins the three things that make
 * the panel feel fast:
 *
 *   1. a warm bootstrap answers without touching Miniflux
 *   2. marking one entry read expires counters/entries but NOT the catalog
 *   3. the same entries page is not re-fetched within its short TTL
 *
 *   node tests/host-cache.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { apply } from '../index.js'

const TOKEN = 'host-cache-token'
const LATENCY = 60

const upstream = []
const now = Date.now()
const iso = (hoursAgo) => new Date(now - hoursAgo * 3_600_000).toISOString()

const feeds = [
  { id: 42, title: 'Fake Tech', category: { id: 7, title: 'Tech' } },
  { id: 43, title: 'Fake Product', category: { id: 8, title: 'Product' } },
]
const entries = [
  {
    id: 101,
    title: 'One',
    url: 'https://fake.example/a',
    content: '<p>one</p>',
    published_at: iso(1),
    status: 'unread',
    starred: false,
    feed: feeds[0],
  },
  {
    id: 102,
    title: 'Two',
    url: 'https://fake.example/b',
    content: '<p>two</p>',
    published_at: iso(2),
    status: 'unread',
    starred: false,
    feed: feeds[1],
  },
]

const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const reply = (status, body) => {
    setTimeout(() => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }, LATENCY)
  }
  if (req.headers['x-auth-token'] !== TOKEN) return reply(401, { error_message: 'bad token' })
  const key = `${req.method} ${url.pathname}`
  upstream.push(key)
  if (url.pathname === '/v1/me') return reply(200, { id: 1, username: 'tester' })
  if (url.pathname === '/v1/categories') {
    return reply(200, [{ id: 7, title: 'Tech', total_unread: 1, feed_count: 1 }, { id: 8, title: 'Product', total_unread: 1, feed_count: 1 }])
  }
  if (url.pathname === '/v1/feeds/refresh') return reply(204, {})
  if (url.pathname === '/v1/feeds') return reply(200, feeds)
  if (/^\/v1\/feeds\/\d+\/icon$/.test(url.pathname)) {
    // Miniflux hands icons back as a base64 data URL.
    const id = Number(url.pathname.split('/')[3])
    if (id === 43) return reply(404, { error_message: 'no icon' })
    return reply(200, { mime_type: 'image/png', data: `data:image/png;base64,${Buffer.from('icon-' + id).toString('base64')}` })
  }
  if (url.pathname === '/v1/feeds/counters') {
    return reply(200, { reads: { 42: 0, 43: 0 }, unreads: { 42: 1, 43: 1 }, total: 2 })
  }
  if (url.pathname === '/v1/entries') {
    return reply(200, { total: entries.length, entries })
  }
  if (/^\/v1\/entries\/\d+\/status$/.test(url.pathname)) return reply(204, {})
  if (/^\/v1\/entries\/\d+\/bookmark$/.test(url.pathname)) return reply(204, {})
  if (url.pathname === '/v1/entries/stats') return reply(200, {})
  return reply(404, { error_message: `no fake for ${url.pathname}` })
})

function fakeNodeRequest(method, body) {
  const payload = Buffer.from(JSON.stringify(body || {}))
  return {
    method,
    async *[Symbol.asyncIterator]() {
      yield payload
    },
  }
}

function fakeNodeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(payload) {
      this.writableEnded = true
      this.body = String(payload || '')
    },
    on() {},
  }
}

async function main() {
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${fake.address().port}`

  const resourceRoutes = []
  const exactRoutes = new Map()
  const webServer = {
    register: (route) => {
      if (route.kind === 'prefix') resourceRoutes.push(route)
      else exactRoutes.set(route.path, route)
      return () => {}
    },
  }
  const tools = { register: () => {} }
  const ctx = {
    webServer,
    tools,
    get: (name) => {
      if (name === 'webServer') return webServer
      if (name === 'tools') return tools
      return undefined
    },
    effect: (factory) => {
      factory()
      return () => {}
    },
    inject: () => {},
    logger: { warn: () => {}, debug: () => {} },
  }
  apply(ctx, { baseUrl, apiToken: TOKEN, timeoutMs: 5_000 })

  assert.equal(resourceRoutes.length, 1, 'the reader resource route must be registered')
  const reader = resourceRoutes[0].resource
  const action = exactRoutes.get('/rss-miniflux/api/action')
  assert.ok(action, 'the write action route must be registered')

  const get = async (path) => {
    const started = Date.now()
    const response = await reader(new Request(`http://127.0.0.1${path}`), { principal: { kind: 'owner' } })
    const body = await response.json()
    return { status: response.status, headers: response.headers, body, ms: Date.now() - started }
  }

  const post = async (path, payload) => {
    const res = fakeNodeResponse()
    await action.handler(fakeNodeRequest('POST', payload), res)
    return { status: res.status, body: JSON.parse(res.body || '{}') }
  }

  // 1. Cold bootstrap: four upstream calls, then a warm answer with none.
  const cold = await get('/rss-miniflux/api/bootstrap')
  assert.equal(cold.status, 200)
  assert.equal(cold.body.status.configured, true)
  assert.equal(cold.body.feeds.length, 2)
  const coldCalls = upstream.length
  assert.equal(coldCalls, 4, `cold bootstrap should call Miniflux 4 times, saw ${upstream.join(', ')}`)
  assert.match(String(cold.headers.get('server-timing')), /bootstrap;dur=\d+/, 'server-timing should report the duration')

  const warm = await get('/rss-miniflux/api/bootstrap')
  assert.equal(warm.status, 200)
  assert.equal(upstream.length, coldCalls, 'warm bootstrap must not touch Miniflux')
  assert.equal(warm.body.feeds.length, 2)

  // 2. One entries page, asked twice inside its TTL, costs one upstream call.
  const beforeEntries = upstream.length
  const page1 = await get('/rss-miniflux/api/entries?filter=unread&limit=60&offset=0')
  const page2 = await get('/rss-miniflux/api/entries?filter=unread&limit=60&offset=0')
  assert.equal(page1.status, 200)
  assert.equal(page1.body.entries.length, 2)
  assert.equal(page2.body.entries.length, 2)
  assert.equal(upstream.length, beforeEntries + 1, 'a repeated entries page should be served from memory')

  // 3. Marking one entry read keeps the catalog: only counters (and the entry
  //    page) may be refetched, not feeds/categories/me.
  const marked = await post('/rss-miniflux/api/action', { action: 'mark_read', id: 101 })
  assert.equal(marked.status, 200)
  assert.equal(marked.body.ok, true)

  const beforeAfterMark = upstream.length
  const afterMark = await get('/rss-miniflux/api/bootstrap')
  assert.equal(afterMark.status, 200)
  const afterMarkCalls = upstream.slice(beforeAfterMark)
  assert.ok(
    afterMarkCalls.every((call) => !/\/v1\/(feeds|categories|me)$/.test(call)),
    `a read action must not refetch the catalog, saw ${afterMarkCalls.join(', ')}`,
  )
  assert.ok(afterMarkCalls.length <= 1, `a read action should refetch counters only, saw ${afterMarkCalls.join(', ')}`)

  // The entry page was expired by the action, so it is fetched again and shows
  // the read state the action wrote.
  const beforePage = upstream.length
  await get('/rss-miniflux/api/entries?filter=unread&limit=60&offset=0')
  assert.equal(upstream.length, beforePage + 1, 'a write action must expire the entries page')

  // 4. Icons arrive in one batch, are cached, and never ask again.
  const beforeIcons = upstream.length
  const batch1 = await get('/rss-miniflux/api/icons?ids=42,43')
  assert.equal(batch1.status, 200)
  assert.match(batch1.body.icons['42'], /^data:image\/png;base64,/, 'the batch must inline the icon')
  assert.equal(batch1.body.icons['43'], undefined, 'a feed without an icon must be omitted, not faked')
  assert.equal(upstream.length, beforeIcons + 2, 'one upstream lookup per feed')

  const batch2 = await get('/rss-miniflux/api/icons?ids=42,43')
  assert.equal(batch2.body.icons['42'], batch1.body.icons['42'])
  assert.equal(upstream.length, beforeIcons + 2, 'a warm icon must not hit Miniflux again')

  // The single-icon route shares the same store, so <img> fallbacks are warm too.
  const single = await reader(new Request('http://127.0.0.1/rss-miniflux/api/icon?id=42'), { principal: { kind: 'owner' } })
  assert.equal(single.status, 200)
  assert.equal(single.headers.get('content-type'), 'image/png')
  assert.equal(Buffer.from(await single.arrayBuffer()).toString(), 'icon-42')
  assert.equal(upstream.length, beforeIcons + 2, 'the single-icon route must reuse the cache')
  const missing = await reader(new Request('http://127.0.0.1/rss-miniflux/api/icon?id=43'), { principal: { kind: 'owner' } })
  assert.equal(missing.status, 204, 'a feed without an icon answers 204')

  // 5. A full refresh is allowed to drop everything.
  await post('/rss-miniflux/api/action', { action: 'refresh' })
  const beforeRefresh = upstream.length
  await get('/rss-miniflux/api/bootstrap')
  assert.ok(upstream.length - beforeRefresh >= 3, 'refresh must invalidate the catalog cache')

  fake.close()
  console.log('host cache tests passed')
}

main().catch((error) => {
  console.error(error)
  fake.close()
  process.exit(1)
})

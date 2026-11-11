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
const ENDPOINT = '/rss-miniflux/api'
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

const failures = new Set()

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
  if (failures.has(url.pathname)) return reply(500, { error_message: 'upstream exploded' })
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
  if (/^\/v1\/entries\/\d+\/status$/.test(url.pathname)) {
    // Track the write so a refetch would visibly disagree with a patched page.
    const id = Number(url.pathname.split('/')[3])
    const entry = entries.find((candidate) => candidate.id === id)
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try {
        const body = JSON.parse(raw || '{}')
        if (entry && body.status) entry.status = body.status
      } catch {
        // a malformed body simply leaves state alone
      }
    })
    return reply(204, {})
  }
  if (/^\/v1\/entries\/\d+\/bookmark$/.test(url.pathname)) {
    const id = Number(url.pathname.split('/')[3])
    const entry = entries.find((candidate) => candidate.id === id)
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try {
        const body = JSON.parse(raw || '{}')
        if (entry && typeof body.bookmark_id !== 'undefined') entry.starred = Boolean(body.bookmark_id)
      } catch {
        // ignore
      }
    })
    return reply(204, {})
  }
  if (url.pathname === '/v1/entries/stats') return reply(200, {})
  if (/^\/v1\/(feeds|users)\/\d+\/mark-all-as-read$/.test(url.pathname)) return reply(204, {})
  if (/^\/v1\/entries\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split('/')[3])
    const entry = entries.find((candidate) => candidate.id === id)
    if (!entry) return reply(404, { error_message: 'no such entry' })
    return reply(200, entry)
  }
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
  const disposers = []
  const ctx = {
    webServer,
    tools,
    get: (name) => {
      if (name === 'webServer') return webServer
      if (name === 'tools') return tools
      return undefined
    },
    effect: (factory) => {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    inject: () => {},
    logger: { warn: () => {}, debug: () => {} },
  }
  apply(ctx, { baseUrl, apiToken: TOKEN, timeoutMs: 5_000 })

  assert.equal(resourceRoutes.length, 2, 'the reader API and the player page must both be registered')
  const apiRoute = resourceRoutes.find((route) => route.path === ENDPOINT)
  const playerRoute = resourceRoutes.find((route) => route.path === '/rss-miniflux/player')
  assert.ok(apiRoute, 'the reader API route must be registered')
  assert.ok(playerRoute, 'the player page route must be registered')
  const reader = apiRoute.resource
  const action = exactRoutes.get('/rss-miniflux/api/action')
  assert.ok(action, 'the write action route must be registered')
  const manage = exactRoutes.get('/rss-miniflux/api/manage')
  assert.ok(manage, 'the management route must be registered')

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

  // 0. Nothing cached yet and the upstream is down: the Host must say so
  //    (502) instead of answering 200 with an empty catalog, which is what
  //    emptied the sidebar in the field.
  for (const path of ['/v1/feeds', '/v1/categories', '/v1/feeds/counters', '/v1/me']) failures.add(path)
  const broken = await get('/rss-miniflux/api/bootstrap')
  assert.equal(broken.status, 502, 'a cold bootstrap with a broken upstream must not be a 200')
  assert.equal(broken.body.feeds, undefined, 'the error answer carries no feed list')
  assert.equal(broken.body.error?.code, 'upstream_unavailable', 'the client can tell this apart from a real empty account')
  assert.match(String(broken.body.error?.message || ''), /upstream exploded|Miniflux/, 'the error is explained')
  failures.clear()
  // The failed attempt is not what the rest of the file is counting.
  upstream.length = 0

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

  // The page itself was patched, not dropped: the row that became read is gone
  // from the unread page, the total follows, and no upstream call was needed.
  const beforePage = upstream.length
  const patchedPage = await get('/rss-miniflux/api/entries?filter=unread&limit=60&offset=0')
  assert.equal(upstream.length, beforePage, 'a write action must patch the entries page instead of refetching it')
  assert.deepEqual(patchedPage.body.entries.map((entry) => entry.id), [102], 'the read row leaves an unread page')
  assert.equal(patchedPage.body.total, 1, 'the patched page counts one fewer unread')

  // A page that is not unread-filtered keeps the row: marking it read changes
  // its state, it does not remove it from "All".
  const allBefore = await get('/rss-miniflux/api/entries?filter=all&limit=60&offset=0')
  assert.deepEqual(allBefore.body.entries.map((entry) => entry.id), [101, 102])
  await post('/rss-miniflux/api/action', { action: 'mark_read', id: 102 })
  const beforeAll = upstream.length
  const allAfter = await get('/rss-miniflux/api/entries?filter=all&limit=60&offset=0')
  assert.equal(upstream.length, beforeAll, 'an all-page is patched, not refetched')
  assert.deepEqual(allAfter.body.entries.map((entry) => entry.id), [101, 102], 'an all-page keeps the row')
  assert.equal(allAfter.body.entries.find((entry) => entry.id === 102).status, 'read', 'the row shows the new state')

  // 4. One article, asked twice, costs one upstream call. Parsing and shaping
  //    are not the cost; the Miniflux round trip is.
  const beforeArticle = upstream.length
  const article1 = await get('/rss-miniflux/api/entry?id=101')
  assert.equal(article1.status, 200)
  assert.equal(article1.body.item.title, 'One')
  const article2 = await get('/rss-miniflux/api/entry?id=101')
  assert.equal(article2.status, 200)
  assert.equal(upstream.length, beforeArticle + 1, 'a repeated article must be served from memory')
  assert.match(String(article2.headers.get('server-timing')), /entry;dur=\d+/, 'article timing must be reported')

  // A write patches the cached article header in place as well.
  const starred = await post('/rss-miniflux/api/action', { action: 'star', id: 101 })
  assert.equal(starred.body.ok, true)
  const afterStar = await get('/rss-miniflux/api/entry?id=101')
  assert.equal(afterStar.body.item.starred, true, 'the star action patched the cached article')
  assert.equal(upstream.length, beforeArticle + 2, 'patching must not refetch the article')

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

  // 4b. The player page: ours, with the referrer policy YouTube needs — this is
  //     what makes an embed survive a `no-referrer` shell (error 153).
  const playerPage = await playerRoute.resource(
    new Request('http://127.0.0.1/rss-miniflux/player?id=aqz-KE-bpKQ'),
    { principal: { kind: 'owner' } },
  )
  assert.equal(playerPage.status, 200)
  assert.equal(playerPage.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', 'the player document must send an origin')
  const playerHtml = await playerPage.text()
  assert.match(playerHtml, /<meta name="referrer" content="strict-origin-when-cross-origin">/, 'the meta tag backs up the header')
  assert.match(playerHtml, /youtube-nocookie\.com\/embed\/aqz-KE-bpKQ/, 'the page embeds the requested video')
  assert.match(playerHtml, /allowfullscreen/, 'fullscreen must survive')
  assert.match(playerHtml, /rss-miniflux-player/, 'the page reports back whether it can send a Referer')
  assert.match(String(playerPage.headers.get('content-security-policy')), /connect-src 'self'/, 'the page must be allowed to probe itself')
  const badPlayer = await playerRoute.resource(
    new Request('http://127.0.0.1/rss-miniflux/player?id=..%2F..%2Fetc%2Fpasswd'),
    { principal: { kind: 'owner' } },
  )
  assert.equal(badPlayer.status, 400, 'a video id that is not an id must be refused')

  // 4c. The player origin. The desktop window runs on dsh-app://, which cannot
  //     produce a Referer; the loopback http origin can, and that is the whole
  //     point of serving the player from it.
  const originRes = await get('/rss-miniflux/api/player-origin')
  assert.equal(originRes.status, 200)
  const playerOrigin = String(originRes.body.origin || '')
  assert.match(playerOrigin, /^http:\/\/127\.0\.0\.1:\d+$/, `expected a loopback http origin, saw ${playerOrigin}`)

  const hostedPage = await fetch(`${playerOrigin}/player?id=aqz-KE-bpKQ`)
  assert.equal(hostedPage.status, 200, 'the loopback player page must load')
  assert.equal(hostedPage.headers.get('referrer-policy'), 'strict-origin-when-cross-origin')
  const hostedHtml = await hostedPage.text()
  assert.match(hostedHtml, /youtube-nocookie\.com\/embed\/aqz-KE-bpKQ/, 'it embeds the requested video')
  assert.match(hostedHtml, /fetch\('\/referer'/, 'its probe talks to the loopback origin, not to the app scheme')

  const echoed = await new Promise((resolve, reject) => {
    http.get(`${playerOrigin}/referer`, { headers: { Referer: 'http://127.0.0.1:9/player?id=x' } }, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body }))
    }).on('error', reject)
  })
  assert.equal(echoed.status, 200)
  assert.equal(JSON.parse(echoed.body).referer, 'http://127.0.0.1:9/player?id=x', 'the echo reports the Referer it received')

  const badId = await fetch(`${playerOrigin}/player?id=..%2F%2Fetc`)
  assert.equal(badId.status, 400, 'a non-id is refused on the loopback origin too')

  // 5. A write patches the counters it changed, so the next bootstrap does not
  //    have to refetch them (that refetch is what used to fail and blank the
  //    sidebar).
  const warmAgain = await get('/rss-miniflux/api/bootstrap')
  assert.equal(warmAgain.status, 200)
  const countersBefore = Number(warmAgain.body.counters.unreads['43'])
  const beforeCounterWrite = upstream.length
  await post('/rss-miniflux/api/action', { action: 'mark_read', id: 102, feedId: 43 })
  const afterCounterWrite = await get('/rss-miniflux/api/bootstrap')
  assert.equal(upstream.length, beforeCounterWrite + 1, 'only the write itself goes upstream, not the counters')
  assert.equal(
    Number(afterCounterWrite.body.counters.unreads['43']),
    Math.max(0, countersBefore - 1),
    'the patched counters follow the write',
  )

  // 5c. Mark all as read only moves counts: the catalog has to survive, or the
  //     panel waits for four upstream calls after a write that already landed.
  await get('/rss-miniflux/api/bootstrap')
  const beforeBulk = upstream.length
  const bulkRes = fakeNodeResponse()
  await manage.handler(fakeNodeRequest('POST', { action: 'mark_all_read', scope: 'all' }), bulkRes)
  assert.equal(bulkRes.status, 200, 'mark_all_read should succeed')
  const afterBulk = await get('/rss-miniflux/api/bootstrap')
  const bulkCalls = upstream.slice(beforeBulk)
  assert.ok(
    bulkCalls.every((call) => !/\/v1\/(feeds|categories|me)$/.test(call)),
    `a bulk read must not refetch the catalog, saw ${bulkCalls.join(', ')}`,
  )
  assert.equal(afterBulk.body.feeds.length, 2, 'the subscriptions are still there')

  // 6. Degraded bootstrap: one upstream call failing must not empty the panel.
  //    This is the reported symptom — mark something read, then the whole
  //    subscription list came back empty.
  failures.add('/v1/feeds')
  await post('/rss-miniflux/api/action', { action: 'refresh' }) // invalidate, like any write
  const degraded = await get('/rss-miniflux/api/bootstrap')
  assert.equal(degraded.status, 200, 'a partly available catalog is still an answer')
  assert.equal(degraded.body.feeds.length, 2, 'the feeds we already knew survive a failing endpoint')
  assert.equal(degraded.body.categories.length, 2, 'so do the categories')
  assert.match(String(degraded.body.status.error || ''), /exploded|Miniflux/, 'the answer says it is degraded')
  assert.equal(degraded.body.status.stale, true, 'the panel can tell it is a stale catalog')
  failures.delete('/v1/feeds')

  // 7. Missing counters are a soft failure: keep the numbers, do not report an
  //    error the panel cannot act on.
  await get('/rss-miniflux/api/bootstrap') // restore a full catalog
  failures.add('/v1/feeds/counters')
  await post('/rss-miniflux/api/action', { action: 'refresh' })
  const noCounters = await get('/rss-miniflux/api/bootstrap')
  assert.equal(noCounters.status, 200)
  assert.equal(noCounters.body.feeds.length, 2, 'feeds survive a counters failure')
  const unreadAfter = noCounters.body.feeds.reduce((sum, feed) => sum + feed.unread, 0)
  assert.ok(unreadAfter > 0, `counters must fall back to the last known numbers, saw ${unreadAfter} unread`)
  assert.equal(noCounters.body.status.error, undefined, 'a counters hiccup is not an error the panel shows')
  assert.equal(noCounters.body.status.countersUnknown, false, 'the fallback means the counts are still known')
  failures.delete('/v1/feeds/counters')

  // 8. A full refresh is allowed to drop everything.
  await post('/rss-miniflux/api/action', { action: 'refresh' })
  const beforeRefresh = upstream.length
  await get('/rss-miniflux/api/bootstrap')
  assert.ok(upstream.length - beforeRefresh >= 3, 'refresh must invalidate the catalog cache')

  for (const dispose of disposers.reverse()) {
    try { dispose() } catch { /* best effort */ }
  }
  fake.close()
  console.log('host cache tests passed')
}

main().catch((error) => {
  console.error(error)
  fake.close()
  process.exit(1)
})

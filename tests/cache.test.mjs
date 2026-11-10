/**
 * Unit tests for the Host TTL cache: stale-while-revalidate semantics and the
 * targeted `expire` that keeps a read action from clearing the whole catalog.
 *
 *   node tests/cache.test.mjs
 */
import assert from 'node:assert/strict'
import { createCache } from '../lib/cache.js'

let clock = 0
const now = () => clock
const makeCache = () => createCache({ now })

const settle = () => new Promise((resolve) => setImmediate(resolve))

async function freshHitDoesNotRefetch() {
  const cache = makeCache()
  let calls = 0
  const value = () => { calls += 1; return calls }
  assert.equal(await cache.run('k', 1_000, value), 1)
  clock += 500
  assert.equal(await cache.run('k', 1_000, value), 1, 'fresh value must be reused')
  assert.equal(calls, 1)
}

async function expiredValueWaitsForFetch() {
  const cache = makeCache()
  let calls = 0
  const value = () => { calls += 1; return calls }
  await cache.run('k', 1_000, value)
  clock += 1_500
  assert.equal(await cache.run('k', 1_000, value), 2, 'expired value must be refetched')
  assert.equal(calls, 2)
}

async function staleValueIsServedWhileRefreshing() {
  const cache = makeCache()
  let calls = 0
  let release = null
  const slow = () => {
    calls += 1
    if (calls === 1) return Promise.resolve('first')
    return new Promise((resolve) => { release = () => resolve('second') })
  }
  assert.deepEqual(await cache.runSWR('catalog', 1_000, 10_000, slow), 'first')
  clock += 5_000 // past ttl, inside staleTtl

  // Answers immediately with the old value and starts one refresh.
  const stale = await cache.runSWR('catalog', 1_000, 10_000, slow)
  assert.equal(stale, 'first', 'stale read should not wait for the refresh')
  assert.equal(cache.pendingRefreshes(), 1, 'one background refresh should be in flight')

  // A second reader during the refresh gets the same stale value, not a second fetch.
  const alsoStale = await cache.runSWR('catalog', 1_000, 10_000, slow)
  assert.equal(alsoStale, 'first')
  assert.equal(calls, 2, 'the refresh must be shared, not repeated')

  release()
  await settle()
  assert.equal(cache.pendingRefreshes(), 0)
  clock += 1
  assert.equal(await cache.runSWR('catalog', 1_000, 10_000, slow), 'second', 'refreshed value must be used next')
}

async function backgroundFailureKeepsOldValue() {
  const cache = makeCache()
  let calls = 0
  const flaky = () => {
    calls += 1
    return calls === 1 ? Promise.resolve('cached') : Promise.reject(new Error('offline'))
  }
  await cache.runSWR('me', 1_000, 10_000, flaky)
  clock += 5_000
  assert.equal(await cache.runSWR('me', 1_000, 10_000, flaky), 'cached')
  await settle()
  clock += 1
  assert.equal(await cache.runSWR('me', 1_000, 10_000, flaky), 'cached', 'a failed refresh must not drop the value')
}

async function beyondStaleWaits() {
  const cache = makeCache()
  let calls = 0
  const value = () => { calls += 1; return `v${calls}` }
  await cache.runSWR('old', 1_000, 5_000, value)
  clock += 20_000 // past staleTtl
  assert.equal(await cache.runSWR('old', 1_000, 5_000, value), 'v2', 'too-old values must be refetched')
}

async function expireDropsOnlyMatchingKeys() {
  const cache = makeCache()
  await cache.run('feeds', 60_000, async () => 'feeds')
  await cache.run('categories', 60_000, async () => 'categories')
  await cache.run('entries:filter=unread&limit=60', 8_000, async () => 'page')
  await cache.run('feed-stats', 60_000, async () => 'stats')

  cache.expire(['entries', 'feed-stats'])
  assert.equal(cache.get('feeds'), 'feeds', 'the catalog must survive a read action')
  assert.equal(cache.get('categories'), 'categories')
  assert.equal(cache.get('entries:filter=unread&limit=60'), undefined, 'entries pages must expire')
  assert.equal(cache.get('feed-stats'), undefined)

  cache.expire(['counters'])
  assert.equal(cache.get('feeds'), 'feeds', 'counters expiry must not touch other keys')
  cache.clear()
  assert.equal(cache.size, 0)
}

async function prefixDoesNotOvermatch() {
  const cache = makeCache()
  await cache.run('feeds', 60_000, async () => 1)
  await cache.run('feed-stats', 60_000, async () => 2)
  cache.expire(['feed-stats'])
  assert.equal(cache.get('feeds'), 1, '"feeds" must not match the "feed-stats" prefix')
  assert.equal(cache.get('feed-stats'), undefined)
}

async function patchRewritesValueAndKeepsFreshness() {
  const cache = makeCache()
  await cache.run('entries:filter=unread', 10_000, async () => ({ total: 2, entries: [{ id: 1, status: 'unread' }, { id: 2, status: 'unread' }] }))
  await cache.run('entries:filter=all', 10_000, async () => ({ total: 2, entries: [{ id: 1, status: 'unread' }] }))

  const changed = cache.patch(['entries'], (page) => ({
    ...page,
    entries: page.entries.filter((entry) => entry.id !== 1),
  }))
  assert.equal(changed, 2, 'every matching page is patched')
  assert.deepEqual(cache.get('entries:filter=unread').entries, [{ id: 2, status: 'unread' }])
  assert.deepEqual(cache.get('entries:filter=all').entries, [])

  // Patching must not reset the clock: an old page stays old and refreshes.
  clock += 9_500
  await cache.runSWR('entries:filter=all', 10_000, 60_000, async () => ({ total: 0, entries: [] }))
  assert.equal(cache.pendingRefreshes(), 0, 'a patched page keeps its age, so it is still fresh here')
}

async function patchSkipsExpiredAndUndefined() {
  const cache = makeCache()
  await cache.run('article:7', 1_000, async () => ({ id: 7, starred: false }))
  clock += 5_000
  const changed = cache.patch(['article:7'], () => ({ id: 7, starred: true }))
  assert.equal(changed, 0, 'an aged-out value is dropped, not resurrected')
  assert.equal(cache.get('article:7'), undefined)

  clock = 0
  await cache.run('article:8', 60_000, async () => ({ id: 8, starred: false }))
  assert.equal(cache.patch(['article:8'], () => undefined), 0, 'returning undefined leaves the value alone')
  assert.deepEqual(cache.get('article:8'), { id: 8, starred: false })
  cache.patch(['article:8'], (value) => ({ ...value, starred: true }))
  assert.deepEqual(cache.get('article:8'), { id: 8, starred: true })
}

const tests = [
  freshHitDoesNotRefetch,
  expiredValueWaitsForFetch,
  staleValueIsServedWhileRefreshing,
  backgroundFailureKeepsOldValue,
  beyondStaleWaits,
  expireDropsOnlyMatchingKeys,
  prefixDoesNotOvermatch,
  patchRewritesValueAndKeepsFreshness,
  patchSkipsExpiredAndUndefined,
]

let failed = 0
for (const test of tests) {
  clock = 0
  try {
    await test()
    console.log(`ok   ${test.name}`)
  } catch (error) {
    failed += 1
    console.error(`fail ${test.name}\n     ${error.message}`)
  }
}

console.log(failed === 0 ? 'cache tests passed' : `${failed} cache test(s) failed`)
process.exit(failed === 0 ? 0 : 1)

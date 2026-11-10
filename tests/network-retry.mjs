/**
 * Connection failures: one retry for idempotent requests, none for the rest,
 * and an error that says what actually happened.
 *
 * "Cannot reach Miniflux: fetch failed" is undici's catch-all; the real reason
 * (ECONNRESET, ENOTFOUND, EPROTO) lives in `error.cause`. The panel runs behind
 * proxies and VPNs that drop a socket now and then, so a GET gets one more
 * chance while a POST — which could subscribe the same feed twice — does not.
 *
 *   node tests/network-retry.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { MinifluxClient } from '../lib/miniflux.js'

const TOKEN = 'retry-token'

/** Counts requests; `dropFirst` paths destroy their first connection. */
function createServer({ dropFirst = [], hang = false } = {}) {
  const hits = []
  const dropped = new Set()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    hits.push(`${req.method} ${path}`)
    if (hang) return // never answers: the client's timeout has to fire
    if (dropFirst.includes(path) && !dropped.has(path)) {
      dropped.add(path)
      req.socket.destroy()
      return
    }
    if (req.headers['x-auth-token'] !== TOKEN) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error_message: 'bad token' }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ total: 0, entries: [], feed_id: 7 }))
  })
  return { server, hits }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function retriesAGet() {
  const { server, hits } = createServer({ dropFirst: ['/v1/entries'] })
  const baseUrl = await listen(server)
  try {
    const client = new MinifluxClient({ baseUrl, token: TOKEN, timeoutMs: 5_000 })
    const page = await client.entries({ status: 'unread', limit: 10 })
    assert.equal(page.total, 0, 'the retried GET should return the real answer')
    assert.equal(hits.filter((hit) => hit === 'GET /v1/entries').length, 2, `expected one retry, saw ${hits.join(', ')}`)
  } finally {
    server.close()
  }
}

async function doesNotRetryAPost() {
  const { server, hits } = createServer({ dropFirst: ['/v1/feeds'] })
  const baseUrl = await listen(server)
  try {
    const client = new MinifluxClient({ baseUrl, token: TOKEN, timeoutMs: 5_000 })
    const error = await client.createFeed({ feedUrl: 'https://example.com/feed.xml' }).then(
      () => null,
      (reason) => reason,
    )
    assert.ok(error, 'a dropped POST should fail rather than silently succeed')
    assert.equal(error.code, 'network')
    assert.match(error.message, /Cannot reach Miniflux/, `unexpected message: ${error.message}`)
    assert.match(error.message, /ECONNRESET|socket hang up|other side closed/i, `the cause is missing: ${error.message}`)
    assert.equal(hits.filter((hit) => hit === 'POST /v1/feeds').length, 1, `a POST must not be retried, saw ${hits.join(', ')}`)
  } finally {
    server.close()
  }
}

async function namesTheCause() {
  // Nothing listens on this port: the connection is refused, and the message
  // has to say so instead of "fetch failed".
  const probe = http.createServer(() => {})
  const baseUrl = await listen(probe)
  await new Promise((resolve) => probe.close(resolve))
  const client = new MinifluxClient({ baseUrl, token: TOKEN, timeoutMs: 2_000 })
  const error = await client.entries({ limit: 1 }).then(() => null, (reason) => reason)
  assert.ok(error, 'an unreachable server should fail')
  assert.equal(error.code, 'network')
  assert.match(error.message, /ECONNREFUSED/i, `the reason should be named: ${error.message}`)
}

async function doesNotRetryATimeout() {
  const { server, hits } = createServer({ hang: true })
  const baseUrl = await listen(server)
  try {
    const client = new MinifluxClient({ baseUrl, token: TOKEN, timeoutMs: 300 })
    const error = await client.entries({ limit: 1 }).then(() => null, (reason) => reason)
    assert.ok(error, 'a hung request should time out')
    assert.equal(error.code, 'timeout')
    assert.equal(hits.length, 1, `a timeout must not be retried, saw ${hits.join(', ')}`)
  } finally {
    server.close()
  }
}

const tests = [retriesAGet, doesNotRetryAPost, namesTheCause, doesNotRetryATimeout]

let failed = 0
for (const test of tests) {
  try {
    await test()
    console.log(`ok   ${test.name}`)
  } catch (error) {
    failed += 1
    console.error(`fail ${test.name}\n     ${error.message}`)
  }
}

console.log(failed === 0 ? 'network-retry tests passed' : `${failed} network-retry test(s) failed`)
process.exit(failed === 0 ? 0 : 1)

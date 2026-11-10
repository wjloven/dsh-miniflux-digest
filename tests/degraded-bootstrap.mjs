/**
 * A degraded upstream must never blank the panel.
 *
 * The field report: right after marking something read (and after adding a
 * feed) the whole subscription list came back empty. Cause: a write expires the
 * caches, the next bootstrap fires four Miniflux calls at once, and when one of
 * them failed the Host answered HTTP 200 with `{feeds: [], categories: []}` —
 * the panel replaced a good catalog with nothing. A missing counters payload
 * had the same effect in the Unread filter, because "no counters" reads as
 * "0 unread on every feed".
 *
 * The panel now folds a degraded answer into what is on screen: it may update
 * what it fetched, it may not delete a catalog it already has.
 *
 *   node tests/degraded-bootstrap.mjs
 *   node tests/degraded-bootstrap.mjs --chromium /path/to/Chromium
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 ? process.argv[index + 1] : fallback
}

const DELAY = Number(arg('delay', 200))
const PORT = Number(arg('port', 5613))
const CHROME = arg('chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium')
const DEBUG_PORT = Number(arg('debugPort', 9347))
const URL_BASE = `http://127.0.0.1:${PORT}/`

if (!fs.existsSync(CHROME)) {
  console.log(`degraded-bootstrap: skipped, no Chromium at ${CHROME}`)
  process.exit(0)
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForHttp(url, timeout = 15_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
    } catch {
      // not up yet
    }
    await wait(120)
  }
  throw new Error(`timed out waiting for ${url}`)
}

async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const problems = []
  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails
      problems.push(details?.exception?.description || details?.text || 'exception')
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      problems.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '))
    }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  return {
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
    problems,
    close() {
      socket.close()
    },
  }
}

/**
 * Wraps fetch so `/bootstrap` can be answered with each degraded shape. The
 * last good payload is remembered so a case can keep the real feeds and only
 * damage one part of it.
 */
const PROBE = `
(() => {
  const original = window.fetch
  window.__bootMode = 'pass'
  window.__lastBoot = null
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '')
    const response = await original(input, init)
    if (!url.includes('/rss-miniflux/api/bootstrap')) return response
    const good = await response.clone().json().catch(() => null)
    if (good && good.status) window.__lastBoot = good
    const mode = window.__bootMode
    if (mode === 'pass' || !good || !good.status) return response
    if (mode === 'http502') {
      return new Response(JSON.stringify({ error: { code: 'upstream_unavailable', message: 'Miniflux is unreachable' } }), {
        status: 502, headers: { 'content-type': 'application/json' },
      })
    }
    let body
    if (mode === 'empty') {
      body = { status: { ...good.status, error: 'Feed counters are unavailable', stale: true, countersUnknown: true }, categories: [], feeds: [], counters: null }
    } else if (mode === 'nocounters') {
      body = { ...good, status: { ...good.status, countersUnknown: true }, counters: null, feeds: (good.feeds || []).map((feed) => ({ ...feed, unread: 0 })) }
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  window.__visibleFeeds = () => document.querySelectorAll('.mrss-sidefeed').length
  window.__unreadBadges = () => [...document.querySelectorAll('.mrss-sidefeed .mrss-count')]
    .reduce((sum, node) => sum + (Number(node.textContent) || 0), 0)
  window.__emptySidebar = () => {
    const text = document.querySelector('.mrss-side')?.innerText || ''
    return /no feeds|add your first feed|没有订阅|添加第一个/i.test(text)
  }
  window.__banner = () => {
    const banner = document.querySelector('.mrss-main .mrss-banner')
    return banner ? banner.innerText.trim().slice(0, 80) : ''
  }
  window.__refresh = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))
})()
`

async function run() {
  const server = spawn(process.execPath, [path.join(root, 'preview/server.mjs'), '--port', String(PORT), '--delay', String(DELAY)], {
    stdio: 'ignore',
  })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mrss-degraded-'))
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' })

  const cleanup = () => {
    chrome.kill('SIGTERM')
    server.kill('SIGTERM')
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  try {
    await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    await waitForHttp(URL_BASE)
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
    const page = targets.find((target) => target.type === 'page')
    assert.ok(page, 'no page target in Chromium')
    const client = await connect(page.webSocketDebuggerUrl)
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1360, height: 880, deviceScaleFactor: 1, mobile: false,
    })

    const evaluate = async (expression) => {
      const result = await client.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed')
      return result.result?.value
    }

    await client.send('Page.navigate', { url: URL_BASE })
    const until = Date.now() + 20_000
    while (Date.now() < until) {
      if (await evaluate('window.__visibleFeeds() > 3')) break
      await wait(150)
    }
    await wait(DELAY + 400)

    const base = await evaluate('({ feeds: window.__visibleFeeds(), badges: window.__unreadBadges() })')
    assert.ok(base.feeds > 3, `the preview should show a populated sidebar, saw ${base.feeds}`)
    assert.ok(base.badges > 0, 'the unread badges should be visible before the degraded answers')

    /** Run one degraded bootstrap and report what the panel did with it. */
    const degrade = async (mode) => {
      await evaluate(`window.__bootMode = ${JSON.stringify(mode)}`)
      await evaluate('window.__refresh()')
      await wait(DELAY + 900)
      const state = await evaluate(`({
        feeds: window.__visibleFeeds(),
        badges: window.__unreadBadges(),
        empty: window.__emptySidebar(),
        banner: window.__banner(),
      })`)
      await evaluate("window.__bootMode = 'pass'")
      return state
    }

    // 1. The exact shape that emptied the sidebar: 200 with empty arrays.
    const empty = await degrade('empty')
    assert.equal(empty.feeds, base.feeds, `a degraded answer dropped feeds: ${empty.feeds} of ${base.feeds}`)
    assert.equal(empty.empty, false, 'the sidebar showed "no feeds" after a degraded answer')
    assert.ok(empty.banner.length > 0, 'a degraded answer should be reported, not silently swallowed')

    // 2. No counters: every feed would read as 0 unread and vanish from the
    //    Unread filter. The panel must keep the numbers it already had.
    const noCounters = await degrade('nocounters')
    assert.equal(noCounters.feeds, base.feeds, `a counterless answer dropped ${base.feeds - noCounters.feeds} feeds`)
    assert.equal(noCounters.empty, false, 'the sidebar looked empty without counters')
    assert.ok(noCounters.badges > 0, 'the unread badges should survive a counterless answer')

    // 3. A hard failure (502) keeps the snapshot, like any failed refresh.
    const failed = await degrade('http502')
    assert.equal(failed.feeds, base.feeds, 'a 502 refresh dropped feeds')

    // 4. Recovery: a good answer clears the banner again.
    await wait(DELAY + 3200) // let the panel's own follow-up refresh land
    const recovered = await evaluate(`({
      feeds: window.__visibleFeeds(), badges: window.__unreadBadges(), banner: window.__banner(),
    })`)
    assert.equal(recovered.feeds, base.feeds)
    assert.ok(recovered.badges > 0, 'the unread badges came back')
    assert.equal(recovered.banner, '', `the error banner should clear after a good answer, saw ${JSON.stringify(recovered.banner)}`)

    assert.deepEqual(client.problems, [], `page errors: ${client.problems.join(' | ')}`)
    console.log('[degraded] base:', JSON.stringify(base))
    console.log('[degraded] empty:', JSON.stringify(empty))
    console.log('[degraded] no counters:', JSON.stringify(noCounters))
    console.log('[degraded] http 502:', JSON.stringify(failed))
    console.log('[degraded] recovered:', JSON.stringify(recovered))
    client.close()
  } finally {
    cleanup()
  }

  console.log('\ndegraded-bootstrap ok')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})

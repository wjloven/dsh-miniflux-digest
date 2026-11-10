/**
 * Interaction checks for the warm paths (v1.5.3).
 *
 * The first paint was already fast after v1.5.0; what still felt slow was every
 * click after it. Each one waited for Miniflux: one list page takes 1.8-5.7 s on
 * a large account, one article 0.7-1.5 s, and the panel asked again each time.
 *
 * This drives the preview shell with a deliberately slow mock (`--delay 1200`)
 * and measures, inside the page, how long it takes for the thing that was
 * clicked to be on screen:
 *
 *   switch-away   a scope the panel has not shown yet: pays the network, once
 *   switch-back   the same scope again: must come from the remembered page
 *   article-reopen  an article already read: must come from the parsed copy
 *   article-neighbour  j/k style walking: the next row was prefetched at idle
 *   article-hover  the row under the pointer was prefetched before the click
 *
 *   node tests/warm-paths.mjs
 *   node tests/warm-paths.mjs --delay 1200 --chromium /path/to/Chromium
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

const DELAY = Number(arg('delay', 1200))
const PORT = Number(arg('port', 5599))
const CHROME = arg('chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium')
const DEBUG_PORT = Number(arg('debugPort', 9334))
const URL_BASE = `http://127.0.0.1:${PORT}/`
/** A warm path may spend one frame or two; anything near DELAY means it waited. */
const FAST = 400

if (!fs.existsSync(CHROME)) {
  console.log(`warm-paths: skipped, no Chromium at ${CHROME}`)
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
 * A row click, timed in the page: how long until the reader shows that title.
 * `rowIndex` is into the visible list; `title` is the row's own title so a stale
 * article left over from the previous step cannot be mistaken for the new one.
 */
const clickArticle = (rowIndex) => `(async () => {
  const rows = [...document.querySelectorAll('.mrss-item')]
  const row = rows[${rowIndex}]
  if (!row) return { error: 'no row ' + ${rowIndex} }
  const wanted = (row.querySelector('.mrss-item-title')?.textContent || '').trim().slice(0, 14)
  const start = performance.now()
  row.click()
  let reader = ''
  const shown = await new Promise((resolve) => {
    const tick = () => {
      reader = (document.querySelector('.mrss-article-title')?.textContent || '').trim()
      const body = document.querySelector('.mrss-article-body')
      if (reader.slice(0, 14) && reader.slice(0, 14) === wanted && body) return resolve(true)
      if (performance.now() - start > 20_000) return resolve(false)
      requestAnimationFrame(tick)
    }
    tick()
  })
  return {
    ms: Math.round(performance.now() - start),
    shown,
    wanted,
    reader: reader.slice(0, 24),
    center: (document.querySelector('.mrss-center')?.textContent || '').slice(0, 60),
  }
})()`

/**
 * A category-tab click, timed until the list is showing that scope *and* not
 * refreshing. The header text changes on click, before any fetch, so the signal
 * that matters is the refresh bar: it only appears when the panel is waiting for
 * a page it does not have.
 */
const clickCategory = (tabIndex) => `(async () => {
  const tabs = [...document.querySelectorAll('.mrss-cat-tab')]
  const tab = tabs[${tabIndex}]
  if (!tab) return { error: 'no tab ' + ${tabIndex} }
  const label = (tab.getAttribute('aria-label') || tab.textContent || '').trim()
  // Let any earlier refresh finish before starting the clock.
  await new Promise((resolve) => {
    const idle = () => {
      const busy = document.querySelector('.mrss-list-head[data-loading="true"]')
        || document.querySelector('[data-testid="list-skeleton"]')
      if (!busy) return resolve()
      setTimeout(idle, 30)
    }
    idle()
  })
  const start = performance.now()
  let sawLoading = false
  const waiting = () => Boolean(
    document.querySelector('.mrss-list-head[data-loading="true"]')
    || document.querySelector('[data-testid="list-skeleton"]'),
  )
  tab.click()
  const done = await new Promise((resolve) => {
    const tick = () => {
      const busy = waiting()
      if (busy) sawLoading = true
      const scope = (document.querySelector('.mrss-scope')?.textContent || '').trim()
      if (scope && label && scope === label && !busy && document.querySelectorAll('.mrss-item').length > 0) return resolve(true)
      if (performance.now() - start > 20_000) return resolve(false)
      requestAnimationFrame(tick)
    }
    tick()
  })
  return { ms: Math.round(performance.now() - start), shown: done, label, sawLoading }
})()`

/** Hover a row the way a pointer does, and wait for the prefetch to land. */
const hoverRow = (rowIndex) => `(() => {
  const rows = [...document.querySelectorAll('.mrss-item')]
  const row = rows[${rowIndex}]
  if (!row) return false
  for (const type of ['mouseover', 'mouseenter', 'pointerover']) {
    row.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
  }
  return true
})()`

const results = {}

async function run() {
  const server = spawn(process.execPath, [path.join(root, 'preview/server.mjs'), '--port', String(PORT), '--delay', String(DELAY)], {
    stdio: 'ignore',
  })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mrss-warm-'))
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
    // First list page plus the icon waves.
    await waitForHttp(URL_BASE)
    const until = Date.now() + 20_000
    while (Date.now() < until) {
      const ready = await evaluate('document.querySelectorAll(".mrss-item").length > 3')
      if (ready) break
      await wait(200)
    }
    await wait(DELAY + 600)

    // 1. Two cold articles, then back to the first: the parsed copy is reused.
    //    The row indices are stable here because no scope switch has happened.
    results.articleCold = await evaluate(clickArticle(0))
    results.articleSecond = await evaluate(clickArticle(1))
    results.articleReopen = await evaluate(clickArticle(0))

    // 2. The rows next to the open article were prefetched while the reader sat
    //    idle, so walking down the list does not wait.
    await wait(DELAY + 1400)
    results.articleNeighbour = await evaluate(clickArticle(2))

    // 3. Hover, rest the pointer, then click: the body was already on its way.
    await evaluate(hoverRow(5))
    await wait(DELAY * 2 + 800)
    results.articleHover = await evaluate(clickArticle(5))

    // 4. A scope switch is the other half of the same problem. Leave the list
    //    on a scope it has never shown (pays the network), then come back to
    //    one it has (must be instant).
    const tabs = await evaluate(`[...document.querySelectorAll('.mrss-cat-tab')]
      .map((tab) => tab.getAttribute('aria-label') || '').slice(0, 6)`)
    results.tabs = tabs
    const current = await evaluate("(document.querySelector('.mrss-scope')?.textContent || '').trim()")
    const otherIndex = tabs.findIndex((label) => label && label !== current)
    if (otherIndex > 0) {
      results.switchAway = await evaluate(clickCategory(otherIndex))
      await wait(DELAY + 500)
      results.switchBack = await evaluate(clickCategory(0))
    }
    results.problems = client.problems
    results.counts = await evaluate(`({
      rows: document.querySelectorAll('.mrss-item').length,
      article: Boolean(document.querySelector('.mrss-article-body')),
      requests: performance.getEntriesByType('resource')
        .filter((entry) => /\\/rss-miniflux\\/api\\/(entries|entry)/.test(entry.name)).length,
    })`)
    client.close()
  } finally {
    cleanup()
  }

  const show = (name) => {
    const value = results[name]
    console.log(`  ${name.padEnd(18)} ${JSON.stringify(value)}`)
    return value
  }

  console.log(`\n[warm paths] mock latency ${DELAY} ms per request`)
  show('articleCold')
  show('articleSecond')
  show('articleReopen')
  show('articleNeighbour')
  show('articleHover')
  show('switchAway')
  show('switchBack')
  console.log(`[warm paths] tabs: ${JSON.stringify(results.tabs || [])}`)
  console.log(`[warm paths] page: ${JSON.stringify(results.counts)}`)

  const steps = ['articleCold', 'articleSecond', 'articleReopen', 'articleNeighbour', 'articleHover']
  if (results.switchAway) steps.push('switchAway', 'switchBack')
  for (const step of steps) {
    assert.ok(!results[step]?.error, `${step} failed: ${results[step]?.error}`)
    assert.equal(results[step].shown, true, `${step} never showed the expected content`)
  }
  assert.ok(results.articleCold.ms >= DELAY * 0.8, `the first article should pay the network, took ${results.articleCold.ms}ms`)
  if (results.switchAway) {
    assert.equal(results.switchAway.sawLoading, true, 'the first visit to a scope should have waited for the network')
    assert.ok(results.switchAway.ms >= DELAY * 0.8, `the first visit to a scope should pay the network, took ${results.switchAway.ms}ms`)
    assert.equal(results.switchBack.sawLoading, false, 'going back to a scope should not show a refresh')
    assert.ok(results.switchBack.ms < FAST, `going back to a scope took ${results.switchBack.ms}ms, expected < ${FAST}ms`)
  }
  assert.ok(results.articleReopen.ms < FAST, `reopening an article took ${results.articleReopen.ms}ms, expected < ${FAST}ms`)
  assert.ok(results.articleNeighbour.ms < FAST, `a prefetched neighbour took ${results.articleNeighbour.ms}ms, expected < ${FAST}ms`)
  assert.ok(results.articleHover.ms < FAST, `a hovered row took ${results.articleHover.ms}ms, expected < ${FAST}ms`)

  assert.deepEqual(results.problems, [], `page errors: ${results.problems.join(' | ')}`)

  console.log('\nwarm-paths ok')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})

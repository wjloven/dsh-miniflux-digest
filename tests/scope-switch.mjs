/**
 * Switching a feed or a category clears the reading column.
 *
 * The reader used to keep the article of the list the user just left, so after
 * clicking another feed (or a category tab) the third column still showed the
 * previous feed's post — and the highlighted row was nowhere in the new list.
 * The switch is now also a "close the reader": the column goes back to its
 * empty state, the selection is dropped, and the saved snapshot remembers a
 * blank reader instead of reopening it on the next page load.
 *
 * A body that was still loading must not paint after the switch either, and
 * re-clicking the scope that is already active keeps the open article.
 *
 *   node tests/scope-switch.mjs
 *   node tests/scope-switch.mjs --chromium /path/to/Chromium
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

const DELAY = Number(arg('delay', 600))
const PORT = Number(arg('port', 5612))
const CHROME = arg('chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium')
const DEBUG_PORT = Number(arg('debugPort', 9346))
const URL_BASE = `http://127.0.0.1:${PORT}/`

if (!fs.existsSync(CHROME)) {
  console.log(`scope-switch: skipped, no Chromium at ${CHROME}`)
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

/** In-page probes, so every assertion is a plain DOM read. */
const HELPERS = `(() => {
  window.__rows = () => [...document.querySelectorAll('.mrss-item')]
  window.__until = (test, timeout = 20000) => new Promise((resolve, reject) => {
    const start = performance.now()
    const tick = () => {
      let ok = false
      try { ok = test() } catch (error) { return reject(error) }
      if (ok) return resolve(true)
      if (performance.now() - start > timeout) return reject(new Error('timeout waiting for the page'))
      setTimeout(tick, 50)
    }
    tick()
  })
  window.__busy = () => Boolean(
    document.querySelector('.mrss-list-head[data-loading="true"]')
    || document.querySelector('[data-testid="list-skeleton"]'),
  )
  /**
   * The list has stopped refreshing *and stayed* that way. A single "not busy"
   * sample is not enough: right after a click React has not committed the new
   * scope yet, so the first sample still describes the previous list. Requiring
   * a quiet window also catches a fetch that starts a frame later.
   */
  window.__idle = (quiet = 300, timeout = 25000) => new Promise((resolve, reject) => {
    const start = performance.now()
    let since = null
    const tick = () => {
      if (window.__busy()) since = null
      else if (since === null) since = performance.now()
      if (since !== null && performance.now() - since >= quiet) return resolve(true)
      if (performance.now() - start > timeout) return reject(new Error('the list never settled'))
      setTimeout(tick, 40)
    }
    tick()
  })
  window.__state = () => {
    const reader = document.querySelector('.mrss-reader')
    const active = window.__rows().findIndex((row) => row.getAttribute('data-active') === 'true')
    return {
      rows: window.__rows().length,
      scope: (document.querySelector('.mrss-scope')?.textContent || '').trim(),
      article: Boolean(document.querySelector('.mrss-article')),
      void: Boolean(document.querySelector('.mrss-void')),
      pick: (document.querySelector('.mrss-void')?.textContent || '').trim(),
      active,
      busy: window.__busy(),
      readerHasContent: Boolean(reader && reader.textContent.trim()),
    }
  }
  /** Open one row of the current list and wait for its body to be on screen. */
  window.__open = async (index) => {
    const row = window.__rows()[index]
    if (!row) throw new Error('no row ' + index)
    row.click()
    await window.__until(() => document.querySelector('.mrss-article'))
    return window.__state()
  }
  /** Click a sidebar feed row and wait until only that feed's rows are listed. */
  window.__switchFeed = async (index) => {
    const row = [...document.querySelectorAll('.mrss-sidefeed')][index]
    if (!row) throw new Error('no sidebar feed ' + index)
    const label = (row.querySelector('.mrss-feedtitle')?.textContent || '').trim()
    row.click()
    await window.__until(() => {
      const active = document.querySelector('.mrss-sidefeed[data-active="true"]')
      const scope = (document.querySelector('.mrss-scope')?.textContent || '').trim()
      return Boolean(active) && scope === label && window.__rows().length > 0
    })
    await window.__idle(300)
    const titles = window.__rows().map((item) => (item.querySelector('.mrss-item-feed')?.textContent || '').trim())
    if (!titles.every((title) => title === label)) {
      throw new Error('the list still shows another feed after switching to ' + label)
    }
    return { label, state: window.__state() }
  }
  /** Click a category tab (0 is "All") and wait for that category's rows. */
  window.__switchTab = async (index) => {
    const tab = [...document.querySelectorAll('.mrss-cat-tab')][index]
    if (!tab) throw new Error('no category tab ' + index)
    const label = (tab.getAttribute('aria-label') || '').trim()
    const wasActive = tab.getAttribute('data-active') === 'true'
    const before = window.__rows().map((item) => (item.querySelector('.mrss-item-feed')?.textContent || '').trim())
    tab.click()
    await window.__until(() => {
      const active = [...document.querySelectorAll('.mrss-cat-tab')][index]
      return Boolean(active && active.getAttribute('data-active') === 'true')
        && window.__rows().length > 0
    })
    await window.__idle(300)
    // The new list must be the new scope's, not the previous rows filtered by
    // it: the sidebar now lists the category's feeds (every feed for "All").
    if (index > 0) {
      const feeds = new Set([...document.querySelectorAll('.mrss-feedtitle')]
        .map((node) => (node.textContent || '').trim()))
      const titles = window.__rows().map((item) => (item.querySelector('.mrss-item-feed')?.textContent || '').trim())
      const outside = titles.filter((title) => !feeds.has(title))
      if (outside.length > 0) throw new Error('rows outside ' + label + ': ' + outside.slice(0, 2).join(', '))
      if (!wasActive && titles.join('|') === before.join('|')) {
        throw new Error('the list did not change after switching to ' + label)
      }
    }
    return { label, state: window.__state() }
  }
  window.__snapshot = () => {
    try { return JSON.parse(localStorage.getItem('rss-miniflux:cache:v1') || 'null') } catch { return null }
  }
})()`

const assertBlank = (state, where) => {
  assert.equal(state.article, false, `${where}: the reader still shows an article`)
  assert.equal(state.void, true, `${where}: the reader is not showing its empty state`)
  assert.equal(state.active, -1, `${where}: a row is still highlighted in the new list`)
  assert.ok(state.pick.length > 0, `${where}: the empty state has no message`)
}

async function run() {
  const server = spawn(process.execPath, [path.join(root, 'preview/server.mjs'), '--port', String(PORT), '--delay', String(DELAY)], {
    stdio: 'ignore',
  })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mrss-scope-'))
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
    // Opening an article must not write: the preview accepts /action without
    // mutating its data, so a "marked read" entry would stay in the unread
    // list while the sidebar counter believed it was gone. This test is about
    // the reader, not the read state.
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "try { localStorage.setItem('rss-miniflux:prefs', JSON.stringify({ markReadOnOpen: false })) } catch (error) {}",
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
      if (await evaluate('document.querySelectorAll(".mrss-item").length > 10')) break
      await wait(150)
    }
    await evaluate(HELPERS)
    await wait(DELAY + 300)

    const log = {}
    const first = await evaluate('window.__state()')
    assert.equal(first.article, false, 'the reader starts blank')
    assert.ok(first.void, 'the reader starts in its empty state')

    // 1. Read an article in the All scope.
    log.openedAll = await evaluate('window.__open(0)')
    assert.equal(log.openedAll.article, true, 'clicking a row did not open the article')
    assert.equal(log.openedAll.active, 0, 'the clicked row is not the highlighted one')

    // 2. Clicking one feed clears the reader.
    log.feed = await evaluate('window.__switchFeed(0)')
    assertBlank(log.feed.state, 'after switching to a feed')
    await wait(700) // the snapshot (and its patch) is written 400ms after the change
    const saved = await evaluate('window.__snapshot()')
    assert.ok(saved, 'no snapshot was written')
    assert.equal(saved.selectedId, null, 'the snapshot still remembers the previous article')
    assert.equal(saved.scope?.kind, 'feed', `the snapshot scope is ${saved.scope?.kind}`)

    // 3. Reading inside the feed, then a category tab: also blank.
    log.openedFeed = await evaluate('window.__open(0)')
    assert.equal(log.openedFeed.article, true, 'the feed list does not open an article')
    log.tab = await evaluate('window.__switchTab(1)')
    assertBlank(log.tab.state, 'after switching to a category')
    assert.equal(log.tab.state.scope, log.tab.label, 'the list did not move to the category')

    // 4. Re-clicking the category that is already active is a no-op: the open
    //    article stays (the switch only clears when the scope really changes).
    log.openedCategory = await evaluate('window.__open(1)')
    assert.equal(log.openedCategory.article, true, 'the category list does not open an article')
    const again = await evaluate('window.__switchTab(1)')
    assert.equal(again.state.article, true, 're-clicking the active category closed the reader')
    assert.equal(again.state.active, 1, 're-clicking the active category dropped the selection')
    assert.equal(again.state.void, false, 're-clicking the active category showed the empty state')

    // 5. "All" is a scope too.
    log.all = await evaluate('window.__switchTab(0)')
    assertBlank(log.all.state, 'after switching to All')

    // 6. A body still in flight must not land after the switch. Start from a
    //    fresh page so no body can be in memory, then click a row and leave
    //    before its request answers.
    await wait(700) // the cleared snapshot lands 400ms after the switch
    await client.send('Page.reload', { ignoreCache: true })
    const reloadUntil = Date.now() + 20_000
    while (Date.now() < reloadUntil) {
      const ready = await evaluate('document.querySelectorAll(".mrss-item").length > 3')
      if (ready) break
      await wait(150)
    }
    await evaluate(HELPERS)
    await evaluate('window.__idle(400)')
    const restored = await evaluate('window.__state()')
    assert.equal(restored.article, false, 'the reload reopened an article instead of a blank reader')
    assert.equal(restored.active, -1, 'the reload restored a selection')
    const raced = await evaluate(`(async () => {
      const row = window.__rows()[5]
      row.click()
      await new Promise((resolve) => setTimeout(resolve, Math.round(${DELAY} * 0.25)))
      const loading = {
        article: Boolean(document.querySelector('.mrss-article')),
        text: (document.querySelector('.mrss-center')?.textContent || '').trim().slice(0, 32),
      }
      const tab = [...document.querySelectorAll('.mrss-cat-tab')][2]
      const label = (tab?.getAttribute('aria-label') || '').trim()
      tab?.click()
      await window.__idle(300)
      await new Promise((resolve) => setTimeout(resolve, ${DELAY} * 3))
      return { loading, label, state: window.__state() }
    })()`)
    log.race = raced
    assert.ok(raced.label, 'no category tab for the race check')
    assert.equal(raced.loading.article, false, 'the row painted instantly, nothing was in flight')
    assertBlank(raced.state, 'after leaving while the body was loading')
    assert.equal(raced.state.scope, raced.label, 'the race check did not reach the new scope')

    assert.deepEqual(client.problems, [], `page errors: ${client.problems.join(' | ')}`)

    console.log('[scope-switch] opened in All:', JSON.stringify({
      article: log.openedAll.article, active: log.openedAll.active,
    }))
    console.log('[scope-switch] feed switch:', JSON.stringify({
      label: log.feed.label, scope: log.feed.state.scope, void: log.feed.state.void, active: log.feed.state.active,
    }))
    console.log('[scope-switch] category switch:', JSON.stringify({
      label: log.tab.label, scope: log.tab.state.scope, void: log.tab.state.void,
    }))
    console.log('[scope-switch] same tab again:', JSON.stringify({
      article: again.state.article, active: again.state.active,
    }))
    console.log('[scope-switch] race:', JSON.stringify(raced.loading))
    console.log('[scope-switch] snapshot:', JSON.stringify({ selectedId: saved.selectedId, scope: saved.scope?.kind }))
    client.close()
  } finally {
    cleanup()
  }

  console.log('\nscope-switch ok')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

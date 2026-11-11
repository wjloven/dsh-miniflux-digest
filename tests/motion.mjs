/**
 * The motion language of a scope switch.
 *
 * Switching a feed or a category now reads as one transition instead of a hard
 * cut: the scope label fades, the sidebar feed list fades with the category, the
 * list sheet fades in once its page is painted, the reader falls back to its
 * (fading in) empty state, and an opened entry settles in. People who ask for
 * reduced motion get none of it, but the same final state.
 *
 *   node tests/motion.mjs
 *   node tests/motion.mjs --chromium /path/to/Chromium
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

const DELAY = Number(arg('delay', 300))
const PORT = Number(arg('port', 5616))
const CHROME = arg('chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium')
const DEBUG_PORT = Number(arg('debugPort', 9350))
const URL_BASE = `http://127.0.0.1:${PORT}/`

if (!fs.existsSync(CHROME)) {
  console.log(`motion: skipped, no Chromium at ${CHROME}`)
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

const HELPERS = `(() => {
  window.__until = (test, timeout = 20000) => new Promise((resolve, reject) => {
    const start = performance.now()
    const tick = () => {
      let ok = false
      try { ok = test() } catch (error) { return reject(error) }
      if (ok) return resolve(true)
      if (performance.now() - start > timeout) return reject(new Error('timeout waiting for the page'))
      setTimeout(tick, 40)
    }
    tick()
  })
  window.__anim = (selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const style = getComputedStyle(el)
    return { name: style.animationName, opacity: Number(style.opacity) }
  }
  /** Click a category tab and wait until its list is on screen. */
  window.__tab = async (index) => {
    const tab = [...document.querySelectorAll('.mrss-cat-tab')][index]
    if (!tab) throw new Error('no category tab ' + index)
    tab.click()
    await window.__until(() => {
      const active = [...document.querySelectorAll('.mrss-cat-tab')][index]
      const busy = document.querySelector('.mrss-list-head[data-loading="true"]')
        || document.querySelector('[data-testid="list-skeleton"]')
      return Boolean(active && active.getAttribute('data-active') === 'true')
        && !busy && document.querySelectorAll('.mrss-item').length > 0
    })
  }
  window.__switchState = () => ({
    list: window.__anim('.mrss-list .mrss-scroll'),
    listAttr: document.querySelector('.mrss-list .mrss-scroll')?.getAttribute('data-anim') || '',
    scope: window.__anim('.mrss-scope'),
    // The idle reader is the greeting page (the chat only opens on demand).
    pane: window.__anim('.mrss-void'),
    sidebar: window.__anim('.mrss-feedline'),
    article: window.__anim('.mrss-article'),
  })
})()`

async function run() {
  const server = spawn(process.execPath, [path.join(root, 'preview/server.mjs'), '--port', String(PORT), '--delay', String(DELAY)], {
    stdio: 'ignore',
  })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mrss-motion-'))
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
    const until = Date.now() + 20_000
    while (Date.now() < until) {
      if (await evaluate('document.querySelectorAll(".mrss-item").length > 5')) break
      await wait(150)
    }
    await evaluate(HELPERS)
    await wait(DELAY + 400)

    // 1. Opening an entry settles the article in.
    await evaluate(`(async () => {
      document.querySelectorAll('.mrss-item')[0].click()
      await window.__until(() => document.querySelector('.mrss-article'))
    })()`)
    const opened = await evaluate('window.__switchState()')
    assert.equal(opened.article.name, 'mrss-article-in', 'the article has no settle-in')
    await wait(320) // the 180ms settle-in must end on fully visible text
    const openedSettled = await evaluate('window.__switchState()')
    assert.equal(openedSettled.article.opacity, 1, 'the entry never became fully visible')

    // 2. A category swap fades the label, the sidebar, the list sheet and the
    //    empty reader.
    await evaluate('window.__tab(1)')
    await wait(400)
    const swapped = await evaluate('window.__switchState()')
    assert.equal(swapped.listAttr, 'true', 'the new list is not marked as an animated page')
    for (const [facet, expected] of [
      ['list', 'mrss-list-in'],
      ['scope', 'mrss-fade'],
      ['pane', 'mrss-void-in'],
      ['sidebar', 'mrss-list-in'],
    ]) {
      assert.ok(swapped[facet], `no ${facet} to measure after the switch`)
      assert.equal(swapped[facet].name, expected, `${facet} does not use ${expected}`)
    }
    // The fades must end on the visible state, not leave the panel blank.
    for (const facet of ['list', 'pane', 'sidebar']) {
      assert.equal(swapped[facet].opacity, 1, `${facet} is still not fully visible after the switch`)
    }

    // 3. A restored article is content the snapshot already had: it paints as
    //    is, without replaying the entry animation every time the panel comes
    //    back from the conversation pane.
    //    A reload first, so the entry is fetched rather than served from this
    //    session's memory cache (that path does not write the article snapshot).
    await client.send('Page.reload', { ignoreCache: true })
    const warmUntil = Date.now() + 20_000
    while (Date.now() < warmUntil) {
      if (await evaluate('document.querySelectorAll(".mrss-item").length > 5')) break
      await wait(120)
    }
    await evaluate(HELPERS)
    await wait(DELAY + 300)
    await evaluate(`(async () => {
      document.querySelectorAll('.mrss-item')[0].click()
      await window.__until(() => document.querySelector('.mrss-article'))
    })()`)
    // Wait for the snapshot writer: the article body key plus the selected id.
    await evaluate(`window.__until(() => {
      const snap = JSON.parse(localStorage.getItem('rss-miniflux:cache:v1') || 'null')
      return Boolean(localStorage.getItem('rss-miniflux:cache:v1:article'))
        && Boolean(snap && snap.selectedId)
    })`)
    await wait(500)
    await client.send('Page.reload', { ignoreCache: true })
    const reloadUntil = Date.now() + 20_000
    while (Date.now() < reloadUntil) {
      if (await evaluate('Boolean(document.querySelector(".mrss-article"))')) break
      await wait(120)
    }
    assert.ok(await evaluate('Boolean(document.querySelector(".mrss-article"))'), 'the article was not restored after the reload')
    const restored = await evaluate(`(() => {
      const el = document.querySelector('.mrss-article')
      return {
        enter: el.classList.contains('mrss-article--enter'),
        name: getComputedStyle(el).animationName,
      }
    })()`)
    assert.equal(restored.enter, false, 'the restored article replays the entry animation')
    assert.equal(restored.name, 'none', 'the restored article still has an animation')
    await evaluate(HELPERS) // the reload dropped the probes

    // 4. Reduced motion: the same layout, no movement.
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    await evaluate('window.__tab(2)')
    await wait(300)
    const reduced = await evaluate('window.__switchState()')
    for (const facet of ['list', 'scope', 'pane', 'sidebar']) {
      assert.ok(reduced[facet], `no ${facet} to measure in reduced motion`)
      assert.equal(reduced[facet].name, 'none', `${facet} still animates with reduced motion`)
      if (facet !== 'scope') assert.equal(reduced[facet].opacity, 1, `${facet} is hidden in reduced motion`)
    }

    await evaluate(`(async () => {
      document.querySelectorAll('.mrss-item')[0].click()
      await window.__until(() => document.querySelector('.mrss-article'))
    })()`)
    const reducedArticle = await evaluate('window.__switchState()')
    assert.equal(reducedArticle.article.name, 'none', 'the article still animates with reduced motion')

    assert.deepEqual(client.problems, [], `page errors: ${client.problems.join(' | ')}`)

    console.log('[motion] opened:  ', JSON.stringify({ article: opened.article }))
    console.log('[motion] swapped: ', JSON.stringify({
      list: swapped.list, scope: swapped.scope, pane: swapped.pane, sidebar: swapped.sidebar,
    }))
    console.log('[motion] restored:', JSON.stringify(restored))
    console.log('[motion] reduced: ', JSON.stringify({
      list: reduced.list, scope: reduced.scope, pane: reduced.pane, sidebar: reduced.sidebar,
      article: reducedArticle.article,
    }))
    client.close()
  } finally {
    cleanup()
  }

  console.log('\nmotion ok')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

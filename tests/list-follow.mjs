/**
 * The list follows the selection.
 *
 * Before this, `j` / `k` moved the reader while the list stayed put, so the
 * highlighted row walked off the bottom of the column and the reader showed an
 * article with no visible row. The list now scrolls the selected row into view,
 * but only when it is actually out of sight, and never twice for the same
 * selection (a background refresh must not yank a manual scroll back).
 *
 *   node tests/list-follow.mjs
 *   node tests/list-follow.mjs --chromium /path/to/Chromium
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
const PORT = Number(arg('port', 5607))
const CHROME = arg('chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium')
const DEBUG_PORT = Number(arg('debugPort', 9341))
const URL_BASE = `http://127.0.0.1:${PORT}/`

if (!fs.existsSync(CHROME)) {
  console.log(`list-follow: skipped, no Chromium at ${CHROME}`)
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

/** The list scroller, the highlighted row, and a wait for smooth scrolling. */
const HELPERS = `(() => {
  window.__list = () => document.querySelector('.mrss-list .mrss-scroll')
  window.__active = () => document.querySelector('.mrss-item[data-active="true"]')
  window.__rowHeight = () => {
    const row = document.querySelector('.mrss-item')
    return row ? row.getBoundingClientRect().height : 0
  }
  // React commits the new selection a frame or two after the key press, so the
  // first 150ms are not evidence that the list has settled.
  window.__settle = () => new Promise((resolve) => {
    const list = window.__list()
    const start = performance.now()
    let last = list ? list.scrollTop : 0
    let stable = 0
    const until = start + 3000
    const tick = () => {
      const now = list ? list.scrollTop : 0
      if (Math.abs(now - last) < 0.5) stable += 1
      else stable = 0
      last = now
      if ((stable >= 4 && performance.now() - start > 150) || performance.now() > until) return resolve(now)
      requestAnimationFrame(tick)
    }
    tick()
  })
  /** Is the highlighted row fully inside the list viewport? */
  window.__visible = () => {
    const list = window.__list()
    const row = window.__active()
    if (!list || !row) return false
    const box = list.getBoundingClientRect()
    const rect = row.getBoundingClientRect()
    return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1
  }
  window.__press = (key) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  }
  window.__state = () => {
    const list = window.__list()
    const row = window.__active()
    return {
      scrollTop: list ? Math.round(list.scrollTop) : -1,
      scrollHeight: list ? list.scrollHeight : 0,
      viewport: list ? list.clientHeight : 0,
      rows: document.querySelectorAll('.mrss-item').length,
      active: row ? (row.querySelector('.mrss-item-title')?.textContent || '').slice(0, 20) : '',
      visible: window.__visible(),
      index: row ? [...document.querySelectorAll('.mrss-item')].indexOf(row) : -1,
    }
  }
})()`

async function run() {
  const server = spawn(process.execPath, [path.join(root, 'preview/server.mjs'), '--port', String(PORT), '--delay', String(DELAY)], {
    stdio: 'ignore',
  })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mrss-follow-'))
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
      width: 1360, height: 820, deviceScaleFactor: 1, mobile: false,
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
      if (await evaluate('document.querySelectorAll(".mrss-item").length > 12')) break
      await wait(150)
    }
    await evaluate(HELPERS)
    await wait(DELAY + 200)

    const start = await evaluate('({ ...window.__state(), rowHeight: window.__rowHeight() })')
    assert.equal(start.scrollTop, 0, 'the list should start at the top')
    assert.ok(start.rows > 12, `expected a long list, saw ${start.rows} rows`)
    assert.ok(start.rowHeight > 20, 'rows have no height')

    // 1. Walking down with `j` must bring the highlighted row into view.
    await evaluate(`(async () => {
      for (let index = 0; index < 8; index += 1) {
        window.__press('j')
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      await window.__settle()
    })()`)
    const walked = await evaluate('window.__state()')
    assert.equal(walked.index, 7, `j should land on row 7, landed on ${walked.index}`)
    assert.ok(walked.visible, 'the selected row is still outside the list viewport')
    assert.ok(walked.scrollTop > 0, 'the list never scrolled to follow the selection')

    // 2. A manual scroll is not taken back while the selection does not change.
    await evaluate('window.__list().scrollTop = 0')
    await wait(500)
    const afterManual = await evaluate('window.__state()')
    assert.equal(afterManual.scrollTop, 0, 'a manual scroll was overridden without a new selection')

    // 3. The next selection brings it back, and `k` walks back up.
    await evaluate(`(async () => { window.__press('j'); await window.__settle() })()`)
    const resumed = await evaluate('window.__state()')
    assert.equal(resumed.index, 8, `expected row 8 after j, saw ${resumed.index}`)
    assert.ok(resumed.visible, 'the list did not scroll back to the selected row')
    assert.ok(resumed.scrollTop > 0, 'the list stayed at the top after the selection moved off screen')

    // 4. A row that is already fully visible must not move the list at all.
    //    Park the selection near the top of the viewport so the next row is
    //    certainly on screen, then step once.
    const beforeStill = await evaluate(`(async () => {
      const list = window.__list()
      const active = window.__active()
      const delta = active.getBoundingClientRect().top - list.getBoundingClientRect().top
      list.scrollTop += delta - 24
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return window.__state()
    })()`)
    await evaluate(`(async () => { window.__press('j'); await window.__settle() })()`)
    const afterStill = await evaluate('window.__state()')
    assert.ok(afterStill.visible, 'the row after a visible one is not visible')
    const moved = Math.abs(afterStill.scrollTop - beforeStill.scrollTop)
    assert.ok(
      moved <= 2,
      `stepping to an already visible row moved the list by ${moved}px (one row is ${Math.round(start.rowHeight)}px)`,
    )

    // 5. Upwards: `k` returns to the previous selection and keeps it visible.
    await evaluate(`(async () => {
      for (let index = 0; index < 5; index += 1) {
        window.__press('k')
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      await window.__settle()
    })()`)
    const up = await evaluate('window.__state()')
    assert.ok(up.visible, 'scrolling up left the selected row outside the viewport')

    // 6. A row opened by a click stays visible as well (it already is, by
    //    definition, but the follow effect must not undo the click's scroll).
    const clicked = await evaluate(`(async () => {
      const rows = [...document.querySelectorAll('.mrss-item')]
      const row = rows[10]
      row.click()
      await new Promise((resolve) => setTimeout(resolve, 80))
      await window.__settle()
      return window.__state()
    })()`)
    assert.equal(clicked.index, 10, `the click selected row ${clicked.index}`)
    assert.ok(clicked.visible, 'a clicked row is not visible in the list')

    assert.deepEqual(client.problems, [], `page errors: ${client.problems.join(' | ')}`)
    console.log('[list-follow] start:', JSON.stringify({ scrollTop: start.scrollTop, rowHeight: Math.round(start.rowHeight) }))
    console.log('[list-follow] j x8:', JSON.stringify({ index: walked.index, scrollTop: walked.scrollTop }))
    console.log('[list-follow] manual scroll:', afterManual.scrollTop)
    console.log('[list-follow] k x5:', JSON.stringify({ index: up.index, scrollTop: up.scrollTop }))
    client.close()
  } finally {
    cleanup()
  }

  console.log('\nlist-follow ok')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})

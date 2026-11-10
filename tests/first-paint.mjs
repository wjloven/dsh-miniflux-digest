/**
 * First-paint check for the saved snapshot.
 *
 * Runs the preview shell against a mock API that is deliberately slow
 * (`--delay 1200`), drives headless Chromium over CDP and reports when the
 * panel first shows its shell, its account name, its list rows and its
 * skeletons. Two passes:
 *
 *   cold  no localStorage → the panel has to wait for the first fetch
 *   warm  reload with a saved snapshot → rows and account must be on screen
 *         long before the network answers
 *
 *   node tests/first-paint.mjs
 *   node tests/first-paint.mjs --delay 1600 --chromium /path/to/Chromium
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
const PORT = Number(arg('port', 5588))
const CHROME = arg('chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium')
const DEBUG_PORT = Number(arg('debugPort', 9333))
const URL_BASE = `http://127.0.0.1:${PORT}/`

if (!fs.existsSync(CHROME)) {
  console.log(`first-paint: skipped, no Chromium at ${CHROME}`)
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

/** Minimal CDP client over the devtools WebSocket. */
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

/** Timestamps, in ms since navigation start, captured inside the page. */
const PROBE = `
(() => {
  const marks = (window.__paint = {})
  const stamp = (key) => { if (marks[key] === undefined) marks[key] = Math.round(performance.now()) }
  const sample = () => {
    const root = document.querySelector('.mrss-root')
    if (!root) return
    stamp('root')
    if (root.getAttribute('data-mrss-hydrated') === 'true') stamp('hydrated')
    if (document.querySelector('.mrss-account-name')) stamp('account')
    if (document.querySelector('.mrss-item')) stamp('item')
    if (document.querySelector('[data-testid="list-skeleton"]')) stamp('listSkeleton')
    if (document.querySelector('[data-testid="sidebar-skeleton"]')) stamp('sidebarSkeleton')
    if (document.querySelector('.mrss-favicon--tile')) stamp('iconTile')
    if (document.querySelector('.mrss-favicon--in')) stamp('iconImage')
    if (document.querySelector('.mrss-favicon--in') && !marks.iconsAll) {
      const rows = document.querySelectorAll('.mrss-sidefeed .mrss-favicon, .mrss-sidefeed .mrss-favicon--tile').length
      const images = document.querySelectorAll('.mrss-sidefeed .mrss-favicon--in').length
      if (rows > 0 && images >= rows) marks.iconsAll = Math.round(performance.now())
    }
  }
  const observer = new MutationObserver(sample)
  document.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.documentElement, { childList: true, subtree: true })
    sample()
  })
})()
`

const results = {}
const SHOTS = arg('shots', '')
const THEME = arg('theme', '')

async function run() {
  const server = spawn(process.execPath, [path.join(root, 'preview/server.mjs'), '--port', String(PORT), '--delay', String(DELAY)], {
    stdio: 'ignore',
  })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mrss-chrome-'))
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
      width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
    })
    const shoot = async (name) => {
      if (!SHOTS) return
      const { data } = await client.send('Page.captureScreenshot', { format: 'png' })
      fs.mkdirSync(SHOTS, { recursive: true })
      fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'))
    }

    const evaluate = async (expression) => {
      const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      return result.result?.value
    }

    const load = async (label, prepare) => {
      if (prepare) await evaluate(prepare)
      const query = new URLSearchParams({ run: label })
      if (THEME) query.set('theme', THEME)
      await client.send('Page.navigate', { url: `${URL_BASE}?${query}` })
      await wait(400)
      const early = await evaluate('({ text: document.body.innerText.slice(0, 400), hydrated: document.querySelector(".mrss-root")?.getAttribute("data-mrss-hydrated") || null })')
      await shoot(`${label}-early`)
      // Long enough for the slow mock to finish every icon wave and let the
      // panel write its icon store before the next pass reloads.
      await wait(DELAY * 2 + 3000)
      await shoot(`${label}-settled`)
      const marks = await evaluate('window.__paint || {}')
      const state = await evaluate(`({
        items: document.querySelectorAll('.mrss-item').length,
        account: document.querySelector('.mrss-account-name')?.textContent || '',
        stored: Boolean(localStorage.getItem('rss-miniflux:cache:v1')),
        storedBytes: (localStorage.getItem('rss-miniflux:cache:v1') || '').length,
        icons: document.querySelectorAll('.mrss-favicon--in, .mrss-meta-favicon.mrss-favicon--in').length,
        tiles: document.querySelectorAll('.mrss-favicon--tile, .mrss-meta-favicon.mrss-favicon--tile').length,
        iconRequests: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/rss-miniflux/api/icon')).length,
      })`)
      return { early, marks, state }
    }

    // Pass 1: cold, nothing saved.
    results.cold = await load('cold', 'localStorage.clear()')
    await wait(600)
    // Pass 2: warm, the panel wrote a snapshot on the cold pass.
    results.warm = await load('warm', null)

    results.problems = client.problems
    client.close()
  } finally {
    cleanup()
  }

  const summarize = (name) => {
    const run = results[name]
    const marks = run.marks || {}
    console.log(`\n[${name}] marks (ms since navigation start): ${JSON.stringify(marks)}`)
    console.log(`[${name}] after ${DELAY * 2 + 3000}ms: items=${run.state.items} account=${JSON.stringify(run.state.account)} snapshot=${run.state.stored} (${run.state.storedBytes}B)`)
    return marks
  }

  const cold = summarize('cold')
  const warm = summarize('warm')

  console.log(`\n[cold] first frame text: ${JSON.stringify(results.cold.early.text.slice(0, 160))}`)
  console.log(`[warm] first frame text: ${JSON.stringify(results.warm.early.text.slice(0, 160))}`)

  // The cold pass has to explain itself with skeletons, never with the
  // "not connected" or "no feeds yet" copy.
  assert.equal(results.cold.early.hydrated, null, 'cold pass must not claim a snapshot')
  assert.ok(!/Not connected/.test(results.cold.early.text), 'cold pass flashed "Not connected"')
  assert.ok(!/Add your first feed|No feeds yet|No feeds/i.test(results.cold.early.text), 'cold pass flashed the empty feed state')
  assert.ok(!/No entries match/.test(results.cold.early.text), 'cold pass flashed the empty list state')
  assert.ok(cold.listSkeleton !== undefined || cold.sidebarSkeleton !== undefined, 'cold pass never showed a skeleton')

  // The warm pass must have rows on screen before the mock API answers.
  assert.equal(results.warm.early.hydrated, 'true', 'warm pass did not paint from the snapshot')
  assert.ok(warm.item !== undefined, 'warm pass never rendered list rows')
  assert.ok(warm.item < DELAY, `warm pass rendered rows after ${warm.item}ms, expected < ${DELAY}ms`)
  assert.ok(results.warm.state.items > 0, 'warm pass ended with an empty list')
  assert.match(results.warm.state.account, /\w/, 'warm pass did not restore the account name')
  assert.ok(warm.listSkeleton === undefined || warm.item < warm.listSkeleton, 'warm pass showed the list skeleton before its rows')
  // The saved icon store must paint the icons on the first frame instead of
  // re-asking the slow endpoint.
  assert.ok(warm.iconImage !== undefined, 'warm pass never painted an icon')
  assert.ok(warm.iconImage - warm.item < 400, `warm pass painted icons ${warm.iconImage - warm.item}ms after the rows; the icon store should make that instant`)
  assert.equal(results.warm.state.iconRequests, 0, 'warm pass should not fetch icons one by one')

  assert.deepEqual(results.problems, [], `page errors: ${results.problems.join(' | ')}`)

  console.log('\nfirst-paint ok')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})

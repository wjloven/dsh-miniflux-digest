/**
 * First-open measurement against the live Harness GUI (not the preview).
 *
 * Loads the GUI in headless Chromium, opens the Miniflux digest panel from the
 * sidebar, records when the panel shell, the account name and the first list
 * row appear, then reloads and records the same marks from the saved snapshot.
 *
 *   node tests/live-first-open.mjs
 *   node tests/live-first-open.mjs --url http://127.0.0.1:51592
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 ? process.argv[index + 1] : fallback
}

const GUI = arg('url', 'http://127.0.0.1:51592')
const CHROME = arg('chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium')
const DEBUG_PORT = Number(arg('debugPort', 9444))
const SHOTS = arg('shots', '')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
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
    close() {
      socket.close()
    },
  }
}

const PROBE = `
(() => {
  const marks = (window.__paint = {})
  const stamp = (key) => { if (marks[key] === undefined) marks[key] = Math.round(performance.now()) }
  window.__markPanelOpen = () => { marks.opened = Math.round(performance.now()) }
  const sample = () => {
    const root = document.querySelector('.mrss-root')
    if (!root) return
    stamp('panel')
    if (root.getAttribute('data-mrss-hydrated') === 'true') stamp('hydrated')
    if (document.querySelector('.mrss-account-name')) stamp('account')
    if (document.querySelector('.mrss-item')) stamp('item')
    if (document.querySelector('[data-testid="list-skeleton"]')) stamp('listSkeleton')
    if (document.querySelector('[data-testid="sidebar-skeleton"]')) stamp('sidebarSkeleton')
  }
  const observer = new MutationObserver(sample)
  document.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.documentElement, { childList: true, subtree: true })
    sample()
  })
})()
`

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mrss-gui-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' })

const cleanup = () => {
  chrome.kill('SIGTERM')
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* best effort */ }
}

async function waitForDebug() {
  const until = Date.now() + 15_000
  while (Date.now() < until) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
      if (response.ok) return
    } catch {
      // not up yet
    }
    await wait(120)
  }
  throw new Error('Chromium debug port never opened')
}

async function run() {
  await waitForDebug()
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  const client = await connect(page.webSocketDebuggerUrl)
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })

  const evaluate = async (expression) => {
    const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed')
    return result.result?.value
  }
  const shoot = async (name) => {
    if (!SHOTS) return
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' })
    fs.mkdirSync(SHOTS, { recursive: true })
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'))
  }

  /** Click the sidebar entry that opens the panel, if it is not already open. */
  const openPanel = async () => {
    const clicked = await evaluate(`(() => {
      if (document.querySelector('.mrss-root')) return 'already-open'
      const nodes = [...document.querySelectorAll('button, [role="button"], a, li, div')]
      const hit = nodes.find((node) => {
        const label = (node.getAttribute('aria-label') || '') + ' ' + node.textContent
        return /miniflux digest/i.test(label) && node.getBoundingClientRect().width > 0
      })
      if (!hit) return 'not-found'
      hit.click()
      if (window.__markPanelOpen) window.__markPanelOpen()
      return 'clicked'
    })()`)
    return clicked
  }

  await client.send('Page.navigate', { url: GUI })
  await wait(2500)
  const first = await openPanel()
  if (first !== 'clicked') {
    console.log(`live-first-open: could not open the panel from the sidebar (${first})`)
  }
  await wait(250)
  await shoot('gui-open-early')
  await wait(2500)
  await shoot('gui-open-settled')
  const coldMarks = await evaluate('window.__paint || {}')
  const coldState = await evaluate(`({
    items: document.querySelectorAll('.mrss-item').length,
    account: document.querySelector('.mrss-account-name')?.textContent || '',
    stored: Boolean(localStorage.getItem('rss-miniflux:cache:v1')),
    bytes: (localStorage.getItem('rss-miniflux:cache:v1') || '').length,
  })`)

  // Reload the whole GUI and open the panel again: the saved snapshot should
  // paint the account and the list without waiting for the Host.
  await client.send('Page.reload')
  await wait(2500)
  await evaluate('window.__paint = {}')
  const second = await openPanel()
  if (second !== 'clicked') {
    console.log(`live-first-open: could not reopen the panel (${second})`)
  }
  await wait(250)
  await shoot('gui-reopen-early')
  const warmMarks = await evaluate('window.__paint || {}')
  const warmState = await evaluate(`({
    items: document.querySelectorAll('.mrss-item').length,
    account: document.querySelector('.mrss-account-name')?.textContent || '',
    stored: Boolean(localStorage.getItem('rss-miniflux:cache:v1')),
  })`)

  client.close()
  console.log(`\n[live gui] first open (cold for this browser profile): ${JSON.stringify(coldMarks)}`)
  console.log(`[live gui] state: ${JSON.stringify(coldState)}`)
  console.log(`[live gui] reopen after reload (snapshot): ${JSON.stringify(warmMarks)}`)
  console.log(`[live gui] state: ${JSON.stringify(warmState)}`)
}

run()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(cleanup)

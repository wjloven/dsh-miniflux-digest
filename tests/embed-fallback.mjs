/**
 * The player document reports whether it can send a Referer.
 *
 * YouTube's embedded player needs one ("error 153"), and the *player document's*
 * policy is what decides it — not the embedding page's. So the check lives in
 * the Host-served player page and arrives here as a message:
 *
 *   { source: 'rss-miniflux-player', referer: false }
 *
 * Only that negative answer swaps the player for a card: a shell that strips the
 * header outright means no player can work, and a card that opens the video in
 * the browser is better than a black error box. Until it arrives the player
 * stays, because it is the richer result.
 *
 *   node tests/embed-fallback.mjs
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
const PORT = Number(arg('port', 5624))
const CHROME = arg('chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium')
const DEBUG_PORT = Number(arg('debugPort', 9354))
const URL_BASE = `http://127.0.0.1:${PORT}/`

if (!fs.existsSync(CHROME)) {
  console.log(`embed-fallback: skipped, no Chromium at ${CHROME}`)
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

async function run() {
  const server = spawn(process.execPath, [path.join(root, 'preview/server.mjs'), '--port', String(PORT), '--delay', String(DELAY)], {
    stdio: 'ignore',
  })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mrss-embed-'))
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

    const state = () => evaluate(`(() => {
      const card = document.querySelector('.mrss-embed--link')
      const frame = document.querySelector('.mrss-embed iframe')
      return {
        kind: card ? 'card' : (frame ? 'frame' : 'other'),
        src: frame ? frame.getAttribute('src') : '',
        href: card ? card.getAttribute('href') : '',
        thumb: card ? (document.querySelector('.mrss-embed-thumb')?.getAttribute('src') || '') : '',
        hint: card ? (card.innerText || '').trim().slice(0, 80) : '',
      }
    })()`)

    /**
     * Re-load the player with the preview's `noref=1` flag, which is the page
     * reporting "I cannot send a Referer" — the same message the Host's real
     * player sends after its own probe.
     */
    const reportMissingReferer = () => evaluate(`(async () => {
      const frame = document.querySelector('.mrss-embed iframe')
      if (!frame) return false
      frame.src = frame.src.includes('?') ? frame.src + '&noref=1' : frame.src + '?noref=1'
      const deadline = performance.now() + 10_000
      while (performance.now() < deadline) {
        if (document.querySelector('.mrss-embed--link')) return true
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      return false
    })()`)

    await client.send('Page.navigate', { url: URL_BASE })
    const until = Date.now() + 20_000
    while (Date.now() < until) {
      if (await evaluate('document.querySelectorAll(".mrss-item").length > 3')) break
      await wait(150)
    }
    const opened = await evaluate(`(async () => {
      const rows = [...document.querySelectorAll('.mrss-item')]
      const row = rows.find((node) => /youtube/i.test(node.querySelector('.mrss-item-title')?.textContent || ''))
      if (!row) return false
      row.click()
      const deadline = performance.now() + 15_000
      while (performance.now() < deadline) {
        if (document.querySelector('.mrss-embed')) break
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      return Boolean(document.querySelector('.mrss-embed'))
    })()`)
    assert.equal(opened, true, 'the video article never rendered an embed')

    // 1. The player is the default: the report has not arrived yet.
    const beforeReport = await state()
    assert.equal(beforeReport.kind, 'frame', `the player should be shown first, saw ${JSON.stringify(beforeReport)}`)
    assert.match(beforeReport.src, /^\/rss-miniflux\/player\?id=/, `unexpected player src: ${beforeReport.src}`)

    // 2. The preview's player reports a Referer on load, and the player stays:
    //    the positive path is the default one.
    await wait(600)
    assert.equal((await state()).kind, 'frame', 'a positive report must keep the player')

    // 3. A negative report swaps in the card, which always works.
    assert.equal(await reportMissingReferer(), true, 'the player never reported a missing Referer')
    await wait(200)
    const afterReport = await state()
    assert.equal(afterReport.kind, 'card', `a missing Referer should fall back, saw ${JSON.stringify(afterReport)}`)
    assert.match(afterReport.href, /^https:\/\/www\.youtube\.com\/watch\?v=/, `the card should open the video, saw ${afterReport.href}`)
    assert.match(afterReport.thumb, /^https:\/\/i\.ytimg\.com\/vi\//, `the card should use a thumbnail, saw ${afterReport.thumb}`)
    assert.ok(afterReport.hint.length > 0, 'the card should explain itself')

    assert.deepEqual(client.problems, [], `page errors: ${client.problems.join(' | ')}`)
    console.log('[embed] before report:', JSON.stringify(beforeReport))
    console.log('[embed] after negative report:', JSON.stringify(afterReport))
    client.close()
  } finally {
    cleanup()
  }

  console.log('\nembed-fallback ok')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})

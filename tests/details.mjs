/**
 * Small, user-visible details that are easy to break silently.
 *
 *   1. The article title is a link that opens the original page in the browser,
 *      and it points at exactly the same address as the toolbar button.
 *   2. "Mark all as read" shows a spinner while it runs. It used to spin the
 *      checkmark glyph, which reads as a glitch rather than as work in
 *      progress.
 *
 *   node tests/details.mjs
 *   node tests/details.mjs --chromium /path/to/Chromium
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
const PORT = Number(arg('port', 5605))
const CHROME = arg('chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium')
const DEBUG_PORT = Number(arg('debugPort', 9335))
const URL_BASE = `http://127.0.0.1:${PORT}/`

if (!fs.existsSync(CHROME)) {
  console.log(`details: skipped, no Chromium at ${CHROME}`)
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mrss-details-'))
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
      if (await evaluate('document.querySelectorAll(".mrss-item").length > 3')) break
      await wait(150)
    }

    // Open the first article and wait for its body.
    await evaluate('document.querySelector(".mrss-item").click()')
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (await evaluate('Boolean(document.querySelector(".mrss-article-body .mrss-article-title, .mrss-article-title a") || document.querySelector(".mrss-article-body"))')) break
      await wait(120)
    }
    await wait(DELAY)

    // 1. The title is a link to the original page, and it agrees with the
    //    toolbar's "Open in browser" action.
    const title = await evaluate(`(() => {
      const anchor = document.querySelector('.mrss-article-title a')
      const toolbar = [...document.querySelectorAll('a[target="_blank"]')]
        .find((node) => node.getAttribute('aria-label') === anchor?.getAttribute('title'))
      if (!anchor) return { missing: true }
      const style = getComputedStyle(anchor)
      return {
        href: anchor.href,
        target: anchor.getAttribute('target'),
        rel: anchor.getAttribute('rel') || '',
        text: anchor.textContent.trim(),
        tooltip: anchor.getAttribute('title') || '',
        toolbarHref: toolbar ? toolbar.href : '',
        cursor: style.cursor,
        decoration: style.textDecorationLine,
        color: style.color,
      }
    })()`)

    assert.ok(!title.missing, 'the article title is not a link')
    assert.match(title.href, /^https?:\/\//, `title links to ${title.href}, expected an http(s) address`)
    assert.equal(title.target, '_blank', 'the title link must open in a new tab')
    assert.match(title.rel, /noreferrer/, 'the title link must not leak the referrer')
    assert.ok(title.text.length > 0, 'the title link has no text')
    assert.ok(title.tooltip.length > 0, 'the title link has no tooltip')
    assert.equal(title.href, title.toolbarHref, 'the title and the toolbar must point at the same page')
    assert.equal(title.cursor, 'pointer', 'the title should look clickable')
    assert.equal(title.decoration, 'none', 'the title should not be underlined at rest')

    // 2. Mark all as read: spinner while it works, checkmark when it is done.
    const markAll = await evaluate(`(async () => {
      window.confirm = () => true
      const button = document.querySelector('.mrss-markall')
      if (!button) return { missing: true }
      button.click()
      await new Promise((resolve) => setTimeout(resolve, 120))
      const busy = {
        spinner: Boolean(button.querySelector('.mrss-spinner')),
        icon: Boolean(button.querySelector('svg')),
        disabled: button.disabled,
      }
      const until = Date.now() + 15_000
      while (Date.now() < until) {
        if (!button.querySelector('.mrss-spinner')) break
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      const settled = {
        spinner: Boolean(button.querySelector('.mrss-spinner')),
        icon: Boolean(button.querySelector('svg')),
        disabled: button.disabled,
      }
      return { busy, settled }
    })()`)

    assert.ok(!markAll.missing, 'the Mark all as read button is missing')
    assert.equal(markAll.busy.spinner, true, 'Mark all as read must show a spinner while it runs')
    assert.equal(markAll.busy.icon, false, 'the checkmark glyph must not be rotated as a spinner')
    assert.equal(markAll.busy.disabled, true, 'the button must be disabled while the write is in flight')
    assert.equal(markAll.settled.spinner, false, 'the spinner must go away when the write settles')
    assert.equal(markAll.settled.icon, true, 'the checkmark must come back after the write')
    assert.equal(markAll.settled.disabled, false, 'the button must be usable again')

    assert.deepEqual(client.problems, [], `page errors: ${client.problems.join(' | ')}`)
    console.log('[details] title:', JSON.stringify({ href: title.href, target: title.target, tooltip: title.tooltip }))
    console.log('[details] mark-all:', JSON.stringify(markAll))
    client.close()
  } finally {
    cleanup()
  }

  console.log('\ndetails ok')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})

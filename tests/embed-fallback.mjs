/**
 * When the host strips the Referer, do not render a player that cannot work.
 *
 * YouTube's embed needs the Referer (error 153 otherwise). Our iframe sets its
 * own referrerpolicy, which covers a `no-referrer` document, but a shell that
 * drops the header deeper down defeats it — no HTML attribute helps there. The
 * panel therefore asks the Host once what it actually received and, when the
 * answer is "nothing", shows a thumbnail card that opens the video in the
 * browser instead of a black error box.
 *
 * The same page also renders the real player when a Referer does arrive, so the
 * two paths are checked against the same article.
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

/**
 * Answer `/echo-referer` from the URL, decided at document start: the restored
 * snapshot can reopen the last article before a test could install anything.
 * `?noref=1` models a host that strips the header.
 */
const PROBE = `(() => {
  try { sessionStorage.removeItem('rss-miniflux:referer:v1') } catch (error) { /* ignore */ }
  const missing = new URL(location.href).searchParams.get('noref') === '1'
  const original = window.fetch
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '')
    if (!url.includes('/rss-miniflux/api/echo-referer')) return original(input, init)
    return new Response(JSON.stringify({ referer: missing ? '' : 'http://127.0.0.1/' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
})()`

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
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })

    const evaluate = async (expression) => {
      const result = await client.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed')
      return result.result?.value
    }

    /** Reload with a fresh probe answer, open the video article, report the embed. */
    let caseIndex = 0
    const openVideoArticle = async ({ referer }) => {
      caseIndex += 1
      await client.send('Page.navigate', { url: `${URL_BASE}?noref=${referer ? 0 : 1}&case=${caseIndex}` })
      const until = Date.now() + 20_000
      while (Date.now() < until) {
        if (await evaluate('document.querySelectorAll(".mrss-item").length > 3')) break
        await wait(150)
      }
      await wait(150)
      const opened = await evaluate(`(async () => {
        const rows = [...document.querySelectorAll('.mrss-item')]
        const row = rows.find((node) => /youtube/i.test(node.querySelector('.mrss-item-title')?.textContent || ''))
        if (!row) return false
        row.click()
        const until = performance.now() + 15_000
        while (performance.now() < until) {
          if (document.querySelector('.mrss-embed')) break
          await new Promise((resolve) => setTimeout(resolve, 60))
        }
        return Boolean(document.querySelector('.mrss-embed'))
      })()`)
      assert.equal(opened, true, 'the video article never rendered an embed')
      // Give the probe a moment to resolve and React to swap, if it will.
      await wait(600)
      return evaluate(`(() => {
        const card = document.querySelector('.mrss-embed')
        const link = document.querySelector('.mrss-embed--link')
        const frame = document.querySelector('.mrss-embed iframe')
        const thumb = document.querySelector('.mrss-embed-thumb')
        return {
          kind: link ? 'card' : (frame ? 'frame' : 'other'),
          href: link ? link.getAttribute('href') : (frame ? frame.getAttribute('src') : ''),
          thumb: thumb ? thumb.getAttribute('src') : '',
          hint: card ? (card.innerText || '').trim().slice(0, 80) : '',
        }
      })()`)
    }

    const withReferer = await openVideoArticle({ referer: true })
    assert.equal(withReferer.kind, 'frame', `a Referer should keep the real player, saw ${JSON.stringify(withReferer)}`)
    assert.match(withReferer.href, /youtube-nocookie\.com\/embed\//)

    const withoutReferer = await openVideoArticle({ referer: false })
    assert.equal(withoutReferer.kind, 'card', `a missing Referer should fall back to a card, saw ${JSON.stringify(withoutReferer)}`)
    assert.match(withoutReferer.href, /^https:\/\/www\.youtube\.com\/watch\?v=/, `the card should open the video, saw ${withoutReferer.href}`)
    assert.match(withoutReferer.thumb, /^https:\/\/i\.ytimg\.com\/vi\//, `the card should use a thumbnail, saw ${withoutReferer.thumb}`)
    assert.ok(withoutReferer.hint.length > 0, 'the card should explain itself')

    assert.deepEqual(client.problems, [], `page errors: ${client.problems.join(' | ')}`)
    console.log('[embed] with referer:', JSON.stringify(withReferer))
    console.log('[embed] without referer:', JSON.stringify(withoutReferer))
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

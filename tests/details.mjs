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
/** Fake latency for the bulk write, shorter than `--delay` on purpose. */
const MANAGE_DELAY = Number(arg('manageDelay', 300))
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

    // A bulk write takes seconds on a real Miniflux; the preview answers at
    // once. Slow just this route down so the busy state is observable, and keep
    // it shorter than the entries delay so "stopped with the write" and
    // "stopped with the refresh" stay distinguishable.
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const original = window.fetch
        window.fetch = async (input, init) => {
          const url = String(typeof input === 'string' ? input : (input && input.url) || '')
          if (url.includes('/rss-miniflux/api/manage')) {
            await new Promise((resolve) => setTimeout(resolve, ${MANAGE_DELAY}))
          }
          return original(input, init)
        }
      })()`,
    })

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

    // 2. Mark all as read: the button spins while the write runs and stops as
    //    soon as it lands — not after the refresh it triggers. The success toast
    //    used to appear with the icon still turning.
    const markAll = await evaluate(`(async () => {
      window.confirm = () => true
      const button = document.querySelector('.mrss-markall')
      if (!button) return { missing: true }
      const started = performance.now()
      button.click()
      await new Promise((resolve) => setTimeout(resolve, 120))
      const during = {
        spinner: Boolean(button.querySelector('.mrss-spinner')),
        icon: Boolean(button.querySelector('svg')),
        disabled: button.disabled,
      }
      const goneMs = await new Promise((resolve) => {
        const tick = () => {
          if (!button.querySelector('.mrss-spinner')) return resolve(Math.round(performance.now() - started))
          if (performance.now() - started > 15_000) return resolve(-1)
          setTimeout(tick, 20)
        }
        tick()
      })
      const after = {
        spinner: Boolean(button.querySelector('.mrss-spinner')),
        icon: Boolean(button.querySelector('svg')),
        disabled: button.disabled,
        rows: document.querySelectorAll('.mrss-item').length,
      }
      await new Promise((resolve) => setTimeout(resolve, ${DELAY} + 900))
      return {
        during,
        goneMs,
        after,
        settled: { disabled: button.disabled, spinner: Boolean(button.querySelector('.mrss-spinner')) },
      }
    })()`)

    assert.ok(!markAll.missing, 'the Mark all as read button is missing')
    assert.equal(markAll.during.spinner, true, 'Mark all as read must show a spinner while the write runs')
    assert.equal(markAll.during.icon, false, 'the checkmark glyph must not be rotated as a spinner')
    assert.equal(markAll.during.disabled, true, 'the button must be disabled while the write is in flight')
    assert.ok(
      markAll.goneMs >= MANAGE_DELAY - 40 && markAll.goneMs < MANAGE_DELAY + (DELAY * 0.6),
      `the spinner stopped after ${markAll.goneMs}ms; the write takes ~${MANAGE_DELAY}ms and the refresh ~${DELAY * 2}ms`,
    )
    assert.equal(markAll.after.spinner, false, 'the spinner must be gone once the write is done')
    assert.equal(markAll.after.rows, 0, 'the unread list should be empty right after a successful mark-all')
    assert.equal(markAll.settled.disabled, false, 'the button must be usable again')

    // 3. The YouTube embed carries its own referrer policy. Without it a host
    //    that sends `Referrer-Policy: no-referrer` makes the player answer
    //    "Video player configuration error — Error 153", because it cannot see
    //    the embedding origin.
    //    The sample rows differ between data sets, so open the video one by its
    //    own title instead of assuming it is first.
    const embed = await evaluate(`(async () => {
      const rows = [...document.querySelectorAll('.mrss-item')]
      const row = rows.find((node) => /youtube/i.test(node.querySelector('.mrss-item-title')?.textContent || ''))
      if (!row) return { missing: true, reason: 'no youtube sample row' }
      row.click()
      const until = performance.now() + 15_000
      while (performance.now() < until) {
        if (document.querySelector('.mrss-embed iframe')) break
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      const frame = document.querySelector('.mrss-embed iframe')
      if (!frame) return { missing: true, reason: 'no embed rendered' }
      return {
        src: frame.getAttribute('src'),
        referrerPolicy: frame.getAttribute('referrerpolicy'),
        sandbox: frame.getAttribute('sandbox') || '',
        allowFullScreen: frame.hasAttribute('allowfullscreen'),
      }
    })()`)

    assert.ok(!embed.missing, `the preview should render a YouTube embed (${embed.reason || ''})`)
    // The panel embeds the Host's own player document, not YouTube directly:
    // that page carries the referrer policy the player needs.
    assert.match(embed.src, /^\/rss-miniflux\/player\?id=/, `unexpected embed src: ${embed.src}`)
    assert.equal(
      embed.referrerPolicy,
      'strict-origin-when-cross-origin',
      'the embed must send its origin even when the host document is no-referrer (error 153)',
    )
    assert.match(embed.sandbox, /allow-scripts/, 'the player needs scripts')
    assert.match(embed.sandbox, /allow-same-origin/, 'without allow-same-origin the player renders a black frame')
    assert.equal(embed.allowFullScreen, true, 'the player must be able to go fullscreen')

    // 4. A fetched original page keeps its `<figure><img width height>`: the
    //    attributes must supply the aspect ratio, not the used size. 9to5Google's
    //    1440x810 hero used to render 655x810 (squashed) because only the width
    //    was clamped.
    const figure = await evaluate(`(async () => {
      const body = document.querySelector('.mrss-article-body')
      const holder = document.createElement('div')
      holder.innerHTML = '<figure><img width="1440" height="810" alt="" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221440%22 height=%22810%22%3E%3Crect width=%22100%25%22 height=%22100%25%22 fill=%22%231a73e8%22/%3E%3C/svg%3E"></figure>'
      body.appendChild(holder)
      const img = holder.querySelector('img')
      await new Promise((resolve) => {
        if (img.complete && img.naturalWidth > 0) return resolve()
        img.addEventListener('load', resolve, { once: true })
        img.addEventListener('error', resolve, { once: true })
      })
      const rect = img.getBoundingClientRect()
      const result = {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        bodyWidth: Math.round(body.getBoundingClientRect().width),
        cssHeight: getComputedStyle(img).height,
        cssWidth: getComputedStyle(img).width,
      }
      holder.remove()
      return result
    })()`)

    assert.ok(figure.naturalWidth > 0, 'the probe image did not load')
    assert.ok(figure.width < figure.naturalWidth, 'the probe image should have been clamped by the column')
    const rendered = figure.width / figure.height
    const intrinsic = figure.naturalWidth / figure.naturalHeight
    assert.ok(
      Math.abs(rendered - intrinsic) < 0.03,
      `the image is squashed: rendered ${figure.width}x${figure.height} (ratio ${rendered.toFixed(3)}) for an intrinsic ratio of ${intrinsic.toFixed(3)}`,
    )
    assert.ok(figure.height < figure.bodyWidth, 'the image is taller than the column')

    assert.deepEqual(client.problems, [], `page errors: ${client.problems.join(' | ')}`)
    console.log('[details] title:', JSON.stringify({ href: title.href, target: title.target, tooltip: title.tooltip }))
    console.log('[details] mark-all:', JSON.stringify({ during: markAll.during, goneMs: markAll.goneMs, after: markAll.after }))
    console.log('[details] embed:', JSON.stringify({ src: embed.src.slice(0, 48), referrerPolicy: embed.referrerPolicy }))
    console.log('[details] figure:', JSON.stringify(figure))
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

/**
 * Body images appear sharp, once.
 *
 * A streaming image is painted by the browser in passes: the reader watches a
 * blurred frame sharpen, and (because the sanitizer keeps width/height but the
 * reading CSS does not use them for layout) the text below can jump when the
 * intrinsic size arrives. The panel now decorates every body image: the box is
 * reserved from the width/height attributes, the element stays invisible until
 * `load` + `decode`, then fades in once.
 *
 * The test pauses the preview's figure request, so the pending state is real
 * rather than a race, then lets it through and checks the reveal.
 *
 *   node tests/reader-images.mjs
 *   node tests/reader-images.mjs --chromium /path/to/Chromium
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

const PORT = Number(arg('port', 5614))
const CHROME = arg('chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium')
const DEBUG_PORT = Number(arg('debugPort', 9348))
const URL_BASE = `http://127.0.0.1:${PORT}/`
const PHOTO = '*mock-photo*'
/** 1440x900 in preview/data.mjs; the figure may bleed to the text column + 2*pad. */
const RATIO = 1440 / 900

if (!fs.existsSync(CHROME)) {
  console.log(`reader-images: skipped, no Chromium at ${CHROME}`)
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
  const paused = []
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
    if (message.method === 'Fetch.requestPaused') paused.push(message.params)
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
    paused,
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
  window.__photo = () => document.querySelector('.mrss-article-body figure img')
  /** Every decorated image with the placeholder that covers it, if any. */
  window.__imageSlots = () => [...document.querySelectorAll('.mrss-article-body img')]
    .filter((img) => img.dataset.mrssImage)
    .map((img) => {
      const box = img.getBoundingClientRect()
      const slot = img.parentElement?.querySelector('.mrss-imgslot')
      const slotBox = slot ? slot.getBoundingClientRect() : null
      return {
        state: img.dataset.mrssImage,
        figure: Boolean(img.closest('figure')),
        imgBox: {
          left: Math.round(box.left), top: Math.round(box.top),
          width: Math.round(box.width), height: Math.round(box.height),
        },
        slot: slotBox
          ? {
            left: Math.round(slotBox.left), top: Math.round(slotBox.top),
            width: Math.round(slotBox.width), height: Math.round(slotBox.height),
          }
          : null,
      }
    })
  window.__photoState = () => {
    const img = window.__photo()
    if (!img) return null
    const box = img.getBoundingClientRect()
    const style = getComputedStyle(img)
    const slot = img.parentElement?.querySelector('.mrss-imgslot') || null
    const slotBox = slot ? slot.getBoundingClientRect() : null
    return {
      state: img.getAttribute('data-mrss-image') || '',
      opacity: style.opacity,
      animation: style.animationName,
      width: Math.round(box.width),
      height: Math.round(box.height),
      ratio: box.height > 0 ? box.width / box.height : 0,
      inlineWidth: img.style.width,
      inlineRatio: img.style.aspectRatio,
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      slot: slotBox
        ? {
          left: Math.round(slotBox.left), top: Math.round(slotBox.top),
          width: Math.round(slotBox.width), height: Math.round(slotBox.height),
        }
        : null,
      imgBox: {
        left: Math.round(box.left), top: Math.round(box.top),
        width: Math.round(box.width), height: Math.round(box.height),
      },
    }
  }
})()`

async function run() {
  const server = spawn(process.execPath, [path.join(root, 'preview/server.mjs'), '--port', String(PORT), '--delay', '300'], {
    stdio: 'ignore',
  })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mrss-img-'))
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
    await client.send('Fetch.enable', { patterns: [{ urlPattern: PHOTO }] })

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
    await wait(300)

    await evaluate('document.querySelectorAll(".mrss-item")[0].click()')
    await evaluate('window.__until(() => document.querySelector(".mrss-article-body figure img"))')
    // The image is held by Fetch, so this is the real pending state.
    await evaluate(`window.__until(() => window.__photoState()?.state === 'pending')`)
    // The article settle-in is still running right after the click; measure once
    // it is done so the boxes are compared in their final position.
    await wait(320)
    const pending = await evaluate('window.__photoState()')
    assert.equal(pending.state, 'pending', 'the image is not waiting for its bitmap')
    assert.equal(pending.opacity, '0', 'a pending image is visible')
    assert.ok(pending.width > 200, `the pending image has no reserved width (${pending.width}px)`)
    assert.ok(Math.abs(pending.ratio - RATIO) < 0.02, `reserved ratio ${pending.ratio.toFixed(3)} is not ${RATIO.toFixed(3)}`)
    assert.ok(pending.inlineWidth, 'the reserved width is not inline')
    assert.ok(pending.inlineRatio, 'the reserved ratio is not inline')
    assert.ok(pending.slot, 'the reserved box has no loading placeholder')
    // Every pending body image carries a placeholder that covers its box —
    // the centred paragraph image and the one inside the figure alike.
    const slots = await evaluate('window.__imageSlots()')
    const pendingSlots = slots.filter((image) => image.state === 'pending')
    assert.equal(pendingSlots.length, 2, `expected two pending images, saw ${pendingSlots.length}`)
    assert.ok(slots.some((image) => image.figure), 'the figure image is not decorated')
    assert.ok(slots.some((image) => !image.figure), 'the paragraph image is not decorated')
    for (const image of pendingSlots) {
      assert.ok(image.slot, `a pending ${image.figure ? 'figure' : 'paragraph'} image has no placeholder`)
      for (const edge of ['left', 'top', 'width', 'height']) {
        assert.ok(
          Math.abs(image.slot[edge] - image.imgBox[edge]) <= 2,
          `the placeholder does not cover the ${image.figure ? 'figure' : 'paragraph'} image (${edge}: ${image.slot[edge]} vs ${image.imgBox[edge]})`,
        )
      }
    }
    const article = await evaluate(`(() => {
      const el = document.querySelector('.mrss-article')
      return { animation: getComputedStyle(el).animationName, opacity: getComputedStyle(el).opacity }
    })()`)
    assert.equal(article.animation, 'mrss-article-in', 'the article has no entry animation')

    assert.ok(client.paused.length > 0, 'the figure request was never paused')
    for (const request of client.paused) {
      await client.send('Fetch.continueRequest', { requestId: request.requestId })
    }
    await client.send('Fetch.disable')

    await evaluate(`window.__until(() => window.__photoState()?.state === 'ready')`)
    await wait(400) // let the 240ms fade finish
    const ready = await evaluate('window.__photoState()')
    assert.equal(ready.state, 'ready', 'the image never became ready')
    assert.equal(ready.opacity, '1', 'the ready image is still transparent')
    assert.equal(ready.inlineWidth, '', 'the reserved width was not released')
    assert.equal(ready.inlineRatio, '', 'the reserved ratio was not released')
    assert.ok(ready.naturalWidth > 0, 'the image has no bitmap')
    assert.ok(
      Math.abs(ready.width - pending.width) <= 2,
      `the image changed width after loading (${pending.width} -> ${ready.width})`,
    )
    assert.ok(Math.abs(ready.height - pending.height) <= 2, `the image changed height (${pending.height} -> ${ready.height})`)
    assert.equal(ready.animation, 'mrss-image-in', 'the reveal is not the fade-in')
    assert.equal(ready.slot, null, 'the loading placeholder was not removed')
    const slotsAfter = await evaluate('window.__imageSlots()')
    assert.ok(slotsAfter.length >= 2, 'the second body image is not decorated')
    assert.ok(slotsAfter.every((image) => image.slot === null), 'a loading placeholder was left behind')

    assert.deepEqual(client.problems, [], `page errors: ${client.problems.join(' | ')}`)

    console.log('[reader-images] pending:', JSON.stringify(pending))
    console.log('[reader-images] ready:  ', JSON.stringify(ready))
    client.close()
  } finally {
    cleanup()
  }

  console.log('\nreader-images ok')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

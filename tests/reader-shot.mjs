#!/usr/bin/env node
/**
 * Reader screenshots for the preview shell.
 *
 * Opens the panel, clicks the first list row and captures the reading column in
 * the requested theme / surface / width. Used to eyeball typography, media
 * bleed, the code header and the footnote popover without a Harness session.
 *
 *   node tests/reader-shot.mjs --out preview/shots/ringo --theme light
 *   node tests/reader-shot.mjs --out preview/shots/ringo-dark --theme dark --surface paper
 *   node tests/reader-shot.mjs --note --width 1180
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
const flag = (name) => process.argv.includes(`--${name}`)

const THEME = arg('theme', 'light')
const LOCALE = arg('locale', 'zh')
const SURFACE = arg('surface', 'default')
const WIDTH = Number(arg('width', 1280))
const OUT = arg('out', '')
const PORT = Number(arg('port', 5591))
const DEBUG_PORT = Number(arg('debugPort', 9341))
const CHROME = arg('chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium')

if (!fs.existsSync(CHROME)) {
  console.log(`reader-shot: skipped, no Chromium at ${CHROME}`)
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
  const problems = []
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
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails
      problems.push(details?.exception?.description || details?.text || 'exception')
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      problems.push(message.params.args.map((item) => item.value ?? item.description ?? '').join(' '))
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
    close() { socket.close() },
  }
}

const server = spawn(process.execPath, [path.join(root, 'preview/server.mjs'), '--port', String(PORT)], { stdio: 'ignore' })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mrss-shot-'))
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
  await waitForHttp(`http://127.0.0.1:${PORT}/`)
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
  const page = targets.find((target) => target.type === 'page')
  assert.ok(page, 'no page target in Chromium')
  const client = await connect(page.webSocketDebuggerUrl)
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: 900, deviceScaleFactor: 2, mobile: false,
  })

  const evaluate = async (expression) => {
    const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed')
    return result.result?.value
  }

  const shoot = async (name, clip) => {
    const params = { format: 'png', captureBeyondViewport: false }
    if (clip) params.clip = { ...clip, scale: 1 }
    const { data } = await client.send('Page.captureScreenshot', params)
    const target = path.join(OUT, `${name}.png`)
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(target, Buffer.from(data, 'base64'))
    console.log(`shot ${target}`)
  }

  const query = new URLSearchParams({ theme: THEME })
  await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?${query}` })
  await wait(700)
  await evaluate(`localStorage.setItem('rss-miniflux:prefs', ${JSON.stringify(JSON.stringify({ surface: SURFACE, locale: LOCALE }))})`)
  await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?${query}` })
  await wait(900)

  // Open the requested row (or the first one), then scroll to the top.
  const rowFilter = arg('row', '')
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.mrss-item')]
    const row = ${JSON.stringify(rowFilter)}
      ? rows.find((node) => (node.textContent || '').includes(${JSON.stringify(rowFilter)}))
      : rows[0]
    if (!row) return 'no rows'
    row.click()
    return 'clicked'
  })()`)
  await wait(900)
  await evaluate(`(() => {
    const pane = document.querySelector('.mrss-article-scroll')
    if (pane) pane.scrollTop = 0
    return Boolean(pane)
  })()`)
  await wait(250)
  await shoot('reader-top')

  // Mid-article: the figure and the code block.
  await evaluate(`(() => {
    const pane = document.querySelector('.mrss-article-scroll')
    const figure = document.querySelector('.mrss-article figure')
    if (pane && figure) pane.scrollTop = figure.offsetTop - 120
    return true
  })()`)
  await wait(350)
  await shoot('reader-figure')

  if (flag('settings')) {
    await evaluate(`(() => {
      const account = document.querySelector('.mrss-switch-account')
      if (account) account.click()
      return Boolean(account)
    })()`)
    await wait(300)
    await evaluate(`(() => {
      const item = [...document.querySelectorAll('.mrss-menu button, .mrss-menu [role="menuitem"], [role="menuitem"]')]
        .find((node) => /设置|Settings/.test(node.textContent || ''))
      if (item) item.click()
      return item ? item.textContent : document.body.innerText.slice(0, 200)
    })()`)
    await wait(500)
    await evaluate(`(() => {
      const tab = [...document.querySelectorAll('button')]
        .find((node) => /外观|Appearance/.test(node.textContent || ''))
      if (tab) tab.click()
      return Boolean(tab)
    })()`)
    await wait(400)
    const manage = await evaluate(`(() => {
      const node = document.querySelector('.mrss-manage')
      const side = document.querySelector('.mrss-side')
      return {
        manageBg: node ? getComputedStyle(node).backgroundColor : null,
        manageZ: node ? getComputedStyle(node).zIndex : null,
        sideBg: side ? getComputedStyle(side).backgroundColor : null,
      }
    })()`)
    console.log('overlay:', JSON.stringify(manage))
    await shoot('settings-appearance')
  }

  if (flag('note')) {
    await evaluate(`(() => {
      const marker = document.querySelector('.mrss-article [data-mrss-fn]')
      if (marker) marker.click()
      return Boolean(marker)
    })()`)
    await wait(400)
    await shoot('reader-footnote')
    const open = await evaluate(`Boolean(document.querySelector('.mrss-fn-pop'))`)
    console.log('footnote popover open:', open)
    assert.ok(open, 'footnote popover did not open')
    // Esc closes the note, not the article behind it.
    for (const type of ['keyDown', 'keyUp']) {
      await client.send('Input.dispatchKeyEvent', {
        type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
      })
    }
    await wait(200)
    const afterEsc = await evaluate(`({
      pop: Boolean(document.querySelector('.mrss-fn-pop')),
      article: Boolean(document.querySelector('.mrss-article')),
    })`)
    console.log('after Esc:', JSON.stringify(afterEsc))
    assert.equal(afterEsc.pop, false, 'Esc did not close the footnote')
    assert.equal(afterEsc.article, true, 'Esc closed the whole article instead of the footnote')
  }

  // Dateline: the same button must swap between relative and absolute time.
  const dateline = await evaluate(`(async () => {
    const button = document.querySelector('.mrss-meta-date')
    if (!button) return null
    const relative = button.textContent
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 120))
    const absolute = document.querySelector('.mrss-meta-date')?.textContent || ''
    document.querySelector('.mrss-meta-date')?.click()
    await new Promise((resolve) => setTimeout(resolve, 120))
    const again = document.querySelector('.mrss-meta-date')?.textContent || ''
    return { relative, absolute, again }
  })()`)
  console.log('dateline:', JSON.stringify(dateline))
  assert.ok(dateline && dateline.absolute !== dateline.relative, 'dateline does not switch to the absolute date')
  assert.equal(dateline.again, dateline.relative, 'dateline does not switch back')

  // Report the measurements the layout work is about.
  const rects = await evaluate(`(() => {
    const box = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }
    }
    return {
      pane: box(document.querySelector('.mrss-article-scroll')),
      article: box(document.querySelector('.mrss-article')),
      body: box(document.querySelector('.mrss-article-body')),
      figure: box(document.querySelector('.mrss-article-body figure')),
      img: box(document.querySelector('.mrss-article-body figure img')),
      paragraph: box(document.querySelector('.mrss-article-body p')),
      paragraphColor: (() => {
        const p = document.querySelector('.mrss-article-body p')
        return p ? getComputedStyle(p).color : ''
      })(),
      bodyBg: (() => {
        const a = document.querySelector('.mrss-article')
        return a ? getComputedStyle(a).backgroundColor : ''
      })(),
      rootVars: (() => {
        const root = document.querySelector('.mrss-root')
        if (!root) return null
        const css = getComputedStyle(root)
        return {
          bg: css.getPropertyValue('--dsw-alias-bg-base').trim(),
          layer1: css.getPropertyValue('--dsw-alias-bg-layer-1').trim(),
          link: css.getPropertyValue('--mrss-link').trim(),
        }
      })(),
      sideBg: (() => {
        const side = document.querySelector('.mrss-side')
        return side ? getComputedStyle(side).backgroundColor : ''
      })(),
      listBg: (() => {
        const col = document.querySelector('.mrss-col')
        return col ? getComputedStyle(col).backgroundColor : ''
      })(),
    }
  })()`)
  console.log(JSON.stringify(rects, null, 2))
  const metrics = await evaluate(`(() => {
    const article = document.querySelector('.mrss-article')
    const img = document.querySelector('.mrss-article figure img')
    const pre = document.querySelector('.mrss-code pre')
    const pop = document.querySelector('.mrss-fn-pop')
    return {
      surface: document.querySelector('.mrss-root')?.getAttribute('data-mrss-surface'),
      articleWidth: article?.clientWidth || 0,
      padInline: article ? getComputedStyle(article).paddingInlineStart : '',
      figureWidth: img ? img.clientWidth : 0,
      codeHead: Boolean(document.querySelector('.mrss-code-head')),
      codeLang: document.querySelector('.mrss-code-lang')?.textContent || '',
      meta: document.querySelector('.mrss-article-meta')?.innerText || '',
      popover: pop ? { width: pop.clientWidth, height: pop.clientHeight } : null,
      fontSize: article ? getComputedStyle(article).fontSize : '',
    }
  })()`)
  console.log(JSON.stringify(metrics, null, 2))
  if (client.problems.length > 0) {
    console.log('console problems:', client.problems.slice(0, 5))
  }
  assert.equal(client.problems.length, 0, 'console errors while opening the reader')
} finally {
  cleanup()
}

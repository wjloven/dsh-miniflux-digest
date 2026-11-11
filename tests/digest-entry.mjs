/**
 * The empty article page keeps its text and gets one AI digest entry. Clicking
 * it does not open a panel chat: it asks the Host for a draft and starts a new
 * DSH session through uiWorkspace, so the reader lands in the native composer.
 *
 *   node tests/digest-entry.mjs
 *   node tests/digest-entry.mjs --chromium /path/to/Chromium
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

const DELAY = Number(arg('delay', 120))
const PORT = Number(arg('port', 5620))
const CHROME = arg('chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium')
const DEBUG_PORT = Number(arg('debugPort', 9354))
const URL_BASE = `http://127.0.0.1:${PORT}/`

if (!fs.existsSync(CHROME)) {
  console.log(`digest-entry: skipped, no Chromium at ${CHROME}`)
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
  window.__entry = () => ({
    picked: (document.querySelector('.mrss-void > span')?.textContent || '').trim(),
    label: (document.querySelector('.mrss-ai-entry')?.textContent || '').trim(),
    disabled: Boolean(document.querySelector('.mrss-ai-entry')?.disabled),
    toast: (document.querySelector('.mrss-toast')?.textContent || '').trim(),
    view: Boolean(document.querySelector('.mrss-digest-view')),
    title: (document.querySelector('.mrss-digest-title')?.textContent || '').trim(),
    native: Boolean(document.querySelector('.fake-native[data-slot="rss-miniflux.digest"]')),
    actions: [...document.querySelectorAll('.mrss-digest-actions button')].map((button) => button.getAttribute('aria-label')),
    digestCalls: window.__digestCalls,
    digestBodies: (window.__digestBodies || []).slice(),
    drafts: window.__drafts.slice(),
    greeting: (document.querySelector('.mrss-digest-greeting')?.textContent || '').trim(),
    scopeLine: (document.querySelector('.mrss-digest-sub')?.textContent || '').trim(),
    chips: [...document.querySelectorAll('.mrss-chip')].map((chip) => chip.getAttribute('data-chip')),
    whaleHeader: Boolean(document.querySelector('.mrss-digest-title .mrss-whale')),
    whaleEntry: Boolean(document.querySelector('.mrss-ai-entry .mrss-whale')),
    voidIcon: Boolean(document.querySelector('.mrss-void-icon')),
    art: Boolean(document.querySelector('.mrss-digest-art')),
    clearRow: Boolean(document.querySelector('.mrss-chips-clear-row')),
    selectedChips: [...document.querySelectorAll('.mrss-chip[data-on="true"]')].map((chip) => chip.getAttribute('data-chip')),
    sessions: window.__sessionCreates,
  })
})()`

async function run() {
  const server = spawn(process.execPath, [path.join(root, 'preview/server.mjs'), '--port', String(PORT), '--delay', String(DELAY)], {
    stdio: 'ignore',
  })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mrss-digest-'))
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
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const original = window.fetch
        window.__digestCalls = 0
        window.__digestBodies = []
        window.__failDigest = false
        window.fetch = async (input, init) => {
          const url = String(typeof input === 'string' ? input : (input && input.url) || '')
          if (url.includes('/rss-miniflux/api/digest')) {
            window.__digestCalls += 1
            try { window.__digestBodies.push(JSON.parse(init?.body || '{}')) } catch { /* not JSON */ }
            if (window.__failDigest) {
              return new Response(JSON.stringify({ error: { code: 'no_entries', message: 'No entries in this timeline.' } }), {
                status: 400,
                headers: { 'content-type': 'application/json' },
              })
            }
          }
          return original(input, init)
        }
      })()`,
    })

    const evaluate = async (expression) => {
      const result = await client.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed')
      return result.result?.value
    }

    await client.send('Page.navigate', { url: URL_BASE })
    await evaluate(HELPERS)
    await evaluate('window.__until(() => document.querySelector(".mrss-ai-entry"))')
    const empty = await evaluate('window.__entry()')
    assert.equal(empty.picked, 'Pick an entry to start reading', 'the original empty-page copy changed')
    assert.match(empty.label, /Continue with AI digest/i, 'the digest entry is missing')
    assert.equal(empty.whaleEntry, true, 'the entry lost its DeepSeek whale mark')
    assert.equal(empty.voidIcon, true, 'the empty page lost its larger reading icon')
    assert.equal(empty.view, false, 'the digest opened by itself')
    assert.equal(empty.digestCalls, 0, 'the empty page asked for a digest by itself')
    assert.equal(empty.drafts.length, 0, 'the empty page prepared a draft by itself')

    // The entry switches this column into the native digest view with an empty
    // composer and a prompt builder above it.
    await evaluate('document.querySelector(".mrss-ai-entry").click()')
    await evaluate('window.__until(() => document.querySelector(".mrss-digest-view") && document.querySelector(".mrss-chip"))')
    const opened = await evaluate('window.__entry()')
    assert.equal(opened.digestCalls, 0, 'the entry should not fetch a draft any more')
    assert.equal(opened.title, 'AI digest', 'the digest header lost its title')
    assert.equal(opened.native, true, 'the native conversation slot was not rendered')
    assert.deepEqual(opened.actions, ['New chat', 'Close'], `unexpected header actions: ${opened.actions}`)
    assert.equal(opened.drafts.length, 0, 'opening the digest must leave the composer empty')
    assert.deepEqual(opened.chips, ['summary', 'slow', 'threads', 'changes', 'feeds', 'starred', 'unread', 'all'])
    assert.match(opened.greeting, /What should we dig into\?/, 'the prompt builder lost its greeting')
    assert.match(opened.scopeLine, /All articles · \d+ unread/, 'the greeting lost the timeline scope line')
    assert.equal(opened.whaleHeader, true, 'the header lost its DeepSeek whale mark')
    assert.equal(opened.art, true, 'the greeting lost its illustration')
    assert.equal(await evaluate('document.querySelector(".mrss-chips-label") === null'), true, 'the old Ask about label is still there')
    assert.equal(await evaluate('Boolean(document.querySelector(".mrss-digest-empty .mrss-chip"))'), true,
      'the prompt builder must sit in the blank area, not the composer')
    assert.equal(opened.disabled, false, 'the entry stayed disabled after opening')

    // A chip fills the whole prompt (context + tool + request + close).
    await evaluate('document.querySelector(\'.mrss-chip[data-chip="summary"]\').click()')
    await evaluate('window.__until(() => window.__drafts.length === 1)')
    let current = await evaluate('window.__entry()')
    assert.deepEqual(current.selectedChips, ['summary'])
    assert.equal(current.clearRow, true, 'Clear should move to its own centred row')
    assert.match(current.drafts[0], /This is my Miniflux timeline “All articles”/)
    assert.match(current.drafts[0], /miniflux_timeline/)
    assert.match(current.drafts[0], /Summarize what came in/)
    assert.equal(current.drafts[0].split('This is my Miniflux timeline').length - 1, 1, 'the context line repeated')

    // Free combination: another chip is added to the same prompt.
    await evaluate('document.querySelector(\'.mrss-chip[data-chip="slow"]\').click()')
    await evaluate('window.__until(() => window.__drafts.length === 2)')
    current = await evaluate('window.__entry()')
    assert.deepEqual(current.selectedChips, ['summary', 'slow'])
    assert.match(current.drafts[1], /Summarize what came in/)
    assert.match(current.drafts[1], /Pick 3 entries worth a slow read/)
    assert.equal(current.drafts[1].split('This is my Miniflux timeline').length - 1, 1, 'the context line repeated')

    // Clicking a selected chip removes it and rebuilds the prompt.
    await evaluate('document.querySelector(\'.mrss-chip[data-chip="summary"]\').click()')
    await evaluate('window.__until(() => window.__drafts.length === 3)')
    current = await evaluate('window.__entry()')
    assert.deepEqual(current.selectedChips, ['slow'])
    assert.doesNotMatch(current.drafts[2], /Summarize what came in/)
    assert.match(current.drafts[2], /Pick 3 entries worth a slow read/)

    // Clear empties the composer.
    await evaluate('document.querySelector(".mrss-chips-clear").click()')
    await evaluate('window.__until(() => window.__drafts.length === 4)')
    assert.equal((await evaluate('window.__entry()')).drafts[3], '', 'clear did not empty the composer')

    // A file link jumps to the digest session's own interface, where the
    // right sidebar can mount it; the panel overlay is only a fallback.
    await evaluate(`window.__scope.sidebarRight.openResource("dsh-resource://file/session/session-1/.dsh/miniflux-digest/all-unread.md")`)
    await evaluate('window.__until(() => window.__sessionOpened === "session-1" && window.__fallbackOpen === "dsh-resource://file/session/session-1/.dsh/miniflux-digest/all-unread.md")')
    assert.equal(await evaluate('document.querySelector(".mrss-file-view") === null'), true,
      'the digest file should jump to the session, not open the panel overlay')

    // An external link jumps to the session and opens in its browser tab, never
    // in the system browser.
    await evaluate('document.querySelector(".fake-native a[href]").click()')
    await evaluate('window.__until(() => window.__tabOpened?.params?.url === "https://example.com/post")')
    assert.equal(await evaluate('window.__sessionOpened'), 'session-1', 'the external link skipped the session jump')

    // A file from another session still goes to the shell.
    await evaluate(`window.__scope.sidebarRight.openResource("dsh-resource://file/session/other-session/x.md")`)
    assert.equal(await evaluate('window.__fallbackOpen'), 'dsh-resource://file/session/other-session/x.md',
      'a file from another session must fall through')

    // New chat keeps the view, resets the chips and leaves the composer empty.
    await evaluate('document.querySelector(\'.mrss-digest-actions button[aria-label="New chat"]\').click()')
    await evaluate('window.__until(() => window.__sessionCreates === 2 && document.querySelector(".mrss-chip:not([data-on])"))')
    const renewed = await evaluate('window.__entry()')
    assert.equal(renewed.view, true, 'new chat closed the digest')
    assert.deepEqual(renewed.selectedChips, [], 'new chat kept the selected chips')

    // Close returns to the empty page.
    await evaluate('document.querySelector(\'.mrss-digest-actions button[aria-label="Close"]\').click()')
    await evaluate('window.__until(() => document.querySelector(".mrss-ai-entry"))')
    assert.equal((await evaluate('window.__entry()')).view, false, 'close did not return to the empty page')

    // A different list drafts that list's context when a chip is clicked.
    await evaluate(`(async () => {
      [...document.querySelectorAll('.mrss-cat-tab')][1].click()
      await window.__until(() => document.querySelector('.mrss-ai-entry') && document.querySelectorAll('.mrss-item').length > 0)
      document.querySelector('.mrss-ai-entry').click()
      await window.__until(() => document.querySelector('.mrss-chip'))
      document.querySelector('.mrss-chip[data-chip="summary"]').click()
      await window.__until(() => window.__drafts.length === 5)
    })()`)
    const second = await evaluate('window.__entry()')
    assert.equal(second.view, true)
    assert.match(second.drafts[4], /This is my Miniflux timeline “/, 'the second prompt has no timeline context')

    // Returning to the same scope after a reload resumes the digest session
    // instead of creating a new one.
    await client.send('Page.reload')
    await evaluate(HELPERS)
    await evaluate('window.__until(() => document.querySelector(".mrss-ai-entry"))')
    await evaluate(`(async () => {
      [...document.querySelectorAll('.mrss-cat-tab')][1].click()
      await window.__until(() => document.querySelector('.mrss-digest-view'))
    })()`)
    const resumed = await evaluate('window.__entry()')
    assert.equal(resumed.view, true, 'returning to the scope did not resume the digest')
    assert.equal(await evaluate('window.__sessionCreates'), 0, 'resume must not create a new session')
    assert.deepEqual(resumed.selectedChips, ['summary'], 'resume must restore the selected chips')

    assert.deepEqual(client.problems, [], `page errors: ${client.problems.join(' | ')}`)

    console.log('[digest] empty:', JSON.stringify({ picked: empty.picked, entry: empty.label }))
    console.log('[digest] view:', JSON.stringify({ title: opened.title, actions: opened.actions, chips: opened.chips.length }))
    console.log('[digest] prompt:', JSON.stringify({ head: second.drafts[4].split('\n')[0] }))
    client.close()
  } finally {
    cleanup()
  }

  console.log('\ndigest-entry ok')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

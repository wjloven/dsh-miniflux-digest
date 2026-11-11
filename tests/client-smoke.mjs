/**
 * Load the Client half outside a browser and check that it registers the two
 * slots. This catches module-scope and apply-time errors; it does not render.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let loaded = null
const window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}
const localStorage = {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
  setItem(key, value) { this.store.set(key, String(value)) },
}

const react = {
  createElement: () => ({}),
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}

const sandbox = {
  window,
  localStorage,
  document: { activeElement: null, visibilityState: 'visible' },
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: async () => ({ ok: false, status: 500, json: async () => null }),
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  console,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

assert.ok(loaded, 'module did not call __ModuleLoader__.load')
assert.match(
  source,
  /\[data-sidebar-collapsed\] \.mrss-root\{padding-top:var\(--dsh-frame-top-clearance,48px\)\}/,
  'collapsed-shell safe area must stay in the stylesheet',
)
assert.equal(loaded.id, 'rss-miniflux-deepread', 'module id must equal the package name')

const module = loaded.factory((name) => {
  if (name === 'react') return react
  if (name === 'react-dom') return { createPortal: (node) => node }
  assert.fail(`unexpected require(${name})`)
})

assert.ok(module && typeof module.apply === 'function', 'factory must return apply')

const registrations = []
const ctx = {
  get: () => undefined,
  slots: {
    inject: (key, callback) => {
      callback()
      return () => {}
    },
    register: (position, component) => {
      registrations.push({ position, component })
      return () => {}
    },
  },
}

module.apply(ctx)

assert.equal(registrations.length, 3, `expected 3 registrations, got ${registrations.length}`)
const sidebar = registrations.find((entry) => entry.position.name === 'sidebar.panellist')
const main = registrations.find((entry) => entry.position.name === 'main')
assert.ok(sidebar, 'sidebar launcher was not registered')
assert.equal(sidebar.position.id, 'rss-miniflux')
assert.equal(typeof sidebar.component, 'function')
assert.ok(main, 'main panel was not registered')
assert.equal(main.position.key, 'rss-miniflux')
assert.deepEqual(Object.keys(main.position.children || {}), ['rss-miniflux.digest'],
  'the main panel must declare the native digest child slot')
const digest = registrations.find((entry) => entry.position.name === 'rss-miniflux.digest')
assert.ok(digest, 'the native digest conversation slot was not registered')
assert.equal(typeof digest.component, 'function')

console.log('client smoke ok:', registrations.map((entry) => entry.position.name).join(', '))

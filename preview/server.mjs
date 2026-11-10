#!/usr/bin/env node
/**
 * Local preview for the Client half: serves the panel against mock data so the
 * layout and interactions can be checked in a browser without Harness.
 *
 *   node preview/server.mjs            # http://127.0.0.1:5577
 *   node preview/server.mjs --port 5588
 *
 * Mock data lives in data.mjs; nothing here talks to Miniflux or Harness.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { article, catalog, categories, efforts, entries, models } from './data.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const portArg = process.argv.indexOf('--port')
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 5577
// Artificial latency, in milliseconds, on every mock API answer. Used to see
// what the panel paints before the network catches up.
const delayArg = process.argv.indexOf('--delay')
const DELAY = delayArg > 0 ? Math.max(0, Number(process.argv[delayArg + 1]) || 0) : 0
const LATE_ROUTES = ['/bootstrap', '/entries', '/entry', '/feed-stats', '/icons']

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

const PALETTE = ['#4d93f8', '#ec6a5e', '#f2b44b', '#5bbd8b', '#8b6bd6', '#38a8c9', '#d6709b']

let accounts = [
  { id: 'default', baseUrl: 'https://rss.example.com', username: 'demo' },
  { id: 'work', baseUrl: 'https://reader.example.net', username: 'work' },
]
let activeAccountId = 'default'
let lastBaseUrl = ''
const accountSnapshot = () => ({
  accounts: accounts.map((account) => ({ ...account, active: account.id === activeAccountId })),
  active: activeAccountId,
})

function iconSvg(feedId) {
  const feed = catalog.find((item) => item.id === feedId)
  const color = PALETTE[Number(feedId) % PALETTE.length]
  const initial = (feed?.title || '?').trim().slice(0, 1).toUpperCase()
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${color}"/><text x="16" y="22" font-family="-apple-system,Helvetica,sans-serif" font-size="17" font-weight="600" fill="#fff" text-anchor="middle">${initial.replace(/[<>&]/g, '')}</text></svg>`
}

function listPage(url) {
  const filter = url.searchParams.get('filter') || 'unread'
  const category = url.searchParams.get('category') || ''
  const feed = url.searchParams.get('feed') || ''
  const search = (url.searchParams.get('search') || '').trim().toLowerCase()
  const sort = url.searchParams.get('sort') === 'oldest' ? 'oldest' : 'newest'
  const order = url.searchParams.get('order') === 'created' ? 'created' : 'published'
  const limit = Math.min(Number(url.searchParams.get('limit')) || 60, 100)
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0)
  let list = entries.slice()
  if (filter === 'unread') list = list.filter((entry) => entry.status === 'unread')
  if (filter === 'starred') list = list.filter((entry) => entry.starred)
  if (category) list = list.filter((entry) => String(entry.categoryId) === category)
  if (feed) list = list.filter((entry) => String(entry.feedId) === feed)
  if (search) list = list.filter((entry) => `${entry.title} ${entry.excerpt}`.toLowerCase().includes(search))
  const field = order === 'created' ? 'id' : 'publishedAt'
  list.sort((a, b) => {
    const left = field === 'id' ? a.id : Date.parse(a.publishedAt)
    const right = field === 'id' ? b.id : Date.parse(b.publishedAt)
    return sort === 'newest' ? right - left : left - right
  })
  return { demo: false, total: list.length, entries: list.slice(offset, offset + limit) }
}

// Wide landscape used by the article figure: wide enough that the reading
// column has to scale it down, which is what the media-bleed rule is for.
function photoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900" viewBox="0 0 1440 900">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dfeaf2"/><stop offset="1" stop-color="#f4efe6"/></linearGradient>
  <linearGradient id="far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fa6b8"/><stop offset="1" stop-color="#b9c7ce"/></linearGradient>
  <linearGradient id="near" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4c6472"/><stop offset="1" stop-color="#6f8794"/></linearGradient></defs>
  <rect width="1440" height="900" fill="url(#sky)"/>
  <circle cx="1090" cy="250" r="86" fill="#f7e6c8" opacity=".75"/>
  <path d="M0 470 L210 300 L360 430 L520 330 L700 470 L860 360 L1040 470 L1200 390 L1440 470 L1440 900 L0 900 Z" fill="url(#far)" opacity=".8"/>
  <path d="M0 620 L240 470 L430 600 L640 500 L820 620 L1010 520 L1200 620 L1440 540 L1440 900 L0 900 Z" fill="url(#near)" opacity=".9"/>
  <g fill="#ffffff" opacity=".35"><ellipse cx="330" cy="560" rx="260" ry="42"/><ellipse cx="900" cy="620" rx="320" ry="46"/></g>
</svg>`
}

function coverSvg(index) {
  const palette = [['#eaf3ff', '#4d93f8'], ['#fff1e6', '#ec6a5e'], ['#eafaf1', '#5bbd8b'], ['#f4ecff', '#8b6bd6']]
  const [bg, ink] = palette[Number(index) % palette.length]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320" viewBox="0 0 640 320"><rect width="640" height="320" fill="${bg}"/><circle cx="${90 + (Number(index) % 5) * 30}" cy="96" r="54" fill="${ink}" opacity=".18"/><rect x="40" y="200" width="${180 + (Number(index) % 4) * 60}" height="14" rx="7" fill="${ink}" opacity=".35"/><rect x="40" y="230" width="${120 + (Number(index) % 3) * 50}" height="14" rx="7" fill="${ink}" opacity=".22"/></svg>`
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  const write = () => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(payload)
  }
  if (res.__late && DELAY > 0) setTimeout(write, DELAY)
  else write()
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const route = url.pathname

  if (route.startsWith('/rss-miniflux/api/')) {
    const api = route.slice('/rss-miniflux/api'.length)
    res.__late = DELAY > 0 && LATE_ROUTES.includes(api)
    if (api === '/bootstrap') {
      const unread = catalog.reduce((sum, feed) => sum + feed.unread, 0)
      const active = accounts.find((account) => account.id === activeAccountId) || accounts[0] || null
      return send(res, 200, {
        status: {
          configured: Boolean(active), source: active ? 'account' : 'none', baseUrl: active?.baseUrl || '',
          lastBaseUrl: active ? '' : lastBaseUrl,
          demo: !active, demoAvailable: true, version: '1.6.0', credentialStore: true,
          accountId: active?.id || '', username: active?.username || '', user: active?.username || '',
        },
        categories,
        feeds: catalog,
        counters: { unreads: Object.fromEntries(catalog.map((feed) => [feed.id, feed.unread])), unread: unread },
      })
    }
    if (api === '/entries') return send(res, 200, listPage(url))
    if (api === '/entry') {
      const payload = article(url.searchParams.get('id'), `http://127.0.0.1:${PORT}`)
      return payload ? send(res, 200, payload) : send(res, 404, { error: { code: 'not_found', message: 'no such entry' } })
    }
    if (api === '/models') return send(res, 200, models)
    if (api === '/efforts') return send(res, 200, efforts)
    if (api === '/dashboard') return send(res, 200, { digest: null })
    if (api === '/icons') {
      const ids = String(url.searchParams.get('ids') || '').split(',').map((id) => id.trim()).filter(Boolean)
      const icons = {}
      for (const id of ids) {
        icons[id] = `data:image/svg+xml;base64,${Buffer.from(iconSvg(Number(id) || 0)).toString('base64')}`
      }
      return send(res, 200, { icons, oversize: [] })
    }
    if (api === '/icon') {
      const id = Number(url.searchParams.get('id')) || 0
      return send(res, 200, iconSvg(id), 'image/svg+xml')
    }
    if (api === '/digest') {
      return send(res, 200, {
        categories: categories.map((category) => ({ id: category.id, title: category.title, unread: category.totalUnread, feeds: 0 })),
        total: entries.length,
        window: { seconds: 86400, unread: entries.length, byCategory: {}, byFeed: {} },
        crossSource: [], genre: { opinion: 2, news: 5, mixed: 1, unknown: 0, opinionRatio: 0.25 },
        recommendations: [], stats: { sources: feedsCount(), unread: entries.length, readingMinutes: 120 },
      })
    }
    if (api === '/accounts') {
      return send(res, 200, accountSnapshot())
    }
    if (api === '/accounts/action') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const payload = JSON.parse(body || '{}')
        if (payload.action === 'switch' && accounts.some((account) => account.id === payload.id)) {
          activeAccountId = payload.id
        }
        if (payload.action === 'add') {
          const baseUrl = String(payload.baseUrl || 'https://example.com')
          const username = String(payload.username || '').trim()
            || (payload.apiToken ? 'token-user' : 'basic-user')
          const id = `a${accounts.length + 1}${Date.now().toString(36).slice(-3)}`
          accounts = accounts.filter((account) => account.baseUrl !== baseUrl).concat({ id, baseUrl, username })
          activeAccountId = id
        }
        if (payload.action === 'logout') {
          const target = accounts.find((account) => account.id === (payload.id || activeAccountId)) || accounts[0] || null
          if (target) {
            lastBaseUrl = target.baseUrl
            accounts = accounts.filter((account) => account.id !== target.id)
          }
          if (!accounts.some((account) => account.id === activeAccountId)) activeAccountId = accounts[0]?.id || ''
        }
        if (payload.action === 'remove') {
          accounts = accounts.filter((account) => account.id !== payload.id)
          if (!accounts.some((account) => account.id === activeAccountId)) activeAccountId = accounts[0]?.id || ''
        }
        send(res, 200, { ok: true, ...accountSnapshot() })
      })
      return undefined
    }
    if (api === '/feeds') {
      return send(res, 200, {
        configured: true,
        categories: categories.map((category) => ({ id: category.id, title: category.title, feedCount: category.feedCount, totalUnread: category.totalUnread })),
        feeds: catalog.map((feed) => ({
          id: feed.id, title: feed.title, feedUrl: `https://example.com/${feed.id}.xml`,
          siteUrl: 'https://example.com', categoryId: feed.categoryId, categoryTitle: feed.categoryTitle,
          unread: feed.unread, disabled: false, lastError: '',
        })),
      })
    }
    if (api === '/discover') {
      const target = url.searchParams.get('url') || 'https://example.com'
      const base = target.replace(/\/+$/, '')
      const isFeed = /\.(xml|rss|atom|json)$/i.test(base)
      let host = 'example.com'
      try { host = new URL(base).host } catch { /* keep the default */ }
      const feeds = isFeed
        ? [{ url: base, title: `${host} feed`, type: /atom/i.test(base) ? 'atom' : 'rss' }]
        : [
          { url: `${base}/feed.xml`, title: `${host} — RSS`, type: 'rss' },
          { url: `${base}/atom.xml`, title: `${host} — Atom`, type: 'atom' },
          { url: `${base}/jsonfeed.json`, title: `${host} — JSON Feed`, type: 'json' },
        ]
      return send(res, 200, { url: target, feeds })
    }
    if (api === '/feed-stats') {
      const counts = {}
      for (const entry of entries) {
        if (!entry.starred) continue
        counts[entry.feedId] = (counts[entry.feedId] || 0) + 1
      }
      return send(res, 200, {
        starred: counts,
        total: Object.values(counts).reduce((sum, value) => sum + value, 0),
        scanned: entries.filter((entry) => entry.starred).length,
        capped: false,
      })
    }
    if (api === '/opml') return send(res, 200, '<opml version="2.0"></opml>', 'text/xml')
    if (['/action', '/manage', '/settings', '/settings/action'].includes(api)) {
      return send(res, 200, { ok: true })
    }
    return send(res, 404, { error: { code: 'not_found', message: `no mock for ${api}` } })
  }

  if (route === '/mock-cover.svg') {
    return send(res, 200, coverSvg(url.searchParams.get('i') || 0), 'image/svg+xml')
  }
  if (route === '/mock-photo.svg') {
    return send(res, 200, photoSvg(), 'image/svg+xml')
  }

  const files = {
    '/': [path.join(here, 'index.html'), 'text/html; charset=utf-8'],
    '/client.js': [path.join(root, 'client.js'), 'text/javascript; charset=utf-8'],
    '/tokens.css': [path.join(here, 'tokens.css'), 'text/css; charset=utf-8'],
    '/tokens-dark.css': [path.join(here, 'tokens-dark.css'), 'text/css; charset=utf-8'],
    '/preview.css': [path.join(here, 'preview.css'), 'text/css; charset=utf-8'],
  }
  const entry = files[route]
  if (entry && fs.existsSync(entry[0])) return send(res, 200, fs.readFileSync(entry[0]), entry[1])
  if (route.startsWith('/vendor/')) {
    const file = path.join(here, 'vendor', path.basename(route))
    if (fs.existsSync(file)) return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'text/plain')
  }
  send(res, 404, 'not found', 'text/plain')
})

function feedsCount() {
  return new Set(entries.map((entry) => entry.feedId)).size
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:${PORT}/`)
})

/**
 * Miniflux digest · Host half.
 *
 * Owns the Miniflux connection (base URL + API token), exposes a small JSON API
 * for the reader panel over the Harness web server, and gives the agent tools
 * that read the same data: unread overview, digest, article text, search, and
 * read-state actions.
 */

import { MinifluxClient, MinifluxError, createApiKeyWithPassword, normalizeBaseUrl } from './lib/miniflux.js'
import { buildDigest, normalizeEntry } from './lib/digest.js'
import { BRIEFING_SYSTEM, buildBriefingInput, parseBriefing } from './lib/briefing.js'
import { demoEntries } from './lib/demo.js'
import {
  estimateMinutes,
  extractEmbeds,
  markdownFromHtml,
  sanitizeArticleHtml,
  textFromHtml,
} from './lib/html.js'
import { tweetFromSyndication } from './lib/tweet.js'
import { createCache } from './lib/cache.js'

const VERSION = '1.6.8'
const PREFIX = '/rss-miniflux/api'
const CREDENTIAL_KEY = 'rss-miniflux'
const META_TTL = 60_000
const LIST_TTL = 20_000
const DIGEST_TTL = 45_000
// A cached catalog older than META_TTL but younger than this is served while it
// refreshes in the background; past it the request waits for Miniflux.
const META_STALE_TTL = 15 * 60_000
// One page of entries is served from memory while it is fresh, and while it is
// merely plausible it is served *and* refreshed in the background. Miniflux
// takes 1.8-5.7 s for a page on a large account, so an expired page that blocks
// is what "the list is slow" actually means.
const ENTRIES_TTL = 60_000
const ENTRIES_STALE_TTL = 30 * 60_000
// An article body does not change once published, and opening the same one
// again (back/forward, next/previous, the prefetch the panel does on hover) is
// the common case. Keep them for longer and let a write patch them.
const ARTICLE_TTL = 10 * 60_000
const ARTICLE_STALE_TTL = 2 * 60 * 60_000
// Bound on cached article payloads; a 40 KB body times a few hundred is still
// small, this is only here so a session that reads all day cannot grow forever.
const ARTICLE_CACHE_MAX = 240

export const inject = ['webServer', 'tools']

export function apply(ctx, config = {}) {
  const cache = createCache()
  const runtime = {
    settings: null,
    settingsAt: 0,
    ready: false,
    migrationError: '',
    accountIndex: null,
    indexPromise: null,
    // Last server we were signed into, kept after logout to prefill the form.
    lastBaseUrl: '',
  }

  // -------------------------------------------------------------------------
  // Settings: config > credential record > process environment
  // -------------------------------------------------------------------------

  // Credential keys follow the store's `<scope>/<id>` grammar. Colons were a
  // mistake: they collided in the YAML record map and once produced duplicate
  // keys, which stops the whole Host from booting.
  const ACCOUNTS_KEY = 'rss-miniflux/accounts'
  const ACCOUNT_PREFIX = 'rss-miniflux/acct-'

  /** One exclusive chain for every credential write this plugin performs. */
  let credentialQueue = Promise.resolve()
  function queueCredentialWrite(task) {
    const run = credentialQueue.then(task, task)
    credentialQueue = run.then(() => undefined, () => undefined)
    return run
  }

  async function credentialRecord(key = CREDENTIAL_KEY) {
    const credentials = ctx.get('credentials')
    if (!credentials) return null
    try {
      return await credentials.readRecord(key)
    } catch {
      return null
    }
  }

  /** Saved Miniflux connections: a JSON index plus one token record per account. */
  async function readAccountIndex() {
    const record = await credentialRecord(ACCOUNTS_KEY)
    if (!record || typeof record.key !== 'string') return null
    try {
      const list = JSON.parse(record.key)
      if (!Array.isArray(list)) return null
      return {
        list: list.filter((account) => account && typeof account.id === 'string' && account.id),
        active: typeof record.env?.active === 'string' ? record.env.active : '',
      }
    } catch {
      return null
    }
  }

  async function writeAccountIndex(list, active) {
    const credentials = ctx.get('credentials')
    if (!credentials) {
      throw new HttpError(501, 'no_credential_store', 'This profile has no credential service, so accounts cannot be stored')
    }
    await queueCredentialWrite(() => credentials.modifyRecord(ACCOUNTS_KEY, async () => ({
      kind: 'api-key',
      key: JSON.stringify(list),
      env: active ? { active } : {},
    })))
    runtime.accountIndex = { list, active }
  }

  async function readAccount(id) {
    const record = await credentialRecord(`${ACCOUNT_PREFIX}${id}`)
    if (!record || typeof record.key !== 'string' || !record.key) return null
    return {
      token: record.key,
      baseUrl: normalizeBaseUrl(record.env?.MINIFLUX_BASE_URL || ''),
      username: record.env?.MINIFLUX_USERNAME || '',
    }
  }

  async function writeAccount(id, { baseUrl, token, username }) {
    const credentials = ctx.get('credentials')
    if (!credentials) {
      throw new HttpError(501, 'no_credential_store', 'This profile has no credential service, so accounts cannot be stored')
    }
    const env = { MINIFLUX_BASE_URL: baseUrl }
    if (username) env.MINIFLUX_USERNAME = username
    await queueCredentialWrite(() => credentials.modifyRecord(`${ACCOUNT_PREFIX}${id}`, async () => ({
      kind: 'api-key',
      key: token,
      env,
    })))
  }

  /**
   * The legacy single-account record is folded into the account index exactly
   * once per process: concurrent readers share one in-flight promise, so a page
   * load cannot start several migrations at the same time.
   */
  async function ensureAccountIndex() {
    if (runtime.accountIndex) return runtime.accountIndex
    if (!runtime.indexPromise) {
      runtime.indexPromise = migrateOrReadIndex()
        .then((index) => {
          runtime.accountIndex = index
          return index
        })
        .finally(() => {
          runtime.indexPromise = null
        })
    }
    return runtime.indexPromise
  }

  async function migrateOrReadIndex() {
    const existing = await readAccountIndex()
    if (existing) return existing
    const legacy = await credentialRecord(CREDENTIAL_KEY)
    if (!legacy || typeof legacy.key !== 'string' || !legacy.key) return { list: [], active: '' }
    const baseUrl = normalizeBaseUrl(legacy.env?.MINIFLUX_BASE_URL || '')
    if (!baseUrl) return { list: [], active: '' }
    const account = { id: 'default', baseUrl, username: legacy.env?.MINIFLUX_USERNAME || '' }
    try {
      await writeAccount('default', { baseUrl, token: legacy.key, username: account.username })
      await writeAccountIndex([account], 'default')
      // The legacy record is redundant once its token lives in an account.
      await credentialQueue.then(() => ctx.get('credentials')?.deleteRecord(CREDENTIAL_KEY).catch(() => {}))
      return { list: [account], active: 'default' }
    } catch (error) {
      runtime.migrationError = error?.message || String(error)
      return { list: [], active: '' }
    }
  }

  async function resolveSettings(force = false) {
    if (!force && runtime.settings && Date.now() - runtime.settingsAt < 5_000) return runtime.settings

    const configBase = typeof config.baseUrl === 'string' ? config.baseUrl : ''
    const configToken = typeof config.apiToken === 'string' ? config.apiToken : ''
    if (configBase || configToken) {
      const baseUrl = normalizeBaseUrl(configBase || process.env.MINIFLUX_BASE_URL || '')
      const token = String(configToken || process.env.MINIFLUX_API_TOKEN || '').trim()
      const settings = {
        baseUrl,
        token,
        configured: Boolean(baseUrl && token),
        source: 'config',
        accountId: '',
        username: '',
      }
      runtime.settings = settings
      runtime.settingsAt = Date.now()
      return settings
    }

    const index = await ensureAccountIndex()
    const active = index.list.find((account) => account.id === index.active) || index.list[0] || null
    if (active) {
      const stored = await readAccount(active.id)
      if (stored && stored.token && stored.baseUrl) {
        const settings = {
          baseUrl: stored.baseUrl,
          token: stored.token,
          configured: true,
          source: 'account',
          accountId: active.id,
          username: active.username || stored.username || '',
        }
        runtime.settings = settings
        runtime.settingsAt = Date.now()
        return settings
      }
    }

    const legacy = await credentialRecord(CREDENTIAL_KEY)
    const legacyEnv = legacy && legacy.kind === 'api-key' && legacy.env ? legacy.env : {}
    const baseUrl = normalizeBaseUrl(legacyEnv.MINIFLUX_BASE_URL || process.env.MINIFLUX_BASE_URL || '')
    const token = String((legacy && typeof legacy.key === 'string' ? legacy.key : '') || process.env.MINIFLUX_API_TOKEN || '').trim()
    const settings = {
      baseUrl,
      token,
      configured: Boolean(baseUrl && token),
      source: legacy ? 'credentials' : process.env.MINIFLUX_API_TOKEN ? 'environment' : 'none',
      accountId: '',
      username: legacyEnv.MINIFLUX_USERNAME || '',
    }
    runtime.settings = settings
    runtime.settingsAt = Date.now()
    return settings
  }

  async function miniflux() {
    const settings = await resolveSettings()
    return new MinifluxClient({
      baseUrl: settings.baseUrl,
      token: settings.token,
      timeoutMs: Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 15_000,
    })
  }

  const cacheRun = (key, ttl, fn) => cache.run(key, ttl, fn)
  /** `/v1/me` never changes within a session; a bulk read needs the id too. */
  const cachedMe = (client) => cacheRunSWR('me', 5 * 60_000, META_STALE_TTL, () => client.me())
  const cacheRunSWR = (key, ttl, staleTtl, fn) => cache.runSWR(key, ttl, staleTtl, fn)
  const invalidate = () => cache.clear()
  const expire = (keys) => cache.expire(keys)

  // -------------------------------------------------------------------------
  // Feed icons
  //
  // Miniflux answers /v1/feeds/<id>/icon in 300–500 ms on a real account, so a
  // 60-row list used to fire 60 slow requests and paint its icons over several
  // seconds. Icons are now cached here — seven days for a hit, one day for
  // "this feed has none", folded into one background refresh — and handed to
  // the panel in a single batch as data URLs. Nextflux gets the same effect
  // from its IndexedDB icon table (7 days for an icon, 1 for a miss).
  // -------------------------------------------------------------------------

  const ICON_TTL = 7 * 24 * 60 * 60_000
  const ICON_MISS_TTL = 24 * 60 * 60_000
  const ICON_BATCH_MAX = 200
  /** Upstream icon lookups in flight for one batch. */
  // Behind a proxy or VPN a dozen parallel TLS handshakes to one host is a
  // burst that can come back as dropped connections; six still fills a cold
  // icon batch quickly and each lookup is cached for days afterwards.
  const ICON_CONCURRENCY = 6
  /** Larger icons skip the batch and load through <img>, which the browser caches. */
  const ICON_DATA_MAX = 48 * 1024
  const ICON_STORE_MAX = 2000

  /** feed id → { at, type, bytes } | { at, none: true } */
  const iconStore = new Map()
  const iconPending = new Map()

  function iconCached(key) {
    const hit = iconStore.get(key)
    if (!hit) return null
    const ttl = hit.none ? ICON_MISS_TTL : ICON_TTL
    if (Date.now() - hit.at > ttl) {
      iconStore.delete(key)
      return null
    }
    return hit
  }

  function iconRemember(key, entry) {
    iconStore.set(key, entry)
    if (iconStore.size > ICON_STORE_MAX) {
      // Oldest first; a warmed icon is a cache entry, not state.
      const oldest = [...iconStore.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, ICON_STORE_MAX / 4)
      for (const [id] of oldest) iconStore.delete(id)
    }
    return entry
  }

  /** One upstream lookup per feed at a time, shared by batch and single reads. */
  async function iconLoad(feedId) {
    const key = String(feedId || '')
    if (!key) return { at: Date.now(), none: true }
    const cached = iconCached(key)
    if (cached) return cached
    if (iconPending.has(key)) return iconPending.get(key)
    const task = (async () => {
      const settings = await resolveSettings()
      if (!settings.configured) return iconRemember(key, { at: Date.now(), none: true })
      try {
        const client = await miniflux()
        const icon = await client.feedIcon(key)
        if (!icon || !icon.bytes || icon.bytes.length === 0) {
          return iconRemember(key, { at: Date.now(), none: true })
        }
        return iconRemember(key, { at: Date.now(), type: icon.type || 'image/png', bytes: icon.bytes })
      } catch {
        // A feed without an icon, or a scrape that failed: remember the miss
        // instead of asking Miniflux again on every render.
        return iconRemember(key, { at: Date.now(), none: true })
      }
    })().finally(() => { iconPending.delete(key) })
    iconPending.set(key, task)
    return task
  }

  async function iconDataUrl(feedId) {
    const entry = await iconLoad(feedId)
    if (!entry || entry.none || !entry.bytes) return ''
    return `data:${entry.type};base64,${Buffer.from(entry.bytes).toString('base64')}`
  }

  /**
   * The batch the panel asks for on first paint: `icons` maps feed id to a data
   * URL, `oversize` lists icons too large to inline (load those through /icon).
   * At most ICON_CONCURRENCY upstream lookups run at once, so a cold list of 60
   * rows does not open 60 sockets to Miniflux; everything after the first batch
   * is served from the store above.
   */
  async function iconBatch(requested) {
    const ids = [...new Set(requested)].filter(Boolean).slice(0, ICON_BATCH_MAX)
    const icons = {}
    const oversize = []
    const queue = [...ids]
    const entries = []
    const worker = async () => {
      while (queue.length > 0) {
        const id = queue.shift()
        entries.push([id, await iconLoad(id)])
      }
    }
    await Promise.all(Array.from({ length: Math.min(ICON_CONCURRENCY, queue.length) }, worker))
    for (const [id, entry] of entries) {
      if (!entry || entry.none || !entry.bytes) continue
      if (entry.bytes.length > ICON_DATA_MAX) {
        oversize.push(id)
        continue
      }
      icons[id] = `data:${entry.type};base64,${Buffer.from(entry.bytes).toString('base64')}`
    }
    return { icons, oversize }
  }

  // -------------------------------------------------------------------------
  // Data access shared by the UI routes and the agent tools
  // -------------------------------------------------------------------------

  function wantsDemo(requested) {
    return requested === true || requested === '1' || requested === 'true'
  }

  async function loadUnread({ limit = 200, demo = false } = {}) {
    if (demo) {
      const entries = demoEntries().map((entry) => normalizeEntry(entry, { demo: true }))
      return { entries, total: entries.length, demo: true }
    }
    const client = await miniflux()
    if (!client.configured) throw new MinifluxError('Miniflux URL and API token are not configured', { code: 'not_configured' })
    const page = await client.collectEntries({ status: 'unread', max: Math.min(Math.max(limit, 1), 400) })
    const entries = page.entries.map((entry) => normalizeEntry(entry))
    return { entries, total: page.total, demo: false }
  }

  async function loadInterests(client) {
    if (!client.configured) return { titles: [] }
    return cacheRun('interests', 10 * 60_000, async () => {
      const titles = []
      for (const status of ['read', 'unread']) {
        try {
          const page = await client.entries({ status, starred: true, limit: 25, order: 'published_at' })
          for (const entry of page?.entries || []) titles.push(String(entry.title || ''))
        } catch {
          // Starred lookups are an enhancement; a Miniflux instance may refuse them.
        }
      }
      return { titles }
    })
  }

  async function loadDigest({ demo = false, limit = 200, force = false } = {}) {
    const useDemo = demo || !(await resolveSettings()).configured
    const key = `digest:${useDemo ? 'demo' : 'live'}:${limit}`
    if (force) cache.delete(key)
    return cacheRun(key, DIGEST_TTL, async () => {
      const unread = await loadUnread({ limit, demo: useDemo })
      const client = await miniflux()
      const interests = useDemo ? { titles: [] } : await loadInterests(client)
      const digest = buildDigest(unread.entries, {
        demo: useDemo,
        source: useDemo ? 'demo' : 'miniflux',
        total: unread.total,
        interests: interests.titles,
      })
      return digest
    })
  }

  /**
   * X's embed card is intentionally not rendered, but its videos are missing
   * from most RSS feeds. Ask the public syndication endpoint for the tweet's
   * media (server-side: that endpoint only allows platform.twitter.com as an
   * origin) and cache it in memory for five minutes.
   */
  const TWEET_TTL = 5 * 60_000
  // A miss is usually a timeout, not "this tweet has no media". Retrying one
  // minute later is cheap now that this is off the article's critical path.
  const TWEET_MISS_TTL = 60_000
  const tweetCache = new Map()

  async function loadTweet(id) {
    const key = String(id)
    const hit = tweetCache.get(key)
    if (hit && Date.now() - hit.at < (hit.value ? TWEET_TTL : TWEET_MISS_TTL)) return hit.value
    let value = null
    try {
      const response = await fetch(
        `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(key)}&lang=en&token=x`,
        { signal: AbortSignal.timeout(3000), headers: { accept: 'application/json' } },
      )
      if (response.ok) value = tweetFromSyndication(await response.json())
    } catch {
      value = null
    }
    if (tweetCache.size > 200) tweetCache.clear()
    tweetCache.set(key, { at: Date.now(), value })
    return value
  }

  async function enrichEmbeds(embeds) {
    for (const embed of embeds) {
      if (embed.provider !== 'x') continue
      const tweet = await loadTweet(embed.id)
      if (tweet) embed.tweet = tweet
    }
  }

  async function loadArticle(id, { demo = false, fetchOriginal = false, enrich = false } = {}) {
    const useDemo = demo || !(await resolveSettings()).configured
    if (useDemo) {
      const entry = demoEntries().find((candidate) => Number(candidate.id) === Number(id))
      if (!entry) throw new HttpError(404, 'not_found', `Demo entry ${id} does not exist`)
      return articlePayload(entry)
    }
    const client = await miniflux()
    if (!client.configured) throw new MinifluxError('Miniflux URL and API token are not configured', { code: 'not_configured' })
    let entry = null
    if (fetchOriginal) {
      try {
        const fetched = await client.fetchContent(id)
        if (fetched && fetched.content) {
          entry = { ...(await client.getEntry(id)), content: fetched.content }
        }
      } catch {
        entry = null
      }
    }
    if (!entry || !entry.content) entry = await client.getEntry(id)
    if (!entry) throw new HttpError(404, 'not_found', `Entry ${id} does not exist`)
    const payload = articlePayload(entry)
    // Only the reader needs tweet media; the agent tool stays offline for X.
    if (enrich) await enrichEmbeds(payload.embeds)
    return payload
  }

  /**
   * `/entry` behind a stale-while-revalidate cache.
   *
   * Miniflux answers one entry in 0.7-1.5 s, with the occasional 5-15 s outlier,
   * and the panel asks again for the same id on back/forward, on p/n, and on the
   * hover prefetch. Parsing is not the cost (a 34 KB body sanitizes in ~3 ms), so
   * the only real fix is not asking twice.
   */
  async function loadArticleCached(id, { demo = false, fetchOriginal = false } = {}) {
    const useDemo = demo || !(await resolveSettings()).configured
    if (useDemo) return loadArticle(id, { demo: useDemo, fetchOriginal })
    const key = `article:${Number(id)}${fetchOriginal ? ':orig' : ''}`
    const payload = await cacheRunSWR(key, ARTICLE_TTL, ARTICLE_STALE_TTL, () =>
      loadArticle(id, { fetchOriginal }),
    )
    if (cache.size > ARTICLE_CACHE_MAX + 200) cache.expire(['article'])
    return payload
  }

  /**
   * A write only changes one row. Patch the pages that already hold it instead
   * of dropping every page: on this account a page costs seconds, and marking an
   * article read used to invalidate all of them (so the next category switch was
   * a cold fetch again).
   */
  function patchEntryRows(ids, changes) {
    const targets = new Set((Array.isArray(ids) ? ids : [ids]).map((id) => Number(id)).filter(Boolean))
    if (targets.size === 0) return
    cache.patch(['entries'], (page, key) => {
      if (!page || !Array.isArray(page.entries)) return undefined
      // Only an unread-only page loses a row that is no longer unread. `All`
      // and `Starred` keep it and just show the new state.
      const dropWhenRead = changes.status === 'read' && /filter=unread(?:&|$)/.test(key)
      let touched = false
      let removed = 0
      const entries = page.entries
        .map((entry) => {
          if (!targets.has(Number(entry.id))) return entry
          touched = true
          if (dropWhenRead && String(entry.status) === 'unread') {
            removed += 1
            return null
          }
          return { ...entry, ...changes }
        })
        .filter(Boolean)
      if (!touched) return undefined
      return {
        ...page,
        entries,
        total: removed > 0 ? Math.max(0, Number(page.total || 0) - removed) : page.total,
      }
    })
    // The open article carries the same status/starred fields in its header.
    for (const id of targets) {
      cache.patch([`article:${id}`], (payload) => {
        if (!payload || !payload.item) return undefined
        return { ...payload, item: { ...payload.item, ...changes } }
      })
    }
  }

  /**
   * Move one feed's unread count instead of dropping the counters cache.
   * Expiring it forced the next bootstrap to refetch counters; when that call
   * hiccuped the payload read as "0 unread everywhere" and the unread-filtered
   * sidebar came back empty.
   */
  function patchCounters(feedId, delta) {
    const id = Number(feedId)
    if (!id || !delta) return false
    const touched = cache.patch(['counters'], (value) => {
      if (!value || typeof value !== 'object') return undefined
      const unreads = { ...(value.unreads || {}) }
      const key = String(id)
      const current = Number(unreads[key]) || 0
      const next = Math.max(0, current + delta)
      if (next === current) return undefined
      unreads[key] = next
      const patched = { ...value, unreads }
      // Miniflux 2.x answers `{reads, unreads}` without a total; only move one
      // when the server actually reports it.
      if (typeof value.total === 'number') patched.total = Math.max(0, value.total + delta)
      return patched
    })
    return touched > 0
  }

  function articlePayload(raw) {
    const content = String(raw.content || '')
    const baseUrl = raw.url || ''
    const title = String(raw.title || '').trim()
    const { html, toc, notes } = sanitizeArticleHtml(content, baseUrl, { title })
    const text = textFromHtml(content)
    const minutes = Number(raw.reading_time) > 0 ? Number(raw.reading_time) : estimateMinutes(text)
    const feed = raw.feed || {}
    return {
      item: {
        id: Number(raw.id),
        title: String(raw.title || '(无标题)').trim(),
        url: String(raw.url || ''),
        author: String(raw.author || ''),
        publishedAt: String(raw.published_at || raw.created_at || new Date().toISOString()),
        readingMinutes: minutes,
        starred: Boolean(raw.starred),
        status: String(raw.status || 'unread'),
        feedId: Number(feed.id) || 0,
        feedTitle: String(feed.title || '未知订阅'),
        categoryTitle: String(feed.category?.title || '未分类'),
      },
      html,
      toc,
      // Footnote markers the sanitizer recognised; the reader opens their note
      // in a popover instead of scrolling to the end of the article.
      notes,
      // Provider players survive sanitization as metadata: the sanitizer drops
      // iframes, the client reframes YouTube / Bilibili / X from provider + id.
      embeds: extractEmbeds(content, baseUrl),
      markdown: markdownFromHtml(content, baseUrl),
      textLength: text.length,
      excerpt: text.slice(0, 220),
    }
  }

  async function modelCatalog() {
    return cacheRun('models', 5 * 60_000, async () => {
      const llm = ctx.get('llm')
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (!llm || typeof llm.stream !== 'function') {
        return { models: [], defaultId: '', error: 'Language model service is unavailable in this profile.' }
      }
      let providers = []
      try {
        providers = llm.listProviders() || []
      } catch {
        providers = []
      }
      const discovered = await Promise.all(providers.map(async (provider) => {
        try {
          const list = await Promise.race([
            llm.listModels(provider.id),
            new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 4_000)),
          ])
          return (list || []).map((model) => ({
            id: `${provider.id}::${model.id}`,
            provider: provider.id,
            model: model.id,
            label: model.name || model.id,
            providerLabel: provider.name || provider.id,
          }))
        } catch {
          return []
        }
      }))
      const models = discovered.flat()
      models.sort((a, b) => `${a.providerLabel} ${a.label}`.localeCompare(`${b.providerLabel} ${b.label}`))
      let defaultId = ''
      if (selection?.provider && selection?.model) {
        defaultId = `${selection.provider}::${selection.model}`
        if (!models.some((item) => item.id === defaultId)) {
          models.unshift({
            id: defaultId,
            provider: selection.provider,
            model: selection.model,
            label: selection.model,
            providerLabel: selection.provider,
          })
        }
      }
      if (!defaultId && models.length > 0) defaultId = models[0].id
      return {
        models,
        defaultId,
        error: models.length > 0 ? '' : 'No language model is available in this profile.',
      }
    })
  }

  /** Reasoning efforts a model actually advertises, resolved through its adapter. */
  async function modelEfforts(modelId) {
    const llm = ctx.get('llm')
    const value = String(modelId || '')
    if (!llm || typeof llm.resolveModelInfo !== 'function' || !value.includes('::')) {
      return { efforts: [], defaultId: '' }
    }
    const [provider, model] = value.split('::')
    return cacheRun(`efforts:${value}`, 5 * 60_000, async () => {
      try {
        const info = await llm.resolveModelInfo(provider, model)
        const efforts = (info?.reasoning?.efforts || []).map((effort) => ({
          id: String(effort.id),
          name: effort.name || String(effort.id),
          description: effort.description || '',
        }))
        return { efforts, defaultId: info?.reasoning?.defaultEffort ? String(info.reasoning.defaultEffort) : '' }
      } catch {
        return { efforts: [], defaultId: '' }
      }
    })
  }

  /**
   * One category in, a written briefing out. The model sees titles plus body
   * text only; the panel's statistics and article lists are not part of it.
   */
  async function generateBriefing(body = {}, signal) {
    const settings = await resolveSettings()
    const demo = wantsDemo(body.demo) || !settings.configured
    const limit = Math.min(Math.max(Number(body.limit) || 50, 5), 80)
    const categoryId = body.categoryId === undefined || body.categoryId === null || body.categoryId === ''
      ? ''
      : String(body.categoryId)

    let items = []
    if (demo) {
      const raw = demoEntries()
        .filter((entry) => !categoryId || String(entry.feed?.category?.id ?? '') === categoryId)
        .slice(0, limit)
      items = raw.map((entry) => ({ ...normalizeEntry(entry, { demo: true }), body: textFromHtml(entry.content) }))
    } else {
      const client = await miniflux()
      const page = await client.collectEntries({ status: 'unread', categoryId, max: limit })
      items = page.entries.map((entry) => ({ ...normalizeEntry(entry), body: textFromHtml(entry.content) }))
    }
    if (items.length === 0) {
      throw new HttpError(400, 'no_entries', 'No unread entries in this category.')
    }

    const categoryTitle = categoryId ? (items[0].categoryTitle || `Category ${categoryId}`) : 'All categories'
    const input = buildBriefingInput(items, { categoryTitle })

    const catalog = await modelCatalog()
    let provider = ''
    let model = ''
    const requested = String(body.model || '')
    if (requested.includes('::')) {
      const [requestedProvider, requestedModel] = requested.split('::')
      provider = requestedProvider
      model = requestedModel
    }
    if (!provider) {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      provider = selection?.provider || ''
      model = selection?.model || ''
    }
    if (!provider || !model) throw new HttpError(400, 'no_model', catalog.error || 'No language model is selected.')
    const known = catalog.models.find((entry) => entry.provider === provider && entry.model === model)
    const modelLabel = known?.label || model

    const effortInfo = await modelEfforts(`${provider}::${model}`)
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    let effort = String(body.effort || '')
    if (effort && !effortInfo.efforts.some((entry) => entry.id === effort)) effort = ''
    if (!effort && selection?.provider === provider && selection?.model === model && selection.reasoningEffort) {
      const preferred = String(selection.reasoningEffort)
      if (effortInfo.efforts.some((entry) => entry.id === preferred)) effort = preferred
    }
    if (!effort && effortInfo.defaultId) effort = effortInfo.defaultId
    const effortLabel = effortInfo.efforts.find((entry) => entry.id === effort)?.name || ''

    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') {
      throw new HttpError(501, 'no_llm', 'Language model service is unavailable in this profile.')
    }

    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), 180_000)
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
    const startedAt = Date.now()
    let reply = ''
    let finishKind = ''
    try {
      const stream = llm.stream({
        provider,
        model,
        system: BRIEFING_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: input.text }] }],
        maxTokens: 8_000,
        temperature: 0.3,
        ...(effort ? { reasoningEffort: effort } : {}),
        signal: combined,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') {
          reply += chunk.text
        } else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && reply === '') {
          reply = chunk.block.text
        } else if (chunk.type === 'finish') {
          finishKind = chunk.reason?.kind || ''
          if (chunk.reason?.kind === 'error') {
            throw new HttpError(502, 'model_failed', chunk.reason.failure?.message || 'The model call failed.')
          }
          if (chunk.reason?.kind === 'aborted') {
            throw new HttpError(499, 'aborted', 'Generation was cancelled.')
          }
          break
        }
      }
    } catch (error) {
      if (error instanceof HttpError) throw error
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new HttpError(504, 'timeout', 'The model call timed out or was cancelled.')
      }
      throw new HttpError(502, 'model_failed', error?.message || String(error))
    } finally {
      clearTimeout(timer)
    }
    if (!reply.trim()) {
      throw new HttpError(
        502,
        'empty_reply',
        finishKind === 'max-tokens'
          ? 'The model used its whole output budget before writing anything. Try a smaller category or a different model.'
          : 'The model returned no text. Try again or pick a different model.',
      )
    }
    if (finishKind === 'max-tokens') {
      ctx.logger?.warn?.('rss-miniflux: briefing hit the output token limit; the reply may be truncated')
    }

    const parsed = parseBriefing(reply)
    ctx.logger?.info?.(`rss-miniflux: briefing for ${categoryTitle} via ${provider}/${model} in ${Date.now() - startedAt}ms`)
    return {
      overview: parsed.overview,
      topics: parsed.topics,
      parsed: parsed.parsed,
      partial: parsed.partial,
      meta: {
        categoryId,
        categoryTitle,
        provider,
        model,
        modelLabel,
        effort,
        effortLabel,
        entries: items.length,
        included: input.included,
        chars: input.text.length,
        durationMs: Date.now() - startedAt,
        createdAt: new Date().toISOString(),
        demo,
        finish: finishKind,
      },
    }
  }

  /** Feeds and categories for the management view. */
  async function manageData() {
    const settings = await resolveSettings()
    if (!settings.configured) {
      const demo = demoCatalog()
      return {
        configured: false,
        feeds: demo.feeds.map((feed) => ({
          id: feed.id,
          title: feed.title,
          feedUrl: '',
          categoryId: feed.categoryId,
          categoryTitle: feed.categoryTitle,
          unread: feed.unread,
          disabled: false,
          error: '',
        })),
        categories: demo.categories,
      }
    }
    const client = await miniflux()
    const [feeds, categories, counters] = await Promise.all([
      client.feeds(),
      client.categories({ counts: true }),
      client.counters().catch(() => null),
    ])
    return {
      configured: true,
      feeds: (feeds || []).map((feed) => ({
        id: Number(feed.id),
        title: String(feed.title || ''),
        feedUrl: String(feed.feed_url || ''),
        siteUrl: String(feed.site_url || ''),
        categoryId: Number(feed.category?.id) || 0,
        categoryTitle: String(feed.category?.title || ''),
        unread: Number(counters?.unreads?.[String(feed.id)] ?? counters?.unreads?.[feed.id]) || 0,
        disabled: Boolean(feed.disabled),
        error: String(feed.parsing_error_message || ''),
        checkedAt: String(feed.checked_at || ''),
      })).sort((a, b) => b.unread - a.unread || a.title.localeCompare(b.title)),
      categories: (categories || []).map((category) => ({
        id: Number(category.id),
        title: String(category.title || ''),
        totalUnread: Number(category.total_unread) || 0,
        feedCount: Number(category.feed_count) || 0,
      })),
    }
  }

  async function handleManage(body = {}) {
    const action = String(body.action || '')
    const settings = await resolveSettings()
    if (!settings.configured) {
      throw new HttpError(400, 'not_configured', 'Connect Miniflux before changing subscriptions')
    }
    const client = await miniflux()
    switch (action) {
      case 'feed_add': {
        const feedUrl = String(body.url || '').trim()
        if (!/^https?:\/\//i.test(feedUrl)) throw new HttpError(400, 'bad_url', 'Feed URL must start with http:// or https://')
        const created = await client.createFeed({
          feedUrl,
          categoryId: body.categoryId || '',
          crawler: Boolean(body.crawler),
        })
        invalidate()
        return { ok: true, feedId: created?.feed_id ?? null }
      }
      case 'feed_update':
        await client.updateFeed(body.id, { title: body.title, categoryId: body.categoryId })
        invalidate()
        return { ok: true }
      case 'feed_delete':
        await client.deleteFeed(body.id)
        invalidate()
        return { ok: true }
      case 'feed_refresh':
        await client.refreshFeed(body.id)
        invalidate()
        return { ok: true }
      case 'feed_mark_read':
        await client.markFeedRead(body.id)
        expire(['counters', 'feed-stats', 'entries'])
        return { ok: true }
      case 'category_add': {
        const title = String(body.title || '').trim()
        if (!title) throw new HttpError(400, 'title_required', 'Category name is required')
        const created = await client.createCategory(title)
        invalidate()
        return { ok: true, category: created }
      }
      case 'category_update': {
        const title = String(body.title || '').trim()
        if (!title) throw new HttpError(400, 'title_required', 'Category name is required')
        await client.updateCategory(body.id, title)
        invalidate()
        return { ok: true }
      }
      case 'category_delete':
        await client.deleteCategory(body.id)
        invalidate()
        return { ok: true }
      case 'mark_all_read': {
        const scope = String(body.scope || 'feed')
        if (scope === 'feed') await client.markFeedRead(body.id)
        else if (scope === 'category') await client.markCategoryRead(body.id)
        else {
          const me = await cachedMe(client)
          if (!me?.id) throw new HttpError(502, 'no_user', 'Could not resolve the Miniflux user')
          await client.markUserRead(me.id)
        }
        // Marking read changes counts, not the subscription list. Dropping the
        // whole catalog made the panel wait for four upstream calls after a
        // write that is already finished — the "success but still spinning".
        expire(['counters', 'feed-stats', 'entries'])
        return { ok: true }
      }
      case 'import_opml': {
        const xml = String(body.xml || '').trim()
        if (!xml.startsWith('<')) throw new HttpError(400, 'bad_opml', 'That does not look like an OPML document')
        const result = await client.importOpml(xml)
        invalidate()
        return { ok: true, message: result?.message || 'Feeds imported' }
      }
      default:
        throw new HttpError(400, 'bad_action', `Unknown management action ${action}`)
    }
  }

  async function listEntries(params) {
    const demo = wantsDemo(params.get('demo')) || !(await resolveSettings()).configured
    const filter = params.get('filter') || 'unread'
    const limit = Math.min(Math.max(Number(params.get('limit')) || 60, 1), 100)
    const offset = Math.max(Number(params.get('offset')) || 0, 0)
    const search = (params.get('search') || '').trim()
    const categoryId = params.get('category') || ''
    const feedId = params.get('feed') || ''
    const direction = params.get('sort') === 'oldest' ? 'asc' : 'desc'
    const order = params.get('order') === 'created' ? 'created_at' : 'published_at'

    if (demo) {
      let entries = demoEntries().map((entry) => normalizeEntry(entry, { demo: true }))
      if (filter === 'unread') entries = entries.filter((entry) => entry.status === 'unread')
      if (filter === 'starred') entries = entries.filter((entry) => entry.starred)
      if (search) {
        const needle = search.toLowerCase()
        entries = entries.filter((entry) => `${entry.title} ${entry.excerpt}`.toLowerCase().includes(needle))
      }
      if (categoryId) entries = entries.filter((entry) => Number(entry.categoryId) === Number(categoryId))
      if (feedId) entries = entries.filter((entry) => Number(entry.feedId) === Number(feedId))
      return {
        demo: true,
        total: entries.length,
        entries: entries.slice(offset, offset + limit).map(listItem),
      }
    }

    const client = await miniflux()
    const status = filter === 'unread' ? 'unread' : ['unread', 'read']
    const page = await client.entries({
      status,
      limit,
      offset,
      search,
      categoryId,
      feedId,
      starred: filter === 'starred' ? true : '',
      order,
      direction,
    })
    let entries = (page?.entries || []).map((entry) => normalizeEntry(entry))
    if (filter === 'starred') entries = entries.filter((entry) => entry.starred)
    return { demo: false, total: Number(page?.total) || entries.length, entries: entries.map(listItem) }
  }

  /**
   * `/entries` behind a stale-while-revalidate cache. Reopening the panel, going
   * back to a category, or the panel's prefetch all ask for a page that was
   * already fetched; the answer is the cached one while it is plausible, and a
   * background refresh updates the next view. Writes patch rows in place
   * (`patchEntryRows`) instead of dropping every page.
   */
  async function listEntriesCached(params) {
    const demo = wantsDemo(params.get('demo')) || !(await resolveSettings()).configured
    if (demo) return listEntries(params)
    const key = `entries:${params.toString()}`
    return cacheRunSWR(key, ENTRIES_TTL, ENTRIES_STALE_TTL, () => listEntries(params))
  }

  function listItem(entry) {
    return {
      id: entry.id,
      cover: entry.cover || '',
      title: entry.title,
      url: entry.url,
      author: entry.author,
      publishedAt: entry.publishedAt,
      readingMinutes: entry.readingMinutes,
      starred: entry.starred,
      status: entry.status,
      feedId: entry.feedId,
      feedTitle: entry.feedTitle,
      categoryId: entry.categoryId,
      categoryTitle: entry.categoryTitle,
      excerpt: entry.excerpt,
      textLength: entry.textLength,
    }
  }

  /** The demo feed list, shaped like the live one so the sidebar is never empty. */
  function demoCatalog() {
    const entries = demoEntries().map((entry) => normalizeEntry(entry, { demo: true }))
    const categories = new Map()
    const feeds = new Map()
    for (const entry of entries) {
      const category = categories.get(entry.categoryId) || {
        id: entry.categoryId,
        title: entry.categoryTitle,
        totalUnread: 0,
        feedCount: 0,
        feedIds: new Set(),
      }
      category.totalUnread += 1
      category.feedIds.add(entry.feedId)
      categories.set(entry.categoryId, category)

      const feed = feeds.get(entry.feedId) || {
        id: entry.feedId,
        title: entry.feedTitle,
        feedUrl: '',
        categoryId: entry.categoryId,
        categoryTitle: entry.categoryTitle,
        unread: 0,
        disabled: false,
        lastError: '',
      }
      feed.unread += 1
      feeds.set(entry.feedId, feed)
    }
    return {
      categories: [...categories.values()]
        .map((category) => ({
          id: category.id,
          title: category.title,
          totalUnread: category.totalUnread,
          feedCount: category.feedIds.size,
        }))
        .sort((a, b) => b.totalUnread - a.totalUnread),
      feeds: [...feeds.values()].sort((a, b) => b.unread - a.unread || a.title.localeCompare(b.title)),
    }
  }

  /**
   * The last catalog that came back complete.
   *
   * A write expires the caches right before the next bootstrap, which is
   * exactly when four Miniflux calls go out together. One of them failing used
   * to answer `{feeds: [], categories: []}` with HTTP 200, and the panel
   * replaced the whole sidebar with nothing — the "all subscriptions went
   * empty after marking something read" report. A degraded answer now keeps
   * what we already knew and says so.
   */
  let lastCatalog = null

  const shapeCategory = (category) => ({
    id: Number(category.id),
    title: String(category.title || ''),
    totalUnread: Number(category.total_unread) || 0,
    feedCount: Number(category.feed_count) || 0,
  })

  function shapeFeed(feed, counters) {
    return {
      id: Number(feed.id),
      title: String(feed.title || ''),
      // The edit dialog shows the address Miniflux polls, so the sidebar
      // payload carries it; a Host half without it makes the dialog ask.
      feedUrl: String(feed.feed_url || ''),
      categoryId: Number(feed.category?.id) || 0,
      categoryTitle: String(feed.category?.title || ''),
      unread: Number(counters?.unreads?.[String(feed.id)] ?? counters?.unreads?.[feed.id]) || 0,
      disabled: Boolean(feed.disabled),
      lastError: String(feed.parsing_error_message || ''),
    }
  }

  async function bootstrap(demoRequested) {
    const settings = await resolveSettings()
    const demo = wantsDemo(demoRequested) || !settings.configured
    const status = {
      configured: settings.configured,
      source: settings.source,
      baseUrl: settings.baseUrl,
      lastBaseUrl: settings.configured ? '' : runtime.lastBaseUrl,
      demo,
      demoAvailable: true,
      version: VERSION,
      credentialStore: Boolean(ctx.get('credentials')),
      accountId: settings.accountId || '',
      username: settings.username || '',
    }
    if (!settings.configured) {
      return { status, ...demoCatalog(), counters: null }
    }
    try {
      const client = await miniflux()
      // allSettled, not all: one slow endpoint must not throw away the three
      // answers that did arrive.
      const settled = await Promise.allSettled([
        cacheRunSWR('categories', META_TTL, META_STALE_TTL, () => client.categories({ counts: true })),
        cacheRunSWR('feeds', META_TTL, META_STALE_TTL, () => client.feeds()),
        // `client.counters()` swallows its own failures and returns null, which
        // a cache would then hold for the whole TTL as "0 unread everywhere".
        // Surface it as a *soft* failure instead: no counters, no cached null,
        // and the caller falls back to the numbers already on screen.
        cacheRunSWR('counters', LIST_TTL, META_STALE_TTL, async () => {
          const counts = await client.counters()
          if (!counts) throw new MinifluxError('Feed counters are unavailable', { code: 'no_counters' })
          return counts
        }),
        cachedMe(client),
      ])
      const value = (index) => (settled[index].status === 'fulfilled' ? settled[index].value : null)
      const failures = settled
        .filter((result) => result.status === 'rejected')
        // Missing counters are not a broken catalog: the panel keeps the numbers
        // it already shows rather than reporting an error it cannot act on.
        .filter((result) => !(result.reason?.code === 'no_counters'))
        .map((result) => messageOf(result.reason))
      const categories = value(0)
      const feeds = value(1)
      const counters = value(2)
      const me = value(3)

      if (settings.accountId && me?.username && me.username !== settings.username) {
        try {
          await writeAccount(settings.accountId, { baseUrl: settings.baseUrl, token: settings.token, username: me.username })
          const index = await readAccountIndex()
          if (index) {
            await writeAccountIndex(
              index.list.map((account) => (account.id === settings.accountId ? { ...account, username: me.username } : account)),
              index.active,
            )
          }
          runtime.settings = { ...settings, username: me.username }
        } catch {
          // a display label is not worth failing the panel over
        }
      }

      // Counters are the one payload whose absence reads as "every feed has 0
      // unread", which hides the entire sidebar in the Unread filter. Prefer
      // the numbers already on screen over a lie.
      const effectiveCounters = counters ?? lastCatalog?.counters ?? null
      const shapedFeeds = feeds
        ? feeds.map((feed) => shapeFeed(feed, effectiveCounters))
          .sort((a, b) => b.unread - a.unread || a.title.localeCompare(b.title))
        : (lastCatalog?.feeds || [])
      const shapedCategories = categories ? categories.map(shapeCategory) : (lastCatalog?.categories || [])

      if (failures.length > 0 && shapedFeeds.length === 0) {
        // Nothing fresh and nothing remembered: say so instead of pretending
        // the account has no subscriptions.
        ctx.logger?.warn?.(`rss-miniflux: bootstrap unavailable: ${failures.join('; ')}`)
        return {
          status: { ...status, error: failures.join('; '), stale: true },
          categories: shapedCategories,
          feeds: [],
          counters: effectiveCounters,
          unavailable: true,
        }
      }
      if (failures.length === 0) {
        lastCatalog = { feeds: shapedFeeds, categories: shapedCategories, counters: effectiveCounters }
      } else {
        ctx.logger?.warn?.(`rss-miniflux: bootstrap degraded: ${failures.join('; ')}`)
      }

      return {
        status: {
          ...status,
          user: me?.username || '',
          username: me?.username || settings.username || '',
          countersUnknown: !effectiveCounters,
          ...(failures.length > 0 ? { error: failures.join('; '), stale: true } : {}),
        },
        categories: shapedCategories,
        feeds: shapedFeeds,
        counters: effectiveCounters,
      }
    } catch (error) {
      ctx.logger?.warn?.(`rss-miniflux: bootstrap failed: ${messageOf(error)}`)
      return {
        status: { ...status, error: messageOf(error), stale: true },
        categories: lastCatalog?.categories || [],
        feeds: lastCatalog?.feeds || [],
        counters: lastCatalog?.counters || null,
        unavailable: !lastCatalog,
      }
    }
  }

  // -------------------------------------------------------------------------
  // HTTP API for the reader panel
  // -------------------------------------------------------------------------

  class HttpError extends Error {
    constructor(status, code, message) {
      super(message)
      this.status = status
      this.code = code
    }
  }

  function messageOf(error) {
    if (error instanceof MinifluxError) return error.message
    if (error instanceof HttpError) return error.message
    return error?.message || String(error)
  }

  function json(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...headers,
      },
    })
  }

  function failureParts(error) {
    const status = Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 502
    return {
      status,
      body: {
        error: {
          code: error?.code || (error instanceof MinifluxError ? error.code : 'internal_error'),
          message: messageOf(error),
        },
      },
    }
  }

  function failure(error) {
    const { status, body } = failureParts(error)
    return json(body, status)
  }

  function sendNode(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  /** The browser carrier only routes GET/HEAD to a resource, so writes use a handler route. */
  function writeRoute(path, methods, run) {
    return ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (!methods.includes((req.method || 'GET').toUpperCase())) {
          sendNode(res, 405, { error: { code: 'method_not_allowed', message: `Only ${methods.join(' / ')} is allowed` } })
          return
        }
        const controller = new AbortController()
        res.on('close', () => {
          if (!res.writableEnded) controller.abort()
        })
        try {
          const chunks = []
          let size = 0
          for await (const chunk of req) {
            size += chunk.length
            if (size > 1_000_000) throw new HttpError(413, 'too_large', 'Request body too large')
            chunks.push(chunk)
          }
          const text = Buffer.concat(chunks).toString('utf8')
          let body = {}
          if (text) {
            try {
              body = JSON.parse(text)
            } catch {
              throw new HttpError(400, 'bad_json', 'Request body is not valid JSON')
            }
          }
          sendNode(res, 200, await run(body, (req.method || 'GET').toUpperCase(), controller.signal))
        } catch (error) {
          const { status, body } = failureParts(error)
          sendNode(res, status, body)
        }
      },
    })
  }

  async function handleApi(request, peer) {
    if (peer && peer.principal && peer.principal.kind !== 'owner') {
      return json({ error: { code: 'forbidden', message: 'Local user only' } }, 403)
    }
    const url = new URL(request.url, 'http://127.0.0.1')
    const route = url.pathname.slice(PREFIX.length) || '/'
    const method = request.method.toUpperCase()
    try {
      if (method === 'GET' && route === '/bootstrap') {
        const started = Date.now()
        const payload = await bootstrap(url.searchParams.get('demo'))
        if (payload.unavailable) {
          // Keep the panel's last good catalog instead of handing it an empty one.
          return json(
            { error: { code: 'upstream_unavailable', message: payload.status?.error || 'Miniflux is unreachable' } },
            502,
            { 'server-timing': `bootstrap;dur=${Date.now() - started}` },
          )
        }
        // Visible in devtools and curl: how long the Host took to answer.
        return json(payload, 200, { 'server-timing': `bootstrap;dur=${Date.now() - started}` })
      }
      if (method === 'GET' && route === '/entries') {
        const started = Date.now()
        const payload = await listEntriesCached(url.searchParams)
        return json(payload, 200, { 'server-timing': `entries;dur=${Date.now() - started}` })
      }
      if (method === 'GET' && route === '/entry') {
        const id = url.searchParams.get('id')
        if (!id) throw new HttpError(400, 'bad_request', 'Missing id')
        const start = Date.now()
        const demo = wantsDemo(url.searchParams.get('demo'))
        const payload = await loadArticleCached(id, {
          demo,
          fetchOriginal: url.searchParams.get('fetch') === '1',
        })
        return json(payload, 200, { 'server-timing': `entry;dur=${Date.now() - start}` })
      }
      if (method === 'GET' && route === '/tweets') {
        // X media is enrichment, not the article. Asking the syndication
        // endpoint takes 1.4-3 s, so it runs after the body is on screen
        // instead of holding `/entry` open for it.
        const ids = String(url.searchParams.get('ids') || '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
          .slice(0, 24)
        const started = Date.now()
        const tweets = {}
        await Promise.all(ids.map(async (id) => {
          tweets[id] = await loadTweet(id)
        }))
        return json({ tweets }, 200, { 'server-timing': `tweets;dur=${Date.now() - started}` })
      }
      if (method === 'GET' && route === '/echo-referer') {
        // Diagnostic for embedded players: YouTube needs the Referer, and a
        // host shell that suppresses it (Referrer-Policy or a stripped header)
        // makes some embeds answer "error 153". The panel asks once and picks
        // the player that can actually work here.
        return json({ referer: request.headers.get('referer') || '' })
      }
      if (method === 'GET' && route === '/accounts') {
        return json(await accountsSnapshot())
      }
      if (method === 'GET' && route === '/feeds') {
        return json(await manageData())
      }
      if (method === 'GET' && route === '/discover') {
        const target = String(url.searchParams.get('url') || '').trim()
        if (!/^https?:\/\//i.test(target)) throw new HttpError(400, 'bad_url', 'URL must start with http:// or https://')
        const settings = await resolveSettings()
        if (!settings.configured) throw new HttpError(400, 'not_configured', 'Connect Miniflux before discovering feeds')
        const client = await miniflux()
        try {
          const found = await client.discover(target)
          const feeds = found
            .map((item) => ({
              url: String(item?.url || ''),
              title: String(item?.title || item?.url || ''),
              type: String(item?.type || ''),
            }))
            .filter((item) => /^https?:\/\//i.test(item.url))
          return json({ url: target, feeds })
        } catch (error) {
          if (error instanceof MinifluxError && (error.code === 'unauthorized' || error.code === 'not_configured')) throw error
          return json({ url: target, feeds: [], error: String(error?.message || 'Feed discovery failed') })
        }
      }
      if (method === 'GET' && route === '/feed-stats') {
        const settings = await resolveSettings()
        if (!settings.configured) {
          const counts = {}
          for (const entry of demoEntries()) {
            if (!entry.starred) continue
            const feedId = Number(entry.feed?.id) || 0
            if (feedId) counts[feedId] = (counts[feedId] || 0) + 1
          }
          return json({
            starred: counts,
            total: Object.values(counts).reduce((sum, value) => sum + value, 0),
            scanned: 0,
            capped: false,
          })
        }
        const stats = await cacheRun('feed-stats', 60_000, async () => {
          const client = await miniflux()
          const counts = {}
          const max = 1000
          let total = 0
          let scanned = 0
          for (let offset = 0; offset < max; offset += 100) {
            const page = await client.entries({
              status: ['unread', 'read'],
              starred: true,
              limit: 100,
              offset,
            })
            const entries = page?.entries || []
            total = Number(page?.total) || total
            for (const entry of entries) {
              const feedId = Number(entry.feed_id ?? entry.feed?.id) || 0
              if (feedId) counts[feedId] = (counts[feedId] || 0) + 1
            }
            scanned += entries.length
            if (entries.length < 100 || scanned >= total) break
          }
          return { starred: counts, total, scanned, capped: total > scanned }
        })
        return json(stats)
      }
      if (method === 'GET' && route === '/opml') {
        const settings = await resolveSettings()
        if (!settings.configured) throw new HttpError(400, 'not_configured', 'Connect Miniflux first')
        const client = await miniflux()
        const xml = await client.exportOpml()
        return new Response(xml, {
          status: 200,
          headers: {
            'content-type': 'text/xml; charset=utf-8',
            'content-disposition': 'attachment; filename="miniflux-subscriptions.opml"',
            'cache-control': 'no-store',
          },
        })
      }
      if (method === 'GET' && route === '/icon') {
        const feedId = url.searchParams.get('id')
        if (!feedId) throw new HttpError(400, 'bad_request', 'Missing feed id')
        const settings = await resolveSettings()
        if (!settings.configured) return new Response(null, { status: 204 })
        const icon = await iconLoad(feedId)
        if (!icon || icon.none || !icon.bytes) return new Response(null, { status: 204 })
        return new Response(icon.bytes, {
          status: 200,
          headers: { 'content-type': icon.type, 'cache-control': 'private, max-age=86400' },
        })
      }
      if (method === 'GET' && route === '/icons') {
        // One request for every icon the panel is about to show. The panel
        // asks again only for ids it does not have, so this stays small.
        const ids = String(url.searchParams.get('ids') || '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
        const started = Date.now()
        const batch = await iconBatch(ids)
        return json(batch, 200, { 'server-timing': `icons;dur=${Date.now() - started}` })
      }
      if (method === 'GET' && route === '/models') {
        return json(await modelCatalog())
      }
      if (method === 'GET' && route === '/efforts') {
        return json(await modelEfforts(url.searchParams.get('model') || ''))
      }
      if (method === 'GET' && route === '/digest') {
        return json(
          await loadDigest({
            demo: wantsDemo(url.searchParams.get('demo')),
            limit: Number(url.searchParams.get('limit')) || 200,
            force: url.searchParams.get('force') === '1',
          }),
        )
      }
      return json({ error: { code: 'not_found', message: `Unknown endpoint ${route}` } }, 404)
    } catch (error) {
      if (!(error instanceof HttpError) && !(error instanceof MinifluxError)) {
        ctx.logger?.warn?.(`rss-miniflux: ${error?.stack || error}`)
      }
      return failure(error)
    }
  }

  async function handleAction(body) {
    const action = String(body.action || '')
    const id = body.id
    const demo = wantsDemo(body.demo) || !(await resolveSettings()).configured
    if (demo) return { ok: true, demo: true, action, message: 'Demo data is not written back to Miniflux' }
    const client = await miniflux()
    switch (action) {
      case 'mark_read':
        await client.markRead(id, 'read')
        // One row changed: patch it into every cached page and article, keep the
        // pages themselves. Counters are cheap to refetch, entries are not.
        patchEntryRows(id, { status: 'read' })
        if (!patchCounters(body.feedId, -1)) expire(['counters'])
        expire(['feed-stats'])
        return { ok: true, action }
      case 'mark_unread':
        await client.markRead(id, 'unread')
        patchEntryRows(id, { status: 'unread' })
        if (!patchCounters(body.feedId, 1)) expire(['counters'])
        expire(['feed-stats'])
        return { ok: true, action }
      case 'mark_read_many':
        if (Array.isArray(body.ids) && body.ids.length > 0 && body.ids.length <= 200) {
          await client.markRead(body.ids, 'read')
          patchEntryRows(body.ids, { status: 'read' })
          expire(['counters', 'feed-stats'])
          return { ok: true, action }
        }
        await client.markRead(body.ids, 'read')
        expire(['counters', 'feed-stats', 'entries'])
        return { ok: true, action }
      case 'star':
        await starEntry(client, id, true)
        patchEntryRows(id, { starred: true })
        expire(['feed-stats'])
        return { ok: true, action }
      case 'unstar':
        await starEntry(client, id, false)
        patchEntryRows(id, { starred: false })
        expire(['feed-stats'])
        return { ok: true, action }
      case 'refresh':
        await client.refreshAll()
        break
      case 'refresh_feed':
        await client.refreshFeed(body.feedId)
        break
      case 'mark_feed_read':
        await client.markFeedRead(body.feedId)
        break
      case 'mark_category_read':
        await client.markCategoryRead(body.categoryId)
        break
      default:
        throw new HttpError(400, 'bad_action', `Unknown action ${action}`)
    }
    invalidate()
    return { ok: true, action }
  }

  async function starEntry(client, id, starred) {
    try {
      await client.setStarred(id, starred)
    } catch (error) {
      // Miniflux < 2.3.2 has no bulk starred flag; the bookmark endpoint toggles.
      if (error instanceof MinifluxError && (error.status === 400 || error.status === 405)) {
        await client.toggleBookmark(id)
        return
      }
      throw error
    }
  }

  function accountListResponse(index, settings) {
    return {
      accounts: index.list.map((account) => ({
        id: account.id,
        baseUrl: account.baseUrl,
        username: account.username || '',
        active: account.id === (index.active || ''),
      })),
      activeId: index.active || '',
      configured: Boolean(settings?.configured),
      activeBaseUrl: settings?.baseUrl || '',
      migrationError: runtime.migrationError || '',
    }
  }

  async function accountsSnapshot() {
    const index = await ensureAccountIndex()
    const settings = await resolveSettings(true)
    return accountListResponse(index, settings)
  }

  async function handleAccounts(body = {}) {
    const action = String(body.action || 'add')
    const index = await ensureAccountIndex()

    runtime.accountIndex = null

    if (action === 'add') {
      const baseUrl = normalizeBaseUrl(body.baseUrl)
      if (!baseUrl) throw new HttpError(400, 'bad_base_url', 'Miniflux URL must be an http(s) URL')
      let token = String(body.apiToken || '').trim()
      let username = ''
      const password = String(body.password || '')
      const login = String(body.username || '').trim()
      // Two ways in: paste an API token, or give the account password once and
      // let Miniflux mint a key (the password is never stored).
      if (!token && (login || password)) {
        if (!login || !password) throw new HttpError(400, 'credentials_required', 'Username and password are both required')
        try {
          const created = await createApiKeyWithPassword({
            baseUrl,
            username: login,
            password,
            description: 'Miniflux digest (DeepSeek Harness)',
          })
          token = created.token
          username = created.username
        } catch (error) {
          if (error instanceof MinifluxError && error.code === 'unauthorized') {
            throw new HttpError(400, 'verify_failed', 'Miniflux rejected the username or password')
          }
          throw new HttpError(400, 'verify_failed', `Connection failed: ${messageOf(error)}`)
        }
      }
      if (!token) throw new HttpError(400, 'token_required', 'The API token is required')
      if (!username) {
        try {
          username = (await new MinifluxClient({ baseUrl, token, timeoutMs: 12_000 }).me())?.username || ''
        } catch (error) {
          throw new HttpError(400, 'verify_failed', `Connection failed: ${messageOf(error)}`)
        }
      }
      const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      await writeAccount(id, { baseUrl, token, username })
      const list = index.list.filter((account) => account.id !== id).concat({ id, baseUrl, username })
      await writeAccountIndex(list, id)
      runtime.settings = null
      runtime.settingsAt = 0
      invalidate()
      return { ok: true, ...(await accountsSnapshot()) }
    }

    if (action === 'switch') {
      const id = String(body.id || '')
      if (!index.list.some((account) => account.id === id)) {
        throw new HttpError(404, 'account_not_found', 'Unknown account')
      }
      await writeAccountIndex(index.list, id)
      runtime.settings = null
      runtime.settingsAt = 0
      invalidate()
      return { ok: true, ...(await accountsSnapshot()) }
    }

    if (action === 'logout') {
      // Signing out forgets the token but keeps the server address around so
      // the connect form opens pre-filled.
      const id = String(body.id || index.active || index.list[0]?.id || '')
      const account = index.list.find((entry) => entry.id === id) || null
      const credentials = ctx.get('credentials')
      if (!account) {
        const legacy = await credentialRecord(CREDENTIAL_KEY)
        if (!legacy || (typeof legacy.key === 'string' && !legacy.key)) {
          throw new HttpError(400, 'not_connected', 'There is no saved connection to sign out of')
        }
        if (credentials) await credentials.deleteRecord(CREDENTIAL_KEY).catch(() => {})
        runtime.lastBaseUrl = normalizeBaseUrl(legacy.env?.MINIFLUX_BASE_URL || '') || runtime.lastBaseUrl
        runtime.settings = null
        runtime.settingsAt = 0
        invalidate()
        return { ok: true, ...(await accountsSnapshot()) }
      }
      if (credentials) await credentials.deleteRecord(`${ACCOUNT_PREFIX}${id}`).catch(() => {})
      const list = index.list.filter((entry) => entry.id !== id)
      const active = index.active === id ? (list[0]?.id || '') : index.active
      await writeAccountIndex(list, active)
      runtime.lastBaseUrl = account.baseUrl || runtime.lastBaseUrl
      runtime.settings = null
      runtime.settingsAt = 0
      invalidate()
      return { ok: true, ...(await accountsSnapshot()) }
    }

    if (action === 'remove') {
      const id = String(body.id || index.active || '')
      const credentials = ctx.get('credentials')
      if (credentials) await credentials.deleteRecord(`${ACCOUNT_PREFIX}${id}`).catch(() => {})
      const list = index.list.filter((account) => account.id !== id)
      const active = index.active === id ? (list[0]?.id || '') : index.active
      await writeAccountIndex(list, active)
      runtime.settings = null
      runtime.settingsAt = 0
      invalidate()
      return { ok: true, ...(await accountsSnapshot()) }
    }

    throw new HttpError(400, 'bad_action', `Unknown account action ${action}`)
  }

  async function saveSettings(body) {
    const result = await handleAccounts({ action: 'add', ...body })
    return { ok: true, check: { ok: true, message: `Connected${result.accounts.find((account) => account.active)?.username ? ` as ${result.accounts.find((account) => account.active).username}` : ''}` }, status: { configured: true } }
  }

  async function clearSettings() {
    const index = await ensureAccountIndex()
    if (index.list.length > 0) return handleAccounts({ action: 'remove', id: index.active || index.list[0].id })
    const credentials = ctx.get('credentials')
    if (credentials) await credentials.deleteRecord(CREDENTIAL_KEY)
    runtime.settings = null
    invalidate()
    return { ok: true }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        resource: (request, peer) => handleApi(request, peer),
      }),
    'rss-miniflux: reader API',
  )
  ctx.effect(
    () => writeRoute(`${PREFIX}/action`, ['POST'], (body) => handleAction(body)),
    'rss-miniflux: write action route',
  )
  ctx.effect(
    () => writeRoute(`${PREFIX}/briefing`, ['POST'], (body, _method, signal) => generateBriefing(body, signal)),
    'rss-miniflux: briefing route',
  )
  ctx.effect(
    () => writeRoute(`${PREFIX}/accounts/action`, ['POST'], (body) => handleAccounts(body)),
    'rss-miniflux: accounts route',
  )
  ctx.effect(
    () => writeRoute(`${PREFIX}/manage`, ['POST'], (body) => handleManage(body)),
    'rss-miniflux: manage route',
  )
  ctx.effect(
    () => writeRoute(`${PREFIX}/settings`, ['POST', 'DELETE'], (body, method) => (
      method === 'DELETE' ? clearSettings() : saveSettings(body)
    )),
    'rss-miniflux: settings route',
  )

  // -------------------------------------------------------------------------
  // Agent tools
  // -------------------------------------------------------------------------

  function toolText(value) {
    return [{ type: 'text', text: String(value) }]
  }

  function output() {
    return { schema: { type: 'string' }, render: (_args, value) => toolText(value) }
  }

  function formatMinutes(minutes) {
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60)
      return `${hours} 小时 ${minutes % 60} 分`
    }
    return `${minutes} 分钟`
  }

  function digestText(digest) {
    const lines = []
    const banner = digest.demo ? '（示例数据，未连接 Miniflux）' : ''
    lines.push(
      `未读 ${digest.counts.unread} 篇 · 约 ${formatMinutes(digest.counts.minutes)} · ${digest.counts.feeds} 个源 · ${digest.counts.categories} 个分类 · 时间窗 ${digest.window.hours} 小时${banner}`,
    )
    lines.push('')
    lines.push(`分类分布：${digest.categories.map((category) => `${category.title} ${category.unread} 篇`).join(' / ') || '无'}`)
    lines.push(`活跃源：${digest.feeds.slice(0, 6).map((feed) => `${feed.title} ${feed.unread} 篇`).join(' / ') || '无'}`)
    lines.push(
      `体裁估计：观点/评论 ${digest.stance.opinion} 篇 · 资讯/发布 ${digest.stance.news} 篇 · 混合 ${digest.stance.mixed} 篇 · 未判定 ${digest.stance.unknown} 篇`,
    )
    lines.push('')
    if (digest.echoes.length > 0) {
      lines.push('多个来源在讲同一件事（标题相似）：')
      digest.echoes.forEach((echo, index) => {
        lines.push(`${index + 1}. ${echo.label} — ${echo.size} 篇 / ${echo.feeds.length} 个源 / 约 ${echo.minutes} 分钟`)
        for (const item of echo.items.slice(0, 3)) {
          lines.push(`   - #${item.id} ${item.title}（${item.feed}，${item.minutes} 分钟）`)
        }
      })
    } else {
      lines.push('未发现标题高度相似的跨来源呼应。')
    }
    lines.push('')
    lines.push('深度阅读推荐（按 篇幅/正文完整度/新鲜度/标题信号/收藏兴趣 打分）：')
    for (const item of digest.recommendations.slice(0, 6)) {
      lines.push(`- #${item.id} ${item.title}（${item.minutes} 分钟，${item.feed}，分数 ${item.score}）`)
      if (item.reasons.length) lines.push(`  理由：${item.reasons.join('；')}`)
    }
    if (digest.quickScan.length > 0) {
      lines.push('')
      lines.push(`碎片时间可扫读：${digest.quickScan.map((item) => `#${item.id} ${item.title}`).join('；')}`)
    }
    lines.push('')
    lines.push('用 miniflux_read 读取推荐条目的正文；用 miniflux_act 标记已读或收藏。')
    return lines.join('\n')
  }

  function overviewText(payload) {
    const { status, categories, feeds } = payload
    const lines = []
    lines.push(`连接状态：${status.configured ? `已连接 ${status.baseUrl}${status.user ? `（${status.user}）` : ''}` : '未配置'}`)
    if (status.error) lines.push(`连接错误：${status.error}`)
    if (!status.configured) {
      lines.push('在「Miniflux digest」面板里填写实例地址与 API 令牌即可连接；也可以先用 miniflux_digest 的 demo 参数查看示例。')
      return lines.join('\n')
    }
    lines.push(`分类：${categories.map((category) => `${category.title} ${category.totalUnread}`).join(' / ') || '无'}`)
    lines.push('未读最多的源：')
    for (const feed of feeds.slice(0, 8)) {
      lines.push(`- ${feed.title}：${feed.unread} 篇${feed.lastError ? `（解析错误：${feed.lastError}）` : ''}`)
    }
    return lines.join('\n')
  }

  const tools = [
    {
      name: 'miniflux_overview',
      description:
        '连接状态、分类与订阅源的未读分布。用户问「我的 RSS 订阅有什么」「哪些源积压最多」时先调用它。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: output(),
      execute: async () => overviewText(await bootstrap(false)),
    },
    {
      name: 'miniflux_digest',
      description:
        '分析当前未读条目：时间窗、分类/源分布、标题相似的多来源呼应、体裁估计（观点/资讯）、以及按篇幅与正文完整度打分的深度阅读推荐。要写「最近发生了什么/有什么值得读」的中文报告时，先调用它拿事实底稿，再组织成 3-5 条要点 + 2-3 条观点 + 3-5 篇推荐，不要编造条目之外的事实。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最多分析多少条未读，默认 200，上限 400' },
          demo: { type: 'boolean', description: '使用内置示例数据（未连接 Miniflux 时也会自动使用）' },
        },
        additionalProperties: false,
      },
      output: output(),
      execute: async (args = {}) => digestText(await loadDigest({
        demo: Boolean(args.demo),
        limit: Math.min(Math.max(Number(args.limit) || 200, 20), 400),
        force: true,
      })),
    },
    {
      name: 'miniflux_briefing',
      description: '按分类生成一份模型速读简报：概要与话题排行，只使用该分类未读条目的标题与正文。不传 model 时用当前默认模型；分类 id 来自 miniflux_overview。',
      parameters: {
        type: 'object',
        properties: {
          categoryId: { type: 'number', description: '分类 id；省略表示全部分类' },
          model: { type: 'string', description: '模型路由，格式 provider::model；省略用当前默认模型' },
          effort: { type: 'string', description: '推理强度，如 off / low / high / max；省略用模型默认值（deepseek-flash 默认 high）' },
          limit: { type: 'number', description: '最多分析多少篇未读，默认 50，上限 80' },
          demo: { type: 'boolean', description: '使用内置示例数据' },
        },
        additionalProperties: false,
      },
      timeoutMs: 240_000,
      output: output(),
      execute: async (args = {}, exec) => {
        const briefing = await generateBriefing(args, exec.signal)
        const lines = [
          `速读简报｜${briefing.meta.categoryTitle} · ${briefing.meta.modelLabel} · ${briefing.meta.entries} 篇未读`,
          '',
          briefing.overview,
          '',
          '话题排行：',
        ]
        for (const [index, topic] of briefing.topics.entries()) {
          lines.push(`${index + 1}. ${topic.topic} — ${topic.summary}（${topic.articles} 篇 / ${topic.sources} 个源）`)
        }
        if (briefing.topics.length === 0) lines.push('（模型没有给出结构化话题，只有概要。）')
        else if (briefing.partial) lines.push('（模型输出不完整或不是合法 JSON，话题列表可能缺项。）')
        return lines.join('\n')
      },
    },
    {
      name: 'miniflux_read',
      description: '读取一篇条目的全文（已清洗为 Markdown），用于深度阅读、复述或回答关于这篇文章的问题。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '条目 id，来自 miniflux_digest 或 miniflux_search 的结果' },
          fetchOriginal: { type: 'boolean', description: '让 Miniflux 抓取原始网页全文（较慢，仅在正文明显被截断时使用）' },
          markRead: { type: 'boolean', description: '读完后标记为已读' },
          demo: { type: 'boolean', description: '读取示例条目' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: output(),
      execute: async (args = {}, exec) => {
        const id = Number(args.id)
        if (!Number.isFinite(id)) throw new Error('id 必须是数字')
        const article = await loadArticle(id, {
          demo: Boolean(args.demo),
          fetchOriginal: Boolean(args.fetchOriginal),
        })
        if (args.markRead) {
          const settings = await resolveSettings()
          if (settings.configured) {
            const client = await miniflux()
            await client.markRead(id, 'read').catch(() => {})
            invalidate()
          }
        }
        const header = [
          `# ${article.item.title}`,
          `来源：${article.item.feedTitle}${article.item.author ? ` / ${article.item.author}` : ''}`,
          `发布：${article.item.publishedAt} · 约 ${article.item.readingMinutes} 分钟 · ${article.item.url}`,
          '',
        ].join('\n')
        const body = article.markdown.length > 14_000
          ? `${article.markdown.slice(0, 14_000)}\n\n（正文过长，已截断为前 14000 字符；如需后续部分请分段请求或直接在阅读器里阅读。）`
          : article.markdown
        return `${header}${body || '（这篇条目没有正文，只有标题与链接。）'}`
      },
    },
    {
      name: 'miniflux_search',
      description: '在 Miniflux 中按关键词搜索条目（标题与正文），返回 id、来源、时间与摘要，便于继续 miniflux_read。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词' },
          status: { type: 'string', enum: ['unread', 'read'], description: '状态过滤，默认 unread' },
          limit: { type: 'number', description: '返回条数，默认 15，上限 50' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: output(),
      execute: async (args = {}) => {
        const query = String(args.query || '').trim()
        if (!query) throw new Error('query 不能为空')
        const settings = await resolveSettings()
        if (!settings.configured) {
          const entries = demoEntries()
            .filter((entry) => `${entry.title} ${textFromHtml(entry.content)}`.toLowerCase().includes(query.toLowerCase()))
          if (entries.length === 0) return `示例数据里没有匹配「${query}」的条目。`
          return [`匹配 ${entries.length} 条（示例数据）：`, ...entries.map((entry) => `- #${entry.id} ${entry.title}（${entry.feed.title}）`)].join('\n')
        }
        const client = await miniflux()
        const page = await client.entries({
          status: args.status === 'read' ? 'read' : 'unread',
          search: query,
          limit: Math.min(Math.max(Number(args.limit) || 15, 1), 50),
        })
        const entries = page?.entries || []
        if (entries.length === 0) return `没有匹配「${query}」的条目。`
        return [
          `匹配 ${entries.length} 条（共 ${page?.total ?? entries.length}）：`,
          ...entries.map((entry) => {
            const minutes = Number(entry.reading_time) || estimateMinutes(textFromHtml(entry.content))
            return `- #${entry.id} ${entry.title}（${entry.feed?.title || '未知源'}，${String(entry.published_at || '').slice(0, 10)}，${minutes} 分钟）`
          }),
        ].join('\n')
      },
    },
    {
      name: 'miniflux_act',
      description: '改变 Miniflux 条目/订阅的读状态：mark_read、mark_unread、star、unstar、refresh、refresh_feed、mark_feed_read、mark_category_read。会写回用户的真实账号，只在用户明确要求时调用。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['mark_read', 'mark_unread', 'star', 'unstar', 'refresh', 'refresh_feed', 'mark_feed_read', 'mark_category_read'],
            description: '要执行的操作',
          },
          id: { type: 'number', description: '条目 id（mark_read/mark_unread/star/unstar）' },
          ids: { type: 'array', items: { type: 'number' }, description: '批量条目 id（可选）' },
          feedId: { type: 'number', description: '订阅源 id（refresh_feed/mark_feed_read）' },
          categoryId: { type: 'number', description: '分类 id（mark_category_read）' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: output(),
      execute: async (args = {}) => {
        const result = await handleAction(args)
        return `${result.demo ? '示例模式：' : ''}已执行 ${result.action || args.action}。`
      },
    },
  ]

  for (const tool of tools) ctx.tools.register(tool)

  // A short pointer so the model knows the reader exists before it is asked.
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: 'rss-miniflux',
      order: 9600,
      interpolate: false,
      text: '用户连接了 Miniflux 阅读器（插件「Miniflux digest」）。当用户问起订阅、未读、最近资讯或值得读的文章时，用 miniflux_overview / miniflux_digest 取事实底稿，再写摘要或推荐；用户要「按分类生成简报」时用 miniflux_briefing（概要与话题排行，需要可用模型）。推荐必须来自工具返回的条目，不要编造标题、来源或数据。',
    })
  })

  ctx.logger?.info?.(`rss-miniflux: reader API at ${PREFIX}, ${tools.length} tools`)
}

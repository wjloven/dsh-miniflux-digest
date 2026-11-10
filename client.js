/**
 * Miniflux digest · Client half.
 *
 * Registers a sidebar panel and its central panel (both keyed `rss-miniflux`).
 * The panel reads the Host JSON API under /rss-miniflux/api; it never talks to
 * Miniflux directly, so the API token stays on the Host.
 */
window.__ModuleLoader__.load({
  id: 'rss-miniflux-deepread',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    const API = '/rss-miniflux/api'
    const PANEL_ID = 'rss-miniflux'
    const PREFS_KEY = 'rss-miniflux:prefs'
    const DEFAULT_PREFS = {
      // Reading
      fontSize: 16,
      lineHeight: 1.75,
      lineWidth: 65,
      fontFamily: 'system',
      justify: false,
      titleSize: 1.6,
      // List
      showExcerpt: true,
      showReadingTime: true,
      showFavicon: true,
      titleLines: 2,
      previewLines: 2,
      cardImage: 'none',
      dimRead: true,
      showReadingRail: false,
      // Behaviour
      markReadOnOpen: true,
      markReadOnScroll: false,
      autoRefreshMinutes: 15,
      sortField: 'published',
      // `${accountId}:${categoryId}` → Lucide icon name, chosen in the picker.
      categoryIcons: {},
      // Sidebar feed order: 'alpha' by name, 'unread' by unread count.
      feedSort: 'alpha',
      // General
      locale: 'en',
      showHiddenFeeds: false,
      // Appearance
      theme: 'system',
      accent: 'default',
      // Reading surface: 'default' follows the Harness tokens, 'paper' uses the
      // warm Ringo palette for both modes.
      surface: 'default',
      faviconShape: 'rounded',
      faviconColor: 'normal',
      // Reading
      titleAlign: 'left',
    }

    const FONT_STACKS = {
      system: 'inherit',
      sans: '-apple-system, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif',
      serif: 'Georgia, "Songti SC", "Noto Serif CJK SC", "Times New Roman", serif',
      mono: 'ui-monospace, SFMono-Regular, Menlo, "SF Mono", monospace',
    }

    function loadPrefs() {
      try {
        const stored = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
        return { ...DEFAULT_PREFS, ...(stored && typeof stored === 'object' ? stored : {}) }
      } catch {
        return { ...DEFAULT_PREFS }
      }
    }

    function savePrefs(value) {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(value))
      } catch {
        // private mode: preferences simply do not persist
      }
    }

    const iconSrc = (feedId) => `${API}/icon?id=${encodeURIComponent(feedId)}`

    // ---------------------------------------------------------------------
    // Feed icons
    //
    // Miniflux answers one icon in ~400 ms (a feed it has never scraped can take
    // seconds), so one <img> per row painted the list over several seconds, and
    // rows without an icon kept a blank hole after their 404. Icons now come in
    // progressive batches, are kept per account in localStorage, and a letter
    // tile stands in until one arrives — nothing flashes, shifts or trickles in.
    // Nextflux gets the same result from an IndexedDB icon table (7 days for an
    // icon, 1 day for a miss); the panel keeps the same shape in localStorage.
    // ---------------------------------------------------------------------

    const ICON_STORE_KEY = 'rss-miniflux:icons:v1'
    const ICON_STORE_MAX_BYTES = 1_200_000
    const ICON_STORE_MAX_ITEMS = 300
    /** Ids per request. A cold icon can take seconds, so ask in small waves. */
    const ICON_CHUNK = 16
    const FEED_HUES = [212, 158, 28, 274, 340, 190, 46, 8]

    function feedHue(title) {
      let hash = 0
      for (const ch of String(title || '')) hash = (hash * 31 + (ch.codePointAt(0) || 0)) % 100000
      return FEED_HUES[hash % FEED_HUES.length]
    }

    function feedLetter(title) {
      const text = String(title || '').trim()
      if (!text) return '·'
      const first = [...text][0]
      return /[\p{L}\p{N}]/u.test(first) ? first.toUpperCase() : '·'
    }

    /** The account an icon belongs to: feed ids repeat across accounts. */
    function iconScope() {
      const status = PANEL_CACHE.boot?.status
      return String(status?.accountId || status?.baseUrl || '')
    }

    /**
     * feed id → { src } (data URL) | { direct: true } (too big to inline) |
     * { none: true } (the feed has none). Missing means "not asked yet".
     * The saved copy is stamped with its account, so it is never shown under
     * another one.
     */
    const ICON_CACHE = new Map()
    const ICON_QUEUED = new Set()
    const ICON_WATCHERS = new Set()
    let iconTimer = null
    let iconFlush = null
    let iconFailed = false
    let iconSaveTimer = null

    function iconKey(feedId) {
      const id = String(feedId ?? '')
      return id && id !== '0' ? id : ''
    }

    function watchIcons(listener) {
      ICON_WATCHERS.add(listener)
      return () => ICON_WATCHERS.delete(listener)
    }

    /**
     * `changed` carries the ids of this wave, so only the rows whose icon just
     * arrived re-render — a 200-feed sidebar must not redraw on every wave.
     */
    function notifyIcons(changed) {
      for (const listener of ICON_WATCHERS) {
        try {
          listener(changed)
        } catch {
          // one broken subscriber must not stop the others
        }
      }
    }

    /** Icons saved by an earlier page load, so they never re-request. */
    function restoreIcons() {
      const value = readCached(ICON_STORE_KEY)
      if (!value || value.v !== 1 || !value.items || typeof value.items !== 'object') return
      const scope = iconScope()
      if (!scope || value.account !== scope) return
      for (const [key, src] of Object.entries(value.items)) {
        if (typeof src === 'string' && src.startsWith('data:')) ICON_CACHE.set(key, { src })
      }
    }

    function persistIcons() {
      if (iconSaveTimer) return
      iconSaveTimer = setTimeout(() => {
        iconSaveTimer = null
        const items = {}
        let bytes = 0
        let count = 0
        // Newest first: an icon seen this session is likelier to be on screen
        // next time than one from a month ago.
        for (const [key, entry] of [...ICON_CACHE.entries()].reverse()) {
          if (!entry?.src) continue
          if (count >= ICON_STORE_MAX_ITEMS) break
          if (bytes + entry.src.length > ICON_STORE_MAX_BYTES) continue
          items[key] = entry.src
          bytes += entry.src.length
          count += 1
        }
        const scope = iconScope()
        try {
          if (count === 0 || !scope) localStorage.removeItem(ICON_STORE_KEY)
          else localStorage.setItem(ICON_STORE_KEY, JSON.stringify({ v: 1, account: scope, at: Date.now(), items }))
        } catch {
          // Over quota: icons are the first thing worth dropping.
          try { localStorage.removeItem(ICON_STORE_KEY) } catch { /* ignore */ }
        }
      }, 900)
    }

    /** Coalesce every icon the visible rows want into one wave of requests. */
    function queueIcons(ids) {
      let added = false
      for (const id of ids) {
        const key = iconKey(id)
        if (!key || ICON_CACHE.has(key) || ICON_QUEUED.has(key)) continue
        ICON_QUEUED.add(key)
        added = true
      }
      if (!added || iconTimer || iconFlush) return
      iconTimer = setTimeout(() => {
        iconTimer = null
        iconFlush = flushIcons().finally(() => { iconFlush = null })
      }, 16)
    }

    /**
     * Ask for the queued icons in small waves: the first rows get their icons as
     * soon as those answers land instead of waiting for the slowest feed.
     */
    async function flushIcons() {
      while (ICON_QUEUED.size > 0 && !iconFailed) {
        const ids = [...ICON_QUEUED].slice(0, ICON_CHUNK)
        for (const id of ids) ICON_QUEUED.delete(id)
        const query = ids.map((id) => encodeURIComponent(id)).join(',')
        const result = await callApi(`/icons?ids=${query}`)
        if (!result.ok) {
          // An older Host half has no batch route: fall back to <img> per row and
          // stop asking, so this costs one request, not one per render.
          iconFailed = true
          const changed = new Set()
          for (const id of ids) {
            ICON_CACHE.set(id, { direct: true })
            changed.add(id)
          }
          notifyIcons(changed)
          return
        }
        const icons = result.data?.icons || {}
        const changed = new Set()
        for (const id of ids) {
          const src = icons[id]
          const had = ICON_CACHE.has(id)
          ICON_CACHE.set(id, typeof src === 'string' && src ? { src } : { none: true })
          if (!had || Boolean(src)) changed.add(id)
        }
        // Icons above the inline budget come through the browser-cached endpoint.
        for (const id of result.data?.oversize || []) {
          ICON_CACHE.set(iconKey(id), { direct: true })
          changed.add(iconKey(id))
        }
        notifyIcons(changed)
        // Save after every wave: a slow batch should not lose the icons that did
        // arrive if the panel is closed (or the page reloaded) mid-flight.
        persistIcons()
      }
    }

    /** Forget one feed's icon, e.g. after the feed was removed. */
    function forgetIcon(feedId) {
      const key = iconKey(feedId)
      if (!key) return
      ICON_CACHE.delete(key)
      notifyIcons()
    }

    /** Feed ids repeat across accounts, so switching drops the icons. */
    function resetIcons() {
      ICON_CACHE.clear()
      ICON_QUEUED.clear()
      iconFailed = false
      try { localStorage.removeItem(ICON_STORE_KEY) } catch { /* ignore */ }
      notifyIcons()
    }

    /**
     * A feed icon that is never empty: the letter tile is painted immediately
     * and the real icon fades in on top once it arrives.
     */
    function FeedIcon({ feedId, title, kind = 'row', size = 16, style }) {
      const key = iconKey(feedId)
      const [, bump] = useState(0)
      const [seen, setSeen] = useState(false)
      const holder = useRef(null)
      useEffect(() => {
        // Only the rows whose icon is in this wave update.
        const stop = watchIcons((changed) => {
          if (!changed || changed.has(key)) bump((value) => value + 1)
        })
        return stop
      }, [key])
      // Icons for rows far off screen would queue forever in a 200-feed
      // sidebar; ask for one when it comes within a screen of the viewport.
      useEffect(() => {
        if (seen) return undefined
        const node = holder.current
        if (!node || typeof IntersectionObserver !== 'function') {
          setSeen(true)
          return undefined
        }
        const observer = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setSeen(true)
            observer.disconnect()
          }
        }, { rootMargin: '240px' })
        observer.observe(node)
        return () => observer.disconnect()
      }, [seen])
      useEffect(() => {
        if (seen && !iconFailed && key) queueIcons([feedId])
      }, [seen, feedId, key])

      const className = kind === 'meta' ? 'mrss-meta-favicon' : 'mrss-favicon'
      const entry = ICON_CACHE.get(key)
      if (entry?.src) {
        return h('img', {
          className: `${className} mrss-favicon--in`,
          src: entry.src,
          alt: '',
          width: size,
          height: size,
          style,
          loading: 'lazy',
          decoding: 'async',
          referrerPolicy: 'no-referrer',
        })
      }
      if (entry?.direct) {
        return h('img', {
          className,
          src: iconSrc(feedId),
          alt: '',
          width: size,
          height: size,
          style,
          loading: 'lazy',
          decoding: 'async',
          referrerPolicy: 'no-referrer',
          onError: (event) => { event.currentTarget.style.visibility = 'hidden' },
        })
      }
      return h('span', {
        ref: holder,
        className: `${className} mrss-favicon--tile`,
        style: { ...style, '--mrss-fav-h': String(feedHue(title)) },
        'aria-hidden': true,
      }, feedLetter(title))
    }


    // ---------------------------------------------------------------------
    // Provider video embeds (YouTube / Bilibili / X)
    // ---------------------------------------------------------------------

    const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

    /** Parse an entry or iframe URL into { provider, id }. Mirrors lib/html.js. */
    function embedForUrl(raw) {
      let url
      try {
        url = new URL(String(raw || '').trim())
      } catch {
        return null
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      const host = url.hostname.toLowerCase().replace(/^www\./, '')
      if (host === 'youtu.be') {
        const id = url.pathname.split('/').filter(Boolean)[0]
        return id && VIDEO_ID.test(id) ? { provider: 'youtube', id } : null
      }
      if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
        const queryId = url.searchParams.get('v') || ''
        const pathId = (url.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{6,20})/) || [])[1] || ''
        const id = queryId || pathId
        return id && VIDEO_ID.test(id) ? { provider: 'youtube', id } : null
      }
      if (host === 'bilibili.com' || host === 'm.bilibili.com' || host === 'player.bilibili.com') {
        const bvid = url.searchParams.get('bvid') || (url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/) || [])[1] || ''
        if (/^BV[0-9A-Za-z]+$/.test(bvid)) return { provider: 'bilibili', id: bvid }
        const aid = url.searchParams.get('aid') || (url.pathname.match(/\/video\/av(\d+)/i) || [])[1] || ''
        return aid && /^\d+$/.test(aid) ? { provider: 'bilibili', id: `av${aid}` } : null
      }
      if (host === 'x.com' || host === 'twitter.com' || host === 'mobile.x.com' || host === 'mobile.twitter.com' || host === 'platform.twitter.com') {
        const statusId = (url.pathname.match(/\/status(?:es)?\/(\d{2,25})/) || [])[1] || ''
        if (/^\d{2,25}$/.test(statusId)) return { provider: 'x', id: statusId }
        const embedId = host === 'platform.twitter.com' ? url.searchParams.get('id') || '' : ''
        return /^\d{2,25}$/.test(embedId) ? { provider: 'x', id: embedId } : null
      }
      return null
    }

    function embedSource(embed) {
      const id = String(embed?.id || '')
      if (embed?.provider === 'youtube' && VIDEO_ID.test(id)) {
        return `https://www.youtube-nocookie.com/embed/${id}?rel=0`
      }
      if (embed?.provider === 'bilibili' && /^(?:BV[0-9A-Za-z]+|av\d+)$/.test(id)) {
        const query = /^av/i.test(id) ? `aid=${id.slice(2)}` : `bvid=${id}`
        return `https://player.bilibili.com/player.html?${query}&page=1&high_quality=1&danmaku=0&autoplay=0`
      }
      return ''
    }

    function ArticleEmbed({ embed }) {
      const src = embedSource(embed)
      if (!src) return null
      const title = embed.provider === 'youtube' ? 'YouTube video' : 'Bilibili video'
      return h('div', { className: 'mrss-embed', 'data-provider': embed.provider },
        h('iframe', {
          src,
          title,
          loading: 'lazy',
          allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen',
          allowFullScreen: true,
          sandbox: 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox allow-forms',
        }))
    }

    /**
     * X entries keep their feed body (text, quotes) and only borrow the tweet's
     * video here: no card chrome, no duplicate author block. When the feed body
     * is empty the tweet text fills in instead.
     */
    function TweetBlock({ embed, showText, bodyHasVideo }) {
      const tweet = embed && embed.tweet
      if (!tweet) return null
      const videos = bodyHasVideo ? [] : (Array.isArray(tweet.videos) ? tweet.videos : [])
      const text = showText ? String(tweet.text || '').trim() : ''
      if (videos.length === 0 && !text) return null
      return h('div', { className: 'mrss-tweet' },
        text ? h('p', { className: 'mrss-tweet-text' }, text) : null,
        videos.map((video) => h('video', {
          key: video.src,
          className: 'mrss-tweet-video',
          src: video.src,
          poster: video.poster || undefined,
          controls: true,
          playsInline: true,
          loop: Boolean(video.loop),
          preload: 'metadata',
        })))
    }

    // ---------------------------------------------------------------------
    // Saved snapshot
    //
    // Borrowed from Nextflux: the panel paints from the last known snapshot
    // (account, categories, feeds, one page of entries, the open article) and
    // revalidates afterwards. localStorage is synchronous, which is the whole
    // point — the first render is already correct instead of "Not connected"
    // followed 300ms later by the account and the list.
    //
    // Only the first page of entries is kept (currently scrolled pages are not
    // replayed); the article lives under its own key so a big one cannot evict
    // the catalog, and every write survives a full quota.
    // ---------------------------------------------------------------------

    const CACHE_KEY = 'rss-miniflux:cache:v1'
    const CACHE_ARTICLE_KEY = 'rss-miniflux:cache:v1:article'
    const CACHE_VERSION = 1
    const CACHE_MAX_AGE = 7 * 24 * 60 * 60_000
    const CACHE_WRITE_DELAY = 400
    /** Mount-time patience: younger snapshots are not revalidated. */
    const FRESH_FOR = 45_000

    function readCached(key) {
      try {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      } catch {
        return null
      }
    }

    function readSnapshot() {
      const value = readCached(CACHE_KEY)
      if (!value || value.v !== CACHE_VERSION) return null
      if (!value.boot || !value.boot.status) return null
      if (Date.now() - Number(value.savedAt || 0) > CACHE_MAX_AGE) return null
      return value
    }

    function readCachedArticle() {
      const value = readCached(CACHE_ARTICLE_KEY)
      if (!value || value.v !== CACHE_VERSION || !value.article || !value.id) return null
      if (Date.now() - Number(value.savedAt || 0) > CACHE_MAX_AGE) return null
      return value
    }

    /** Last written snapshot, merged with every queued patch. */
    let snapshotBase = null
    let snapshotPatch = null
    let snapshotTimer = null

    function persistSnapshot(patch) {
      if (!patch) return
      snapshotPatch = { ...(snapshotPatch || {}), ...patch }
      if (snapshotTimer) return
      snapshotTimer = setTimeout(() => {
        snapshotTimer = null
        const queued = snapshotPatch
        snapshotPatch = null
        if (!queued) return
        const body = { ...(snapshotBase || {}), ...queued, v: CACHE_VERSION, savedAt: Date.now() }
        if (!body.boot || !body.boot.status) {
          // Nothing to anchor the snapshot to yet (the first bootstrap is still
          // in flight): hold the patch and write it with that bootstrap.
          snapshotPatch = { ...queued, ...(snapshotPatch || {}) }
          return
        }
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(body))
          snapshotBase = body
        } catch {
          // Over quota: the catalog is worth more than the entry page.
          try {
            const lean = { ...body, entries: [], total: 0 }
            localStorage.setItem(CACHE_KEY, JSON.stringify(lean))
            snapshotBase = lean
          } catch {
            try { localStorage.removeItem(CACHE_KEY) } catch { /* nothing else to try */ }
            snapshotBase = null
          }
        }
      }, CACHE_WRITE_DELAY)
    }

    function persistArticle(payload) {
      if (!payload || !payload.item?.id) return
      try {
        const text = JSON.stringify({
          v: CACHE_VERSION,
          id: payload.item.id,
          savedAt: Date.now(),
          article: payload,
        })
        if (text.length > 400_000) {
          localStorage.removeItem(CACHE_ARTICLE_KEY)
          return
        }
        localStorage.setItem(CACHE_ARTICLE_KEY, text)
      } catch {
        try { localStorage.removeItem(CACHE_ARTICLE_KEY) } catch { /* ignore */ }
      }
    }

    function forgetArticle() {
      try { localStorage.removeItem(CACHE_ARTICLE_KEY) } catch { /* ignore */ }
    }

    function clearSnapshot() {
      if (snapshotTimer) clearTimeout(snapshotTimer)
      snapshotTimer = null
      snapshotPatch = null
      snapshotBase = null
      // Nothing in the warm paths may survive an account switch: these caches
      // are only ever the previous account's rows and bodies.
      PANEL_CACHE.pages.clear()
      PANEL_CACHE.articles.clear()
      prefetch.queue.length = 0
      try {
        localStorage.removeItem(CACHE_KEY)
        localStorage.removeItem(CACHE_ARTICLE_KEY)
      } catch {
        // private mode
      }
    }

    /** Idle scheduling that also works where requestIdleCallback is missing. */
    function scheduleIdle(fn, timeout = 400) {
      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        return { idle: window.requestIdleCallback(fn, { timeout }) }
      }
      return { timer: setTimeout(fn, 0) }
    }

    function cancelIdle(handle) {
      if (!handle) return
      if (handle.idle !== undefined && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(handle.idle)
      } else if (handle.timer !== undefined) {
        clearTimeout(handle.timer)
      }
    }

    /**
     * The panel unmounts whenever the user switches to the conversation and
     * back, so the view state lives outside the component. It is a pure UI
     * cache: nothing here is authoritative, and the saved snapshot (above)
     * outlives a page reload.
     */
    const PANEL_CACHE = {
      boot: null,
      entries: [],
      entriesKey: '',
      listInfo: { loading: false, total: 0 },
      filter: 'unread',
      scope: { kind: 'all', id: null, title: '' },
      query: '',
      debounced: '',
      selectedId: null,
      article: null,
      articleState: 'idle',
      articleScroll: 0,
      listScroll: 0,
      lastSync: 0,
      wide: false,
      sidebarCollapsed: false,
      fullView: false,
      /** True when this page session started from the saved snapshot. */
      hydrated: false,
      /**
       * Article bodies this session has already seen, most recent last. Kept
       * outside the component because the panel unmounts on every switch to the
       * conversation pane; going back to an article should not open it again.
       */
      articles: new Map(),
      /** Recent list pages by entries key, so going back to a scope is instant. */
      pages: new Map(),
    }

    // ---------------------------------------------------------------------
    // Warm paths
    //
    // Since v1.5.0 the first paint is fast, but a click still waited for the
    // network: Miniflux takes 1.8-5.7 s for a list page and 0.7-1.5 s for one
    // entry on a large account, and the panel asked again every time. So the
    // panel (a) remembers what it has already read, (b) asks for the row under
    // the pointer a moment before the click, and (c) reuses list pages it has
    // seen. Prefetching is deliberately shy: one hovered thing, two at a time,
    // never for something already in hand, and never blocking anything.
    // ---------------------------------------------------------------------

    const ARTICLE_MEMORY_MAX = 16
    const PAGE_MEMORY_MAX = 8
    const PAGE_MEMORY_TTL = 5 * 60_000
    const PREFETCH_CONCURRENCY = 2
    /** Hover dwell before a prefetch; moving across the list fires nothing. */
    const PREFETCH_DELAY = 140

    function rememberArticle(payload) {
      const id = Number(payload?.item?.id)
      if (!id) return
      PANEL_CACHE.articles.delete(id)
      PANEL_CACHE.articles.set(id, { article: payload, at: Date.now() })
      while (PANEL_CACHE.articles.size > ARTICLE_MEMORY_MAX) {
        const oldest = PANEL_CACHE.articles.keys().next().value
        PANEL_CACHE.articles.delete(oldest)
      }
    }

    function recallArticle(id) {
      const hit = PANEL_CACHE.articles.get(Number(id))
      return hit ? hit.article : null
    }

    function rememberPage(key, data) {
      if (!key) return
      PANEL_CACHE.pages.delete(key)
      PANEL_CACHE.pages.set(key, {
        entries: data.entries || [],
        total: Number(data.total) || 0,
        at: Date.now(),
      })
      while (PANEL_CACHE.pages.size > PAGE_MEMORY_MAX) {
        const oldest = PANEL_CACHE.pages.keys().next().value
        PANEL_CACHE.pages.delete(oldest)
      }
    }

    function recallPage(key) {
      const hit = PANEL_CACHE.pages.get(key)
      if (!hit) return null
      if (Date.now() - hit.at > PAGE_MEMORY_TTL) {
        PANEL_CACHE.pages.delete(key)
        return null
      }
      return hit
    }

    /**
     * A read/star write only moves one row. Patch the pages already in memory
     * instead of forgetting them: the page cost seconds to fetch, and the panel
     * is about to switch scope again.
     *
     * Rows are updated, not removed, to match the optimistic list: marking an
     * article read dims its row instead of making it jump out from under the
     * pointer. The next background fetch drops it from an unread page.
     */
    function patchCachedEntry(id, changes) {
      const numeric = Number(id)
      if (!numeric) return
      for (const [key, page] of PANEL_CACHE.pages) {
        let touched = false
        const entries = page.entries.map((entry) => {
          if (Number(entry.id) !== numeric) return entry
          touched = true
          return { ...entry, ...changes }
        })
        if (!touched) continue
        PANEL_CACHE.pages.set(key, { ...page, entries })
      }
    }

    /** Patch the open article and every remembered copy of it. */
    function patchCachedArticle(id, changes) {
      const numeric = Number(id)
      const apply = (payload) => (payload && Number(payload.item?.id) === numeric
        ? { ...payload, item: { ...payload.item, ...changes } }
        : payload)
      for (const [key, hit] of PANEL_CACHE.articles) {
        const next = apply(hit.article)
        if (next !== hit.article) PANEL_CACHE.articles.set(key, { ...hit, article: next })
      }
    }

    // A tiny queue: two requests in flight, newest hover wins. Idle warming (the
    // rows next to the open article) is a separate lane that only runs when
    // nothing else wants the connection, so it can never delay a hover.
    const prefetch = {
      queue: [],
      idleQueue: [],
      inflight: new Set(),
      hoverTimer: null,
      hoverKind: '',
    }

    /**
     * One request per article id, shared by the click and the prefetch that
     * started a moment earlier. Without this a hover followed by a click sends
     * two identical requests and the second one lands second.
     */
    const inflightArticles = new Map()

    function fetchArticle(id, { fetchOriginal = false } = {}) {
      const numeric = Number(id)
      const key = fetchOriginal ? `${numeric}:orig` : String(numeric)
      const existing = inflightArticles.get(key)
      if (existing) return existing
      const params = new URLSearchParams({ id: String(numeric) })
      if (fetchOriginal) params.set('fetch', '1')
      const task = callApi(`/entry?${params.toString()}`)
        .then((result) => {
          if (!result.ok) return { error: result.error }
          rememberArticle(result.data)
          return { article: result.data }
        })
        .finally(() => { inflightArticles.delete(key) })
      inflightArticles.set(key, task)
      return task
    }

    function prefetchKey(kind, value) {
      return `${kind}:${value}`
    }

    function pumpPrefetch() {
      // Idle warming gets the connection only when nothing else is waiting for it.
      if (prefetch.queue.length === 0 && prefetch.inflight.size === 0 && prefetch.idleQueue.length > 0) {
        prefetch.queue.push(prefetch.idleQueue.shift())
      }
      while (prefetch.inflight.size < PREFETCH_CONCURRENCY && prefetch.queue.length > 0) {
        const task = prefetch.queue.shift()
        const key = prefetchKey(task.kind, task.value)
        if (prefetch.inflight.has(key)) continue
        if (task.kind === 'article') {
          if (recallArticle(task.value)) continue
        } else if (recallPage(task.value.key)) {
          continue
        }
        prefetch.inflight.add(key)
        const request = task.kind === 'article'
          ? fetchArticle(task.value).then(() => {})
          : callApi(task.path).then((result) => {
            if (result.ok && result.data) rememberPage(task.value.key, result.data)
          })
        request
          .catch(() => {})
          .finally(() => {
            prefetch.inflight.delete(key)
            pumpPrefetch()
          })
      }
    }

    function prefetchArticle(id, { priority = false, idle = false } = {}) {
      const numeric = Number(id)
      if (!numeric || recallArticle(numeric)) return
      const key = prefetchKey('article', numeric)
      if (prefetch.inflight.has(key)) return
      if (prefetch.queue.some((task) => task.kind === 'article' && task.value === numeric)) return
      if (prefetch.idleQueue.some((task) => task.kind === 'article' && task.value === numeric)) return
      const task = { kind: 'article', value: numeric, path: `/entry?id=${numeric}` }
      if (!idle) prefetch.idleQueue.length = 0
      if (idle) {
        prefetch.idleQueue.push(task)
      } else if (priority) {
        // A hovered row is about to be clicked; nothing queued should come first.
        prefetch.queue.unshift(task)
      } else {
        prefetch.queue.push(task)
      }
      pumpPrefetch()
    }

    function prefetchPage({ filter, scope, order, search = '', limit = 60 }) {
      const key = entriesKeyFor({ filter, scope, debounced: search, order })
      if (PANEL_CACHE.entriesKey === key || recallPage(key)) return
      const params = new URLSearchParams({ filter, limit: String(limit), offset: '0' })
      if (order === 'created') params.set('order', 'created')
      if (search) params.set('search', search)
      if (scope.kind === 'category') params.set('category', String(scope.id))
      if (scope.kind === 'feed') params.set('feed', String(scope.id))
      const path = `/entries?${params.toString()}`
      if (prefetch.queue.some((task) => task.kind === 'page' && task.value.key === key)) return
      prefetch.queue.push({ kind: 'page', value: { key }, path })
      pumpPrefetch()
    }

    /**
     * Hover/focus dwell. Only the thing the pointer actually rests on is asked
     * for, so dragging across the list does not start twenty requests.
     */
    function prefetchAfterDwell(kind, run) {
      if (prefetch.hoverTimer) clearTimeout(prefetch.hoverTimer)
      prefetch.hoverKind = kind
      prefetch.hoverTimer = setTimeout(() => {
        prefetch.hoverTimer = null
        if (prefetch.hoverKind === kind) run()
      }, PREFETCH_DELAY)
    }

    /**
     * Adopt the saved snapshot for the very first render. Everything restored
     * here is a guess about a moment ago, so the panel revalidates right after
     * it paints — but the account name, the categories and the first page are
     * already in place instead of appearing one by one.
     */
    function adoptSnapshot(snapshot) {
      if (!snapshot || !snapshot.boot || !snapshot.boot.status) return false
      PANEL_CACHE.boot = snapshot.boot
      PANEL_CACHE.lastSync = Number(snapshot.savedAt) || 0
      PANEL_CACHE.hydrated = true
      if (['unread', 'all', 'starred'].includes(snapshot.filter)) PANEL_CACHE.filter = snapshot.filter
      const scope = snapshot.scope
      const categories = Array.isArray(snapshot.boot.categories) ? snapshot.boot.categories : []
      const feeds = Array.isArray(snapshot.boot.feeds) ? snapshot.boot.feeds : []
      if (scope && (
        scope.kind === 'all'
        || (scope.kind === 'category' && categories.some((item) => item.id === scope.id))
        || (scope.kind === 'feed' && feeds.some((item) => item.id === scope.id))
      )) {
        PANEL_CACHE.scope = { kind: scope.kind, id: scope.id ?? null, title: scope.title || '' }
      }
      PANEL_CACHE.listScroll = Number(snapshot.listScroll) || 0
      PANEL_CACHE.articleScroll = Number(snapshot.articleScroll) || 0
      // The first page is only usable when it belongs to the scope we restored:
      // a stale page under a different filter would show the wrong list.
      const key = entriesKeyFor({
        filter: PANEL_CACHE.filter,
        scope: PANEL_CACHE.scope,
        debounced: '',
        order: loadPrefs().sortField === 'created' ? 'created' : 'published',
      })
      if (Array.isArray(snapshot.entries) && snapshot.entries.length > 0 && snapshot.entriesKey === key) {
        PANEL_CACHE.entries = snapshot.entries
        PANEL_CACHE.entriesKey = key
        PANEL_CACHE.listInfo = { loading: false, total: Number(snapshot.total) || snapshot.entries.length }
        // Seed the in-session page cache too, so the very first scope switch
        // after a reload hits memory instead of the network.
        PANEL_CACHE.pages.set(key, {
          entries: snapshot.entries,
          total: PANEL_CACHE.listInfo.total,
          at: Number(snapshot.savedAt) || Date.now(),
        })
      }
      if (snapshot.selectedId) {
        PANEL_CACHE.selectedId = Number(snapshot.selectedId) || null
        const article = readCachedArticle()
        if (article && article.id === PANEL_CACHE.selectedId) {
          PANEL_CACHE.article = article.article
          PANEL_CACHE.articleState = 'ready'
          rememberArticle(article.article)
        }
      }
      return true
    }

    // Seed the write buffer with whatever was restored, so a patch that only
    // carries entries still lands on top of the catalog.
    const SAVED_SNAPSHOT = readSnapshot()
    if (adoptSnapshot(SAVED_SNAPSHOT)) snapshotBase = SAVED_SNAPSHOT
    // Icons are keyed by account, so they can only be restored once the saved
    // status says which account the panel is about to show.
    restoreIcons()

    /**
     * feed id → feed URL, filled from /feeds. `/bootstrap` carries the address
     * too, but a Host half from before that field existed does not send it; the
     * edit dialog falls back to this once per panel session.
     */
    const FEED_URLS = new Map()
    let feedUrlsPending = null

    /** Last /accounts answer, so a remount does not ask again for 30s. */
    const ACCOUNTS_CACHE = { data: null, at: 0 }

    // ---------------------------------------------------------------------
    // Text
    // ---------------------------------------------------------------------

    const EN = {
      'panel.title': 'Miniflux digest',
      'manage.title': 'Settings',
      'manage.categories': 'Categories',
      'manage.preferences': 'Preferences',
      'manage.shortcuts': 'Shortcuts',
      'manage.notConnected': 'Not connected',
      'manage.addAccount': 'Add account',
      'manage.accountAdded': 'Account added',
      'manage.confirmRemoveAccount': 'Remove this account? Its saved token is deleted.',
      'manage.addFeed': 'Add feed',
      'addfeed.title': 'Add feed',
      'addfeed.hint': 'Paste a site address or a feed URL. Miniflux looks for the feeds published there.',
      'addfeed.placeholder': 'https://example.com',
      'addfeed.find': 'Find feeds',
      'addfeed.finding': 'Looking for feeds…',
      'addfeed.found': 'feeds found',
      'addfeed.foundOne': 'Feed found',
      'addfeed.choose': 'Pick the feed to subscribe to.',
      'addfeed.none': 'No feed was found at that address. You can still subscribe to it directly.',
      'addfeed.badUrl': 'Enter a full URL starting with http:// or https://.',
      'addfeed.failed': 'Could not look up that address.',
      'addfeed.category': 'Category',
      'addfeed.subscribe': 'Subscribe',
      'addfeed.subscribing': 'Subscribing…',
      'addfeed.subscribed': 'Feed added',
      'addfeed.back': 'Back',
      'addfeed.direct': 'Direct URL',
      'addfeed.uncategorized': 'Uncategorized',
      'manage.searchFeeds': 'Search feeds',
      'manage.exportOpml': 'Export OPML',
      'manage.importOpml': 'Import OPML',
      'manage.imported': 'OPML imported',
      'manage.noFeeds': 'No feeds match.',
      'manage.uncategorized': 'Uncategorized',
      'manage.disabled': 'disabled',
      'manage.refresh': 'Refresh',
      'manage.markRead': 'Mark all read',
      'manage.edit': 'Edit',
      'manage.delete': 'Delete',
      'manage.save': 'Save',
      'manage.cancel': 'Cancel',
      'manage.confirmDeleteFeed': 'Delete subscription “{name}”? Its entries are removed too.',
      'manage.confirmDeleteCategory': 'Delete category “{name}”? Its feeds move to Uncategorized.',
      'manage.categoryName': 'Category name',
      'manage.addCategory': 'Add category',
      'manage.noCategories': 'No categories yet.',
      'manage.feedsCount': 'feeds',
      'manage.rename': 'Rename',
      'manage.fontSize': 'Reading font size',
      'manage.lineWidth': 'Line width',
      'manage.showExcerpt': 'Show excerpt in the list',
      'manage.showReadingTime': 'Show reading time',
      'manage.markReadOnOpen': 'Mark as read when opened',
      'manage.markReadOnScroll': 'Mark as read near the end',
      'manage.autoRefresh': 'Auto refresh',
      'manage.off': 'Off',
      'manage.minutes': 'min',
      'manage.version': 'Version',
      'manage.done': 'Done',
      'manage.failed': 'That action failed',
      'manage.connectFirst': 'Connect a Miniflux account before changing feeds.',
      'scope.all': 'all subscriptions',
      'list.markAll': 'Mark all as read',
      'list.confirmMarkAll': 'Mark every unread entry in “{name}” as read?',
      'list.markedAll': 'Marked all as read',
      'reader.prev': 'Previous entry',
      'reader.next': 'Next entry',
      'menu.actions': 'Actions',
      'menu.refreshFeed': 'Refresh this feed',
      'menu.markFeedRead': 'Mark all in this feed as read',
      'menu.markCategoryRead': 'Mark all in this category as read',
      'menu.editFeed': 'Edit feed',
      'menu.unsubscribe': 'Unsubscribe',
      'menu.confirmUnsubscribe': 'Delete “{name}” and all of its entries? This cannot be undone.',
      'menu.unsubscribed': 'Unsubscribed',
      'menu.feedUpdated': 'Feed updated',
      'menu.categoryIcon': 'Choose icon',
      'menu.categoryIconTitle': 'Category icon',
      'menu.categoryIconSearch': 'Search icons',
      'menu.categoryIconDefault': 'Use default icon',
      'menu.categoryIconNone': 'No icon matches that name.',
      'menu.categoryIconHint': 'Shown on this category’s tab in the sidebar.',
      'menu.renameCategory': 'Rename category',
      'menu.categoryRenamed': 'Category renamed',
      'menu.newCategory': 'New category',
      'menu.categoryCreated': 'Category created',
      'menu.categoryDeleted': 'Category deleted',
      'account.switch': 'Switch account',
      'account.title': 'Accounts',
      'account.switched': 'Switched account',
      'account.serverUrl': 'Server URL',
      'account.serverPlaceholder': 'example.com/v1/',
      'account.username': 'Username',
      'account.password': 'Password',
      'account.apiToken': 'API token',
      'account.tokenHint': 'Miniflux → Settings → API Keys',
      'account.orContinueWith': 'Or continue with',
      'account.tokenAuth': 'API Token Auth',
      'account.basicAuth': 'Basic Auth',
      'account.confirm': 'Confirm',
      'account.storageHint': 'Credentials stay in a local credential record, never in the profile config.',
      'account.addAnother': 'Add another account',
      'account.logout': 'Logout',
      'account.confirmLogout': 'Log out of “{name}”? Its saved API token is deleted.',
      'account.loggedOut': 'Logged out',
      'menu.feedTitle': 'Feed title',
      'menu.category': 'Category',
      'menu.categoryName': 'Category name',
      'menu.feedUrl': 'Feed URL',
      'menu.copyFeedUrl': 'Copy feed URL',
      'menu.copied': 'Copied',
      'menu.copyFailedShort': 'Copy failed',
      'menu.copyFailed': 'Could not copy — select the URL and copy it manually',
      'menu.urlUnavailable': 'Miniflux did not report an address for this feed.',
      'menu.urlLoading': 'Reading the address from Miniflux…',
      'menu.urlLookupFailed': 'Could not read this feed’s address from Miniflux.',
      'menu.openInMiniflux': 'Open in Miniflux',
      'menu.openInMinifluxHint': 'Opens this feed on your Miniflux server',
      'menu.markAboveRead': 'Mark above as read',
      'menu.copyLink': 'Copy link',
      'list.loadMore': 'Load more',
      'list.loadingMore': 'Loading more…',
      'reader.linkCopied': 'Link copied',
      'reader.share': 'Share',
      'side.syncing': 'Syncing…',
      'prefs.reading': 'Reading',
      'prefs.list': 'Article list',
      'prefs.behaviour': 'Behaviour',
      'prefs.fontSize': 'Text size',
      'prefs.lineHeight': 'Text line height',
      'prefs.lineWidth': 'Text max width',
      'prefs.fontFamily': 'Text font',
      'prefs.fontSystem': 'System',
      'prefs.fontSans': 'Sans',
      'prefs.fontSerif': 'Serif',
      'prefs.fontMono': 'Mono',
      'prefs.justify': 'Text justify',
      'prefs.titleSize': 'Title font size',
      'prefs.titleLines': 'Title lines in the list',
      'prefs.previewLines': 'Preview lines in the list',
      'prefs.showFavicon': 'Show feed icons in the list',
      'prefs.dimRead': 'Dim read entries',
      'prefs.showReadingRail': 'Show the reading rail',
      'prefs.cardImage': 'Cover image',
      'prefs.cardNone': 'None',
      'prefs.cardSmall': 'Small',
      'prefs.cardLarge': 'Large',
      'prefs.sortField': 'Sort by',
      'prefs.published': 'Published date',
      'prefs.created': 'Fetched date',
      'prefs.backup': 'Export preferences',
      'prefs.restore': 'Import preferences',
      'prefs.backupHint': 'Preferences live in this browser only. Export them to move to another machine.',
      'prefs.restored': 'Preferences imported',
      'prefs.reset': 'Reset preferences',
      'prefs.resetDone': 'Preferences reset',
      'manage.keyNext': 'Next / previous entry',
      'manage.keyMarkRead': 'Mark read / unread',
      'manage.keyStar': 'Star / unstar',
      'manage.keyRefresh': 'Refresh',
      'manage.keySearch': 'Search',
      'manage.keyOriginal': 'Open the original page',
      'manage.keyContent': 'Fetch the original content',
      'manage.keyCopy': 'Copy as Markdown',
      'manage.keyWide': 'Wide reading column',
      'manage.keyNextScope': 'Next feed or category',
      'manage.keyPrevScope': 'Previous feed or category',
      'manage.keyBack': 'Close the reader',
      'manage.keyAddFeed': 'Add a feed',

      'settings.general': 'General',
      'settings.appearance': 'Appearance',
      'settings.reading': 'Reading',
      'settings.data': 'Data',
      'settings.shortcuts': 'Shortcuts',
      'settings.about': 'About',
      'settings.language': 'Language',
      'settings.sync': 'Sync',
      'settings.syncManual': 'Manually',
      'settings.syncMinutes': 'Every {n} minutes',
      'settings.syncHour': 'Every hour',
      'settings.showHiddenFeeds': 'Show hidden feeds',
      'settings.showHiddenFeedsHint': 'Also list feeds with no unread entries.',
      'settings.theme': 'Theme',
      'settings.themeSystem': 'System',
      'settings.themeLight': 'Light',
      'settings.themeDark': 'Dark',
      'settings.surface': 'Reading surface',
      'settings.surfaceDefault': 'Default',
      'settings.surfacePaper': 'Paper',
      'settings.themeColor': 'Theme color',
      'settings.accentDefault': 'Default',
      'settings.accentBlue': 'Blue',
      'settings.accentGreen': 'Green',
      'settings.accentAmber': 'Amber',
      'settings.accentRed': 'Red',
      'settings.accentViolet': 'Violet',
      'settings.faviconShape': 'Favicon shape',
      'settings.shapeCircle': 'Circle',
      'settings.shapeSquare': 'Square',
      'settings.faviconColor': 'Favicon color',
      'settings.colorNormal': 'Normal',
      'settings.colorGreyscale': 'Greyscale',
      'settings.articleList': 'Article list',
      'settings.imagePreview': 'Image preview',
      'settings.displayFavicon': 'Display favicon',
      'settings.readingTime': 'Estimated reading time',
      'settings.titleAlign': 'Title alignment',
      'settings.alignLeft': 'Left',
      'settings.alignCenter': 'Central',
      'settings.textFontSize': 'Text font size',
      'settings.resetReading': 'Reset',
      'settings.subscriptionBackup': 'Subscription backup',
      'settings.opmlHint': 'Download every subscription as an OPML file.',
      'settings.settingsBackup': 'Settings backup',
      'settings.backupHint': 'Miniflux keeps its own database backups.',
      'settings.backupLink': 'See the Miniflux backup FAQ',
      'settings.version': 'Version',
      'settings.madeWith': 'Made with ♥ by',
      'settings.acknowledgements': 'Acknowledgements',
      'settings.ackMiniflux': 'API and UI reference',
      'settings.ackLucide': 'Icon set (ISC licence)',
      'settings.ackNextflux': 'Reading layout reference',
      'settings.ackHarness': 'Plugin host and design tokens',
      'demo.tag': 'Demo data',
      'demo.hint': 'No Miniflux connection yet; this is built-in demo content.',
      'demo.connect': 'Connect Miniflux',
      'nav.list': 'All articles',
      'nav.unread': 'Unread',
      'nav.starred': 'Starred',
      'nav.all': 'All',
      'nav.feeds': 'Feeds',
      'nav.uncategorized': 'Uncategorized',
      'side.refresh': 'Refresh subscriptions',
      'side.add': 'Add subscription',
      'side.newFeed': 'New feed',
      'side.importOpml': 'Import OPML',
      'side.newCategory': 'New category',
      'side.settings': 'Settings',
      'side.unread': 'unread',
      'side.feedSortAlpha': 'Sorted A–Z',
      'side.feedSortUnread': 'Sorted by unread',
      'side.feedSortHint': 'Click to switch the feed order',
      'side.updated': 'Updated',
      'side.neverSynced': 'Not synced yet',
      'side.noFeeds': 'No feeds here yet.',
      'side.noUnreadFeeds': 'No feeds with unread articles here.',
      'side.noStarredFeeds': 'No feeds with starred articles here.',
      'side.noFeedsAtAll': 'No subscriptions yet.',
      'side.addFirst': 'Add a feed',
      'side.feedError': 'The last refresh of this feed failed',
      'digest.recommendHint': 'Ranked by length, full text, freshness, and your starred interests',
      'digest.promptCopied': 'Copied — paste it into the chat',
      'digest.demoHint': 'No Miniflux connection yet; these are built-in demo entries.',

      'digest.min': ' min',
      'digest.hour': 'h',
      'unit.entries': 'entries',
      'unit.sources': 'sources',
      'digest.noEcho': 'No cross-source echoes with similar titles.',
      'list.empty': 'No entries match.',
      'list.loading': 'Loading…',
      'list.count': 'unread',
      'list.search': 'Search titles and text',
      'list.hideSidebar': 'Collapse feeds sidebar',
      'list.showSidebar': 'Expand feeds sidebar',
      'list.markAllStarred': 'Not available in Starred',
      'a11y.resizeSidebar': 'Resize feeds sidebar',
      'a11y.resizeList': 'Resize article list',
      'list.refresh': 'Refresh',
      'reader.pick': 'Pick an entry to start reading',
      'reader.loading': 'Opening…',
      'reader.original': 'Open in browser',
      'reader.close': 'Close article',
      'reader.readability': 'Readability',
      'reader.fullView': 'Full view',
      'reader.exitFullView': 'Exit full view',
      'reader.markRead': 'Mark read',
      'reader.markUnread': 'Mark unread',
      'reader.star': 'Star',
      'reader.unstar': 'Unstar',
      'reader.copied': 'Copied as Markdown',
      'reader.fetching': 'Asking Miniflux for the original page…',
      'reader.fetchingShort': 'Fetching the readable content…',
      'reader.fetchFailed': 'Could not fetch the readable content',
      'reader.toc': 'Contents',
      'reader.minutes': 'min',
      'reader.author': 'Author',
      'reader.authorSep': ', ',
      'reader.authorMore': 'and {n} more',
      'reader.code': 'Code',
      'reader.copyCode': 'Copy',
      'reader.copiedCode': 'Copied',
      'reader.copyFailed': 'Copy failed',
      'reader.fnBack': 'Back to the text',
      'reader.fnTitle': 'Note {n}',
      'reader.dateNow': 'Just now',
      'reader.empty': 'This entry has no body, only a title and a link.',
      'setup.hint': 'The address and API token live in a local credential record, not in the profile config.',
      'setup.baseUrl': 'Miniflux URL',
      'setup.tokenPlaceholder': 'Create one in Miniflux → Settings → API keys',
      'setup.saving': 'Testing connection…',
      'error.title': 'That did not work',
      'error.retry': 'Retry',
      'status.demoBanner': 'Demo data · not connected',
      'status.refreshing': 'Refreshing feeds…',
      'status.updated': 'Updated',
      'status.markedRead': 'Marked read',
      'status.markedUnread': 'Marked unread',
      'status.starred': 'Starred',
      'status.unstarred': 'Unstarred',
      'status.actionFailed': 'Action failed',
      'time.now': 'just now',
      'time.minutes': 'm ago',
      'time.hours': 'h ago',
      'time.yesterday': 'yesterday',
      'time.days': 'd ago',
    }
    /** Simplified Chinese dictionary; keys mirror EN one for one. */
    const ZH = {
      "panel.title": "Miniflux digest",
      "manage.title": "设置",
      "manage.categories": "分类",
      "manage.preferences": "偏好设置",
      "manage.shortcuts": "快捷键",
      "manage.notConnected": "未连接",
      "manage.addAccount": "添加账号",
      "manage.accountAdded": "账号已添加",
      "manage.confirmRemoveAccount": "删除这个账号？已保存的 token 会一并删除。",
      "manage.addFeed": "添加订阅",
      "addfeed.title": "添加订阅",
      "addfeed.hint": "粘贴站点地址或 Feed 地址，Miniflux 会去找该站点发布的 Feed。",
      "addfeed.placeholder": "https://example.com",
      "addfeed.find": "查找 Feed",
      "addfeed.finding": "正在查找 Feed…",
      "addfeed.found": "个 Feed",
      "addfeed.foundOne": "已找到 Feed",
      "addfeed.choose": "选择要订阅的 Feed。",
      "addfeed.none": "这个地址上没有找到 Feed，也可以直接按地址订阅。",
      "addfeed.badUrl": "请输入以 http:// 或 https:// 开头的完整地址。",
      "addfeed.failed": "无法查询该地址。",
      "addfeed.category": "分类",
      "addfeed.subscribe": "订阅",
      "addfeed.subscribing": "正在订阅…",
      "addfeed.subscribed": "订阅已添加",
      "addfeed.back": "返回",
      "addfeed.direct": "直接使用该地址",
      "addfeed.uncategorized": "未分类",
      "manage.searchFeeds": "搜索订阅源",
      "manage.exportOpml": "导出 OPML",
      "manage.importOpml": "导入 OPML",
      "manage.imported": "OPML 已导入",
      "manage.noFeeds": "没有匹配的订阅源。",
      "manage.uncategorized": "未分类",
      "manage.disabled": "已停用",
      "manage.refresh": "刷新",
      "manage.markRead": "全部标为已读",
      "manage.edit": "编辑",
      "manage.delete": "删除",
      "manage.save": "保存",
      "manage.cancel": "取消",
      "manage.confirmDeleteFeed": "删除订阅“{name}”？它的文章也会一并删除。",
      "manage.confirmDeleteCategory": "删除分类“{name}”？该分类下的订阅会移到未分类。",
      "manage.categoryName": "分类名",
      "manage.addCategory": "添加分类",
      "manage.noCategories": "还没有分类。",
      "manage.feedsCount": "个源",
      "manage.rename": "重命名",
      "manage.fontSize": "正文字号",
      "manage.lineWidth": "行宽",
      "manage.showExcerpt": "列表显示摘要",
      "manage.showReadingTime": "显示预计阅读时间",
      "manage.markReadOnOpen": "打开即标为已读",
      "manage.markReadOnScroll": "读到接近结尾时标为已读",
      "manage.autoRefresh": "自动刷新",
      "manage.off": "关闭",
      "manage.minutes": "分钟",
      "manage.version": "版本",
      "manage.done": "完成",
      "manage.failed": "操作失败",
      "manage.connectFirst": "先连接一个 Miniflux 账号，再修改订阅。",
      "scope.all": "全部订阅",
      "list.markAll": "全部标为已读",
      "list.confirmMarkAll": "把“{name}”里的未读文章全部标为已读？",
      "list.markedAll": "已全部标为已读",
      "reader.prev": "上一篇",
      "reader.next": "下一篇",
      "menu.actions": "操作",
      "menu.refreshFeed": "刷新这个源",
      "menu.markFeedRead": "把这个源全部标为已读",
      "menu.markCategoryRead": "把这个分类全部标为已读",
      "menu.editFeed": "编辑订阅源",
      "menu.unsubscribe": "取消订阅",
      "menu.confirmUnsubscribe": "删除“{name}”及其全部文章？此操作不可撤销。",
      "menu.unsubscribed": "已取消订阅",
      "menu.feedUpdated": "订阅源已更新",
      "menu.categoryIcon": "选择图标",
      "menu.categoryIconTitle": "分类图标",
      "menu.categoryIconSearch": "搜索图标",
      "menu.categoryIconDefault": "用默认图标",
      "menu.categoryIconNone": "没有匹配这个名字的图标。",
      "menu.categoryIconHint": "显示在该分类的侧栏标签上。",
      "menu.renameCategory": "重命名分类",
      "menu.categoryRenamed": "分类已重命名",
      "menu.newCategory": "新建分类",
      "menu.categoryCreated": "分类已创建",
      "menu.categoryDeleted": "分类已删除",
      "account.switch": "切换账号",
      "account.title": "账号",
      "account.switched": "已切换账号",
      "account.serverUrl": "服务器地址",
      "account.serverPlaceholder": "example.com/v1/",
      "account.username": "用户名",
      "account.password": "密码",
      "account.apiToken": "API token",
      "account.tokenHint": "Miniflux → Settings → API Keys",
      "account.orContinueWith": "或者使用",
      "account.tokenAuth": "API Token Auth",
      "account.basicAuth": "Basic Auth",
      "account.confirm": "确认",
      "account.storageHint": "凭据保存在本地凭据记录里，不会写进配置文件。",
      "account.addAnother": "添加另一个账号",
      "account.logout": "退出登录",
      "account.confirmLogout": "退出“{name}”？已保存的 API token 会删除。",
      "account.loggedOut": "已退出登录",
      "menu.feedTitle": "订阅源名称",
      "menu.category": "分类",
      "menu.categoryName": "分类名",
      "menu.feedUrl": "Feed 地址",
      "menu.copyFeedUrl": "复制 Feed 地址",
      "menu.copied": "已复制",
      "menu.copyFailedShort": "复制失败",
      "menu.copyFailed": "复制失败——请手动选中地址再复制",
      "menu.urlUnavailable": "Miniflux 没有返回这个源的地址。",
      "menu.urlLoading": "正在从 Miniflux 读取地址…",
      "menu.urlLookupFailed": "无法从 Miniflux 读取这个源的地址。",
      "menu.openInMiniflux": "在 Miniflux 中打开",
      "menu.openInMinifluxHint": "在你的 Miniflux 服务器上打开这个源",
      "menu.markAboveRead": "以上标为已读",
      "menu.copyLink": "复制链接",
      "list.loadMore": "加载更多",
      "list.loadingMore": "正在加载…",
      "reader.linkCopied": "链接已复制",
      "reader.share": "分享",
      "side.syncing": "正在同步…",
      "prefs.reading": "阅读",
      "prefs.list": "文章列表",
      "prefs.behaviour": "行为",
      "prefs.fontSize": "正文字号",
      "prefs.lineHeight": "正文行高",
      "prefs.lineWidth": "正文最大宽度",
      "prefs.fontFamily": "正文字体",
      "prefs.fontSystem": "系统",
      "prefs.fontSans": "无衬线",
      "prefs.fontSerif": "衬线",
      "prefs.fontMono": "等宽",
      "prefs.justify": "正文两端对齐",
      "prefs.titleSize": "标题字号",
      "prefs.titleLines": "列表标题行数",
      "prefs.previewLines": "列表摘要行数",
      "prefs.showFavicon": "列表显示源图标",
      "prefs.dimRead": "弱化已读文章",
      "prefs.showReadingRail": "显示阅读进度条",
      "prefs.cardImage": "封面图",
      "prefs.cardNone": "不显示",
      "prefs.cardSmall": "小图",
      "prefs.cardLarge": "大图",
      "prefs.sortField": "排序依据",
      "prefs.published": "发布时间",
      "prefs.created": "抓取时间",
      "prefs.backup": "导出设置",
      "prefs.restore": "导入设置",
      "prefs.backupHint": "设置只存在这台浏览器里，导出后可以搬到另一台机器。",
      "prefs.restored": "设置已导入",
      "prefs.reset": "重置设置",
      "prefs.resetDone": "设置已重置",
      "manage.keyNext": "下一篇 / 上一篇",
      "manage.keyMarkRead": "已读 / 未读",
      "manage.keyStar": "收藏 / 取消收藏",
      "manage.keyRefresh": "刷新",
      "manage.keySearch": "搜索",
      "manage.keyOriginal": "打开原网页",
      "manage.keyContent": "抓取原文正文",
      "manage.keyCopy": "复制为 Markdown",
      "manage.keyWide": "宽栏阅读",
      "manage.keyNextScope": "下一个源或分类",
      "manage.keyPrevScope": "上一个源或分类",
      "manage.keyBack": "关闭阅读器",
      "manage.keyAddFeed": "添加订阅源",
      "settings.general": "通用",
      "settings.appearance": "外观",
      "settings.reading": "阅读",
      "settings.data": "数据",
      "settings.shortcuts": "快捷键",
      "settings.about": "关于",
      "settings.language": "语言",
      "settings.sync": "同步",
      "settings.syncManual": "手动",
      "settings.syncMinutes": "每 {n} 分钟",
      "settings.syncHour": "每小时",
      "settings.showHiddenFeeds": "显示隐藏的订阅源",
      "settings.showHiddenFeedsHint": "同时列出没有未读文章的源。",
      "settings.theme": "主题",
      "settings.themeSystem": "跟随系统",
      "settings.themeLight": "浅色",
      "settings.themeDark": "深色",
      "settings.surface": "阅读底色",
      "settings.surfaceDefault": "默认",
      "settings.surfacePaper": "纸面",
      "settings.themeColor": "主题色",
      "settings.accentDefault": "默认",
      "settings.accentBlue": "蓝色",
      "settings.accentGreen": "绿色",
      "settings.accentAmber": "琥珀",
      "settings.accentRed": "红色",
      "settings.accentViolet": "紫色",
      "settings.faviconShape": "图标形状",
      "settings.shapeCircle": "圆形",
      "settings.shapeSquare": "方形",
      "settings.faviconColor": "图标颜色",
      "settings.colorNormal": "原色",
      "settings.colorGreyscale": "灰度",
      "settings.articleList": "文章列表",
      "settings.imagePreview": "图片预览",
      "settings.displayFavicon": "显示源图标",
      "settings.readingTime": "预计阅读时间",
      "settings.titleAlign": "标题对齐",
      "settings.alignLeft": "左对齐",
      "settings.alignCenter": "居中",
      "settings.textFontSize": "正文字号",
      "settings.resetReading": "重置",
      "settings.subscriptionBackup": "订阅备份",
      "settings.opmlHint": "把全部订阅导出为 OPML 文件。",
      "settings.settingsBackup": "设置备份",
      "settings.backupHint": "Miniflux 自己也做数据库备份。",
      "settings.backupLink": "查看 Miniflux 备份说明",
      "settings.version": "版本",
      "settings.madeWith": "用 ♥ 制作：",
      "settings.acknowledgements": "致谢",
      "settings.ackMiniflux": "API 与界面参考",
      "settings.ackLucide": "图标库（ISC 授权）",
      "settings.ackNextflux": "阅读版式参考",
      "settings.ackHarness": "插件宿主与设计 token",
      "demo.tag": "示例数据",
      "demo.hint": "还没有连接 Miniflux，下面是内置示例内容。",
      "demo.connect": "连接 Miniflux",
      "nav.list": "全部文章",
      "nav.unread": "未读",
      "nav.starred": "收藏",
      "nav.all": "全部",
      "nav.feeds": "订阅源",
      "nav.uncategorized": "未分类",
      "side.refresh": "刷新订阅",
      "side.add": "添加订阅",
      "side.newFeed": "新建订阅源",
      "side.importOpml": "导入 OPML",
      "side.newCategory": "新建分类",
      "side.settings": "设置",
      "side.unread": "未读",
      "side.feedSortAlpha": "按名称排序",
      "side.feedSortUnread": "按未读数排序",
      "side.feedSortHint": "点击切换排序方式",
      "side.updated": "更新于",
      "side.neverSynced": "尚未同步",
      "side.noFeeds": "这里还没有订阅源。",
      "side.noUnreadFeeds": "这里没有带未读文章的源。",
      "side.noStarredFeeds": "这里没有带收藏文章的源。",
      "side.noFeedsAtAll": "还没有任何订阅。",
      "side.addFirst": "添加一个源",
      "side.feedError": "这个源上次抓取失败",
      "digest.recommendHint": "按篇幅、正文完整度、新鲜度和你的收藏偏好排序",
      "digest.promptCopied": "已复制，粘贴到对话里即可",
      "digest.demoHint": "还没有连接 Miniflux，下面是内置示例文章。",
      "digest.min": " 分钟",
      "digest.hour": " 小时",
      "unit.entries": "篇",
      "unit.sources": "个源",
      "digest.noEcho": "没有标题相近的跨来源呼应。",
      "list.empty": "没有匹配的文章。",
      "list.loading": "加载中…",
      "list.count": "未读",
      "list.search": "搜索标题和正文",
      "list.hideSidebar": "收起订阅栏",
      "list.showSidebar": "展开订阅栏",
      "list.markAllStarred": "收藏视图下不可用",
      "a11y.resizeSidebar": "调整订阅栏宽度",
      "a11y.resizeList": "调整文章列表宽度",
      "list.refresh": "刷新",
      "reader.pick": "选一篇文章开始阅读",
      "reader.loading": "正在打开…",
      "reader.original": "在浏览器中打开",
      "reader.close": "关闭文章",
      "reader.readability": "正文提取",
      "reader.fullView": "无干扰阅读",
      "reader.exitFullView": "退出无干扰阅读",
      "reader.markRead": "标为已读",
      "reader.markUnread": "标为未读",
      "reader.star": "收藏",
      "reader.unstar": "取消收藏",
      "reader.copied": "已复制为 Markdown",
      "reader.fetching": "正在向 Miniflux 请求原网页…",
      "reader.fetchingShort": "正在抓取正文…",
      "reader.fetchFailed": "抓取正文失败",
      "reader.toc": "目录",
      "reader.minutes": " 分钟",
      "reader.authorSep": "、",
      "reader.authorMore": "等 {n} 位",
      "reader.code": "代码",
      "reader.copyCode": "复制",
      "reader.copiedCode": "已复制",
      "reader.copyFailed": "复制失败",
      "reader.fnBack": "回到正文",
      "reader.fnTitle": "脚注 {n}",
      "reader.dateNow": "刚刚",
      "reader.author": "作者",
      "reader.empty": "这篇文章只有标题和链接，没有正文。",
      "setup.hint": "地址和 API token 保存在本地凭据记录里，不写进配置文件。",
      "setup.baseUrl": "Miniflux 地址",
      "setup.tokenPlaceholder": "在 Miniflux → Settings → API keys 里创建",
      "setup.saving": "正在测试连接…",
      "error.title": "操作没有成功",
      "error.retry": "重试",
      "status.demoBanner": "示例数据 · 未连接",
      "status.refreshing": "正在刷新订阅…",
      "status.updated": "已更新",
      "status.markedRead": "已标为已读",
      "status.markedUnread": "已标为未读",
      "status.starred": "已收藏",
      "status.unstarred": "已取消收藏",
      "status.actionFailed": "操作失败",
      "time.now": "刚刚",
      "time.minutes": " 分钟前",
      "time.hours": " 小时前",
      "time.yesterday": "昨天",
      "time.days": " 天前",
    }

    const DICTS = { en: EN, zh: ZH }

    /** Lookup for one locale, falling back to English then the key itself. */
    function makeT(locale) {
      const dict = DICTS[locale === "zh" ? "zh" : "en"]
      return (key) => dict[key] ?? EN[key] ?? key
    }

    // ---------------------------------------------------------------------
    // Utilities
    // ---------------------------------------------------------------------

    async function callApi(path, options = {}) {
      const init = { method: options.method || 'GET', headers: {}, credentials: 'same-origin' }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      let response
      try {
        response = await fetch(`${API}${path}`, init)
      } catch (error) {
        return { ok: false, error: { code: 'network', message: String(error?.message || error) } }
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        return {
          ok: false,
          error: payload?.error || { code: `http_${response.status}`, message: `HTTP ${response.status}` },
        }
      }
      return { ok: true, data: payload }
    }

    /**
     * Fill FEED_URLS from /feeds. One request covers every feed, and concurrent
     * callers share it: only the fallback path for a Host half that does not
     * send the addresses in /bootstrap ever gets here.
     */
    async function loadFeedUrls() {
      if (feedUrlsPending) return feedUrlsPending
      feedUrlsPending = (async () => {
        const result = await callApi('/feeds')
        const rows = result.ok && Array.isArray(result.data?.feeds) ? result.data.feeds : []
        for (const row of rows) {
          FEED_URLS.set(Number(row.id), String(row.feedUrl || row.feed_url || ''))
        }
        return result.ok
      })()
      try {
        return await feedUrlsPending
      } finally {
        feedUrlsPending = null
      }
    }

    function entriesKeyFor({ filter, scope, debounced, order }) {
      return `${filter}|${scope.kind}|${scope.id ?? ''}|${debounced}|${order}`
    }

    // ---------------------------------------------------------------------
    // Warm-up
    // ---------------------------------------------------------------------

    let warmPending = null
    let warmedAt = 0
    const WARM_COOLDOWN = 5 * 60_000
    const WARM_SNAPSHOT_AGE = 2 * 60_000

    /**
     * Warm the Host caches while the panel is still closed. The sidebar entry
     * mounts with the app, so by the time someone opens the panel the Host has
     * already run the slow Miniflux calls once and answers from memory.
     * Nextflux gets the same effect by reading IndexedDB before the network.
     */
    function warmSnapshot() {
      if (warmPending) return warmPending
      if (Date.now() - warmedAt < WARM_COOLDOWN) return null
      const saved = readSnapshot()
      if (saved && Date.now() - Number(saved.savedAt || 0) < WARM_SNAPSHOT_AGE) return null
      warmedAt = Date.now()
      const order = loadPrefs().sortField === 'created' ? 'created' : 'published'
      const filter = ['unread', 'all', 'starred'].includes(saved?.filter) ? saved.filter : 'unread'
      const scope = saved?.scope?.kind === 'category' || saved?.scope?.kind === 'feed'
        ? saved.scope
        : { kind: 'all', id: null }
      const params = new URLSearchParams({ filter, limit: '60', offset: '0' })
      if (order === 'created') params.set('order', 'created')
      if (scope.kind === 'category' && scope.id) params.set('category', String(scope.id))
      if (scope.kind === 'feed' && scope.id) params.set('feed', String(scope.id))
      warmPending = Promise.all([callApi('/bootstrap'), callApi(`/entries?${params.toString()}`)])
        .then(([boot, page]) => {
          if (!boot.ok) return null
          const patch = { boot: boot.data, filter, scope }
          if (page.ok) {
            patch.entries = page.data.entries || []
            patch.total = Number(page.data.total) || 0
            patch.entriesKey = entriesKeyFor({ filter, scope, debounced: '', order })
          }
          persistSnapshot(patch)
          return boot.data
        })
        .catch(() => null)
        .finally(() => { warmPending = null })
      return warmPending
    }

    function relativeTime(iso, t) {
      const time = Date.parse(iso)
      if (!Number.isFinite(time)) return ''
      const minutes = Math.round((Date.now() - time) / 60_000)
      if (minutes < 2) return t('time.now')
      if (minutes < 60) return `${minutes}${t('time.minutes')}`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours}${t('time.hours')}`
      const days = Math.round(hours / 24)
      if (days === 1) return t('time.yesterday')
      if (days < 7) return `${days}${t('time.days')}`
      const date = new Date(time)
      return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')}`
    }

    // Ringo's kicker: a short lead before the first colon, dash or bar reads as
    // a topic label above the title. Only when the lead is short enough to be a
    // label and the rest still carries the sentence.
    function splitKicker(title) {
      const text = String(title || '').trim()
      const match = /^([^：:—–|]{2,28})[：:]\s*(\S[\s\S]{3,})$/.exec(text)
        || /^([^—–|]{2,20})\s+[—–|]\s+(\S[\s\S]{3,})$/.exec(text)
      if (!match) return { kicker: '', title: text }
      const lead = match[1].trim()
      // A CJK lead is dense: more than a dozen characters is a sentence, not a
      // label, so the title keeps its colon instead.
      const limit = /[\u3400-\u9fff]/.test(lead) ? 12 : 28
      if (lead.length > limit) return { kicker: '', title: text }
      return { kicker: lead, title: match[2].trim() }
    }

    // Feed bylines are comma-, semicolon-, ampersand- or "and"-separated. Two
    // names fit on the line; the rest folds into a count.
    function authorsOf(raw) {
      const text = String(raw || '').trim()
      if (!text) return []
      return text
        .split(/\s*(?:[,、;；/&]|\band\b|和|与|及)\s*/)
        .map((part) => part.trim())
        .filter(Boolean)
    }

    function fullDate(iso, locale) {
      const time = Date.parse(iso)
      if (!Number.isFinite(time)) return ''
      try {
        return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
          year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        }).format(new Date(time))
      } catch {
        return new Date(time).toISOString().slice(0, 16).replace('T', ' ')
      }
    }

    /** Smooth only when the reader has not asked for reduced motion. */
    function scrollBehavior() {
      try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
      } catch {
        return 'smooth'
      }
    }

    function scoreTier(score) {
      if (score >= 55) return 'high'
      if (score >= 35) return 'mid'
      return 'low'
    }

    function formatMinutes(minutes, t) {
      if (!minutes) return `0${t('digest.min')}`
      if (minutes >= 60) return `${Math.floor(minutes / 60)}${t('digest.hour')} ${minutes % 60}${t('digest.min')}`
      return `${minutes}${t('digest.min')}`
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    const CSS = `
.mrss-root{display:flex;height:100%;min-height:0;flex:1;align-self:stretch;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;overflow:hidden;position:relative}
/* The host does not ship a global border-box reset (its own components opt in
   per subtree), so the panel carries its own. Without it the search field and
   list rows grow by their padding and spill past the list column. */
.mrss-root,.mrss-root *,.mrss-root *::before,.mrss-root *::after{box-sizing:border-box}
/* With the DSH sidebar collapsed, the shell floats the traffic lights and the
   sidebar toggle over the leading edge of the panel. Reserve the titlebar
   strip so the panel's own header row starts below those buttons. */
html[data-platform=darwin] [data-sidebar-collapsed] .mrss-root{padding-top:var(--dsh-frame-top-clearance,48px)}
.mrss-side{width:256px;flex:none;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);container-type:inline-size}
.mrss-side[data-collapsed="true"]{display:none}
.mrss-side-head{padding:9px 8px 8px 11px;display:flex;align-items:center;gap:1px;min-height:52px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mrss-brand{display:flex;align-items:center;gap:7px;min-width:0;flex:1;padding-right:4px}
.mrss-brand .mrss-icon{opacity:.85}
.mrss-brand-text{display:flex;flex-direction:column;gap:0;min-width:0}
.mrss-brand-title{font-weight:600;font-size:13px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrss-brand-sub{font-size:10.5px;line-height:1.35;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@container (max-width:235px){
  .mrss-side-head{padding-left:9px;gap:0}
  .mrss-brand{gap:0}
  .mrss-brand .mrss-icon{display:none}
  .mrss-brand-title{font-size:12.5px}
  .mrss-side-head .mrss-btn[data-icon="true"]{width:26px;height:26px}
}
.mrss-scroll{overflow:auto;min-height:0;flex:1;scrollbar-width:thin;padding:2px 8px 12px}
.mrss-navrow{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13.5px;cursor:pointer;text-align:left}
.mrss-navrow:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.mrss-navrow[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);font-weight:600}
.mrss-navrow .mrss-grow{padding-left:2px}
.mrss-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrss-count{font-variant-numeric:tabular-nums;font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-secondary);padding:0 4px;min-width:30px;text-align:right}
.mrss-sidefeed[data-active="true"] .mrss-count{color:inherit}
.mrss-dot{width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-brand-primary);flex:none}
.mrss-feedline{display:flex;align-items:center;padding-right:2px}
.mrss-sidefeed{display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:28px;padding:0 6px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer;text-align:left}
.mrss-sidefeed:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent)}
.mrss-sidefeed[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary);font-weight:600}
.mrss-sidefeed .mrss-count{min-width:24px;font-size:11px}
.mrss-sidefeed .mrss-favicon{width:15px;height:15px;padding:0}
.mrss-feeds-empty{padding:4px 8px 6px 6px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.mrss-linkbtn{border:0;background:transparent;padding:0;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11.5px;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.mrss-feedlabel{display:flex;align-items:center;gap:5px;min-width:0}
.mrss-feedtitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrss-warn-flag{display:inline-flex;align-items:center;flex:none;color:var(--dsw-alias-state-warn-primary)}
.mrss-warn-flag svg{display:block}
.mrss-side-foot{padding:8px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;gap:2px;margin-top:auto;background:var(--dsw-alias-bg-layer-1)}
.mrss-switch-account{display:flex;align-items:center;gap:9px;flex:1;min-width:0;padding:6px;border:0;border-radius:10px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}
.mrss-switch-account:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.mrss-avatar{width:30px;height:30px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-size:12px;font-weight:600;text-transform:uppercase}
.mrss-account-meta{display:flex;flex-direction:column;gap:1px;min-width:0}
.mrss-account-name{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrss-account-server{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrss-account-chevron{width:14px;height:14px;opacity:.4;flex:none}
.mrss-switch-account:hover .mrss-account-chevron{opacity:.7}
.mrss-tabs{padding:8px 8px 12px;display:flex;justify-content:center;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.mrss-tabs>div{display:flex;gap:2px;padding:3px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.mrss-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:4px 12px;border-radius:999px;cursor:pointer}
.mrss-tab:hover{color:var(--dsw-alias-label-primary)}
.mrss-tab[data-active="true"]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}
.mrss-main{flex:1;display:flex;min-width:0;min-height:0}
.mrss-resizer{width:5px;flex:none;cursor:col-resize;position:relative;z-index:3;touch-action:none}
.mrss-resizer::after{content:"";position:absolute;top:0;bottom:0;left:2px;width:1px;background:var(--dsw-alias-border-l1)}
.mrss-resizer:hover::after{background:var(--dsw-alias-brand-primary)}
.mrss-col{display:flex;flex-direction:column;min-height:0;min-width:0}
.mrss-list{width:336px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.mrss-list[data-hidden="true"]{display:none}
.mrss-list-head{position:relative;padding:7px 9px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:7px}
.mrss-list-head .mrss-input{height:28px}
.mrss-list-head[data-loading="true"]::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;pointer-events:none;background:linear-gradient(90deg,transparent,var(--dsw-alias-brand-primary),transparent) no-repeat;background-size:38% 100%;animation:mrss-list-loading 1.1s ease-in-out infinite}
@keyframes mrss-list-loading{0%{background-position:-40% 0}100%{background-position:140% 0}}
.mrss-list-bar{display:flex;align-items:center;gap:3px;min-height:32px}
.mrss-list-bar .mrss-btn[data-icon="true"]{width:28px;height:28px;padding:4px}
.mrss-list-title{display:flex;align-items:center;gap:7px;flex:1;min-width:0;padding:0 2px}
.mrss-scope{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrss-list-count{flex:none;font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mrss-tip{position:relative;display:inline-flex;flex:none}
.mrss-tip::after{content:attr(data-tip);position:absolute;top:calc(100% + 7px);right:-2px;z-index:20;padding:4px 8px;border-radius:6px;background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);font-size:11px;line-height:1.4;white-space:nowrap;box-shadow:0 6px 18px rgba(0,0,0,.18);opacity:0;transform:translateY(-2px);pointer-events:none;transition:opacity .12s ease,transform .12s ease}
.mrss-tip--start::after{left:-2px;right:auto}
.mrss-tip:hover::after{opacity:1;transform:none}
.mrss-list-bar .mrss-markall:disabled,
.mrss-list-bar .mrss-markall:disabled:hover{opacity:.45;background:transparent;color:var(--dsw-alias-label-secondary)}
.mrss-item{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font:inherit;padding:8px 12px 10px;cursor:pointer;position:relative}
.mrss-item:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent)}
.mrss-item[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.mrss-item[data-unread="true"] .mrss-item-title{font-weight:600}
.mrss-item-title{font-size:15.5px;font-weight:600;line-height:1.5;margin:2px 0 4px;display:-webkit-box;-webkit-line-clamp:var(--mrss-title-lines,2);-webkit-box-orient:vertical;overflow:hidden}
.mrss-item[data-read="true"][data-dim="true"] .mrss-item-title{opacity:.6;font-weight:500}
.mrss-item[data-read="true"][data-dim="true"] .mrss-item-excerpt{opacity:.55}
.mrss-item-cover{width:100%;display:block;object-fit:cover;border-radius:8px;background:var(--dsw-alias-bg-layer-2);margin:4px 0 2px}
.mrss-item-cover[data-size="small"]{height:64px}
.mrss-item-cover[data-size="large"]{height:148px}
.mrss-item-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);display:flex;gap:6px;align-items:center;min-width:0;white-space:nowrap}
.mrss-item-feed{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto;min-width:0;max-width:62%}
.mrss-item-time{font-size:11px;color:var(--dsw-alias-label-secondary);flex:none;font-variant-numeric:tabular-nums}
.mrss-item-readtime{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:1px}
.mrss-sep{opacity:.5}
.mrss-item-excerpt{margin-top:2px;font-size:13.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:var(--mrss-preview-lines,2);-webkit-box-orient:vertical;overflow:hidden}
.mrss-reader{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--dsw-alias-bg-base);position:relative}
.mrss-reader-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);backdrop-filter:blur(6px);z-index:2}
.mrss-reader-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px;row-gap:6px;min-width:0;margin-left:auto}
.mrss-progress{position:absolute;top:0;left:0;height:2px;background:var(--dsw-alias-brand-primary);transition:width .1s linear;z-index:3}
.mrss-article-scroll{overflow:auto;min-height:0;flex:1;scrollbar-width:thin}
.mrss-article{--mrss-pad-inline:32px;--mrss-reading-color:var(--dsw-alias-label-primary);--mrss-muted:var(--dsw-alias-label-secondary);max-width:var(--mrss-reading-width,65ch);margin:0 auto;padding:26px var(--mrss-pad-inline) 96px;font-size:var(--mrss-reading-size,16px);line-height:var(--mrss-reading-line-height,1.75);font-family:var(--mrss-reading-font,inherit);text-align:var(--mrss-reading-align,left);color:var(--mrss-reading-color);word-break:break-word;overflow-wrap:break-word;font-synthesis:none;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
@media (max-width:720px){.mrss-article{--mrss-pad-inline:20px;padding-top:18px}}
/* Set the reading text slightly below the surface's brightest colour: full
   white on a dark page is what makes long reads glare (Ringo's dark palette). */
.mrss-root[data-mrss-theme="dark"] .mrss-article,
[data-ds-dark-theme] .mrss-root:not([data-mrss-theme="light"]) .mrss-article{--mrss-reading-color:color-mix(in srgb,var(--dsw-alias-label-primary) 88%,var(--dsw-alias-bg-base))}
@media (prefers-color-scheme:dark){.mrss-root:not([data-mrss-theme="light"]) .mrss-article{--mrss-reading-color:color-mix(in srgb,var(--dsw-alias-label-primary) 88%,var(--dsw-alias-bg-base))}}
@media (prefers-contrast:more){.mrss-article{--mrss-reading-color:var(--dsw-alias-label-primary);--mrss-muted:color-mix(in srgb,var(--dsw-alias-label-secondary) 55%,var(--dsw-alias-label-primary))}}
.mrss-article-body :is(h1,h2,h3,h4){color:var(--dsw-alias-label-primary);line-height:1.3;text-wrap:balance;scroll-margin-top:16px}
.mrss-article-body h1{font-size:1.5em;margin:.2em 0 .5em}
.mrss-article-body h2{font-size:1.3em;margin:1.7em 0 .55em}
.mrss-article-body h3{font-size:1.12em;margin:1.45em 0 .45em}
.mrss-article-body h4{font-size:1em;margin:1.2em 0 .4em}
.mrss-article-body p{margin:0 0 1em}
.mrss-article-body ul,.mrss-article-body ol{margin:0 0 1.1em;padding-left:1.35em}
.mrss-article-body li{margin:.32em 0}
.mrss-article-body li::marker{color:var(--mrss-muted)}
/* Media runs into the margins: the element stays centred on the padded column
   (relative offset + half-width translate) while its maximum width grows by the
   inline padding on both sides. Narrow images are never upscaled. */
.mrss-article-body :is(img,video):not(figure *):not(.mrss-tweet-video):not(.mrss-embeds *){display:block;width:auto;height:auto;max-inline-size:calc(100% + 2*var(--mrss-pad-inline));position:relative;inset-inline-start:50%;translate:-50% 0;margin:1em 0;border-radius:8px}
.mrss-article-body img{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
/* Feed-native videos (X/Instagram embeds often arrive as <video>) get the same
   ceiling as tweet videos: keep the ratio, never fill the reading pane. */
.mrss-article-body video{max-height:min(420px,60vh);background:#000}
.mrss-embeds{display:flex;flex-direction:column;gap:14px;margin:18px 0 20px}
.mrss-embed{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.mrss-embed iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}
.mrss-tweet{display:flex;flex-direction:column;gap:10px;margin:16px 0 20px}
/* Tweet videos keep their own ratio but never take over the column: the
   height cap keeps vertical clips readable and no upscaling keeps small clips
   small; the block is centred either way. */
.mrss-tweet-video{display:block;align-self:center;width:auto;height:auto;max-width:100%;max-height:min(420px,60vh);margin:0;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:#000}
.mrss-tweet-text{margin:0;white-space:pre-wrap;line-height:1.75;font-size:.98em;color:var(--dsw-alias-label-primary)}
.mrss-article-body figure{position:relative;inset-inline-start:50%;translate:-50% 0;width:max-content;max-inline-size:calc(100% + 2*var(--mrss-pad-inline));margin:1.2em 0}
.mrss-article-body figure :is(img,video){position:static;inset:auto;translate:none;width:auto;height:auto;max-inline-size:100%;margin:0}
/* A fetched original page keeps the img width/height attributes. Without
   height:auto the width attribute is clamped by the column while the height
   attribute stands, and 9to5Google's 1440x810 hero became 655x810 — the picture
   looked squeezed. The attributes still supply the intrinsic ratio (so nothing
   shifts while loading), they just stop dictating the used size. */
.mrss-article-body figcaption{font-size:.8em;line-height:1.55;color:var(--mrss-muted);margin-top:.6em;text-align:center}
.mrss-article-body a{color:var(--mrss-link,var(--dsw-alias-brand-primary));text-decoration-line:underline;text-decoration-color:color-mix(in srgb,currentColor 38%,transparent);text-underline-offset:.2em;text-decoration-thickness:from-font;transition:text-decoration-color .15s ease}
.mrss-article-body a:hover{text-decoration-color:currentColor}
.mrss-article-body a:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:3px}
/* In-page anchors stay quiet; external links carry the underline. */
.mrss-article-body a[href^="#"]{text-decoration:none}
.mrss-article-body blockquote{margin:1.3em 0;padding:.1em 0 .1em 1em;border-inline-start:3px solid color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);color:var(--mrss-muted)}
.mrss-article-body blockquote p:last-child{margin-bottom:0}
.mrss-article-body hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:1.6em 0}
.mrss-article-body sup{position:relative;font-size:.76em;inset-block-start:-.28em;line-height:0;vertical-align:baseline}
.mrss-article-body sub{position:relative;font-size:.76em;inset-block-end:-.2em;line-height:0;vertical-align:baseline}
.mrss-article-body a[data-mrss-fn]{color:inherit;font-weight:700;text-decoration:none;padding:0 2px;border-radius:4px;cursor:pointer}
.mrss-article-body a[data-mrss-fn]:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}
.mrss-article-body [data-mrss-note]{scroll-margin-block:16px}
/* The note list at the end reads as an appendix, not as body text. */
.mrss-article-body :is(ol,ul):has(>li[data-mrss-note]){font-size:.86em;color:var(--mrss-muted);border-top:1px solid var(--dsw-alias-border-l1);margin-top:2em;padding-top:1em}
.mrss-fn-veil{position:absolute;inset:0;z-index:40;background:color-mix(in srgb,#000 30%,transparent);animation:mrss-fade .14s ease}
.mrss-fn-pop{position:fixed;z-index:41;max-width:min(420px,calc(100vw - 32px));max-height:min(58vh,420px);overflow:auto;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:.85rem;line-height:1.65;box-shadow:0 16px 40px rgba(0,0,0,.28);animation:mrss-pop .16s ease}
.mrss-fn-pop p{margin:0 0 .6em}
.mrss-fn-pop p:last-child{margin-bottom:0}
.mrss-fn-pop a[data-mrss-fn-back]{display:none}
.mrss-fn-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.mrss-fn-pop-foot{display:flex;justify-content:flex-end;margin-top:8px}
@keyframes mrss-fade{from{opacity:0}to{opacity:1}}
@keyframes mrss-pop{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.mrss-fn-veil,.mrss-fn-pop{animation:none}}
.mrss-article-body pre{overflow:auto;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;font-size:.82em;line-height:1.6;tab-size:2}
.mrss-article-body code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;background:var(--dsw-alias-bg-layer-2);padding:.1em .32em;border-radius:4px}
.mrss-article-body pre code{background:transparent;padding:0;font-size:inherit}
/* Code blocks get their own header: language on the left, copy on the right. */
.mrss-code{position:relative;margin:1.15em 0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.mrss-code-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 6px 4px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);font-size:11px;color:var(--mrss-muted)}
.mrss-code-lang{font-weight:600;letter-spacing:.05em;text-transform:uppercase;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrss-code-copy{border:0;background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer;padding:2px 7px;border-radius:5px;white-space:nowrap}
.mrss-code-copy:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.mrss-code[data-copied="true"] .mrss-code-copy{color:var(--dsw-alias-state-success-primary,#22c55e)}
.mrss-code pre{margin:0;border:0;border-radius:0;background:transparent;max-height:min(70vh,720px)}
.mrss-article-body table{display:block;overflow-x:auto;max-width:100%;border-collapse:collapse;font-size:.9em;margin:1.1em 0}
.mrss-article-body th,.mrss-article-body td{border:1px solid var(--dsw-alias-border-l1);padding:6px 9px;text-align:left}
.mrss-article-body th{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);font-weight:600}
/* Forced themes: the panel can pin light or dark without waiting for the host.
   Values mirror the Harness alias palette (only the tokens this panel uses). */
.mrss-root[data-mrss-theme="light"]{color-scheme:light;--dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#61666b;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-border-l1:#0000000a;--dsw-alias-border-l2:#0000001a;--dsw-alias-border-l3:#0000001f;--dsw-alias-border-l4:#00000029;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#fff;--dsw-alias-bg-layer-3:#fff;--dsw-alias-brand-primary:#0f1115;--dsw-alias-button-primary-hover:#43454a;--dsw-alias-toast-bg:#353638;--dsw-alias-toast-label:#fff;--dsw-alias-state-error-primary:#ec1313;--dsw-alias-state-warn-primary:#f59e0b;--dsw-alias-state-success-primary:#22c55e;--dsw-alias-state-idle-primary:#d4d4d4}
.mrss-root[data-mrss-theme="dark"]{color-scheme:dark;--dsw-alias-label-primary:#f9fafb;--dsw-alias-label-secondary:#cfd3d6;--dsw-alias-label-primary-foreground:#0f1115;--dsw-alias-border-l1:#ffffff0f;--dsw-alias-border-l2:#ffffff1f;--dsw-alias-border-l3:#ffffff29;--dsw-alias-border-l4:#fff3;--dsw-alias-bg-base:#151517;--dsw-alias-bg-layer-1:#232324;--dsw-alias-bg-layer-2:#2c2c2e;--dsw-alias-bg-layer-3:#353638;--dsw-alias-brand-primary:#f9fafb;--dsw-alias-button-primary-hover:#ebeef2;--dsw-alias-toast-bg:#43454a;--dsw-alias-toast-label:#fff;--dsw-alias-state-error-primary:#f25a5a;--dsw-alias-state-warn-primary:#f59e0b;--dsw-alias-state-success-primary:#22c55e;--dsw-alias-state-idle-primary:#545557}
/* Accent colours replace the brand token; foreground flips to white. */
.mrss-root[data-mrss-accent="blue"]{--dsw-alias-brand-primary:#3b82f6;--dsw-alias-button-primary-hover:#2563eb;--dsw-alias-label-primary-foreground:#fff}
.mrss-root[data-mrss-accent="green"]{--dsw-alias-brand-primary:#22c55e;--dsw-alias-button-primary-hover:#16a34a;--dsw-alias-label-primary-foreground:#fff}
.mrss-root[data-mrss-accent="amber"]{--dsw-alias-brand-primary:#f59e0b;--dsw-alias-button-primary-hover:#dd8629;--dsw-alias-label-primary-foreground:#fff}
.mrss-root[data-mrss-accent="red"]{--dsw-alias-brand-primary:#ef4444;--dsw-alias-button-primary-hover:#dc2626;--dsw-alias-label-primary-foreground:#fff}
.mrss-root[data-mrss-accent="violet"]{--dsw-alias-brand-primary:#7c3aed;--dsw-alias-button-primary-hover:#6d28d9;--dsw-alias-label-primary-foreground:#fff}
/* Reading surface: a warm paper palette for the whole panel (Ringo's light and
   dark grounds). It overrides surfaces and text, not the accent, so an accent
   colour still wins. The mrss-link variable keeps links readable on both. */
.mrss-root[data-mrss-surface="paper"]{--dsw-alias-bg-base:#f5f1e8;--dsw-alias-bg-layer-1:#fcf9f2;--dsw-alias-bg-layer-2:#efe8db;--dsw-alias-bg-layer-3:#e6ddcc;--dsw-alias-border-l1:#e3d9c7;--dsw-alias-border-l2:#d3c7b2;--dsw-alias-border-l3:#c3b5a0;--dsw-alias-border-l4:#a99c85;--dsw-alias-label-primary:#3b3730;--dsw-alias-label-secondary:#6c6558;--dsw-alias-toast-bg:#3b3730;--dsw-alias-toast-label:#fcf9f2;--mrss-link:#0066cc}
.mrss-root[data-mrss-surface="paper"][data-mrss-theme="dark"],
[data-ds-dark-theme] .mrss-root[data-mrss-surface="paper"]:not([data-mrss-theme="light"]){--dsw-alias-bg-base:#1b1b1b;--dsw-alias-bg-layer-1:#222221;--dsw-alias-bg-layer-2:#292c29;--dsw-alias-bg-layer-3:#32352f;--dsw-alias-border-l1:#3b3e39;--dsw-alias-border-l2:#4a4d46;--dsw-alias-border-l3:#5a5d55;--dsw-alias-border-l4:#6d7068;--dsw-alias-label-primary:#e4e4e1;--dsw-alias-label-secondary:#9d9a92;--dsw-alias-toast-bg:#43454a;--dsw-alias-toast-label:#f4f2ee;--mrss-link:#6cb0ff}
@media (prefers-color-scheme:dark){.mrss-root[data-mrss-surface="paper"]:not([data-mrss-theme="light"]){--dsw-alias-bg-base:#1b1b1b;--dsw-alias-bg-layer-1:#222221;--dsw-alias-bg-layer-2:#292c29;--dsw-alias-bg-layer-3:#32352f;--dsw-alias-border-l1:#3b3e39;--dsw-alias-border-l2:#4a4d46;--dsw-alias-border-l3:#5a5d55;--dsw-alias-border-l4:#6d7068;--dsw-alias-label-primary:#e4e4e1;--dsw-alias-label-secondary:#9d9a92;--dsw-alias-toast-bg:#43454a;--dsw-alias-toast-label:#f4f2ee;--mrss-link:#6cb0ff}}
@media (prefers-contrast:more){
.mrss-root[data-mrss-surface="paper"]{--dsw-alias-label-primary:#1c1b19;--dsw-alias-label-secondary:#45423c;--dsw-alias-border-l1:#a89b86;--mrss-link:#004c99}
.mrss-root[data-mrss-surface="paper"][data-mrss-theme="dark"],
[data-ds-dark-theme] .mrss-root[data-mrss-surface="paper"]:not([data-mrss-theme="light"]){--dsw-alias-label-primary:#f4f4f1;--dsw-alias-label-secondary:#c6c3ba;--dsw-alias-border-l1:#6d7068;--mrss-link:#9ac6ff}
}
/* Feed icons */
.mrss-root[data-mrss-favicon="circle"] .mrss-favicon{border-radius:999px}
.mrss-root[data-mrss-favicon-color="grayscale"] .mrss-favicon{filter:grayscale(1)}
/* Article title alignment */
.mrss-article-head{padding:0 0 16px;margin:0 0 20px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mrss-root[data-mrss-title-align="center"] .mrss-article-title{text-align:center}
.mrss-root[data-mrss-title-align="center"] .mrss-article-kicker,.mrss-root[data-mrss-title-align="center"] .mrss-article-meta{justify-content:center;text-align:center}
/* A title's lead before its first colon moves above it, in a smaller size
   (Ringo's kicker); the rest of the title keeps the full size. */
.mrss-article-kicker{display:block;font-size:.76em;font-weight:600;letter-spacing:.05em;color:var(--mrss-muted);margin:0 0 .5em}
.mrss-article-title{font-size:var(--mrss-title-size,1.6em);line-height:1.26;margin:0 0 10px;font-weight:700;text-wrap:balance;color:var(--dsw-alias-label-primary)}
.mrss-article-title-link{color:inherit;text-decoration:none;cursor:pointer}
.mrss-article-title-link:hover{text-decoration:underline;text-decoration-thickness:from-font;text-underline-offset:.14em;text-decoration-color:color-mix(in srgb,currentColor 42%,transparent)}
.mrss-article-title-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:4px;border-radius:4px}
.mrss-article-meta{display:flex;flex-wrap:wrap;align-items:center;gap:5px 8px;font-size:.76em;color:var(--mrss-muted)}
.mrss-article-meta>span,.mrss-article-meta>button{display:inline-flex;align-items:center;gap:5px;min-width:0}
.mrss-meta-favicon{width:14px;height:14px;border-radius:4px;object-fit:cover;flex:none;filter:grayscale(1);opacity:.8}
.mrss-meta-feed{font-weight:600;color:var(--dsw-alias-label-primary);max-width:22ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrss-meta-sep{opacity:.45}
.mrss-meta-date{border:0;background:none;padding:0;font:inherit;color:inherit;cursor:pointer;border-radius:4px;font-variant-numeric:tabular-nums}
.mrss-meta-date:hover{color:var(--dsw-alias-label-primary);text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 40%,transparent);text-underline-offset:.2em}
.mrss-meta-date:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.mrss-toc{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 12px;margin-bottom:20px;background:var(--dsw-alias-bg-layer-1);font-size:12px}
.mrss-toc summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}
.mrss-toc a{display:block;padding:3px 0;color:var(--dsw-alias-label-primary);text-decoration:none}
.mrss-toc a:hover{color:var(--dsw-alias-brand-primary)}
.mrss-toc a[data-level="3"]{padding-left:14px;color:var(--dsw-alias-label-secondary)}
.mrss-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 9px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.mrss-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.mrss-btn[data-tone="primary"]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.mrss-btn[data-tone="primary"]:hover{background:var(--dsw-alias-button-primary-hover)}
.mrss-btn:disabled{opacity:.55;cursor:default}
.mrss-btn[data-icon="true"]{padding:5px;width:30px;height:30px;justify-content:center}
.mrss-btn[data-variant="ghost"]{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.mrss-btn[data-variant="ghost"]:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);color:var(--dsw-alias-label-primary)}
.mrss-btn[data-open="true"],.mrss-btn[data-on="true"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent);color:var(--dsw-alias-label-primary)}
.mrss-btn[data-on="true"]:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 13%,transparent)}
.mrss-side-head .mrss-btn[data-icon="true"]{width:28px;height:28px}
.mrss-cat-tabs{display:flex;align-items:center;gap:6px;padding:10px 10px 6px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;flex:none}
.mrss-cat-tabs::-webkit-scrollbar{display:none}
.mrss-cat-tab{flex:1 1 0;min-width:36px;height:44px;display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);font:600 12.5px/1 inherit;cursor:pointer}
.mrss-cat-tab:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.mrss-cat-tab:not([data-tinted="true"]){background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
.mrss-cat-tab:not([data-tinted="true"]):hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}
.mrss-cat-tab[data-tinted="true"]{background:hsl(var(--mrss-cat-h) 55% 50% / 14%)}
.mrss-cat-tab[data-tinted="true"]:hover{background:hsl(var(--mrss-cat-h) 55% 50% / 24%)}
.mrss-cat-tab[data-active="true"]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}
.mrss-cat-tab .mrss-icon{width:20px;height:20px}
.mrss-side-feeds-head{display:flex;align-items:center;gap:6px;padding:2px 12px 6px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);min-height:24px;flex:none}
.mrss-side-feeds-head .mrss-btn[data-icon="true"]{width:22px;height:22px;padding:2px}
.mrss-side-feeds-head .mrss-count{min-width:0;padding:0;font-size:11px;white-space:nowrap}
.mrss-icon{width:16px;height:16px;display:block;flex:none}
.mrss-input{width:100%;max-width:100%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:inherit;border-radius:6px;padding:5px 8px;font:inherit;font-size:12px;outline:none}
.mrss-input:focus{border-color:var(--dsw-alias-brand-primary)}
.mrss-digest{flex:1;overflow:auto;min-height:0;padding:0 0 80px}
.mrss-digest-inner{max-width:980px;margin:0 auto;padding:18px 26px}
.mrss-digest-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}
.mrss-h1{font-size:19px;font-weight:650;margin:0 0 4px;letter-spacing:.01em}
.mrss-sub{font-size:12px;color:var(--dsw-alias-label-secondary)}
.mrss-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:22px}
.mrss-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}
.mrss-stat-value{font-size:20px;font-weight:650;line-height:1.2;font-variant-numeric:tabular-nums}
.mrss-stat-label{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.mrss-cols{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(240px,1fr);gap:22px;align-items:start}
.mrss-h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin:0 0 8px;display:flex;align-items:center;gap:8px}
.mrss-h2::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l1)}
.mrss-rec{display:flex;gap:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1);cursor:pointer}
.mrss-rec:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1))}
.mrss-rank{width:22px;height:22px;flex:none;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent);color:var(--dsw-alias-brand-primary)}
.mrss-rec-body{min-width:0;flex:1}
.mrss-rec-title{font-size:13.5px;font-weight:600;line-height:1.45;margin-bottom:3px}
.mrss-rec-meta{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.mrss-chips{display:flex;gap:5px;flex-wrap:wrap}
.mrss-chip{font-size:10.5px;padding:2px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}
.mrss-score{margin-left:auto;text-align:right;flex:none;width:54px}
.mrss-score-num{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.mrss-score[data-tier="high"] .mrss-score-num{color:var(--dsw-alias-state-success-primary)}
.mrss-score[data-tier="mid"] .mrss-score-num{color:var(--dsw-alias-state-warn-primary)}
.mrss-score[data-tier="low"] .mrss-score-num{color:var(--dsw-alias-state-idle-primary)}
.mrss-bar{height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);margin-top:4px;overflow:hidden}
.mrss-bar>i{display:block;height:100%;background:currentColor}
.mrss-panel{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-1);margin-bottom:14px}
.mrss-feedrow{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px}
.mrss-feedrow .mrss-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrss-mini-bar{width:64px;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;flex:none}
.mrss-mini-bar>i{display:block;height:100%;background:var(--dsw-alias-brand-primary)}
.mrss-timeline{display:flex;align-items:flex-end;gap:3px;height:44px;margin:6px 0 4px}
.mrss-timeline>i{flex:1;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 65%,transparent);border-radius:2px 2px 0 0;min-height:2px}
.mrss-timeline-labels{display:flex;justify-content:space-between;font-size:10px;color:var(--dsw-alias-label-secondary)}
.mrss-stance{display:flex;height:8px;border-radius:4px;overflow:hidden;margin:6px 0 8px;background:var(--dsw-alias-bg-layer-2)}
.mrss-stance>i{display:block;height:100%}
.mrss-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.mrss-legend b{font-weight:600;color:var(--dsw-alias-label-primary)}
.mrss-swatch{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:4px;vertical-align:middle}
.mrss-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:22px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.mrss-setup{max-width:460px;margin:40px auto;padding:22px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.mrss-field{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}
.mrss-field>span{font-size:12px;color:var(--dsw-alias-label-secondary)}
.mrss-setup-actions{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap}
.mrss-banner{display:flex;align-items:center;gap:10px;padding:7px 12px;font-size:12px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);border-bottom:1px solid var(--dsw-alias-border-l1)}
.mrss-banner .mrss-grow{flex:1}
.mrss-center{flex:1;display:flex;align-items:center;justify-content:center;padding:40px;color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center}
/* First-paint placeholders. They stand in for "account / feeds / entries" only
   while the very first fetch is in flight (no saved snapshot), so the panel
   never flashes "Not connected" or "no feeds" before the data lands. */
.mrss-skeleton{display:flex;flex-direction:column;gap:9px;padding:12px 8px}
.mrss-skel-row{height:11px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent);animation:mrss-skel-pulse 1.5s ease-in-out infinite}
.mrss-skel-list{padding:4px 0;gap:0}
.mrss-skel-item{padding:11px 12px;display:flex;flex-direction:column;gap:7px}
.mrss-skel-item+.mrss-skel-item{border-top:1px solid var(--dsw-alias-border-l1)}
.mrss-skel-account{display:flex;align-items:center;gap:9px;min-width:0}
.mrss-skel-avatar{width:26px;height:26px;border-radius:50%;flex:none;background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);animation:mrss-skel-pulse 1.5s ease-in-out infinite}
@keyframes mrss-skel-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.mrss-skel-row,.mrss-skel-avatar{animation:none;opacity:.7}}
.mrss-void{display:flex;flex-direction:column;align-items:center;gap:10px}
.mrss-void-icon{opacity:.45}
.mrss-manage{position:absolute;inset:0;z-index:12;display:flex;background:color-mix(in srgb,#000 22%,transparent)}
.mrss-manage-card{margin:auto;width:min(880px,94%);max-height:88%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.28);overflow:hidden}
.mrss-manage-head{display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mrss-manage-body{display:flex;min-height:0;flex:1}
.mrss-manage-nav{width:170px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);padding:10px 8px;display:flex;flex-direction:column;gap:2px}
.mrss-manage-content{flex:1;min-width:0;overflow:auto;padding:16px 18px 28px}
.mrss-manage-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mrss-manage-row .mrss-grow{display:flex;flex-direction:column;gap:2px;min-width:0}
.mrss-row-title{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrss-row-sub{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrss-row-actions{display:flex;gap:4px;flex:none}
.mrss-form-row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin:12px 0}
.mrss-input-inline{min-width:220px;flex:1}
.mrss-favicon{width:16px;height:16px;border-radius:4px;flex:none;object-fit:cover;background:var(--dsw-alias-bg-layer-2)}
/* Letter tile: painted before the icon batch answers (and stays for feeds with
   no icon, where the old code simply hid the <img> and left a hole). */
.mrss-favicon--tile,.mrss-meta-favicon.mrss-favicon--tile{display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;line-height:1;letter-spacing:0;overflow:hidden;
  background:color-mix(in srgb,hsl(var(--mrss-fav-h,212) 62% 52%) 20%,var(--dsw-alias-bg-layer-2));
  color:color-mix(in srgb,hsl(var(--mrss-fav-h,212) 62% 42%) 68%,var(--dsw-alias-label-primary))}
/* The real icon fades in over the tile instead of popping in. */
.mrss-favicon--in{animation:mrss-fav-in .18s ease-out both}
@keyframes mrss-fav-in{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.mrss-favicon--in{animation:none}}
.mrss-pref-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12.5px}
.mrss-pref-row>div:first-child{min-width:0;color:var(--dsw-alias-label-secondary)}
.mrss-pref-label{display:flex;flex-direction:column;gap:2px}
.mrss-pref-hint{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);opacity:.85}
.mrss-slider{display:flex;align-items:center;gap:8px;flex:none}
.mrss-seg{display:inline-flex;gap:2px;padding:2px;flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.mrss-seg-btn{border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;padding:4px 9px;cursor:pointer;white-space:nowrap}
.mrss-seg-btn:hover{color:var(--dsw-alias-label-primary)}
.mrss-seg-btn[data-active="true"]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}
.mrss-swatches{display:flex;align-items:center;gap:7px;flex:none}
.mrss-swatch{width:22px;height:22px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;cursor:pointer}
.mrss-swatch[data-default="true"]{background:conic-gradient(from 210deg,#ef4444,#f59e0b,#22c55e,#3b82f6,#7c3aed,#ef4444)}
.mrss-swatch[data-active="true"]{box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1),0 0 0 4px var(--dsw-alias-label-primary)}
.mrss-link{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-brand-primary);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent)}
.mrss-link:hover{border-bottom-color:var(--dsw-alias-brand-primary)}
.mrss-pref-foot{margin-top:16px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.mrss-about{padding:4px 0}
.mrss-about-name{font-size:16px;font-weight:650;color:var(--dsw-alias-label-primary)}
.mrss-about-version{margin-top:2px;font-size:11.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.mrss-about-made{margin-top:10px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.mrss-ack{margin:6px 0 0;padding-left:18px;font-size:12px;line-height:1.9;color:var(--dsw-alias-label-secondary)}
.mrss-ack li::marker{color:var(--dsw-alias-border-l4)}
.mrss-pref-row>span:first-child{color:var(--dsw-alias-label-secondary)}
.mrss-switch{width:34px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);position:relative;cursor:pointer;padding:0;flex:none}
.mrss-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:left .15s,background .15s}
.mrss-switch[data-on="true"]{background:var(--dsw-alias-brand-primary);border-color:transparent}
.mrss-switch[data-on="true"]::after{left:16px;background:var(--dsw-alias-label-primary-foreground)}
.mrss-root input[type="range"]{accent-color:var(--dsw-alias-brand-primary)}
.mrss-kbd{font:11px ui-monospace,Menlo,monospace;border:1px solid var(--dsw-alias-border-l2);border-bottom-width:2px;border-radius:4px;padding:1px 5px;background:var(--dsw-alias-bg-layer-2)}
.mrss-select{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:6px 8px;font:inherit;font-size:12.5px;min-width:210px;max-width:280px;outline:none}
.mrss-select:focus{border-color:var(--dsw-alias-brand-primary)}
.mrss-spinner{width:14px;height:14px;flex:none;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:mrss-spin .8s linear infinite}
.mrss-topic-row{display:flex;gap:12px;padding:13px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mrss-topic-rank{width:24px;height:24px;flex:none;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);font-variant-numeric:tabular-nums}
.mrss-topic-body{flex:1;min-width:0}
.mrss-topic-name{font-size:13.5px;font-weight:600;margin-bottom:3px}
.mrss-topic-summary{font-size:13px;line-height:1.7}
.mrss-topic-stats{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:5px;font-variant-numeric:tabular-nums}
.mrss-toast{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);border:1px solid transparent;border-radius:999px;padding:6px 14px;font-size:12px;box-shadow:0 6px 18px rgba(0,0,0,.18);z-index:5;max-width:80%}
.mrss-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.mrss-rec-actions{display:flex;gap:6px;margin-top:8px}
.mrss-muted{color:var(--dsw-alias-label-secondary)}
.mrss-spin{animation:mrss-spin 1s linear infinite}
@keyframes mrss-spin{to{transform:rotate(360deg)}}
.mrss-menu-layer{position:fixed;inset:0;z-index:30}
.mrss-menu{position:fixed;width:224px;padding:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px rgba(0,0,0,.22);display:flex;flex-direction:column;gap:1px}
.mrss-menu-title{padding:6px 9px 4px;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrss-menu-item{display:flex;align-items:center;gap:9px;width:100%;height:30px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;text-align:left}
.mrss-menu-item:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
.mrss-menu-item[data-danger="true"]{color:var(--dsw-alias-state-error-primary)}
.mrss-menu-item[data-danger="true"]:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.mrss-menu-item[data-sub="true"]{height:auto;min-height:38px;padding:5px 9px}
.mrss-menu-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.mrss-menu-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrss-menu-sub{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrss-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1)}
.mrss-dialog-layer{position:fixed;inset:0;z-index:31;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,#000 28%,transparent);backdrop-filter:blur(2px)}
.mrss-dialog{width:min(400px,92%);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 18px 48px rgba(0,0,0,.26);padding:16px 16px 14px;display:flex;flex-direction:column;gap:12px}
.mrss-dialog-head{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600}
.mrss-dialog-body{display:flex;flex-direction:column;gap:10px;font-size:12.5px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.mrss-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.mrss-dialog[data-kind="feed"]{width:min(560px,94%)}
.mrss-dialog[data-kind="feed"] .mrss-select{width:100%;max-width:none;background:var(--dsw-alias-bg-base);padding:5px 8px;font-size:12px}
.mrss-dialog[data-kind="categoryIcon"]{width:min(520px,94%)}
.mrss-icon-picker{display:flex;flex-direction:column;gap:9px;min-width:0}
.mrss-icon-hint{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.mrss-icon-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:4px;max-height:250px;overflow:auto;padding:2px}
.mrss-icon-cell{display:flex;align-items:center;justify-content:center;height:34px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.mrss-icon-cell:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.mrss-icon-cell[data-active="true"]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}
.mrss-icon-empty{grid-column:1/-1;padding:20px 0;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary)}
.mrss-url-group{display:flex;flex-direction:column;gap:8px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.mrss-url-block{display:flex;flex-direction:column;gap:2px;min-width:0}
.mrss-url-head{display:flex;align-items:center;gap:6px;min-height:20px}
.mrss-url-label{flex:1;min-width:0;font-size:11px;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.mrss-url-head .mrss-btn[data-icon="true"]{width:24px;height:24px;padding:3px}
.mrss-url-head .mrss-btn[data-copied="true"]{color:var(--dsw-alias-state-success-primary)}
.mrss-url-copied{font-size:11px;line-height:1;white-space:nowrap;color:var(--dsw-alias-state-success-primary)}
.mrss-url-copied[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.mrss-url-value{display:block;min-width:0;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,"SF Mono",monospace;overflow-wrap:anywhere;word-break:break-word;user-select:text;cursor:text}
.mrss-url-value[data-empty="true"]{color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px}
.mrss-url-group>.mrss-btn{align-self:flex-start;margin-top:2px;text-decoration:none}
.mrss-addfeed{width:min(500px,94%)}
.mrss-accounts{width:min(440px,94%);max-height:86%}
.mrss-accounts .mrss-field{margin-bottom:0}
.mrss-accounts .mrss-dialog-body{overflow:auto;gap:10px}
.mrss-field-hint{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.mrss-auth-divider{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.mrss-auth-divider::before,.mrss-auth-divider::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l1)}
.mrss-auth-switch{display:flex;justify-content:center;margin-top:-2px}
.mrss-addfeed .mrss-dialog-body{gap:10px}
.mrss-addfeed-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}
.mrss-addfeed-summary{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}
.mrss-addfeed-summary .mrss-grow{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrss-addfeed-list{display:flex;flex-direction:column;gap:4px;max-height:230px;overflow:auto;padding:1px}
.mrss-addfeed-item{display:flex;align-items:center;gap:9px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);cursor:pointer}
.mrss-addfeed-item:hover{border-color:var(--dsw-alias-border-l3)}
.mrss-addfeed-item[data-active="true"]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent)}
.mrss-radio-input{position:absolute;width:0;height:0;opacity:0;pointer-events:none}
.mrss-radio{width:14px;height:14px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l4);box-sizing:border-box;flex:none;display:flex;align-items:center;justify-content:center}
.mrss-addfeed-item[data-active="true"] .mrss-radio{border-color:var(--dsw-alias-label-primary)}
.mrss-addfeed-item[data-active="true"] .mrss-radio::after{content:"";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-primary)}
.mrss-radio-input:focus-visible+.mrss-radio{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.mrss-addfeed-meta{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.mrss-addfeed-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrss-addfeed-url{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.mrss-addfeed-category{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.mrss-addfeed-category .mrss-select{min-width:200px}
.mrss-addfeed-error{padding:7px 9px;border-radius:7px;font-size:12px;line-height:1.5;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.mrss-item-more{position:absolute;top:6px;right:6px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent);color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;transition:opacity .12s ease}
.mrss-item:hover .mrss-item-more,.mrss-item:focus-within .mrss-item-more{opacity:1}
.mrss-item-more:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mrss-row-more{width:22px;height:22px;flex:none;display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0}
.mrss-sidefeed:hover .mrss-row-more,.mrss-row-more:focus-visible{opacity:1}
.mrss-row-more:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.mrss-rail{position:absolute;top:56px;bottom:20px;right:4px;width:18px;z-index:2;pointer-events:none}
.mrss-rail-track{position:absolute;top:0;bottom:0;right:8px;width:2px;border-radius:2px;background:var(--dsw-alias-border-l2)}
.mrss-rail-fill{position:absolute;top:0;right:8px;width:2px;border-radius:2px;background:var(--dsw-alias-brand-primary);transition:height .1s linear}
.mrss-rail-tick{position:absolute;right:2px;width:10px;height:3px;padding:0;border:0;appearance:none;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 28%,transparent);pointer-events:auto;cursor:pointer;transition:background .12s ease,width .12s ease}
.mrss-rail-tick:hover{background:var(--dsw-alias-label-primary);width:14px}
.mrss-rail-tick[data-active="true"]{background:var(--dsw-alias-brand-primary);width:12px}
.mrss-loadmore{display:flex;align-items:center;justify-content:center;gap:8px;width:calc(100% - 24px);margin:10px 12px 20px;height:32px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.mrss-loadmore:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.mrss-loadmore:disabled{cursor:default;opacity:.6}
@media (max-width:1100px){.mrss-cols{grid-template-columns:1fr}.mrss-stats{grid-template-columns:repeat(2,1fr)}}
@media (max-width:900px){.mrss-side{width:176px}.mrss-list{width:280px}}
`

    // ---------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------

    const paths = {
      feed: ['M4 11a9 9 0 0 1 9 9', 'M4 4a16 16 0 0 1 16 16', 'M5 19a1.5 1.5 0 1 0 0-.01'],
      digest: ['M4 5h16', 'M4 10h10', 'M4 15h16', 'M4 20h7'],
      list: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
      star: ['M12 3.6l2.5 5.1 5.6.8-4 4 1 5.6-5.1-2.7-5 2.7 1-5.6-4.1-4 5.6-.8z'],
      check: ['M4 12.5l5 5L20 6.5'],
      refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
      search: ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M15.5 15.5L21 21'],
      external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
      copy: ['M9 9h10v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V9z', 'M6 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1'],
      gear: ['M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z', 'M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14.1 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z'],
      back: ['M15 5l-7 7 7 7'],
      user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 20c0-3.3 3.6-5 8-5s8 1.7 8 5'],
      trash: ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13'],
      edit: ['M4 20h4l10-10-4-4L4 16v4z', 'M13 5l4 4'],
      download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
      upload: ['M12 16V5', 'M7 10l5-5 5 5', 'M5 20h14'],
      close: ['M6 6l12 12', 'M18 6L6 18'],
      folder: ['M3 7h6l2 2h10v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z'],
      chevron: ['M9 6l6 6-6 6'],
      next: ['M9 5l7 7-7 7'],
      plus: ['M12 5v14', 'M5 12h14'],
      share: ['M12 15V4', 'M8 8l4-4 4 4', 'M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5'],
      inbox: ['M4 13l2.2-7.2A1 1 0 0 1 7.2 5h9.6a1 1 0 0 1 1 .8L20 13', 'M4 13h4.5l1.2 2.2h4.6L15.5 13H20v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5z'],
    }

    // Category icons from Lucide (https://lucide.dev, ISC licence).
    // Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as
    // part of Feather (MIT); other copyright (c) Lucide Contributors 2022.
    // Inline SVG bodies keep the client buildless; Icon renders them through
    // innerHTML.
    const LUCIDE_ICONS = {
      "align-left": "<path d=\"M21 6H3\" /><path d=\"M15 12H3\" /><path d=\"M17 18H3\" />",
      "atom": "<circle cx=\"12\" cy=\"12\" r=\"1\" /> <path d=\"M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z\" /> <path d=\"M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z\" />",
      "baby": "<path d=\"M10 16c.5.3 1.2.5 2 .5s1.5-.2 2-.5\" /> <path d=\"M15 12h.01\" /> <path d=\"M19.38 6.813A9 9 0 0 1 20.8 10.2a2 2 0 0 1 0 3.6 9 9 0 0 1-17.6 0 2 2 0 0 1 0-3.6A9 9 0 0 1 12 3c2 0 3.5 1.1 3.5 2.5s-.9 2.5-2 2.5c-.8 0-1.5-.4-1.5-1\" /> <path d=\"M9 12h.01\" />",
      "banknote": "<rect width=\"20\" height=\"12\" x=\"2\" y=\"6\" rx=\"2\" /> <circle cx=\"12\" cy=\"12\" r=\"2\" /> <path d=\"M6 12h.01M18 12h.01\" />",
      "bike": "<circle cx=\"18.5\" cy=\"17.5\" r=\"3.5\" /> <circle cx=\"5.5\" cy=\"17.5\" r=\"3.5\" /> <circle cx=\"15\" cy=\"5\" r=\"1\" /> <path d=\"M12 17.5V14l-3-3 4-3 2 3h2\" />",
      "arrow-down-1-0": "<path d=\"m3 16 4 4 4-4\" /> <path d=\"M7 20V4\" /> <path d=\"M17 10V4h-2\" /> <path d=\"M15 10h4\" /> <rect x=\"15\" y=\"14\" width=\"4\" height=\"6\" ry=\"2\" />",
      "arrow-down-a-z": "<path d=\"m3 16 4 4 4-4\" /> <path d=\"M7 20V4\" /> <path d=\"M20 8h-5\" /> <path d=\"M15 10V6.5a2.5 2.5 0 0 1 5 0V10\" /> <path d=\"M15 14h5l-5 6h5\" />",
      "book-open": "<path d=\"M12 5v16\" /><path d=\"M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z\" />",
      "bookmark": "<path d=\"M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z\" />",
      "briefcase": "<path d=\"M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16\" /><rect width=\"20\" height=\"14\" x=\"2\" y=\"6\" rx=\"2\" />",
      "building-2": "<path d=\"M10 12h4\" /> <path d=\"M10 8h4\" /> <path d=\"M14 21v-3a2 2 0 0 0-4 0v3\" /> <path d=\"M6 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2\" /> <path d=\"M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16\" />",
      "camera": "<path d=\"M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z\" /><circle cx=\"12\" cy=\"13\" r=\"3\" />",
      "car": "<path d=\"M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2\" /><circle cx=\"7\" cy=\"17\" r=\"2\" /><path d=\"M9 17h6\" /><circle cx=\"17\" cy=\"17\" r=\"2\" />",
      "chart-line": "<path d=\"M3 3v16a2 2 0 0 0 2 2h16\" /><path d=\"m19 9-5 5-4-4-3 3\" />",
      "circle": "<circle cx=\"12\" cy=\"12\" r=\"10\" />",
      "circle-check": "<circle cx=\"12\" cy=\"12\" r=\"10\" /><path d=\"m9 12 2 2 4-4\" />",
      "clapperboard": "<path d=\"m12.296 3.464 3.02 3.956\" /><path d=\"M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z\" /><path d=\"M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\" /><path d=\"m6.18 5.276 3.1 3.899\" />",
      "cloud": "<path d=\"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z\" />",
      "code": "<path d=\"m16 18 6-6-6-6\" /> <path d=\"m8 6-6 6 6 6\" />",
      "coins": "<path d=\"M13.744 17.736a6 6 0 1 1-7.48-7.48\" /> <path d=\"M15 6h1v4\" /> <path d=\"m6.134 14.768.866-.5 2 3.464\" /> <circle cx=\"16\" cy=\"8\" r=\"6\" />",
      "compass": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z\" />",
      "cpu": "<path d=\"M12 20v2\" /><path d=\"M12 2v2\" /><path d=\"M17 20v2\" /><path d=\"M17 2v2\" /><path d=\"M2 12h2\" /><path d=\"M2 17h2\" /><path d=\"M2 7h2\" /><path d=\"M20 12h2\" /><path d=\"M20 17h2\" /><path d=\"M20 7h2\" /><path d=\"M7 20v2\" /><path d=\"M7 2v2\" /><rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"2\" /><rect x=\"8\" y=\"8\" width=\"8\" height=\"8\" rx=\"1\" />",
      "credit-card": "<rect width=\"20\" height=\"14\" x=\"2\" y=\"5\" rx=\"2\" /> <line x1=\"2\" x2=\"22\" y1=\"10\" y2=\"10\" /> <path d=\"M6 14h2\" />",
      "database": "<ellipse cx=\"12\" cy=\"5\" rx=\"9\" ry=\"3\" /> <path d=\"M3 5V19A9 3 0 0 0 21 19V5\" /> <path d=\"M3 12A9 3 0 0 0 21 12\" />",
      "dna": "<path d=\"m10 16 1.5 1.5\" /> <path d=\"m14 8-1.5-1.5\" /> <path d=\"M15 2c-1.798 1.998-2.518 3.995-2.807 5.993\" /> <path d=\"m16.5 10.5 1 1\" /> <path d=\"m17 6-2.891-2.891\" /> <path d=\"M2 15c6.667-6 13.333 0 20-6\" /> <path d=\"m20 9 .891.891\" /> <path d=\"M3.109 14.109 4 15\" /> <path d=\"m6.5 12.5 1 1\" /> <path d=\"m7 18 2.891 2.891\" /> <path d=\"M9 22c1.798-1.998 2.518-3.995 2.807-5.993\" />",
      "droplet": "<path d=\"M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z\" />",
      "dumbbell": "<path d=\"M17.596 12.768a2 2 0 1 0 2.829-2.829l-1.768-1.767a2 2 0 0 0 2.828-2.829l-2.828-2.828a2 2 0 0 0-2.829 2.828l-1.767-1.768a2 2 0 1 0-2.829 2.829z\" /><path d=\"m2.5 21.5 1.4-1.4\" /><path d=\"m20.1 3.9 1.4-1.4\" /><path d=\"M5.343 21.485a2 2 0 1 0 2.829-2.828l1.767 1.768a2 2 0 1 0 2.829-2.829l-6.364-6.364a2 2 0 1 0-2.829 2.829l1.768 1.767a2 2 0 0 0-2.828 2.829z\" /><path d=\"m9.6 14.4 4.8-4.8\" />",
      "feather": "<path d=\"M14.086 18.412A2 2 0 0112.67 19H5v-7.672a2 2 0 01.586-1.414L11.75 3.75a6 6 0 118.49 8.49z\" /> <path d=\"M16 8 2 22\" /> <path d=\"M17.488 15H9\" />",
      "film": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" /> <path d=\"M7 3v18\" /> <path d=\"M3 7.5h4\" /> <path d=\"M3 12h18\" /> <path d=\"M3 16.5h4\" /> <path d=\"M17 3v18\" /> <path d=\"M17 7.5h4\" /> <path d=\"M17 16.5h4\" />",
      "flame": "<path d=\"M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4\" />",
      "flask-conical": "<path d=\"M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2\" /><path d=\"M6.453 15h11.094\" /><path d=\"M8.5 2h7\" />",
      "folder": "<path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\" />",
      "gamepad-2": "<line x1=\"6\" x2=\"10\" y1=\"11\" y2=\"11\" /><line x1=\"8\" x2=\"8\" y1=\"9\" y2=\"13\" /><line x1=\"15\" x2=\"15.01\" y1=\"12\" y2=\"12\" /><line x1=\"18\" x2=\"18.01\" y1=\"10\" y2=\"10\" /><path d=\"M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z\" />",
      "globe": "<circle cx=\"12\" cy=\"12\" r=\"10\" /><path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\" /><path d=\"M2 12h20\" />",
      "graduation-cap": "<path d=\"M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z\" /> <path d=\"M22 10v6\" /> <path d=\"M6 12.5V16a6 3 0 0 0 12 0v-3.5\" />",
      "hammer": "<path d=\"m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9\" /> <path d=\"m18 15 4-4\" /> <path d=\"m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5\" />",
      "headphones": "<path d=\"M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3\" />",
      "heart-pulse": "<path d=\"M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5\" /><path d=\"M3.22 13H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27\" />",
      "house": "<path d=\"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8\" /> <path d=\"M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\" />",
      "keyboard": "<path d=\"M10 8h.01\" /> <path d=\"M12 12h.01\" /> <path d=\"M14 8h.01\" /> <path d=\"M16 12h.01\" /> <path d=\"M18 8h.01\" /> <path d=\"M6 8h.01\" /> <path d=\"M7 16h10\" /> <path d=\"M8 12h.01\" /> <rect width=\"20\" height=\"16\" x=\"2\" y=\"4\" rx=\"2\" />",
      "key-round": "<path d=\"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z\" /> <circle cx=\"16.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\" />",
      "landmark": "<path d=\"M10 18v-7\" /><path d=\"M11.119 2.205a2 2 0 0 1 1.762 0l7.84 3.846A.5.5 0 0 1 20.5 7h-17a.5.5 0 0 1-.22-.949z\" /><path d=\"M14 18v-7\" /><path d=\"M18 18v-7\" /><path d=\"M3 22h18\" /><path d=\"M6 18v-7\" />",
      "layout-grid": "<rect width=\"7\" height=\"7\" x=\"3\" y=\"3\" rx=\"1\" /><rect width=\"7\" height=\"7\" x=\"14\" y=\"3\" rx=\"1\" /><rect width=\"7\" height=\"7\" x=\"14\" y=\"14\" rx=\"1\" /><rect width=\"7\" height=\"7\" x=\"3\" y=\"14\" rx=\"1\" />",
      "leaf": "<path d=\"M11 20a10 10 0 0010-10 25.9 25.9 0 00-1.04-7.281 1 1 0 00-1.755-.325C15.833 5.5 13 5.5 9.8 6.1A7 7 0 0011 20\" /> <path d=\"M2 21a5 5 0 012.911-4.544C7.613 15.212 8.351 15.24 11 13\" />",
      "library": "<path d=\"m16 6 4 14\" /> <path d=\"M12 6v14\" /> <path d=\"M8 8v12\" /> <path d=\"M4 4v16\" />",
      "lightbulb": "<path d=\"M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5\" /> <path d=\"M9 18h6\" /> <path d=\"M10 22h4\" />",
      "link": "<path d=\"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\" /> <path d=\"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\" />",
      "list": "<path d=\"M3 5h.01\" /> <path d=\"M3 12h.01\" /> <path d=\"M3 19h.01\" /> <path d=\"M8 5h13\" /> <path d=\"M8 12h13\" /> <path d=\"M8 19h13\" />",
      "log-out": "<path d=\"m16 17 5-5-5-5\" /> <path d=\"M21 12H9\" /> <path d=\"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4\" />",
      "mail": "<path d=\"m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7\" /> <rect x=\"2\" y=\"4\" width=\"20\" height=\"16\" rx=\"2\" />",
      "map": "<path d=\"M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z\" /> <path d=\"M15 5.764v15\" /> <path d=\"M9 3.236v15\" />",
      "map-pin": "<path d=\"M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0\" /> <circle cx=\"12\" cy=\"10\" r=\"3\" />",
      "maximize": "<path d=\"M8 3H5a2 2 0 0 0-2 2v3\" /><path d=\"M21 8V5a2 2 0 0 0-2-2h-3\" /><path d=\"M3 16v3a2 2 0 0 0 2 2h3\" /><path d=\"M16 21h3a2 2 0 0 0 2-2v-3\" />",
      "megaphone": "<path d=\"M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z\" /> <path d=\"M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14\" /> <path d=\"M8 6v8\" />",
      "message-circle": "<path d=\"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719\" />",
      "mic": "<path d=\"M12 19v3\" /> <path d=\"M19 10v2a7 7 0 0 1-14 0v-2\" /> <rect x=\"9\" y=\"2\" width=\"6\" height=\"13\" rx=\"3\" />",
      "microscope": "<path d=\"M6 18h8\" /> <path d=\"M3 22h18\" /> <path d=\"M14 22a7 7 0 1 0 0-14h-1\" /> <path d=\"M9 14h2\" /> <path d=\"M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z\" /> <path d=\"M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3\" />",
      "minimize": "<path d=\"M8 3v3a2 2 0 0 1-2 2H3\" /><path d=\"M21 8h-3a2 2 0 0 1-2-2V3\" /><path d=\"M3 16h3a2 2 0 0 1 2 2v3\" /><path d=\"M16 21v-3a2 2 0 0 1 2-2h3\" />",
      "monitor": "<rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\" /> <line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\" /> <line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\" />",
      "moon": "<path d=\"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401\" />",
      "mountain": "<path d=\"m8 3 4 8 5-5 5 15H2L8 3z\" />",
      "music": "<path d=\"M21 16V3a1 1 0 0 0-1.28-.96l-10 2.917a1 1 0 0 0-.72.96V19\" /> <circle cx=\"18\" cy=\"16\" r=\"3\" /> <circle cx=\"6\" cy=\"19\" r=\"3\" />",
      "newspaper": "<path d=\"M15 18h-5\" /><path d=\"M18 14h-8\" /><path d=\"M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2\" /><rect width=\"8\" height=\"4\" x=\"10\" y=\"6\" rx=\"1\" />",
      "notebook": "<path d=\"M2 6h4\" /> <path d=\"M2 10h4\" /> <path d=\"M2 14h4\" /> <path d=\"M2 18h4\" /> <rect width=\"16\" height=\"20\" x=\"4\" y=\"2\" rx=\"2\" /> <path d=\"M16 2v20\" />",
      "paintbrush": "<path d=\"m14.622 17.897-10.68-2.913\" /> <path d=\"M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z\" /> <path d=\"M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15\" />",
      "palette": "<path d=\"M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z\" /><circle cx=\"13.5\" cy=\"6.5\" r=\".5\" fill=\"currentColor\" /><circle cx=\"17.5\" cy=\"10.5\" r=\".5\" fill=\"currentColor\" /><circle cx=\"6.5\" cy=\"12.5\" r=\".5\" fill=\"currentColor\" /><circle cx=\"8.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\" />",
      "panel-left-close": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" /><path d=\"M9 3v18\" /><path d=\"m16 15-3-3 3-3\" />",
      "panel-left-open": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" /><path d=\"M9 3v18\" /><path d=\"m14 9 3 3-3 3\" />",
      "paw-print": "<circle cx=\"11\" cy=\"4\" r=\"2\" /> <circle cx=\"18\" cy=\"8\" r=\"2\" /> <circle cx=\"20\" cy=\"16\" r=\"2\" /> <path d=\"M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z\" />",
      "pen-tool": "<path d=\"m18 13-.654-4.736a4 4 0 00-2.756-3.266l-9.163-2.9a2 2 0 00-2.017.493l-.82.819a2 2 0 00-.492 2.017l2.9 9.163a4 4 0 003.266 2.756L13 18\" /><path d=\"M18.648 12.352a1.205 1.205 0 011.704 0l1.296 1.296a1.205 1.205 0 010 1.704l-6.296 6.296a1.205 1.205 0 01-1.704 0l-1.296-1.296a1.205 1.205 0 010-1.704z\" /><path d=\"m3 3 6.586 6.586\" /><circle cx=\"11\" cy=\"11\" r=\"2\" />",
      "pill": "<path d=\"m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z\" /> <path d=\"m8.5 8.5 7 7\" />",
      "plane": "<path d=\"M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z\" />",
      "puzzle": "<path d=\"M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z\" />",
      "radio": "<path d=\"M16.247 7.761a6 6 0 0 1 0 8.478\" /> <path d=\"M19.075 4.933a10 10 0 0 1 0 14.134\" /> <path d=\"M4.925 19.067a10 10 0 0 1 0-14.134\" /> <path d=\"M7.753 16.239a6 6 0 0 1 0-8.478\" /> <circle cx=\"12\" cy=\"12\" r=\"2\" />",
      "rocket": "<path d=\"M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5\" /> <path d=\"M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09\" /> <path d=\"M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z\" /> <path d=\"M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05\" />",
      "rss": "<path d=\"M4 11a9 9 0 0 1 9 9\" /> <path d=\"M4 4a16 16 0 0 1 16 16\" /> <circle cx=\"5\" cy=\"19\" r=\"1\" />",
      "shapes": "<path d=\"M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z\" /> <rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"1\" /> <circle cx=\"17.5\" cy=\"17.5\" r=\"3.5\" />",
      "share-2": "<circle cx=\"18\" cy=\"5\" r=\"3\" /> <circle cx=\"6\" cy=\"12\" r=\"3\" /> <circle cx=\"18\" cy=\"19\" r=\"3\" /> <line x1=\"8.59\" x2=\"15.42\" y1=\"13.51\" y2=\"17.49\" /> <line x1=\"15.41\" x2=\"8.59\" y1=\"6.51\" y2=\"10.49\" />",
      "shopping-bag": "<path d=\"M16 10a4 4 0 0 1-8 0\" /> <path d=\"M3.103 6.034h17.794\" /> <path d=\"M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z\" />",
      "shopping-cart": "<path d=\"m2.05 2.05 1.099-.028a1 1 0 0 1 1.008.815l2.69 14.347A1 1 0 0 0 7.83 18H18\" /> <path d=\"M4.563 5h16.435a1 1 0 0 1 .981 1.204l-1.026 6.226A2 2 0 0 1 18.962 14H6.25\" /> <circle cx=\"18\" cy=\"20\" r=\"2\" /> <circle cx=\"8\" cy=\"20\" r=\"2\" />",
      "sparkles": "<path d=\"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z\" /> <path d=\"M20 2v4\" /> <path d=\"M22 4h-4\" /> <circle cx=\"4\" cy=\"20\" r=\"2\" />",
      "sprout": "<path d=\"M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3\" /> <path d=\"M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4\" /> <path d=\"M5 21h14\" />",
      "star": "<path d=\"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z\" />",
      "stethoscope": "<path d=\"M11 2v2\" /> <path d=\"M5 2v2\" /> <path d=\"M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1\" /> <path d=\"M8 15a6 6 0 0 0 12 0v-3\" /> <circle cx=\"20\" cy=\"10\" r=\"2\" />",
      "sun": "<circle cx=\"12\" cy=\"12\" r=\"4\" /> <path d=\"M12 2v2\" /> <path d=\"M12 20v2\" /> <path d=\"m4.93 4.93 1.41 1.41\" /> <path d=\"m17.66 17.66 1.41 1.41\" /> <path d=\"M2 12h2\" /> <path d=\"M20 12h2\" /> <path d=\"m6.34 17.66-1.41 1.41\" /> <path d=\"m19.07 4.93-1.41 1.41\" />",
      "tag": "<path d=\"M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z\" /> <circle cx=\"7.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\" />",
      "telescope": "<path d=\"m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44\" /> <path d=\"m13.56 11.747 4.332-.924\" /> <path d=\"m16 21-3.105-6.21\" /> <path d=\"M16.485 5.94a2 2 0 0 1 1.455-2.425l1.09-.272a1 1 0 0 1 1.212.727l1.515 6.06a1 1 0 0 1-.727 1.213l-1.09.272a2 2 0 0 1-2.425-1.455z\" /> <path d=\"m6.158 8.633 1.114 4.456\" /> <path d=\"m8 21 3.105-6.21\" /> <circle cx=\"12\" cy=\"13\" r=\"2\" />",
      "terminal": "<path d=\"M12 19h8\" /> <path d=\"m4 17 6-6-6-6\" />",
      "train-front": "<path d=\"M8 3.1V7a4 4 0 0 0 8 0V3.1\" /> <path d=\"m9 15-1-1\" /> <path d=\"m15 15 1-1\" /> <path d=\"M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z\" /> <path d=\"m8 19-2 3\" /> <path d=\"m16 19 2 3\" />",
      "tree-pine": "<path d=\"m17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z\" /> <path d=\"M12 22v-3\" />",
      "triangle-alert": "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\" /><path d=\"M12 9v4\" /><path d=\"M12 17h.01\" />",
      "tv": "<path d=\"m17 2-5 5-5-5\" /> <rect width=\"20\" height=\"15\" x=\"2\" y=\"7\" rx=\"2\" />",
      "users": "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\" /><path d=\"M16 3.128a4 4 0 0 1 0 7.744\" /><path d=\"M22 21v-2a4 4 0 0 0-3-3.87\" /><circle cx=\"9\" cy=\"7\" r=\"4\" />",
      "utensils": "<path d=\"M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2\" /><path d=\"M7 2v20\" /><path d=\"M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7\" />",
      "wallet": "<path d=\"M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1\" /> <path d=\"M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4\" />",
      "waves": "<path d=\"M2 12q2.5 2 5 0t5 0 5 0 5 0\" /> <path d=\"M2 19q2.5 2 5 0t5 0 5 0 5 0\" /> <path d=\"M2 5q2.5 2 5 0t5 0 5 0 5 0\" />",
      "wind": "<path d=\"M12.8 19.6A2 2 0 1 0 14 16H2\" /> <path d=\"M17.5 8a2.5 2.5 0 1 1 2 4H2\" /> <path d=\"M9.8 4.4A2 2 0 1 1 11 8H2\" />",
      "wrench": "<path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z\" />",
      "zap": "<path d=\"M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z\" />",
    }

    const byTitle = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

    /** Sidebar feed order: A–Z, or most unread first with names as the tiebreak. */
    const compareFeeds = (sort) => (a, b) => (sort === 'unread'
      ? (b.unread || 0) - (a.unread || 0) || byTitle(a.title, b.title)
      : byTitle(a.title, b.title))

    /** Tab icon for a category the user has not given one to. */
    const DEFAULT_CATEGORY_ICON = 'folder'

    /** Icons offered in the category-icon picker, grouped loosely by theme. */
    const CATEGORY_ICON_CHOICES = [
      'cpu',
      'code',
      'terminal',
      'database',
      'cloud',
      'monitor',
      'tv',
      'film',
      'clapperboard',
      'music',
      'mic',
      'headphones',
      'radio',
      'rss',
      'palette',
      'pen-tool',
      'paintbrush',
      'feather',
      'shapes',
      'puzzle',
      'layout-grid',
      'align-left',
      'newspaper',
      'book-open',
      'notebook',
      'library',
      'graduation-cap',
      'telescope',
      'microscope',
      'atom',
      'dna',
      'flask-conical',
      'lightbulb',
      'briefcase',
      'chart-line',
      'banknote',
      'coins',
      'wallet',
      'credit-card',
      'shopping-bag',
      'shopping-cart',
      'tag',
      'bookmark',
      'megaphone',
      'users',
      'message-circle',
      'mail',
      'share-2',
      'link',
      'list',
      'globe',
      'compass',
      'map',
      'map-pin',
      'landmark',
      'camera',
      'plane',
      'bike',
      'car',
      'train-front',
      'building-2',
      'house',
      'mountain',
      'waves',
      'gamepad-2',
      'dumbbell',
      'heart-pulse',
      'stethoscope',
      'pill',
      'leaf',
      'sprout',
      'tree-pine',
      'paw-print',
      'baby',
      'utensils',
      'folder',
      'sun',
      'moon',
      'star',
      'sparkles',
      'zap',
      'flame',
      'droplet',
      'wind',
      'wrench',
      'hammer',
      'rocket',
      'panel-left-open',
      'panel-left-close',
      'maximize',
      'minimize',
      'circle',
      'circle-check',
      'triangle-alert',
    ]

    function Icon({ name, size = 16, className = 'mrss-icon', filled = false }) {
      const lucide = LUCIDE_ICONS[name]
      if (lucide) {
        return h('svg', {
          className,
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: filled ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          dangerouslySetInnerHTML: { __html: lucide },
        })
      }
      const shape = paths[name] || paths.digest
      return h(
        'svg',
        {
          className,
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: filled ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        shape.map((d, index) => h('path', { key: index, d, fill: name === 'feed' && index === 2 ? 'currentColor' : 'none', stroke: index === 2 && name === 'feed' ? 'none' : 'currentColor' })),
      )
    }

    function PanelIcon({ size = 22, active = false }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, style: { display: 'block' } },
        h('circle', { cx: 5.2, cy: 18.8, r: 1.9, fill: 'currentColor' }),
        h('path', { d: 'M5.2 12.2a6.6 6.6 0 0 1 6.6 6.6', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
        h('path', { d: 'M5.2 5.6a13.2 13.2 0 0 1 13.2 13.2', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', opacity: active ? 1 : 0.72 }),
      )
    }

    function MoreDots({ size = 14 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'currentColor',
        'aria-hidden': true,
        style: { display: 'block' },
      },
      h('circle', { cx: 5, cy: 12, r: 1.7 }),
      h('circle', { cx: 12, cy: 12, r: 1.7 }),
      h('circle', { cx: 19, cy: 12, r: 1.7 }),
      )
    }

    /**
     * Tooltip wrapper for icon-only buttons. The tooltip lives on the span so a
     * disabled button still explains itself (Safari drops native titles there).
     */
    function Tip({ tip, align = 'end', children }) {
      return h('span', {
        className: align === 'start' ? 'mrss-tip mrss-tip--start' : 'mrss-tip',
        'data-tip': tip,
      }, children)
    }

    /** Cold-start placeholders: shown only when there is no snapshot to paint. */
    function SidebarSkeleton({ rows = 7 }) {
      return h('div', { className: 'mrss-skeleton', 'data-testid': 'sidebar-skeleton', 'aria-hidden': true },
        Array.from({ length: rows }, (_, index) => h('div', {
          key: index,
          className: 'mrss-skel-row',
          style: { width: `${54 + ((index * 23) % 38)}%` },
        })))
    }

    function ListSkeleton({ rows = 8 }) {
      return h('div', { className: 'mrss-skeleton mrss-skel-list', 'data-testid': 'list-skeleton', 'aria-hidden': true },
        Array.from({ length: rows }, (_, index) => h('div', { key: index, className: 'mrss-skel-item' },
          h('div', { className: 'mrss-skel-row', style: { width: '38%', height: 9 } }),
          h('div', { className: 'mrss-skel-row', style: { width: `${68 + ((index * 7) % 26)}%` } }),
          h('div', { className: 'mrss-skel-row', style: { width: `${48 + ((index * 11) % 32)}%`, height: 9 } }),
        )))
    }

    function AccountSkeleton() {
      return h('div', { className: 'mrss-skel-account', 'data-testid': 'account-skeleton', 'aria-hidden': true },
        h('span', { className: 'mrss-skel-avatar' }),
        h('span', { className: 'mrss-grow mrss-skeleton', style: { padding: 0, gap: 5 } },
          h('span', { className: 'mrss-skel-row', style: { width: 76 } }),
          h('span', { className: 'mrss-skel-row', style: { width: 116, height: 9 } }),
        ))
    }

    // ---------------------------------------------------------------------
    // Panel
    // ---------------------------------------------------------------------

    function Panel() {
      const [boot, setBoot] = useState(PANEL_CACHE.boot)
      // The latest adopted catalog, readable from callbacks that never re-bind.
      const bootRef = useRef(PANEL_CACHE.boot)
      const [entries, setEntries] = useState(PANEL_CACHE.entries)
      const [listInfo, setListInfo] = useState(PANEL_CACHE.listInfo)
      const [filter, setFilter] = useState(PANEL_CACHE.filter)
      const [scope, setScope] = useState(PANEL_CACHE.scope)
      const [query, setQuery] = useState(PANEL_CACHE.query)
      const [debounced, setDebounced] = useState(PANEL_CACHE.debounced)
      const [selectedId, setSelectedId] = useState(PANEL_CACHE.selectedId)
      const [article, setArticle] = useState(PANEL_CACHE.article)
      const [articleState, setArticleState] = useState(PANEL_CACHE.articleState === 'loading' ? 'idle' : PANEL_CACHE.articleState)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState(null)
      const [showManage, setShowManage] = useState(false)
      const [manageTab, setManageTab] = useState('general')
      const [accounts, setAccounts] = useState(null)
      const [showAccounts, setShowAccounts] = useState(false)
      const [accountsFocus, setAccountsFocus] = useState('')
      const [showAddFeed, setShowAddFeed] = useState(false)
      const [feedStats, setFeedStats] = useState(null)
      const [starredEpoch, setStarredEpoch] = useState(0)
      const [addFeedCategory, setAddFeedCategory] = useState('')
      const [prefs, setPrefs] = useState(loadPrefs)
      // The panel owns its own translations so the language switch is instant.
      const localeKey = prefs.locale === 'zh' ? 'zh' : 'en'
      const t = useMemo(() => makeT(localeKey), [localeKey])
      const [toast, setToast] = useState('')
      const [progress, setProgress] = useState(0)
      const [railTicks, setRailTicks] = useState([])
      // Reader-only transient state: absolute date on click, open footnote.
      const [dateFull, setDateFull] = useState(false)
      const [note, setNote] = useState(null)
      const [lastSync, setLastSync] = useState(PANEL_CACHE.lastSync || 0)
      const [wide, setWide] = useState(PANEL_CACHE.wide)
      const [searchOpen, setSearchOpen] = useState(Boolean(PANEL_CACHE.query))
      const [sidebarWidth, setSidebarWidth] = useState(PANEL_CACHE.sidebarWidth || 256)
      const [listWidth, setListWidth] = useState(PANEL_CACHE.listWidth || 336)
      const [sidebarCollapsed, setSidebarCollapsed] = useState(Boolean(PANEL_CACHE.sidebarCollapsed))
      const [fullView, setFullView] = useState(Boolean(PANEL_CACHE.fullView) && PANEL_CACHE.articleState === 'ready')
      const toastTimer = useRef(null)
      const rootRef = useRef(null)
      const searchRef = useRef(null)
      const articleRef = useRef(null)
      const listRef = useRef(null)
      const listSeq = useRef(0)
      const entriesRef = useRef(entries)
      const loadingMoreRef = useRef(false)
      const articleSeq = useRef(0)
      const scrollMarkedRef = useRef(null)
      const firstBootRef = useRef(false)
      const addMenuRef = useRef(null)
      const opmlInputRef = useRef(null)
      const accountsRef = useRef(null)

      const updatePrefs = useCallback((patch) => {
        setPrefs((current) => {
          const next = { ...current, ...patch }
          savePrefs(next)
          return next
        })
      }, [])

      const notify = useCallback((message) => {
        setToast(message)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(''), 2600)
      }, [])

      const articleBody = useCallback(() => articleRef.current?.querySelector('.mrss-article') || null, [])

      // Footnote markers open their note in place; the note's own return link
      // closes the popover and scrolls back to the marker.
      const openNote = useCallback((index, anchor) => {
        const target = articleBody()?.querySelector(`[data-mrss-note="${index}"]`)
        if (!target) return false
        const rect = anchor.getBoundingClientRect()
        const width = Math.min(420, window.innerWidth - 32)
        const left = Math.max(12, Math.min(rect.left - 8, window.innerWidth - width - 12))
        const top = rect.bottom + 250 < window.innerHeight
          ? rect.bottom + 8
          : Math.max(12, rect.top - 220)
        // The note's return link lives in the note list; the popover carries its
        // own button for that, so the glyph is dropped from the copied markup.
        const html = target.innerHTML.replace(/<a\b[^>]*>(?:[^<]*[↩⤴↑»‹][^<]*)?<\/a>/g, '')
        setNote({ index, html, left, top })
        return true
      }, [articleBody])

      const scrollToMarker = useCallback((index) => {
        const marker = articleBody()?.querySelector(`[data-mrss-fn="${index}"]`)
        if (marker) marker.scrollIntoView({ behavior: scrollBehavior(), block: 'center' })
      }, [articleBody])

      // Delegated inside the reading column so injected article HTML needs no
      // React handlers: footnote markers/notes and in-article fragments.
      const onArticleClick = useCallback((event) => {
        const anchor = event.target && event.target.closest ? event.target.closest('a') : null
        if (!anchor) return
        const marker = anchor.getAttribute('data-mrss-fn')
        const back = anchor.getAttribute('data-mrss-fn-back')
        if (marker) {
          if (openNote(Number(marker), anchor)) event.preventDefault()
          return
        }
        if (back) {
          event.preventDefault()
          setNote(null)
          scrollToMarker(Number(back))
          return
        }
        const href = anchor.getAttribute('href') || ''
        if (!href.startsWith('#')) return
        const target = articleBody()?.querySelector(`[id="${href.slice(1)}"]`)
        if (!target) return
        event.preventDefault()
        target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })
      }, [articleBody, openNote, scrollToMarker])

      useEffect(() => () => {
        if (toastTimer.current) clearTimeout(toastTimer.current)
      }, [])

      // Absolute date and an open note belong to one article only.
      useEffect(() => {
        setDateFull(false)
        setNote(null)
      }, [article && article.item ? article.item.id : 0])

      useEffect(() => {
        if (!note) return undefined
        const onKey = (event) => { if (event.key === 'Escape') setNote(null) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [note])

      // Code blocks get a header (language + copy). The article body is injected
      // HTML, so this decorates it after mount instead of parsing React children.
      useEffect(() => {
        const root = articleBody()
        if (!root || articleState !== 'ready' || !article) return
        const blocks = root.querySelectorAll('pre')
        blocks.forEach((pre) => {
          if (pre.parentElement && pre.parentElement.classList.contains('mrss-code')) return
          const wrap = document.createElement('div')
          wrap.className = 'mrss-code'
          const head = document.createElement('div')
          head.className = 'mrss-code-head'
          const lang = document.createElement('span')
          lang.className = 'mrss-code-lang'
          lang.textContent = pre.getAttribute('data-lang') || t('reader.code')
          const copy = document.createElement('button')
          copy.type = 'button'
          copy.className = 'mrss-code-copy'
          copy.textContent = t('reader.copyCode')
          copy.addEventListener('click', async (event) => {
            event.stopPropagation()
            const source = pre.querySelector('code') || pre
            let ok = false
            try {
              await navigator.clipboard.writeText(source.textContent || '')
              ok = true
            } catch {
              ok = false
            }
            copy.textContent = ok ? t('reader.copiedCode') : t('reader.copyFailed')
            wrap.setAttribute('data-copied', ok ? 'true' : 'false')
            setTimeout(() => {
              copy.textContent = t('reader.copyCode')
              wrap.removeAttribute('data-copied')
            }, 1600)
          })
          head.append(lang, copy)
          pre.parentNode.insertBefore(wrap, pre)
          wrap.append(head, pre)
        })
      }, [article && article.html, articleState, articleBody, t])

      // Full view only makes sense while an article is open: closing it (or
      // switching scope) restores the feeds sidebar and the article list.
      useEffect(() => {
        if (fullView && articleState !== 'ready') setFullView(false)
      }, [fullView, articleState])

      useEffect(() => {
        const timer = setTimeout(() => setDebounced(query.trim()), 260)
        return () => clearTimeout(timer)
      }, [query])

      useEffect(() => {
        entriesRef.current = entries
      }, [entries])

      useEffect(() => { bootRef.current = boot }, [boot])

      // Mirror the view state outside the component so a panel switch keeps
      // the reading position and filters.
      useEffect(() => {
        PANEL_CACHE.boot = boot
        PANEL_CACHE.entries = entries
        PANEL_CACHE.listInfo = listInfo
        PANEL_CACHE.filter = filter
        PANEL_CACHE.scope = scope
        PANEL_CACHE.query = query
        PANEL_CACHE.debounced = debounced
        PANEL_CACHE.selectedId = selectedId
        PANEL_CACHE.article = article
        PANEL_CACHE.articleState = articleState
        PANEL_CACHE.lastSync = lastSync
        PANEL_CACHE.wide = wide
        PANEL_CACHE.sidebarWidth = sidebarWidth
        PANEL_CACHE.listWidth = listWidth
        PANEL_CACHE.sidebarCollapsed = sidebarCollapsed
        PANEL_CACHE.fullView = fullView
        // Nothing references the saved article once the reader is closed.
        if (!selectedId) forgetArticle()
        // Keep the saved snapshot's view state in step, so the next page load
        // opens on the same scope, filter and article.
        persistSnapshot({
          filter,
          scope,
          selectedId,
          listScroll: PANEL_CACHE.listScroll,
          articleScroll: PANEL_CACHE.articleScroll,
        })
      }, [boot, entries, listInfo, filter, scope, query, debounced, selectedId,
        article, articleState, lastSync, wide, sidebarWidth, listWidth, sidebarCollapsed, fullView])

      const loadBootstrap = useCallback(async ({ silent = false } = {}) => {
        const result = await callApi('/bootstrap')
        if (!result.ok) {
          // A failed background refresh keeps the snapshot on screen.
          if (!silent) setError(result.error)
          return null
        }
        // A degraded answer (one upstream call failed) updates what it fetched
        // and keeps the rest; it never blanks the sidebar.
        const merged = mergeBootstrap(bootRef.current, result.data)
        bootRef.current = merged
        setBoot(merged)
        setLastSync(Date.now())
        if (merged.status?.error) {
          if (!silent) setError({ code: 'bootstrap', message: merged.status.error })
        } else {
          setError((current) => (current?.code === 'bootstrap' ? null : current))
        }
        if (!merged.status?.configured && !firstBootRef.current) {
          setAccountsFocus('add')
          setShowAccounts(true)
        }
        firstBootRef.current = true
        persistSnapshot({ boot: merged })
        return merged
      }, [])

      /** True when two list pages carry the same rows in the same state. */
      /**
     * Fold a bootstrap answer into what is already on screen.
     *
     * The Host marks a degraded answer with `status.error` (one Miniflux call
     * failed while the others answered). Such an answer may arrive with empty
     * arrays or without counters, and applying it verbatim is what blanked the
     * subscription sidebar right after a read write: four upstream calls go out
     * together once the caches are expired, and any one of them failing was
     * enough to replace the whole catalog with nothing.
     *
     * A degraded answer may update what it actually fetched; it may not delete a
     * catalog we already have.
     */
    function mergeBootstrap(current, incoming) {
      if (!incoming || !incoming.status) return current
      if (!current || !current.status) return incoming
      const degraded = Boolean(incoming.status.error)
      const counters = incoming.counters ?? current.counters ?? null
      const prevFeeds = new Map((current.feeds || []).map((feed) => [feed.id, feed]))
      const incomingFeeds = Array.isArray(incoming.feeds) ? incoming.feeds : []
      const feeds = incomingFeeds.map((feed) => {
        const prev = prevFeeds.get(feed.id)
        // Without counters every row reads as 0 unread, which hides all of them
        // in the Unread filter. The numbers already on screen are closer to the
        // truth than a zero.
        if (!incoming.counters && prev) return { ...feed, unread: prev.unread || 0 }
        return feed
      })
      const incomingCategories = Array.isArray(incoming.categories) ? incoming.categories : []
      return {
        ...incoming,
        feeds: degraded && feeds.length === 0 ? (current.feeds || []) : feeds,
        categories: degraded && incomingCategories.length === 0
          ? (current.categories || [])
          : incomingCategories,
        counters,
        status: { ...incoming.status, countersUnknown: counters == null },
      }
    }

    function sameList(left, right) {
        if (left === right) return true
        if (!Array.isArray(left) || !Array.isArray(right)) return false
        if (left.length !== right.length) return false
        for (let index = 0; index < left.length; index += 1) {
          const a = left[index]
          const b = right[index]
          if (a.id !== b.id || a.status !== b.status || a.starred !== b.starred) return false
        }
        return true
      }

      /**
       * One page of entries. `append` loads the next page for the same scope;
       * otherwise the list is replaced. `silent` revalidates an already painted
       * list: no loading state, no scroll reset, no error banner, and no state
       * update at all when nothing changed.
       *
       * A page this session has already shown paints from memory first and only
       * then refreshes, which is what makes going back to a category feel like a
       * switch instead of a fetch.
       */
      const loadEntries = useCallback(async ({ append = false, silent = false } = {}) => {
        if (append && loadingMoreRef.current) return
        const key = entriesKeyFor({ filter, scope, debounced, order: prefs.sortField })
        const remembered = append || silent ? null : recallPage(key)
        if (remembered) {
          PANEL_CACHE.entriesKey = key
          PANEL_CACHE.listScroll = 0
          if (listRef.current) listRef.current.scrollTop = 0
          setEntries(remembered.entries)
          // A degraded catalog keeps its own banner: the list loading fine does
          // not mean the catalog is fresh.
          setError((current) => (current?.code === 'bootstrap' ? current : null))
          setListInfo((current) => ({ ...current, loading: false, loadingMore: false, total: remembered.total }))
        }
        const previous = append ? entriesRef.current : []
        const seq = append ? listSeq.current : ++listSeq.current
        if (append) loadingMoreRef.current = true
        if (!silent && !remembered) setListInfo((current) => ({ ...current, loading: !append, loadingMore: append }))
        const params = new URLSearchParams({
          filter,
          limit: '60',
          offset: String(previous.length),
        })
        if (prefs.sortField === 'created') params.set('order', 'created')
        if (debounced) params.set('search', debounced)
        if (scope.kind === 'category') params.set('category', String(scope.id))
        if (scope.kind === 'feed') params.set('feed', String(scope.id))
        const result = await callApi(`/entries?${params.toString()}`)
        if (append) loadingMoreRef.current = false
        if (seq !== listSeq.current) return
        if (!result.ok) {
          if (silent || remembered) return
          setListInfo((current) => ({ ...current, loading: false, loadingMore: false }))
          setError(result.error)
          return
        }
        const total = Number(result.data.total) || 0
        const incoming = result.data.entries || []
        if (append) {
          setEntries((current) => {
            const seen = new Set(current.map((entry) => entry.id))
            const merged = current.concat(incoming.filter((entry) => !seen.has(entry.id)))
            rememberPage(key, { entries: merged, total })
            return merged
          })
        } else {
          PANEL_CACHE.entriesKey = key
          if (!silent && !remembered) {
            PANEL_CACHE.listScroll = 0
            if (listRef.current) listRef.current.scrollTop = 0
          }
          rememberPage(key, { entries: incoming, total })
          // A remembered page is already on screen; only replace it when the
          // refresh actually differs, so the reader keeps its scroll position.
          if ((!silent && !remembered) || !sameList(entriesRef.current, incoming)) setEntries(incoming)
          // A degraded catalog keeps its own banner: it is not fixed by the
          // list loading fine, only by the next good bootstrap.
          if (!silent) setError((current) => (current?.code === 'bootstrap' ? current : null))
          // Only the first page is worth persisting: a long scrolled list would
          // blow the storage budget for nothing.
          persistSnapshot({ entries: incoming, entriesKey: key, total, filter, scope })
        }
        setListInfo((current) => ({ ...current, loading: false, loadingMore: false, total }))
      }, [filter, scope, debounced, prefs.sortField])

      const loadArticle = useCallback(async (id, fetchOriginal = false) => {
        if (!id) return null
        const seq = ++articleSeq.current
        const remembered = fetchOriginal ? null : recallArticle(id)
        if (remembered) {
          // Paint what this session already read, then refresh it in place: the
          // click lands now, not in 700 ms, and the header still catches up.
          PANEL_CACHE.articleScroll = 0
          PANEL_CACHE.articleState = 'ready'
          setArticle(remembered)
          setArticleState('ready')
          setProgress(0)
          void fetchArticle(id).then((outcome) => {
            if (seq !== articleSeq.current) return
            if (!outcome?.article) return
            if (JSON.stringify(outcome.article) === JSON.stringify(remembered)) return
            setArticle(outcome.article)
            persistArticle(outcome.article)
          })
          return null
        }
        // Readability refetches in place: keep the article on screen (and any
        // full-view layout) instead of swapping to the "Opening…" state.
        if (!fetchOriginal) setArticleState('loading')
        const outcome = await fetchArticle(id, { fetchOriginal })
        if (seq !== articleSeq.current) return null
        if (outcome?.article) {
          PANEL_CACHE.articleScroll = 0
          if (articleRef.current) articleRef.current.scrollTop = 0
          setArticle(outcome.article)
          setArticleState('ready')
          setProgress(0)
          persistArticle(outcome.article)
          return null
        }
        // A failed refetch keeps the current article; the caller shows a toast.
        if (fetchOriginal) return outcome?.error || { code: 'unknown', message: 'Article request failed' }
        setArticleState('error')
        setError(outcome?.error || { code: 'unknown', message: 'Article request failed' })
        return null
      }, [])

      useEffect(() => {
        if (!PANEL_CACHE.boot) void loadBootstrap()
      }, [loadBootstrap])

      /**
       * Stale-while-revalidate. The snapshot (or the last mount's data) is
       * already on screen, so ask once for the current state after the first
       * paint: the account and the list update in place, no skeleton, no scroll
       * jump. A cold start has nothing to show, so it waits for the fetch.
       */
      useEffect(() => {
        if (!PANEL_CACHE.boot) return undefined
        if (Date.now() - (PANEL_CACHE.lastSync || 0) <= FRESH_FOR) return undefined
        const handle = scheduleIdle(() => {
          void loadBootstrap({ silent: true })
          void loadEntries({ silent: true })
        }, 250)
        return () => cancelIdle(handle)
      }, [loadBootstrap, loadEntries])

      const entriesKey = entriesKeyFor({ filter, scope, debounced, order: prefs.sortField })
      // One request per key: the snapshot may already cover this key (then the
      // mount revalidation above refreshes it), and a rerun of this effect must
      // not fire a second identical request.
      const requestedKeyRef = useRef('')
      useEffect(() => {
        if (requestedKeyRef.current === entriesKey) return
        if (PANEL_CACHE.entriesKey === entriesKey && entriesRef.current.length > 0) {
          requestedKeyRef.current = entriesKey
          return
        }
        requestedKeyRef.current = entriesKey
        void loadEntries()
      }, [loadEntries, entriesKey])

      // Starred is the only filter whose per-feed counts Miniflux does not
      // expose; fetch an aggregated map when the filter is active.
      useEffect(() => {
        if (filter !== 'starred') return undefined
        let cancelled = false
        callApi('/feed-stats').then((result) => {
          if (cancelled || !result.ok) return
          setFeedStats(result.data)
        })
        return () => { cancelled = true }
      }, [filter, starredEpoch])

      useEffect(() => {
        if (!selectedId) return
        const cached = PANEL_CACHE.article
        if (cached && cached.item?.id === selectedId && PANEL_CACHE.articleState === 'ready') return
        void loadArticle(selectedId)
      }, [selectedId, loadArticle])

      // X media is enrichment: the body is already on screen, so ask for the
      // tweet afterwards and drop it into the card that is waiting for it. The
      // Host caches the answer for five minutes, so a revisit is instant.
      useEffect(() => {
        if (articleState !== 'ready' || !article?.item?.id) return undefined
        const embeds = Array.isArray(article.embeds) ? article.embeds : []
        const ids = embeds
          .filter((embed) => embed.provider === 'x' && embed.id && !embed.tweet)
          .map((embed) => String(embed.id))
        if (ids.length === 0) return undefined
        let cancelled = false
        callApi(`/tweets?ids=${ids.map((id) => encodeURIComponent(id)).join(',')}`).then((result) => {
          if (cancelled || !result.ok) return
          const tweets = result.data?.tweets || {}
          const merged = {
            ...article,
            embeds: embeds.map((embed) => (
              embed.provider === 'x' && !embed.tweet && tweets[embed.id]
                ? { ...embed, tweet: tweets[embed.id] }
                : embed
            )),
          }
          if (merged.embeds.every((embed, index) => embed === embeds[index])) return
          rememberArticle(merged)
          setArticle((current) => (current && current.item?.id === merged.item.id ? merged : current))
        })
        return () => { cancelled = true }
      }, [article, articleState])

      // Section ticks for the reading rail; measured from the rendered DOM so
      // it follows whatever headings the sanitizer kept.
      useEffect(() => {
        if (articleState !== 'ready' || !article || !prefs.showReadingRail) {
          setRailTicks([])
          return
        }
        const node = articleRef.current
        if (!node) return
        const total = node.scrollHeight || 1
        const box = node.getBoundingClientRect()
        const ticks = [...node.querySelectorAll('.mrss-article-body h2, .mrss-article-body h3')].map((heading) => ({
          id: heading.id || heading.textContent,
          label: heading.textContent,
          ratio: Math.min(1, Math.max(0, (heading.getBoundingClientRect().top - box.top + node.scrollTop) / total)),
          top: heading.getBoundingClientRect().top - box.top + node.scrollTop,
        }))
        setRailTicks(ticks)
      }, [article, articleState, prefs.showReadingRail, prefs.fontSize, prefs.lineHeight, prefs.lineWidth])

      // Restore the article scroll offset after a remount.
      useEffect(() => {
        if (articleState !== 'ready' || !articleRef.current) return
        if (PANEL_CACHE.articleScroll > 0 && articleRef.current.scrollTop === 0) {
          articleRef.current.scrollTop = PANEL_CACHE.articleScroll
        }
      }, [articleState, selectedId])

      // Keep the active feed visible in the list when navigating with p/n.
      useEffect(() => {
        if (scope.kind !== 'feed') return
        const node = document.querySelector('.mrss-sidefeed[data-active="true"]')
        node?.scrollIntoView({ behavior: 'instant', block: 'nearest' })
      }, [scope])

      // Keep the active category tab inside the horizontal scroller.
      useEffect(() => {
        const node = document.querySelector('.mrss-cat-tab[data-active="true"]')
        node?.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' })
      }, [scope])

      // Restore the list scroll offset after a remount.
      useEffect(() => {
        if (!listRef.current) return
        if (PANEL_CACHE.listScroll > 0 && listRef.current.scrollTop === 0) {
          listRef.current.scrollTop = PANEL_CACHE.listScroll
        }
      }, [entries.length])


      // Background sync on the interval chosen in Preferences. Silent: the
      // list is already on screen and should not blink into its loading state.
      useEffect(() => {
        const minutes = Number(prefs.autoRefreshMinutes) || 0
        if (minutes <= 0) return undefined
        const timer = setInterval(() => {
          if (document.visibilityState !== 'visible') return
          void loadBootstrap({ silent: true })
          void loadEntries({ silent: true })
        }, minutes * 60_000)
        return () => clearInterval(timer)
      }, [loadBootstrap, loadEntries, prefs.autoRefreshMinutes])

      // Coming back to the app after a while refreshes once, quietly, instead of
      // waiting for the next interval tick (Nextflux resumes from visibility the
      // same way).
      useEffect(() => {
        const onVisible = () => {
          if (document.visibilityState !== 'visible') return
          if (Date.now() - (PANEL_CACHE.lastSync || 0) < FRESH_FOR) return
          void loadBootstrap({ silent: true })
          void loadEntries({ silent: true })
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => document.removeEventListener('visibilitychange', onVisible)
      }, [loadBootstrap, loadEntries])

      /**
       * The visible refresh control: reload everything the panel shows, and ask
       * Miniflux to fetch new entries. It is the only path that refetches on
       * purpose — mounting the panel deliberately does not.
       */
      const refreshPanel = useCallback(async () => {
        if (busy === 'refresh') return
        setBusy('refresh')
        setStarredEpoch((value) => value + 1)
        PANEL_CACHE.entriesKey = ''
        const configured = Boolean(boot?.status?.configured)
        try {
          if (configured) {
            const result = await callApi('/action', { method: 'POST', body: { action: 'refresh' } })
            if (!result.ok) notify(`${t('status.actionFailed')}: ${result.error.message}`)
            else notify(t('status.refreshing'))
          }
          await loadBootstrap()
          await loadEntries()
          if (!configured) notify(t('status.updated'))
          if (configured) {
            window.setTimeout(() => {
              void loadBootstrap()
              void loadEntries()
            }, 3000)
          }
        } finally {
          setBusy('')
        }
      }, [boot, busy, loadBootstrap, loadEntries, notify, t])

      const act = useCallback(async (action, payload = {}) => {
        const result = await callApi('/action', { method: 'POST', body: { action, ...payload } })
        if (!result.ok) {
          notify(`${t('status.actionFailed')}: ${result.error.message}`)
          return false
        }
        return true
      }, [notify, t])

      const toggleRead = useCallback(async (item) => {
        const nextRead = item.status === 'unread'
        const ok = await act(nextRead ? 'mark_read' : 'mark_unread', { id: item.id, feedId: item.feedId })
        if (!ok) return
        notify(nextRead ? t('status.markedRead') : t('status.markedUnread'))
        // Keep the row in place so j/k does not jump: it dims instead of
        // disappearing, and the unread counter catches up on the next sync.
        const nextStatus = nextRead ? 'read' : 'unread'
        setEntries((current) => current.map((entry) => (
          entry.id === item.id ? { ...entry, status: nextStatus } : entry
        )))
        setArticle((current) => (current && current.item.id === item.id
          ? { ...current, item: { ...current.item, status: nextStatus } }
          : current))
        patchCachedEntry(item.id, { status: nextStatus })
        patchCachedArticle(item.id, { status: nextStatus })
        void loadBootstrap({ silent: true })
      }, [act, filter, loadBootstrap, notify, t])

      const toggleStar = useCallback(async (item) => {
        const next = !item.starred
        const ok = await act(next ? 'star' : 'unstar', { id: item.id })
        if (!ok) return
        notify(next ? t('status.starred') : t('status.unstarred'))
        const patch = (entry) => (entry.id === item.id ? { ...entry, starred: next } : entry)
        setEntries((current) => current.map(patch))
        setArticle((current) => (current && current.item.id === item.id
          ? { ...current, item: { ...current.item, starred: next } }
          : current))
        patchCachedEntry(item.id, { starred: next })
        patchCachedArticle(item.id, { starred: next })
        setStarredEpoch((value) => value + 1)
      }, [act, notify, t])

      /** Keep the Unread feed list honest when reading without a full bootstrap. */
      const adjustFeedUnread = useCallback((feedId, delta) => {
        if (!feedId) return
        setBoot((current) => (current ? {
          ...current,
          feeds: current.feeds.map((feed) => (feed.id === feedId
            ? { ...feed, unread: Math.max(0, (feed.unread || 0) + delta) }
            : feed)),
        } : current))
      }, [])

      const markReadInPlace = useCallback(async (item) => {
        const ok = await act('mark_read', { id: item.id, feedId: item.feedId })
        if (!ok) return
        if (item.status === 'unread') adjustFeedUnread(item.feedId, -1)
        setEntries((current) => current.map((entry) => (entry.id === item.id ? { ...entry, status: 'read' } : entry)))
        setArticle((current) => (current && current.item.id === item.id
          ? { ...current, item: { ...current.item, status: 'read' } }
          : current))
        patchCachedEntry(item.id, { status: 'read' })
        patchCachedArticle(item.id, { status: 'read' })
      }, [act, adjustFeedUnread])

      const openItem = useCallback((item) => {
        setSelectedId(item.id)
        scrollMarkedRef.current = null
        if (prefs.markReadOnOpen && item.status === 'unread') void markReadInPlace(item)
      }, [markReadInPlace, prefs.markReadOnOpen])

      /** Close the reader (same as Esc): clear the selection and show the empty state. */
      const closeArticle = useCallback(() => {
        setArticleState('idle')
        setSelectedId(null)
        setFullView(false)
      }, [])

      /** Full view drops the feeds sidebar and the article list for reading. */
      const toggleFullView = useCallback(() => setFullView((value) => !value), [])

      const fetchOriginalContent = useCallback(async () => {
        if (!article || busy === 'fetch') return
        setBusy('fetch')
        notify(t('reader.fetching'))
        const error = await loadArticle(article.item.id, true)
        setBusy('')
        if (error) notify(error.message || t('reader.fetchFailed'))
      }, [article, busy, loadArticle, notify, t])

      const copyArticle = useCallback(async () => {
        if (!article) return
        try {
          await navigator.clipboard.writeText(`# ${article.item.title}\n\n${article.markdown}`)
          notify(t('reader.copied'))
        } catch {
          notify(t('reader.copied'))
        }
      }, [article, notify, t])

      const onArticleScroll = useCallback((event) => {
        const node = event.currentTarget
        const max = node.scrollHeight - node.clientHeight
        PANEL_CACHE.articleScroll = node.scrollTop
        const ratio = max > 0 ? node.scrollTop / max : 0
        setProgress(Math.min(100, ratio * 100))
        if (prefs.markReadOnScroll && article && article.item.status === 'unread' && ratio > 0.85) {
          if (scrollMarkedRef.current !== article.item.id) {
            scrollMarkedRef.current = article.item.id
            void markReadInPlace(article.item)
          }
        }
      }, [article, markReadInPlace, prefs.markReadOnScroll])

      const visibleEntries = useMemo(() => {
        let list = entries
        if (scope.kind === 'feed') list = list.filter((entry) => entry.feedId === scope.id)
        if (scope.kind === 'category') list = list.filter((entry) => entry.categoryId === scope.id)
        return list
      }, [entries, scope])

      /**
       * Keep the selected row inside the list viewport.
       *
       * `j` / `k`, opening an article from a restored session, and any other
       * change of selection used to move the reader while the list stayed where
       * it was, so the highlighted row walked off the bottom of the screen.
       *
       * `block: 'nearest'` moves the list only when the row is out of sight, and
       * by the smallest amount — a row that is already visible never jumps, and
       * a manual scroll is not yanked back by an unrelated re-render because the
       * marker below only lets one scroll happen per (scope, article) pair.
       */
      const listFollowRef = useRef('')
      useEffect(() => {
        if (!selectedId) return
        // While a scope is being swapped the rows on screen still belong to the
        // previous one; scrolling those would leave the new list parked at an
        // offset that means nothing. The effect re-runs when the rows land.
        if (listInfo.loading) return
        const list = listRef.current
        if (!list) return
        const marker = `${entriesKey}|${selectedId}`
        if (listFollowRef.current === marker) return
        const row = list.querySelector('.mrss-item[data-active="true"]')
        if (!row) return
        // A remount restores the exact scroll offset a moment later; do not race it.
        if (PANEL_CACHE.listScroll > 0 && list.scrollTop === 0) return
        listFollowRef.current = marker
        // Only the list scrolls. `scrollIntoView` would also walk outer
        // scrollable ancestors, which inside the Harness shell can move the
        // whole panel for a row that is already where it should be.
        const box = list.getBoundingClientRect()
        const rect = row.getBoundingClientRect()
        const air = 8
        let delta = 0
        if (rect.top < box.top + air) delta = rect.top - box.top - air
        else if (rect.bottom > box.bottom - air) delta = rect.bottom - box.bottom + air
        if (Math.abs(delta) < 1) return
        list.scrollBy({ top: delta, behavior: scrollBehavior() })
      }, [selectedId, entriesKey, visibleEntries, listInfo.loading])

      // j/k and the next/previous buttons walk the list; asking for the rows
      // around the open one while the reader is idle makes that walk instant.
      useEffect(() => {
        if (!selectedId) return undefined
        const index = visibleEntries.findIndex((entry) => entry.id === selectedId)
        if (index < 0) return undefined
        const handle = scheduleIdle(() => {
          for (const offset of [1, -1, 2]) {
            const neighbour = visibleEntries[index + offset]
            if (neighbour) prefetchArticle(neighbour.id, { idle: true })
          }
        }, 700)
        return () => cancelIdle(handle)
      }, [selectedId, visibleEntries])

      const markAllRead = useCallback(async () => {
        // Starred is a saved-items view, not an unread queue: the list header
        // greys the action out there instead of marking saved entries read.
        if (filter === 'starred') return
        const target = scope.kind === 'feed' ? 'feed' : scope.kind === 'category' ? 'category' : 'all'
        const label = scope.kind === 'all' ? t('scope.all') : scope.title
        let confirmed = true
        try {
          confirmed = window.confirm(t('list.confirmMarkAll').replace('{name}', label))
        } catch {
          confirmed = true
        }
        if (!confirmed) return
        setBusy('markAll')
        try {
          const result = await callApi('/manage', {
            method: 'POST',
            body: { action: 'mark_all_read', scope: target, id: scope.id },
          })
          if (!result.ok) {
            notify(`${t('status.actionFailed')}: ${result.error.message}`)
            return
          }
          notify(t('list.markedAll'))
          PANEL_CACHE.entriesKey = ''
          await loadBootstrap()
          await loadEntries()
        } finally {
          // The button keeps spinning until the list it just emptied is back.
          setBusy('')
        }
      }, [filter, loadBootstrap, loadEntries, notify, scope, t])

      const currentIndex = useMemo(
        () => visibleEntries.findIndex((entry) => entry.id === selectedId),
        [selectedId, visibleEntries],
      )

      const goRelative = useCallback((delta) => {
        if (visibleEntries.length === 0) return
        const next = currentIndex < 0 ? 0 : Math.min(visibleEntries.length - 1, Math.max(0, currentIndex + delta))
        const item = visibleEntries[next]
        if (item) openItem(item)
      }, [currentIndex, openItem, visibleEntries])


      const messages = useMemo(() => {
        const texts = []
        if (error) texts.push(error.message)
        return texts
      }, [error])

      const status = boot?.status || null
      const configured = Boolean(status?.configured)
      const feeds = boot?.feeds || []
      const categories = boot?.categories || []
      const unreadTotal = feeds.reduce((sum, feed) => sum + (feed.unread || 0), 0)

      // Miniflux's web UI has no bare /feed/<id> route: 2.1 through 2.3 serve
      // /feed/<id>/entries (the feed's entry list) and /feed/<id>/edit. A
      // trailing slash on the configured base URL would double up here.
      const minifluxBase = String(status?.baseUrl || '').replace(/\/+$/, '')
      const feedAdminUrl = (feedId) => (minifluxBase && feedId
        ? `${minifluxBase}/feed/${encodeURIComponent(feedId)}/entries`
        : '')

      const beginResize = (kind) => (event) => {
        event.preventDefault()
        const startX = event.clientX
        const startWidth = kind === 'sidebar' ? sidebarWidth : listWidth
        const min = kind === 'sidebar' ? 200 : 260
        const max = kind === 'sidebar' ? 420 : 560
        const onMove = (moveEvent) => {
          const next = Math.max(min, Math.min(max, startWidth + (moveEvent.clientX - startX)))
          if (kind === 'sidebar') {
            PANEL_CACHE.sidebarWidth = next
            setSidebarWidth(next)
          } else {
            PANEL_CACHE.listWidth = next
            setListWidth(next)
          }
        }
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          document.body.style.cursor = ''
        }
        document.body.style.cursor = 'col-resize'
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      const openManage = (tab) => {
        setManageTab(tab)
        setShowManage(true)
      }

      /** Subscription writes need a configured Miniflux, not the demo data. */
      const ensureConnected = () => {
        if (configured) return true
        openAccounts('add')
        notify(t('manage.connectFirst'))
        return false
      }

      /**
       * The add-feed flow is its own dialog: site or feed URL -> Miniflux
       * discovery -> pick the feed and a category -> subscribe. It never opens
       * the settings overlay.
       */
      const openAddFeed = () => {
        if (!ensureConnected()) return
        const currentFeed = scope.kind === 'feed' ? feeds.find((feed) => feed.id === scope.id) : null
        const categoryId = scope.kind === 'category' ? scope.id : currentFeed?.categoryId
        setAddFeedCategory(categoryId ? String(categoryId) : '')
        setShowAddFeed(true)
      }

      const openScope = (nextScope, nextFilter = filter) => {
        setFilter(nextFilter)
        setScope(nextScope)
      }

      const [menu, setMenu] = useState(null)
      const [dialog, setDialog] = useState(null)
      /** Inline copy feedback: { label, status: 'ok' | 'failed' } for one row. */
      const [copied, setCopied] = useState(null)
      const copiedTimer = useRef(null)

      const flashCopied = useCallback((label, status) => {
        if (copiedTimer.current) clearTimeout(copiedTimer.current)
        setCopied({ label, status })
        copiedTimer.current = setTimeout(() => setCopied(null), 1600)
      }, [])

      useEffect(() => () => {
        if (copiedTimer.current) clearTimeout(copiedTimer.current)
      }, [])

      const closeMenu = useCallback(() => setMenu(null), [])

      /**
       * Clamp a context menu into the viewport instead of letting it overflow.
       * Pass `options.anchor` (a DOM node) to pin the menu under a toolbar
       * button, right-aligned, instead of dropping it at the pointer.
       */
      const openMenu = useCallback((event, items, title, options = {}) => {
        if (event?.preventDefault) event.preventDefault()
        if (event?.stopPropagation) event.stopPropagation()
        const pinned = options.anchor?.getBoundingClientRect?.() || null
        const anchor = pinned || event?.currentTarget?.getBoundingClientRect?.()
        const width = 224
        const height = items.reduce((sum, item) => sum + (item === 'sep' ? 9 : item.sub ? 40 : 32), 12) + (title ? 28 : 0)
        const rawX = pinned ? pinned.right - width : (event?.clientX || (anchor ? anchor.right - width : 0))
        const rawY = pinned
          ? (options.up ? pinned.top - height - 4 : pinned.bottom + 4)
          : (event?.clientY || (anchor ? anchor.bottom + 4 : 0))
        setMenu({
          title: title || '',
          items,
          x: Math.max(8, Math.min(rawX, window.innerWidth - width - 8)),
          y: Math.max(8, Math.min(rawY, window.innerHeight - height - 8)),
        })
      }, [])

      const dialogOpen = (next) => setDialog(next)
      const dialogClose = () => setDialog(null)
      const patchDialog = (patch) => setDialog((current) => (current ? { ...current, ...patch } : current))

      const manageAction = useCallback(async (action, payload = {}) => {
        const result = await callApi('/manage', { method: 'POST', body: { action, ...payload } })
        if (!result.ok) {
          notify(`${t('status.actionFailed')}: ${result.error.message}`)
          return false
        }
        return true
      }, [notify, t])

      /** Metadata changes (feeds, categories) invalidate the list and the tree. */
      const afterCatalogChange = useCallback(async () => {
        PANEL_CACHE.boot = null
        setStarredEpoch((value) => value + 1)
        await loadBootstrap()
        PANEL_CACHE.entriesKey = ''
        await loadEntries()
      }, [loadBootstrap, loadEntries])

      /** Full panel reload; `reset` also drops the current view/selection. */
      const reloadPanel = useCallback((reset) => {
        if (reset) {
          setSelectedId(null)
          setArticle(null)
          setArticleState('idle')
          setFeedStats(null)
          setStarredEpoch((value) => value + 1)
          PANEL_CACHE.entriesKey = ''
        }
        void loadBootstrap()
        void loadEntries()
      }, [loadBootstrap, loadEntries])

      const loadAccounts = useCallback(async (force = false) => {
        // The account list is a local read, but it also runs a forced settings
        // reload on the Host: keep it for a moment across panel mounts.
        if (!force && ACCOUNTS_CACHE.data && Date.now() - ACCOUNTS_CACHE.at < 30_000) {
          setAccounts(ACCOUNTS_CACHE.data)
          return
        }
        const result = await callApi('/accounts')
        if (!result.ok) return
        ACCOUNTS_CACHE.data = result.data
        ACCOUNTS_CACHE.at = Date.now()
        setAccounts(result.data)
      }, [])

      useEffect(() => {
        void loadAccounts()
      }, [loadAccounts])

      const accountAction = useCallback(async (action, payload = {}) => {
        const result = await callApi('/accounts/action', { method: 'POST', body: { action, ...payload } })
        if (!result.ok) {
          return { ok: false, error: result.error?.message || t('manage.failed') }
        }
        // The snapshot belongs to the account it was written for: drop it before
        // anything else can paint it under the new account.
        clearSnapshot()
        resetIcons()
        ACCOUNTS_CACHE.data = result.data
        ACCOUNTS_CACHE.at = Date.now()
        setAccounts(result.data)
        reloadPanel(true)
        if (action === 'switch') notify(t('account.switched'))
        if (action === 'logout') notify(t('account.loggedOut'))
        return { ok: true }
      }, [notify, reloadPanel, t])

      const switchAccount = useCallback(async (account) => {
        if (!account || account.active) return
        const result = await accountAction('switch', { id: account.id })
        if (!result.ok) notify(`${t('status.actionFailed')}: ${result.error}`)
      }, [accountAction, notify, t])

      const openAccounts = (focus = '') => {
        setAccountsFocus(focus)
        setShowAccounts(true)
      }

      const onFeedAdded = useCallback(async () => {
        setShowAddFeed(false)
        notify(t('addfeed.subscribed'))
        await afterCatalogChange()
      }, [afterCatalogChange, notify, t])

      /** OPML import used by the sidebar "+" menu. */
      const importOpmlFile = useCallback(async (file) => {
        if (!file) return false
        let xml = ''
        try {
          xml = await file.text()
        } catch {
          notify(t('manage.failed'))
          return false
        }
        const result = await callApi('/manage', { method: 'POST', body: { action: 'import_opml', xml } })
        if (!result.ok) {
          notify(`${t('status.actionFailed')}: ${result.error?.message || ''}`)
          return false
        }
        notify(t('manage.imported'))
        await afterCatalogChange()
        return true
      }, [afterCatalogChange, notify, t])

      /** OPML export moved out of the old Subscriptions dialog. */
      const exportOpml = () => {
        const link = document.createElement('a')
        link.href = `${API}/opml`
        link.download = 'miniflux-subscriptions.opml'
        document.body.appendChild(link)
        link.click()
        link.remove()
      }

      /**
       * Open the feed dialog. `feedUrl` arrives with /bootstrap; when the Host
       * half predates that field the dialog opens with `urlsPending` and
       * hydrateFeedUrls() fills the address from /feeds a moment later.
       */
      const hydrateFeedUrls = useCallback(async (feed) => {
        const ok = await loadFeedUrls()
        const cached = FEED_URLS.get(feed.id)
        setDialog((current) => {
          if (!current || current.kind !== 'feed' || current.feed?.id !== feed.id) return current
          if (cached === undefined) return { ...current, urlsPending: false, urlsFailed: !ok }
          return { ...current, feedUrl: cached, urlsPending: false, urlsFailed: false }
        })
      }, [])

      const openFeedDialog = (feed) => {
        const known = typeof feed.feedUrl === 'string'
        const cached = FEED_URLS.get(feed.id)
        dialogOpen({
          kind: 'feed',
          feed,
          title: t('menu.editFeed'),
          name: feed.title,
          categoryId: String(feed.categoryId || ''),
          feedUrl: known ? feed.feedUrl : (cached || ''),
          urlsPending: !known && !cached,
          urlsFailed: false,
        })
        if (!known && !cached) void hydrateFeedUrls(feed)
      }

      const feedActions = useCallback((feed) => [
        { label: t('menu.refreshFeed'), icon: 'refresh', run: async () => {
          if (await manageAction('feed_refresh', { id: feed.id })) notify(t('status.refreshing'))
        } },
        { label: t('menu.markFeedRead'), icon: 'check', run: async () => {
          if (await manageAction('feed_mark_read', { id: feed.id })) {
            notify(t('list.markedAll'))
            afterCatalogChange()
          }
        } },
        { label: t('menu.editFeed'), icon: 'edit', run: () => openFeedDialog(feed) },
        'sep',
        { label: t('menu.unsubscribe'), icon: 'trash', danger: true, run: () => dialogOpen({
          kind: 'confirm',
          title: t('menu.unsubscribe'),
          confirmLabel: t('menu.unsubscribe'),
          message: t('menu.confirmUnsubscribe').replace('{name}', feed.title),
          run: async () => {
            if (await manageAction('feed_delete', { id: feed.id })) {
              notify(t('menu.unsubscribed'))
              forgetIcon(feed.id)
              if (scope.kind === 'feed' && scope.id === feed.id) {
                setScope({ kind: 'all', id: null, title: '' })
                setSelectedId(null)
                PANEL_CACHE.entriesKey = ''
              }
              afterCatalogChange()
            }
          },
        }) },
      ], [afterCatalogChange, manageAction, notify, scope, t])

      const categoryActions = useCallback((group) => [
        { label: t('menu.markCategoryRead'), icon: 'check', run: async () => {
          if (await manageAction('mark_all_read', { scope: 'category', id: group.id })) {
            notify(t('list.markedAll'))
            afterCatalogChange()
          }
        } },
        { label: t('menu.categoryIcon'), icon: 'palette', run: () => dialogOpen({
          kind: 'categoryIcon',
          category: group,
          title: `${group.title} · ${t('menu.categoryIconTitle')}`,
          query: '',
        }) },
        { label: t('menu.renameCategory'), icon: 'folder', run: () => dialogOpen({
          kind: 'category',
          category: group,
          title: t('menu.renameCategory'),
          name: group.title,
        }) },
        'sep',
        { label: t('manage.delete'), icon: 'trash', danger: true, run: () => dialogOpen({
          kind: 'confirm',
          title: t('manage.delete'),
          confirmLabel: t('manage.delete'),
          message: t('manage.confirmDeleteCategory').replace('{name}', group.title),
          run: async () => {
            if (await manageAction('category_delete', { id: group.id })) {
              notify(t('menu.categoryDeleted'))
              if (scope.kind === 'category' && scope.id === group.id) {
                setScope({ kind: 'all', id: null, title: '' })
                setSelectedId(null)
                PANEL_CACHE.entriesKey = ''
              }
              afterCatalogChange()
            }
          },
        }) },
      ], [afterCatalogChange, manageAction, notify, scope, t])

      const markAboveRead = useCallback(async (item) => {
        const index = visibleEntries.findIndex((entry) => entry.id === item.id)
        if (index <= 0) return
        const ids = visibleEntries.slice(0, index)
          .filter((entry) => entry.status === 'unread')
          .map((entry) => entry.id)
        if (ids.length === 0) return
        if (!(await act('mark_read_many', { ids }))) return
        notify(t('status.markedRead'))
        setEntries((current) => current.map((entry) => (ids.includes(entry.id) ? { ...entry, status: 'read' } : entry)))
        void loadBootstrap({ silent: true })
      }, [act, loadBootstrap, notify, t, visibleEntries])

      /**
       * Clipboard write with a fallback for browsers that only expose
       * `execCommand`. Returns whether the text made it onto the clipboard.
       */
      const copyText = useCallback(async (value) => {
        const text = String(value || '')
        if (!text) return false
        try {
          await navigator.clipboard.writeText(text)
          return true
        } catch {
          // Safari without a user gesture, or a page without clipboard grants
        }
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.setAttribute('readonly', '')
          area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0'
          document.body.appendChild(area)
          area.select()
          const ok = typeof document.execCommand === 'function' && document.execCommand('copy')
          area.remove()
          return Boolean(ok)
        } catch {
          return false
        }
      }, [])

      const copyLink = useCallback(async (item) => {
        const ok = await copyText(item.url)
        notify(ok ? t('reader.linkCopied') : t('menu.copyFailed'))
      }, [copyText, notify, t])

      /**
       * Native share sheet when the host supports Web Share; copying the link is
       * the fallback. Cancelling the sheet is not an error and must not copy.
       */
      const shareArticle = useCallback(async (item) => {
        if (navigator.share) {
          try {
            await navigator.share({ title: item.title, url: item.url })
            return
          } catch (error) {
            if (error && error.name === 'AbortError') return
          }
        }
        await copyLink(item)
      }, [copyLink])

      const articleActions = useCallback((item) => [
        {
          label: item.status === 'unread' ? t('reader.markRead') : t('reader.markUnread'),
          icon: 'check',
          run: () => { void toggleRead(item) },
        },
        { label: item.starred ? t('reader.unstar') : t('reader.star'), icon: 'star', run: () => { void toggleStar(item) } },
        { label: t('menu.markAboveRead'), icon: 'chevron', run: () => { void markAboveRead(item) } },
        'sep',
        { label: t('menu.copyLink'), icon: 'copy', run: () => { void copyLink(item) } },
        ...(item.url ? [{ label: t('reader.original'), icon: 'external', run: () => window.open(item.url, '_blank', 'noreferrer') }] : []),
      ], [copyLink, markAboveRead, t, toggleRead, toggleStar])

      // Every category owns its feeds; a feed whose category is missing (or is
      // 0) still needs a home, so it lands in Uncategorized.
      const feedGroups = useMemo(() => {
        const groups = new Map()
        const ensure = (id, title) => {
          if (!groups.has(id)) groups.set(id, { id, title, totalUnread: 0, feeds: [] })
          return groups.get(id)
        }
        for (const category of categories) ensure(category.id, category.title)
        for (const feed of feeds) {
          const group = ensure(feed.categoryId || 0, feed.categoryTitle || t('nav.uncategorized'))
          group.feeds.push(feed)
        }
        const byFeed = compareFeeds(prefs.feedSort)
        return [...groups.values()]
          .map((group) => ({
            ...group,
            feeds: group.feeds.sort(byFeed),
            totalUnread: group.totalUnread || group.feeds.reduce((sum, feed) => sum + (feed.unread || 0), 0),
          }))
          .sort((a, b) => byTitle(a.title, b.title))
      }, [categories, feeds, prefs.feedSort, t])

      // The p/n keys walk this flattened tree: all entries, then every
      // category followed by its feeds, matching the sidebar order.
      const scopeChain = useMemo(() => {
        const chain = [{ kind: 'all', id: null, title: t('nav.list') }]
        for (const group of feedGroups) {
          chain.push({ kind: 'category', id: group.id, title: group.title })
          for (const feed of group.feeds) chain.push({ kind: 'feed', id: feed.id, title: feed.title })
        }
        return chain
      }, [feedGroups, t])

      const activeCategoryId = scope.kind === 'category'
        ? scope.id
        : scope.kind === 'feed'
          ? feedGroups.find((group) => group.feeds.some((feed) => feed.id === scope.id))?.id ?? null
          : null
      const activeGroup = activeCategoryId !== null
        ? feedGroups.find((group) => group.id === activeCategoryId) || null
        : null
      const activeTitle = activeGroup?.title || t('nav.list')
      const starredCount = (feedId) => {
        const counts = feedStats?.starred
        if (!counts) return 0
        return Number(counts[feedId] ?? counts[String(feedId)] ?? 0)
      }
      const sumStarred = (list) => list.reduce((sum, feed) => sum + starredCount(feed.id), 0)
      const activeStarred = activeGroup ? sumStarred(activeGroup.feeds) : sumStarred(feeds)
      // The tab bar is the only category navigation now: the feed list under it
      // shows the active category (or every feed for All), filtered by the
      // article list's Starred / Unread / All state.
      const sidebarFeeds = activeCategoryId !== null
        ? activeGroup?.feeds || []
        // All subscriptions is one flat list, so the sort button orders the
        // whole thing rather than leaving it clustered by category.
        : feedGroups.flatMap((group) => group.feeds).slice().sort(compareFeeds(prefs.feedSort))
      const visibleSidebarFeeds = sidebarFeeds.filter((feed) => {
        // Unknown counts look like "0 unread everywhere"; showing every
        // subscription beats an empty sidebar while the upstream recovers.
        if (filter === 'unread') return boot?.status?.countersUnknown || prefs.showHiddenFeeds || (feed.unread || 0) > 0
        if (filter === 'starred') return !feedStats || starredCount(feed.id) > 0
        return true
      })
      // The article list's header carries the count now, so it follows the
      // list's own scope rather than the sidebar's selected category.
      const scopeFeed = scope.kind === 'feed' ? feeds.find((feed) => feed.id === scope.id) || null : null
      const scopeGroup = scope.kind === 'category' ? feedGroups.find((group) => group.id === scope.id) || null : null
      const scopeUnread = scopeFeed
        ? (scopeFeed.unread || 0)
        : scopeGroup
          ? scopeGroup.totalUnread
          : unreadTotal
      const scopeStarred = scopeFeed
        ? starredCount(scopeFeed.id)
        : scopeGroup
          ? sumStarred(scopeGroup.feeds)
          : activeStarred
      const listCount = !boot
        // The counts arrive with the catalog; a "0 unread" flash is a lie.
        ? ''
        : filter === 'starred'
          ? (feedStats ? `${scopeStarred} ${t('nav.starred').toLowerCase()}` : '')
          : `${scopeUnread} ${t('side.unread')}`
      const tabMetric = (list, unread) => {
        if (filter === 'unread') return `${unread} ${t('side.unread')}`
        if (filter === 'starred') {
          return feedStats ? `${sumStarred(list)} ${t('nav.starred').toLowerCase()}` : t('nav.starred')
        }
        return `${list.length} ${t('manage.feedsCount')}`
      }
      const feedListRef = useRef(null)
      const openCategoryTab = (id) => {
        if (id === null) {
          openScope({ kind: 'all', id: null, title: '' })
        } else {
          const group = feedGroups.find((item) => item.id === id)
          openScope({ kind: 'category', id, title: group?.title || '' })
        }
        if (feedListRef.current) feedListRef.current.scrollTop = 0
      }

      // Category tabs are icon-only to stay compact; a stable hue plus the
      // first letter tells two same-initial categories apart at a glance.
      const CATEGORY_HUES = [212, 158, 28, 274, 340, 190, 46, 0]
      const categoryHue = (title) => {
        let hash = 0
        for (const ch of String(title || '')) hash = (hash * 31 + (ch.codePointAt(0) || 0)) % 100000
        return CATEGORY_HUES[hash % CATEGORY_HUES.length]
      }

      // Category icons are chosen by hand (Preferences → category menu → Choose
      // icon) and stored per account; a category without a choice keeps the
      // neutral default instead of being guessed from its name.
      const categoryIconKey = (categoryId) => `${boot?.status?.accountId || 'local'}:${categoryId}`
      const categoryIcon = (group) => {
        const chosen = prefs.categoryIcons?.[categoryIconKey(group.id)]
        return chosen && LUCIDE_ICONS[chosen] ? chosen : DEFAULT_CATEGORY_ICON
      }

      // Keyboard: Nextflux's map, plus our own b/l for the two top-level views.
      useEffect(() => {
        const onKeyDown = (event) => {
          const active = document.activeElement
          if (active && active !== document.body && !rootRef.current?.contains(active)) return
          const target = event.target
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            if (event.key === 'Escape') target.blur()
            return
          }
          if (showAddFeed || showAccounts || dialog) return
          // An open footnote owns the keyboard: Esc closes it, typing does not
          // reach the article shortcuts behind the popover.
          if (note) return
          if (event.metaKey || event.ctrlKey || event.altKey) return
          const key = event.key

          if (key === 'Escape') {
            if (menu) { setMenu(null); return }
            if (searchOpen) { setSearchOpen(false); return }
            if (fullView) { setFullView(false); return }
            if (articleState === 'ready') closeArticle()
            return
          }
          if (key === '?') { setManageTab('shortcuts'); setShowManage(true); return }
          if (key === 'N' && event.shiftKey) { openAddFeed(); return }

          const lower = key.toLowerCase()
          if (lower === 'j' || lower === 'k') {
            if (visibleEntries.length === 0) return
            event.preventDefault()
            const index = visibleEntries.findIndex((entry) => entry.id === selectedId)
            const next = lower === 'j'
              ? Math.min(visibleEntries.length - 1, index + 1)
              : Math.max(0, index - 1)
            const item = visibleEntries[next < 0 ? 0 : next]
            if (!item) return
            setSelectedId(item.id)
            if (item.status === 'unread') void markReadInPlace(item)
            return
          }
          if (lower === 'f' || key === '/') {
            event.preventDefault()
            setSearchOpen(true)
            window.setTimeout(() => searchRef.current?.focus(), 30)
            return
          }
          if (lower === 'm' && article) { void toggleRead(article.item); return }
          if (lower === 's' && article) { void toggleStar(article.item); return }
          if (lower === 'c' && article) { void copyArticle(); return }
          if (lower === 'w') { setWide((value) => !value); return }
          if (lower === 'v' && article) { window.open(article.item.url, '_blank', 'noreferrer'); return }
          if (lower === 'g') { void fetchOriginalContent(); return }
          if (lower === 'r') { void refreshPanel(); return }
          if (lower === 'p' || lower === 'n') {
            if (scopeChain.length === 0) return
            event.preventDefault()
            const index = scopeChain.findIndex((entry) => entry.kind === scope.kind && entry.id === scope.id)
            const next = lower === 'n' ? index + 1 : index - 1
            const targetScope = scopeChain[next]
            if (!targetScope) return
            openScope({ kind: targetScope.kind, id: targetScope.id, title: targetScope.title })
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [article, articleState, activeCategoryId, closeArticle, copyArticle, dialog, feedGroups, fetchOriginalContent,
        fullView,
        markReadInPlace, menu, note, openAddFeed, openManage, openScope, refreshPanel, scope, scopeChain, searchOpen,
        selectedId, showAccounts, showAddFeed, toggleRead, toggleStar, visibleEntries])

      const feedRow = (feed) => {
        const badge = filter === 'unread'
          ? (feed.unread || 0)
          : filter === 'starred'
            ? (feedStats ? starredCount(feed.id) : 0)
            : 0
        return h('div', {
          key: `feed-${feed.id}`,
          className: 'mrss-feedline',
          onContextMenu: (event) => openMenu(event, feedActions(feed), feed.title),
        },
        h('button', {
          type: 'button',
          className: 'mrss-sidefeed',
          'data-active': scope.kind === 'feed' && scope.id === feed.id,
          title: feed.lastError
            ? `${feed.title} · ${t('side.feedError')}: ${feed.lastError}`
            : `${feed.title}${feed.categoryTitle ? ` · ${feed.categoryTitle}` : ''}`,
          onClick: () => openScope({ kind: 'feed', id: feed.id, title: feed.title }),
          onMouseEnter: () => prefetchAfterDwell(`feed:${feed.id}`, () => prefetchPage({
            filter,
            scope: { kind: 'feed', id: feed.id },
            order: prefs.sortField === 'created' ? 'created' : 'published',
          })),
          onFocus: () => prefetchAfterDwell(`feed:${feed.id}`, () => prefetchPage({
            filter,
            scope: { kind: 'feed', id: feed.id },
            order: prefs.sortField === 'created' ? 'created' : 'published',
          })),
        },
        h(FeedIcon, { feedId: feed.id, title: feed.title }),
        h('span', { className: 'mrss-grow mrss-feedlabel' },
          h('span', { className: 'mrss-feedtitle' }, feed.title),
          feed.lastError
            ? h('span', {
              className: 'mrss-warn-flag',
              role: 'img',
              'aria-label': t('side.feedError'),
              title: `${t('side.feedError')}\n${feed.lastError}`,
            }, h(Icon, { name: 'triangle-alert', size: 12 }))
            : null,
        ),
        badge > 0 ? h('span', { className: 'mrss-count' }, String(badge)) : null,
        ),
        h('button', {
          className: 'mrss-row-more',
          type: 'button',
          'aria-label': t('menu.actions'),
          title: t('menu.actions'),
          onClick: (event) => { event.stopPropagation(); openMenu(event, feedActions(feed), feed.title) },
        }, h(MoreDots)),
        )
      }

      const clock = (time) => {
        const date = new Date(time)
        const today = new Date()
        const hours = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
        return date.toDateString() === today.toDateString()
          ? hours
          : `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${hours}`
      }

      const accountName = boot?.status?.user || boot?.status?.username || t('manage.notConnected')
      const accountServer = String(boot?.status?.baseUrl || '')
      /** Host part of the server URL; the full URL stays in the tooltip. */
      const serverLabel = (() => {
        if (!accountServer) return ''
        try {
          return new URL(accountServer).host
        } catch {
          return accountServer
        }
      })()
      const logoutAccount = () => {
        const label = boot?.status?.user || boot?.status?.username || accountServer
        dialogOpen({
          kind: 'confirm',
          title: t('account.logout'),
          confirmLabel: t('account.logout'),
          message: t('account.confirmLogout').replace('{name}', label),
          run: async () => {
            const result = await accountAction('logout', {})
            if (!result.ok) notify(`${t('status.actionFailed')}: ${result.error}`)
          },
        })
      }
      const accountMenuItems = () => {
        const list = accounts?.accounts || []
        const current = list.find((account) => account.active) || list[0] || null
        const items = []
        if (current) {
          items.push({
            label: current.username || current.baseUrl,
            sub: current.baseUrl || accountServer,
            icon: 'check',
            run: () => {},
          })
        }
        for (const account of list) {
          if (current && account.id === current.id) continue
          items.push({
            label: account.username || account.baseUrl,
            sub: account.baseUrl,
            icon: 'user',
            run: () => { void switchAccount(account) },
          })
        }
        if (items.length > 0) items.push('sep')
        items.push({ label: t('account.addAnother'), icon: 'plus', run: () => openAccounts('add') })
        items.push({ label: t('side.settings'), icon: 'gear', run: () => openManage('general') })
        items.push('sep')
        items.push({ label: t('account.logout'), icon: 'log-out', danger: true, run: logoutAccount })
        return items
      }

      const addItems = [
        { label: t('side.newFeed'), icon: 'feed', run: () => openAddFeed() },
        {
          label: t('side.importOpml'),
          icon: 'upload',
          run: () => { if (ensureConnected()) opmlInputRef.current?.click() },
        },
        {
          label: t('side.newCategory'),
          icon: 'folder',
          run: () => {
            if (!ensureConnected()) return
            dialogOpen({ kind: 'newCategory', title: t('menu.newCategory'), name: '', busy: false })
          },
        },
        'sep',
        { label: t('manage.exportOpml'), icon: 'download', run: () => { if (ensureConnected()) exportOpml() } },
      ]

      const syncLabel = busy === 'refresh' || (!boot && !lastSync)
        ? t('side.syncing')
        : lastSync
          ? `${t('side.updated')} ${clock(lastSync)}`
          : t('side.neverSynced')

      const sidebar = h(
        'aside',
        {
          id: 'mrss-feeds',
          className: 'mrss-side',
          style: { width: sidebarWidth },
          'data-collapsed': sidebarCollapsed || fullView ? 'true' : undefined,
          'aria-hidden': sidebarCollapsed || fullView ? 'true' : undefined,
        },
        h('div', { className: 'mrss-side-head' },
          h('div', { className: 'mrss-brand', title: t('panel.title') },
            h(Icon, { name: 'feed', className: 'mrss-icon' }),
            h('div', { className: 'mrss-brand-text' },
              h('span', { className: 'mrss-brand-title' }, t('panel.title')),
              h('span', { className: 'mrss-brand-sub', title: syncLabel }, syncLabel),
            ),
          ),
          h('button', {
            className: 'mrss-btn', 'data-icon': 'true', 'data-variant': 'ghost', type: 'button',
            title: t('side.refresh'), 'aria-label': t('side.refresh'),
            disabled: busy === 'refresh',
            onClick: () => { void refreshPanel() },
          }, h(Icon, { name: 'refresh', className: busy === 'refresh' ? 'mrss-icon mrss-spin' : 'mrss-icon' })),
          h('button', {
            ref: addMenuRef,
            className: 'mrss-btn', 'data-icon': 'true', 'data-variant': 'ghost', type: 'button',
            title: t('side.add'), 'aria-label': t('side.add'),
            'aria-haspopup': 'menu',
            'data-open': menu ? 'true' : undefined,
            onClick: (event) => openMenu(event, addItems, '', { anchor: addMenuRef.current }),
          }, h(Icon, { name: 'plus' })),
        ),
        h('div', { className: 'mrss-cat-tabs', role: 'tablist', 'aria-label': t('nav.feeds') },
          // One grey bar while the categories are in flight: without the other
          // tabs the "All" tab would stretch across the whole strip.
          !boot ? h('div', { className: 'mrss-skel-row', style: { flex: 1, height: 26, borderRadius: 8 } }) : null,
          !boot ? null : h('button', {
            className: 'mrss-cat-tab',
            type: 'button',
            role: 'tab',
            'aria-selected': scope.kind === 'all' ? 'true' : 'false',
            'data-active': scope.kind === 'all' ? 'true' : undefined,
            title: `${t('nav.list')} · ${tabMetric(feeds, unreadTotal)}`,
            'aria-label': t('nav.list'),
            onClick: () => openCategoryTab(null),
          }, h(Icon, { name: 'layout-grid', size: 20 })),
          feedGroups.map((group) => {
            const icon = categoryIcon(group)
            return h('button', {
              key: `tab-${group.id}`,
              className: 'mrss-cat-tab',
              type: 'button',
              role: 'tab',
              'aria-selected': activeCategoryId === group.id ? 'true' : 'false',
              'data-active': activeCategoryId === group.id ? 'true' : undefined,
              title: `${group.title} · ${tabMetric(group.feeds, group.totalUnread)}`,
              'aria-label': group.title,
              'data-tinted': 'true',
              style: { '--mrss-cat-h': String(categoryHue(group.title)) },
              onClick: () => openCategoryTab(group.id),
              onContextMenu: (event) => openMenu(event, categoryActions(group), group.title),
            }, h(Icon, { name: icon, size: 20 }))
          }),
        ),
        h('div', { className: 'mrss-side-feeds-head' },
          h('span', { className: 'mrss-grow' }, activeTitle),
          h('button', {
            className: 'mrss-btn',
            'data-icon': 'true',
            'data-variant': 'ghost',
            type: 'button',
            title: `${t(prefs.feedSort === 'unread' ? 'side.feedSortUnread' : 'side.feedSortAlpha')}\n${t('side.feedSortHint')}`,
            'aria-label': t(prefs.feedSort === 'unread' ? 'side.feedSortUnread' : 'side.feedSortAlpha'),
            onClick: () => updatePrefs({ feedSort: prefs.feedSort === 'unread' ? 'alpha' : 'unread' }),
          }, h(Icon, { name: prefs.feedSort === 'unread' ? 'arrow-down-1-0' : 'arrow-down-a-z', size: 15 })),
        ),
        h('div', { className: 'mrss-scroll', ref: feedListRef },
          // No bootstrap yet means the first fetch is still running: placeholders,
          // not the "no feeds yet" invitation.
          !boot
            ? h(SidebarSkeleton, { rows: 7 })
            : feedGroups.length === 0
            ? h('div', { className: 'mrss-feeds-empty' },
              t('side.noFeedsAtAll'),
              ' ',
              h('button', { className: 'mrss-linkbtn', type: 'button', onClick: () => openAddFeed() }, t('side.addFirst')))
            : sidebarFeeds.length === 0
              ? h('div', { className: 'mrss-feeds-empty' },
                t('side.noFeeds'),
                ' ',
                h('button', { className: 'mrss-linkbtn', type: 'button', onClick: () => openAddFeed() }, t('side.addFirst')))
              : visibleSidebarFeeds.length === 0
                ? h('div', { className: 'mrss-feeds-empty' },
                  filter === 'starred' ? t('side.noStarredFeeds') : t('side.noUnreadFeeds'))
                : visibleSidebarFeeds.map(feedRow),
        ),
        h('div', { className: 'mrss-side-foot' },
          boot
            ? h('button', {
              ref: accountsRef,
              className: 'mrss-switch-account',
              type: 'button',
              title: accountServer || accountName,
              'aria-haspopup': 'menu',
              'aria-label': `${t('account.switch')}: ${accountName}`,
              onClick: (event) => openMenu(event, accountMenuItems(), t('account.switch'), {
                anchor: accountsRef.current,
                up: true,
              }),
            },
            h('span', { className: 'mrss-avatar' }, (configured ? accountName : '?').slice(0, 1)),
            h('span', { className: 'mrss-account-meta mrss-grow' },
              h('span', { className: 'mrss-account-name' }, accountName),
              serverLabel ? h('span', { className: 'mrss-account-server' }, serverLabel) : null,
            ),
            configured ? null : h('span', { className: 'mrss-dot' }),
            h(Icon, { name: 'chevron', className: 'mrss-icon mrss-account-chevron' }),
            )
            : h(AccountSkeleton),
        ),
      )

      const banner = boot && !configured
        ? h('div', { className: 'mrss-banner' },
          h('span', { className: 'mrss-badge' }, t('demo.tag')),
          h('span', { className: 'mrss-grow' }, t('demo.hint')),
          h('button', { className: 'mrss-btn', type: 'button', onClick: () => openAccounts('add') }, t('demo.connect')),
        )
        : null

      const hasMore = visibleEntries.length < listInfo.total
      const loadMore = () => { void loadEntries({ append: true }) }

      const scopeTitle = scope.title
        || (scope.kind === 'all' ? t('nav.list') : t('nav.unread'))
      const collapseLabel = t(sidebarCollapsed ? 'list.showSidebar' : 'list.hideSidebar')
      const markAllLabel = filter === 'starred' ? t('list.markAllStarred') : t('list.markAll')

      // One row, left to right: sidebar toggle, scope name with its unread
      // count, Mark all read (icon only, tooltip on hover), search. Refresh
      // lives in the feeds sidebar (and on `r`).
      const listHead = h('div', {
        className: 'mrss-list-head',
        // A refresh under an already painted list; a cold list shows the
        // skeleton instead, so this bar never stands in for missing content.
        'data-loading': listInfo.loading && visibleEntries.length > 0 ? 'true' : undefined,
      },
        h('div', { className: 'mrss-list-bar' },
          h('button', {
            className: 'mrss-btn', 'data-icon': 'true', 'data-variant': 'ghost', type: 'button',
            title: collapseLabel, 'aria-label': collapseLabel,
            'aria-expanded': sidebarCollapsed ? 'false' : 'true',
            'aria-controls': 'mrss-feeds',
            onClick: () => setSidebarCollapsed((value) => !value),
          }, h(Icon, { name: sidebarCollapsed ? 'panel-left-open' : 'panel-left-close' })),
          h('div', { className: 'mrss-list-title' },
            h('span', { className: 'mrss-scope', title: scopeTitle }, scopeTitle),
            listCount ? h('span', { className: 'mrss-list-count' }, listCount) : null,
          ),
          // Tooltip on the wrapper: a disabled button would swallow (or never
          // fire) a native title in Safari, and Starred disables this one.
          h('span', { className: 'mrss-tip', 'data-tip': markAllLabel },
            h('button', {
              className: 'mrss-btn mrss-markall', 'data-icon': 'true', 'data-variant': 'ghost', type: 'button',
              disabled: filter === 'starred' || busy === 'markAll',
              'aria-label': markAllLabel,
              onClick: () => { void markAllRead() },
            }, busy === 'markAll'
              ? h('span', { className: 'mrss-spinner', 'aria-hidden': 'true' })
              : h(Icon, { name: 'check', className: 'mrss-icon' })),
          ),
          h('button', {
            className: 'mrss-btn', 'data-icon': 'true', 'data-variant': 'ghost', type: 'button',
            title: t('list.search'), 'aria-label': t('list.search'),
            'data-open': searchOpen ? 'true' : undefined,
            'aria-pressed': searchOpen ? 'true' : 'false',
            onClick: () => { setSearchOpen((open) => !open); if (!searchOpen) window.setTimeout(() => searchRef.current?.focus(), 30) },
          }, h(Icon, { name: 'search' })),
        ),
        searchOpen
          ? h('input', {
            ref: searchRef,
            className: 'mrss-input',
            placeholder: t('list.search'),
            value: query,
            autoFocus: true,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Escape') setSearchOpen(false) },
            'aria-label': t('list.search'),
          })
          : null,
      )

      const listPane = h('div', {
        className: 'mrss-col mrss-list',
        style: { width: listWidth },
        'data-hidden': fullView ? 'true' : undefined,
      },
        listHead,
        h('div', {
          className: 'mrss-scroll',
          ref: listRef,
          onScroll: (event) => {
            const node = event.currentTarget
            PANEL_CACHE.listScroll = node.scrollTop
            if (hasMore && !listInfo.loading && !listInfo.loadingMore
              && node.scrollTop + node.clientHeight > node.scrollHeight - 240) {
              loadMore()
            }
          },
        },
          // A cold start (`!boot`) has no rows yet, so the first fetch shows the
          // list skeleton; there is never a frame of "No entries match".
          !boot || (listInfo.loading && visibleEntries.length === 0)
            ? h(ListSkeleton, { rows: 8 })
            : visibleEntries.length === 0
              ? h('div', { className: 'mrss-center' }, t('list.empty'))
              : visibleEntries.map((item) => h('div', {
                key: item.id,
                className: 'mrss-item',
                role: 'button',
                tabIndex: 0,
                'data-active': item.id === selectedId,
                'data-unread': item.status === 'unread',
                'data-read': item.status === 'read',
                'data-dim': prefs.dimRead ? 'true' : 'false',
                onClick: () => openItem(item),
                onMouseEnter: () => prefetchAfterDwell(`item:${item.id}`, () => prefetchArticle(item.id, { priority: true })),
                onFocus: () => prefetchAfterDwell(`item:${item.id}`, () => prefetchArticle(item.id, { priority: true })),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    openItem(item)
                  }
                },
                onContextMenu: (event) => openMenu(event, articleActions(item), item.title),
              },
              h('div', { className: 'mrss-item-sub' },
                prefs.showFavicon
                  ? h(FeedIcon, { feedId: item.feedId, title: item.feedTitle, style: { width: 16, height: 16 } })
                  : null,
                h('span', { className: 'mrss-item-feed' }, item.feedTitle),
                item.starred ? h(Icon, { name: 'star', size: 11 }) : null,
                h('span', { className: 'mrss-grow' }),
                h('span', { className: 'mrss-item-time' }, relativeTime(item.publishedAt, t)),
                item.status === 'unread' ? h('span', { className: 'mrss-dot' }) : null,
              ),
              h('div', { className: 'mrss-item-title' }, item.title),
              prefs.showReadingTime ? h('div', { className: 'mrss-item-readtime' }, formatMinutes(item.readingMinutes, t)) : null,
              prefs.cardImage !== 'none' && item.cover
                ? h('img', {
                  className: 'mrss-item-cover',
                  'data-size': prefs.cardImage,
                  src: item.cover,
                  alt: '',
                  loading: 'lazy',
                  referrerPolicy: 'no-referrer',
                  onError: (event) => { event.currentTarget.style.display = 'none' },
                })
                : null,
              prefs.showExcerpt && item.excerpt ? h('div', { className: 'mrss-item-excerpt' }, item.excerpt) : null,
              h('button', {
                className: 'mrss-item-more',
                type: 'button',
                'aria-label': t('menu.actions'),
                title: t('menu.actions'),
                onClick: (event) => { event.stopPropagation(); openMenu(event, articleActions(item), item.title) },
              }, h(MoreDots)),
              )),
          hasMore
            ? h('button', {
              className: 'mrss-loadmore',
              type: 'button',
              disabled: listInfo.loadingMore,
              onClick: loadMore,
            },
            listInfo.loadingMore ? h('span', { className: 'mrss-spinner' }) : null,
            listInfo.loadingMore
              ? t('list.loadingMore')
              : `${t('list.loadMore')} · ${listInfo.total - visibleEntries.length}`,
            )
            : null,
        ),
        h('div', { className: 'mrss-tabs' },
          h('div', null,
            [['starred', t('nav.starred')], ['unread', t('nav.unread')], ['all', t('nav.all')]].map(([id, label]) => h('button', {
              key: id,
              type: 'button',
              className: 'mrss-tab',
              'data-active': filter === id,
              onClick: () => setFilter(id),
            }, label)),
          ),
        ),
      )

      // The Host sends provider embeds parsed from the raw body; older payloads
      // (and the preview) fall back to the entry URL itself.
      const embeds = !article
        ? []
        : (Array.isArray(article.embeds) && article.embeds.length > 0
          ? article.embeds
          : [embedForUrl(article.item?.url)].filter(Boolean))

      const unread = Boolean(article) && article.item.status === 'unread'
      // Title lead + byline + absolute date, computed once per article render.
      const articleTitle = article ? splitKicker(article.item.title) : { kicker: '', title: '' }
      const authorNames = article ? authorsOf(article.item.author) : []
      const authorText = authorNames.length === 0
        ? ''
        : authorNames.length <= 2
          ? authorNames.join(t('reader.authorSep'))
          : `${authorNames.slice(0, 2).join(t('reader.authorSep'))} ${t('reader.authorMore').replace('{n}', String(authorNames.length - 2))}`
      const articlePublished = article ? fullDate(article.item.publishedAt, localeKey) : ''
      const readLabel = unread ? t('reader.markRead') : t('reader.markUnread')
      const starLabel = article?.item.starred ? t('reader.unstar') : t('reader.star')

      const readerPane = h('div', { className: 'mrss-reader' },
        articleState === 'ready' && article
          ? h(React.Fragment, null,
            h('div', { className: 'mrss-progress', style: { width: `${progress}%` } }),
            h('div', { className: 'mrss-reader-head' },
              h(Tip, { tip: t('reader.close'), align: 'start' },
                h('button', {
                  className: 'mrss-btn', 'data-icon': 'true', type: 'button',
                  'aria-label': t('reader.close'), onClick: closeArticle,
                }, h(Icon, { name: 'close' }))),
              h(Tip, { tip: t('reader.prev'), align: 'start' },
                h('button', {
                  className: 'mrss-btn', 'data-icon': 'true', type: 'button',
                  'aria-label': t('reader.prev'),
                  disabled: currentIndex <= 0,
                  onClick: () => goRelative(-1),
                }, h(Icon, { name: 'back' }))),
              h(Tip, { tip: t('reader.next'), align: 'start' },
                h('button', {
                  className: 'mrss-btn', 'data-icon': 'true', type: 'button',
                  'aria-label': t('reader.next'),
                  disabled: currentIndex < 0 || currentIndex >= visibleEntries.length - 1,
                  onClick: () => goRelative(1),
                }, h(Icon, { name: 'next' }))),
              // Actions wrap inside their own box: in a narrow panel the group
              // drops to a second line instead of pushing buttons out of view.
              h('div', { className: 'mrss-reader-actions' },
                h(Tip, { tip: readLabel },
                  h('button', {
                    className: 'mrss-btn', 'data-icon': 'true', type: 'button',
                    'aria-label': readLabel, 'aria-pressed': unread ? 'false' : 'true',
                    onClick: () => { void toggleRead(article.item) },
                  }, h(Icon, { name: unread ? 'circle' : 'circle-check' }))),
                h(Tip, { tip: starLabel },
                  h('button', {
                    className: 'mrss-btn', 'data-icon': 'true', type: 'button',
                    'aria-label': starLabel, 'aria-pressed': article.item.starred ? 'true' : 'false',
                    onClick: () => { void toggleStar(article.item) },
                  }, h(Icon, { name: 'star', filled: Boolean(article.item.starred) }))),
                h(Tip, { tip: t('reader.share') },
                  h('button', {
                    className: 'mrss-btn', 'data-icon': 'true', type: 'button',
                    'aria-label': t('reader.share'),
                    onClick: () => { void shareArticle(article.item) },
                  }, h(Icon, { name: 'share' }))),
                configured ? h(Tip, { tip: busy === 'fetch' ? t('reader.fetchingShort') : t('reader.readability') },
                  h('button', {
                    className: 'mrss-btn', 'data-icon': 'true', type: 'button',
                    'aria-label': t('reader.readability'),
                    disabled: busy === 'fetch',
                    onClick: () => { void fetchOriginalContent() },
                  }, h(Icon, {
                    name: busy === 'fetch' ? 'refresh' : 'align-left',
                    className: busy === 'fetch' ? 'mrss-icon mrss-spin' : 'mrss-icon',
                  }))) : null,
                h(Tip, { tip: fullView ? t('reader.exitFullView') : t('reader.fullView') },
                  h('button', {
                    className: 'mrss-btn', 'data-icon': 'true', type: 'button',
                    'aria-label': fullView ? t('reader.exitFullView') : t('reader.fullView'),
                    'aria-pressed': fullView ? 'true' : 'false',
                    'data-on': fullView ? 'true' : undefined,
                    onClick: toggleFullView,
                  }, h(Icon, { name: fullView ? 'minimize' : 'maximize' }))),
                article.item.url ? h(Tip, { tip: t('reader.original') },
                  h('a', {
                    className: 'mrss-btn', 'data-icon': 'true', href: article.item.url,
                    target: '_blank', rel: 'noreferrer', 'aria-label': t('reader.original'),
                  }, h(Icon, { name: 'external' }))) : null,
              ),
            ),
            prefs.showReadingRail && railTicks.length > 0
              ? h('div', { className: 'mrss-rail', 'aria-hidden': true },
                h('div', { className: 'mrss-rail-track' }),
                h('div', { className: 'mrss-rail-fill', style: { height: `${progress}%` } }),
                railTicks.map((tick) => h('button', {
                  key: tick.id,
                  type: 'button',
                  className: 'mrss-rail-tick',
                  'data-active': progress >= tick.ratio * 100 - 2 ? 'true' : 'false',
                  style: { top: `${tick.ratio * 100}%` },
                  title: tick.label,
                  onClick: () => {
                    const node = articleRef.current
                    if (node) node.scrollTo({ top: tick.top, behavior: scrollBehavior() })
                  },
                })),
              )
              : null,
            h('div', { className: 'mrss-article-scroll', ref: articleRef, onScroll: onArticleScroll },
              h('article', { className: 'mrss-article', onClick: onArticleClick },
                h('header', { className: 'mrss-article-head' },
                  articleTitle.kicker
                    ? h('div', { className: 'mrss-article-kicker' }, articleTitle.kicker)
                    : null,
                  h('h1', { className: 'mrss-article-title' },
                    article.item.url
                      ? h('a', {
                        className: 'mrss-article-title-link',
                        href: article.item.url,
                        target: '_blank',
                        rel: 'noreferrer',
                        title: t('reader.original'),
                        'aria-label': `${articleTitle.title} — ${t('reader.original')}`,
                      }, articleTitle.title)
                      : articleTitle.title),
                  h('div', { className: 'mrss-article-meta' },
                    prefs.showFavicon && article.item.feedId
                      ? h(FeedIcon, {
                        feedId: article.item.feedId,
                        title: article.item.feedTitle,
                        kind: 'meta',
                        size: 14,
                      })
                      : null,
                    h('span', { className: 'mrss-meta-feed', title: article.item.feedTitle }, article.item.feedTitle),
                    authorText
                      ? h(React.Fragment, null,
                        h('span', { className: 'mrss-meta-sep' }, '·'),
                        h('span', { title: article.item.author }, authorText))
                      : null,
                    h('span', { className: 'mrss-meta-sep' }, '·'),
                    // Relative by default, absolute on click (Ringo's dateline).
                    h('button', {
                      type: 'button',
                      className: 'mrss-meta-date',
                      title: dateFull ? relativeTime(article.item.publishedAt, t) : articlePublished,
                      'aria-pressed': dateFull ? 'true' : 'false',
                      onClick: (event) => { event.stopPropagation(); setDateFull((value) => !value) },
                    }, dateFull ? articlePublished : relativeTime(article.item.publishedAt, t)),
                    h('span', { className: 'mrss-meta-sep' }, '·'),
                    h('span', null, `${article.item.readingMinutes} ${t('reader.minutes')}`),
                    article.item.categoryTitle && article.item.categoryTitle !== article.item.feedTitle
                      ? h(React.Fragment, null,
                        h('span', { className: 'mrss-meta-sep' }, '·'),
                        h('span', null, article.item.categoryTitle))
                      : null,
                  ),
                ),
                embeds.length > 0
                  ? h('div', { className: 'mrss-embeds' },
                    embeds.slice(0, 3).map((embed) => (embed.provider === 'x'
                      ? h(TweetBlock, {
                        key: `x:${embed.id}`,
                        embed,
                        showText: article.textLength < 80,
                        bodyHasVideo: /<video[\s>]/i.test(article.html || ''),
                      })
                      : h(ArticleEmbed, { key: `${embed.provider}:${embed.id}`, embed }))))
                  : null,
                article.toc.length >= 3
                  ? h('details', { className: 'mrss-toc' },
                    h('summary', null, `${t('reader.toc')} · ${article.toc.length}`),
                    article.toc.map((heading) => h('a', {
                      key: heading.id, href: `#${heading.id}`, 'data-level': String(heading.level),
                      onClick: (event) => {
                        event.preventDefault()
                        const node = articleRef.current?.querySelector(`#${heading.id}`)
                        if (node) node.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })
                      },
                    }, heading.text)),
                  )
                  : null,
                article.html
                  ? h('div', { className: 'mrss-article-body', dangerouslySetInnerHTML: { __html: article.html } })
                  : h('div', { className: 'mrss-empty' }, t('reader.empty')),
              ),
            ),
          )
          : articleState === 'loading'
            ? h('div', { className: 'mrss-center' }, t('reader.loading'))
            : articleState === 'error'
              ? h('div', { className: 'mrss-center' }, error?.message || t('error.title'))
              : h('div', { className: 'mrss-center' },
                h('div', { className: 'mrss-void' },
                  h(Icon, { name: 'inbox', size: 30, className: 'mrss-icon mrss-void-icon' }),
                  h('span', null, t('reader.pick')),
                )),
      )

      const addFeedDialog = showAddFeed
        ? h(AddFeedDialog, {
          t,
          boot,
          initialCategoryId: addFeedCategory,
          onClose: () => setShowAddFeed(false),
          onAdded: onFeedAdded,
        })
        : null

      const accountsDialog = showAccounts
        ? h(AddAccountDialog, {
          t,
          boot,
          focus: accountsFocus,
          onClose: () => setShowAccounts(false),
          onAction: accountAction,
          notify,
        })
        : null

      const setup = showManage
        ? h(ManageOverlay, {
          t,
          boot,
          prefs,
          notify,
          onExportOpml: () => { if (ensureConnected()) exportOpml() },
          initialTab: manageTab,
          onPrefs: updatePrefs,
          onClose: () => {
            setShowManage(false)
            PANEL_CACHE.entriesKey = ''
            void loadEntries()
          },
        })
        : null

      const menuItems = menu
        ? menu.items.map((item, index) => (item === 'sep'
          ? h('div', { key: `sep-${index}`, className: 'mrss-menu-sep' })
          : h('button', {
            key: item.label,
            type: 'button',
            role: 'menuitem',
            className: 'mrss-menu-item',
            'data-danger': item.danger ? 'true' : undefined,
            'data-sub': item.sub ? 'true' : undefined,
            title: item.sub || '',
            onClick: () => { closeMenu(); item.run() },
          },
          item.icon ? h(Icon, { name: item.icon }) : null,
          h('span', { className: 'mrss-grow mrss-menu-text' },
            h('span', { className: 'mrss-menu-label' }, item.label),
            item.sub ? h('span', { className: 'mrss-menu-sub' }, item.sub) : null,
          ),
          )))
        : null

      const menuLayer = menu
        ? h('div', {
          className: 'mrss-menu-layer',
          onClick: closeMenu,
          onContextMenu: (event) => { event.preventDefault(); closeMenu() },
        },
        h('div', {
          className: 'mrss-menu',
          role: 'menu',
          style: { left: menu.x, top: menu.y },
          onClick: (event) => event.stopPropagation(),
        },
        menu.title ? h('div', { className: 'mrss-menu-title' }, menu.title) : null,
        menuItems,
        ))
        : null

      /** Persist the chosen tab icon for the category in `dialog`. */
      const applyCategoryIcon = (iconName) => {
        if (!dialog || dialog.kind !== 'categoryIcon') return
        const key = categoryIconKey(dialog.category.id)
        const next = { ...(prefs.categoryIcons || {}) }
        if (iconName && LUCIDE_ICONS[iconName]) next[key] = iconName
        else delete next[key]
        updatePrefs({ categoryIcons: next })
        dialogClose()
      }

      const iconMatches = (() => {
        const query = String(dialog?.kind === 'categoryIcon' ? dialog.query || '' : '').trim().toLowerCase()
        return query ? CATEGORY_ICON_CHOICES.filter((name) => name.includes(query)) : CATEGORY_ICON_CHOICES
      })()

      const submitDialog = async () => {
        if (!dialog) return
        if (dialog.busy) return
        if (dialog.kind === 'categoryIcon') return
        if (dialog.kind === 'confirm') {
          const run = dialog.run
          dialogClose()
          await run()
          return
        }
        const name = String(dialog.name || '').trim()
        if (!name) return
        patchDialog({ busy: true })
        if (dialog.kind === 'feed') {
          const ok = await manageAction('feed_update', {
            id: dialog.feed.id,
            title: name,
            categoryId: dialog.categoryId || '',
          })
          dialogClose()
          if (ok) {
            notify(t('menu.feedUpdated'))
            await afterCatalogChange()
          }
          return
        }
        if (dialog.kind === 'category') {
          const ok = await manageAction('category_update', { id: dialog.category.id, title: name })
          dialogClose()
          if (ok) {
            notify(t('menu.categoryRenamed'))
            await afterCatalogChange()
          }
          return
        }
        if (dialog.kind === 'newCategory') {
          const ok = await manageAction('category_add', { title: name })
          dialogClose()
          if (ok) {
            notify(t('menu.categoryCreated'))
            await afterCatalogChange()
          }
        }
      }

      /**
       * Read-only address with a copy button. The URL wraps instead of
       * truncating: seeing the whole address is the point of showing it.
       */
      const urlBlock = (label, value, copyLabel, placeholder) => {
        const status = copied && copied.label === label ? copied.status : ''
        return h('div', { className: 'mrss-url-block' },
          h('div', { className: 'mrss-url-head' },
            h('span', { className: 'mrss-url-label' }, label),
            status
              ? h('span', {
                className: 'mrss-url-copied',
                'data-tone': status === 'ok' ? 'ok' : 'error',
                role: 'status',
              }, status === 'ok' ? t('menu.copied') : t('menu.copyFailedShort'))
              : null,
            h('button', {
              className: 'mrss-btn',
              'data-icon': 'true',
              'data-variant': 'ghost',
              'data-copied': status === 'ok' ? 'true' : 'false',
              type: 'button',
              title: copyLabel,
              'aria-label': copyLabel,
              disabled: !value,
              onClick: async () => {
                const ok = await copyText(value)
                flashCopied(label, ok ? 'ok' : 'failed')
              },
            }, h(Icon, { name: status === 'ok' ? 'check' : 'copy' })),
          ),
          h('code', {
            className: 'mrss-url-value',
            'data-empty': value ? 'false' : 'true',
            title: value || '',
          }, value || placeholder || t('menu.urlUnavailable')),
        )
      }

      const dialogBody = !dialog
        ? null
        : dialog.kind === 'confirm'
          ? h('div', null, dialog.message)
          : dialog.kind === 'categoryIcon'
            ? (() => {
              // Read the current choice here, not when the menu was built: the
              // menu item's callback can outlive the render that created it.
              const current = categoryIcon(dialog.category)
              return h(React.Fragment, null,
                h('div', { className: 'mrss-icon-picker' },
                  h('span', { className: 'mrss-icon-hint' }, t('menu.categoryIconHint')),
                  h('input', {
                    className: 'mrss-input',
                    value: dialog.query || '',
                    placeholder: t('menu.categoryIconSearch'),
                    'aria-label': t('menu.categoryIconSearch'),
                    autoFocus: true,
                    spellCheck: false,
                    onChange: (event) => patchDialog({ query: event.target.value }),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        if (iconMatches[0]) applyCategoryIcon(iconMatches[0])
                      }
                    },
                  }),
                  h('div', { className: 'mrss-icon-grid' },
                    iconMatches.map((name) => h('button', {
                      key: name,
                      type: 'button',
                      className: 'mrss-icon-cell',
                      'data-active': current === name ? 'true' : 'false',
                      title: name,
                      'aria-label': name,
                      // The grid scrolls: bring the current choice into sight.
                      ref: (node) => {
                        if (node && current === name) node.scrollIntoView({ block: 'nearest' })
                      },
                      onClick: () => applyCategoryIcon(name),
                    }, h(Icon, { name, size: 18 }))),
                    iconMatches.length === 0
                      ? h('div', { className: 'mrss-icon-empty' }, t('menu.categoryIconNone'))
                      : null,
                  ),
                ),
              )
            })()
            : h(React.Fragment, null,
            h('label', { className: 'mrss-field' },
              h('span', null, dialog.kind === 'feed' ? t('menu.feedTitle') : t('menu.categoryName')),
              h('input', {
                className: 'mrss-input',
                value: dialog.name,
                autoFocus: true,
                spellCheck: false,
                onChange: (event) => patchDialog({ name: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') { event.preventDefault(); void submitDialog() }
                  if (event.key === 'Escape') dialogClose()
                },
              }),
            ),
            dialog.kind === 'feed'
              ? h(React.Fragment, null,
                h('label', { className: 'mrss-field' },
                  h('span', null, t('menu.category')),
                  h('select', {
                    className: 'mrss-select',
                    value: dialog.categoryId,
                    onChange: (event) => patchDialog({ categoryId: event.target.value }),
                  },
                  h('option', { value: '' }, t('manage.uncategorized')),
                  categories.map((category) => h('option', { key: category.id, value: String(category.id) }, category.title)),
                  ),
                ),
                h('div', { className: 'mrss-url-group' },
                  urlBlock(
                    t('menu.feedUrl'),
                    String(dialog.feedUrl || ''),
                    t('menu.copyFeedUrl'),
                    dialog.urlsPending ? t('menu.urlLoading')
                      : dialog.urlsFailed ? t('menu.urlLookupFailed')
                        : t('menu.urlUnavailable'),
                  ),
                  feedAdminUrl(dialog.feed?.id)
                    ? h('a', {
                      className: 'mrss-btn',
                      'data-variant': 'ghost',
                      href: feedAdminUrl(dialog.feed?.id),
                      target: '_blank',
                      rel: 'noreferrer noopener',
                      title: t('menu.openInMinifluxHint'),
                    }, h(Icon, { name: 'external' }), t('menu.openInMiniflux'))
                    : null,
                ),
              )
              : null,
            )

      const dialogLayer = dialog
        ? h('div', { className: 'mrss-dialog-layer', onClick: dialogClose },
          h('div', {
            className: 'mrss-dialog',
            'data-kind': dialog.kind,
            role: 'dialog',
            'aria-modal': 'true',
            onClick: (event) => event.stopPropagation(),
            onKeyDown: (event) => { if (event.key === 'Escape') dialogClose() },
          },
          h('div', { className: 'mrss-dialog-head' },
            h('span', { className: 'mrss-grow' }, dialog.title),
            h('button', { className: 'mrss-btn', 'data-icon': 'true', 'data-variant': 'ghost', type: 'button', onClick: dialogClose, 'aria-label': t('manage.cancel') }, h(Icon, { name: 'close' })),
          ),
          h('div', { className: 'mrss-dialog-body' }, dialogBody),
          h('div', { className: 'mrss-dialog-actions' },
            dialog.kind === 'categoryIcon'
              ? h(React.Fragment, null,
                h('button', {
                  className: 'mrss-btn',
                  'data-variant': 'ghost',
                  type: 'button',
                  onClick: () => applyCategoryIcon(null),
                }, t('menu.categoryIconDefault')),
                h('div', { className: 'mrss-grow' }),
                h('button', { className: 'mrss-btn', type: 'button', onClick: dialogClose }, t('manage.done')),
              )
              : h(React.Fragment, null,
                h('button', { className: 'mrss-btn', type: 'button', onClick: dialogClose }, t('manage.cancel')),
                h('button', {
                  className: 'mrss-btn',
                  'data-tone': dialog.kind === 'confirm' ? 'danger' : 'primary',
                  type: 'button',
                  disabled: Boolean(dialog.busy) || (dialog.kind !== 'confirm' && !String(dialog.name || '').trim()),
                  onClick: () => { void submitDialog() },
                }, dialog.kind === 'confirm'
                  ? dialog.confirmLabel
                  : dialog.kind === 'newCategory' ? t('manage.addCategory') : t('manage.save')),
              ),
          ),
          ),
        )
        : null

      return h('div', {
        className: 'mrss-root',
        ref: rootRef,
        // Diagnostics only: true when this page session painted from the saved
        // snapshot instead of waiting for the first fetch.
        'data-mrss-hydrated': PANEL_CACHE.hydrated ? 'true' : undefined,
        'data-mrss-theme': prefs.theme === 'system' ? undefined : prefs.theme,
        'data-mrss-accent': prefs.accent === 'default' ? undefined : prefs.accent,
        'data-mrss-surface': prefs.surface === 'paper' ? 'paper' : undefined,
        'data-mrss-favicon': prefs.faviconShape === 'circle' ? 'circle' : undefined,
        'data-mrss-favicon-color': prefs.faviconColor === 'grayscale' ? 'grayscale' : undefined,
        'data-mrss-title-align': prefs.titleAlign === 'center' ? 'center' : undefined,
        style: {
          '--mrss-reading-size': `${prefs.fontSize}px`,
          '--mrss-reading-width': `${wide ? 90 : prefs.lineWidth}ch`,
          '--mrss-reading-line-height': String(prefs.lineHeight),
          '--mrss-reading-font': FONT_STACKS[prefs.fontFamily] || FONT_STACKS.system,
          '--mrss-reading-align': prefs.justify ? 'justify' : 'left',
          '--mrss-title-size': `${prefs.titleSize}em`,
          '--mrss-title-lines': String(prefs.titleLines),
          '--mrss-preview-lines': String(prefs.previewLines),
        },
      },
        h('style', null, CSS),
        sidebar,
        sidebarCollapsed || fullView ? null : h('div', {
          className: 'mrss-resizer',
          role: 'separator',
          'aria-label': t('a11y.resizeSidebar'),
          onPointerDown: beginResize('sidebar'),
        }),
        h('div', { className: 'mrss-main' },
          h('div', { className: 'mrss-col', style: { flex: 1 } },
            banner,
            messages.length > 0 && !showManage
              ? h('div', { className: 'mrss-banner' }, h('span', { className: 'mrss-grow' }, messages[0]),
                h('button', { className: 'mrss-btn', type: 'button', onClick: () => { setError(null); void loadBootstrap() } }, t('error.retry')))
              : null,
            h('div', { className: 'mrss-main' },
              listPane,
              fullView ? null : h('div', {
                className: 'mrss-resizer',
                role: 'separator',
                'aria-label': t('a11y.resizeList'),
                onPointerDown: beginResize('list'),
              }),
              readerPane),
          ),
        ),
        h('input', {
          type: 'file',
          ref: opmlInputRef,
          accept: '.opml,.xml,text/xml',
          style: { display: 'none' },
          onChange: (event) => {
            const file = event.target.files && event.target.files[0]
            event.target.value = ''
            void importOpmlFile(file)
          },
        }),
        setup,
        addFeedDialog,
        accountsDialog,
        menuLayer,
        dialogLayer,
        note
          ? h(React.Fragment, null,
            h('div', { className: 'mrss-fn-veil', 'aria-hidden': true, onClick: () => setNote(null) }),
            h('div', {
              className: 'mrss-fn-pop',
              role: 'dialog',
              'aria-label': t('reader.fnTitle').replace('{n}', String(note.index)),
              style: { left: `${note.left}px`, top: `${note.top}px` },
              onClick: (event) => event.stopPropagation(),
            },
              h('div', { className: 'mrss-fn-pop-head' },
                h('span', null, t('reader.fnTitle').replace('{n}', String(note.index))),
                h('button', {
                  className: 'mrss-btn',
                  'data-icon': 'true',
                  'data-variant': 'ghost',
                  type: 'button',
                  'aria-label': t('reader.close'),
                  autoFocus: true,
                  onClick: () => setNote(null),
                }, h(Icon, { name: 'close' }))),
              h('div', { dangerouslySetInnerHTML: { __html: note.html } }),
              h('div', { className: 'mrss-fn-pop-foot' },
                h('button', {
                  className: 'mrss-btn',
                  type: 'button',
                  onClick: () => { setNote(null); scrollToMarker(note.index) },
                }, t('reader.fnBack'))),
            ))
          : null,
        toast ? h('div', { className: 'mrss-toast' }, toast) : null,
      )
    }

    function Switch({ on, onChange, label }) {
      return h('button', {
        type: 'button',
        className: 'mrss-switch',
        'data-on': String(Boolean(on)),
        role: 'switch',
        'aria-checked': Boolean(on),
        'aria-label': label,
        onClick: () => onChange(!on),
      })
    }

    /**
     * Standalone add-feed dialog: URL -> Miniflux discovery -> pick a feed and
     * a category -> subscribe. Adding one feed never opens the settings overlay.
     */
    function AddFeedDialog({ t, boot, initialCategoryId, onClose, onAdded }) {
      const categories = boot?.categories || []
      const [url, setUrl] = useState('')
      const [step, setStep] = useState('url')
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [results, setResults] = useState([])
      const [picked, setPicked] = useState(0)
      const [categoryId, setCategoryId] = useState(initialCategoryId ? String(initialCategoryId) : '')
      const [note, setNote] = useState('')
      const inputRef = useRef(null)
      const closeRef = useRef(onClose)
      closeRef.current = onClose

      useEffect(() => {
        const timer = setTimeout(() => inputRef.current?.focus(), 60)
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            closeRef.current()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => {
          clearTimeout(timer)
          window.removeEventListener('keydown', onKey)
        }
      }, [])

      const findFeeds = async () => {
        const target = url.trim()
        if (!/^https?:\/\//i.test(target)) {
          setError(t('addfeed.badUrl'))
          return
        }
        setBusy('discover')
        setError('')
        setNote('')
        const result = await callApi(`/discover?url=${encodeURIComponent(target)}`)
        setBusy('')
        if (!result.ok) {
          setResults([{ url: target, title: t('addfeed.direct'), type: '' }])
          setNote(t('addfeed.none'))
        } else {
          const seen = new Set()
          const feeds = (result.data.feeds || []).filter((item) => {
            if (!item?.url || seen.has(item.url)) return false
            seen.add(item.url)
            return true
          })
          if (feeds.length > 0) {
            setResults(feeds)
            setNote('')
          } else {
            setResults([{ url: target, title: t('addfeed.direct'), type: '' }])
            setNote(t('addfeed.none'))
          }
        }
        setPicked(0)
        setStep('pick')
      }

      const subscribe = async () => {
        const chosen = results[picked]
        if (!chosen || busy) return
        setBusy('subscribe')
        setError('')
        const result = await callApi('/manage', {
          method: 'POST',
          body: { action: 'feed_add', url: chosen.url, categoryId: categoryId || undefined },
        })
        setBusy('')
        if (!result.ok) {
          setError(result.error?.message || t('addfeed.failed'))
          return
        }
        onAdded(result.data)
      }

      const urlPane = h(React.Fragment, null,
        h('div', { className: 'mrss-addfeed-hint' }, t('addfeed.hint')),
        h('input', {
          ref: inputRef,
          className: 'mrss-input',
          placeholder: t('addfeed.placeholder'),
          value: url,
          spellCheck: false,
          autoComplete: 'off',
          disabled: Boolean(busy),
          onChange: (event) => { setUrl(event.target.value); setError('') },
          onKeyDown: (event) => {
            if (event.key === 'Enter' && url.trim() && !busy) {
              event.preventDefault()
              void findFeeds()
            }
          },
        }),
      )

      const pickPane = h(React.Fragment, null,
        h('div', { className: 'mrss-addfeed-summary' },
          h('span', { className: 'mrss-badge' }, results.length > 1 ? `${results.length} ${t('addfeed.found')}` : t('addfeed.foundOne')),
          h('span', { className: 'mrss-grow' }, note || t('addfeed.choose')),
        ),
        h('div', { className: 'mrss-addfeed-list' },
          results.map((item, index) => h('label', {
            key: `${item.url}-${index}`,
            className: 'mrss-addfeed-item',
            'data-active': index === picked,
          },
          h('input', {
            type: 'radio',
            className: 'mrss-radio-input',
            name: 'mrss-addfeed',
            checked: index === picked,
            onChange: () => setPicked(index),
          }),
          h('span', { className: 'mrss-radio', 'aria-hidden': 'true' }),
          h('span', { className: 'mrss-addfeed-meta' },
            h('span', { className: 'mrss-addfeed-title' }, item.title || item.url),
            h('span', { className: 'mrss-addfeed-url' }, item.url),
          ),
          item.type ? h('span', { className: 'mrss-badge' }, item.type) : null,
          )),
        ),
        h('label', { className: 'mrss-addfeed-category' },
          h('span', null, t('addfeed.category')),
          h('select', {
            className: 'mrss-select',
            value: categoryId,
            onChange: (event) => setCategoryId(event.target.value),
          },
          h('option', { value: '' }, t('manage.uncategorized')),
          categories.map((category) => h('option', { key: category.id, value: String(category.id) }, category.title)),
          ),
        ),
      )

      return h('div', {
        className: 'mrss-dialog-layer',
        onClick: () => { if (!busy) onClose() },
      },
      h('div', {
        className: 'mrss-dialog mrss-addfeed',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('addfeed.title'),
        onClick: (event) => event.stopPropagation(),
      },
      h('div', { className: 'mrss-dialog-head' },
        h(Icon, { name: 'feed' }),
        h('span', null, t('addfeed.title')),
        h('span', { className: 'mrss-grow' }),
        h('button', {
          type: 'button',
          className: 'mrss-btn',
          'data-icon': 'true',
          title: t('manage.done'),
          onClick: onClose,
        }, h(Icon, { name: 'close' })),
      ),
      h('div', { className: 'mrss-dialog-body' },
        step === 'url' ? urlPane : pickPane,
        error ? h('div', { className: 'mrss-addfeed-error' }, error) : null,
      ),
      h('div', { className: 'mrss-dialog-actions' },
        h('button', { type: 'button', className: 'mrss-btn', onClick: onClose }, t('manage.cancel')),
        step === 'pick'
          ? h('button', {
            type: 'button',
            className: 'mrss-btn',
            disabled: Boolean(busy),
            onClick: () => { setStep('url'); setError('') },
          }, t('addfeed.back'))
          : null,
        h('button', {
          type: 'button',
          className: 'mrss-btn',
          'data-tone': 'primary',
          disabled: busy ? true : step === 'url' ? !url.trim() : !results[picked],
          onClick: () => { void (step === 'url' ? findFeeds() : subscribe()) },
        },
        step === 'url'
          ? (busy === 'discover' ? t('addfeed.finding') : t('addfeed.find'))
          : (busy === 'subscribe' ? t('addfeed.subscribing') : t('addfeed.subscribe'))),
      ),
      ))
    }

    /**
     * Add-account dialog. Basic auth (username + password, used once to mint an
     * API key) is the default path; the token form is one click away. Opened
     * from the sidebar footer and on first run.
     */
    function AddAccountDialog({ t, boot, focus, onClose, onAction, notify }) {
      const [mode, setMode] = useState('basic')
      const [form, setForm] = useState({
        // Adding another account starts blank; after a logout (or first run)
        // the server we came from is pre-filled.
        baseUrl: boot?.status?.configured ? '' : (boot?.status?.lastBaseUrl || boot?.status?.baseUrl || ''),
        username: '',
        password: '',
        apiToken: '',
      })
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const baseRef = useRef(null)
      const closeRef = useRef(onClose)
      closeRef.current = onClose

      useEffect(() => {
        const timer = setTimeout(() => baseRef.current?.focus(), 60)
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            closeRef.current()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => {
          clearTimeout(timer)
          window.removeEventListener('keydown', onKey)
        }
      }, [focus])

      const field = (patch) => setForm((current) => ({ ...current, ...patch }))
      const baseUrl = form.baseUrl.trim()
      const ready = mode === 'token'
        ? Boolean(baseUrl && form.apiToken.trim())
        : Boolean(baseUrl && form.username.trim() && form.password)

      const submit = async () => {
        if (!ready || busy) return
        setBusy(true)
        setError('')
        const payload = mode === 'token'
          ? { baseUrl, apiToken: form.apiToken.trim() }
          : { baseUrl, username: form.username.trim(), password: form.password }
        const result = await onAction('add', payload)
        setBusy(false)
        if (!result.ok) {
          setError(result.error)
          return
        }
        notify(t('manage.accountAdded'))
        onClose()
      }

      const onEnter = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void submit()
        }
      }

      const input = (extra) => h('input', {
        className: 'mrss-input',
        spellCheck: false,
        autoComplete: 'off',
        ...extra,
      })

      return h('div', { className: 'mrss-dialog-layer', onClick: onClose },
        h('div', {
          className: 'mrss-dialog mrss-accounts',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('manage.addAccount'),
          onClick: (event) => event.stopPropagation(),
        },
        h('div', { className: 'mrss-dialog-head' },
          h('span', { className: 'mrss-grow' }, t('manage.addAccount')),
          h('button', {
            type: 'button',
            className: 'mrss-btn',
            'data-icon': 'true',
            'data-variant': 'ghost',
            title: t('manage.cancel'),
            onClick: onClose,
          }, h(Icon, { name: 'close' })),
        ),
        h('div', { className: 'mrss-dialog-body' },
          error ? h('div', { className: 'mrss-addfeed-error' }, error) : null,
          h('label', { className: 'mrss-field' },
            h('span', null, t('account.serverUrl')),
            input({
              ref: baseRef,
              placeholder: t('account.serverPlaceholder'),
              value: form.baseUrl,
              onChange: (event) => field({ baseUrl: event.target.value }),
              onKeyDown: onEnter,
            }),
          ),
          mode === 'basic'
            ? h(React.Fragment, null,
              h('label', { className: 'mrss-field' },
                h('span', null, t('account.username')),
                input({
                  value: form.username,
                  autoComplete: 'username',
                  onChange: (event) => field({ username: event.target.value }),
                  onKeyDown: onEnter,
                }),
              ),
              h('label', { className: 'mrss-field' },
                h('span', null, t('account.password')),
                input({
                  type: 'password',
                  value: form.password,
                  autoComplete: 'current-password',
                  onChange: (event) => field({ password: event.target.value }),
                  onKeyDown: onEnter,
                }),
              ),
            )
            : h('label', { className: 'mrss-field' },
              h('span', null, t('account.apiToken')),
              input({
                type: 'password',
                value: form.apiToken,
                onChange: (event) => field({ apiToken: event.target.value }),
                onKeyDown: onEnter,
              }),
              h('span', { className: 'mrss-field-hint' }, t('account.tokenHint')),
            ),
          h('div', { className: 'mrss-auth-divider' }, h('span', null, t('account.orContinueWith'))),
          h('div', { className: 'mrss-auth-switch' },
            h('button', {
              type: 'button',
              className: 'mrss-btn',
              disabled: busy,
              onClick: () => setMode(mode === 'token' ? 'basic' : 'token'),
            }, h(Icon, { name: mode === 'token' ? 'user' : 'key-round' }), t(mode === 'token' ? 'account.basicAuth' : 'account.tokenAuth')),
          ),
          h('div', { className: 'mrss-field-hint' }, t('account.storageHint')),
        ),
        h('div', { className: 'mrss-dialog-actions' },
          h('button', { className: 'mrss-btn', type: 'button', onClick: onClose }, t('manage.cancel')),
          h('button', {
            className: 'mrss-btn',
            'data-tone': 'primary',
            type: 'button',
            disabled: busy || !ready,
            onClick: () => { void submit() },
          }, busy ? t('setup.saving') : t('account.confirm')),
        ),
        ))
    }

    /**
     * Settings overlay: General / Appearance / Reading / Data / Shortcuts /
     * About. Every row writes straight into the prefs object.
     */
    function ManageOverlay({ t, boot, prefs, onPrefs, onClose, initialTab, notify, onExportOpml }) {
      const [tab, setTab] = useState(initialTab || 'general')
      const fileRef = useRef(null)
      const [error, setError] = useState('')

      const tabs = [
        ['general', 'gear', t('settings.general')],
        ['appearance', 'palette', t('settings.appearance')],
        ['reading', 'book-open', t('settings.reading')],
        ['data', 'download', t('settings.data')],
        ['shortcuts', 'keyboard', t('settings.shortcuts')],
        ['about', 'user', t('settings.about')],
      ]

      const section = (title) => h('div', { className: 'mrss-h2', style: { marginTop: 18 } }, title)

      const row = (label, control, hint) => h('div', { className: 'mrss-pref-row' },
        h('div', { className: 'mrss-pref-label' },
          h('span', null, label),
          hint ? h('span', { className: 'mrss-pref-hint' }, hint) : null,
        ),
        control,
      )

      const seg = (options, value, key) => h('div', { className: 'mrss-seg' },
        options.map(([id, label]) => h('button', {
          key: id,
          type: 'button',
          className: 'mrss-seg-btn',
          'data-active': String(value) === id ? 'true' : undefined,
          onClick: () => onPrefs({ [key]: id }),
        }, label)))

      const slider = (label, key, min, max, step, format) => row(label,
        h('span', { className: 'mrss-slider' },
          h('input', {
            type: 'range', min, max, step, value: prefs[key],
            onChange: (event) => onPrefs({ [key]: Number(event.target.value) }),
          }),
          h('span', { className: 'mrss-badge' }, format ? format(prefs[key]) : String(prefs[key])),
        ))

      const toggle = (label, key, hint) => row(label,
        h(Switch, { on: Boolean(prefs[key]), onChange: (value) => onPrefs({ [key]: value }), label }),
        hint)

      const select = (label, key, options) => row(label,
        h('select', {
          className: 'mrss-select',
          value: String(prefs[key]),
          onChange: (event) => onPrefs({ [key]: event.target.value }),
        }, options.map(([value, text]) => h('option', { key: value, value }, text))))

      const link = (href, label) => h('a', {
        className: 'mrss-link',
        href,
        target: '_blank',
        rel: 'noreferrer noopener',
      }, label, h(Icon, { name: 'external', size: 13 }))

      // ------------------------------------------------------------- General
      const generalPane = h('div', null,
        row(t('settings.language'), seg([
          ['en', 'English'],
          ['zh', '简体中文'],
        ], prefs.locale, 'locale')),
        row(t('settings.sync'), h('select', {
          className: 'mrss-select',
          value: String(prefs.autoRefreshMinutes),
          onChange: (event) => onPrefs({ autoRefreshMinutes: Number(event.target.value) }),
        },
        [0, 5, 15, 30, 60].map((minutes) => h('option', { key: minutes, value: String(minutes) },
          minutes === 0 ? t('settings.syncManual') : minutes === 60 ? t('settings.syncHour') : t('settings.syncMinutes').replace('{n}', String(minutes)))),
        )),
        toggle(t('settings.showHiddenFeeds'), 'showHiddenFeeds', t('settings.showHiddenFeedsHint')),
      )

      // ---------------------------------------------------------- Appearance
      const ACCENTS = [
        ['default', t('settings.accentDefault'), ''],
        ['blue', t('settings.accentBlue'), '#3b82f6'],
        ['green', t('settings.accentGreen'), '#22c55e'],
        ['amber', t('settings.accentAmber'), '#f59e0b'],
        ['red', t('settings.accentRed'), '#ef4444'],
        ['violet', t('settings.accentViolet'), '#7c3aed'],
      ]
      const appearancePane = h('div', null,
        row(t('settings.theme'), seg([
          ['system', t('settings.themeSystem')],
          ['light', t('settings.themeLight')],
          ['dark', t('settings.themeDark')],
        ], prefs.theme, 'theme')),
        row(t('settings.surface'), seg([
          ['default', t('settings.surfaceDefault')],
          ['paper', t('settings.surfacePaper')],
        ], prefs.surface, 'surface')),
        row(t('settings.themeColor'), h('div', { className: 'mrss-swatches' },
          ACCENTS.map(([id, label, color]) => h('button', {
            key: id,
            type: 'button',
            className: 'mrss-swatch',
            'data-active': prefs.accent === id ? 'true' : undefined,
            'data-default': id === 'default' ? 'true' : undefined,
            title: label,
            'aria-label': label,
            style: color ? { background: color } : undefined,
            onClick: () => onPrefs({ accent: id }),
          })))),
        row(t('settings.faviconShape'), seg([
          ['circle', t('settings.shapeCircle')],
          ['rounded', t('settings.shapeSquare')],
        ], prefs.faviconShape, 'faviconShape')),
        row(t('settings.faviconColor'), seg([
          ['normal', t('settings.colorNormal')],
          ['grayscale', t('settings.colorGreyscale')],
        ], prefs.faviconColor, 'faviconColor')),
        section(t('settings.articleList')),
        row(t('settings.imagePreview'), seg([
          ['none', t('prefs.cardNone')],
          ['small', t('prefs.cardSmall')],
          ['large', t('prefs.cardLarge')],
        ], prefs.cardImage, 'cardImage')),
        toggle(t('settings.displayFavicon'), 'showFavicon'),
        toggle(t('settings.readingTime'), 'showReadingTime'),
      )

      // ------------------------------------------------------------- Reading
      const readingDefaults = {
        titleAlign: DEFAULT_PREFS.titleAlign,
        titleSize: DEFAULT_PREFS.titleSize,
        fontFamily: DEFAULT_PREFS.fontFamily,
        justify: DEFAULT_PREFS.justify,
        lineHeight: DEFAULT_PREFS.lineHeight,
        fontSize: DEFAULT_PREFS.fontSize,
        lineWidth: DEFAULT_PREFS.lineWidth,
      }
      const readingPane = h('div', null,
        row(t('settings.titleAlign'), seg([
          ['left', t('settings.alignLeft')],
          ['center', t('settings.alignCenter')],
        ], prefs.titleAlign, 'titleAlign')),
        slider(t('prefs.titleSize'), 'titleSize', 1.2, 2.4, 0.1, (value) => `${Number(value).toFixed(1)}em`),
        select(t('prefs.fontFamily'), 'fontFamily', [
          ['system', t('prefs.fontSystem')],
          ['sans', t('prefs.fontSans')],
          ['serif', t('prefs.fontSerif')],
          ['mono', t('prefs.fontMono')],
        ]),
        toggle(t('prefs.justify'), 'justify'),
        slider(t('prefs.lineHeight'), 'lineHeight', 1.4, 2.2, 0.05, (value) => Number(value).toFixed(2)),
        slider(t('settings.textFontSize'), 'fontSize', 14, 24, 1, (value) => `${value}px`),
        slider(t('prefs.lineWidth'), 'lineWidth', 45, 90, 5, (value) => `${value}ch`),
        h('div', { className: 'mrss-pref-row' },
          h('span', null, ''),
          h('button', {
            type: 'button',
            className: 'mrss-btn',
            onClick: () => {
              onPrefs(readingDefaults)
              notify(t('prefs.resetDone'))
            },
          }, t('settings.resetReading')),
        ),
      )

      // ---------------------------------------------------------------- Data
      const dataPane = h('div', null,
        section(t('settings.subscriptionBackup')),
        h('div', { className: 'mrss-pref-row' },
          h('span', null, t('settings.opmlHint')),
          h('button', {
            type: 'button',
            className: 'mrss-btn',
            onClick: () => onExportOpml?.(),
          }, h(Icon, { name: 'download' }), t('manage.exportOpml')),
        ),
        section(t('settings.settingsBackup')),
        h('div', { className: 'mrss-sub', style: { marginBottom: 10 } }, t('prefs.backupHint')),
        h('div', { className: 'mrss-form-row' },
          h('button', {
            type: 'button',
            className: 'mrss-btn',
            onClick: () => {
              const payload = { version: 1, exportedAt: new Date().toISOString(), prefs }
              const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const link = document.createElement('a')
              link.href = url
              link.download = 'miniflux-digest-preferences.json'
              link.click()
              URL.revokeObjectURL(url)
            },
          }, h(Icon, { name: 'download' }), t('prefs.backup')),
          h('button', {
            type: 'button',
            className: 'mrss-btn',
            onClick: () => fileRef.current?.click(),
          }, h(Icon, { name: 'upload' }), t('prefs.restore')),
        ),
        h('input', {
          ref: fileRef,
          type: 'file',
          accept: 'application/json',
          style: { display: 'none' },
          onChange: async (event) => {
            const file = event.target.files && event.target.files[0]
            event.target.value = ''
            if (!file) return
            try {
              const parsed = JSON.parse(await file.text())
              const source = parsed && typeof parsed.prefs === 'object' ? parsed.prefs : parsed
              const next = {}
              for (const key of Object.keys(DEFAULT_PREFS)) {
                if (source && key in source) next[key] = source[key]
              }
              onPrefs(next)
              notify(t('prefs.restored'))
            } catch {
              setError(t('manage.failed'))
            }
          },
        }),
        error ? h('div', { className: 'mrss-addfeed-error' }, error) : null,
        h('div', { className: 'mrss-pref-foot' },
          t('settings.backupHint'),
          ' ',
          link('https://miniflux.app/faq.html#backup', t('settings.backupLink')),
        ),
      )

      // ----------------------------------------------------------- Shortcuts
      const shortcuts = [
        ['j / k', t('manage.keyNext')],
        ['m', t('manage.keyMarkRead')],
        ['s', t('manage.keyStar')],
        ['c', t('manage.keyCopy')],
        ['v', t('manage.keyOriginal')],
        ['g', t('manage.keyContent')],
        ['w', t('manage.keyWide')],
        ['/', t('manage.keySearch')],
        ['p / n', t('manage.keyNextScope')],
        ['r', t('manage.keyRefresh')],
        ['Esc', t('manage.keyBack')],
        ['Shift + N', t('manage.keyAddFeed')],
        ['?', t('settings.shortcuts')],
      ]
      const shortcutsPane = h('div', null,
        shortcuts.map(([key, label]) => h('div', { className: 'mrss-pref-row', key, style: { justifyContent: 'flex-start', gap: 12 } },
          h('span', { className: 'mrss-kbd' }, key),
          h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, label),
        )),
      )

      // --------------------------------------------------------------- About
      const aboutPane = h('div', { className: 'mrss-about' },
        h('div', { className: 'mrss-about-name' }, t('panel.title')),
        h('div', { className: 'mrss-about-version' }, `${t('settings.version')} ${boot?.status?.version || ''}`),
        h('div', { className: 'mrss-about-made' },
          t('settings.madeWith'),
          ' ',
          h('a', {
            className: 'mrss-link',
            href: 'https://wjloven.com',
            target: '_blank',
            rel: 'noreferrer noopener',
            title: 'wjloven.com',
          }, 'wjloven', h(Icon, { name: 'external', size: 13 })),
        ),
        h('div', { className: 'mrss-h2', style: { marginTop: 20 } }, t('settings.acknowledgements')),
        h('ul', { className: 'mrss-ack' },
          h('li', null, h('a', { className: 'mrss-link', href: 'https://miniflux.app', target: '_blank', rel: 'noreferrer noopener' }, 'Miniflux'), ' — ', t('settings.ackMiniflux')),
          h('li', null, h('a', { className: 'mrss-link', href: 'https://lucide.dev', target: '_blank', rel: 'noreferrer noopener' }, 'Lucide'), ' — ', t('settings.ackLucide')),
          h('li', null, h('a', { className: 'mrss-link', href: 'https://github.com/electh/nextflux', target: '_blank', rel: 'noreferrer noopener' }, 'Nextflux'), ' — ', t('settings.ackNextflux')),
          h('li', null, h('a', { className: 'mrss-link', href: 'https://github.com/deepseek-ai', target: '_blank', rel: 'noreferrer noopener' }, 'DeepSeek Harness'), ' — ', t('settings.ackHarness')),
        ),
      )

      const panes = {
        general: generalPane,
        appearance: appearancePane,
        reading: readingPane,
        data: dataPane,
        shortcuts: shortcutsPane,
        about: aboutPane,
      }

      return h('div', { className: 'mrss-manage', role: 'dialog', 'aria-label': t('manage.title') },
        h('div', { className: 'mrss-manage-card' },
          h('div', { className: 'mrss-manage-head' },
            h('span', { className: 'mrss-h1', style: { fontSize: 15 } }, t('manage.title')),
            h('span', { className: 'mrss-grow' }),
            h('button', { type: 'button', className: 'mrss-btn', 'data-icon': 'true', title: t('manage.done'), onClick: onClose }, h(Icon, { name: 'close' })),
          ),
          h('div', { className: 'mrss-manage-body' },
            h('nav', { className: 'mrss-manage-nav' },
              tabs.map(([id, icon, label]) => h('button', {
                key: id,
                type: 'button',
                className: 'mrss-navrow',
                'data-active': tab === id ? 'true' : undefined,
                onClick: () => setTab(id),
              },
              h(Icon, { name: icon }),
              h('span', { className: 'mrss-grow' }, label),
              )),
            ),
            h('div', { className: 'mrss-manage-content' }, panes[tab] || null),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Plugin
    // ---------------------------------------------------------------------

    return {
      inject: ['slots'],
      apply(ctx) {
        const localeService = ctx.get('locale')
        if (localeService) {
          try {
            // Both dictionaries go to the locale service so host-level labels
            // (the sidebar entry) follow the language chosen in the panel.
            localeService.register('rss-miniflux', 'en', EN)
            localeService.register('rss-miniflux', 'zh', ZH)
          } catch {
            // the panel still translates itself through makeT
          }
        }

        // Host-level labels cannot see the panel's prefs, so read them here.
        const t = (key) => makeT(loadPrefs().locale)(key)

        function Provider() {
          return h(Panel, {})
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 24,
          label: () => t('panel.title'),
        }, function RssPanelIcon(props) {
          // Mounted with the app, not with the panel: use it to warm the Host
          // caches and refresh the saved snapshot before anyone clicks the entry.
          useEffect(() => {
            const handle = scheduleIdle(() => { void warmSnapshot() }, 1500)
            return () => cancelIdle(handle)
          }, [])
          return h(PanelIcon, { size: props.size || 22, active: Boolean(props.active) })
        }))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, Provider))
      },
    }
  },
})

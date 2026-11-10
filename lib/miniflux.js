/**
 * Minimal Miniflux API client (v1). Only the endpoints this plugin uses.
 * https://miniflux.app/docs/api.html
 */

export class MinifluxError extends Error {
  constructor(message, { status = 0, code = 'miniflux_error' } = {}) {
    super(message)
    this.name = 'MinifluxError'
    this.status = status
    this.code = code
  }
}

const MAX_LIMIT = 100

/**
 * Methods that may be sent twice. A dropped connection says nothing about
 * whether Miniflux saw the request, so only idempotent ones are retried; a
 * duplicate POST /feeds would subscribe the same feed twice.
 */
const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT'])
/** Small pause before the single retry: proxy resets clear in a moment. */
const RETRY_DELAY = 250

/**
 * undici reports every connection problem as `fetch failed` and keeps the real
 * reason in `error.cause`. "Cannot reach Miniflux: fetch failed" tells nobody
 * whether to check the VPN, the token or the server, so surface the cause.
 */
function connectionDetail(error) {
  const cause = error?.cause
  const code = String(cause?.code || '')
  const message = String(cause?.message || error?.message || error || 'connection failed')
  if (!code || message.includes(code)) return message
  return `${code}: ${message}`
}

/**
 * Miniflux accepts HTTP Basic auth (account username + password) on the v1 API.
 * The add-account form uses that once: it checks the password, then creates a
 * dedicated API key so the plugin never stores the password itself.
 */
export async function createApiKeyWithPassword({ baseUrl, username, password, description = '', timeoutMs = 15000 }) {
  const origin = normalizeBaseUrl(baseUrl)
  if (!origin) throw new MinifluxError('Miniflux URL is not valid', { code: 'bad_base_url' })
  const credentials = Buffer.from(`${username}:${password}`).toString('base64')
  const call = async (path, options = {}) => {
    let response
    try {
      response = await fetch(new URL(`${origin}/v1${path}`), {
        method: options.method || 'GET',
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      })
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new MinifluxError(`Miniflux request timed out (${timeoutMs}ms)`, { code: 'timeout' })
      }
      throw new MinifluxError(`Cannot reach Miniflux: ${connectionDetail(error)}`, { code: 'network' })
    }
    if (response.status === 401) {
      throw new MinifluxError('Miniflux rejected the username or password', { status: 401, code: 'unauthorized' })
    }
    if (!response.ok) {
      let detail = ''
      try {
        const payload = await response.json()
        detail = payload?.error_message || payload?.error || ''
      } catch {
        detail = ''
      }
      throw new MinifluxError(`Miniflux returned ${response.status}${detail ? `: ${detail}` : ''}`, {
        status: response.status,
        code: 'http_error',
      })
    }
    const text = await response.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new MinifluxError('Miniflux returned an unreadable response', { code: 'bad_payload' })
    }
  }

  const me = await call('/me')
  let token = ''
  try {
    const created = await call('/api-keys', { method: 'POST', body: { description } })
    token = String(created?.token || '').trim()
  } catch (error) {
    // Descriptions are unique per user, so signing in a second time collides
    // with the key we minted before. Reuse that key when Miniflux lists it.
    const keys = await call('/api-keys').catch(() => null)
    const match = (Array.isArray(keys) ? keys : []).find(
      (key) => String(key?.description || '').toLowerCase() === description.toLowerCase(),
    )
    token = String(match?.token || '').trim()
    if (!token) throw error
  }
  if (!token) throw new MinifluxError('Miniflux did not return an API key', { code: 'no_token' })
  return { token, username: String(me?.username || username) }
}

export class MinifluxClient {
  constructor({ baseUrl, token, timeoutMs = 15000 } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.token = String(token || '').trim()
    this.timeoutMs = timeoutMs
  }

  get configured() {
    return Boolean(this.baseUrl && this.token)
  }

  async send(path, { method = 'GET', query, body, signal, contentType = 'application/json', accept = 'application/json', rawBody } = {}) {
    if (!this.configured) {
      throw new MinifluxError('Miniflux URL or API token is not configured', { code: 'not_configured' })
    }
    const url = new URL(`${this.baseUrl}/v1${path}`)
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue
        if (Array.isArray(value)) {
          for (const entry of value) url.searchParams.append(key, String(entry))
          continue
        }
        url.searchParams.set(key, String(value))
      }
    }
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const attempts = RETRYABLE_METHODS.has(method) ? 2 : 1
    let response
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        response = await fetch(url, {
          method,
          headers: {
            'X-Auth-Token': this.token,
            Accept: accept,
            ...(body === undefined && rawBody === undefined ? {} : { 'Content-Type': contentType }),
          },
          body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
          signal: combined,
          redirect: 'follow',
        })
        break
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          // The caller's own signal means "stop", and a slow request is not a
          // dropped one; neither should be retried.
          if (signal?.aborted) throw new MinifluxError('Miniflux request was cancelled', { code: 'aborted' })
          throw new MinifluxError(`Miniflux request timed out (${this.timeoutMs}ms)`, { code: 'timeout' })
        }
        if (attempt >= attempts) {
          throw new MinifluxError(`Cannot reach Miniflux: ${connectionDetail(error)}`, { code: 'network' })
        }
        await new Promise((resolve) => { setTimeout(resolve, RETRY_DELAY) })
      }
    }
    if (response.status === 204 || response.status === 205) return null
    if (response.status === 401 || response.status === 403) {
      throw new MinifluxError('Miniflux rejected the API token (401/403)', { status: response.status, code: 'unauthorized' })
    }
    if (!response.ok) {
      let detail = ''
      try {
        const payload = await response.json()
        detail = payload?.error_message || payload?.error || ''
      } catch {
        detail = ''
      }
      throw new MinifluxError(`Miniflux returned ${response.status}${detail ? `: ${detail}` : ''}`, {
        status: response.status,
        code: 'http_error',
      })
    }
    return response
  }

  async request(path, options = {}) {
    const response = await this.send(path, options)
    if (response === null) return null
    const text = await response.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new MinifluxError('Miniflux returned an unreadable response', { code: 'bad_payload' })
    }
  }

  async requestText(path, options = {}) {
    const response = await this.send(path, { accept: 'text/xml, application/xml, text/plain', ...options })
    if (response === null) return ''
    return response.text()
  }

  async requestBytes(path, options = {}) {
    const response = await this.send(path, { accept: 'image/*', ...options })
    if (response === null) return null
    return {
      type: response.headers.get('content-type') || 'application/octet-stream',
      bytes: new Uint8Array(await response.arrayBuffer()),
    }
  }

  async me() {
    return this.request('/me')
  }

  async version() {
    try {
      return await this.request('/version')
    } catch {
      return null
    }
  }

  async categories({ counts = true } = {}) {
    const list = await this.request('/categories', { query: { counts } })
    return Array.isArray(list) ? list : []
  }

  async feeds() {
    const list = await this.request('/feeds')
    return Array.isArray(list) ? list : []
  }

  async counters() {
    try {
      return await this.request('/feeds/counters')
    } catch {
      return null
    }
  }

  async entries({
    status = 'unread',
    limit = 50,
    offset = 0,
    order = 'published_at',
    direction = 'desc',
    search = '',
    categoryId = '',
    feedId = '',
    starred = '',
    publishedAfter = '',
  } = {}) {
    return this.request('/entries', {
      query: {
        status,
        limit: Math.min(Math.max(Number(limit) || 50, 1), MAX_LIMIT),
        offset: Math.max(Number(offset) || 0, 0),
        order,
        direction,
        search: String(search || '').trim(),
        category_id: categoryId,
        feed_id: feedId,
        starred: starred === '' ? '' : String(Boolean(starred)),
        published_after: publishedAfter,
      },
    })
  }

  /** Walk pages until `total` entries or `max` reached. */
  async collectEntries({ max = 200, pageSize = 100, ...filters } = {}) {
    const collected = []
    let total = 0
    for (let offset = 0; offset < Math.min(max, 500); offset += pageSize) {
      const page = await this.entries({ ...filters, limit: pageSize, offset })
      const entries = Array.isArray(page?.entries) ? page.entries : []
      total = Number(page?.total) || collected.length + entries.length
      collected.push(...entries)
      if (entries.length < pageSize || collected.length >= Math.min(total, max)) break
    }
    return { entries: collected.slice(0, max), total }
  }

  async getEntry(id) {
    return this.request(`/entries/${encodeURIComponent(id)}`)
  }

  /** Ask Miniflux's scraper for the original page body. May be slow on first call. */
  async fetchContent(id, { update = true } = {}) {
    return this.request(`/entries/${encodeURIComponent(id)}/fetch-content`, {
      query: update ? { update_content: 'true' } : {},
    })
  }

  async markRead(ids, status = 'read') {
    const entryIds = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite)
    if (entryIds.length === 0) return null
    return this.request('/entries', { method: 'PUT', body: { entry_ids: entryIds, status } })
  }

  async toggleBookmark(id) {
    return this.request(`/entries/${encodeURIComponent(id)}/bookmark`, { method: 'PUT' })
  }

  async setStarred(ids, starred) {
    const entryIds = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite)
    if (entryIds.length === 0) return null
    return this.request('/entries', { method: 'PUT', body: { entry_ids: entryIds, starred: Boolean(starred) } })
  }

  async markFeedRead(feedId) {
    return this.request(`/feeds/${encodeURIComponent(feedId)}/mark-all-as-read`, { method: 'PUT' })
  }

  async markCategoryRead(categoryId) {
    return this.request(`/categories/${encodeURIComponent(categoryId)}/mark-all-as-read`, { method: 'PUT' })
  }

  async markUserRead(userId) {
    return this.request(`/users/${encodeURIComponent(userId)}/mark-all-as-read`, { method: 'PUT' })
  }

  async refreshFeed(feedId) {
    return this.request(`/feeds/${encodeURIComponent(feedId)}/refresh`, { method: 'PUT' })
  }

  async refreshAll() {
    return this.request('/feeds/refresh', { method: 'PUT' })
  }

  // ---------------------------------------------------------------------
  // Subscription management
  // ---------------------------------------------------------------------

  /** POST /v1/discover — find the feeds published on a site or feed URL. */
  async discover(url) {
    const data = await this.request('/discover', {
      method: 'POST',
      body: { url: String(url || '').trim() },
    })
    return Array.isArray(data) ? data : []
  }

  async createFeed({ feedUrl, categoryId, crawler = false, username = '', password = '' }) {
    return this.request('/feeds', {
      method: 'POST',
      body: {
        feed_url: String(feedUrl || '').trim(),
        ...(categoryId ? { category_id: Number(categoryId) } : {}),
        ...(crawler ? { crawler: true } : {}),
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
      },
    })
  }

  async updateFeed(id, patch) {
    const body = {}
    if (patch.title !== undefined) body.title = String(patch.title)
    if (patch.categoryId !== undefined && patch.categoryId !== '') body.category_id = Number(patch.categoryId)
    if (patch.disabled !== undefined) body.disabled = Boolean(patch.disabled)
    return this.request(`/feeds/${encodeURIComponent(id)}`, { method: 'PUT', body })
  }

  async deleteFeed(id) {
    return this.request(`/feeds/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async createCategory(title) {
    return this.request('/categories', { method: 'POST', body: { title: String(title) } })
  }

  async updateCategory(id, title) {
    return this.request(`/categories/${encodeURIComponent(id)}`, { method: 'PUT', body: { title: String(title) } })
  }

  async deleteCategory(id) {
    return this.request(`/categories/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async exportOpml() {
    return this.requestText('/export')
  }

  async importOpml(xml) {
    return this.request('/import', {
      method: 'POST',
      rawBody: String(xml),
      contentType: 'text/xml',
    })
  }

  async feedIcon(feedId) {
    const payload = await this.request(`/feeds/${encodeURIComponent(feedId)}/icon`)
    if (!payload || typeof payload.data !== 'string') return null
    const raw = payload.data
    const comma = raw.indexOf(',')
    const base64 = comma >= 0 ? raw.slice(comma + 1) : raw
    try {
      return {
        type: payload.mime_type || 'image/png',
        bytes: new Uint8Array(Buffer.from(base64, 'base64')),
      }
    } catch {
      return null
    }
  }
}

export function normalizeBaseUrl(value) {
  let raw = String(value || '').trim()
  if (!raw) return ''
  // "example.com/v1/" is what the Miniflux docs show; assume https for it.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`
  let url
  try {
    url = new URL(raw)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  url.hash = ''
  url.search = ''
  let path = url.pathname.replace(/\/+$/, '')
  path = path.replace(/\/v1$/, '')
  return `${url.origin}${path}`
}

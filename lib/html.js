/**
 * Article HTML utilities: a conservative allow-list sanitizer for the reader,
 * a plain-text projection for the agent, a Markdown projection for export, and
 * a table of contents built from the sanitized headings.
 *
 * The reader renders the sanitizer's output with innerHTML, so this file is the
 * only trust boundary for third-party article markup. Unknown tags are dropped,
 * every attribute except an explicit allow-list is dropped, and links/images
 * must resolve to http(s).
 */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'code',
  'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'dl', 'dt', 'dd',
  'video', 'audio', 'source',
  'div', 'span',
])

const VOID_TAGS = new Set(['br', 'hr', 'img', 'source', 'col'])

const ATTRS_BY_TAG = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  video: new Set(['src', 'poster', 'controls', 'loop', 'muted', 'playsinline']),
  audio: new Set(['src', 'controls', 'loop']),
  source: new Set(['src', 'type']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  td: new Set(['colspan', 'rowspan']),
}

const DROP_WITH_CONTENT =
  /<(script|style|noscript|iframe|object|embed|form|select|textarea|svg|math|canvas|template|applet|frameset)\b[^>]*>[\s\S]*?<\/\1\s*>/gi

const DROP_SELF_CONTAINED =
  /<\/?(?:input|link|meta|base|embed|track|area|param|frame|noframes|marquee|blink)\b[^>]*>/gi

const TAG_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g
const ATTR_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷',
}

/** Decode the small entity set articles actually use. Numeric forms are kept. */
export function decodeEntities(input) {
  return String(input || '').replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
      try { return String.fromCodePoint(code) } catch { return match }
    }
    const mapped = ENTITIES[body.toLowerCase()]
    return mapped === undefined ? match : mapped
  })
}

/** Strip every tag and collapse whitespace. Used for excerpts and word counts. */
export function textFromHtml(html) {
  const withoutBlocks = String(html || '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|figure|figcaption|pre)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
  return decodeEntities(withoutBlocks)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** One-line summary for list rows. */
export function excerptFromHtml(html, limit = 200) {
  const text = textFromHtml(html).replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, limit).replace(/[\s,;:，。；：、]+$/, '')}…`
}

// In-page fragments are rewritten by `rewriteIds` to `mrss-*` ids that the
// sanitizer itself generated, so a bare fragment is safe to keep as-is.
const SAFE_FRAGMENT = /^#[A-Za-z0-9_-]{1,48}$/
const GENERATED_ID = /^mrss-[A-Za-z0-9_-]{1,48}$/

function safeUrl(raw, baseUrl) {
  const value = String(raw || '').trim()
  if (!value) return ''
  if (/[\u0000-\u001f]/.test(value)) return ''
  if (SAFE_FRAGMENT.test(value)) return value
  if (/^(javascript|vbscript|file|blob|about|data):/i.test(value)) return ''
  try {
    const url = new URL(value, baseUrl || 'https://example.invalid/')
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
    if (url.protocol === 'mailto:') return url.href
    return ''
  } catch {
    return ''
  }
}

function renderAttributes(tag, rawAttrs, baseUrl) {
  const allowed = ATTRS_BY_TAG[tag]
  const seen = new Set()
  let out = ''
  if (tag === 'img') out += ' loading="lazy" decoding="async" referrerpolicy="no-referrer"'
  ATTR_PATTERN.lastIndex = 0
  let match
  while ((match = ATTR_PATTERN.exec(rawAttrs)) !== null) {
    const name = match[1].toLowerCase()
    if (seen.has(name)) continue
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    // Attributes the sanitizer itself generates: prefixed ids (in-article
    // anchors), footnote markers/notes and the code language label. Feeds can
    // not smuggle anything else in through these names.
    if (name === 'id') {
      if (!GENERATED_ID.test(value.trim())) continue
      out += ` id="${value.trim()}"`
      seen.add(name)
      continue
    }
    if (name === 'data-mrss-fn' || name === 'data-mrss-fn-back' || name === 'data-mrss-note') {
      if (!/^\d{1,3}$/.test(value.trim())) continue
      out += ` ${name}="${value.trim()}"`
      seen.add(name)
      continue
    }
    if (name === 'data-lang') {
      if (!/^[A-Za-z0-9+#.-]{1,20}$/.test(value.trim())) continue
      out += ` data-lang="${value.trim()}"`
      seen.add(name)
      continue
    }
    if (!allowed || !allowed.has(name)) continue
    if (name === 'href' || name === 'src' || name === 'poster') {
      const url = safeUrl(value, baseUrl)
      if (!url) continue
      out += ` ${name}="${url.replace(/"/g, '&quot;')}"`
    } else if (name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan') {
      if (!/^\d{1,4}$/.test(value.trim())) continue
      out += ` ${name}="${value.trim()}"`
    } else if (name === 'controls' || name === 'loop' || name === 'muted' || name === 'playsinline') {
      out += ` ${name}=""`
    } else {
      out += ` ${name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`
    }
    seen.add(name)
  }
  // Feed videos often ship without controls or a preload hint; add both so the
  // reader can actually play them, and let CSS cap their size.
  if (tag === 'video') {
    out += ' preload="metadata"'
    if (!seen.has('controls')) out += ' controls=""'
    if (!seen.has('playsinline')) out += ' playsinline=""'
  }
  return out
}

/**
 * Opening tags with their attribute text, tolerating quoted `>` inside values.
 * Used by the id rewrite pass; not a parser, only good enough for well-formed
 * feed markup (the sanitizer drops anything this misses).
 */
const OPEN_TAG_PATTERN = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g

// Footnote ids and markers, in the shapes newsletters and static-site
// generators actually ship: fn1, fn:1, _ftn1, fnref1, note-1, or a plain
// bracketed number inside <sup>.
const FOOTNOTE_ID = /^(?:fn|_ftn|fnref|footnote|note|ref|cite)[-:_.]?\d{1,3}$/i
const FOOTNOTE_MARKER = /^[[(]?\s*\d{1,2}\s*[\])]?$|^[*†‡]$/
const BACK_MARKER = /^[↩⤴↑⇧«»‹›\s]*$|^(?:back|return|返回|戻る)$/i

/** `true` when an anchor points at a note instead of another section. */
function looksLikeFootnote(rawId, text) {
  if (FOOTNOTE_ID.test(rawId)) return true
  const label = String(text || '').trim()
  return label.length <= 6 && FOOTNOTE_MARKER.test(label)
}

/**
 * Rewrite feed-supplied ids and fragments to `mrss-*` ids the sanitizer can
 * allow, and tag footnote markers + their notes so the reader can open a note
 * where the marker is instead of jumping to the end of the article.
 *
 * @returns {{ html: string, notes: number }}
 */
function rewriteIds(html) {
  const ids = new Map()
  let match
  OPEN_TAG_PATTERN.lastIndex = 0
  while ((match = OPEN_TAG_PATTERN.exec(html)) !== null && ids.size < 300) {
    const idMatch = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[2])
    if (!idMatch) continue
    const raw = String(idMatch[1] ?? idMatch[2] ?? '').trim()
    if (!raw || ids.has(raw)) continue
    ids.set(raw, `mrss-${ids.size + 1}`)
  }
  if (ids.size === 0) return { html, notes: 0 }

  html = html.replace(
    /(<[a-zA-Z][a-zA-Z0-9:-]*(?:"[^"]*"|'[^']*'|[^'">])*?\bid\s*=\s*)(?:"([^"]*)"|'([^']*)')/g,
    (whole, head, dq, sq) => {
      const mapped = ids.get(String(dq ?? sq ?? '').trim())
      return mapped ? `${head}"${mapped}"` : head.replace(/\s+id\s*=\s*$/, '')
    },
  )

  // Every fragment link is pointed at its rewritten target (TOC links, section
  // cross-references); footnote-shaped ones also get a marker index so the
  // reader can open the note in place.
  const notes = new Map()
  html = html.replace(/<a\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]{0,200}?)<\/a>/gi, (whole, attrs, inner) => {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
    const fragment = String(href?.[1] ?? href?.[2] ?? '').trim()
    if (!fragment.startsWith('#')) return whole
    const raw = fragment.slice(1)
    const target = ids.get(raw)
    if (!target) return whole
    const cleaned = attrs.replace(/\bhref\s*=\s*(?:"[^"]*"|'[^']*')/i, `href="#${target}"`)
    if (!looksLikeFootnote(raw, textFromHtml(inner))) return `<a${cleaned}>${inner}</a>`
    // A note's own return link ("↩", "back") is not a marker: leave it as a
    // plain in-article link and never register its target as a note.
    if (BACK_MARKER.test(textFromHtml(inner).trim())) return `<a${cleaned}>${inner}</a>`
    let index = notes.get(target)
    if (!index) {
      index = notes.size + 1
      notes.set(target, index)
    }
    return `<a${cleaned} data-mrss-fn="${index}">${inner}</a>`
  })

  // Safety net for links the anchor pass did not reach (very long inner markup):
  // point every remaining raw fragment at its rewritten id so no link is left
  // aimed at an id that no longer exists.
  for (const [raw, mapped] of ids) {
    if (raw === mapped) continue
    html = html.split(`href="#${raw}"`).join(`href="#${mapped}"`)
  }

  let notesMarked = 0
  html = html.replace(OPEN_TAG_PATTERN, (whole, tag, attrs) => {
    if (notesMarked >= notes.size) return whole
    const idMatch = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
    if (!idMatch) return whole
    const index = notes.get(String(idMatch[1] ?? idMatch[2] ?? '').trim())
    if (!index) return whole
    notesMarked += 1
    return whole.replace(/>$/, ` data-mrss-note="${index}">`)
  })

  return { html, notes: notesMarked }
}

const LANG_LABELS = {
  js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX',
  py: 'Python', python: 'Python', rb: 'Ruby', ruby: 'Ruby', go: 'Go', golang: 'Go', rs: 'Rust', rust: 'Rust',
  java: 'Java', kt: 'Kotlin', kotlin: 'Kotlin', swift: 'Swift', c: 'C', h: 'C', cpp: 'C++', 'c++': 'C++',
  cs: 'C#', csharp: 'C#', php: 'PHP', sh: 'Shell', bash: 'Shell', zsh: 'Shell', shell: 'Shell',
  sql: 'SQL', json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', html: 'HTML', css: 'CSS', scss: 'SCSS',
  md: 'Markdown', markdown: 'Markdown', txt: 'Text', diff: 'Diff', graphql: 'GraphQL', dockerfile: 'Dockerfile',
}

/**
 * Label fenced code. Feeds put the language on the `<pre>` or on its `<code>`
 * child, as `language-x`, `lang-x` or `x`; the label is normalised so the
 * reader can print a human name in the block's header.
 */
function annotateCodeLanguages(html) {
  return html.replace(/<pre\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi, (whole, attrs) => {
    const own = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
    let token = guessLanguage(own?.[1] ?? own?.[2] ?? '')
    if (!token) {
      const ahead = html.slice(html.indexOf(whole) + whole.length, html.indexOf(whole) + whole.length + 240)
      const child = /^<code\b((?:"[^"]*"|'[^']*'|[^'">])*)>/i.exec(ahead)
      const childClass = child && /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(child[1])
      token = guessLanguage(childClass?.[1] ?? childClass?.[2] ?? '')
    }
    if (!token) return whole
    return whole.replace(/>$/, ` data-lang="${token}">`)
  })
}

function guessLanguage(value) {
  const raw = String(value || '').toLowerCase()
  if (!raw) return ''
  const token = raw.match(/(?:^|\s)(?:language|lang)-([a-z0-9+#.-]{1,20})(?:\s|$)/) || raw.match(/^([a-z0-9+#.-]{1,20})$/)
  if (!token) return ''
  const key = token[1]
  return LANG_LABELS[key] || ''
}

function normalizeHeadingText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[：:|·—–\-–_]/g, '')
    .toLowerCase()
}

/**
 * Ringo's "cleaner articles" pass: drop spacer paragraphs, an opening heading
 * that only repeats the title, and a rule that opens a section.
 */
function tidyArticle(html, title) {
  let out = html.replace(/<p\b[^>]*>(?:\s|&nbsp;|&#160;|<br\s*\/?>)*<\/p>/gi, '')
  out = out.replace(/<hr\b[^>]*>\s*(?=<h[1-6]\b)/gi, '')
  const wanted = normalizeHeadingText(title)
  if (wanted) {
    // Feeds sometimes repeat the title in the body twice (heading + kicker).
    for (let pass = 0; pass < 2; pass += 1) {
      const before = out
      out = out.replace(/^\s*<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/, (whole, level, inner) => {
        return normalizeHeadingText(inner) === wanted ? '' : whole
      })
      if (out === before) break
    }
  }
  return out
}

/**
 * Sanitize third-party article HTML and collect its headings.
 * @param {{ title?: string }} [options] `title` lets the pass drop a repeated
 *   opening heading.
 * @returns {{ html: string, toc: Array<{ id: string, level: number, text: string }>, notes: number }}
 */
export function sanitizeArticleHtml(input, baseUrl, options = {}) {
  let html = String(input || '')
  html = html.replace(/<!--[\s\S]*?-->/g, '')
  html = html.replace(DROP_WITH_CONTENT, '')
  html = html.replace(DROP_SELF_CONTAINED, '')
  html = annotateCodeLanguages(html)
  const rewritten = rewriteIds(html)
  html = rewritten.html

  html = html.replace(TAG_PATTERN, (_match, closing, rawTag, rawAttrs) => {
    const tag = String(rawTag).toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) return ''
    if (closing) return VOID_TAGS.has(tag) ? '' : `</${tag}>`
    if (VOID_TAGS.has(tag)) {
      if (tag === 'img' || tag === 'source') {
        const attrs = renderAttributes(tag, rawAttrs, baseUrl)
        if (tag === 'img' && !attrs.includes('src=')) return ''
        return `<${tag}${attrs}>`
      }
      return `<${tag}>`
    }
    return `<${tag}${renderAttributes(tag, rawAttrs, baseUrl)}>`
  })

  html = tidyArticle(html, options.title)

  const toc = []
  let index = 0
  html = html.replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi, (match, level, attrs, inner) => {
    const text = textFromHtml(inner).replace(/\s+/g, ' ').trim()
    if (!text) return match
    index += 1
    // Keep an id the feed already gave the heading: in-article links were
    // rewritten to it above, and replacing it would break them.
    const existing = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
    const kept = String(existing?.[1] ?? existing?.[2] ?? '').trim()
    const id = GENERATED_ID.test(kept) ? kept : `sec-${index}`
    toc.push({ id, level: Number(level), text: text.slice(0, 90) })
    const rest = existing ? attrs : `${attrs} id="${id}"`
    return `<h${level}${rest}>${inner}</h${level}>`
  })

  return { html, toc, notes: rewritten.notes }
}

/**
 * Provider video embeds (YouTube, Bilibili, X) that the reader may frame.
 * The sanitizer strips every iframe, so this runs on the *raw* article HTML and
 * on the entry URL, and the client builds the player iframe from provider + id.
 */
const YT_ID = /^[A-Za-z0-9_-]{11}$/

function embedForUrl(raw, baseUrl) {
  let value = String(raw || '').trim()
  if (value.startsWith('//')) value = `https:${value}`
  let url
  try {
    url = new URL(value, baseUrl || undefined)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase().replace(/^www\./, '')

  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0]
    return id && YT_ID.test(id) ? { provider: 'youtube', id } : null
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    const queryId = url.searchParams.get('v') || ''
    const pathId = (url.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{6,20})/) || [])[1] || ''
    const id = queryId || pathId
    return id && YT_ID.test(id) ? { provider: 'youtube', id } : null
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

/**
 * Up to three provider videos for an entry: the entry URL itself plus any
 * provider iframes found in the raw body.
 * @returns {Array<{ provider: 'youtube'|'bilibili'|'x', id: string }>}
 */
export function extractEmbeds(html, pageUrl = '') {
  const out = []
  const seen = new Set()
  const push = (raw) => {
    const embed = embedForUrl(raw, pageUrl)
    if (!embed) return
    const key = `${embed.provider}:${embed.id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ provider: embed.provider, id: embed.id })
  }
  if (pageUrl) push(pageUrl)
  const source = String(html || '')
  const pattern = /<iframe\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
  let match
  let guard = 0
  while ((match = pattern.exec(source)) !== null && guard < 8) {
    guard += 1
    push(decodeEntities(match[1] ?? match[2] ?? ''))
  }
  return out.slice(0, 3)
}

/** Markdown projection used by the agent tool and the export action. */
export function markdownFromHtml(html, baseUrl) {
  let source = String(html || '')
  source = source.replace(/<!--[\s\S]*?-->/g, '')
  source = source.replace(DROP_WITH_CONTENT, '')
  source = source.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (match, attrs, inner) => {
    const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
    const url = href ? safeUrl(href[1] ?? href[2], baseUrl) : ''
    const label = textFromHtml(inner).replace(/\s+/g, ' ').trim() || url
    return url ? `[${label}](${url})` : label
  })
  source = source.replace(/<img\b([^>]*)>/gi, (match, attrs) => {
    const alt = /alt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
    return alt && alt[1] ? `![${alt[1]}]` : ''
  })
  source = source.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (match, level, inner) => {
    return `\n\n${'#'.repeat(Number(level))} ${textFromHtml(inner).trim()}\n\n`
  })
  source = source.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
  source = source.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
  source = source.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (match, inner) => {
    const body = textFromHtml(inner).trim().split('\n').map((line) => `> ${line}`).join('\n')
    return `\n\n${body}\n\n`
  })
  source = source.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (match, inner) => {
    const code = textFromHtml(inner).replace(/\n{3,}/g, '\n\n').trim()
    return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`
  })
  source = source.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (match, inner) => {
    return `\n- ${textFromHtml(inner).replace(/\s+/g, ' ').trim()}`
  })
  source = source.replace(/<\/(p|div|tr|figure|figcaption)>/gi, '\n\n')
  source = source.replace(/<(p|div|tr|figure|figcaption)\b[^>]*>/gi, '\n')
  source = source.replace(/<br\s*\/?>/gi, '\n')
  source = source.replace(/<[^>]*>/g, '')
  return decodeEntities(source)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** CJK-aware reading estimate; Miniflux already sends one, this is the fallback. */
/**
 * First usable image in an entry body, resolved against the entry URL. Used by
 * the list cards; data: and relative sources are either dropped or resolved.
 */
export function firstImageFromHtml(html, baseUrl = '') {
  // Only the top of the body is scanned: cards never use a lead image that
  // lives deep in the article, and entries can carry hundreds of KB of HTML.
  const source = String(html || '').slice(0, 20_000)
  const pattern = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi
  let match
  while ((match = pattern.exec(source))) {
    const raw = decodeEntities(match[1]).trim()
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) continue
    try {
      const resolved = new URL(raw, baseUrl || undefined)
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
      return resolved.href
    } catch {
      continue
    }
  }
  return ''
}

export function estimateMinutes(text) {
  const body = String(text || '')
  const cjk = (body.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
  const words = (body.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || []).length
  return Math.max(1, Math.round(cjk / 380 + words / 210))
}

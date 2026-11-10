/**
 * Normalize the JSON from X's public syndication endpoint
 * (cdn.syndication.twimg.com/tweet-result) into the small shape the reader
 * needs: the author, the text, and playable video variants.
 *
 * The reader does not render X's embed card; it shows the entry body as-is and
 * only adds the tweet's video, which RSS feeds rarely carry.
 */

const TWIMG_HOSTS = new Set(['video.twimg.com', 'pbs.twimg.com'])

function safeTwimgUrl(raw) {
  const value = String(raw || '').trim()
  if (!/^https:\/\//i.test(value)) return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return ''
    return TWIMG_HOSTS.has(url.hostname.toLowerCase()) ? url.href : ''
  } catch {
    return ''
  }
}

function noteText(json) {
  const note = json?.note_tweet?.note_tweet_results?.result?.text
  if (typeof note === 'string' && note.trim()) return note
  return typeof json?.text === 'string' ? json.text : ''
}

/**
 * @returns {{ text: string, name: string, screenName: string, createdAt: string,
 *   videos: Array<{ src: string, poster: string }>,
 *   images: Array<{ src: string, alt: string }> } | null}
 */
export function tweetFromSyndication(json) {
  if (!json || typeof json !== 'object') return null
  const user = json.user || {}
  const media = Array.isArray(json.mediaDetails) ? json.mediaDetails : []
  const videos = []
  const images = []
  for (const item of media) {
    if (!item || typeof item !== 'object') continue
    const type = String(item.type || '')
    if (type === 'photo') {
      const src = safeTwimgUrl(item.media_url_https)
      if (src) images.push({ src, alt: String(item.ext_alt_text || '') })
      continue
    }
    if (type !== 'video' && type !== 'animated_gif') continue
    const variants = Array.isArray(item.video_info?.variants) ? item.video_info.variants : []
    const mp4 = variants
      .filter((variant) => variant && variant.content_type === 'video/mp4' && safeTwimgUrl(variant.url))
      .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0]
    if (!mp4) continue
    videos.push({ src: safeTwimgUrl(mp4.url), poster: safeTwimgUrl(item.media_url_https), loop: type === 'animated_gif' })
  }
  return {
    text: noteText(json),
    name: String(user.name || ''),
    screenName: String(user.screen_name || ''),
    createdAt: String(json.created_at || ''),
    videos,
    images,
  }
}

/**
 * In-memory TTL cache with stale-while-revalidate, shared by the reader routes
 * and the agent tools.
 *
 * Two rules matter for the panel's perceived speed:
 *
 * - `runSWR` answers from an aging value immediately and refreshes it in the
 *   background, so a catalog older than its TTL does not turn every open into a
 *   Miniflux round trip. Only past `staleTtl` does a caller wait again.
 * - `expire` drops the keys an action actually changed instead of the whole
 *   cache. Marking one entry read used to clear everything, which made the next
 *   bootstrap a cold fetch of feeds, categories, counters and /me.
 */
export function createCache({ now = Date.now } = {}) {
  const entries = new Map()
  const refreshing = new Map()

  function get(key) {
    const hit = entries.get(key)
    if (!hit) return undefined
    if (now() - hit.at > hit.ttl) {
      entries.delete(key)
      return undefined
    }
    return hit.value
  }

  function set(key, value, ttl) {
    entries.set(key, { at: now(), value, ttl })
    return value
  }

  function run(key, ttl, fn) {
    const hit = get(key)
    if (hit !== undefined) return hit
    return Promise.resolve(fn()).then((value) => set(key, value, ttl))
  }

  function runSWR(key, ttl, staleTtl, fn) {
    const hit = entries.get(key)
    if (hit) {
      const age = now() - hit.at
      if (age <= ttl) return hit.value
      if (age <= staleTtl) {
        if (!refreshing.has(key)) {
          const task = Promise.resolve()
            .then(fn)
            .then((value) => set(key, value, ttl))
            .catch(() => hit.value)
            .finally(() => { refreshing.delete(key) })
          refreshing.set(key, task)
        }
        return hit.value
      }
      entries.delete(key)
    }
    return Promise.resolve(fn()).then((value) => set(key, value, ttl))
  }

  function matches(key, prefixes) {
    return prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}:`))
  }

  function expire(prefixes) {
    for (const key of [...entries.keys()]) if (matches(key, prefixes)) entries.delete(key)
    for (const key of [...refreshing.keys()]) if (matches(key, prefixes)) refreshing.delete(key)
  }

  function clear() {
    entries.clear()
    refreshing.clear()
  }

  return {
    get,
    set,
    run,
    runSWR,
    expire,
    clear,
    /** Test/diagnostic helpers. */
    get size() {
      return entries.size
    },
    pendingRefreshes() {
      return refreshing.size
    },
  }
}

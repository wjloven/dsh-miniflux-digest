#!/usr/bin/env node
/**
 * Restore the Miniflux account that a credentials repair commented out.
 *
 * The 2026-11-09 crash left three duplicated `rss-miniflux` records in
 * `~/.dsh/.credentials.yaml`; the repair commented them out so the Host could
 * boot again, which also disconnected the plugin. This reads the commented
 * block back and re-adds the account through the plugin's own API, so the write
 * goes through the credential service (serialized, valid keys) instead of
 * hand-editing the YAML.
 *
 * The token never leaves this process except into the local plugin endpoint,
 * and is never printed.
 *
 * Usage: node scripts/restore-account.mjs [--dry-run] [--url http://127.0.0.1:PORT]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const urlFlag = args.indexOf('--url')
const base = (urlFlag >= 0 ? args[urlFlag + 1] : process.env.DSH_WEB_URL || 'http://127.0.0.1:62253').replace(/\/+$/, '')

const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
const text = fs.readFileSync(file, 'utf8')

/** Read the commented `# rss-miniflux` record blocks left by the repair. */
function commentedBlocks(source) {
  const blocks = []
  let current = null
  for (const line of source.split('\n')) {
    const stripped = line.replace(/^\s*#\s?/, '')
    if (/^rss-miniflux[^\s]*:\s*$/.test(stripped)) {
      if (current) blocks.push(current)
      current = {}
      continue
    }
    if (!current) continue
    if (!/^\s*#/.test(line) || line.trim() === '') {
      if (line.trim() !== '') {
        blocks.push(current)
        current = null
      }
      continue
    }
    const match = /^\s*#\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (match) current[match[1]] = unquote(match[2])
  }
  if (current) blocks.push(current)
  return blocks
}

function unquote(value) {
  const raw = String(value || '').trim()
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'")
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw.slice(1, -1)
    }
  }
  return raw
}

const blocks = commentedBlocks(text)
const candidate = blocks.find((block) => block.key && !block.key.startsWith('[') && block.MINIFLUX_BASE_URL)
if (!candidate) {
  console.error('no commented rss-miniflux account block with a token and base URL was found')
  process.exit(2)
}

console.log(`found account block: ${candidate.MINIFLUX_BASE_URL} (token ${candidate.key.length} chars)`)
if (dryRun) {
  console.log('dry run: nothing written')
  process.exit(0)
}

const response = await fetch(`${base}/rss-miniflux/api/accounts/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'add', baseUrl: candidate.MINIFLUX_BASE_URL, apiToken: candidate.key }),
})
const payload = await response.json().catch(() => null)
if (!response.ok || !payload?.ok) {
  console.error(`restore failed (${response.status}): ${payload?.error?.message || 'unknown error'}`)
  process.exit(1)
}

const active = (payload.accounts || []).find((account) => account.active)
console.log(`restored: ${active?.username || 'connected'} · ${active?.baseUrl || candidate.MINIFLUX_BASE_URL}`)

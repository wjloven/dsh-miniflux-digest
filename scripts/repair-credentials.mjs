#!/usr/bin/env node
/**
 * Repair a corrupted DSH credentials document.
 *
 * The failure this fixes: two writers (or a crashed restart) leave the same
 * record key twice in `records:`, the YAML parser rejects the whole file with
 * DUPLICATE_KEY, and the Host cannot boot at all. Recovering by hand means
 * commenting lines inside a file full of secrets; this does it with a backup.
 *
 * Usage:
 *   node scripts/repair-credentials.mjs --check     # report only
 *   node scripts/repair-credentials.mjs             # repair ~/.dsh/.credentials.yaml
 *   node scripts/repair-credentials.mjs <path>
 *
 * The first occurrence of a duplicated key wins; later copies are commented
 * out block by block, so their content stays visible for manual recovery.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const target = args.find((value) => !value.startsWith('--'))
  || path.join(os.homedir(), '.dsh', '.credentials.yaml')

if (!fs.existsSync(target)) {
  console.error(`no such file: ${target}`)
  process.exit(2)
}

const text = fs.readFileSync(target, 'utf8')
const lines = text.split('\n')

/** Top-level sections (`version`, `refs`, `records`) bound the scan. */
function sectionBounds(name) {
  const start = lines.findIndex((line) => line === `${name}:`)
  if (start < 0) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.length === 0) continue
    if (!line.startsWith(' ') && !line.startsWith('#')) {
      end = index
      break
    }
  }
  return { start, end }
}

/** A record block runs from its 2-space key line to the next 2-space key. */
function sectionEntries(bounds) {
  const entries = []
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    // Commented-out recovery blocks are not live entries.
    if (lines[index].trimStart().startsWith('#')) continue
    const match = /^  ('?[^':#]+'?|"[^"]+"):\s*$/.exec(lines[index])
    if (!match) continue
    const key = match[1].replace(/^['"]|['"]$/g, '')
    let end = bounds.end
    for (let probe = index + 1; probe < bounds.end; probe += 1) {
      if (/^  \S/.test(lines[probe]) && !lines[probe].startsWith('   ')) {
        end = probe
        break
      }
    }
    entries.push({ key, start: index, end })
    index = end - 1
  }
  return entries
}

const records = sectionBounds('records')
if (!records) {
  console.log('no `records:` section; nothing to repair')
  process.exit(0)
}

const seen = new Map()
const duplicates = []
for (const entry of sectionEntries(records)) {
  const first = seen.get(entry.key)
  if (first === undefined) {
    seen.set(entry.key, entry.start)
    continue
  }
  duplicates.push({ ...entry, firstLine: first + 1 })
}

if (duplicates.length === 0) {
  console.log(`ok: no duplicate record keys in ${target}`)
  process.exit(0)
}

console.log(`${duplicates.length} duplicate record key(s) in ${target}:`)
for (const duplicate of duplicates) {
  console.log(`  "${duplicate.key}" repeats at line ${duplicate.start + 1} (first at line ${duplicate.firstLine})`)
}

if (checkOnly) process.exit(1)

const backup = `${target}.bak-repair-${Date.now()}`
fs.copyFileSync(target, backup)
fs.chmodSync(backup, 0o600)

// Comment out every line of a later duplicate block, keeping its content.
const output = [...lines]
for (const duplicate of duplicates) {
  for (let index = duplicate.start; index < duplicate.end; index += 1) {
    if (output[index].length === 0) continue
    output[index] = `# ${output[index]}`
  }
}
fs.writeFileSync(target, output.join('\n'), { mode: 0o600 })

console.log(`repaired; backup at ${backup}`)
console.log('restart DeepSeek Harness, then re-check the plugin that owns those records')

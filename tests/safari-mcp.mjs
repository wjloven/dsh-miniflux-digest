#!/usr/bin/env node
/**
 * Minimal MCP stdio client for /usr/bin/safarimcp (safaridriver --mcp).
 * Usage: node safari-mcp.mjs list
 *        node safari-mcp.mjs call <tool> '<json-args>'
 */
import { spawn } from 'node:child_process'

const BIN = '/usr/bin/safarimcp'
const [mode, toolName, rawArgs] = process.argv.slice(2)

const child = spawn(BIN, ['--mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })
let buffer = ''
const pending = new Map()
let nextId = 1

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
  }
})
child.stderr.on('data', (chunk) => process.stderr.write(`[safari] ${chunk}`))

function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout: ${method}`))
      }
    }, 90_000)
  })
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

async function main() {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dsh', version: '0.0.0' },
  })
  notify('notifications/initialized', {})
  if (mode === 'list') {
    const tools = await request('tools/list', {})
    console.log(JSON.stringify({ serverInfo: init.serverInfo, tools: tools.tools }, null, 1))
    return
  }
  if (mode === 'shot') {
    const tabs = await request('tools/call', { name: 'list_tabs', arguments: {} })
    const text = tabs.content?.[0]?.text || ''
    let list = []
    try { list = JSON.parse(text) } catch { list = [] }
    const target = (Array.isArray(list) ? list : list.tabs || []).find((tab) => String(tab.url || '').includes('reader.example.com'))
    if (target?.handle) await request('tools/call', { name: 'switch_tab', arguments: { handle: target.handle } })
    const shot = await request('tools/call', { name: 'screenshot', arguments: { path: `/tmp/safari-shot-${Date.now()}.png` } })
    console.log(JSON.stringify({ tabs: list, shot }, null, 1))
    return
  }
  if (mode === 'call') {
    const args = rawArgs ? JSON.parse(rawArgs) : {}
    const result = await request('tools/call', { name: toolName, arguments: args })
    console.log(JSON.stringify(result, null, 1))
    return
  }
  console.log(JSON.stringify(init, null, 1))
}

main()
  .catch((error) => {
    console.error('ERROR', error.message)
    process.exitCode = 1
  })
  .finally(() => {
    child.kill()
  })

#!/usr/bin/env node
/**
 * volcano-separator MCP server (stdio, hand-rolled JSON-RPC, zero dependencies)
 *
 * For any harness.
 *
 * Service lifecycle
 *   volcano_status       whole-chain check (read-only unless deep=true)
 *   volcano_heal         intelligent repair: warm -> serve -> watch
 *   volcano_doctor       historical start-failure diagnosis
 *
 * Observation -- read-only
 *   volcano_resources    free memory, CPU load, largest processes, and whether heavy work fits
 *   volcano_activity     the system-wide process/window/persistence record
 *   volcano_busy         what has actually been running, grouped
 *   volcano_ps           what is running now, with ages
 *   volcano_redline      what is sitting in user-writable space on the system drive
 *   volcano_cache_plan   what a uv cache prune would remove -- the plan only, never applied
 *
 * Incident response -- read-only
 *   volcano_signals      what looks like stealth, with evidence
 *   volcano_decide       what would be done about each signal, and the current mode
 *   volcano_detained     what is under custody, reconciled against the live system
 *   volcano_timeline     the life of each custody decision
 *
 * Why there is no mutating tool beyond `heal`
 * -------------------------------------------
 * `heal` repairs a service the agent is usually the reason for needing; it removes nothing and the
 * worst outcome is a slower path to the same state. Everything else that changes the machine --
 * `detain`, `release`, `cache --apply`, `policy allow` -- needs a human in the loop, and an agent
 * that can freeze a process or delete cache entries on its own is a worse failure than an agent
 * that has to ask. `cache_plan` exists precisely so an agent can show a person what a prune WOULD
 * do and let them run it.
 *
 * Read-only here means read-only: nothing in this list writes to the activity record, the policy
 * file, the cache, or any process. `volcano_status` is the one that borders on it -- measuring uv
 * warmth runs uvx, and uvx writes to the cache -- so that probe is behind `deep` and off by default.
 */

import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOLS, call } from './tools.mjs'

// Re-exported so the split does not move the public surface, only the file the code lives in.
export { TOOLS, call } from './tools.mjs'
// One version, read from the one place that declares it.
//
// This was hardcoded to '1.0.0' and stayed there through five releases, so an MCP client asking
// the server what it was got an answer five versions out of date. A second copy of a value is a
// second thing to forget. The fallback is deliberately not a plausible version number: if
// package.json cannot be read, saying so is better than naming a release that does not exist.
let VERSION = 'unknown (package.json unreadable)'
try {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
  if (pkg?.version) VERSION = pkg.version
} catch {
  /* keep the honest placeholder */
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const t = line.trim()
  if (!t) return
  let req
  try {
    req = JSON.parse(t)
  } catch {
    return
  }
  const { id, method, params } = req
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'volcano-separator', version: VERSION },
        },
      })
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    } else if (method === 'tools/call') {
      const r = await call(params?.name, params?.arguments ?? {})
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: r.text }], isError: !r.ok },
      })
    } else if (method === 'notifications/initialized') {
      /* notification: no reply */
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `not implemented: ${method}` } })
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(e?.message ?? e) } })
  }
})

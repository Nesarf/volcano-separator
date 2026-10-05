#!/usr/bin/env node
/**
 * volcano-separator MCP server (stdio, hand-rolled JSON-RPC, zero dependencies)
 *
 * For any harness. Tools:
 *   volcano_status  -- whole-chain check
 *   volcano_heal    -- intelligent repair (warm -> serve -> watch)
 *   volcano_doctor  -- historical start-failure diagnosis
 */

import { createInterface } from 'node:readline'
import * as g from './core.mjs'

const TOOLS = [
  {
    name: 'volcano_status',
    description:
      'Whole-chain check of the Hindsight memory service: is the uv toolchain present, is the daemon port answering, is Postgres reachable, is the watchdog task installed. Also scans the daemon log for errors, because a service can answer on its port while being unable to reach its database. Read-only by default: the uv env warmth probe is skipped because measuring it runs uvx, which writes to the uv cache.',
    inputSchema: {
      type: 'object',
      properties: {
        deep: {
          type: 'boolean',
          description: 'Also measure whether the uv env is warm. NOT read-only: it runs a uvx dry run, and uvx creates a cache environment to do so.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'volcano_heal',
    description:
      'Intelligently repair the Hindsight memory service: probe first (returns immediately, nearly free, when healthy); otherwise close the gaps in stages -- warm (bring the uv env up to date, no watchdog) -> serve (seconds once warm) -> watch (confirm stability across consecutive probes).',
    inputSchema: {
      type: 'object',
      properties: { force: { type: 'boolean', description: 'Ignore the "already healthy" check and redo it from the start.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'volcano_doctor',
    description:
      'Count historical Hindsight daemon start failures from the host plugin log, answering "why did it used to die without warning" (typical answer: the start path carried a download/build and tripped a ~180 s watchdog).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

async function call(name, args = {}) {
  const ctx = g.resolveContext({})
  if (name === 'volcano_status') {
    const s = await g.status(ctx, { deep: args.deep === true })
    const svc = await g.serviceState(ctx)
    const text = `${s.text}\n  watchdog    : ${svc.installed ? `[ok  ] ${svc.state} (last ${svc.lastRun}, result ${svc.lastResult})` : '[FAIL] not installed'}`
    return { ok: s.ok, text }
  }
  if (name === 'volcano_heal') {
    const r = await g.heal(ctx, { force: args.force === true })
    return {
      ok: r.ok,
      text: r.ok ? (r.fastPath ? 'Healthy, nothing to do.' : 'Repaired.') : `Repair failed at ${r.failedAt}: ${r.steps.at(-1)?.detail ?? ''}`,
      detail: r,
    }
  }
  if (name === 'volcano_doctor') {
    const d = await g.doctor(ctx)
    return { ok: true, text: d.verdict, detail: d }
  }
  throw new Error(`unknown tool: ${name}`)
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
          serverInfo: { name: 'volcano-separator', version: '1.0.0' },
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

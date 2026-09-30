#!/usr/bin/env node
'use strict'
// QA stand-in for one role in a simulated company
// (qa/scenarios/11-company-simulation.qa.ts). It is spawned by Foreman the
// way the real agent is:
//
//   <agent> task <argv…>   Claude Code (`claude --print <task>`) and Codex
//                          (`codex exec <task>`): the task is the last
//                          argument, the answer goes to stdout.
//   <agent> acp            Hermes, OpenClaw, ZeroClaw: ACP (JSON-RPC over
//                          stdio). The answer streams as session/update
//                          agent_message_chunk notifications, and the prompt
//                          ends with { stopReason: "end_turn" }, like the
//                          real agents.
//
// What it does with a task comes from the playbook in QA_PLAYBOOK: a reply,
// work to hand on with `foreman write <agent> <task>` (as itself: Foreman
// sets FOREMAN_SPAWNED_BY), and a post or an org_report through the Foreman
// MCP server this launch was given (an instance's own: Codex `-c
// mcp_servers.foreman.*`, Claude Code `--mcp-config`; Claude Code itself
// reads ~/.claude.json, as the real one does). The "What you did recently"
// block Foreman puts before a task is set aside before the playbook is
// matched, so a rule answers the task, not the memory. Every task it
// receives is logged to QA_AGENT_LOG, with its argv and that block. It
// touches no network and no file outside the sandbox.

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const readline = require('node:readline')
const toml = require('smol-toml')

const [agent, mode, ...rest] = process.argv.slice(2)

/** The Foreman MCP server this launch was given, from its argv, or null.
 *  Codex does what the real Codex (0.159) does: it starts from the
 *  `foreman` server in its own config.toml and merges each `-c` into it
 *  table by table, so keys the launch leaves alone (a token `agent add
 *  codex` wrote there) survive. */
function launchServer(argv) {
  const cfg = argv.indexOf('--mcp-config')
  if (cfg >= 0) return JSON.parse(argv[cfg + 1]).mcpServers.foreman
  if (agent !== 'codex') return null
  let config = {}
  const home = process.env.CODEX_HOME || require('node:path').join(process.env.HOME || '', '.codex')
  try {
    config = toml.parse(fs.readFileSync(require('node:path').join(home, 'config.toml'), 'utf8'))
  } catch {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '-c') continue
    try {
      config = mergeTables(config, toml.parse(argv[i + 1]))
    } catch {}
  }
  const server = (config.mcp_servers || {}).foreman
  return server && server.command && server.enabled !== false ? server : null
}

function mergeTables(into, from) {
  const isTable = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
  const out = { ...into }
  for (const [key, value] of Object.entries(from)) out[key] = isTable(out[key]) && isTable(value) ? mergeTables(out[key], value) : value
  return out
}

/** Claude Code without an instance's own server uses its user config. */
function userServer() {
  if (agent !== 'claude-code') return null
  try {
    const cfg = JSON.parse(fs.readFileSync(require('node:path').join(process.env.HOME, '.claude.json'), 'utf8'))
    return (cfg.mcpServers && cfg.mcpServers.foreman) || null
  } catch {
    return null
  }
}

const MEMORY_HEADER = '## What you did recently\n'
const MEMORY_END = '## Your task\n'

/** [the task without Foreman's memory block, the block or null]. */
function splitMemory(task) {
  const at = task.indexOf(MEMORY_HEADER)
  const end = at >= 0 ? task.indexOf(MEMORY_END, at) : -1
  if (end < 0) return [task, null]
  return [task.slice(0, at) + task.slice(end + MEMORY_END.length), task.slice(at, end + MEMORY_END.length)]
}

/** Call a Foreman MCP tool, as the launch says, and return its reply. */
function mcpCall(server, name, args) {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa-company-agent', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ]
    .map((m) => JSON.stringify(m))
    .join('\n')
  // The server's own env is what proves who calls (a token file for an
  // instance, the token in ~/.claude.json for Claude Code itself), never
  // one inherited from the launch.
  const env = { ...process.env }
  delete env.FOREMAN_AGENT_TOKEN
  delete env.FOREMAN_AGENT_TOKEN_FILE
  Object.assign(env, server.env || {})
  const r = spawnSync(server.command, server.args || [], { input: input + '\n', encoding: 'utf8', env, timeout: 30000 })
  for (const line of (r.stdout || '').split('\n')) {
    try {
      const msg = JSON.parse(line)
      if (msg.id === 2) return ((msg.result && msg.result.content) || []).map((c) => c.text).join(' ') || JSON.stringify(msg.error)
    } catch {}
  }
  return 'no answer: ' + (r.stderr || '').trim().split('\n').pop()
}

function play(received, argv = []) {
  const server = launchServer(argv)
  const [task, memory] = splitMemory(received)
  fs.appendFileSync(
    process.env.QA_AGENT_LOG,
    JSON.stringify({
      agent,
      task,
      memory,
      spawnedBy: process.env.FOREMAN_SPAWNED_BY || null,
      depth: process.env.FOREMAN_SPAWN_DEPTH || null,
      server,
      argv,
      cwd: process.cwd(),
    }) + '\n',
  )
  const book = JSON.parse(fs.readFileSync(process.env.QA_PLAYBOOK, 'utf8'))
  const rule = (book[agent] || []).find((r) => new RegExp(r.when, 'i').test(task))
  if (!rule) return 'Done: ' + task
  const lines = [rule.reply]
  const mcp = server || userServer()
  if (rule.post) lines.push('posted: ' + (mcp ? mcpCall(mcp, 'org_post', { to: rule.post[0], text: rule.post[1] }) : 'no Foreman server in this launch'))
  if (rule.report) lines.push('reported: ' + (mcp ? mcpCall(mcp, 'org_report', { text: rule.report }) : 'no Foreman server in this launch'))
  for (const [to, subtask] of rule.delegate || []) {
    const r = spawnSync('foreman', ['write', to, subtask], { encoding: 'utf8', env: process.env })
    const said = ((r.stderr || '') + (r.stdout || '')).trim().split('\n')[0]
    lines.push(r.status === 0 ? 'handed to ' + to + ': ' + subtask : 'could not hand to ' + to + ': ' + said)
  }
  return lines.join('\n')
}

if (mode === 'task') {
  if (rest.includes('--version')) {
    process.stdout.write(agent + ' 0.0.0-qa-company\n')
    process.exit(0)
  }
  // `codex exec <task> …` / `claude --print <task> …`: the task follows the
  // subcommand; flags Foreman appends come after it.
  const at = rest.findIndex((a) => a === 'exec' || a === '--print' || a === '-p')
  const task = at >= 0 ? rest[at + 1] : rest[rest.length - 1]
  process.stdout.write(play(task || '', rest) + '\n')
  process.exit(0)
}

if (mode !== 'acp') {
  process.stdout.write(agent + ' 0.0.0-qa-company\n')
  process.exit(0)
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || 1, agentCapabilities: {} } })
  } else if (msg.method === 'session/new') {
    send({ id: msg.id, result: { sessionId: 'qa-' + agent } })
  } else if (msg.method === 'session/prompt') {
    const params = msg.params || {}
    const task = (params.prompt || []).map((b) => b.text || '').join('\n')
    const reply = play(task)
    // Two chunks, as a real agent streams: Foreman must join them.
    const cut = Math.ceil(reply.length / 2)
    for (const text of [reply.slice(0, cut), reply.slice(cut)]) {
      send({
        method: 'session/update',
        params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
      })
    }
    send({ id: msg.id, result: { stopReason: 'end_turn' } })
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'not supported by the QA stand-in' } })
  }
})

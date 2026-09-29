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
// and work to hand on with `foreman write <agent> <task>` (as itself:
// Foreman sets FOREMAN_SPAWNED_BY). Every task it receives is logged to
// QA_AGENT_LOG. It touches no network and no file outside the sandbox.

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const readline = require('node:readline')

const [agent, mode, ...rest] = process.argv.slice(2)

function play(task) {
  fs.appendFileSync(
    process.env.QA_AGENT_LOG,
    JSON.stringify({
      agent,
      task,
      spawnedBy: process.env.FOREMAN_SPAWNED_BY || null,
      depth: process.env.FOREMAN_SPAWN_DEPTH || null,
    }) + '\n',
  )
  const book = JSON.parse(fs.readFileSync(process.env.QA_PLAYBOOK, 'utf8'))
  const rule = (book[agent] || []).find((r) => new RegExp(r.when, 'i').test(task))
  if (!rule) return 'Done: ' + task
  const lines = [rule.reply]
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
  process.stdout.write(play(rest[rest.length - 1] || '') + '\n')
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

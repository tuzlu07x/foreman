#!/usr/bin/env node
let buffer = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    handle(msg)
  }
})

function handle(msg) {
  if (msg.method === 'tools/list') {
    respond(msg.id, {
      tools: [
        { name: 'echo', description: 'Echo the input string', inputSchema: { type: 'object' } },
      ],
    })
    return
  }
  if (msg.method === 'tools/call') {
    if (msg.params?.name === 'echo') {
      respond(msg.id, {
        content: [{ type: 'text', text: String(msg.params?.arguments?.text ?? '') }],
      })
      return
    }
    respondError(msg.id, -32601, 'Unknown tool')
    return
  }
  if (msg.method === 'initialize') {
    respond(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake', version: '0.0.0' },
    })
    return
  }
  if (typeof msg.id !== 'undefined') {
    respondError(msg.id, -32601, `Method not found: ${msg.method}`)
  }
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

#!/usr/bin/env node
// A child that closes its stdin and then keeps running — the shape #594
// describes, where a nested agent tears down its MCP server but the process
// itself is still alive. Writing to it raises EPIPE on the parent's stdin,
// which must not be mistaken for the child having exited.
import { closeSync } from 'node:fs'

process.stdout.write(
  JSON.stringify({ jsonrpc: '2.0', id: 0, result: { ready: true } }) + '\n',
)

try {
  process.stdin.pause()
} catch {
  /* already unusable */
}
try {
  closeSync(0)
} catch {
  /* nothing to close */
}

setInterval(() => {}, 1 << 30)

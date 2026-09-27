'use strict'
// Preloaded (NODE_OPTIONS=--require) into every Node process a QA scenario
// starts. Foreman must never reach the network during QA: any TCP connection
// to a host other than the loopback interface is refused and recorded in
// QA_NET_LOG, and each scenario asserts that log stays empty. Unix sockets
// and 127.0.0.1 / ::1 / localhost are allowed (webhook receiver, OTLP).

const net = require('node:net')
const fs = require('node:fs')

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])
const logPath = process.env.QA_NET_LOG

function target(args) {
  let first = args[0]
  if (Array.isArray(first)) first = first[0]
  if (first && typeof first === 'object') {
    if (typeof first.path === 'string' && first.path.length > 0) return null
    return { host: first.host === undefined ? 'localhost' : String(first.host), port: first.port }
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first }
  }
  return null
}

const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function guardedConnect(...args) {
  const t = target(args)
  if (t && !LOOPBACK.has(t.host)) {
    const message = `QA network guard: blocked connection to ${t.host}:${t.port} (pid ${process.pid})`
    if (logPath) {
      try {
        fs.appendFileSync(logPath, `${message} argv=${JSON.stringify(process.argv.slice(1))}\n`)
      } catch {
        /* the guard still blocks */
      }
    }
    process.nextTick(() => this.destroy(new Error(message)))
    return this
  }
  return originalConnect.apply(this, args)
}

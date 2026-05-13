import { safeParseMessage, type JSONRPCMessage } from './types.js'

/**
 * MCP stdio framing is newline-delimited JSON: each message is a single
 * JSON object on its own line, no length prefix. We keep an internal
 * buffer because reads from a child process can split a message across
 * chunks or fuse several together.
 */
export interface DecodeResult {
  /** Messages parsed out of the chunks fed so far. */
  messages: JSONRPCMessage[]
  /** Lines that parsed as JSON but failed schema validation (for logging). */
  rejected: string[]
}

export interface MessageDecoder {
  /** Feed a raw chunk (string or Buffer) and pull out any completed messages. */
  push(chunk: string | Buffer): DecodeResult
  /** Remaining bytes still in the buffer (a partial message, usually). */
  remainder(): string
}

export function createDecoder(): MessageDecoder {
  let buffer = ''
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      const messages: JSONRPCMessage[] = []
      const rejected: string[] = []
      let newlineAt: number
      while ((newlineAt = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineAt).trim()
        buffer = buffer.slice(newlineAt + 1)
        if (line.length === 0) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          rejected.push(line)
          continue
        }
        const validated = safeParseMessage(parsed)
        if (validated) messages.push(validated)
        else rejected.push(line)
      }
      return { messages, rejected }
    },
    remainder() {
      return buffer
    },
  }
}

/** One-shot decode for a single, already-trimmed line. Returns null on any failure. */
export function decodeMessage(line: string): JSONRPCMessage | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  return safeParseMessage(parsed)
}

/** Encode for the wire: JSON + a single trailing newline. */
export function encodeMessage(message: JSONRPCMessage): string {
  return `${JSON.stringify(message)}\n`
}

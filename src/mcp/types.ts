/**
 * MCP types and validation schemas. We lean on the SDK's zod schemas
 * (`@modelcontextprotocol/sdk` ships them at `/types.js`) and only
 * re-export the slices Foreman cares about in v0.1, plus narrow helpers
 * for discrimination.
 *
 * Why re-export rather than redeclare: the protocol evolves; the SDK
 * owns the source of truth. Wrapping it gives us one place to bump
 * versions or stub fields in tests.
 */
import {
  CallToolRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  CallToolResultSchema,
  InitializeRequestSchema,
  type InitializeRequest,
  type InitializeResult,
  JSONRPCErrorResponseSchema,
  type JSONRPCError,
  JSONRPCMessageSchema,
  type JSONRPCMessage,
  JSONRPCNotificationSchema,
  type JSONRPCNotification,
  JSONRPCRequestSchema,
  type JSONRPCRequest,
  JSONRPCResponseSchema,
  type JSONRPCResponse,
  ListToolsRequestSchema,
  type ListToolsRequest,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js'

export {
  CallToolRequestSchema,
  CallToolResultSchema,
  InitializeRequestSchema,
  JSONRPCErrorResponseSchema,
  JSONRPCMessageSchema,
  JSONRPCNotificationSchema,
  JSONRPCRequestSchema,
  JSONRPCResponseSchema,
  ListToolsRequestSchema,
}
export type {
  CallToolRequest,
  CallToolResult,
  InitializeRequest,
  InitializeResult,
  JSONRPCError,
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
  JSONRPCResponse,
  ListToolsRequest,
  ListToolsResult,
}

/**
 * Method names Foreman currently mediates. Anything outside this list
 * goes through verbatim — we don't pretend to gate the long tail of MCP
 * methods in v0.1.
 */
export const FOREMAN_METHODS = [
  'initialize',
  'tools/list',
  'tools/call',
  'prompts/list',
  'prompts/get',
  'resources/list',
  'resources/read',
  'resources/subscribe',
  'resources/unsubscribe',
] as const
export type ForemanMethod = (typeof FOREMAN_METHODS)[number]

export function isForemanMethod(method: string): method is ForemanMethod {
  return (FOREMAN_METHODS as readonly string[]).includes(method)
}

/** A JSON-RPC message that carries a method (request *or* notification). */
export type JSONRPCMethodMessage = JSONRPCRequest | JSONRPCNotification

export function isRequest(msg: JSONRPCMessage): msg is JSONRPCRequest {
  return 'id' in msg && 'method' in msg
}

export function isNotification(msg: JSONRPCMessage): msg is JSONRPCNotification {
  return 'method' in msg && !('id' in msg)
}

export function isResponse(msg: JSONRPCMessage): msg is JSONRPCResponse {
  return 'id' in msg && 'result' in msg
}

export function isErrorResponse(msg: JSONRPCMessage): msg is JSONRPCError {
  return 'id' in msg && 'error' in msg
}

/** Strict parse — throws on invalid input. Use for hot paths that already trust the source. */
export function parseMessage(input: unknown): JSONRPCMessage {
  return JSONRPCMessageSchema.parse(input) as JSONRPCMessage
}

/** Soft parse — returns `null` on invalid input. Use for untrusted transport reads. */
export function safeParseMessage(input: unknown): JSONRPCMessage | null {
  const result = JSONRPCMessageSchema.safeParse(input)
  return result.success ? (result.data as JSONRPCMessage) : null
}

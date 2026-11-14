// Port of the JSON-RPC envelope/type helpers in dstu-mcp/src/mcp/client.rs.
// Transport wiring is native/network work; this module keeps the wire contract.

import type { JsonValue } from '../api.ts';

export interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  /** JSON-RPC 2.0 omits params instead of emitting null. */
  params?: JsonValue;
  id: JsonValue;
}

export interface JsonRpcNotification {
  jsonrpc: string;
  method: string;
  params?: JsonValue;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  result?: JsonValue;
  error?: JsonRpcError;
  id: JsonValue;
}

export interface RootsCapability {
  listChanged?: boolean | null;
}
export interface SamplingCapability {
  enabled: boolean;
}
export interface ClientCapabilities {
  roots?: RootsCapability | null;
  sampling?: SamplingCapability | null;
  experimental?: Record<string, JsonValue> | null;
}

export interface McpToolSpec {
  name: string;
  description: string | null;
  inputSchema: JsonValue;
}

export interface McpResourceContent {
  uri: string;
  mimeType: string | null;
  text: string | null;
  blob: string | null;
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: McpResourceContent };

export interface McpToolResultSpec {
  content: McpContent[];
  isError: boolean | null;
}

export interface McpResource {
  uri: string;
  name: string;
  description: string | null;
  mimeType: string | null;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string | null;
  mimeType: string | null;
}

export interface McpServerCapabilities {
  tools: { listChanged: boolean | null } | null;
  resources: { listChanged: boolean | null; subscribe: boolean | null } | null;
  prompts: { listChanged: boolean | null } | null;
  logging: { levels: string[] } | null;
  experimental: Record<string, JsonValue> | null;
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function optionalString(value: JsonValue | undefined): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : undefined;
}
function optionalBoolean(value: JsonValue | undefined): boolean | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'boolean' ? value : undefined;
}

/** serde `JsonRpcRequest` field order with `skip_serializing_if = "Option::is_none"` params. */
export function serializeJsonRpcRequest(request: JsonRpcRequest): string {
  const payload: Record<string, JsonValue> = {
    jsonrpc: request.jsonrpc,
    method: request.method,
  };
  if (request.params !== undefined && request.params !== null) payload.params = request.params;
  payload.id = request.id;
  return JSON.stringify(payload);
}

export function serializeJsonRpcNotification(notification: JsonRpcNotification): string {
  const payload: Record<string, JsonValue> = {
    jsonrpc: notification.jsonrpc,
    method: notification.method,
  };
  if (notification.params !== undefined && notification.params !== null) {
    payload.params = notification.params;
  }
  return JSON.stringify(payload);
}

export function parseJsonRpcRequest(raw: string): JsonRpcRequest | null {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { return null; }
  if (!isObject(value) || typeof value.jsonrpc !== 'string' || typeof value.method !== 'string') {
    return null;
  }
  return {
    jsonrpc: value.jsonrpc,
    method: value.method,
    params: Object.hasOwn(value, 'params') && value.params !== null ? value.params : undefined,
    id: Object.hasOwn(value, 'id') ? value.id! : null,
  };
}

function parseJsonRpcError(value: JsonValue | undefined): JsonRpcError | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || typeof value.code !== 'number' || typeof value.message !== 'string') {
    return undefined;
  }
  return {
    code: value.code,
    message: value.message,
    data: Object.hasOwn(value, 'data') ? value.data : undefined,
  };
}

export function parseJsonRpcResponse(value: unknown): JsonRpcResponse | null {
  if (!isObject(value) || typeof value.jsonrpc !== 'string') return null;
  const error = parseJsonRpcError(value.error);
  if (error === undefined) return null;
  return {
    jsonrpc: value.jsonrpc,
    result: Object.hasOwn(value, 'result') ? value.result : undefined,
    error: error ?? undefined,
    id: Object.hasOwn(value, 'id') ? value.id! : null,
  };
}

/** `ClientCapabilities` serialization: experimental is omitted when None. */
export function serializeClientCapabilities(
  capabilities: ClientCapabilities,
): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = {
    roots: capabilities.roots === undefined || capabilities.roots === null
      ? null
      : { listChanged: capabilities.roots.listChanged ?? null },
    sampling: capabilities.sampling === undefined || capabilities.sampling === null
      ? null
      : { enabled: capabilities.sampling.enabled },
  };
  if (capabilities.experimental !== undefined && capabilities.experimental !== null) {
    payload.experimental = capabilities.experimental;
  }
  return payload;
}

export function parseMcpTool(value: unknown): McpToolSpec | null {
  if (!isObject(value) || typeof value.name !== 'string' || !Object.hasOwn(value, 'inputSchema')) {
    return null;
  }
  const description = optionalString(value.description);
  if (description === undefined) return null;
  return { name: value.name, description, inputSchema: value.inputSchema! };
}

export function parseMcpContent(value: unknown): McpContent | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case 'text':
      return typeof value.text === 'string' ? { type: 'text', text: value.text } : null;
    case 'image':
      return typeof value.data === 'string' && typeof value.mimeType === 'string'
        ? { type: 'image', data: value.data, mimeType: value.mimeType }
        : null;
    case 'resource': {
      const parsed = parseMcpResourceContent(value.resource);
      return parsed === null ? null : { type: 'resource', resource: parsed };
    }
    default:
      return null;
  }
}

function parseMcpResourceContent(value: unknown): McpResourceContent | null {
  if (!isObject(value) || typeof value.uri !== 'string') return null;
  const mimeType = optionalString(value.mimeType);
  const text = optionalString(value.text);
  const blob = optionalString(value.blob);
  if (mimeType === undefined || text === undefined || blob === undefined) return null;
  return { uri: value.uri, mimeType, text, blob };
}

export function parseMcpToolResult(value: unknown): McpToolResultSpec | null {
  if (!isObject(value) || !Array.isArray(value.content)) return null;
  const content: McpContent[] = [];
  for (const item of value.content) {
    const parsed = parseMcpContent(item);
    if (parsed === null) return null;
    content.push(parsed);
  }
  const isError = optionalBoolean(value.isError);
  if (isError === undefined) return null;
  return { content, isError };
}

export function parseMcpResource(value: unknown): McpResource | null {
  if (!isObject(value) || typeof value.uri !== 'string' || typeof value.name !== 'string') {
    return null;
  }
  const description = optionalString(value.description);
  const mimeType = optionalString(value.mimeType);
  if (description === undefined || mimeType === undefined) return null;
  return { uri: value.uri, name: value.name, description, mimeType };
}

export function parseMcpResourceTemplate(value: unknown): McpResourceTemplate | null {
  if (!isObject(value) || typeof value.uriTemplate !== 'string' || typeof value.name !== 'string') {
    return null;
  }
  const description = optionalString(value.description);
  const mimeType = optionalString(value.mimeType);
  if (description === undefined || mimeType === undefined) return null;
  return { uriTemplate: value.uriTemplate, name: value.name, description, mimeType };
}

export function parseMcpServerCapabilities(value: unknown): McpServerCapabilities | null {
  if (!isObject(value)) return null;
  const parseListChanged = (capability: JsonValue | undefined):
    { listChanged: boolean | null } | null | undefined => {
    if (capability === undefined || capability === null) return null;
    if (!isObject(capability)) return undefined;
    const listChanged = optionalBoolean(capability.listChanged);
    return listChanged === undefined ? undefined : { listChanged };
  };
  const tools = parseListChanged(value.tools);
  const prompts = parseListChanged(value.prompts);
  if (tools === undefined || prompts === undefined) return null;
  let resources: McpServerCapabilities['resources'] = null;
  if (value.resources !== undefined && value.resources !== null) {
    if (!isObject(value.resources)) return null;
    const listChanged = optionalBoolean(value.resources.listChanged);
    const subscribe = optionalBoolean(value.resources.subscribe);
    if (listChanged === undefined || subscribe === undefined) return null;
    resources = { listChanged, subscribe };
  }
  let logging: McpServerCapabilities['logging'] = null;
  if (value.logging !== undefined && value.logging !== null) {
    if (!isObject(value.logging) || !Array.isArray(value.logging.levels)
      || !value.logging.levels.every(level => typeof level === 'string')) return null;
    logging = { levels: value.logging.levels as string[] };
  }
  let experimental: Record<string, JsonValue> | null = null;
  if (value.experimental !== undefined && value.experimental !== null) {
    if (!isObject(value.experimental)) return null;
    experimental = value.experimental;
  }
  return { tools, resources, prompts, logging, experimental };
}

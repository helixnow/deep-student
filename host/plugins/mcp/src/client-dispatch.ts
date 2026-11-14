// Port of dstu-mcp/src/mcp/client.rs message dispatch, request management and events.
// Transport I/O remains native/network work and is not part of this module.

import type { JsonValue } from '../api.ts';
import {
  parseJsonRpcResponse, parseMcpContent, type JsonRpcNotification, type JsonRpcResponse,
  type McpContent,
} from './client-protocol.ts';

/** `client.rs::ServerInfo` payload of `McpEvent::ServerInfoReceived`. */
export interface McpServerInfo {
  name: string;
  version: string;
  protocol_version: string;
  capabilities: JsonValue | null;
}

export type McpEvent =
  | { type: 'Connected' }
  | { type: 'Disconnected' }
  | { type: 'ServerInfoReceived'; server: McpServerInfo }
  | { type: 'ToolsChanged' }
  | { type: 'ResourcesChanged' }
  | { type: 'PromptsChanged' }
  | { type: 'RootsChanged' }
  | { type: 'Error'; message: string };

export type McpNotificationHandler = (
  method: string, params: JsonValue | null,
) => void | Promise<void>;

export class McpEventEmitter {
  private readonly handlers: ((event: McpEvent) => void)[] = [];

  on(handler: (event: McpEvent) => void): void {
    this.handlers.push(handler);
  }

  emit(event: McpEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

export type McpContentSink = (content: McpContent) => void;

export class McpStreamManager {
  private readonly sinks = new Map<string, McpContentSink>();

  register(id: string, sink: McpContentSink): void {
    this.sinks.set(id, sink);
  }

  push(id: string, content: McpContent): void {
    this.sinks.get(id)?.(content);
  }

  complete(id: string): void {
    this.sinks.delete(id);
  }
}

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class McpRequestManager {
  private readonly pending = new Map<string, PendingRequest>();

  private readonly timeoutMs: number;

  constructor(timeoutMs: number = 600_000) {
    this.timeoutMs = timeoutMs;
  }

  registerRequest(id: string): Promise<JsonRpcResponse> {
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Timeout error: Request expired during periodic cleanup'));
      }, this.timeoutMs);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  completeRequest(id: string, response: JsonRpcResponse): void {
    const request = this.pending.get(id);
    if (request === undefined) return;
    this.pending.delete(id);
    if (request.timer !== null) clearTimeout(request.timer);
    request.resolve(response);
  }

  cancelRequest(id: string): void {
    const request = this.pending.get(id);
    if (request === undefined) return;
    this.pending.delete(id);
    if (request.timer !== null) clearTimeout(request.timer);
    request.reject(new Error('Timeout error: Request cancelled'));
  }

  cancelAll(reason: string = 'Timeout error: Request cancelled'): void {
    for (const id of [...this.pending.keys()]) {
      const request = this.pending.get(id);
      if (request === undefined) continue;
      this.pending.delete(id);
      if (request.timer !== null) clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
  }

  hasPending(id: string): boolean {
    return this.pending.has(id);
  }
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseNotification(value: Record<string, JsonValue>): JsonRpcNotification | null {
  if (typeof value.jsonrpc !== 'string' || typeof value.method !== 'string') return null;
  return {
    jsonrpc: value.jsonrpc,
    method: value.method,
    params: Object.hasOwn(value, 'params') && value.params !== null ? value.params : undefined,
  };
}

function notificationParams(
  params: JsonValue | undefined,
): Record<string, JsonValue> | null {
  return params !== undefined && isObject(params) ? params : null;
}

async function handleNotification(
  notification: JsonRpcNotification,
  handler: McpNotificationHandler,
  emitter: McpEventEmitter,
  streamManager: McpStreamManager,
): Promise<void> {
  await handler(notification.method, notification.params ?? null);
  switch (notification.method) {
    case 'notifications/tools/list_changed':
    case 'tools/list_changed':
      emitter.emit({ type: 'ToolsChanged' });
      return;
    case 'tools/call_output':
    case 'tools/call_progress':
    case 'tools/call_chunk': {
      const params = notificationParams(notification.params);
      if (params === null) return;
      const rawId = typeof params.id === 'string'
        ? params.id
        : typeof params.requestId === 'string' ? params.requestId : null;
      if (rawId === null) return;
      if (params.content === undefined) return;
      const content = parseMcpContent(params.content);
      if (content !== null) {
        streamManager.push(rawId, content);
      } else if (isObject(params.content) && typeof params.content.text === 'string') {
        streamManager.push(rawId, { type: 'text', text: params.content.text });
      }
      return;
    }
    case 'notifications/resources/list_changed':
    case 'resources/list_changed':
      emitter.emit({ type: 'ResourcesChanged' });
      return;
    case 'notifications/prompts/list_changed':
    case 'prompts/list_changed':
      emitter.emit({ type: 'PromptsChanged' });
      return;
    case 'notifications/roots/list_changed':
    case 'roots/list_changed':
      emitter.emit({ type: 'RootsChanged' });
      return;
    default:
      return;
  }
}

/** Envelope dispatch: method+id = server request, method = notification, else response. */
export async function handleMcpMessage(
  message: string,
  requestManager: McpRequestManager,
  notificationHandler: McpNotificationHandler,
  eventEmitter: McpEventEmitter,
  streamManager: McpStreamManager,
): Promise<void> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(message) as unknown;
  } catch {
    return;
  }
  if (!isObject(envelope)) return;

  const hasMethod = typeof envelope.method === 'string';
  const hasId = Object.hasOwn(envelope, 'id') && envelope.id !== null;

  if (hasMethod) {
    if (hasId) return; // Unsupported server request (roots/list, sampling/...)
    const notification = parseNotification(envelope);
    if (notification === null) return;
    await handleNotification(notification, notificationHandler, eventEmitter, streamManager);
    return;
  }

  const response = parseJsonRpcResponse(envelope);
  if (response === null) return;
  if (typeof response.id === 'string') {
    requestManager.completeRequest(response.id, response);
  } else if (typeof response.id === 'number') {
    requestManager.completeRequest(String(response.id), response);
  }
}

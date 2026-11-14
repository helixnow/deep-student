import { describe, expect, it } from 'vitest';
import {
  McpEventEmitter, McpRequestManager, McpStreamManager, handleMcpMessage, type McpEvent,
} from '../src/client-dispatch.ts';

interface Fixture {
  manager: McpRequestManager;
  notifications: string[];
  emitter: McpEventEmitter;
  events: McpEvent[];
  stream: McpStreamManager;
}

function fixture(): Fixture {
  const manager = new McpRequestManager();
  const notifications: string[] = [];
  const emitter = new McpEventEmitter();
  const events: McpEvent[] = [];
  emitter.on(event => { events.push(event); });
  return { manager, notifications, emitter, events, stream: new McpStreamManager() };
}

describe('crates/dstu-mcp/src/mcp/client.rs::tests dispatch', () => {
  it('standard_notification_is_not_swallowed_by_response_branch', async () => {
    const { manager, notifications, emitter, events, stream } = fixture();
    await handleMcpMessage(
      '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
      manager,
      method => { notifications.push(method); },
      emitter,
      stream,
    );

    expect(notifications).toEqual(['notifications/tools/list_changed']);
    expect(events).toEqual([{ type: 'ToolsChanged' }]);
  });

  it('legacy_private_notification_names_still_map_to_events', async () => {
    const { manager, notifications, emitter, events, stream } = fixture();
    await handleMcpMessage(
      '{"jsonrpc":"2.0","method":"tools/list_changed","params":{}}',
      manager,
      method => { notifications.push(method); },
      emitter,
      stream,
    );

    expect(notifications).toEqual(['tools/list_changed']);
    expect(events).toEqual([{ type: 'ToolsChanged' }]);
  });

  it('response_completes_pending_request_by_id', async () => {
    const { manager, notifications, emitter, events, stream } = fixture();
    const pending = manager.registerRequest('42');

    await handleMcpMessage(
      '{"jsonrpc":"2.0","id":"42","result":{"ok":true}}',
      manager,
      method => { notifications.push(method); },
      emitter,
      stream,
    );

    const response = await pending;
    expect(response.result).toEqual({ ok: true });
    expect(notifications).toEqual([]);
    expect(events).toEqual([]);
  });

  it('server_request_is_not_treated_as_response_or_notification', async () => {
    const { manager, notifications, emitter, stream } = fixture();
    manager.registerRequest('7').catch(() => undefined);

    await handleMcpMessage(
      '{"jsonrpc":"2.0","method":"roots/list","id":"7"}',
      manager,
      method => { notifications.push(method); },
      emitter,
      stream,
    );

    expect(notifications).toEqual([]);
    expect(manager.hasPending('7')).toBe(true);
    manager.cancelRequest('7');
  });
});

describe('MCP dispatch helpers beyond the Rust unit tests', () => {
  it('routes stream chunks and ignores invalid JSON', async () => {
    const { manager, notifications, emitter, stream } = fixture();
    const chunks: string[] = [];
    stream.register('r1', content => { chunks.push(content.type === 'text' ? content.text : content.type); });
    await handleMcpMessage(
      '{"jsonrpc":"2.0","method":"tools/call_progress","params":{"requestId":"r1","content":{"type":"text","text":"part"}}}',
      manager,
      method => { notifications.push(method); },
      emitter,
      stream,
    );
    expect(chunks).toEqual(['part']);

    await handleMcpMessage('not json', manager, () => undefined, emitter, stream);
    expect(manager.hasPending('missing')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  parseJsonRpcRequest, parseMcpResource, parseMcpResourceTemplate, parseMcpServerCapabilities,
  parseMcpTool, parseMcpToolResult, serializeClientCapabilities, serializeJsonRpcNotification,
  serializeJsonRpcRequest,
} from '../src/client-protocol.ts';

describe('crates/dstu-mcp/src/mcp/client.rs::tests', () => {
  it('client_capabilities_none_experimental_is_omitted_not_null', () => {
    const value = serializeClientCapabilities({
      roots: { listChanged: true },
      sampling: { enabled: true },
      experimental: null,
    });
    expect(Object.hasOwn(value, 'experimental')).toBe(false);
    expect((value.roots as { listChanged: boolean }).listChanged).toBe(true);
    expect((value.sampling as { enabled: boolean }).enabled).toBe(true);
  });

  it('tool_deserializes_spec_camel_case_fields', () => {
    const tool = parseMcpTool({
      name: 'echo_upper',
      description: 'Echo in upper case',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    });
    expect(tool?.name).toBe('echo_upper');
    expect((tool?.inputSchema as { properties?: unknown }).properties).toBeDefined();
  });

  it('tool_result_and_capabilities_use_camel_case_wire_names', () => {
    const result = parseMcpToolResult({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });
    expect(result?.isError).toBe(false);

    const capabilities = parseMcpServerCapabilities({
      tools: { listChanged: true },
      resources: { listChanged: false, subscribe: true },
    });
    expect(capabilities?.tools?.listChanged).toBe(true);
    expect(capabilities?.resources?.subscribe).toBe(true);
  });

  it('resource_types_use_camel_case_wire_names', () => {
    const resource = parseMcpResource({
      uri: 'file:///a.txt', name: 'a', mimeType: 'text/plain',
    });
    expect(resource?.mimeType).toBe('text/plain');

    const template = parseMcpResourceTemplate({
      uriTemplate: 'file:///{path}', name: 't',
    });
    expect(template?.uriTemplate).toBe('file:///{path}');

    const content = parseMcpToolResult({
      content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }],
    });
    expect(content?.content[0]).toEqual({ type: 'image', data: 'aGk=', mimeType: 'image/png' });
  });

  it('jsonrpc_request_omits_params_when_none', () => {
    const serialized = serializeJsonRpcRequest({
      jsonrpc: '2.0', method: 'tools/list', id: 'test-id-1',
    });
    expect(serialized.includes('"params"')).toBe(false);
    expect(serialized.includes('null')).toBe(false);
    expect(serialized).toContain('"jsonrpc":"2.0"');
    expect(serialized).toContain('"method":"tools/list"');
    expect(serialized).toContain('"id":"test-id-1"');
  });

  it('jsonrpc_request_includes_params_when_some', () => {
    const serialized = serializeJsonRpcRequest({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'browser_navigate', arguments: { url: 'https://example.com' } },
      id: 'test-id-2',
    });
    expect(serialized).toContain('"params"');
    expect(serialized).toContain('"name":"browser_navigate"');
    expect(serialized).toContain('"url":"https://example.com"');
  });

  it('jsonrpc_request_deserializes_missing_params_as_none', () => {
    const parsed = parseJsonRpcRequest('{"jsonrpc":"2.0","method":"tools/list","id":"abc"}');
    expect(parsed?.params).toBeUndefined();
    expect(parsed?.method).toBe('tools/list');
  });

  it('jsonrpc_notification_omits_params_when_none', () => {
    const serialized = serializeJsonRpcNotification({
      jsonrpc: '2.0', method: 'notifications/initialized',
    });
    expect(serialized.includes('"params"')).toBe(false);
  });
});

describe('client protocol helpers beyond the Rust unit tests', () => {
  it('client.rs:1272/1736 sends initialized with no id or None params on the wire', () => {
    expect(serializeJsonRpcNotification({ jsonrpc: '2.0', method: 'initialized' }))
      .toBe('{"jsonrpc":"2.0","method":"initialized"}');
  });

  it('rejects malformed envelopes and preserves null option fields', () => {
    expect(parseJsonRpcRequest('not json')).toBeNull();
    expect(parseMcpTool({ name: 'x' })).toBeNull();
    expect(parseMcpServerCapabilities({ tools: { listChanged: 'yes' } })).toBeNull();
    expect(parseMcpResource({ uri: 'x' })).toBeNull();
    expect(serializeJsonRpcNotification({
      jsonrpc: '2.0', method: 'x', params: { a: 1 },
    })).toContain('"params":{"a":1}');
  });
});

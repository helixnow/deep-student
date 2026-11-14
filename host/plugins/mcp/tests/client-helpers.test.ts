import { describe, expect, it } from 'vitest';
import {
  decodeToolNameFromApi, encodeToolNameForApi, resolveFrontendMcpToolName,
} from '../src/canonical-tools.ts';
import { endpointIsLoopback } from '../src/endpoint.ts';

describe('crates/dstu-mcp/src/tools/mod.rs::tests', () => {
  it('resolve_frontend_mcp_tool_name_decodes_canonical_legacy_namespaces', () => {
    const encoded = encodeToolNameForApi('mcp.tools.fetch:url');
    expect(encoded).not.toBeNull();
    expect(resolveFrontendMcpToolName(encoded!, 'mcp.tools.')).toBe('fetch:url');
  });

  it('resolve_frontend_mcp_tool_name_decodes_chat_pipeline_internal_names', () => {
    const encoded = encodeToolNameForApi('mcp_fetch:url');
    expect(encoded).not.toBeNull();
    expect(resolveFrontendMcpToolName(encoded!)).toBe('fetch:url');
  });
});

describe('crates/dstu-mcp/src/mcp/mod.rs::tests', () => {
  it('loopback_endpoints_are_detected', () => {
    expect(endpointIsLoopback('http://127.0.0.1:8931/sse')).toBe(true);
    expect(endpointIsLoopback('http://localhost:8931/sse')).toBe(true);
    expect(endpointIsLoopback('http://[::1]:8931/sse')).toBe(true);
    expect(endpointIsLoopback('http://app.localhost:8931/sse')).toBe(true);
    expect(endpointIsLoopback('https://example.com/mcp')).toBe(false);
    expect(endpointIsLoopback('https://mcp.modelscope.cn/sse')).toBe(false);
    expect(endpointIsLoopback('not a url')).toBe(false);
  });
});

describe('canonical tool name helpers beyond the Rust unit tests', () => {
  it('keeps OpenAI-compatible names and rejects invalid canonical payloads', () => {
    expect(encodeToolNameForApi('browser_open')).toBe('browser_open');
    expect(encodeToolNameForApi('ds_tool_x')).toBe(`ds_tool_${Buffer.from('ds_tool_x').toString('base64url')}`);
    expect(encodeToolNameForApi('   ')).toBeNull();
    expect(decodeToolNameFromApi('ds_tool_%%%')).toBeNull();
    expect(decodeToolNameFromApi('  browser_open  ')).toBe('browser_open');
    expect(resolveFrontendMcpToolName('mcp_fetch')).toBe('fetch');
  });
});

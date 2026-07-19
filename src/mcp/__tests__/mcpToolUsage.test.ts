import { describe, expect, it } from 'vitest';

import { buildMcpToolUsage } from '../mcpService';

describe('buildMcpToolUsage', () => {
  it('preserves resolved MCP server and tool provenance for backend materialization', () => {
    expect(buildMcpToolUsage('filesystem-prod', 'files.read', 'trace-123', 42)).toEqual({
      elapsed_ms: 42,
      provider: 'mcp',
      server_id: 'filesystem-prod',
      tool_name: 'files.read',
      source: 'mcp-frontend',
      trace_id: 'trace-123',
    });
  });
});

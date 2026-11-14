import { expect, it } from 'vitest';
import { toolScopeFromAllowEntry } from '../../../plugins/chat/api.ts';

/** dstu-core/agent.rs:515-523. Construct the same MCP variant through L04's
 * actual worker-grant factory, not a test-local object/type literal.
 * Production: workspace-run-agent.ts -> issueWorkerGrant -> scopesFromAllowedTools.
 */
it('tool_scope_serializes_with_kind_tag', () => {
  const scope = toolScopeFromAllowEntry('server-a::fetch');
  expect(JSON.parse(JSON.stringify(scope))).toEqual({ kind: 'mcp', server: 'server-a', tool: 'fetch' });
});

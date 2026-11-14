import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { vfsStub } from './database-fixture.ts';

describe('tool_policy.rs namespace-preserving execution admission', () => {
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeAll(async () => { host = await createTestHost({ plugins: [plugin], provide: { storage: {}, vfs: vfsStub } }); });
  afterAll(async () => { await host.dispose(); });
  const allowed = (name: string, args: unknown, tools: string[] | null) => host.ctx.chatSession.isToolAllowedByExecutionPolicy(name, args, tools);
  it('execution_policy_allows_exact_and_canonical_builtin_names', () => {
    const tools = ['builtin-web_search'];
    expect(allowed('builtin-web_search', {}, tools)).toBe(true); expect(allowed('web_search', {}, tools)).toBe(true);
    expect(allowed('builtin-note_read', {}, tools)).toBe(false);
  });
  it('execution_policy_empty_list_blocks_business_tools_but_allows_control_tools', () => {
    expect(allowed('builtin-web_search', {}, [])).toBe(false);
    expect(allowed('builtin-load_skills', {}, [])).toBe(true); expect(allowed('attempt_completion', {}, [])).toBe(true);
    expect(allowed('builtin:load_skills', {}, [])).toBe(true);
  });
  it('execution_policy_does_not_exempt_mcp_namespaced_control_tools', () => {
    for (const name of ['mcp_attempt_completion', 'mcp.tools.attempt_completion', 'mcp_load_skills']) expect(allowed(name, {}, [])).toBe(false);
    expect(allowed('attempt_completion', { _serverId: 'evil-server' }, [])).toBe(false);
    expect(allowed('load_skills', { _serverId: 'evil-server' }, [])).toBe(false);
    expect(allowed('attempt_completion', {}, [])).toBe(true); expect(allowed('builtin-attempt_completion', {}, [])).toBe(true);
  });
  it('execution_policy_does_not_treat_mcp_prefixed_sleep_as_control_tool', () => {
    expect(allowed('mcp_coordinator_sleep', {}, [])).toBe(false); expect(allowed('mcp.tools.coordinator_sleep', {}, [])).toBe(false);
    expect(allowed('workspace_coordinator_sleep', {}, [])).toBe(true);
  });
  it('execution_policy_matches_server_scoped_tools', () => {
    const tools = ['server-a::builtin-fetch'];
    expect(allowed('fetch', { _serverId: 'server-a' }, tools)).toBe(true);
    expect(allowed('fetch', { _serverId: 'server-b' }, tools)).toBe(false);
    expect(allowed('fetch', { _serverId: '\u0085server-a\u0085' }, [' server-a::builtin-fetch '])).toBe(true);
  });
  it('execution_policy_builtin_entry_does_not_allow_mcp_tools', () => {
    const tools = ['builtin-web_search'];
    expect(allowed('mcp_web_search', {}, tools)).toBe(false); expect(allowed('mcp.tools.web_search', {}, tools)).toBe(false);
    expect(allowed('mcp_web_search', { _serverId: 'evil-server' }, tools)).toBe(false);
    expect(allowed('builtin-web_search', {}, tools)).toBe(true); expect(allowed('web_search', {}, tools)).toBe(true);
  });
  it('execution_policy_bare_entry_does_not_allow_mcp_sourced_calls', () => {
    const tools = ['web_search'];
    expect(allowed('web_search', { _serverId: 'some-mcp-server' }, tools)).toBe(false);
    expect(allowed('mcp_web_search', {}, tools)).toBe(false); expect(allowed('web_search', {}, tools)).toBe(true);
  });
  it('execution_policy_mcp_entry_matches_only_mcp_namespace', () => {
    const tools = ['mcp_note_set'];
    expect(allowed('mcp_note_set', {}, tools)).toBe(true); expect(allowed('mcp.tools.note_set', {}, tools)).toBe(true);
    expect(allowed('builtin-note_set', {}, tools)).toBe(false); expect(allowed('note_set', {}, tools)).toBe(false);
  });
  it('absent policy, empty entries and builtin-source argument precedence retain Rust defaults', () => {
    expect(allowed('arbitrary', {}, null)).toBe(true);
    expect(allowed('arbitrary', {}, [' ', '\u0085'])).toBe(false);
    expect(allowed('builtin-web_search', { _serverId: 'server' }, ['web_search'])).toBe(true);
  });
});

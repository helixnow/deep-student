import { expect, it } from 'vitest';
import { isExternalMcpCall, toolApprovalSource, toolApprovalDomain, resolveEffectiveSensitivity, type JsonValue } from '../api.ts';

function resolve(settings: Record<string, string>, base: 'low' | 'medium' | 'high' | null, name: string, args: JsonValue) {
  return resolveEffectiveSensitivity(base, name, args, key => settings[key] ?? null);
}

it('derives_stable_source_and_domain', () => {
  expect(toolApprovalSource('search', { _serverId: ' docs-prod ' })).toBe('docs-prod');
  expect(toolApprovalSource('mcp_search', {})).toBe('mcp');
  expect(toolApprovalSource('builtin-note_read', {})).toBe('builtin');
  expect(toolApprovalDomain('builtin-note_read')).toBe('note');
  expect(toolApprovalDomain('mcp_qbank_search')).toBe('qbank');
  expect(isExternalMcpCall('mcp_search', {})).toBe(true);
  expect(isExternalMcpCall('search', { _serverId: 'docs' })).toBe(true);
  expect(isExternalMcpCall('builtin-search', { _serverId: 'spoofed' })).toBe(false);
});
it('source_scoped_tool_rule_isolated_between_servers', () => {
  const settings = { 'tool_approval.override.server-a::search': 'low' };
  expect(resolve(settings, 'high', 'search', { _serverId: 'server-a' })).toBe('low');
  expect(resolve(settings, 'high', 'search', { _serverId: 'server-b' })).toBe('high');
});
it('resolves_rules_from_most_specific_to_global', () => {
  const settings = { 'tool_approval.global_bypass': 'true', 'tool_approval.domain.note': 'medium',
    'tool_approval.source.builtin': 'high', 'tool_approval.override.note_read': 'medium' };
  expect(resolve({ ...settings, 'tool_approval.override.builtin::note_read': 'low' }, 'high', 'note_read', {})).toBe('low');
  expect(resolve(settings, 'high', 'note_read', {})).toBe('medium');
});
it('invalid_specific_rule_falls_through_to_group_rule', () => {
  expect(resolve({ 'tool_approval.override.builtin::note_read': 'inherit', 'tool_approval.domain.note': 'low' }, 'high', 'note_read', {})).toBe('low');
});
it('precise_approval_tools_cannot_be_lowered_by_group_or_global_rules', () => {
  for (const key of ['tool_approval.global_bypass', 'tool_approval.source.builtin', 'tool_approval.override.builtin::builtin-local_shell_execute']) {
    expect(resolve({ [key]: key.endsWith('global_bypass') ? 'true' : 'low' }, 'high', 'builtin-local_shell_execute', {})).toBe('high');
  }
  expect(resolve({ 'tool_approval.global_bypass': 'true' }, 'high', 'mcp_run_command', { _serverId: 'custom-terminal', command: 'rm -rf build' })).toBe('high');
});
it('explicit_group_rule_can_raise_a_low_risk_tool', () => {
  expect(resolve({ 'tool_approval.domain.note': 'high' }, 'low', 'note_read', {})).toBe('high');
});

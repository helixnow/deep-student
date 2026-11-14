import { describe, expect, it } from 'vitest';
import { BUILTIN_DESCRIPTORS, lookupToolDescriptor, isHeadlessReadonly, isPtcAllowed, grantsScopeHint } from '../api.ts';

// Independent Rust whitelist oracles: headless.rs:584-637 and ptc_runtime.rs:115-163.
const readonlyNames = [
  'unified_search', 'rag_search', 'web_search', 'web_fetch', 'settings_get', 'model_assignments_get',
  'llm_usage_query', 'backup_status', 'backup_job_status', 'sync_status', 'index_status', 'learning_overview',
  'pomodoro_today_stats', 'pomodoro_daily_stats', 'fsrs_get_scheduler_config', 'memory_read', 'memory_list',
  'resource_list', 'resource_read', 'resource_search', 'folder_list', 'dstu_list_trash',
  'user_todo_list_lists', 'user_todo_list_items', 'user_todo_get_summary', 'user_todo_search', 'user_todo_list_trash',
  'qbank_list', 'qbank_list_questions', 'qbank_get_question', 'qbank_get_stats', 'qbank_get_next_question',
  'review_get_due', 'review_stats',
];
describe('tool_descriptors.rs shared builtin table and lookup', () => {
  it('table_is_wellformed', () => {
    expect(BUILTIN_DESCRIPTORS.length).toBeGreaterThan(0); const seen = new Set<string>();
    for (const descriptor of BUILTIN_DESCRIPTORS) {
      expect(descriptor.name.startsWith('builtin-')).toBe(false); expect(descriptor.name).not.toBe('');
      expect(descriptor.name.trim()).toBe(descriptor.name); expect(seen.has(descriptor.name)).toBe(false); seen.add(descriptor.name);
    }
  });
  it('headless_flag_matches_headless_whitelist', () => {
    const expected = new Set([...readonlyNames, 'attempt_completion', 'todo_init', 'todo_update', 'todo_add', 'todo_get']);
    expect(new Set(BUILTIN_DESCRIPTORS.filter(d => d.headlessAllowed).map(d => d.name))).toEqual(expected);
  });
  it('headless_tools_are_low_sensitivity', () => {
    for (const descriptor of BUILTIN_DESCRIPTORS) if (descriptor.headlessAllowed) expect(descriptor.sensitivity, descriptor.name).toBe('Low');
  });
  it('ptc_flag_matches_ptc_whitelist', () => {
    expect(new Set(BUILTIN_DESCRIPTORS.filter(d => d.ptcAllowed).map(d => d.name)))
      .toEqual(new Set([...readonlyNames, 'arxiv_search', 'scholar_search']));
  });
  it('ptc_tools_are_low_sensitivity', () => {
    for (const descriptor of BUILTIN_DESCRIPTORS) if (descriptor.ptcAllowed) expect(descriptor.sensitivity, descriptor.name).toBe('Low');
  });
  it('lookup_is_exact_bare_name_match', () => {
    expect(lookupToolDescriptor('rag_search')).not.toBeNull();
    expect(lookupToolDescriptor('builtin-rag_search')).toBeNull(); expect(lookupToolDescriptor('nonexistent_tool')).toBeNull();
  });
  it('headless_and_ptc_queries_accept_both_name_forms', () => {
    for (const name of ['builtin-rag_search', 'rag_search', 'todo_init', 'builtin-attempt_completion']) expect(isHeadlessReadonly(name), name).toBe(true);
    for (const name of ['builtin-local_shell_execute', 'builtin-arxiv_search', 'nonexistent']) expect(isHeadlessReadonly(name), name).toBe(false);
    for (const name of ['builtin-rag_search', 'arxiv_search']) expect(isPtcAllowed(name), name).toBe(true);
    for (const name of ['builtin-attempt_completion', 'builtin-todo_init', 'builtin-local_shell_execute', 'ptc_run', 'nonexistent']) expect(isPtcAllowed(name), name).toBe(false);
  });
  it('grants_scope_hint_marks_shell_family', () => {
    expect(grantsScopeHint('builtin-local_shell_execute')).toBe('shell');
    expect(grantsScopeHint('local_shell_preflight')).toBe('shell');
    expect(grantsScopeHint('builtin-rag_search')).toBe('builtin'); expect(grantsScopeHint('mcp_brave_search')).toBeNull();
  });
});

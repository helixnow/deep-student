import { describe, expect, it } from 'vitest';
import { buildProfileSkillSnapshot, buildTaskContent, deriveWorkspaceName, isOwnAgentCompletion, parseSubagentArgs } from '../src/subagent-args.ts';

describe('subagent_executor.rs argument and completion semantics', () => {
  it('parse_args_requires_task', () => {
    expect(() => parseSubagentArgs({})).toThrow('task is required');
    expect(() => parseSubagentArgs({ task: '  ' })).toThrow('task is required');
    expect(() => parseSubagentArgs({ task: 'do it' })).not.toThrow();
  });
  it('parse_args_defaults_wait_true_and_all_fields_optional', () => {
    const args = parseSubagentArgs({ task: 'summarize the paper' });
    expect(args.task).toBe('summarize the paper');
    expect(args.wait).toBe(true);
    for (const key of ['workspaceId', 'profile', 'skillId', 'model', 'context', 'resumeAgentSessionId'] as const) expect(args[key]).toBeNull();
  });
  it('parse_args_reads_resume_agent_session_id', () => {
    expect(parseSubagentArgs({ task: 'follow-up question', workspace_id: 'ws_1', resume_agent_session_id: 'subagent_worker_01ABC' }).resumeAgentSessionId).toBe('subagent_worker_01ABC');
    expect(parseSubagentArgs({ task: 't', resume_agent_session_id: '   ' }).resumeAgentSessionId).toBeNull();
  });
  it('build_task_content_appends_context_block', () => {
    expect(buildTaskContent(parseSubagentArgs({ task: 'do it' }))).toBe('do it');
    const content = buildTaskContent(parseSubagentArgs({ task: 'do it', context: { hint: 1 } }));
    expect(content.startsWith('do it\n\n[Context]\n')).toBe(true);
    expect(content).toContain('"hint": 1');
  });
  it('profile_skill_snapshot_is_exact_and_fails_closed_on_missing_content', () => {
    const available = new Map([['research', 'research body'], ['other', 'other body']]);
    const snapshot = buildProfileSkillSnapshot(['research'], available);
    expect(snapshot.size).toBe(1);
    expect(snapshot.get('research')).toBe('research body');
    expect(snapshot.has('other')).toBe(false);
    expect(() => buildProfileSkillSnapshot(['missing'], available)).toThrow('silently ignore');
  });
  it('parse_args_reads_all_optional_fields', () => {
    const args = parseSubagentArgs({ task: 't', workspace_id: 'ws_1', profile: 'explorer', skill_id: 'research', model: 'model-config-1', context: { hint: 1 }, wait: false });
    expect(args.workspaceId).toBe('ws_1');
    expect(args.profile).toBe('explorer');
    expect(args.skillId).toBe('research');
    expect(args.model).toBe('model-config-1');
    expect(args.context).toEqual({ hint: 1 });
    expect(args.wait).toBe(false);
  });
  it('derive_workspace_name_truncates_by_chars_not_bytes', () => {
    expect(deriveWorkspaceName('short task')).toBe('short task');
    expect([...deriveWorkspaceName('a'.repeat(40))]).toHaveLength(24);
    expect([...deriveWorkspaceName('分析这篇论文的方法论并总结创新点与局限性以及未来方向')]).toHaveLength(24);
    expect(deriveWorkspaceName('   ')).toBe('Subagent Task');
  });
  it('completion_dedup_matches_type_and_kind_keys_and_agent_id', () => {
    const typeKey = '{"type":"agent_completion","agent_session_id":"subagent_x"}';
    expect(isOwnAgentCompletion(typeKey, 'subagent_x')).toBe(true);
    expect(isOwnAgentCompletion('{"kind":"agent_completion","agent_session_id":"subagent_x"}', 'subagent_x')).toBe(true);
    expect(isOwnAgentCompletion(typeKey, 'subagent_other')).toBe(false);
    expect(isOwnAgentCompletion('{"type":"progress","agent_session_id":"subagent_x"}', 'subagent_x')).toBe(false);
    expect(isOwnAgentCompletion('plain text progress', 'subagent_x')).toBe(false);
  });
});

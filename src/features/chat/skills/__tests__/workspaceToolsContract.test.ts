import { describe, expect, it } from 'vitest';

import { workspaceToolsSkill } from '../builtin-tools/workspace-tools';

const MUTATION_TOOLS = [
  'builtin-workspace_file_write',
  'builtin-workspace_file_move',
  'builtin-workspace_file_delete',
  'builtin-workspace_change_revert',
] as const;

describe('workspace mutation tool contracts', () => {
  it('exposes every auditable workspace mutation tool to the model', () => {
    const names = workspaceToolsSkill.embeddedTools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(MUTATION_TOOLS));
  });

  it('requires stale-write guards for move and delete', () => {
    for (const name of ['builtin-workspace_file_move', 'builtin-workspace_file_delete']) {
      const tool = workspaceToolsSkill.embeddedTools.find((item) => item.name === name);
      const required = (tool?.inputSchema as { required?: string[] })?.required ?? [];
      expect(required).toContain('expected_current_hash');
    }
  });

  it('accepts either a complete mutation receipt or a shell change set for rollback', () => {
    const tool = workspaceToolsSkill.embeddedTools.find(
      (item) => item.name === 'builtin-workspace_change_revert',
    );
    const schema = tool?.inputSchema as {
      required?: string[];
      properties?: { receipt?: { required?: string[] } };
      oneOf?: Array<{ required?: string[] }>;
    };
    expect(schema.properties?.receipt?.required).toEqual(
      expect.arrayContaining(['change_id', 'root_id', 'op', 'relative_path', 'bytes']),
    );
    expect(schema.oneOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: ['receipt'] }),
        expect.objectContaining({ required: ['change_set'] }),
      ]),
    );
  });

  it('describes the real non-interactive shell contract on macOS and Windows', () => {
    expect(workspaceToolsSkill.content).toContain('/bin/sh -c');
    expect(workspaceToolsSkill.content).toContain('-NoProfile -NonInteractive');
    expect(workspaceToolsSkill.content).toContain('Windows PowerShell');
    expect(workspaceToolsSkill.content).toContain('UTF-8');
    expect(workspaceToolsSkill.content).toContain('没有 PTY、stdin 或持久 shell session');
    expect(workspaceToolsSkill.content).toContain('网络默认禁止');
  });

  it('uses platform-correct SKILL_DIR syntax and describes conditional Linux support', () => {
    expect(workspaceToolsSkill.content).toContain('$env:SKILL_DIR');
    expect(workspaceToolsSkill.content).toContain('$SKILL_DIR');
    // Linux 桌面通过 bubblewrap 沙箱支持本地 shell（运行时探测，缺失即 fail-closed）
    expect(workspaceToolsSkill.content).toContain('bubblewrap');
    expect(workspaceToolsSkill.content).toContain('其余平台（移动端）当前不支持本地 shell');
    expect(workspaceToolsSkill.content).not.toContain('其他平台当前不支持本地 shell');
  });

  it('states that preflight cannot waive approval for real execution', () => {
    const preflight = workspaceToolsSkill.embeddedTools.find(
      (item) => item.name === 'builtin-local_shell_preflight',
    );
    expect(preflight?.description).toContain('任何真实执行仍必须单独经过用户审批');
  });

  it('exposes subagent_call as a single-task tool with optional workspace/profile/wait', () => {
    const subagent = workspaceToolsSkill.embeddedTools.find(
      (item) => item.name === 'builtin-subagent_call',
    );
    const schema = subagent?.inputSchema as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<
        string,
        { type?: string; enum?: string[]; default?: unknown; maxLength?: number; description?: string }
      >;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['task']);
    expect(Object.keys(schema.properties ?? {})).toEqual([
      'task',
      'workspace_id',
      'profile',
      'resume_agent_session_id',
      'skill_id',
      'model',
      'context',
      'wait',
    ]);
    expect(schema.properties?.task?.maxLength).toBe(20000);
    // C6: profile 不再是 enum，而是自由字符串（内建三型 + 自定义 profile name）
    expect(schema.properties?.profile?.type).toBe('string');
    expect(schema.properties?.profile?.enum).toBeUndefined();
    expect(schema.properties?.profile?.description).toContain('自定义');
    // C7: 续跑参数与 resumed 返回键
    expect(schema.properties?.resume_agent_session_id?.type).toBe('string');
    expect(schema.properties?.resume_agent_session_id?.description).toContain('resumed');
    expect(schema.properties?.wait?.default).toBe(true);
    expect(subagent?.description).toContain('默认 wait=true');
    expect(subagent?.description).toContain('auto_created_workspace');
    // C8: 描述提及 token 归集
    expect(subagent?.description).toContain('token_usage');
  });

  it('replaces the mandatory-sleep guidance with the delegation decision tree', () => {
    expect(workspaceToolsSkill.content).not.toContain('必须立即调用 builtin-coordinator_sleep');
    expect(workspaceToolsSkill.content).toContain('子代理委托决策树');
    expect(workspaceToolsSkill.content).toContain('wait: false');
    const sleep = workspaceToolsSkill.embeddedTools.find(
      (item) => item.name === 'builtin-coordinator_sleep',
    );
    expect(sleep?.description).toContain('wait=false');
    expect(sleep?.description).not.toContain('【必需】');
  });

  it('defaults parent environment inheritance to deny', () => {
    const execute = workspaceToolsSkill.embeddedTools.find(
      (item) => item.name === 'builtin-local_shell_execute',
    );
    const schema = execute?.inputSchema as {
      properties?: { inherit_env?: { default?: boolean; description?: string } };
    };
    expect(schema.properties?.inherit_env?.default).toBe(false);
    expect(schema.properties?.inherit_env?.description).toContain('Defaults to false');
  });
});

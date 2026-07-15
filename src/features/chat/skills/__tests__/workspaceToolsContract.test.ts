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

  it('uses platform-correct SKILL_DIR syntax and does not claim Linux support', () => {
    expect(workspaceToolsSkill.content).toContain('$env:SKILL_DIR');
    expect(workspaceToolsSkill.content).toContain('$SKILL_DIR');
    expect(workspaceToolsSkill.content).toContain('其他平台当前不支持本地 shell');
    expect(workspaceToolsSkill.content).not.toContain('sh（macOS/Linux）');
  });

  it('states that preflight cannot waive approval for real execution', () => {
    const preflight = workspaceToolsSkill.embeddedTools.find(
      (item) => item.name === 'builtin-local_shell_preflight',
    );
    expect(preflight?.description).toContain('任何真实执行仍必须单独经过用户审批');
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

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
});

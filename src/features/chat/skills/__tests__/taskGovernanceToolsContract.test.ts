import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { taskGovernanceToolsSkill } from '../builtin-tools/task-governance-tools';

describe('task governance tool contracts', () => {
  it('COL-08 exports the complete audit surface with explicit coverage', () => {
    const indexSource = readFileSync(
      resolve(process.cwd(), 'src/features/chat/skills/builtin-tools/index.ts'),
      'utf8',
    );
    expect(indexSource).toContain("export { taskGovernanceToolsSkill } from './task-governance-tools'");
    expect(indexSource).toContain('taskGovernanceToolsSkill,');
    const tool = taskGovernanceToolsSkill.embeddedTools?.find(
      candidate => candidate.name === 'builtin-task_audit_export',
    );
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.additionalProperties).toBe(false);
    expect(tool?.inputSchema.required).toEqual([
      'taskId', 'objectHandles', 'toolCalls', 'approvals', 'outputs',
      'connectorTargets', 'changeCoverage',
    ]);
    expect(taskGovernanceToolsSkill.content).toContain('TaskObjectHandle');
    expect(taskGovernanceToolsSkill.content).toContain('收件人/ACL');
    expect(taskGovernanceToolsSkill.content).toContain('Role Pack');
    expect(tool?.description).toContain('authoritative=false');
    expect(tool?.description).toContain('backend_session_ledger');
    expect(tool?.description).toContain('coverageComplete=false');
  });

  it('COL-06 publishes a two-phase, hash-bound, incomplete-aware forget contract', () => {
    const tool = taskGovernanceToolsSkill.embeddedTools?.find(
      candidate => candidate.name === 'builtin-lineage_forget',
    );
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.properties.mode.enum).toEqual(['dry_run', 'commit']);
    expect(tool?.inputSchema.properties.requestedLayers.items.enum).toEqual([
      'source', 'cache', 'embedding', 'stage', 'copy', 'lineage',
    ]);
    expect(tool?.description).toContain('High');
    expect(tool?.description).toContain('rootId+relativePath');
    expect(tool?.description).toContain('sha256');
    expect(taskGovernanceToolsSkill.content).toContain('incompleteLayers');
    expect(tool?.description).toContain('symlink');
    expect(tool?.description).toContain('无 backup');
  });
});

import { describe, expect, it } from 'vitest';

import { groupTaskSessions, summarizeTaskSession } from '../taskCenter';

describe('task center session grouping', () => {
  it('groups by workspace then default runtime root without inventing task records', () => {
    const sessions = [
      { id: 'a', metadata: { workspaceId: 'workspace-1' } },
      { id: 'b', metadata: { defaultRuntimeRootId: 'authorized_2' } },
      { id: 'c', workspaceKey: 'workspace-1' },
    ];
    const groups = groupTaskSessions(sessions);
    expect(groups.get('workspace-1')?.map(item => item.id)).toEqual(['a', 'c']);
    expect(groups.get('authorized_2')?.map(item => item.id)).toEqual(['b']);
  });

  it('normalizes parallel status and existing output/change metadata', () => {
    expect(summarizeTaskSession({
      id: 'task',
      metadata: { taskStatus: 'blocked', artifactCount: 2, changeCount: 3, lastArtifact: 'report.docx' },
    })).toMatchObject({
      status: 'blocked', artifactCount: 2, changeCount: 3, lastArtifact: 'report.docx',
    });
    expect(summarizeTaskSession({ id: 'done', metadata: { taskStatus: 'success' } }).status)
      .toBe('completed');
  });

  it('does not claim completion when production task metadata is absent', () => {
    expect(summarizeTaskSession({ id: 'plain' }).status).toBe('unknown');
    expect(summarizeTaskSession({ id: 'legacy', metadata: { status: 'success' } }).status)
      .toBe('unknown');
  });
});

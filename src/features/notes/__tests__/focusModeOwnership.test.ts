import { describe, expect, it } from 'vitest';

import { updateFocusModeOwners } from '../focusModeOwnership';

describe('updateFocusModeOwners', () => {
  it('keeps focus mode active until the final split editor exits', () => {
    let owners = updateFocusModeOwners(new Set(), { ownerId: 'left', scopeId: 'workspace-a', enabled: true }, 'workspace-a');
    owners = updateFocusModeOwners(owners, { ownerId: 'right', scopeId: 'workspace-a', enabled: true }, 'workspace-a');
    owners = updateFocusModeOwners(owners, { ownerId: 'left', scopeId: 'workspace-a', enabled: false }, 'workspace-a');

    expect([...owners]).toEqual(['right']);

    owners = updateFocusModeOwners(owners, { ownerId: 'right', scopeId: 'workspace-a', enabled: false }, 'workspace-a');
    expect(owners.size).toBe(0);
  });

  it('ignores malformed events instead of clearing another editor owner', () => {
    const owners = updateFocusModeOwners(new Set(['left']), { scopeId: 'workspace-a', enabled: false }, 'workspace-a');
    expect([...owners]).toEqual(['left']);
  });

  it('ignores focus events from another editor host', () => {
    const owners = updateFocusModeOwners(
      new Set(['left']),
      { ownerId: 'external', scopeId: 'learning-hub', enabled: true },
      'workspace-a',
    );
    expect([...owners]).toEqual(['left']);
  });
});

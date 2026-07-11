import { describe, expect, it } from 'vitest';
import type { WorkbenchWindow } from '../types';
import { normalizeSingletonAppWindows } from '../snapshotWindowPolicy';

function makeWindow(overrides: Partial<WorkbenchWindow>): WorkbenchWindow {
  return {
    id: 'window',
    typeId: 'note',
    instanceKey: null,
    title: 'Window',
    frame: { x: 0, y: 0, w: 800, h: 600 },
    restoreFrame: null,
    displayMode: 'floating',
    minimized: false,
    zIndex: 1,
    createdAt: 1,
    lastFocusedAt: 1,
    ...overrides,
  };
}

describe('normalizeSingletonAppWindows', () => {
  it('keeps only the most recently focused legacy Chat window', () => {
    const note = makeWindow({ id: 'note' });
    const oldChat = makeWindow({
      id: 'chat-old', typeId: 'chat', instanceKey: 'sess_old', lastFocusedAt: 10,
    });
    const recentChat = makeWindow({
      id: 'chat-recent', typeId: 'chat', instanceKey: 'sess_recent', lastFocusedAt: 20,
    });

    expect(normalizeSingletonAppWindows([note, oldChat, recentChat])).toEqual([
      note,
      { ...recentChat, instanceKey: null },
    ]);
  });
});

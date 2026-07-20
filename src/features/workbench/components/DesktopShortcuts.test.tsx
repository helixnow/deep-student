import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopShortcut } from '@/features/learning-hub/stores/desktopStore';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  activate: vi.fn(),
  launchResource: vi.fn(),
}));

vi.mock('../core/workbenchBus', () => ({
  workbenchBus: {
    launch: mocks.launch,
    activate: mocks.activate,
  },
}));

vi.mock('../apps/files/desktopDragBridge', () => ({
  launchResourceFromDragData: mocks.launchResource,
  registerDesktopResourceDropHandler: vi.fn(() => vi.fn()),
}));

import { openDesktopShortcut } from './DesktopShortcuts';

function appShortcut(appType: 'exam' | 'mindmap'): DesktopShortcut {
  return {
    id: `app-${appType}`,
    name: appType,
    type: 'app',
    target: { appType, action: 'list' },
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('openDesktopShortcut learning apps', () => {
  beforeEach(() => {
    mocks.launch.mockReset();
    mocks.activate.mockReset();
  });

  it('launches the corresponding standalone learning app', () => {
    openDesktopShortcut(appShortcut('exam'), (key) => key);

    expect(mocks.launch).toHaveBeenCalledWith({
      typeId: 'exam',
      reason: 'shortcut',
    });
  });

  it('launches mind maps through the shared notes workspace', () => {
    openDesktopShortcut(appShortcut('mindmap'), (key) => key);

    expect(mocks.launch).toHaveBeenCalledWith({
      typeId: 'notes',
      reason: 'shortcut',
    });
  });
});

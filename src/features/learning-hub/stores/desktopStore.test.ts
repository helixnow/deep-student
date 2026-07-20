import { beforeEach, describe, expect, it } from 'vitest';
import {
  getPresetAppShortcuts,
  migrateCreateShortcutsToAppEntries,
  useDesktopStore,
  type DesktopShortcut,
} from './desktopStore';

describe('desktop learning app shortcuts', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      shortcuts: [],
      desktopRoot: { folderId: null, folderName: null, folderPath: null },
    });
  });

  it('uses learning app entries instead of create actions by default', () => {
    const defaults = getPresetAppShortcuts().slice(0, 5);

    expect(defaults.map((shortcut) => shortcut.target.appType)).toEqual([
      'note',
      'exam',
      'essay',
      'translation',
      'mindmap',
    ]);
    expect(defaults.every((shortcut) => shortcut.target.action === 'list')).toBe(true);
  });

  it('migrates persisted create shortcuts to canonical app entries', () => {
    const legacy: DesktopShortcut = {
      id: 'legacy-note',
      name: '新建笔记',
      type: 'app',
      target: { appType: 'note', action: 'create' },
      position: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    const [migrated] = migrateCreateShortcutsToAppEntries([legacy]);

    expect(migrated.target).toEqual({ appType: 'note', action: 'list' });
    expect(migrated.name).toBe(getPresetAppShortcuts()[0].name);
  });

  it('initializes the desktop with five learning app entries', () => {
    useDesktopStore.getState().initDefaultShortcuts();

    const shortcuts = useDesktopStore.getState().shortcuts;
    expect(shortcuts).toHaveLength(5);
    expect(shortcuts.every((shortcut) => shortcut.target.action === 'list')).toBe(true);
  });
});

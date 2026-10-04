import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import zhLearningHub from '@/locales/zh-CN/learningHub.json';
import enLearningHub from '@/locales/en-US/learningHub.json';
import {
  DESKTOP_STORE_VERSION,
  getPresetAppShortcuts,
  migrateCreateShortcutsToAppEntries,
  migrateDesktopPersistedState,
  resolveShortcutName,
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

describe('desktop preset shortcut labels follow the UI language', () => {
  beforeAll(async () => {
    await i18next.init({
      lng: 'zh-CN',
      fallbackLng: 'en-US',
      resources: {
        'zh-CN': { learningHub: zhLearningHub },
        'en-US': { learningHub: enLearningHub },
      },
      interpolation: { escapeValue: false },
    });
  });

  beforeEach(async () => {
    await i18next.changeLanguage('zh-CN');
    useDesktopStore.setState({
      shortcuts: [],
      desktopRoot: { folderId: null, folderName: null, folderPath: null },
    });
  });

  function legacy(
    id: string,
    name: string,
    type: DesktopShortcut['type'],
    target: DesktopShortcut['target'],
    position: number,
  ): DesktopShortcut {
    return { id, name, type, target, position, createdAt: '2026-01-01T00:00:00.000Z' };
  }

  /** v0 持久化快照：zh-CN 下创建的预设（含旧名「知识导图」）+ 一个用户改名的预设 */
  const zhPersisted = () => [
    legacy('s-note', '笔记', 'app', { appType: 'note', action: 'list' }, 0),
    legacy('s-exam', '题目集', 'app', { appType: 'exam', action: 'list' }, 1),
    legacy('s-essay', '我的作文本', 'app', { appType: 'essay', action: 'list' }, 2),
    legacy('s-translation', '翻译', 'app', { appType: 'translation', action: 'list' }, 3),
    legacy('s-mindmap', '知识导图', 'app', { appType: 'mindmap', action: 'list' }, 4),
    legacy('s-fav', '收藏', 'quickAccess', { quickAccessType: 'favorites' }, 5),
    legacy('s-res', '笔记', 'resource', { resourceId: 'note_1', resourceType: 'note' }, 6),
  ];

  it('tags presets with a stable presetKey', () => {
    const presets = getPresetAppShortcuts();
    expect(presets[0]).toMatchObject({ presetKey: 'resourceType.note', name: '笔记' });
    expect(presets[4]).toMatchObject({ presetKey: 'resourceType.mindmap', name: '思维导图' });
  });

  it('migrates zh-persisted presets so they display in English after switching language', async () => {
    const migrated = migrateDesktopPersistedState({
      shortcuts: zhPersisted(),
      desktopRoot: { folderId: null, folderName: null, folderPath: null },
    }) as { shortcuts: DesktopShortcut[] };
    const byId = Object.fromEntries(migrated.shortcuts.map((s) => [s.id, s]));

    expect(byId['s-note'].presetKey).toBe('resourceType.note');
    expect(byId['s-mindmap'].presetKey).toBe('resourceType.mindmap');
    expect(byId['s-fav'].presetKey).toBe('desktop.presets.favorites');
    // 用户改过名的预设、资源快捷方式不回填
    expect(byId['s-essay'].presetKey).toBeUndefined();
    expect(byId['s-res'].presetKey).toBeUndefined();

    await i18next.changeLanguage('en-US');
    expect(migrated.shortcuts.map(resolveShortcutName)).toEqual([
      'Notes',
      'Exam Sets',
      '我的作文本',
      'Translations',
      'Mind Maps',
      'Favorites',
      '笔记',
    ]);
  });

  it('backfills presetKey when rehydrating a v0 persisted store', async () => {
    // zustand persist 未配置 version 时写入 version: 0
    localStorage.setItem(
      'learning-hub-desktop',
      JSON.stringify({
        state: {
          shortcuts: zhPersisted(),
          desktopRoot: { folderId: null, folderName: null, folderPath: null },
        },
        version: 0,
      }),
    );
    await useDesktopStore.persist.rehydrate();

    const shortcuts = useDesktopStore.getState().getSortedShortcuts();
    await i18next.changeLanguage('en-US');
    expect(shortcuts.slice(0, 3).map(resolveShortcutName)).toEqual([
      'Notes',
      'Exam Sets',
      '我的作文本',
    ]);
    const stored = JSON.parse(localStorage.getItem('learning-hub-desktop') ?? '{}');
    expect(stored.version).toBe(DESKTOP_STORE_VERSION);
    localStorage.removeItem('learning-hub-desktop');
  });

  it('renaming a preset unlinks it from the localized label', async () => {
    const id = useDesktopStore.getState().addFromPreset(0)!;
    expect(useDesktopStore.getState().shortcuts[0].presetKey).toBe('resourceType.note');

    useDesktopStore.getState().renameShortcut(id, '期末复习');
    const renamed = useDesktopStore.getState().shortcuts[0];
    expect(renamed.presetKey).toBeUndefined();

    await i18next.changeLanguage('en-US');
    expect(resolveShortcutName(renamed)).toBe('期末复习');
  });
});

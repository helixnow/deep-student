import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import zhLearningHub from '@/locales/zh-CN/learningHub.json';
import enLearningHub from '@/locales/en-US/learningHub.json';
import {
  getPresetAppShortcuts,
  useDesktopStore,
  type DesktopShortcut,
} from '@/features/learning-hub/stores/desktopStore';

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

import { DesktopShortcutsLayer, openDesktopShortcut } from './DesktopShortcuts';

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

describe('DesktopShortcutsLayer preset labels', () => {
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
    const [note, exam] = getPresetAppShortcuts();
    useDesktopStore.setState({
      shortcuts: [
        { ...note, id: 'preset-note', position: 0, createdAt: '2026-01-01T00:00:00.000Z' },
        // 用户改过名：不再带 presetKey
        {
          id: 'renamed-exam',
          name: '我的错题',
          type: exam.type,
          target: exam.target,
          position: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      desktopRoot: { folderId: null, folderName: null, folderPath: null },
    });
  });

  it('re-labels untouched presets live on languageChanged and keeps renamed ones', async () => {
    render(<DesktopShortcutsLayer />);

    expect(screen.getByRole('button', { name: '笔记' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '我的错题' })).toBeInTheDocument();

    await act(async () => {
      await i18next.changeLanguage('en-US');
    });

    expect(screen.getByRole('button', { name: 'Notes' })).toBeInTheDocument();
    expect(screen.queryByText('笔记')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '我的错题' })).toBeInTheDocument();
  });
});

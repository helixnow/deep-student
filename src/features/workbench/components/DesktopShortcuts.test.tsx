import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { APP_EVENTS, addAppEventListener } from '@/events';
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

function mockRect(el: Element, left: number, top: number, width: number, height: number) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  });
}

/** jsdom 无 PointerEvent：用 MouseEvent 携带 button / clientX / clientY + pointerId */
function dispatchPointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { button?: number; pointerId?: number; clientX?: number; clientY?: number; metaKey?: boolean; ctrlKey?: boolean } = {},
) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: init.button ?? 0,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
  });
  Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1 });
  Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
  act(() => {
    target.dispatchEvent(ev);
  });
}

describe('DesktopShortcutsLayer 框选、多选、空格 Quick Look 与拖拽重排', () => {
  const resourceShortcuts: DesktopShortcut[] = [
    {
      id: 'res-1',
      name: '微积分笔记',
      type: 'resource',
      target: { resourceId: 'note_calc_1', resourceType: 'note' },
      position: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'res-2',
      name: '线性代数教材',
      type: 'resource',
      target: { resourceId: 'tb_linalg_2', resourceType: 'textbook' },
      position: 1,
      createdAt: '2026-01-01T00:00:01.000Z',
    },
    {
      id: 'res-3',
      name: '英语作文',
      type: 'resource',
      target: { resourceId: 'essay_3', resourceType: 'essay' },
      position: 2,
      createdAt: '2026-01-01T00:00:02.000Z',
    },
  ];

  beforeEach(() => {
    useDesktopStore.setState({
      shortcuts: resourceShortcuts,
      desktopRoot: { folderId: null, folderName: null, folderPath: null },
    });
  });

  it('支持 Cmd/Ctrl + 点击切换多选与点击空白取消', () => {
    render(
      <div data-wb-desktop>
        <DesktopShortcutsLayer />
      </div>,
    );
    const desktop = document.querySelector('[data-wb-desktop]')!;
    const icon1 = document.querySelector('[data-wb-desk-shortcut="res-1"]')!;
    const icon2 = document.querySelector('[data-wb-desk-shortcut="res-2"]')!;

    fireEvent.click(icon1);
    expect(icon1).toHaveAttribute('data-selected', 'true');
    expect(icon2).not.toHaveAttribute('data-selected');

    fireEvent.click(icon2, { metaKey: true });
    expect(icon1).toHaveAttribute('data-selected', 'true');
    expect(icon2).toHaveAttribute('data-selected', 'true');

    // 再次 Cmd+点击取消 res-1
    fireEvent.click(icon1, { metaKey: true });
    expect(icon1).not.toHaveAttribute('data-selected');
    expect(icon2).toHaveAttribute('data-selected', 'true');

    // 点击桌面空白清空选中
    dispatchPointer(desktop, 'pointerdown', { button: 0, pointerId: 1, clientX: 400, clientY: 400 });
    dispatchPointer(window, 'pointerup', { button: 0, pointerId: 1, clientX: 400, clientY: 400 });
    expect(icon2).not.toHaveAttribute('data-selected');
  });

  it('在桌面空白处拖动可拉出玻璃框选矩形并实时命中相交图标', () => {
    render(
      <div data-wb-desktop>
        <DesktopShortcutsLayer />
      </div>,
    );
    const desktop = document.querySelector('[data-wb-desktop]')!;
    const iconsLayer = document.querySelector('[data-wb-desk-icons]')!;
    const icon1 = document.querySelector('[data-wb-desk-shortcut="res-1"]')!;
    const icon2 = document.querySelector('[data-wb-desk-shortcut="res-2"]')!;
    const icon3 = document.querySelector('[data-wb-desk-shortcut="res-3"]')!;

    mockRect(iconsLayer, 0, 0, 1200, 800);
    mockRect(icon1, 16, 16, 92, 106);
    mockRect(icon2, 16, 128, 92, 106);
    mockRect(icon3, 16, 240, 92, 106);

    dispatchPointer(desktop, 'pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    dispatchPointer(window, 'pointermove', { pointerId: 1, clientX: 120, clientY: 200 });

    const marquee = document.querySelector('[data-wb-desk-marquee]');
    expect(marquee).not.toBeNull();
    expect(icon1).toHaveAttribute('data-selected', 'true');
    expect(icon2).toHaveAttribute('data-selected', 'true');
    expect(icon3).not.toHaveAttribute('data-selected');

    dispatchPointer(window, 'pointerup', { pointerId: 1, clientX: 120, clientY: 200 });
    expect(document.querySelector('[data-wb-desk-marquee]')).toBeNull();
    expect(icon1).toHaveAttribute('data-selected', 'true');
    expect(icon2).toHaveAttribute('data-selected', 'true');
  });

  it('选中资源图标时按空格派发 WB_PREVIEW_QUICK_LOOK，输入框聚焦时不触发', () => {
    const received: unknown[] = [];
    const unsubscribe = addAppEventListener(APP_EVENTS.WB_PREVIEW_QUICK_LOOK, (detail) => {
      received.push(detail);
    });

    render(
      <div data-wb-desktop>
        <DesktopShortcutsLayer />
        <input data-testid="search-box" />
      </div>,
    );
    const icon1 = document.querySelector('[data-wb-desk-shortcut="res-1"]') as HTMLElement;
    fireEvent.click(icon1);

    // 焦点在桌面图标上按 Space → 派发 WB_PREVIEW_QUICK_LOOK
    fireEvent.keyDown(icon1, { key: ' ', code: 'Space' });
    expect(received).toEqual([{ resourceId: 'note_calc_1', toggle: true }]);

    // 焦点在输入框内按 Space → 忽略
    const input = screen.getByTestId('search-box');
    input.focus();
    fireEvent.keyDown(input, { key: ' ', code: 'Space' });
    expect(received).toHaveLength(1);

    unsubscribe();
  });

  it('拖拽桌面图标到其他槽位后持久化更新顺序', () => {
    render(
      <div data-wb-desktop>
        <DesktopShortcutsLayer />
      </div>,
    );
    const icon1 = document.querySelector('[data-wb-desk-shortcut="res-1"]')!;
    const icon2 = document.querySelector('[data-wb-desk-shortcut="res-2"]')!;
    const icon3 = document.querySelector('[data-wb-desk-shortcut="res-3"]')!;

    mockRect(icon1, 16, 16, 92, 106);
    mockRect(icon2, 16, 128, 92, 106);
    mockRect(icon3, 16, 240, 92, 106);

    dispatchPointer(icon1, 'pointerdown', { button: 0, pointerId: 2, clientX: 50, clientY: 50 });
    dispatchPointer(window, 'pointermove', { pointerId: 2, clientX: 50, clientY: 280 });
    expect(icon1).toHaveAttribute('data-dragging', 'true');
    expect(icon3).toHaveAttribute('data-drop-target', 'true');

    dispatchPointer(window, 'pointerup', { pointerId: 2, clientX: 50, clientY: 280 });

    const orderedIds = useDesktopStore
      .getState()
      .getSortedShortcuts()
      .map((s) => s.id);
    expect(orderedIds).toEqual(['res-2', 'res-3', 'res-1']);
  });
});

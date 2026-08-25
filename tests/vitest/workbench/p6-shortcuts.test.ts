/**
 * P6 — core/shortcuts.ts 单元测试：
 * 注册表清单 / 键位匹配 / 输入框 guard / 居中几何 / overlay 会话 store
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  WORKBENCH_SHORTCUT_DEFINITIONS,
  listWorkbenchShortcuts,
  formatShortcutBinding,
  matchWorkbenchShortcut,
  isEditableTarget,
  computeCenteredFrame,
  useWorkbenchOverlay,
} from '@/features/workbench/core/shortcuts';
import { resetWorkbenchState } from './p6-testUtils';

beforeEach(() => resetWorkbenchState());

describe('listWorkbenchShortcuts', () => {
  it('返回全部快捷键（§6.4 基础 9 条 + O12/P2 追加 + 上/下半屏）', () => {
    const list = listWorkbenchShortcuts();
    expect(list.map((s) => s.id)).toEqual([
      'tile-left', 'tile-right', 'maximize', 'restore-or-minimize',
      'center', 'cycle-next', 'cycle-prev', 'expose', 'close-window',
      'tile-tl', 'tile-tr', 'tile-bl', 'tile-br',
      'tile-top', 'tile-bottom',
      'move-left', 'move-right', 'move-up', 'move-down',
      'cycle-app-next', 'cycle-app-prev',
      'minimize', 'show-desktop', 'close-all', 'cheatsheet',
      'expose-app',
    ]);
    expect(list).toHaveLength(WORKBENCH_SHORTCUT_DEFINITIONS.length);
  });

  it('每条都有可读键位与 i18n 描述 key', () => {
    for (const s of listWorkbenchShortcuts()) {
      expect(s.keys.length).toBeGreaterThan(0);
      expect(s.descriptionKey).toMatch(/^workbench:shortcuts\./);
      expect(s.defaultDescription.length).toBeGreaterThan(0);
    }
  });

  it('仅 Ctrl+W 可配置', () => {
    const configurable = listWorkbenchShortcuts().filter((s) => s.configurable);
    expect(configurable.map((s) => s.id)).toEqual(['close-window']);
  });

  it('键位格式化：Ctrl+Alt+← / Ctrl+W / Ctrl+Shift+Tab', () => {
    const byId = new Map(listWorkbenchShortcuts().map((s) => [s.id, s.keys]));
    expect(byId.get('tile-left')).toBe('Ctrl+Alt+←');
    expect(byId.get('close-window')).toBe('Ctrl+W');
    expect(byId.get('cycle-prev')).toBe('Ctrl+Shift+Tab');
    expect(byId.get('expose')).toBe('Ctrl+Alt+E');
  });

  it('formatShortcutBinding 覆盖方向键映射', () => {
    expect(formatShortcutBinding({ key: 'ArrowDown', ctrl: true, alt: true, shift: false }))
      .toBe('Ctrl+Alt+↓');
  });
});

describe('matchWorkbenchShortcut', () => {
  const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

  it('Ctrl+Alt+方向键匹配平铺/最大化/恢复', () => {
    expect(matchWorkbenchShortcut(ev({ key: 'ArrowLeft', ctrlKey: true, altKey: true }))?.id)
      .toBe('tile-left');
    expect(matchWorkbenchShortcut(ev({ key: 'ArrowRight', ctrlKey: true, altKey: true }))?.id)
      .toBe('tile-right');
    expect(matchWorkbenchShortcut(ev({ key: 'ArrowUp', ctrlKey: true, altKey: true }))?.id)
      .toBe('maximize');
    expect(matchWorkbenchShortcut(ev({ key: 'ArrowDown', ctrlKey: true, altKey: true }))?.id)
      .toBe('restore-or-minimize');
  });

  it('字母键按 e.code 匹配（键盘布局无关）', () => {
    expect(matchWorkbenchShortcut(ev({ code: 'KeyC', key: 'ç', ctrlKey: true, altKey: true }))?.id)
      .toBe('center');
    expect(matchWorkbenchShortcut(ev({ code: 'KeyE', key: 'e', ctrlKey: true, altKey: true }))?.id)
      .toBe('expose');
    expect(matchWorkbenchShortcut(ev({ code: 'KeyW', key: 'w', ctrlKey: true }))?.id)
      .toBe('close-window');
  });

  it('Ctrl+Tab / Ctrl+Shift+Tab 区分方向', () => {
    expect(matchWorkbenchShortcut(ev({ key: 'Tab', ctrlKey: true }))?.id).toBe('cycle-next');
    expect(matchWorkbenchShortcut(ev({ key: 'Tab', ctrlKey: true, shiftKey: true }))?.id)
      .toBe('cycle-prev');
  });

  it('修饰键不精确匹配时不命中（不劫持浏览器/系统组合）', () => {
    // 无修饰
    expect(matchWorkbenchShortcut(ev({ key: 'ArrowLeft' }))).toBeNull();
    // Ctrl+Alt+Shift+方向键已被 O12 注册为贴边移动，不再视为多余 Shift
    expect(matchWorkbenchShortcut(ev({ key: 'ArrowLeft', ctrlKey: true, altKey: true, shiftKey: true }))?.id)
      .toBe('move-left');
    // 其他未注册组合仍需精确匹配
    expect(matchWorkbenchShortcut(ev({ code: 'KeyC', key: 'c', ctrlKey: true, altKey: true, shiftKey: true })))
      .toBeNull();
    // Meta 参与一律放行
    expect(matchWorkbenchShortcut(ev({ key: 'Tab', ctrlKey: true, metaKey: true }))).toBeNull();
    // 纯 Ctrl+方向（文本编辑常用）不命中
    expect(matchWorkbenchShortcut(ev({ key: 'ArrowLeft', ctrlKey: true }))).toBeNull();
    // Alt+Tab 不命中
    expect(matchWorkbenchShortcut(ev({ key: 'Tab', altKey: true }))).toBeNull();
  });
});

describe('isEditableTarget（输入框 guard）', () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  it('input / textarea / select 命中', () => {
    for (const tag of ['input', 'textarea', 'select'] as const) {
      const el = document.createElement(tag);
      host.appendChild(el);
      expect(isEditableTarget(el)).toBe(true);
    }
  });

  it('contenteditable 及其后代命中', () => {
    host.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    host.appendChild(child);
    expect(isEditableTarget(host)).toBe(true);
    expect(isEditableTarget(child)).toBe(true);
  });

  it('普通元素 / window / null 不命中', () => {
    const div = document.createElement('div');
    host.appendChild(div);
    expect(isEditableTarget(div)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    host.setAttribute('contenteditable', 'false');
    expect(isEditableTarget(host)).toBe(false);
  });
});

describe('computeCenteredFrame', () => {
  it('保持尺寸居中', () => {
    expect(computeCenteredFrame({ x: 0, y: 0, w: 400, h: 300 }, { w: 1600, h: 900 }))
      .toEqual({ x: 600, y: 300, w: 400, h: 300 });
  });

  it('超出桌面时收缩到桌面并贴 0', () => {
    expect(computeCenteredFrame({ x: 10, y: 10, w: 2000, h: 1200 }, { w: 1600, h: 900 }))
      .toEqual({ x: 0, y: 0, w: 1600, h: 900 });
  });
});

describe('useWorkbenchOverlay（会话 store）', () => {
  it('openSwitcher 空列表 no-op；索引取模回绕', () => {
    const s = useWorkbenchOverlay.getState();
    s.openSwitcher([], 1);
    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(false);

    s.openSwitcher(['a', 'b', 'c'], 4);
    expect(useWorkbenchOverlay.getState().switcherIndex).toBe(1);
  });

  it('stepSwitcher 双向回绕', () => {
    useWorkbenchOverlay.getState().openSwitcher(['a', 'b', 'c'], 2);
    useWorkbenchOverlay.getState().stepSwitcher(1);
    expect(useWorkbenchOverlay.getState().switcherIndex).toBe(0);
    useWorkbenchOverlay.getState().stepSwitcher(-1);
    expect(useWorkbenchOverlay.getState().switcherIndex).toBe(2);
  });

  it('打开俯瞰会关闭切换器（互斥），反之亦然', () => {
    useWorkbenchOverlay.getState().openSwitcher(['a'], 0);
    useWorkbenchOverlay.getState().openExpose();
    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(false);
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(true);

    useWorkbenchOverlay.getState().openSwitcher(['a'], 0);
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(false);
  });

  it('closeSwitcher 清空会话', () => {
    useWorkbenchOverlay.getState().openSwitcher(['a', 'b'], 1);
    useWorkbenchOverlay.getState().closeSwitcher();
    const st = useWorkbenchOverlay.getState();
    expect(st.switcherOpen).toBe(false);
    expect(st.switcherIds).toEqual([]);
    expect(st.switcherIndex).toBe(0);
  });
});

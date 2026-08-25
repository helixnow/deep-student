/**
 * P6 — useWorkbenchShortcuts 行为测试：
 * 输入框 guard、平铺/最大化/恢复/居中/关闭、Ctrl+Tab 会话（顺序=lastFocusedAt、
 * 按住循环、松开 Ctrl 聚焦、Esc 取消）、enabled/enableCloseWindow 选项
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWorkbenchShortcuts } from '@/features/workbench/hooks/useWorkbenchShortcuts';
import { appRegistry } from '@/features/workbench/core/appRegistry';
import { useWindowStore } from '@/features/workbench/core/windowStore';
import { useWorkbenchOverlay } from '@/features/workbench/core/shortcuts';
import type { AppDefinition } from '@/features/workbench/core/types';
import {
  makeWindow,
  seedWindows,
  resetWorkbenchState,
  focusedWindowId,
  keydown,
  keyup,
} from './p6-testUtils';

const win = (id: string, lastFocusedAt: number, extra = {}) =>
  makeWindow({ id, lastFocusedAt, ...extra });

const TABBED_APP_TYPE_ID = 'tabbed-shortcut-test';

appRegistry.register({
  typeId: TABBED_APP_TYPE_ID,
  nameKey: 'workbench:test.tabbedShortcut',
  icon: null,
  instanceMode: 'single',
  memoryWeight: 1,
  defaultFrame: { w: 400, h: 300 },
  minSize: { w: 200, h: 150 },
  render: null as unknown as AppDefinition['render'],
  handlesCloseShortcut: true,
});

/** 声明内部标签循环（Ctrl+Tab 让位协议）的测试应用 */
const TAB_CYCLE_APP_TYPE_ID = 'tab-cycle-claim-test';

appRegistry.register({
  typeId: TAB_CYCLE_APP_TYPE_ID,
  nameKey: 'workbench:test.tabCycleClaim',
  icon: null,
  instanceMode: 'single',
  memoryWeight: 1,
  defaultFrame: { w: 400, h: 300 },
  minSize: { w: 200, h: 150 },
  render: null as unknown as AppDefinition['render'],
  handlesTabCycleShortcut: true,
});

function seedThree() {
  // a 最近聚焦，其次 b，再次 c
  seedWindows([win('a', 300), win('b', 200), win('c', 100)]);
}

beforeEach(() => resetWorkbenchState());
afterEach(() => resetWorkbenchState());

describe('窗口管理快捷键', () => {
  it('Ctrl+Alt+←/→/↑ 作用于焦点窗口', () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts());

    act(() => { keydown({ key: 'ArrowLeft', ctrlKey: true, altKey: true }); });
    expect(useWindowStore.getState().windows.a.displayMode).toBe('tiled-left');

    act(() => { keydown({ key: 'ArrowRight', ctrlKey: true, altKey: true }); });
    expect(useWindowStore.getState().windows.a.displayMode).toBe('tiled-right');

    act(() => { keydown({ key: 'ArrowUp', ctrlKey: true, altKey: true }); });
    expect(useWindowStore.getState().windows.a.displayMode).toBe('maximized');
    // 非焦点窗口不受影响
    expect(useWindowStore.getState().windows.b.displayMode).toBe('floating');
    hook.unmount();
  });

  it('按键 repeat 不重复执行布局命令，但 Ctrl+Tab 循环仍允许 repeat', () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts());
    const before = useWindowStore.getState().windows.a;
    act(() => {
      keydown({ key: 'ArrowLeft', ctrlKey: true, altKey: true, repeat: true });
    });
    expect(useWindowStore.getState().windows.a).toBe(before);

    act(() => { keydown({ key: 'Tab', ctrlKey: true }); });
    expect(useWorkbenchOverlay.getState().switcherIndex).toBe(1);
    act(() => { keydown({ key: 'Tab', ctrlKey: true, repeat: true }); });
    expect(useWorkbenchOverlay.getState().switcherIndex).toBe(2);
    hook.unmount();
  });

  it('Ctrl+Alt+↓：非 floating 恢复原尺寸，floating 最小化', async () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts());
    const original = useWindowStore.getState().windows.a.frame;

    act(() => { keydown({ key: 'ArrowUp', ctrlKey: true, altKey: true }); });
    act(() => { keydown({ key: 'ArrowDown', ctrlKey: true, altKey: true }); });
    const restored = useWindowStore.getState().windows.a;
    expect(restored.displayMode).toBe('floating');
    expect(restored.frame).toEqual(original);

    act(() => { keydown({ key: 'ArrowDown', ctrlKey: true, altKey: true }); });
    // 无壳时 orphan 兜底下一帧提交 minimize
    await waitFor(() => {
      expect(useWindowStore.getState().windows.a.minimized).toBe(true);
    });
    hook.unmount();
  });

  it('Ctrl+Alt+C 居中焦点窗口', () => {
    seedWindows([win('a', 100, { frame: { x: 0, y: 0, w: 400, h: 300 } })]);
    const hook = renderHook(() => useWorkbenchShortcuts());
    act(() => { keydown({ code: 'KeyC', key: 'c', ctrlKey: true, altKey: true }); });
    expect(useWindowStore.getState().windows.a.frame).toEqual({ x: 600, y: 300, w: 400, h: 300 });
    hook.unmount();
  });

  it('Ctrl+W 经 requestCloseAnimated 关闭焦点窗口', async () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts());
    act(() => { keydown({ code: 'KeyW', key: 'w', ctrlKey: true }); });
    await waitFor(() => {
      expect(useWindowStore.getState().windows.a).toBeUndefined();
    });
    expect(Object.keys(useWindowStore.getState().windows).sort()).toEqual(['b', 'c']);
    hook.unmount();
  });

  it('Ctrl+W 放行给声明内部标签关闭语义的应用', () => {
    seedWindows([win('tabbed', 100, { typeId: TABBED_APP_TYPE_ID })]);
    const target = document.createElement('button');
    document.body.appendChild(target);
    const appHandler = vi.fn((event: KeyboardEvent) => {
      if (event.ctrlKey && event.code === 'KeyW') event.preventDefault();
    });
    target.addEventListener('keydown', appHandler);
    const hook = renderHook(() => useWorkbenchShortcuts());

    const event = keydown({ code: 'KeyW', key: 'w', ctrlKey: true }, target);

    expect(appHandler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(useWindowStore.getState().windows.tabbed).toBeDefined();

    hook.unmount();
    target.removeEventListener('keydown', appHandler);
    target.remove();
  });

  it('enableCloseWindow=false 时 Ctrl+W 不触发', async () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts({ enableCloseWindow: false }));
    act(() => { keydown({ code: 'KeyW', key: 'w', ctrlKey: true }); });
    await new Promise((r) => setTimeout(r, 0));
    expect(useWindowStore.getState().windows.a).toBeDefined();
    hook.unmount();
  });

  it('无窗口时快捷键静默不抛错', () => {
    const hook = renderHook(() => useWorkbenchShortcuts());
    expect(() => {
      act(() => { keydown({ key: 'ArrowLeft', ctrlKey: true, altKey: true }); });
    }).not.toThrow();
    hook.unmount();
  });
});

describe('输入框 guard', () => {
  it.each([
    ['input', () => document.createElement('input')],
    ['textarea', () => document.createElement('textarea')],
    ['contenteditable', () => {
      const div = document.createElement('div');
      div.setAttribute('contenteditable', 'true');
      return div;
    }],
  ])('焦点在 %s 内时全部快捷键不触发', (_name, createEl) => {
    seedThree();
    const el = createEl();
    document.body.appendChild(el);
    const hook = renderHook(() => useWorkbenchShortcuts());

    act(() => {
      keydown({ key: 'ArrowLeft', ctrlKey: true, altKey: true }, el);
      keydown({ key: 'Tab', ctrlKey: true }, el);
      keydown({ code: 'KeyE', key: 'e', ctrlKey: true, altKey: true }, el);
    });

    expect(useWindowStore.getState().windows.a.displayMode).toBe('floating');
    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(false);
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(false);
    hook.unmount();
    el.remove();
  });
});

describe('Ctrl+Tab 切换器会话', () => {
  it('首次 Ctrl+Tab：顺序=lastFocusedAt 降序，初始选中下一个最近使用', () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts());
    act(() => { keydown({ key: 'Tab', ctrlKey: true }); });
    const st = useWorkbenchOverlay.getState();
    expect(st.switcherOpen).toBe(true);
    expect(st.switcherIds).toEqual(['a', 'b', 'c']);
    expect(st.switcherIndex).toBe(1);
    hook.unmount();
  });

  it('按住循环并回绕；Shift 反向', () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts());
    act(() => { keydown({ key: 'Tab', ctrlKey: true }); });          // -> b (1)
    act(() => { keydown({ key: 'Tab', ctrlKey: true }); });          // -> c (2)
    expect(useWorkbenchOverlay.getState().switcherIndex).toBe(2);
    act(() => { keydown({ key: 'Tab', ctrlKey: true }); });          // 回绕 -> a (0)
    expect(useWorkbenchOverlay.getState().switcherIndex).toBe(0);
    act(() => { keydown({ key: 'Tab', ctrlKey: true, shiftKey: true }); }); // 反向 -> c (2)
    expect(useWorkbenchOverlay.getState().switcherIndex).toBe(2);
    hook.unmount();
  });

  it('Ctrl+Shift+Tab 直接开启时选中最久未用', () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts());
    act(() => { keydown({ key: 'Tab', ctrlKey: true, shiftKey: true }); });
    expect(useWorkbenchOverlay.getState().switcherIndex).toBe(2); // c
    hook.unmount();
  });

  it('松开 Ctrl 聚焦选中窗口并结束会话', () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts());
    act(() => { keydown({ key: 'Tab', ctrlKey: true }); }); // 选中 b
    act(() => { keyup({ key: 'Control' }); });
    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(false);
    expect(focusedWindowId()).toBe('b');
    hook.unmount();
  });

  it('切换到最小化窗口会恢复显示', () => {
    seedWindows([win('a', 300), win('b', 200, { minimized: true })]);
    const hook = renderHook(() => useWorkbenchShortcuts());
    act(() => { keydown({ key: 'Tab', ctrlKey: true }); });
    expect(useWorkbenchOverlay.getState().switcherIds).toEqual(['a', 'b']);
    act(() => { keyup({ key: 'Control' }); });
    expect(useWindowStore.getState().windows.b.minimized).toBe(false);
    expect(focusedWindowId()).toBe('b');
    hook.unmount();
  });

  it('Esc 取消会话且不改变焦点', () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts());
    act(() => { keydown({ key: 'Tab', ctrlKey: true }); });
    act(() => { keydown({ key: 'Escape' }); });
    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(false);
    act(() => { keyup({ key: 'Control' }); });
    expect(focusedWindowId()).toBe('a');
    hook.unmount();
  });

  it('window blur 取消悬挂会话', () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts());
    act(() => { keydown({ key: 'Tab', ctrlKey: true }); });
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(false);
    hook.unmount();
  });

  it('会话中窗口被关闭：提交时安全跳过', () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts());
    expect(useWindowStore.getState().focusStack).toEqual(['c', 'b', 'a']);
    act(() => { keydown({ key: 'Tab', ctrlKey: true }); }); // 选中 b
    expect(useWorkbenchOverlay.getState().switcherIndex).toBe(1);
    expect(useWindowStore.getState().focusStack).toEqual(['c', 'b', 'a']);
    act(() => { useWindowStore.getState().closeWindow('b'); });
    expect(useWindowStore.getState().focusStack).toEqual(['c', 'a']);
    expect(() => {
      act(() => { keyup({ key: 'Control' }); });
    }).not.toThrow();
    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(false);
    expect(focusedWindowId()).toBe('a');
    hook.unmount();
  });
});

describe('Ctrl+Tab 让位协议（handlesTabCycleShortcut）', () => {
  it('焦点应用声明内部标签循环：壳层让位（不开切换器、不 preventDefault）', () => {
    seedWindows([
      win('claim', 300, { typeId: TAB_CYCLE_APP_TYPE_ID }),
      win('plain', 200),
    ]);
    const hook = renderHook(() => useWorkbenchShortcuts());

    const event = keydown({ key: 'Tab', ctrlKey: true });

    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(false);
    // 未 preventDefault：应用自持监听器可凭 !defaultPrevented 消费
    expect(event.defaultPrevented).toBe(false);
    hook.unmount();
  });

  it('Ctrl+Shift+Tab 同样让位', () => {
    seedWindows([
      win('claim', 300, { typeId: TAB_CYCLE_APP_TYPE_ID }),
      win('plain', 200),
    ]);
    const hook = renderHook(() => useWorkbenchShortcuts());

    const event = keydown({ key: 'Tab', ctrlKey: true, shiftKey: true });

    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    hook.unmount();
  });

  it('让位后应用侧监听器可消费该事件（!defaultPrevented 判定）', () => {
    seedWindows([win('claim', 300, { typeId: TAB_CYCLE_APP_TYPE_ID })]);
    const hook = renderHook(() => useWorkbenchShortcuts());

    const appHandler = vi.fn((event: KeyboardEvent) => {
      // 应用协议：壳层让位（未 preventDefault）时才接管
      if (event.ctrlKey && event.key === 'Tab' && !event.defaultPrevented) {
        event.preventDefault();
      }
    });
    window.addEventListener('keydown', appHandler);

    const event = keydown({ key: 'Tab', ctrlKey: true });
    expect(appHandler).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true); // 由应用（而非壳层）prevent
    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(false);

    window.removeEventListener('keydown', appHandler);
    hook.unmount();
  });

  it('切换器会话已开启：壳层保持所有权（继续步进 + preventDefault）', () => {
    seedWindows([
      win('claim', 300, { typeId: TAB_CYCLE_APP_TYPE_ID }),
      win('plain', 200),
    ]);
    const hook = renderHook(() => useWorkbenchShortcuts());

    // 会话由其他入口开启（如让位前无声明应用聚焦时开的会话未松开 Ctrl）
    act(() => {
      useWorkbenchOverlay.getState().openSwitcher(['claim', 'plain'], 0);
    });

    const event = keydown({ key: 'Tab', ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(useWorkbenchOverlay.getState().switcherIndex).toBe(1);
    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(true);
    hook.unmount();
  });

  it('焦点在未声明的应用上：正常开切换器（后台的声明应用不影响）', () => {
    seedWindows([
      win('plain', 300),
      win('claim', 200, { typeId: TAB_CYCLE_APP_TYPE_ID }),
    ]);
    const hook = renderHook(() => useWorkbenchShortcuts());

    const event = keydown({ key: 'Tab', ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(true);
    hook.unmount();
  });
});

describe('俯瞰快捷键与互斥', () => {
  it('Ctrl+Alt+E 开关俯瞰', () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts());
    act(() => { keydown({ code: 'KeyE', key: 'e', ctrlKey: true, altKey: true }); });
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(true);
    act(() => { keydown({ code: 'KeyE', key: 'e', ctrlKey: true, altKey: true }); });
    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(false);
    hook.unmount();
  });

  it('俯瞰激活期间其他窗口快捷键被抑制', () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts());
    act(() => { keydown({ code: 'KeyE', key: 'e', ctrlKey: true, altKey: true }); });
    act(() => { keydown({ key: 'ArrowLeft', ctrlKey: true, altKey: true }); });
    expect(useWindowStore.getState().windows.a.displayMode).toBe('floating');
    hook.unmount();
  });
});

describe('enabled 选项', () => {
  it('enabled=false 时不监听任何按键', () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts({ enabled: false }));
    act(() => {
      keydown({ key: 'ArrowLeft', ctrlKey: true, altKey: true });
      keydown({ key: 'Tab', ctrlKey: true });
    });
    expect(useWindowStore.getState().windows.a.displayMode).toBe('floating');
    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(false);
    hook.unmount();
  });

  it('卸载时清理会话与监听器', () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts());
    act(() => { keydown({ key: 'Tab', ctrlKey: true }); });
    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(true);
    hook.unmount();
    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(false);
    act(() => { keydown({ key: 'ArrowLeft', ctrlKey: true, altKey: true }); });
    expect(useWindowStore.getState().windows.a.displayMode).toBe('floating');
  });

  it('命中的快捷键 preventDefault（不与系统/浏览器行为冲突）', () => {
    seedThree();
    const hook = renderHook(() => useWorkbenchShortcuts());
    const ev = new KeyboardEvent('keydown', {
      key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true,
    });
    act(() => { window.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    // 未命中的组合不 preventDefault
    const plain = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(plain); });
    expect(plain.defaultPrevented).toBe(false);
    hook.unmount();
  });
});

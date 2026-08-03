/**
 * immersiveMode（P2 绿灯沉浸模式）：进入/退出的 displayMode 与菜单栏强制
 * autohide 联动、Esc 退出（可编辑焦点豁免）、窗口自行离开 maximized 的自动清理。
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { resetWindowStoreForTests, useWindowStore } from '../windowStore';
import {
  enterImmersive,
  exitImmersive,
  isWindowImmersive,
  resetImmersiveModeForTests,
  toggleImmersive,
} from '../immersiveMode';
import {
  resetMenuBarAutohideForTests,
  useMenuBarAutohideStore,
} from '../../components/menuBarAutohideStore';

const FRAME = { x: 24, y: 32, w: 480, h: 320 };

function openWindow(instanceKey = 'a'): string {
  return useWindowStore.getState().openWindow({
    typeId: 'immersive-core-test',
    instanceKey,
    initialFrame: { ...FRAME },
  });
}

beforeEach(() => {
  resetWindowStoreForTests({ w: 1400, h: 900 });
  resetImmersiveModeForTests();
  resetMenuBarAutohideForTests();
});

afterEach(() => {
  resetImmersiveModeForTests();
  resetMenuBarAutohideForTests();
});

describe('进入 / 退出', () => {
  it('进入 = maximize + 菜单栏强制 autohide；退出恢复 floating 与原 frame', () => {
    const id = openWindow();
    enterImmersive(id);

    expect(isWindowImmersive(id)).toBe(true);
    expect(useWindowStore.getState().windows[id]?.displayMode).toBe('maximized');
    expect(useMenuBarAutohideStore.getState().forceAutohide).toBe(true);

    exitImmersive();
    expect(isWindowImmersive(id)).toBe(false);
    const win = useWindowStore.getState().windows[id];
    expect(win?.displayMode).toBe('floating');
    expect(win?.frame).toMatchObject(FRAME);
    expect(useMenuBarAutohideStore.getState().forceAutohide).toBe(false);
  });

  it('从平铺态进入沉浸，退出时恢复平铺模式', () => {
    const id = openWindow();
    useWindowStore.getState().setDisplayMode(id, 'tiled-left');
    enterImmersive(id);
    expect(useWindowStore.getState().windows[id]?.displayMode).toBe('maximized');

    exitImmersive();
    expect(useWindowStore.getState().windows[id]?.displayMode).toBe('tiled-left');
  });

  it('toggle 二次调用等价进入后退出', () => {
    const id = openWindow();
    toggleImmersive(id);
    expect(isWindowImmersive(id)).toBe(true);
    toggleImmersive(id);
    expect(isWindowImmersive(id)).toBe(false);
  });

  it('第二个窗口进入沉浸时替换前一个（单沉浸语义）', () => {
    const id1 = openWindow('a');
    const id2 = openWindow('b');
    enterImmersive(id1);
    enterImmersive(id2);
    expect(isWindowImmersive(id1)).toBe(false);
    expect(isWindowImmersive(id2)).toBe(true);
    // 前一窗已按退出路径恢复 floating
    expect(useWindowStore.getState().windows[id1]?.displayMode).toBe('floating');
    expect(useMenuBarAutohideStore.getState().forceAutohide).toBe(true);
  });
});

describe('Esc 退出', () => {
  it('Esc 退出沉浸模式', () => {
    const id = openWindow();
    enterImmersive(id);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(isWindowImmersive(id)).toBe(false);
    expect(useMenuBarAutohideStore.getState().forceAutohide).toBe(false);
  });

  it('焦点在可编辑目标（输入框）时 Esc 不退出', () => {
    const id = openWindow();
    enterImmersive(id);
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(isWindowImmersive(id)).toBe(true);
    } finally {
      input.remove();
    }
  });

  it('已 defaultPrevented 的 Esc 不退出（更内层消费者优先）', () => {
    const id = openWindow();
    enterImmersive(id);
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(isWindowImmersive(id)).toBe(true);
  });
});

describe('窗口自行离开 maximized 的自动清理', () => {
  it('关闭沉浸窗口 → 沉浸态与菜单栏强制被清理', () => {
    const id = openWindow();
    enterImmersive(id);
    useWindowStore.getState().closeWindow(id);
    expect(isWindowImmersive(id)).toBe(false);
    expect(useMenuBarAutohideStore.getState().forceAutohide).toBe(false);
  });

  it('最小化沉浸窗口 → 自动退出且不回写 displayMode', () => {
    const id = openWindow();
    enterImmersive(id);
    useWindowStore.getState().minimizeWindow(id, true);
    expect(isWindowImmersive(id)).toBe(false);
    expect(useMenuBarAutohideStore.getState().forceAutohide).toBe(false);
    expect(useWindowStore.getState().windows[id]?.displayMode).toBe('maximized');
  });

  it('外部把窗口切出 maximized（如平铺菜单）→ 沉浸态清理且保留新模式', () => {
    const id = openWindow();
    enterImmersive(id);
    useWindowStore.getState().setDisplayMode(id, 'tiled-right');
    expect(isWindowImmersive(id)).toBe(false);
    expect(useWindowStore.getState().windows[id]?.displayMode).toBe('tiled-right');
    expect(useMenuBarAutohideStore.getState().forceAutohide).toBe(false);
  });
});

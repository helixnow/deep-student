/**
 * showDesktop stash 语义：
 * stash → 手动恢复一扇 → 再 showDesktop → 再 restore 时另一扇仍能回来（合并而非整表覆盖）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { resetWindowStoreForTests, useWindowStore } from '../../core/windowStore';
import { registerTestApp } from '../../core/__tests__/testUtils';
import {
  getShowDesktopStashForTests,
  resetShowDesktopStashForTests,
  toggleShowDesktop,
} from '../showDesktop';

registerTestApp('show-desktop-app');

function openWin(instanceKey: string, title: string): string {
  return useWindowStore.getState().openWindow({
    typeId: 'show-desktop-app',
    instanceKey,
    title,
  });
}

async function flushMinimize(ids: string[]): Promise<void> {
  await waitFor(() => {
    const { windows, transientPhases } = useWindowStore.getState();
    for (const id of ids) {
      expect(windows[id]?.minimized).toBe(true);
      expect(transientPhases?.[id]).toBeFalsy();
    }
  });
}

beforeEach(() => {
  resetWindowStoreForTests();
  resetShowDesktopStashForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('toggleShowDesktop stash merge', () => {
  it('手动恢复一扇后再 showDesktop，restore 仍能带回另一扇', async () => {
    const idA = openWin('a', 'Window A');
    const idB = openWin('b', 'Window B');

    toggleShowDesktop();
    await flushMinimize([idA, idB]);
    expect(getShowDesktopStashForTests()).toEqual([idA, idB]);

    // 用户手动恢复 A（stash 仍含 A、B）
    useWindowStore.getState().minimizeWindow(idA, false);
    expect(useWindowStore.getState().windows[idA].minimized).toBe(false);
    expect(useWindowStore.getState().windows[idB].minimized).toBe(true);

    // 再显示桌面：应合并可见的 A，而不是用 [A] 整表覆盖丢掉 B
    toggleShowDesktop();
    await flushMinimize([idA]);
    expect(getShowDesktopStashForTests()).toEqual(
      expect.arrayContaining([idA, idB]),
    );
    expect(getShowDesktopStashForTests()).toHaveLength(2);
    expect(useWindowStore.getState().windows[idB].minimized).toBe(true);

    // 恢复：A 与 B 都应回来
    toggleShowDesktop();
    expect(useWindowStore.getState().windows[idA].minimized).toBe(false);
    expect(useWindowStore.getState().windows[idB].minimized).toBe(false);
    expect(getShowDesktopStashForTests()).toEqual([]);
  });

  it('stash 为空时新建；关窗 id 不在 store 时跳过', async () => {
    const idA = openWin('a', 'Window A');
    const idB = openWin('b', 'Window B');

    toggleShowDesktop();
    await flushMinimize([idA, idB]);

    useWindowStore.getState().closeWindow(idA);
    expect(useWindowStore.getState().windows[idA]).toBeUndefined();

    toggleShowDesktop();
    expect(useWindowStore.getState().windows[idB].minimized).toBe(false);
    expect(getShowDesktopStashForTests()).toEqual([]);
  });
});

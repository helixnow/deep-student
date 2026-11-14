/**
 * 开窗源点（--wb-minimize-origin-x/y）不依赖 Dock 的 rAF 防抖发布先跑完。
 *
 * Dock 在 rAF 里发布图标坐标，opening 相位在开窗那次提交的 layout effect 里取坐标；
 * 两者谁先谁后取决于帧调度，过去会随机落到回退值 50%/50%（学习桌面演示开场两扇窗约一半概率）。
 * 这里把 rAF 挂起（永不回调），模拟发布还没跑的那一半。
 */
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppDefinition, AppWindowProps } from '../../core/types';
import { appRegistry } from '../../core/appRegistry';
import { useWindowStore } from '../../core/windowStore';
import { Dock } from '../Dock';
import { setDockPinned } from '../DockPinnedStore';
import { WindowBody } from '../WindowBody';
import { clearDockGeometry } from '../dockGeometry';

const NullApp: React.FC<AppWindowProps> = () => null;

function makeApp(typeId: string): AppDefinition {
  return {
    typeId,
    nameKey: `workbench:app.${typeId}`,
    icon: <span>{typeId[0]}</span>,
    instanceMode: 'multi',
    memoryWeight: 1,
    defaultFrame: { w: 400, h: 300 },
    minSize: { w: 200, h: 150 },
    render: React.lazy(async () => ({ default: NullApp })),
  };
}

/** 视口坐标：窗口壳 (100,100,400×400)；图标中心 pinned-app (200,900)、extra-app (340,900) */
const SHELL = { left: 100, top: 100, width: 400, height: 400 };
const ICONS: Record<string, { left: number; top: number }> = {
  'pinned-app': { left: 176, top: 876 },
  'extra-app': { left: 316, top: 876 },
};

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}

function geometry(this: Element): DOMRect {
  if (this.hasAttribute('data-wb-window-id')) return rect(SHELL.left, SHELL.top, SHELL.width, SHELL.height);
  const typeId = this.getAttribute('data-testid')?.replace(/^wb-dock-item-/, '');
  const icon = this.hasAttribute('data-wb-dock-item-wrap') && typeId ? ICONS[typeId] : undefined;
  return icon ? rect(icon.left, icon.top, 48, 48) : rect(0, 0, 0, 0);
}

const Windows: React.FC = () => {
  const ids = useWindowStore((s) => Object.keys(s.windows).join('|'));
  return (
    <>
      {ids
        ? ids.split('|').map((id) => (
            <section key={id} data-wb-window-id={id}>
              <WindowBody windowId={id} />
            </section>
          ))
        : null}
    </>
  );
};

/** 学习桌面的最小装配：窗口壳 + WindowBody 与 Dock 同树，开窗时同一次提交 */
const Desk: React.FC = () => (
  <>
    <Windows />
    <Dock />
  </>
);

function origin(id: string): string {
  const shell = document.querySelector<HTMLElement>(`[data-wb-window-id="${id}"]`)!;
  return `${shell.style.getPropertyValue('--wb-minimize-origin-x')} ${shell.style.getPropertyValue('--wb-minimize-origin-y')}`;
}

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  appRegistry.register(makeApp('pinned-app'));
  appRegistry.register(makeApp('extra-app'));
});

beforeEach(() => {
  useWindowStore.setState({
    windows: {},
    focusStack: [],
    lifecycles: {},
    launchPayloads: {},
    tilingRatios: {},
    transientPhases: {},
    desktopSize: { w: 1600, h: 900 },
  });
  clearDockGeometry();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(geometry);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  clearDockGeometry();
});

describe('opening 源点与 Dock 坐标发布的时序', () => {
  it('固定区应用：Dock 已挂载、坐标还没发布时开窗，源点仍对齐图标中心', async () => {
    setDockPinned(['pinned-app']);
    render(<Desk />);
    let id = '';
    await act(async () => {
      id = useWindowStore.getState().openWindow({ typeId: 'pinned-app' });
    });
    expect(useWindowStore.getState().transientPhases?.[id]).toBe('opening');
    expect(origin(id)).toBe('25% 200%');
  });

  it('非固定区应用：运行项与窗口同一次提交出现，源点对齐新图标', async () => {
    setDockPinned(['pinned-app']);
    render(<Desk />);
    let id = '';
    await act(async () => {
      id = useWindowStore.getState().openWindow({ typeId: 'extra-app' });
    });
    expect(origin(id)).toBe('60% 200%');
  });

  it('Dock 卸载后开窗仍回退中心源点（量测登记随 Dock 注销）', async () => {
    setDockPinned(['pinned-app']);
    render(<Dock />).unmount();
    render(<Windows />);
    let id = '';
    await act(async () => {
      id = useWindowStore.getState().openWindow({ typeId: 'pinned-app' });
    });
    expect(origin(id)).toBe('50% 50%');
  });
});

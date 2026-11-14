/**
 * Evidence for the Analysis Panel host frame, recorded before DebugPanelHost is split: the stored position and size
 * with their fallbacks and viewport clamping, pointer drag and resize (saved on release only), double-click reset,
 * collapse, the home screen (groups, favourites first, search, badges, grid columns by panel width), persisted
 * favourites and activation, panels requested by URL or `DSTU_DEBUG_PLUGIN`, the master switch, keep-alive while
 * hidden, and the title-bar actions. Panels are fake components announced without a UI kernel; every case gets a
 * fresh host module. Geometry is asserted as numbers from the host's formulas for the viewport each case sets.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebugPanel, DebugPanelHostProps, DebugPanelPluginProps } from '@/ui-plugins/official/debug/api';
import { pinDefaultLocaleForFile } from './defaultLocale';

const h = vi.hoisted(() => ({ log: [] as string[] }));

vi.mock('../panels', () => ({}));
vi.mock('@/dev/devtools', () => ({ toggleDevtools: vi.fn(async () => null) }));
vi.mock('@/events', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/events')>()), dispatchAppEvent: vi.fn() }));

pinDefaultLocaleForFile();

function fakePanel(id: string): React.ComponentType<DebugPanelPluginProps> {
  return function FakePanel({ visible, isActive, isActivated }: DebugPanelPluginProps) {
    React.useEffect(() => {
      h.log.push(`mount ${id}`);
      return () => {
        h.log.push(`unmount ${id}`);
      };
    }, []);
    return <div data-testid={`panel-${id}`}>{`${id} visible=${visible} active=${isActive} activated=${isActivated}`}</div>;
  };
}

const panel = (id: string, groupId: string, label: string, description: string): DebugPanel => ({
  id, groupId, labelKey: `fake.${id}`, descriptionKey: `fake.${id}.desc`, labelDefault: label, descriptionDefault: description, component: fakePanel(id),
});

const PANELS: DebugPanel[] = [
  panel('p-zeta', 'infra-quality', 'Zeta tools', 'Inspects the pipeline'),
  panel('p-alpha', 'infra-quality', 'alpha probe', 'Watches the network'),
  panel('p-mid', 'infra-quality', 'Mid monitor', 'A zeta helper'),
  panel('p-chat', 'chat-timeline', 'Chat trace', 'Message flow'),
  panel('p-hidden', 'nowhere', 'Hidden lab', 'Only reachable by request'),
];

type Api = typeof import('@/ui-plugins/official/debug/api');
let Host: React.ComponentType<DebugPanelHostProps>;
let api: Api;
let master: typeof import('../debugMasterSwitch')['debugMasterSwitch'];
let events: typeof import('@/events');
let devtools: typeof import('@/dev/devtools');

function viewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
}

beforeEach(async () => {
  h.log.length = 0;
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  viewport(1280, 800);
  vi.resetModules();
  api = await import('@/ui-plugins/official/debug/api');
  for (const p of PANELS) api.debugPanelContributions.announce(p);
  ({ debugMasterSwitch: master } = await import('../debugMasterSwitch'));
  events = await import('@/events');
  devtools = await import('@/dev/devtools');
  ({ default: Host } = await import('../DebugPanelHost'));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

const portal = () => document.getElementById('dstu-debugger-portal')!;
const root = () => portal().firstElementChild as HTMLElement;
const header = () => portal().querySelector<HTMLElement>('.dbg-header')!;
const resizeHandle = () => portal().querySelector<HTMLElement>('.dbg-resize');
const rightButtons = () => Array.from(header().children[1].querySelectorAll('button'));

/** left, top, width, height as the frame's inline style says. */
const frame = () => {
  const { left, top, width, height } = root().style;
  return { left, top, width, height };
};
const box = (x: number, y: number, w: number, hgt: number) => ({ left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hgt}px` });

/** A pointer event as React and the host read it (jsdom has no PointerEvent): coordinates, button, pointerType. */
function pointer(target: EventTarget, type: string, { x = 0, y = 0, button = 0, pointerType = 'mouse' } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
}

const stored = (key: string) => localStorage.getItem(key);

/** Home screen: each group's card titles, in order. */
const groups = () =>
  Array.from(portal().querySelectorAll('div.space-y-2\\.5')).map((group) => Array.from(group.querySelectorAll('h3')).map((h3) => h3.textContent));
const groupCounts = () =>
  Array.from(portal().querySelectorAll('div.space-y-2\\.5')).map((group) => group.firstElementChild?.querySelector('span')?.textContent);
const badges = () => Array.from(portal().querySelectorAll('span.inline-flex')).map((span) => span.textContent);
const card = (label: string) =>
  Array.from(portal().querySelectorAll('h3')).find((h3) => h3.textContent === label)!.closest('div[class*="cursor-pointer"]') as HTMLElement;
const columns = () => /grid-cols-(\d)/.exec(portal().querySelector('div.grid')?.className ?? '')?.[1];
const panelText = (id: string) => within(portal()).queryByTestId(`panel-${id}`)?.textContent ?? null;

function mount(props: Partial<DebugPanelHostProps> = {}) {
  const onClose = vi.fn();
  const view = render(<Host visible onClose={onClose} {...props} />);
  return { ...view, onClose, rerender: (next: Partial<DebugPanelHostProps>) => view.rerender(<Host visible onClose={onClose} {...props} {...next} />) };
}

describe('Analysis Panel host frame (evidence before the split)', () => {
  it('opens at the stored position and size, falls back for missing or malformed values, and clamps to the viewport', () => {
    // Nothing stored: 12/12, width min(720, 92% of the viewport), height half of it.
    mount();
    expect(frame()).toEqual(box(12, 12, 720, 400));
    cleanup();

    // Stored values outside the viewport: x at most width-120, y at least 0, width at least 360, height at most height-24.
    localStorage.setItem('DSTU_DBG_POS', JSON.stringify({ x: 5000, y: -30 }));
    localStorage.setItem('DSTU_DBG_SIZE', JSON.stringify({ w: 100, h: 5000 }));
    mount();
    expect(frame()).toEqual(box(1160, 0, 360, 776));
    cleanup();

    // Wrong types and broken JSON fall back to the defaults.
    localStorage.setItem('DSTU_DBG_POS', JSON.stringify({ x: '1', y: 2 }));
    localStorage.setItem('DSTU_DBG_SIZE', 'not json');
    mount();
    expect(frame()).toEqual(box(12, 12, 720, 400));
    cleanup();
    localStorage.clear();

    // Phone width: the minimum width gives way to viewport-16 (304), and the default width is raised to it.
    viewport(320, 480);
    mount();
    expect(frame()).toEqual(box(12, 12, 304, 240));
    cleanup();

    // Tiny viewport: minimum width 240 and height 220 even beyond the viewport.
    viewport(200, 150);
    mount();
    expect(frame()).toEqual(box(12, 12, 240, 220));
  });

  it('clamps again on window resize without writing the clamped frame back', () => {
    localStorage.setItem('DSTU_DBG_POS', JSON.stringify({ x: 1000, y: 600 }));
    localStorage.setItem('DSTU_DBG_SIZE', JSON.stringify({ w: 700, h: 500 }));
    mount();
    expect(frame()).toEqual(box(1000, 600, 700, 500));

    viewport(900, 600);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(frame()).toEqual(box(780, 520, 700, 500));

    viewport(600, 500);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(frame()).toEqual(box(480, 420, 576, 476));
    expect([stored('DSTU_DBG_POS'), stored('DSTU_DBG_SIZE')]).toEqual(['{"x":1000,"y":600}', '{"w":700,"h":500}']);
  });

  it('drags by the header and resizes by the corner, with the primary button or touch, saving on release only', () => {
    mount();
    expect(frame()).toEqual(box(12, 12, 720, 400));

    // A secondary mouse button, or a press on the title-bar buttons, does not start a drag.
    pointer(header(), 'pointerdown', { x: 100, y: 30, button: 2 });
    pointer(window, 'pointermove', { x: 400, y: 300 });
    pointer(within(header()).getByText('调试首页'), 'pointerdown', { x: 100, y: 30 });
    pointer(window, 'pointermove', { x: 400, y: 300 });
    pointer(rightButtons()[0], 'pointerdown', { x: 100, y: 30 });
    pointer(window, 'pointermove', { x: 400, y: 300 });
    expect(frame()).toEqual(box(12, 12, 720, 400));

    // The grab offset is kept; the frame never goes above or left of 0; the position is saved on pointerup.
    pointer(header(), 'pointerdown', { x: 100, y: 30 });
    pointer(window, 'pointermove', { x: 400, y: 300 });
    expect(frame()).toEqual(box(312, 282, 720, 400));
    expect(stored('DSTU_DBG_POS')).toBeNull();
    pointer(window, 'pointermove', { x: 50, y: 5 });
    expect(frame()).toEqual(box(0, 0, 720, 400));
    pointer(window, 'pointerup');
    expect(stored('DSTU_DBG_POS')).toBe('{"x":0,"y":0}');
    pointer(window, 'pointermove', { x: 500, y: 500 });
    expect(frame()).toEqual(box(0, 0, 720, 400));

    // Touch drags too; pointercancel ends and saves like pointerup.
    pointer(header(), 'pointerdown', { x: 10, y: 10, pointerType: 'touch' });
    pointer(window, 'pointermove', { x: 210, y: 110 });
    pointer(window, 'pointercancel');
    expect(stored('DSTU_DBG_POS')).toBe('{"x":200,"y":100}');
    expect(frame()).toEqual(box(200, 100, 720, 400));

    // Resize: a secondary button does nothing; the corner adds the pointer delta, at least 360 x 240, no maximum.
    pointer(resizeHandle()!, 'pointerdown', { x: 900, y: 500, button: 2 });
    pointer(window, 'pointermove', { x: 1000, y: 650 });
    expect(frame()).toEqual(box(200, 100, 720, 400));
    expect(columns()).toBe('2');
    pointer(resizeHandle()!, 'pointerdown', { x: 900, y: 500 });
    pointer(window, 'pointermove', { x: 1000, y: 650 });
    expect(frame()).toEqual(box(200, 100, 820, 550));
    pointer(window, 'pointermove', { x: 100, y: 100 });
    expect(frame()).toEqual(box(200, 100, 360, 240));
    expect(columns()).toBe('1');
    expect(stored('DSTU_DBG_SIZE')).toBeNull();
    pointer(window, 'pointermove', { x: 1400, y: 700 });
    expect(frame()).toEqual(box(200, 100, 1220, 600));
    expect(columns()).toBe('3');
    pointer(window, 'pointerup');
    expect(stored('DSTU_DBG_SIZE')).toBe('{"w":1220,"h":600}');
    expect(stored('DSTU_DBG_POS')).toBe('{"x":200,"y":100}');

    // Grid columns follow the panel width: 680 and 1100 are the steps.
    pointer(resizeHandle()!, 'pointerdown', { x: 0, y: 0 });
    pointer(window, 'pointermove', { x: -541, y: 0 });
    expect([frame().width, columns()]).toEqual(['679px', '1']);
    pointer(window, 'pointermove', { x: -540, y: 0 });
    expect([frame().width, columns()]).toEqual(['680px', '2']);
    pointer(window, 'pointermove', { x: -121, y: 0 });
    expect([frame().width, columns()]).toEqual(['1099px', '2']);
    pointer(window, 'pointermove', { x: -120, y: 0 });
    expect([frame().width, columns()]).toEqual(['1100px', '3']);
    pointer(window, 'pointerup');
    expect(stored('DSTU_DBG_SIZE')).toBe('{"w":1100,"h":600}');
  });

  it('resets on double-click without saving, collapses to the header, and double-click or expand restores it', () => {
    localStorage.setItem('DSTU_DBG_POS', JSON.stringify({ x: 200, y: 100 }));
    localStorage.setItem('DSTU_DBG_SIZE', JSON.stringify({ w: 900, h: 600 }));
    mount();
    expect(frame()).toEqual(box(200, 100, 900, 600));

    fireEvent.doubleClick(header());
    expect(frame()).toEqual(box(12, 12, 720, 400));
    expect([stored('DSTU_DBG_POS'), stored('DSTU_DBG_SIZE')]).toEqual(['{"x":200,"y":100}', '{"w":900,"h":600}']);

    pointer(header(), 'pointerdown', { x: 20, y: 20 });
    pointer(window, 'pointermove', { x: 308, y: 208 });
    pointer(window, 'pointerup');
    expect(frame()).toEqual(box(300, 200, 720, 400));

    // The test i18n mock returns a string default ahead of the bundle: `t('debug_panel.close', '关闭')` gives 关闭.
    expect(rightButtons().map((button) => button.getAttribute('title'))).toEqual([
      '日志输出已关闭，点击开启', '样式调试已关闭，点击开启', '最小化', '关闭',
    ]);
    fireEvent.click(rightButtons()[2]);
    expect(frame()).toEqual({ left: '300px', top: '200px', width: 'auto', height: 'auto' });
    expect(rightButtons().map((button) => button.getAttribute('title'))).toEqual(['展开', '关闭']);
    expect(header().children[0].textContent).toBe('Analysis Panel');
    expect(resizeHandle()).toBeNull();
    expect(portal().querySelector('input')).toBeNull();

    // Double-click on the collapsed header only expands; the position stays.
    fireEvent.doubleClick(header());
    expect(frame()).toEqual(box(300, 200, 720, 400));
    expect(resizeHandle()).not.toBeNull();

    fireEvent.click(rightButtons()[2]);
    fireEvent.click(rightButtons()[0]);
    expect(frame()).toEqual(box(300, 200, 720, 400));
  });

  it('groups the home cards with favourites first, persists favourites, and searches label and description', () => {
    localStorage.setItem('DSTU_DEBUG_FAVORITES', JSON.stringify(['p-zeta', 3, null]));
    localStorage.setItem('DSTU_DEBUG_ACTIVATED', JSON.stringify({ 'p-chat': true }));
    mount();

    // Group order is the host's; inside a group favourites first, then by label (locale order: alpha < Mid < Zeta).
    // A panel in an unknown group has no card but is still counted in the result badge.
    expect(groups()).toEqual([['Chat trace'], ['Zeta tools', 'alpha probe', 'Mid monitor']]);
    expect(groupCounts()).toEqual(['本组 1 个', '本组 3 个']);
    expect(badges()).toEqual(['结果：5 个', '已收藏：1 个']);
    expect(within(card('Zeta tools')).getByLabelText('取消收藏').textContent).toBe('★');
    expect(within(card('Mid monitor')).getByLabelText('收藏').textContent).toBe('☆');
    expect(within(card('Zeta tools')).getByText('已收藏')).toBeTruthy();
    expect(within(portal()).queryByText('已激活')).toBeNull();

    // The star and the favourite button toggle without opening the card.
    fireEvent.click(within(card('Mid monitor')).getByLabelText('收藏'));
    expect(groups()[1]).toEqual(['Mid monitor', 'Zeta tools', 'alpha probe']);
    expect(stored('DSTU_DEBUG_FAVORITES')).toBe('["p-zeta","p-mid"]');
    expect(badges()).toEqual(['结果：5 个', '已收藏：2 个']);
    fireEvent.click(within(card('Zeta tools')).getByText('已收藏'));
    expect(groups()[1]).toEqual(['Mid monitor', 'alpha probe', 'Zeta tools']);
    expect(stored('DSTU_DEBUG_FAVORITES')).toBe('["p-mid"]');
    expect(stored('DSTU_DEBUG_ACTIVATED')).toBe('{"p-chat":true}');
    expect(h.log).toEqual([]);

    // Search: trimmed, case-insensitive, over label and description.
    const input = portal().querySelector('input')!;
    fireEvent.change(input, { target: { value: 'ZETA' } });
    expect(groups()).toEqual([['Mid monitor', 'Zeta tools']]);
    expect(badges()).toEqual(['结果：2 个', '已收藏：1 个']);
    fireEvent.change(input, { target: { value: '  network ' } });
    expect(groups()).toEqual([['alpha probe']]);
    fireEvent.change(input, { target: { value: 'hidden' } });
    expect(groups()).toEqual([]);
    expect(badges()).toEqual(['结果：1 个', '已收藏：1 个']);
    expect(within(portal()).getByText('未找到匹配的插件')).toBeTruthy();
    fireEvent.click(within(portal()).getByLabelText('清空搜索'));
    expect(input.value).toBe('');
    expect(groups()).toEqual([['Chat trace'], ['Mid monitor', 'alpha probe', 'Zeta tools']]);
  });

  it('persists activation, keeps activated panels mounted but hidden behind the open one, and unmounts them on home', () => {
    master.enable();
    mount();

    fireEvent.click(within(card('Chat trace')).getByText('打开'));
    expect(panelText('p-chat')).toBe('p-chat visible=true active=true activated=true');
    expect(stored('DSTU_DEBUG_ACTIVATED')).toBe('["p-chat"]');
    expect(portal().querySelectorAll('h3')).toHaveLength(0);

    fireEvent.click(within(header()).getByText('调试首页'));
    expect(h.log).toEqual(['mount p-chat', 'unmount p-chat']);
    expect(within(card('Chat trace')).getByText('已激活')).toBeTruthy();
    expect(within(card('alpha probe')).queryByText('已激活')).toBeNull();

    // A click anywhere on the card opens it too.
    fireEvent.click(card('alpha probe'));
    expect(panelText('p-alpha')).toBe('p-alpha visible=true active=true activated=true');
    expect(panelText('p-chat')).toBe('p-chat visible=false active=false activated=true');
    expect(within(portal()).getByTestId('panel-p-chat').parentElement!.className).toContain('hidden');
    expect(stored('DSTU_DEBUG_ACTIVATED')).toBe('["p-chat","p-alpha"]');
    expect(panelText('p-zeta')).toBeNull();
    expect(h.log).toEqual(['mount p-chat', 'unmount p-chat', 'mount p-alpha', 'mount p-chat']);
    cleanup();

    // Malformed activation storage starts empty.
    localStorage.setItem('DSTU_DEBUG_ACTIVATED', 'oops');
    mount();
    expect(within(portal()).queryByText('已激活')).toBeNull();
  });

  it('opens the panel named by ?debug-plugin= ahead of DSTU_DEBUG_PLUGIN, even outside every home group', () => {
    master.enable();
    window.history.replaceState(null, '', '/?debug-plugin=p-hidden');
    localStorage.setItem('DSTU_DEBUG_PLUGIN', 'p-chat');
    mount();
    expect(panelText('p-hidden')).toBe('p-hidden visible=true active=true activated=true');
    expect(panelText('p-chat')).toBeNull();
    expect(stored('DSTU_DEBUG_PLUGIN')).toBeNull();
    expect(stored('DSTU_DEBUG_ACTIVATED')).toBe('["p-hidden"]');
  });

  it('ignores a request for home, and waits once for a requested panel that is announced later', () => {
    master.enable();
    localStorage.setItem('DSTU_DEBUG_PLUGIN', 'home');
    mount();
    expect(portal().querySelectorAll('h3')).toHaveLength(4);
    expect(stored('DSTU_DEBUG_PLUGIN')).toBe('home');
    cleanup();

    localStorage.setItem('DSTU_DEBUG_PLUGIN', 'p-late');
    mount();
    expect(portal().querySelectorAll('h3')).toHaveLength(4);
    expect(stored('DSTU_DEBUG_PLUGIN')).toBe('p-late');
    act(() => api.debugPanelContributions.announce(panel('p-late', 'infra-quality', 'Late panel', 'Arrives after the host')));
    expect(panelText('p-late')).toBe('p-late visible=true active=true activated=true');
    expect(stored('DSTU_DEBUG_PLUGIN')).toBeNull();

    // Handled once: a later request and a later panel do not switch away from home.
    fireEvent.click(within(header()).getByText('调试首页'));
    localStorage.setItem('DSTU_DEBUG_PLUGIN', 'p-later');
    act(() => api.debugPanelContributions.announce(panel('p-later', 'infra-quality', 'Later panel', 'Arrives last')));
    expect(panelText('p-later')).toBeNull();
    expect(groups()[1]).toEqual(['alpha probe', 'Late panel', 'Later panel', 'Mid monitor', 'Zeta tools']);
    expect(stored('DSTU_DEBUG_PLUGIN')).toBe('p-later');
  });

  it('renders no panel while the master switch is off, stays mounted while hidden, and owns its portal element', () => {
    expect(document.getElementById('dstu-debugger-portal')).toBeNull();
    master.enable();
    const view = mount();
    expect(portal().parentElement).toBe(document.body);
    expect(portal().getAttribute('style')).toBe('position: relative; z-index: 2147483647;');

    fireEvent.click(within(card('Chat trace')).getByText('打开'));
    view.rerender({ visible: false });
    expect(root().style.display).toBe('none');
    expect(panelText('p-chat')).toBe('p-chat visible=false active=true activated=true');
    view.rerender({ visible: true, currentStreamId: 's-1' });
    expect(root().style.display).toBe('block');
    expect(h.log).toEqual(['mount p-chat']);

    expect(rightButtons()[0].textContent).toBe('日志开');
    fireEvent.click(rightButtons()[0]);
    expect(master.isEnabled()).toBe(false);
    expect(rightButtons()[0].textContent).toBe('日志关');
    expect(panelText('p-chat')).toBeNull();
    expect(h.log).toEqual(['mount p-chat', 'unmount p-chat']);
    fireEvent.click(within(header()).getByText('调试首页'));
    expect(within(portal()).getByText(/调试总开关已关闭/)).toBeTruthy();

    fireEvent.click(rightButtons()[0]);
    expect(master.isEnabled()).toBe(true);
    expect(within(portal()).queryByText(/调试总开关已关闭/)).toBeNull();

    view.unmount();
    expect(document.getElementById('dstu-debugger-portal')).toBeNull();
  });

  it('title bar: LLM Playground navigates, DevTools toggles (warning when unavailable), UI Lab toggles, close calls onClose', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const view = mount();

    fireEvent.click(within(header()).getByText('LLM Playground'));
    expect(vi.mocked(events.dispatchAppEvent).mock.calls).toEqual([[events.APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'llm-playground' }]]);

    await act(async () => {
      fireEvent.click(within(header()).getByText('DevTools'));
    });
    expect(vi.mocked(devtools.toggleDevtools)).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([['[DebugPanel] DevTools 不可用：当前构建未启用 devtools']]);

    const uiLab = () => [rightButtons()[1].textContent, rightButtons()[1].getAttribute('title')];
    expect(uiLab()).toEqual(['UI Lab 关', '样式调试已关闭，点击开启']);
    fireEvent.click(rightButtons()[1]);
    expect(uiLab()).toEqual(['UI Lab 开', '样式调试已开启，点击关闭']);
    fireEvent.click(rightButtons()[1]);
    expect(uiLab()).toEqual(['UI Lab 关', '样式调试已关闭，点击开启']);

    fireEvent.click(rightButtons()[3]);
    expect(view.onClose).toHaveBeenCalledTimes(1);
  });
});

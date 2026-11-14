/**
 * FE-B7 evidence (dev build): the debug panel inventory as the Analysis Panel shows it.
 * - `debug-panels.json`: every panel in display order with its id, group, label and description, read through the
 *   UI (opening a card records its id), the groups, a search, and the component each panel mounts.
 * - `debug-panels.home.dom.txt`: the home view DOM.
 * Mounted like App: `GlobalDebugPanel` asked to open, inside the production UI assembly.
 */
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeDom } from '../../dom-snapshot';
import { bootAppUi, expectGolden, type AppUi } from './harness';

vi.mock('react-i18next', () => import('./i18nMock'));

const PORTAL = '#dstu-debugger-portal';
const ACTIVATED_KEY = 'DSTU_DEBUG_ACTIVATED';

async function flush(rounds = 5) {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mountPanel(app: AppUi) {
  const { default: GlobalDebugPanel } = await import('@/components/dev/GlobalDebugPanel');
  const view = render(app.wrap(<GlobalDebugPanel openRequest={1} />));
  await flush();
  const portal = document.querySelector(PORTAL);
  expect(portal, 'debug panel portal').not.toBeNull();
  return { view, portal: portal as HTMLElement };
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll('button')).find((el) => el.textContent?.trim() === text);
  if (!button) throw new Error(`button "${text}" not found`);
  return button as HTMLButtonElement;
}

interface Card { label: string; description: string; group: string; element: HTMLElement }

function readCards(portal: HTMLElement): Card[] {
  return Array.from(portal.querySelectorAll('h3')).map((h3) => {
    const element = h3.closest('div[class*="rounded-xl"][class*="cursor-pointer"]') as HTMLElement;
    const groupElement = element.parentElement!.parentElement!;
    return {
      label: h3.textContent ?? '',
      description: element.querySelector('p')?.textContent ?? '',
      group: groupElement.querySelector('div.text-sm')?.textContent ?? '',
      element,
    };
  });
}

function readGroups(portal: HTMLElement) {
  return readCards(portal).reduce<{ label: string; description: string; count: string }[]>((groups, card) => {
    if (groups.at(-1)?.label === card.group) return groups;
    const groupElement = card.element.parentElement!.parentElement!;
    const header = groupElement.firstElementChild!;
    groups.push({ label: card.group, description: header.querySelector('p')?.textContent ?? '', count: header.querySelector('span')?.textContent ?? '' });
    return groups;
  }, []);
}

function activated(): string[] {
  return JSON.parse(localStorage.getItem(ACTIVATED_KEY) ?? '[]') as string[];
}

/** Name of the component mounted for the active panel (React fiber of its keep-alive wrapper). */
function mountedComponentName(portal: HTMLElement): string | null {
  const wrapper = Array.from(portal.querySelectorAll('div')).find((el) => el.className.startsWith('flex-1 flex flex-col overflow-auto') && el.parentElement?.className.includes('overflow-auto'));
  if (!wrapper) return null;
  const fiberKey = Object.keys(wrapper).find((key) => key.startsWith('__reactFiber$'));
  let fiber = fiberKey ? (wrapper as unknown as Record<string, { child?: unknown }>)[fiberKey]?.child as { type?: unknown; child?: unknown } | undefined : undefined;
  while (fiber && typeof fiber.type !== 'function' && typeof fiber.type !== 'object') fiber = fiber.child as typeof fiber;
  const type = fiber?.type as { displayName?: string; name?: string; type?: { name?: string } } | undefined;
  return type ? type.displayName || type.name || type.type?.name || 'anonymous' : null;
}

async function collectPanelIds(portal: HTMLElement): Promise<string[]> {
  const ids: string[] = [];
  const home = buttonByText(portal, '调试首页');
  for (const card of readCards(portal)) {
    const before = activated();
    const current = readCards(portal).find((candidate) => candidate.label === card.label && candidate.group === card.group)!;
    fireEvent.click(buttonByText(current.element, '打开'));
    await flush(1);
    const added = activated().filter((id) => !before.includes(id));
    expect(added, `opening "${card.label}" activates exactly one panel`).toHaveLength(1);
    ids.push(added[0]!);
    fireEvent.click(home);
    await flush(1);
  }
  return ids;
}

/** A panel that throws in jsdom still identifies itself through the component stack. */
class Boundary extends React.Component<{ caught: { stack: string | null }; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(_error: unknown, info: React.ErrorInfo) { this.props.caught.stack = info.componentStack ?? null; }
  render() { return this.state.failed ? null : this.props.children; }
}

function firstFrame(stack: string | null): string | null {
  const match = stack ? /^\s*(?:at\s+)?([A-Z][\w$]*)/m.exec(stack) : null;
  return match ? `${match[1]} (threw in jsdom)` : null;
}

describe('FE-B7 evidence: debug panel inventory (dev build)', () => {
  let app: AppUi;
  beforeEach(async () => {
    localStorage.clear();
    app = await bootAppUi();
  });
  afterEach(async () => {
    cleanup();
    await app.dispose();
    localStorage.clear();
  });

  it('lists every panel with id, group, label and description in display order', async () => {
    const { portal } = await mountPanel(app);
    const homeDom = serializeDom(portal);
    const groups = readGroups(portal);
    const cards = readCards(portal);
    const ids = await collectPanelIds(portal);
    const panels = cards.map((card, index) => ({ id: ids[index]!, group: card.group, label: card.label, description: card.description }));
    const search: Record<string, string[]> = {};
    const input = portal.querySelector('input') as HTMLInputElement;
    for (const query of ['会话', 'Anki', 'crepe', '不存在的面板']) {
      fireEvent.change(input, { target: { value: query } });
      await flush(1);
      search[query] = readCards(portal).map((card) => card.label);
    }
    expect(new Set(panels.map((panel) => panel.id)).size).toBe(panels.length);
    expectGolden('debug-panels.home.dom.txt', homeDom);
    expectGolden('debug-panels.json', { count: panels.length, groups, panels, search });
  }, 60_000);

  it('mounts the same component for each panel', async () => {
    const { portal, view } = await mountPanel(app);
    const ids = await collectPanelIds(portal);
    view.unmount();
    cleanup();
    const { debugMasterSwitch } = await import('@/debug-panel/debugMasterSwitch');
    const components: Record<string, string | null> = {};
    try {
      for (const id of ids) {
        localStorage.clear();
        localStorage.setItem('DSTU_DEBUG_PLUGIN', id);
        const caught: { stack: string | null } = { stack: null };
        const { default: GlobalDebugPanel } = await import('@/components/dev/GlobalDebugPanel');
        const mounted = render(app.wrap(<Boundary caught={caught}><GlobalDebugPanel openRequest={1} /></Boundary>));
        await flush();
        // The panel body only mounts with the master switch on (toggled through the panel's own button).
        const portalNow = document.querySelector(PORTAL) as HTMLElement | null;
        if (portalNow && !debugMasterSwitch.isEnabled()) fireEvent.click(buttonByText(portalNow, '日志关'));
        await flush();
        const portalAfter = document.querySelector(PORTAL) as HTMLElement | null;
        components[id] = (portalAfter && mountedComponentName(portalAfter)) ?? firstFrame(caught.stack);
        mounted.unmount();
        cleanup();
      }
    } finally {
      if (debugMasterSwitch.isEnabled()) debugMasterSwitch.toggle();
    }
    expectGolden('debug-panels.components.json', components);
  }, 120_000);
});

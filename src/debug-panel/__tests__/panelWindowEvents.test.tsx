/**
 * FE-B7: the window events three panels still exchange with the rest of the app.
 * - ChatAnki workflow: other modules dispatch `chatanki-debug-lifecycle` on window directly, so the activated panel
 *   keeps listening for it.
 * - Session load flow: "捕获状态" dispatches one bare `SESSION_LOAD_MANUAL_CAPTURE` window event (no listener in the app).
 * - Unified drag-drop: each quick-jump button (one per known zone, the only callers of the navigation) switches the
 *   tab through `navigate-to-tab` and dispatches nothing else.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { debugMasterSwitch } from '../debugMasterSwitch';

vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard: vi.fn(async () => true) }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

const props = { visible: true, isActive: true, isActivated: true, isActivatedInitially: true, onClose: () => undefined };

beforeAll(() => {
  debugMasterSwitch.enable();
});

afterAll(() => {
  debugMasterSwitch.disable();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function mount(load: () => Promise<{ default: React.ComponentType<any> }>) {
  const { default: Panel } = await load();
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Panel {...props} />);
  });
  return view.container;
}

/** Window events dispatched while `run` executes: type, whether it is a CustomEvent, and its detail. */
async function windowEvents(run: () => void): Promise<unknown[]> {
  const events: unknown[] = [];
  const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation(function record(this: Window, event: Event) {
    events.push([event.type, event instanceof CustomEvent, event instanceof CustomEvent ? event.detail : undefined]);
    return true;
  });
  try {
    await act(async () => {
      run();
    });
  } finally {
    spy.mockRestore();
  }
  return events;
}

describe('debug panel window events (FE-B7)', () => {
  it('ChatAnki workflow: lifecycle events other modules dispatch on window reach the activated panel', async () => {
    const container = await mount(() => import('../plugins/ChatAnkiWorkflowDebugPlugin'));
    await act(async () => {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', {
        detail: { level: 'info', phase: 'bridge:card', summary: 'chatanki-window-event-probe', documentId: 'doc-1' },
      }));
    });
    expect(container.textContent).toContain('chatanki-window-event-probe');
  });

  it('Session load flow: "捕获状态" dispatches one bare SESSION_LOAD_MANUAL_CAPTURE window event', async () => {
    await mount(() => import('../plugins/SessionLoadFlowDebugPlugin'));
    const button = screen.getByRole('button', { name: /捕获状态/ });
    expect(await windowEvents(() => fireEvent.click(button))).toEqual([['SESSION_LOAD_MANUAL_CAPTURE', true, null]]);
  });

  it('Unified drag-drop: every quick-jump button only dispatches navigate-to-tab', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const container = await mount(() => import('../plugins/UnifiedDragDropDebugPlugin'));
    const jumpArea = Array.from(container.querySelectorAll('div')).find((node) => node.firstElementChild?.textContent?.includes('快速跳转到拖拽区域'));
    if (!jumpArea) throw new Error('quick-jump area not rendered');
    const buttons = within(jumpArea).getAllByRole('button');
    const clicks = [];
    for (const button of buttons) {
      clicks.push([button.getAttribute('title'), await windowEvents(() => fireEvent.click(button))]);
    }
    expect(clicks).toEqual([
      ['点击跳转到 Anki 卡片生成', [['navigate-to-tab', true, { tabName: 'anki' }]]],
      ['点击跳转到 聊天输入框（对话中）', [['navigate-to-tab', true, { tabName: 'analysis' }]]],
      ['点击跳转到 聊天输入框（首页）', [['navigate-to-tab', true, { tabName: 'analysis' }]]],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });
});

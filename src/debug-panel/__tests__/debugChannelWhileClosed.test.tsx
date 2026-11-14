/**
 * RF-W19-debug-channel-records-while-closed: the template designer and ChatAnki panels used to hear their reporters only
 * through `window` listeners mounted while the panel is activated (Tauri snapshot 21c9d808), so a report sent before the
 * panel module loaded or while the panel was closed was lost. Over their debug channels the panel module records the
 * report itself: queued ones are replayed when the module starts serving, ones sent while the panel is closed are on the
 * list when it opens, and the debug master switch drops them while it is off. Each case also sends the same report as
 * a window event while the panel is closed, which is still lost as in Tauri.
 */
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard: vi.fn(async () => true) }));

const RF = 'RF-W19-debug-channel-records-while-closed';
const MASTER_SWITCH_KEY = 'DSTU_DEBUG_MASTER_SWITCH';
const START = new Date(2026, 10, 7, 10, 0, 0, 0);

type PanelComponent = React.ComponentType<{ visible: boolean; isActive: boolean; isActivated: boolean; onClose: () => void }>;

async function mount(Panel: PanelComponent, isActivated: boolean) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Panel visible isActive onClose={() => undefined} isActivated={isActivated} />);
  });
  return view;
}

async function open(view: ReturnType<typeof render>, Panel: PanelComponent) {
  await act(async () => {
    view.rerender(<Panel visible isActive onClose={() => undefined} isActivated />);
  });
}

async function step(fn: () => void) {
  await act(async () => {
    fn();
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function templateRows(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.font-mono > div > button')).map((button) =>
    Array.from(button.children)
      .map((el) => el.textContent ?? '')
      .filter(Boolean)
      .join(' '),
  );
}

beforeEach(() => {
  vi.resetModules();
  localStorage.setItem(MASTER_SWITCH_KEY, 'true');
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.removeItem(MASTER_SWITCH_KEY);
});

describe(RF, () => {
  it(`${RF}: template designer lists a call reported while closed when it opens and warns on the first scan if it is past its timeout`, async () => {
    const Panel = (await import('../plugins/TemplateDesignerWorkflowDebugPlugin')).default as PanelComponent;
    const channel = await import('@/shared/debug/channels/templateDesigner');
    const viaWindow = await import('@/features/chat/debug/templateDesignerDebug');
    const view = await mount(Panel, false);
    await step(() => {
      viaWindow.emitTemplateDesignerToolEvent({ type: 'mcp_tool', phase: 'start', toolName: 'template_update', blockId: 'blk-window', payload: { toolCallId: 'call-window' } });
      channel.emitTemplateDesignerToolEvent({ type: 'mcp_tool', phase: 'start', toolName: 'template_update', blockId: 'blk-open', payload: { toolCallId: 'call-open' } });
      channel.emitTemplateDesignerToolEvent({ type: 'mcp_tool', phase: 'start', toolName: 'template_get', blockId: 'blk-done', payload: { toolCallId: 'call-done' } });
    });
    await advance(5_000);
    await step(() =>
      channel.emitTemplateDesignerToolEvent({ type: 'mcp_tool', phase: 'end', toolName: 'template_get', blockId: 'blk-done', toolOutput: { status: 'ok' }, payload: { toolCallId: 'call-done' } }),
    );
    await advance(65_000);
    await open(view, Panel);
    expect(templateRows(view.container)).toEqual([
      '10:00:00.000 [info] [tool:update] → template_update [preparing] block=blk-open',
      '10:00:00.000 [info] [tool:get] → template_get [preparing] block=blk-done',
      '10:00:05.000 [info] [tool:get] ← template_get | status=ok block=blk-done',
      '10:01:10.000 [info] [system] 模板设计师监听插件已激活',
    ]);
    // The scan starts with the panel; its first tick sees call-open at its real age (first seen at t = 0).
    await advance(1_000);
    expect(templateRows(view.container).slice(4)).toEqual([
      '10:01:11.000 [warn] [tool:update] ⚠️ template_update 执行超时 71s（疑似缺少 end/error） block=blk-open',
    ]);
    await advance(60_000);
    expect(templateRows(view.container)).toHaveLength(5);
  });

  it(`${RF}: ChatAnki lists lifecycle reports sent before its module loads or while it is closed, and drops them while the master switch is off`, async () => {
    const channel = await import('@/shared/debug/channels/chatAnki');
    channel.emitChatAnkiLifecycle({ level: 'info', phase: 'system', summary: 'rf-chatanki-before-load' });
    await advance(1_000);
    const Panel = (await import('../plugins/ChatAnkiWorkflowDebugPlugin')).default as PanelComponent;
    const { debugMasterSwitch } = await import('../debugMasterSwitch');
    const view = await mount(Panel, false);
    expect(view.container.innerHTML).toBe('');
    await step(() => {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: { level: 'info', phase: 'system', summary: 'rf-chatanki-window-while-closed' } }));
      channel.emitChatAnkiLifecycle({ level: 'warn', phase: 'render:ui-source-check', summary: 'rf-chatanki-channel-while-closed', blockId: 'blk-c' });
      debugMasterSwitch.disable();
      channel.emitChatAnkiLifecycle({ level: 'info', phase: 'system', summary: 'rf-chatanki-while-switch-off' });
      debugMasterSwitch.enable();
    });
    await open(view, Panel);
    const text = view.container.textContent ?? '';
    const shown = ['rf-chatanki-before-load', 'rf-chatanki-window-while-closed', 'rf-chatanki-channel-while-closed', 'rf-chatanki-while-switch-off']
      .filter((summary) => text.includes(summary));
    expect(shown).toEqual(['rf-chatanki-before-load', 'rf-chatanki-channel-while-closed']);
    expect(text.indexOf('rf-chatanki-before-load')).toBeLessThan(text.indexOf('rf-chatanki-channel-while-closed'));
    await step(() => {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: { level: 'info', phase: 'system', summary: 'rf-chatanki-window-while-open' } }));
    });
    expect(view.container.textContent).toContain('rf-chatanki-window-while-open');
  });
});

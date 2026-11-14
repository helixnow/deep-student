/**
 * FE-B7: template designer reports reach TemplateDesignerWorkflowDebugPlugin over the `template-designer` debug channel.
 * Through the channel the panel module records them itself: emits made before the module loads are replayed when it
 * starts serving, and reports that arrive while the panel is closed are on the list when it opens (like
 * `emitChatAnkiLifecycle`). The debug master switch still gates them, and production builds drop them.
 */
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard: vi.fn(async () => true) }));

type Reporter = {
  emitTemplateDesignerToolEvent: typeof import('@/shared/debug/channels/templateDesigner').emitTemplateDesignerToolEvent;
  emitTemplateDesignerLifecycle: typeof import('@/shared/debug/channels/templateDesigner').emitTemplateDesignerLifecycle;
};
type PanelComponent = React.ComponentType<{ visible: boolean; isActive: boolean; isActivated: boolean; onClose: () => void }>;

const MASTER_SWITCH_KEY = 'DSTU_DEBUG_MASTER_SWITCH';
const START = new Date(2026, 10, 7, 10, 0, 0, 0);

async function loadPanel(): Promise<PanelComponent> {
  return (await import('../plugins/TemplateDesignerWorkflowDebugPlugin')).default as PanelComponent;
}

async function mount(Panel: PanelComponent, isActivated = true) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Panel visible isActive onClose={() => undefined} isActivated={isActivated} />);
  });
  return view;
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

function rows(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.font-mono > div > button')).map((button) =>
    Array.from(button.children)
      .map((el) => el.textContent ?? '')
      .filter(Boolean)
      .join(' '),
  );
}

/** A round with every kind of row and in-flight record; the clock moves between reports. */
function sendRound({ emitTemplateDesignerToolEvent: tool, emitTemplateDesignerLifecycle: lifecycle }: Reporter) {
  const tick = () => vi.advanceTimersByTime(41);
  lifecycle({ level: 'info', phase: 'block:state', summary: 'tool=template_get status=running', blockId: 'blk-get', detail: { status: 'running' } });
  tick();
  tool({ type: 'mcp_tool', phase: 'start', toolName: 'builtin-web_search', blockId: 'blk-other' });
  tool({ type: 'mcp_tool', phase: 'start', toolName: 'builtin-template_get', blockId: 'blk-get', toolInput: { templateId: 'tpl-1' }, payload: { toolCallId: 'call-get' } });
  tick();
  tool({ type: 'mcp_tool', phase: 'end', toolName: 'builtin-template_get', blockId: 'blk-get', toolOutput: { status: 'ok' }, result: { status: 'ok' }, payload: { toolCallId: 'call-get' } });
  tick();
  tool({ type: 'tool_approval_request', toolName: 'template_delete', blockId: 'approval_call-del', payload: { timeoutSeconds: 5 } });
  tool({ type: 'tool_call_preparing', toolName: 'template_create', blockId: 'blk-new', payload: { toolCallId: 'call-new' } });
  tool({ type: 'mcp_tool', phase: 'start', toolName: 'template_update', blockId: 'blk-upd', toolInput: { template_id: 'tpl-2', patch: { expectedVersion: 'v3' } }, payload: { toolCallId: 'call-upd' } });
  tick();
  tool({ type: 'mcp_tool', phase: 'error', toolName: 'template_fork', blockId: 'blk-fork', error: 'conflict' });
  lifecycle({ detail: { partial: true } } as never);
  lifecycle({ level: 'warn', phase: 'render:template', summary: 'render template output', templateId: 'tpl-7' });
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  localStorage.setItem(MASTER_SWITCH_KEY, 'true');
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  localStorage.removeItem(MASTER_SWITCH_KEY);
});

describe('template designer debug channel (FE-B7)', () => {
  it('renders the same rows and in-flight warnings as the window events', async () => {
    const run = async (reporter: () => Promise<Reporter>) => {
      vi.resetModules();
      vi.setSystemTime(START);
      const Panel = await loadPanel();
      const send = await reporter();
      const { container } = await mount(Panel);
      await step(() => sendRound(send));
      await advance(61_000);
      return rows(container);
    };
    const viaWindow = await run(() => import('@/features/chat/debug/templateDesignerDebug'));
    const viaChannel = await run(() => import('@/shared/debug/channels/templateDesigner'));
    expect(viaChannel).toEqual(viaWindow);
    expect(viaChannel.filter((row) => row.includes(' ⚠️ ')).map((row) => row.split(' ⚠️ ')[1]!.split(' ')[1])).toEqual([
      '进入审批，等待用户确认',
      '审批等待超时',
      'preparing',
      '执行超时',
    ]);
  });

  it('replays reports sent before the panel module loads, in-flight calls included', async () => {
    const channel = await import('@/shared/debug/channels/templateDesigner');
    channel.emitTemplateDesignerLifecycle({ level: 'info', phase: 'system', summary: 'queued-before-load' });
    channel.emitTemplateDesignerToolEvent({ type: 'tool_call_preparing', toolName: 'template_create', blockId: 'blk-q', payload: { toolCallId: 'call-q' } });
    await advance(3_000);
    const Panel = await loadPanel();
    await advance(1_000);
    const { container } = await mount(Panel);
    expect(rows(container)).toEqual([
      '10:00:03.000 [info] [system] queued-before-load',
      '10:00:03.000 [info] [tool:create] → template_create [preparing] block=blk-q',
      '10:00:04.000 [info] [system] 模板设计师监听插件已激活',
    ]);
    // First seen at the replay (t = 3 s); the interval starts with the panel (t = 4 s) and warns once age > 20 s.
    await advance(21_000);
    expect(rows(container).at(-1)).toBe(
      '10:00:24.000 [warn] [tool:create] ⚠️ template_create preparing 超时 21s（疑似未进入 tool_call） block=blk-q',
    );
  });

  it('keeps reports that arrive while the panel is closed and shows them when it opens', async () => {
    const Panel = await loadPanel();
    const { emitTemplateDesignerLifecycle, emitTemplateDesignerToolEvent } = await import('@/shared/debug/channels/templateDesigner');
    const view = await mount(Panel, false);
    expect(view.container.innerHTML).toBe('');
    await step(() => {
      emitTemplateDesignerLifecycle({ level: 'info', phase: 'render:template', summary: 'while-closed', templateId: 'tpl-c' });
      emitTemplateDesignerToolEvent({ type: 'mcp_tool', phase: 'end', toolName: 'template_list', blockId: 'blk-c', toolOutput: { status: 'ok' } });
    });
    await advance(500);
    await act(async () => {
      view.rerender(<Panel visible isActive onClose={() => undefined} isActivated />);
    });
    expect(rows(view.container)).toEqual([
      '10:00:00.000 [info] [render:template] while-closed template=tpl-c',
      '10:00:00.000 [info] [tool:list] ← template_list | status=ok block=blk-c',
      '10:00:00.500 [info] [system] 模板设计师监听插件已激活',
    ]);
  });

  it('drops channel reports while the debug master switch is off, queued ones included', async () => {
    localStorage.setItem(MASTER_SWITCH_KEY, 'false');
    const channel = await import('@/shared/debug/channels/templateDesigner');
    channel.emitTemplateDesignerLifecycle({ level: 'info', phase: 'system', summary: 'queued-while-off' });
    const Panel = await loadPanel();
    const { debugMasterSwitch } = await import('../debugMasterSwitch');
    channel.emitTemplateDesignerLifecycle({ level: 'info', phase: 'system', summary: 'served-while-off' });
    channel.emitTemplateDesignerToolEvent({ type: 'mcp_tool', phase: 'start', toolName: 'template_get', payload: { toolCallId: 'call-off' } });
    debugMasterSwitch.enable();
    channel.emitTemplateDesignerLifecycle({ level: 'info', phase: 'system', summary: 'after-enable' });
    const { container } = await mount(Panel);
    await advance(61_000);
    expect(rows(container)).toEqual([
      '10:00:00.000 [info] [system] after-enable',
      '10:00:00.000 [info] [system] 模板设计师监听插件已激活',
    ]);
  });

  it('is a no-op in production builds', async () => {
    vi.stubEnv('DEV', false);
    const channel = await import('@/shared/debug/channels/templateDesigner');
    channel.emitTemplateDesignerLifecycle({ level: 'info', phase: 'system', summary: 'production-report' });
    const Panel = await loadPanel();
    channel.emitTemplateDesignerToolEvent({ type: 'mcp_tool', phase: 'end', toolName: 'template_get', toolOutput: { status: 'ok' } });
    const { container } = await mount(Panel);
    expect(rows(container)).toEqual(['10:00:00.000 [info] [system] 模板设计师监听插件已激活']);
  });
});

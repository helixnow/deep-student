/**
 * FE-B7 evidence for the template designer workflow panel, recorded before its reception moved to a module-level
 * debug channel. Reports arrive the way the chat lane sends them today (`emitTemplateDesignerToolEvent` /
 * `emitTemplateDesignerLifecycle`), and the goldens hold what the panel shows: the rows (time, level, phase, summary,
 * template / block tags), the expanded detail, the copied log text, and the in-flight tracking as it surfaces through
 * the timeout warnings. Every case loads a fresh panel module under a fake clock pinned to a local wall time.
 */
import fs from 'node:fs';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { copied } = vi.hoisted(() => ({ copied: [] as string[] }));

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn(async (text: string) => {
    copied.push(text);
    return true;
  }),
}));

const GOLDEN_DIR = 'src/debug-panel/__tests__/__golden__';
const CAPTURE = process.env.FE_B7_CAPTURE_GOLDEN === '1';

function golden(name: string, current: string): string {
  const file = `${GOLDEN_DIR}/${name}`;
  if (CAPTURE && !fs.existsSync(file)) fs.writeFileSync(file, current);
  return fs.readFileSync(file, 'utf8');
}

type Sender = typeof import('@/features/chat/debug/templateDesignerDebug');
type PanelProps = { isActivated: boolean };

const baseProps = { visible: true, isActive: true, onClose: () => undefined };

async function load(): Promise<{ Panel: React.ComponentType<PanelProps & typeof baseProps>; sender: Sender }> {
  vi.resetModules();
  const { default: Panel } = await import('../plugins/TemplateDesignerWorkflowDebugPlugin');
  const sender = await import('@/features/chat/debug/templateDesignerDebug');
  return { Panel: Panel as never, sender };
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

/** What the panel shows: the counter line and, per row, the button's parts (an svg caret reads as '>'), plus the expanded detail. */
function readPanel(container: HTMLElement) {
  const counter = Array.from(container.querySelectorAll('div')).find(
    (el) => el.children.length === 0 && el.textContent?.startsWith('日志 '),
  )?.textContent;
  const rows = Array.from(container.querySelectorAll('.font-mono > div')).map((row) => {
    const button = row.querySelector('button')!;
    const parts = Array.from(button.children).map((el) => (el.tagName.toLowerCase() === 'svg' ? '>' : el.textContent ?? ''));
    const pre = row.querySelector('pre');
    return pre ? { parts, expanded: pre.textContent } : { parts };
  });
  return { counter, rows };
}

function rowButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.font-mono > div > button'));
}

/** The reports a template designer round produces, in the shapes blockEvents / mcpTool / TemplateToolOutput send. */
function sendRound(sender: Sender) {
  const lifecycle = (detail: Parameters<Sender['emitTemplateDesignerLifecycle']>[0]) => {
    vi.advanceTimersByTime(37);
    sender.emitTemplateDesignerLifecycle(detail);
  };
  const tool = (detail: Parameters<Sender['emitTemplateDesignerToolEvent']>[0]) => {
    vi.advanceTimersByTime(37);
    sender.emitTemplateDesignerToolEvent(detail);
  };
  lifecycle({
    level: 'info',
    phase: 'block:state',
    summary: 'tool=template_get status=running',
    detail: { toolName: 'builtin-template_get', status: 'running', hasInput: true, hasOutput: false },
    blockId: 'blk-td-get-0001',
  });
  lifecycle({ detail: { partial: true } } as never);
  lifecycle(undefined as never);
  tool({ type: 'mcp_tool', phase: 'start', toolName: 'builtin-web_search', blockId: 'blk-other', toolInput: { query: 'x' } });
  tool({
    type: 'mcp_tool',
    phase: 'start',
    toolName: 'builtin-template_get',
    blockId: 'blk-td-get-0001',
    toolInput: { templateId: 'tpl-1' },
    payload: { toolCallId: 'call-get', toolInput: { templateId: 'tpl-1' } },
  });
  tool({
    type: 'mcp_tool',
    phase: 'end',
    toolName: 'builtin-template_get',
    blockId: 'blk-td-get-0001',
    toolOutput: { status: 'ok', templateId: 'tpl-1' },
    result: { status: 'ok', templateId: 'tpl-1' },
    payload: { toolCallId: 'call-get' },
  });
  tool({
    type: 'mcp_tool',
    phase: 'start',
    toolName: 'mcp_template_update',
    blockId: 'blk-td-upd-0002',
    toolInput: { template_id: 'tpl-2', patch: { expectedVersion: 'v3' } },
  });
  tool({ type: 'mcp_tool', phase: 'error', toolName: 'mcp_template_update', blockId: 'blk-td-upd-0002', error: 'version conflict' });
  tool({
    type: 'tool_approval_request',
    phase: 'start',
    toolName: 'builtin.template_delete',
    blockId: 'approval_call-del',
    toolInput: { templateId: 'tpl-3' },
    payload: { timeoutSeconds: 30 },
  });
  tool({ type: 'tool_call_preparing', toolName: 'tools.template_create', blockId: 'blk-td-new-0003', payload: { toolCallId: 'call-new' } });
  tool({
    type: 'mcp_tool',
    phase: 'end',
    toolName: 'mcp.tools.template_fork',
    blockId: 'blk-td-fork-0004',
    toolOutput: { status: 'created', sourceTemplateId: 'tpl-4' },
    result: { status: 'created', sourceTemplateId: 'tpl-4', extra: 1 },
  });
  tool({ type: 'mcp_tool', phase: 'end', toolName: 'template_preview', blockId: 'blk-td-prev-0005', payload: { usedTemplateId: 'tpl-5' } });
  lifecycle({
    level: 'info',
    phase: 'render:template',
    summary: 'render template output | templateId=tpl-6',
    detail: { templateId: 'tpl-6', hasDiff: false, hasWarnings: true, warningCount: 2 },
    templateId: 'tpl-6',
  });
  lifecycle({ level: 'warn', phase: 'render:template', summary: 'render template output', templateId: 'tpl-7' });
}

beforeEach(() => {
  copied.length = 0;
  vi.useFakeTimers({ now: new Date(2026, 10, 7, 10, 0, 0, 0) });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('template designer workflow panel (FE-B7 evidence)', () => {
  it('shows a template designer round: rows, expanded detail and copied text', async () => {
    const { Panel, sender } = await load();
    let container!: HTMLElement;
    await act(async () => {
      container = render(<Panel {...baseProps} isActivated />).container;
    });
    await step(() => sendRound(sender));
    const shown = readPanel(container);
    const buttons = rowButtons(container);
    for (const index of [4, 5, 9, 10]) await step(() => fireEvent.click(buttons[index]!));
    const expanded = readPanel(container);
    await step(() => fireEvent.click(screen.getByRole('button', { name: /复制/ })));
    const afterCopy = readPanel(container).counter;
    await advance(2000);
    const current = `${JSON.stringify({ shown, expanded, copied, afterCopy, afterCopyCleared: readPanel(container).counter }, null, 2)}\n`;
    expect(current).toBe(golden('template-designer.round.json', current));
  });

  it('tracks in-flight calls: preparing, approval and running timeouts warn once; end / error / block end stop tracking', async () => {
    const { Panel, sender } = await load();
    const tool = sender.emitTemplateDesignerToolEvent;
    let container!: HTMLElement;
    await act(async () => {
      container = render(<Panel {...baseProps} isActivated />).container;
    });
    await step(() => {
      tool({ type: 'tool_call_preparing', toolName: 'template_create', blockId: 'blk-prep', payload: { toolCallId: 'call-prep' } });
      tool({ type: 'tool_approval_request', toolName: 'template_delete', blockId: 'approval_call-appr', payload: { timeoutSeconds: 5 } });
      tool({ type: 'tool_approval_request', toolName: 'template_update', blockId: 'approval_call-appr-default' });
      tool({ type: 'tool_approval_request', toolName: 'template_fork', blockId: 'approval_call-appr-run' });
      tool({ type: 'mcp_tool', phase: 'start', toolName: 'template_get', blockId: 'blk-run', payload: { toolCallId: 'call-run' } });
      tool({ type: 'mcp_tool', phase: 'start', toolName: 'template_list', blockId: 'blk-ended', toolInput: { toolCallId: 'call-ended' } });
      tool({ type: 'mcp_tool', phase: 'start', toolName: 'template_validate', blockId: 'blk-by-block', payload: { toolCallId: 'call-by-block' } });
      tool({ type: 'mcp_tool', phase: 'start', toolName: 'template_preview', blockId: 'blk-untracked' });
      tool({ type: 'mcp_tool', phase: 'start', toolName: 'template_get', blockId: 'blk-err', payload: { toolCallId: 'call-err' } });
    });
    await advance(1000);
    await step(() => {
      tool({ type: 'mcp_tool', phase: 'end', toolName: 'template_list', blockId: 'blk-ended', payload: { toolCallId: 'call-ended' } });
      tool({ type: 'mcp_tool', phase: 'end', toolName: 'template_validate', blockId: 'blk-by-block' });
      tool({ type: 'mcp_tool', phase: 'error', toolName: 'template_get', error: 'boom', payload: { toolCallId: 'call-err' } });
      tool({ type: 'mcp_tool', phase: 'chunk', toolName: 'template_fork', blockId: 'approval_call-appr-run', payload: { toolCallId: 'call-appr-run' } });
    });
    const checkpoints: Record<string, ReturnType<typeof readPanel>> = {};
    for (const at of [6000, 21000, 61000, 120000]) {
      await advance(at - (Date.now() - new Date(2026, 10, 7, 10, 0, 0, 0).getTime()));
      checkpoints[`t+${at / 1000}s`] = readPanel(container);
    }
    const current = `${JSON.stringify(checkpoints, null, 2)}\n`;
    expect(current).toBe(golden('template-designer.inflight.json', current));
  });

  it('stops listening while deactivated, clears in-flight calls, and keeps the log across re-activation', async () => {
    const { Panel, sender } = await load();
    const tool = sender.emitTemplateDesignerToolEvent;
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<Panel {...baseProps} isActivated />);
    });
    await step(() => tool({ type: 'mcp_tool', phase: 'start', toolName: 'template_get', blockId: 'blk-x', payload: { toolCallId: 'call-x' } }));
    await act(async () => {
      view.rerender(<Panel {...baseProps} isActivated={false} />);
    });
    const deactivatedHtml = view.container.innerHTML;
    await step(() => {
      tool({ type: 'mcp_tool', phase: 'start', toolName: 'template_list', blockId: 'blk-while-off', payload: { toolCallId: 'call-off' } });
      sender.emitTemplateDesignerLifecycle({ level: 'info', phase: 'system', summary: 'while deactivated' });
    });
    await advance(1000);
    await act(async () => {
      view.rerender(<Panel {...baseProps} isActivated />);
    });
    const reactivated = readPanel(view.container);
    await advance(61000);
    const current = `${JSON.stringify({ deactivatedHtml, reactivated, after61s: readPanel(view.container) }, null, 2)}\n`;
    expect(current).toBe(golden('template-designer.reactivate.json', current));
  });

  it('renders nothing and records nothing before the first activation', async () => {
    const { Panel, sender } = await load();
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<Panel {...baseProps} isActivated={false} />);
    });
    expect(view.container.innerHTML).toBe('');
    await step(() => sendRound(sender));
    await act(async () => {
      view.rerender(<Panel {...baseProps} isActivated />);
    });
    expect(readPanel(view.container)).toEqual({
      counter: '日志 1/1',
      rows: [{ parts: ['', '10:00:00.518', '[info]', '[system]', '模板设计师监听插件已激活'] }],
    });
  });
});

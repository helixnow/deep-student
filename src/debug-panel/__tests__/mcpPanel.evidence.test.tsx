/**
 * Evidence for the MCP debug panel, recorded before the file was split (event model and labels, sanitizing /
 * truncation / throttling, panel). MCP reports arrive as the window events the panel listens to; the goldens hold the
 * panel (classes, inline colours, icons, full text including the sanitized detail JSON), the copied and exported text
 * and the notifications. Times run on a fake clock pinned to a local wall time; ISO times in copied and exported text
 * are kept as offsets from it.
 */
import fs from 'node:fs';
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinDefaultLocaleForFile } from './defaultLocale';
import { panelText } from './domDump';

const h = vi.hoisted(() => ({ copied: [] as string[], notices: [] as string[] }));

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn(async (text: string) => {
    h.copied.push(text);
    return true;
  }),
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn((type: string, message: string) => h.notices.push(`${type}: ${message}`)),
}));

const GOLDEN_DIR = 'src/debug-panel/__tests__/__golden__';
const CAPTURE = process.env.FE_B7_CAPTURE_GOLDEN === '1';
const START = new Date(2026, 10, 7, 10, 0, 0, 0);

function golden(name: string, current: string): string {
  const file = `${GOLDEN_DIR}/${name}`;
  if (CAPTURE && !fs.existsSync(file)) fs.writeFileSync(file, current);
  return fs.readFileSync(file, 'utf8');
}

type PanelProps = { visible: boolean; isActive: boolean; isActivated: boolean; onClose: () => void };
let Panel: React.ComponentType<PanelProps>;
const props = (isActivated: boolean): PanelProps => ({ visible: true, isActive: true, isActivated, onClose: () => undefined });

async function step(fn: () => void) {
  await act(async () => {
    fn();
  });
}

/** One MCP window event, `gap` ms after the previous one. */
async function report(name: string, detail: unknown, gap = 41) {
  await step(() => {
    vi.advanceTimersByTime(gap);
    window.dispatchEvent(new CustomEvent(name, { detail }));
  });
}

const offset = (iso: string) => {
  const ms = Date.parse(iso);
  expect(new Date(ms).toISOString()).toBe(iso);
  return ms - START.getTime();
};

/**
 * Copied / exported entries with `timestamp` as an offset from START and `ts` / `id` checked against it. The id's
 * random part is checked for shape only: it is drawn inside a state updater, and React may run an updater more than
 * once, which shifts the draws of later entries.
 */
function readEntries(text: string) {
  const parsed = JSON.parse(text) as Record<string, unknown> | Array<Record<string, unknown>>;
  const one = (entry: Record<string, unknown>) => {
    const { timestamp, ts, id, ...rest } = entry as { timestamp: string; ts?: number; id?: string };
    const at = offset(timestamp);
    if (ts !== undefined) expect(ts - START.getTime()).toBe(at);
    if (id !== undefined) expect(id).toMatch(new RegExp(`^${ts}-[0-9a-f]{1,6}$`));
    return { keys: Object.keys(entry), at, ...rest };
  };
  return Array.isArray(parsed) ? parsed.map(one) : one(parsed);
}

const button = (container: HTMLElement, title: string) => container.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!;
const selects = (container: HTMLElement) => Array.from(container.querySelectorAll('select'));

/** A round of MCP activity: config, two servers connecting, stdio traffic, tool calls with secrets and large payloads. */
async function sendRound() {
  await report('mcp-config-init', {
    servers: [
      { id: 'fs', type: 'stdio', namespace: 'files', command: 'npx', env: { API_KEY: 'sk-should-not-appear' } },
      { id: 'search', type: 'sse', namespace: 'web', url: 'https://example.invalid/sse' },
    ],
  });
  await report('mcp-config-change', { servers: 2, reason: 'user-edit', note: 'x'.repeat(620) });
  await report('mcp-connect-start', { serverId: 'fs', transport: 'stdio' });
  await report('mcp-connect-success', { serverId: 'fs', transport: 'stdio' });
  await report('mcp-connect-start', { serverId: 'search', transport: 'sse' });
  const refused = Object.assign(new TypeError('fetch failed: ECONNREFUSED'), {
    stack: 'TypeError: fetch failed: ECONNREFUSED\n    at connectSse (mcp/transport.ts:42:7)',
  });
  await report('mcp-connect-fail', { serverId: 'search', transport: 'sse', error: refused });
  await report('mcp-stdio-send', { sessionId: 'session-0123456789', serverId: 'fs', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  await report('mcp-stdio-send', { sessionId: 'session-0123456789', serverId: 'fs', payload: { jsonrpc: '2.0', id: 2, method: 'throttled' } });
  await report('mcp-stdio-recv', { sessionId: 'session-0123456789', serverId: 'fs', payload: 'r'.repeat(340) });
  await report('mcp-stdio-send', { sessionId: 'session-0123456789', serverId: 'fs', payload: { id: 3, method: 'tools/call' } }, 120);
  await report('mcp-tool-call-start', {
    serverId: 'fs', toolName: 'read_file', callId: 'call-1',
    args: { path: '/notes/a.md', apiKey: 'abcdefghijklmnopqrstuvwxyz0123', auth: { bearerToken: 'tok-12345678' }, list: ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'short'] },
  });
  await report('mcp-tool-call-success', { serverId: 'fs', toolName: 'read_file', callId: 'call-1', duration: 87, result: { content: 'y'.repeat(700) } });
  await report('mcp-tool-call-error', { serverId: 'fs', toolName: 'write_file', callId: 'call-2', duration: 12, error: 'EACCES: permission denied' });
  await report('mcp-stdio-error', { sessionId: 'session-0123456789', serverId: 'fs', error: 'broken pipe' });
  await report('mcp-stdio-closed', { sessionId: 'session-0123456789', serverId: 'fs' });
  await report('mcp-disconnect', { serverId: 'search' });
}

// Log rows show `toLocaleTimeString(undefined, …)` times.
pinDefaultLocaleForFile();

beforeEach(async () => {
  h.copied.length = 0;
  h.notices.length = 0;
  vi.useFakeTimers({ now: START });
  let n = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => ((n++ % 90) + 1) / 1000);
  vi.resetModules();
  ({ default: Panel } = (await import('../plugins/McpDebugPlugin')) as unknown as { default: React.ComponentType<PanelProps> });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MCP debug panel (evidence before the split)', () => {
  it('records a round of MCP activity with sanitized details, then copies and exports it', async () => {
    const exported: Array<{ download: string; href: string }> = [];
    const blobs: Array<{ text: string; type?: string }> = [];
    vi.stubGlobal('Blob', class extends Blob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        blobs.push({ text: parts.map(String).join(''), type: options?.type });
      }
    });
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mcp-export'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      exported.push({ download: this.download, href: this.href });
    });

    const { container } = render(<Panel {...props(true)} />);
    const empty = panelText(container);
    await sendRound();
    const round = panelText(container);

    await step(() => fireEvent.click(button(container, '复制所有日志到剪贴板')));
    const copiedAll = readEntries(h.copied.at(-1)!);
    await step(() => fireEvent.click(container.querySelectorAll<HTMLButtonElement>('button[title="复制日志"]')[10]!));
    const copiedOne = readEntries(h.copied.at(-1)!);
    await step(() => fireEvent.click(button(container, '导出日志为JSON文件')));
    const exportFile = {
      download: exported[0]!.download.replace(new Date().toISOString().slice(0, 19).replace(/:/g, '-'), '<now>'),
      href: exported[0]!.href,
      type: blobs[0]!.type,
      entries: readEntries(blobs[0]!.text),
    };

    expect(empty).toBe(golden('mcp.empty.txt', empty));
    expect(round).toBe(golden('mcp.round.txt', round));
    const current = `${JSON.stringify({ notices: h.notices, copiedAll, copiedOne, exportFile }, null, 2)}\n`;
    expect(current).toBe(golden('mcp.copied.json', current));
  });

  it('filters by errors, server, event type, level and keyword, and records every stdio message with throttling off', async () => {
    const { container } = render(<Panel {...props(true)} />);
    await sendRound();
    const views: string[] = [];
    const view = (label: string) => {
      const header = container.querySelector('.bg-gray-100.px-3.py-2')!.textContent;
      const rows = Array.from(container.querySelectorAll('.divide-y > div .text-sm.text-gray-800')).map((el) => el.textContent);
      views.push(`## ${label}\n${header}\n${rows.join('\n')}`);
    };
    const [server, type, level] = selects(container);

    await step(() => fireEvent.click(button(container, '仅显示错误和警告')));
    view('errors only');
    await step(() => fireEvent.click(button(container, '仅显示错误和警告')));
    await step(() => fireEvent.change(server!, { target: { value: 'search' } }));
    view('server search');
    await step(() => fireEvent.change(server!, { target: { value: 'all' } }));
    await step(() => fireEvent.change(type!, { target: { value: 'tool_call_success' } }));
    view('type tool_call_success');
    await step(() => fireEvent.change(type!, { target: { value: 'all' } }));
    await step(() => fireEvent.change(level!, { target: { value: 'debug' } }));
    view('level debug');
    await step(() => fireEvent.change(level!, { target: { value: 'all' } }));
    await step(() => fireEvent.change(container.querySelector('input[type="text"]')!, { target: { value: 'READ_FILE' } }));
    view('keyword READ_FILE');
    await step(() => fireEvent.change(container.querySelector('input[type="text"]')!, { target: { value: 'nothing-matches' } }));
    view('keyword without match');
    const noMatch = panelText(container.querySelector('.border.rounded-lg')!);
    await step(() => fireEvent.change(container.querySelector('input[type="text"]')!, { target: { value: '' } }));
    await step(() => fireEvent.click(button(container, '复制所有日志到剪贴板')));

    await step(() => fireEvent.click(button(container, '节流已启用（防日志风暴）')));
    await report('mcp-stdio-send', { sessionId: 's2', serverId: 'fs', payload: { id: 10 } });
    await report('mcp-stdio-send', { sessionId: 's2', serverId: 'fs', payload: { id: 11 } }, 5);
    await report('mcp-stdio-recv', { sessionId: 's2', serverId: 'fs', payload: { id: 11, result: [] } }, 5);
    view('throttling off');
    const header = panelText(container.querySelector('h2')!.parentElement!);

    await step(() => fireEvent.click(button(container, '清空日志')));
    await report('mcp-connect-start', { serverId: 'fs-2', transport: 'stdio' });
    const afterClear = panelText(container);

    const current = `${views.join('\n')}\n----\n${noMatch}----\n${header}----\n${afterClear}----\n${JSON.stringify(h.notices)}\n`;
    expect(current).toBe(golden('mcp.filters.txt', current));
  });

  it('stops listening when deactivated and keeps the earlier rows on reactivation', async () => {
    const { container, rerender } = render(<Panel {...props(true)} />);
    await report('mcp-connect-start', { serverId: 'fs', transport: 'stdio' });
    rerender(<Panel {...props(false)} />);
    expect(container.innerHTML).toBe('');
    await report('mcp-connect-success', { serverId: 'fs', transport: 'stdio' });
    await step(() => rerender(<Panel {...props(true)} />));
    await report('mcp-disconnect', { serverId: 'fs' });
    expect(panelText(container)).toBe(golden('mcp.reactivate.txt', panelText(container)));
  });
});

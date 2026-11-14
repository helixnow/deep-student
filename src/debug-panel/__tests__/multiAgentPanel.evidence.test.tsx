/**
 * Evidence for the multi-agent debug panel, recorded before the file was split (preset prompts, log store, workspace
 * listeners, panel). Workspace events and per-session chat tool calls arrive through the Tauri `listen` channels the
 * panel subscribes to; sessions come and go through the session manager; the workspace store drives the monitor tab.
 * The goldens hold the three tabs (classes, icons, full text), the copied report, the messages sent to chat and which
 * channels are subscribed at each point. Times run on a fake clock pinned to a local wall time; ISO times in the
 * copied report are kept as offsets from it.
 */
import fs from 'node:fs';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinDefaultLocaleForFile } from './defaultLocale';
import { panelText } from './domDump';

type Handler = (event: { payload: unknown }) => void;
type SessionEvent = { type: string; sessionId: string };

const h = vi.hoisted(() => ({
  copied: [] as string[],
  channels: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  sessionListener: null as ((event: { type: string; sessionId: string }) => void) | null,
  sessionIds: [] as string[],
  currentSession: null as string | null,
  stores: new Map<string, { getState: () => { sessionStatus: string; sendMessage: (text: string) => Promise<void> } }>(),
  sent: [] as Array<[string, string]>,
  refresh: { agents: [] as unknown[], messages: [] as unknown[], fail: false },
}));

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn(async (text: string) => {
    h.copied.push(text);
    return true;
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    if (!h.channels.has(name)) h.channels.set(name, new Set());
    h.channels.get(name)!.add(handler);
    return () => {
      h.channels.get(name)?.delete(handler);
      if (h.channels.get(name)?.size === 0) h.channels.delete(name);
    };
  }),
}));
vi.mock('@/features/chat/core/session/sessionManager', () => ({
  sessionManager: {
    getAllSessionIds: () => [...h.sessionIds],
    subscribe: (listener: (event: { type: string; sessionId: string }) => void) => {
      h.sessionListener = listener;
      return () => {
        if (h.sessionListener === listener) h.sessionListener = null;
      };
    },
    getCurrentSessionId: () => h.currentSession,
    get: (id: string) => h.stores.get(id),
  },
}));
vi.mock('@/features/chat/workspace/api', () => ({
  listAgents: vi.fn(async () => {
    if (h.refresh.fail) throw new Error('workspace not found');
    return h.refresh.agents;
  }),
  listMessages: vi.fn(async () => h.refresh.messages),
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
type PanelModule = typeof import('../plugins/MultiAgentDebugPlugin');
let mod: PanelModule;
let Panel: React.ComponentType<PanelProps>;
let store: typeof import('@/features/chat/workspace/workspaceStore').useWorkspaceStore;
const props = (isActive: boolean): PanelProps => ({ visible: true, isActive, isActivated: isActive, onClose: () => undefined });

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

/** Delivers `payload` on a Tauri channel 29 ms after the previous delivery. */
async function deliver(channel: string, payload: unknown) {
  await act(async () => {
    vi.advanceTimersByTime(29);
    for (const handler of [...(h.channels.get(channel) ?? [])]) (handler as Handler)({ payload });
  });
}

async function session(event: SessionEvent) {
  await act(async () => {
    vi.advanceTimersByTime(29);
    h.sessionListener?.(event);
  });
  await flush();
}

const subscribed = () => [...h.channels.keys()].sort();
const tab = (name: RegExp) => screen.getByRole('button', { name });

/** The copied report with ISO times as offsets from START (checked to round-trip exactly). */
function readReport(text: string) {
  const offset = (iso: string) => {
    const ms = Date.parse(iso);
    expect(new Date(ms).toISOString()).toBe(iso);
    return ms - START.getTime();
  };
  const report = JSON.parse(text) as { generatedAt: string; logs: Array<{ timestamp: string }> };
  return {
    ...report,
    generatedAt: offset(report.generatedAt),
    logs: report.logs.map((log) => ({ ...log, timestamp: offset(log.timestamp) })),
  };
}

function seedWorkspace() {
  store.setState({
    currentWorkspaceId: 'ws_0123456789abcdef',
    workspace: {
      id: 'ws_0123456789abcdef', name: 'AI教育研究', status: 'active', creatorSessionId: 'sess_coordinator_0001',
      createdAt: '2026-11-07T09:50:00', updatedAt: '2026-11-07T09:55:00',
    },
    agents: [
      { sessionId: 'sess_coordinator_0001', workspaceId: 'ws_0123456789abcdef', role: 'coordinator', status: 'running', joinedAt: '2026-11-07T09:50:00', lastActiveAt: '2026-11-07T09:59:00' },
      { sessionId: 'sess_worker_research_02', workspaceId: 'ws_0123456789abcdef', role: 'worker', skillId: 'research', status: 'idle', joinedAt: '2026-11-07T09:51:00', lastActiveAt: '2026-11-07T09:58:00' },
      { sessionId: 'sess_worker_writer_0003', workspaceId: 'ws_0123456789abcdef', role: 'worker', skillId: 'writer', status: 'failed', joinedAt: '2026-11-07T09:52:00', lastActiveAt: '2026-11-07T09:57:00' },
    ],
    messages: Array.from({ length: 12 }, (_, i) => ({
      id: `msg_${i}`,
      workspaceId: 'ws_0123456789abcdef',
      senderSessionId: i % 2 ? 'sess_worker_research_02' : 'sess_coordinator_0001',
      ...(i % 3 === 0 ? {} : { targetSessionId: 'sess_worker_writer_0003' }),
      messageType: i % 4 === 0 ? 'broadcast' : 'task',
      content: `第 ${i} 条消息：调研人工智能在教育领域的应用，并整理成结构化的结论与引用。`,
      status: 'delivered',
      createdAt: `2026-11-07T09:${String(40 + i).padStart(2, '0')}:00`,
    })),
  } as never);
}

// Log rows show `toLocaleTimeString()` times.
pinDefaultLocaleForFile();

beforeEach(async () => {
  h.copied.length = 0;
  h.channels.clear();
  h.sessionListener = null;
  h.sessionIds = ['sess_coordinator_0001'];
  h.currentSession = null;
  h.stores.clear();
  h.sent.length = 0;
  h.refresh = { agents: [], messages: [], fail: false };
  vi.useFakeTimers({ now: START });
  let n = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => ((n++ % 97) + 1) / 1000);
  // The panel calls toLocaleTimeString() with no locale; the goldens hold the en-US output ("10:00:00 AM") whatever
  // the process LANG is. Times stay in the local zone: START and the fixture timestamps are local wall times.
  const toLocaleTimeString = Date.prototype.toLocaleTimeString;
  vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(function (this: Date, locales, options) {
    return toLocaleTimeString.call(this, locales ?? 'en-US', options);
  });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.resetModules();
  mod = await import('../plugins/MultiAgentDebugPlugin');
  Panel = mod.default as unknown as React.ComponentType<PanelProps>;
  ({ useWorkspaceStore: store } = await import('@/features/chat/workspace/workspaceStore'));
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('multi-agent debug panel (evidence before the split)', () => {
  it('logs workspace events and workspace tool calls per session, then copies the report', async () => {
    seedWorkspace();
    mod.logMultiAgent('system', 'LOGGED_BEFORE_MOUNT', { note: 'shown on first render' }, 'info');
    const { container, rerender } = render(<Panel {...props(true)} />);
    await flush();
    const monitor = panelText(container);
    const channelsAtMount = subscribed();

    await deliver('workspace_message_received', { workspaceId: 'ws_0123456789abcdef', messageId: 'msg_12' });
    await deliver('workspace_agent_joined', { sessionId: 'sess_worker_writer_0003', role: 'worker' });
    await deliver('workspace_agent_status_changed', { sessionId: 'sess_worker_research_02', status: 'running' });
    await deliver('workspace_worker_ready', { sessionId: 'sess_worker_research_02' });
    const chat = 'chat_v2_event_sess_coordinator_0001';
    await deliver(chat, { type: 'tool_call', phase: 'start', blockId: 'blk-1', messageId: 'm-1', payload: { toolName: 'builtin-workspace_create', toolInput: { name: 'AI教育研究' } } });
    await deliver(chat, { type: 'tool_call', phase: 'start', blockId: 'blk-2', messageId: 'm-1', payload: { toolName: 'builtin-web_search', toolInput: { q: 'x' } } });
    await deliver(chat, { type: 'tool_call', phase: 'end', blockId: 'blk-2', result: { hits: 3 } });
    await deliver(chat, { type: 'tool_call', phase: 'end', blockId: 'blk-1', result: { workspaceId: 'ws_0123456789abcdef' } });
    await deliver(chat, { type: 'content', phase: 'start', blockId: 'blk-3' });
    await deliver(chat, { type: 'tool_call', phase: 'start', blockId: 'blk-4', messageId: 'm-2', payload: { toolName: 'mcp.tools.subagent_call', toolInput: { skill: 'research' } } });
    await deliver(chat, { type: 'tool_call', phase: 'error', blockId: 'blk-4', error: 'worker crashed' });
    await deliver(chat, { type: 'tool_call', phase: 'end', blockId: 'blk-9', payload: { toolName: 'workspace_send_message' }, result: { ok: true } });
    await deliver(chat, { type: 'tool_call', phase: 'end', payload: { toolName: 'builtin-workspace_list_agents' }, result: [] });

    await session({ type: 'session-created', sessionId: 'sess_new_0004' });
    const channelsAfterCreate = subscribed();
    await deliver('chat_v2_event_sess_new_0004', { type: 'tool_call', phase: 'start', blockId: 'blk-5', messageId: 'm-3', payload: { toolName: 'workspace_query', toolInput: {} } });
    await deliver(chat, { type: 'tool_call', phase: 'start', blockId: 'blk-6', payload: { toolName: 'workspace_close', toolInput: {} } });
    await session({ type: 'session-destroyed', sessionId: 'sess_coordinator_0001' });
    await deliver(chat, { type: 'tool_call', phase: 'end', blockId: 'blk-6', result: { closed: true } });
    await deliver('chat_v2_event_sess_new_0004', { type: 'tool_call', phase: 'end', blockId: 'blk-5', result: { agents: 3 } });
    await session({ type: 'session-evicted', sessionId: 'sess_new_0004' });
    await deliver('workspace_closed', { workspaceId: 'ws_0123456789abcdef' });
    const channelsAfterDestroy = subscribed();

    await act(async () => fireEvent.click(tab(/日志 \(/)));
    const logs = panelText(container);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /复制日志/ })));
    const report = readReport(h.copied.at(-1)!);

    rerender(<Panel {...props(false)} />);
    await flush();
    const channelsAfterDeactivate = subscribed();

    const channels = { channelsAtMount, channelsAfterCreate, channelsAfterDestroy, channelsAfterDeactivate };
    expect(monitor).toBe(golden('multi-agent.monitor.txt', monitor));
    expect(logs).toBe(golden('multi-agent.logs.txt', logs));
    const current = `${JSON.stringify({ channels, report }, null, 2)}\n`;
    expect(current).toBe(golden('multi-agent.events.json', current));
  });

  it('sends preset and custom prompts to the current chat session and logs each outcome', async () => {
    const { container } = render(<Panel {...props(true)} />);
    await flush();
    const emptyMonitor = panelText(container);
    await act(async () => fireEvent.click(tab(/调试/)));
    const prompts = panelText(container);
    const presetButtons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('.space-y-2 > div > button'));

    await act(async () => fireEvent.click(presetButtons()[0]!));
    await flush();
    h.currentSession = 'sess_missing';
    await act(async () => fireEvent.click(presetButtons()[1]!));
    await flush();
    h.currentSession = 'sess_busy';
    h.stores.set('sess_busy', { getState: () => ({ sessionStatus: 'streaming', sendMessage: async () => undefined }) });
    await act(async () => fireEvent.click(presetButtons()[2]!));
    await flush();
    h.currentSession = 'sess_idle';
    h.stores.set('sess_idle', {
      getState: () => ({ sessionStatus: 'idle', sendMessage: async (text: string) => { h.sent.push(['sess_idle', text]); } }),
    });
    await act(async () => fireEvent.click(presetButtons()[3]!));
    await flush();
    const textarea = container.querySelector('textarea')!;
    await act(async () => fireEvent.change(textarea, { target: { value: '   ' } }));
    const blankDisabled = screen.getByRole('button', { name: /发送到聊天/ }).hasAttribute('disabled');
    await act(async () => fireEvent.change(textarea, { target: { value: '  请查询当前工作区的状态  ' } }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /发送到聊天/ })));
    await flush();
    const afterSend = panelText(container);
    await act(async () => fireEvent.click(tab(/日志 \(/)));
    const logs = panelText(container);

    expect(`${emptyMonitor}----\n${prompts}`).toBe(golden('multi-agent.prompts.txt', `${emptyMonitor}----\n${prompts}`));
    const current = `${JSON.stringify({ blankDisabled, sent: h.sent, afterSendChanged: afterSend !== prompts }, null, 2)}\n${logs}`;
    expect(current).toBe(golden('multi-agent.prompt-logs.txt', current));
  });

  it('refreshes agents and messages from the workspace API, logs failures, and clears the log', async () => {
    seedWorkspace();
    const { container } = render(<Panel {...props(true)} />);
    await flush();
    const refreshButton = () => container.querySelector<HTMLButtonElement>('.flex.items-center.gap-2 > button')!;

    await act(async () => fireEvent.click(refreshButton()));
    await flush();
    h.currentSession = 'sess_coordinator_0001';
    h.refresh.agents = [
      { session_id: 'sess_coordinator_0001', role: 'coordinator', skill_id: null, status: 'idle', joined_at: '2026-11-07T09:50:00', last_active_at: '2026-11-07T10:00:00' },
      { session_id: 'sess_worker_review_0005', role: 'worker', skill_id: 'reviewer', status: 'running', joined_at: '2026-11-07T09:59:00', last_active_at: '2026-11-07T10:00:00' },
    ];
    h.refresh.messages = [
      { id: 'msg_r1', sender_session_id: 'sess_worker_review_0005', target_session_id: null, message_type: 'result', content: '审阅完成', status: 'read', created_at: '2026-11-07T09:59:30' },
    ];
    await act(async () => fireEvent.click(refreshButton()));
    await flush();
    const refreshed = panelText(container);
    h.refresh.fail = true;
    await act(async () => fireEvent.click(refreshButton()));
    await flush();
    await act(async () => fireEvent.click(tab(/日志 \(/)));
    const logs = panelText(container);
    await act(async () => fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.flex.items-center.gap-2 > button')[2]!));
    const cleared = panelText(container);

    const current = `${refreshed}----\n${logs}----\n${cleared}`;
    expect(current).toBe(golden('multi-agent.refresh.txt', current));
  });

  it('subscribes to nothing outside Tauri and renders nothing while inactive', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const { container, rerender } = render(<Panel {...props(true)} />);
    await flush();
    expect(subscribed()).toEqual([]);
    expect(h.sessionListener).toBeNull();
    mod.logMultiAgent('agent', 'LOGGED_WHILE_OPEN', { n: 1 }, 'warning');
    rerender(<Panel {...props(false)} />);
    expect(container.innerHTML).toBe('');
    mod.logMultiAgent('error', 'LOGGED_WHILE_CLOSED', { n: 2 }, 'error');
    rerender(<Panel {...props(true)} />);
    await flush();
    await act(async () => fireEvent.click(tab(/日志 \(/)));
    expect(panelText(container)).toBe(golden('multi-agent.inactive.txt', panelText(container)));
  });
});

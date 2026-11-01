import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}${JSON.stringify(opts)}` : key),
  }),
}));

const api = vi.hoisted(() => ({
  status: vi.fn(),
  feed: vi.fn(),
  setEnabled: vi.fn(),
  closeWorker: vi.fn(),
  reviveWorker: vi.fn(),
  send: vi.fn(),
}));

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    superAgentApi: api,
    subscribeSuperAgentEvents: vi.fn().mockResolvedValue(() => undefined),
  };
});

import { APP_EVENTS, addAppEventListener } from '@/events';
import { SuperAgentPage } from '../SuperAgentPage';

const baseStats = {
  pendingRouter: 0,
  pendingWorkers: 0,
  claimed: 0,
  workersTotal: 0,
  workersRunning: 0,
  subscriptions: 0,
};

const worker = {
  id: 'swk_1',
  threadKey: 'task:abc',
  title: '整理错题',
  brief: 'b',
  status: 'running' as const,
  createdMs: 1,
  lastProgressMs: 1,
  runStartedMs: 1,
  runs: 2,
};

describe('SuperAgentPage', () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
    api.feed.mockResolvedValue([]);
    api.setEnabled.mockResolvedValue(undefined);
    api.send.mockResolvedValue({ status: 'accepted', triggerId: 't', targets: ['router'], fastPath: false });
  });
  afterEach(() => cleanup());

  it('shows the intro with a pointer to Settings (no in-page enable) while disabled', async () => {
    api.status.mockResolvedValue({ enabled: false, routerBusy: false, stats: baseStats, workers: [] });
    const navigate = vi.fn();
    const off = addAppEventListener(APP_EVENTS.NAVIGATE_TO_VIEW, navigate);
    render(<SuperAgentPage />);
    await screen.findByText('intro.heading');
    expect(screen.queryByPlaceholderText('composer.placeholder')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.click(screen.getByText('intro.openSettings'));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0]).toMatchObject({ view: 'settings' });
    expect(api.setEnabled).not.toHaveBeenCalled();
    off();
  });

  it('renders one continuous feed with user, reply and collapsed worker progress', async () => {
    api.status.mockResolvedValue({ enabled: true, routerBusy: false, stats: baseStats, workers: [] });
    api.feed.mockResolvedValue([
      { id: '1', kind: 'user', threadKey: 'chat:main', text: '帮我整理错题', createdMs: 1, source: 'chat' },
      { id: '2', kind: 'reply', threadKey: 'chat:main', text: '已开始整理', createdMs: 2, source: 'router' },
      { id: '3', kind: 'worker', threadKey: 'task:abc', text: 'Worker swk_1 完成了归类', createdMs: 3, source: 'internal' },
    ]);
    render(<SuperAgentPage />);
    await screen.findByText('帮我整理错题');
    expect(screen.getByText('已开始整理')).toBeTruthy();
    expect(document.querySelectorAll('details').length).toBe(1);
  });

  it('sends channel messages to chat:main and clears the draft', async () => {
    api.status.mockResolvedValue({ enabled: true, routerBusy: false, stats: baseStats, workers: [] });
    render(<SuperAgentPage />);
    const box = await screen.findByPlaceholderText('composer.placeholder');
    fireEvent.change(box, { target: { value: '  做点事  ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(api.send).toHaveBeenCalledWith('做点事', 'chat:main'));
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });

  it('shift+enter does not send', async () => {
    api.status.mockResolvedValue({ enabled: true, routerBusy: false, stats: baseStats, workers: [] });
    render(<SuperAgentPage />);
    const box = await screen.findByPlaceholderText('composer.placeholder');
    fireEvent.change(box, { target: { value: 'x' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(api.send).not.toHaveBeenCalled();
  });

  it('replies directly to a task thread, bypassing the channel', async () => {
    api.status.mockResolvedValue({
      enabled: true,
      routerBusy: false,
      stats: { ...baseStats, workersTotal: 1, workersRunning: 1 },
      workers: [worker],
    });
    render(<SuperAgentPage />);
    await screen.findByText('整理错题');
    fireEvent.click(screen.getByText('worker.reply'));
    fireEvent.change(screen.getByPlaceholderText('worker.replyPlaceholder'), { target: { value: '改成方案B' } });
    fireEvent.click(screen.getByText('worker.sendDirect'));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith('改成方案B', 'task:abc'));
  });

  it('shows thinking while the router has a backlog', async () => {
    api.status.mockResolvedValue({
      enabled: true,
      routerBusy: false,
      stats: { ...baseStats, pendingRouter: 2 },
      workers: [],
    });
    render(<SuperAgentPage />);
    await screen.findByText('thinking');
  });

  it('does not poll while inactive', async () => {
    api.status.mockResolvedValue({ enabled: true, routerBusy: false, stats: baseStats, workers: [] });
    render(<SuperAgentPage isActive={false} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(api.status).not.toHaveBeenCalled();
  });
});

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BilibiliTransportPanel } from '../BilibiliTransportPanel';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
const mock = vi.mocked(invoke);
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('Bilibili transport panel', () => {
  it('shows browser identity independently and only approves the displayed connection', async () => {
    mock.mockImplementation(async (command) => command === 'media_bilibili_transport_status' ? {
      settings: { mode: 'auto', proxyUrl: null, proxyInAuto: false },
      bridge: { state: 'awaiting_approval', connectionId: 'paired-tab', scriptVersion: '1.0.0', parsing: false, media: false, account: { loggedIn: true, mid: 7, uname: 'Browser user' }, generation: 1 },
    } : null);
    render(<BilibiliTransportPanel />);
    await waitFor(() => expect(screen.getByText('Browser user')).toBeTruthy());
    fireEvent.click(screen.getByText('确认此浏览器配对'));
    await waitFor(() => expect(mock).toHaveBeenCalledWith('media_bilibili_bridge_approve', { connectionId: 'paired-tab' }));
    expect(mock).not.toHaveBeenCalledWith('media_bilibili_logout', expect.anything());
  });
  it('shows parsing-only capability without claiming media support', async () => {
    mock.mockResolvedValue({ settings: { mode: 'browser_bridge', proxyUrl: null, proxyInAuto: false }, bridge: { state: 'ready', connectionId: 'paired-tab', parsing: true, media: false, account: null, generation: 2 } });
    render(<BilibiliTransportPanel />);
    await waitFor(() => expect(screen.getByText('仅解析可用')).toBeTruthy());
    expect(screen.queryByText('解析和媒体可用')).toBeNull();
  });
  it('keeps the failed capability visible after the connection is revoked', async () => {
    mock.mockResolvedValue({ settings: { mode: 'auto', proxyUrl: null, proxyInAuto: false }, bridge: { state: 'offline', connectionId: null, parsing: false, media: false, account: null, generation: 3, lastError: { code: 'bilibili-redirect-unsupported', message: 'Manual redirect unavailable' } } });
    render(<BilibiliTransportPanel />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('bilibili-redirect-unsupported'));
    expect(screen.getByRole('alert').textContent).toContain('Manual redirect unavailable');
  });
});

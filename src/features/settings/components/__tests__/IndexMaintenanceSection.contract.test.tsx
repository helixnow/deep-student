import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectInvokeCallsMatchContract } from '@/__tests__/helpers/ipcContract';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    invoke: invokeMock,
    getSetting: vi.fn().mockResolvedValue('true'),
    saveSetting: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

import { LanceOptimizationPanel } from '../IndexMaintenanceSection';

// optimize_chat_embeddings_table 的契约键是 olderThanDays / deleteUnverified / force；
// snake_case 键会被丢弃，用户设置的天数与“删除未验证”开关此前从未生效。
describe('LanceOptimizationPanel invoke payloads', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
  });

  it('optimize-all sends contract keys for both Lance tables', async () => {
    render(<LanceOptimizationPanel />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '30' } });
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]!);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    expectInvokeCallsMatchContract(invokeMock.mock.calls, 'optimize_chat_embeddings_table');
    expectInvokeCallsMatchContract(invokeMock.mock.calls, 'vfs_optimize_lance');
    expect(invokeMock).toHaveBeenCalledWith('optimize_chat_embeddings_table', { olderThanDays: 30, deleteUnverified: true, force: true });
  });
});

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { SuperAgentConfigPanel } from '../SuperAgentConfigPanel';

describe('SuperAgentConfigPanel', () => {
  it('only exposes the extra instructions field', async () => {
    render(<SuperAgentConfigPanel load={() => Promise.resolve({ instructions: '先问我' })} save={vi.fn()} />);
    const field = await screen.findByLabelText('config.instructionsTitle');
    expect(field).toHaveValue('先问我');
    // 旧版 Router / Worker 模型、并发度、Worker 上限、保留期均已移除
    expect(screen.queryByLabelText('config.concurrencyTitle')).toBeNull();
    expect(screen.queryByLabelText('config.maxWorkersTitle')).toBeNull();
    expect(screen.queryByLabelText('config.retentionTitle')).toBeNull();
    expect(screen.queryByText('config.routerModelTitle')).toBeNull();
    expect(screen.queryByText('config.workerModelTitle')).toBeNull();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('saves the edited instructions', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<SuperAgentConfigPanel load={() => Promise.resolve({ instructions: '' })} save={save} />);
    const field = await screen.findByLabelText('config.instructionsTitle');
    expect(screen.getByTestId('superagent-config-save')).toBeDisabled();

    fireEvent.change(field, { target: { value: '只处理学习相关的事' } });
    fireEvent.click(screen.getByTestId('superagent-config-save'));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toEqual({ instructions: '只处理学习相关的事' });
    expect(await screen.findByText('config.saved')).toBeInTheDocument();
  });

  it('shows the backend error when saving fails', async () => {
    render(
      <SuperAgentConfigPanel
        load={() => Promise.resolve({ instructions: '' })}
        save={() => Promise.reject(new Error('写入失败'))}
      />,
    );
    fireEvent.change(await screen.findByLabelText('config.instructionsTitle'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('superagent-config-save'));
    expect(await screen.findByText(/写入失败/)).toBeInTheDocument();
  });

  it('shows the backend error when loading fails', async () => {
    render(<SuperAgentConfigPanel load={() => Promise.reject(new Error('读取失败'))} save={vi.fn()} />);
    expect(await screen.findByText(/读取失败/)).toBeInTheDocument();
  });
});

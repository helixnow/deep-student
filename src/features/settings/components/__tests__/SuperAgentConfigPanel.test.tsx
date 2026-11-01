import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { SuperAgentConfigPanel, type SuperAgentHubConfig } from '../SuperAgentConfigPanel';

const baseConfig: SuperAgentHubConfig = {
  policyText: '',
  maxWorkers: 6,
  workerConcurrency: 3,
  routerModelId: null,
  workerModelId: null,
  retentionDays: 30,
  // 面板不展示的字段必须原样回写
  stallSecs: 900,
  filter: { dedupeWindowMs: 1000 },
};

describe('SuperAgentConfigPanel', () => {
  it('saves edited fields and passes untouched backend fields through', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <SuperAgentConfigPanel
        load={() => Promise.resolve(baseConfig)}
        save={save}
        loadModels={() => Promise.resolve([])}
      />,
    );
    const policy = await screen.findByLabelText('config.policyTitle');
    expect(screen.getByTestId('superagent-config-save')).toBeDisabled();

    fireEvent.change(policy, { target: { value: '只处理学习相关的事' } });
    fireEvent.change(screen.getByLabelText('config.concurrencyTitle'), { target: { value: '99' } });
    fireEvent.change(screen.getByLabelText('config.retentionTitle'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('superagent-config-save'));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toEqual({
      ...baseConfig,
      policyText: '只处理学习相关的事',
      workerConcurrency: 6, // 夹到上限
      retentionDays: 0,
    });
    expect(await screen.findByText('config.saved')).toBeInTheDocument();
  });

  it('shows the backend error when saving fails', async () => {
    render(
      <SuperAgentConfigPanel
        load={() => Promise.resolve(baseConfig)}
        save={() => Promise.reject(new Error('写入失败'))}
        loadModels={() => Promise.resolve([])}
      />,
    );
    fireEvent.change(await screen.findByLabelText('config.policyTitle'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('superagent-config-save'));
    expect(await screen.findByText(/写入失败/)).toBeInTheDocument();
  });
});

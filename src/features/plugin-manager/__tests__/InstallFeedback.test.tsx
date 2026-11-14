import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InstallFeedback } from '../InstallFeedback';

vi.mock('react-i18next', async () => {
  const { i18nMock } = await import('./i18nMock');
  return i18nMock();
});

describe('InstallFeedback', () => {
  it('RF-W35-offline-package-feedback: a fresh install says it is on disk only, not consented or running', () => {
    render(
      <InstallFeedback
        result={{ status: 'installed', id: 'community.example', version: '2.0.0', previousVersion: null, enabled: false }}
      />,
    );

    const feedback = screen.getByTestId('plugin-install-feedback');
    expect(feedback).toHaveAttribute('data-status', 'installed');
    expect(feedback).toHaveTextContent('已安装 community.example v2.0.0');
    expect(feedback).toHaveTextContent('新安装');
    expect(feedback).toHaveTextContent('安装只写入磁盘');
  });

  it('names the previous version on upgrade', () => {
    render(
      <InstallFeedback
        result={{ status: 'installed', id: 'community.example', version: '2.0.0', previousVersion: '1.9.0', enabled: true }}
      />,
    );

    expect(screen.getByTestId('plugin-install-feedback')).toHaveTextContent('已从 v1.9.0 升级');
  });

  it('reports a rollback with the restored version and the Host reason', () => {
    render(
      <InstallFeedback
        result={{
          status: 'rolled-back',
          id: 'community.example',
          version: '2.0.0',
          previousVersion: '1.9.0',
          reason: 'PLUGIN_PACKAGE_INVALID: checksum mismatch',
        }}
      />,
    );

    const feedback = screen.getByTestId('plugin-install-feedback');
    expect(feedback).toHaveAttribute('data-status', 'rolled-back');
    expect(feedback).toHaveTextContent('已恢复到 v1.9.0');
    expect(feedback).toHaveTextContent('checksum mismatch');
  });

  it('says the disk is unchanged when there was no previous version', () => {
    render(
      <InstallFeedback
        result={{ status: 'rolled-back', previousVersion: null, reason: 'manifest invalid' }}
      />,
    );

    expect(screen.getByTestId('plugin-install-feedback')).toHaveTextContent('没有可恢复的旧版本');
  });

  it.each([
    ['restored', '已恢复旧版本'],
    ['unchanged', '磁盘未改变'],
    ['failed', '回滚失败'],
  ] as const)('shows the rejected install with rollback=%s', (rollback, copy) => {
    render(
      <InstallFeedback
        result={{ status: 'rejected', code: 'PLUGIN_PACKAGE_INVALID', detail: 'path escapes root', rollback }}
      />,
    );

    const feedback = screen.getByTestId('plugin-install-feedback');
    expect(feedback).toHaveAttribute('data-status', 'rejected');
    expect(feedback).toHaveTextContent('PLUGIN_PACKAGE_INVALID');
    expect(feedback).toHaveTextContent('path escapes root');
    expect(screen.getByTestId('plugin-install-rollback')).toHaveAttribute('data-rollback', rollback);
    expect(screen.getByTestId('plugin-install-rollback')).toHaveTextContent(copy);
  });

  it('can be dismissed', async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(
      <InstallFeedback
        result={{ status: 'installed', id: 'community.example', version: '2.0.0', previousVersion: null, enabled: false }}
        onDismiss={onDismiss}
      />,
    );

    await user.click(screen.getByRole('button', { name: '知道了' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConsentDialog } from '../ConsentDialog';
import type { PluginConsentSubject } from '../types';

vi.mock('react-i18next', async () => {
  const { i18nMock } = await import('./i18nMock');
  return i18nMock();
});

const subject: PluginConsentSubject = {
  id: 'community.notes-exporter',
  version: '1.4.0',
  permissions: ['service:__svc_community_notes_exporter', 'service:__svc_storage'],
};

describe('ConsentDialog', () => {
  it('RF-W35-consent-required-dialog: shows the exact id, version and service permissions Host reported', () => {
    render(<ConsentDialog subject={subject} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-consent-id')).toHaveTextContent('community.notes-exporter');
    expect(screen.getByTestId('plugin-consent-version')).toHaveTextContent('1.4.0');

    const list = screen.getByTestId('plugin-consent-permissions');
    const permissions = within(list).getAllByRole('listitem');
    expect(permissions.map((item) => item.getAttribute('data-permission'))).toEqual(subject.permissions);
    expect(within(list).getAllByText('服务', { selector: '[data-shad-badge]' })).toHaveLength(2);
  });

  it('confirms only when the user explicitly presses the allow button', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ConsentDialog subject={subject} onConfirm={onConfirm} onCancel={vi.fn()} />);

    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '同意并重载' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('lets the user decline without granting anything', async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ConsentDialog subject={subject} onConfirm={onConfirm} onCancel={onCancel} />);

    await user.click(screen.getByRole('button', { name: '暂不同意' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('disables both actions while the ledger write is in flight', () => {
    render(<ConsentDialog subject={subject} busy onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByRole('button', { name: '正在保存同意记录' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '暂不同意' })).toBeDisabled();
  });

  it('states that no permissions were declared instead of showing an empty list', () => {
    render(<ConsentDialog subject={{ ...subject, permissions: [] }} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText('没有声明任何服务权限')).toBeInTheDocument();
  });
});

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
    // Plain words first; the exact strings being consented to stay underneath in small print.
    expect(permissions[0]).toHaveTextContent('使用应用服务「__svc_community_notes_exporter」');
    expect(permissions[0]).toHaveTextContent('service:__svc_community_notes_exporter');
  });

  it('uses the workshop confirmation vocabulary for agent tools, network hosts and the chat model', () => {
    render(<ConsentDialog subject={{ id: 'workshop.timetable', version: '1.0.0', permissions: ['agent:tools', 'net:calendar.example.edu.cn', 'service:pluginModel', 'service:notes'] }}
      agentTools={[{ name: 'today', title: '查课表' }, { name: 'week', title: '本周课程' }]} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const texts = within(screen.getByTestId('plugin-consent-permissions')).getAllByRole('listitem')
      .map((item) => item.querySelector('span')?.textContent);
    expect(texts).toEqual([
      '让 AI 助手学会新本事「查课表」', '让 AI 助手学会新本事「本周课程」',
      '联网读取 calendar.example.edu.cn（只读，仅限这个域名）', '用当前对话模型生成文字', '使用应用服务「笔记」',
    ]);
  });

  it('confirms only when the user explicitly presses the allow button', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ConsentDialog subject={subject} onConfirm={onConfirm} onCancel={vi.fn()} />);

    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '允许并启用' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('lets the user decline without granting anything', async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ConsentDialog subject={subject} onConfirm={onConfirm} onCancel={onCancel} />);

    await user.click(screen.getByRole('button', { name: '先不用' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('disables both actions while the ledger write is in flight', () => {
    render(<ConsentDialog subject={subject} busy onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByRole('button', { name: '正在启用…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '先不用' })).toBeDisabled();
  });

  it('states that no permissions were declared instead of showing an empty list', () => {
    render(<ConsentDialog subject={{ ...subject, permissions: [] }} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText('没有声明任何服务权限')).toBeInTheDocument();
  });
});

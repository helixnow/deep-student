import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createWorkshopIntegration } from '../../plugin-workshop/integration';
import type { WorkshopAdapter, WorkshopItem } from '../../plugin-workshop/types';
import { PluginManagerPanel } from '../PluginManagerPanel';
import { PluginManagerController } from '../controller';
import { registerPluginManagerWorkshop } from '../workshop';
import { FakePluginManagerAdapter } from './fixtures';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  ...(await import('./i18nMock')).i18nMock(),
}));

describe('P2/P4 composition', () => {
  it('mounts the actual P4 creations and session callbacks when root ports arrive, then revokes them', async () => {
    const item: WorkshopItem = { id: 'workshop.notes', proposalId: 'work-1', revision: 1, name: '复习工具', version: '1.0.0', capabilities: [], changes: [], trust: 'full', phase: 'ready', visualVerified: false };
    const adapter: WorkshopAdapter = { list: vi.fn().mockResolvedValue([item]), get: vi.fn(), act: vi.fn().mockResolvedValue({ item: { ...item, phase: 'installed' } }), subscribe: () => () => undefined };
    const sessions = { bindSession: vi.fn().mockResolvedValue(undefined), create: vi.fn().mockResolvedValue({ id: 'new-workshop-session' }), activateSkill: vi.fn().mockResolvedValue(true), navigate: vi.fn() };
    const integration = createWorkshopIntegration({ adapter, sessions, reportError: vi.fn() });
    const view = render(<PluginManagerPanel controller={new PluginManagerController(new FakePluginManagerAdapter([]))} />);
    const user = userEvent.setup();
    expect(screen.getByRole('button', { name: '用 AI 创作插件' })).toBeDisabled();
    let revoke!: () => void;
    act(() => { revoke = registerPluginManagerWorkshop(integration.workshop); });
    try {
      await user.click(screen.getByRole('button', { name: '用 AI 创作插件' }));
      await waitFor(() => expect(sessions.navigate).toHaveBeenCalledWith('new-workshop-session'));
      await user.click(screen.getByRole('radio', { name: '我的创作' }));
      await user.click(await screen.findByRole('button', { name: '创建/安装' }));
      await waitFor(() => expect(adapter.act).toHaveBeenCalledWith('confirm', item));
      act(revoke);
      expect(screen.getByRole('button', { name: '用 AI 创作插件' })).toBeDisabled();
      expect(screen.getByText(/插件工坊尚未接入/)).toBeInTheDocument();
    } finally { act(revoke); view.unmount(); }
  });
});

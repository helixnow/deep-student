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
  ...await (await import('./i18nMock')).i18nMock(),
}));

describe('P2/P4 composition', () => {
  it('mounts the actual P4 creations and session callbacks when root ports arrive, then revokes them', async () => {
    const item: WorkshopItem = { id: 'workshop.notes', proposalId: 'work-1', revision: 1, name: '复习工具', version: '1.0.0', capabilities: [], changes: [], trust: 'full', phase: 'ready' };
    const adapter: WorkshopAdapter = { list: vi.fn().mockResolvedValue([item]), get: vi.fn(), act: vi.fn().mockResolvedValue({ item: { ...item, phase: 'installed' } }), subscribe: () => () => undefined };
    const sessions = { bindSession: vi.fn().mockResolvedValue(undefined), create: vi.fn().mockResolvedValue({ id: 'new-workshop-session' }), activateSkill: vi.fn().mockResolvedValue(true), navigate: vi.fn(), prefill: vi.fn() };
    const integration = createWorkshopIntegration({ adapter, sessions, reportError: vi.fn() });
    const view = render(<PluginManagerPanel controller={new PluginManagerController(new FakePluginManagerAdapter([]))} />);
    const user = userEvent.setup();
    expect(await screen.findByTestId('plugin-create')).toBeDisabled();
    expect(screen.getAllByTestId('plugin-starter').every((starter) => starter.hasAttribute('disabled'))).toBe(true);
    expect(screen.getByTestId('plugin-workshop-pending')).toBeInTheDocument();
    let revoke!: () => void;
    act(() => { revoke = registerPluginManagerWorkshop(integration.workshop); });
    try {
      await user.click(screen.getByTestId('plugin-create'));
      await waitFor(() => expect(sessions.navigate).toHaveBeenCalledWith('new-workshop-session'));
      expect(sessions.prefill).not.toHaveBeenCalled();
      // A starter opens a fresh workshop conversation with that sentence as an editable draft (never sent).
      await user.click(screen.getAllByTestId('plugin-starter')[1]!);
      await waitFor(() => expect(sessions.prefill).toHaveBeenCalledWith('new-workshop-session', '选中一段话时，多一个「编成口诀」按钮'));
      // Something waits for the user: 「工坊创作记录」 is already open.
      await user.click(await screen.findByRole('button', { name: '安装' }));
      await waitFor(() => expect(adapter.act).toHaveBeenCalledWith('confirm', item));
      act(revoke);
      expect(screen.getByTestId('plugin-create')).toBeDisabled();
      expect(screen.getByText(/插件工坊尚未接入/)).toBeInTheDocument();
    } finally { act(revoke); view.unmount(); }
  });
});

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/utils/platform', () => ({ isMobilePlatform: () => false }));
vi.mock('@/components/WindowControls', () => ({ WindowControls: () => null }));
vi.mock('../dataRecoveryApi', () => ({
  exportStartupRecoveryReport: vi.fn(async () => null),
  retryRecoveryStartup: vi.fn(),
}));

import { ComponentRecoveryShell } from '../ComponentRecoveryShell';

const renderShell = () => render(<ComponentRecoveryShell components={[{ component: 'notes', status: 'degraded', reason: 'locked' }]} />);

// Rust 版：两个标签只是普通 <button>，读屏软件不知道它们是一组标签页、哪一个被选中，面板也没有归属。
describe('RF-W09-recovery-shell-tab-roles: ComponentRecoveryShell tabs', () => {
  it('exposes a labelled tablist with selectable tabs and a panel owned by the selected tab', () => {
    renderShell();
    const list = screen.getByRole('tablist', { name: 'data:recovery.component_recovery_title' });
    expect(list).toHaveAttribute('aria-orientation', 'horizontal');
    const [status, next] = within(list).getAllByRole('tab');
    expect(status).toHaveAccessibleName('data:recovery.component_tab_status');
    expect(status).toHaveAttribute('aria-selected', 'true');
    expect(status).toHaveAttribute('tabindex', '0');
    expect(next).toHaveAccessibleName('data:recovery.component_tab_next');
    expect(next).toHaveAttribute('aria-selected', 'false');
    expect(next).toHaveAttribute('tabindex', '-1');
    expect(next).not.toHaveAttribute('aria-controls');

    const panel = screen.getByRole('tabpanel', { name: 'data:recovery.component_tab_status' });
    expect(status.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel).toHaveTextContent('locked');

    fireEvent.click(next);
    expect(next).toHaveAttribute('aria-selected', 'true');
    expect(status).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel', { name: 'data:recovery.component_tab_next' })).toHaveTextContent('data:recovery.component_next_title');
  });

  it('arrow keys, Home and End move focus and selection between the tabs', () => {
    renderShell();
    const [status, next] = screen.getAllByRole('tab');
    status.focus();
    fireEvent.keyDown(status, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(next);
    expect(next).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(next, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(status);
    expect(status).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(status, { key: 'ArrowLeft' });
    expect(next).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(next, { key: 'Home' });
    expect(status).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(status, { key: 'End' });
    expect(next).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(next, { key: 'ArrowLeft', metaKey: true });
    expect(next).toHaveAttribute('aria-selected', 'true');
  });
});

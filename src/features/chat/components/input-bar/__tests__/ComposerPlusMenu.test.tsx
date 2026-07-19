import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ComposerPlusMenu } from '../ComposerPlusMenu';

describe('ComposerPlusMenu', () => {
  it('opens mode flyout with plan/ask switches and persists craft when both off', async () => {
    const onAuthorityModeChange = vi.fn();
    render(
      <ComposerPlusMenu
        open
        onOpenChange={() => undefined}
        attachmentCount={0}
        iconButtonClass=""
        onAddAttachment={() => undefined}
        onOpenResourceLibrary={() => undefined}
        sessionId="sess_1"
        authorityMode="craft"
        onAuthorityModeChange={onAuthorityModeChange}
      />,
    );

    fireEvent.click(screen.getByTestId('plus-menu-mode'));
    expect(await screen.findByTestId('plus-menu-mode-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('plus-menu-mode-plan'));
    await waitFor(() => {
      expect(onAuthorityModeChange).toHaveBeenCalledWith('plan');
    });
  });

  it('embeds skill panel under skills submenu and keeps test id for the entry', async () => {
    render(
      <ComposerPlusMenu
        open
        onOpenChange={() => undefined}
        attachmentCount={0}
        iconButtonClass=""
        onAddAttachment={() => undefined}
        onOpenResourceLibrary={() => undefined}
        renderSkillPanel={() => <div data-testid="skill-menu-body">skills</div>}
        activeSkillCount={2}
      />,
    );

    fireEvent.click(screen.getByTestId('btn-toggle-skill'));
    expect(await screen.findByTestId('skill-menu-body')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('opens connectors via submenu action', async () => {
    const onOpenMcpPanel = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ComposerPlusMenu
        open
        onOpenChange={onOpenChange}
        attachmentCount={0}
        iconButtonClass=""
        onAddAttachment={() => undefined}
        onOpenResourceLibrary={() => undefined}
        renderMcpPanel={() => <div>mcp</div>}
        onOpenMcpPanel={onOpenMcpPanel}
      />,
    );

    fireEvent.click(screen.getByTestId('plus-menu-connectors'));
    fireEvent.click(await screen.findByTestId('plus-menu-open-connectors'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenMcpPanel).toHaveBeenCalled();
  });
});

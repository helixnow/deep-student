import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ComposerPlusMenu } from '../ComposerPlusMenu';
import { modeRegistry, resolveSessionFeatureFlags } from '../../../registry/modeRegistry';

describe('ComposerPlusMenu', () => {
  it('focuses exclusively on context & extension items (files / KB / skills / connectors) after runtime controls moved to T3 model selector footer', () => {
    render(
      <ComposerPlusMenu
        open
        onOpenChange={() => undefined}
        attachmentCount={0}
        iconButtonClass=""
        onAddAttachment={() => undefined}
        onOpenResourceLibrary={() => undefined}
        sessionId="sess_1"
        permissionPreset="relaxed"
        onPermissionPresetChange={() => undefined}
        knowledgeBaseProactive={false}
        onKnowledgeBaseProactiveChange={() => undefined}
        ragEnabled
        onRagEnabledChange={() => undefined}
        webSearchEnabled
        onWebSearchEnabledChange={() => undefined}
        onOpenAdvancedPanel={() => undefined}
        onTogglePluginWorkshop={() => undefined}
        renderSkillPanel={() => <div>skills</div>}
        renderMcpPanel={() => <div>mcp</div>}
        onOpenMcpPanel={() => undefined}
      />,
    );

    expect(screen.getByTestId('plus-menu-add-file')).toBeInTheDocument();
    expect(screen.getByTestId('plus-menu-knowledge-base')).toBeInTheDocument();
    expect(screen.getByTestId('btn-toggle-skill')).toBeInTheDocument();
    expect(screen.getByTestId('plus-menu-connectors')).toBeInTheDocument();

    // Runtime controls now live in T3ModelSelectorPopover's bottom footer bar
    expect(screen.queryByTestId('plus-menu-mode')).not.toBeInTheDocument();
    expect(screen.queryByTestId('plus-menu-web-search')).not.toBeInTheDocument();
    expect(screen.queryByTestId('plus-menu-advanced')).not.toBeInTheDocument();
    expect(screen.queryByTestId('plus-menu-plugin-workshop')).not.toBeInTheDocument();
  });

  it('shows compact inline downgrade chips while elevated presets are active', async () => {
    const onPermissionPresetChange = vi.fn();
    const { rerender } = render(
      <ComposerPlusMenu
        open={false}
        onOpenChange={() => undefined}
        attachmentCount={0}
        iconButtonClass=""
        onAddAttachment={() => undefined}
        onOpenResourceLibrary={() => undefined}
        sessionId="sess_1"
        permissionPreset="full_access"
        onPermissionPresetChange={onPermissionPresetChange}
      />,
    );

    const fullAccessChip = screen.getByTestId('full-access-active');
    expect(fullAccessChip.className).toContain('inline-flex');
    expect(fullAccessChip.textContent ?? '').not.toMatch(/点击降为宽松|click to downgrade/i);
    fireEvent.click(fullAccessChip);
    await waitFor(() => {
      expect(onPermissionPresetChange).toHaveBeenCalledWith('relaxed');
    });

    rerender(
      <ComposerPlusMenu
        open={false}
        onOpenChange={() => undefined}
        attachmentCount={0}
        iconButtonClass=""
        onAddAttachment={() => undefined}
        onOpenResourceLibrary={() => undefined}
        sessionId="sess_1"
        permissionPreset="danger_full_access"
        onPermissionPresetChange={onPermissionPresetChange}
      />,
    );
    expect(screen.getByTestId('danger-full-access-active')).toBeInTheDocument();
    expect(screen.queryByTestId('full-access-active')).not.toBeInTheDocument();
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

  it('toggles knowledge base proactive retrieval from its submenu', async () => {
    const onKnowledgeBaseProactiveChange = vi.fn();
    render(
      <ComposerPlusMenu
        open
        onOpenChange={() => undefined}
        attachmentCount={0}
        iconButtonClass=""
        onAddAttachment={() => undefined}
        onOpenResourceLibrary={() => undefined}
        knowledgeBaseProactive={false}
        onKnowledgeBaseProactiveChange={onKnowledgeBaseProactiveChange}
      />,
    );

    fireEvent.click(screen.getByTestId('plus-menu-knowledge-base'));
    expect(await screen.findByTestId('plus-menu-knowledge-base-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('plus-menu-kb-proactive'));
    await waitFor(() => {
      expect(onKnowledgeBaseProactiveChange).toHaveBeenCalledWith(true);
    });
  });

  it('toggles RAG capability switch and disables proactive KB when RAG is off', async () => {
    const onRagEnabledChange = vi.fn();
    const onKnowledgeBaseProactiveChange = vi.fn();
    const { rerender } = render(
      <ComposerPlusMenu
        open
        onOpenChange={() => undefined}
        attachmentCount={0}
        iconButtonClass=""
        onAddAttachment={() => undefined}
        onOpenResourceLibrary={() => undefined}
        knowledgeBaseProactive={false}
        onKnowledgeBaseProactiveChange={onKnowledgeBaseProactiveChange}
        ragEnabled
        onRagEnabledChange={onRagEnabledChange}
      />,
    );

    fireEvent.click(screen.getByTestId('plus-menu-knowledge-base'));
    expect(await screen.findByTestId('plus-menu-knowledge-base-panel')).toBeInTheDocument();
    const ragToggle = screen.getByTestId('plus-menu-rag');
    expect(ragToggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(ragToggle);
    expect(onRagEnabledChange).toHaveBeenCalledWith(false);

    rerender(
      <ComposerPlusMenu
        open
        onOpenChange={() => undefined}
        attachmentCount={0}
        iconButtonClass=""
        onAddAttachment={() => undefined}
        onOpenResourceLibrary={() => undefined}
        knowledgeBaseProactive={false}
        onKnowledgeBaseProactiveChange={onKnowledgeBaseProactiveChange}
        ragEnabled={false}
        onRagEnabledChange={onRagEnabledChange}
      />,
    );

    expect(screen.getByTestId('plus-menu-kb-proactive')).toHaveAttribute('aria-disabled', 'true');
  });

  it('keeps sibling submenus mutually exclusive when opened by click', async () => {
    render(
      <ComposerPlusMenu
        open
        onOpenChange={() => undefined}
        attachmentCount={0}
        iconButtonClass=""
        onAddAttachment={() => undefined}
        onOpenResourceLibrary={() => undefined}
        knowledgeBaseProactive={false}
        onKnowledgeBaseProactiveChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByTestId('plus-menu-add-file'));
    expect(await screen.findByTestId('plus-menu-add-attachment')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('plus-menu-knowledge-base'));
    expect(await screen.findByTestId('plus-menu-knowledge-base-panel')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId('plus-menu-add-attachment')).not.toBeInTheDocument();
    });
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

  it('keeps active Plugin Workshop exit pill visible on the toolbar when active', () => {
    const onTogglePluginWorkshop = vi.fn();
    render(
      <ComposerPlusMenu
        open={false}
        onOpenChange={() => undefined}
        attachmentCount={0}
        iconButtonClass=""
        onAddAttachment={() => undefined}
        onOpenResourceLibrary={() => undefined}
        pluginWorkshopActive
        onTogglePluginWorkshop={onTogglePluginWorkshop}
      />,
    );

    const activePill = screen.getByTestId('plugin-workshop-active');
    expect(activePill).toBeInTheDocument();
    fireEvent.click(activePill);
    expect(onTogglePluginWorkshop).toHaveBeenCalledTimes(1);
  });

  describe('mobile flat menu', () => {
    it('renders file actions and knowledge base controls directly in a clean flat menu', () => {
      const onAddAttachment = vi.fn();
      const onRagEnabledChange = vi.fn();
      const onOpenChange = vi.fn();
      render(
        <ComposerPlusMenu
          open
          isMobile
          onOpenChange={onOpenChange}
          attachmentCount={0}
          iconButtonClass=""
          onAddAttachment={onAddAttachment}
          onOpenResourceLibrary={() => undefined}
          sessionId="sess_1"
          ragEnabled
          onRagEnabledChange={onRagEnabledChange}
          knowledgeBaseProactive={false}
          onKnowledgeBaseProactiveChange={() => undefined}
        />,
      );

      expect(screen.queryByTestId('plus-menu-add-file')).not.toBeInTheDocument();
      expect(screen.queryByTestId('plus-menu-mode')).not.toBeInTheDocument();
      expect(screen.getByTestId('plus-menu-resource-library')).toBeInTheDocument();
      expect(screen.getByTestId('plus-menu-rag')).toBeInTheDocument();
      expect(screen.getByTestId('plus-menu-kb-proactive')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('plus-menu-rag'));
      expect(onRagEnabledChange).toHaveBeenCalledWith(false);

      fireEvent.click(screen.getByTestId('plus-menu-add-attachment'));
      expect(onAddAttachment).toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('opens the inline skill panel instead of embedding it in a flyout', () => {
      const onOpenSkillPanel = vi.fn();
      const onOpenChange = vi.fn();
      render(
        <ComposerPlusMenu
          open
          isMobile
          onOpenChange={onOpenChange}
          attachmentCount={0}
          iconButtonClass=""
          onAddAttachment={() => undefined}
          onOpenResourceLibrary={() => undefined}
          renderSkillPanel={() => <div data-testid="skill-menu-body">skills</div>}
          onOpenSkillPanel={onOpenSkillPanel}
          activeSkillCount={2}
        />,
      );

      expect(screen.queryByTestId('skill-menu-body')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('btn-toggle-skill'));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onOpenSkillPanel).toHaveBeenCalled();
      expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('opens connectors directly from the flat list', () => {
      const onOpenMcpPanel = vi.fn();
      const onOpenChange = vi.fn();
      render(
        <ComposerPlusMenu
          open
          isMobile
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
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onOpenMcpPanel).toHaveBeenCalled();
    });
  });

  it('resolveSessionFeatureFlags inherits mode defaults and respects explicit session overrides', () => {
    const spy = vi.spyOn(modeRegistry, 'getResolved').mockReturnValue({
      name: 'chat',
      displayName: 'Chat',
      config: {
        requiresOcr: false,
        autoStartFirstMessage: false,
        enabledTools: ['rag', 'web_search', 'memory'],
      },
    } as any);
    try {
      expect(resolveSessionFeatureFlags({ mode: 'chat', features: new Map() })).toEqual({
        ragEnabled: true,
        memoryEnabled: true,
        webSearchEnabled: true,
        ankiEnabled: false,
      });
      expect(
        resolveSessionFeatureFlags({
          mode: 'chat',
          features: new Map([
            ['rag', false],
            ['webSearch', false],
          ]),
        }),
      ).toEqual({
        ragEnabled: false,
        memoryEnabled: true,
        webSearchEnabled: false,
        ankiEnabled: false,
      });
    } finally {
      spy.mockRestore();
    }
  });
});

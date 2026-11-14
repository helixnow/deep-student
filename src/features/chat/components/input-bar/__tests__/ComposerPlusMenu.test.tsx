import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ComposerPlusMenu } from '../ComposerPlusMenu';
import { modeRegistry, resolveSessionFeatureFlags } from '../../../registry/modeRegistry';

describe('ComposerPlusMenu', () => {
  it('opens mode flyout with permission presets and no plan/ask switches', async () => {
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
      />,
    );

    fireEvent.click(screen.getByTestId('plus-menu-mode'));
    expect(await screen.findByTestId('plus-menu-mode-panel')).toBeInTheDocument();
    expect(screen.getByTestId('plus-menu-permission-cautious')).toBeInTheDocument();
    expect(screen.getByTestId('plus-menu-permission-relaxed')).toBeInTheDocument();
    expect(screen.queryByTestId('plus-menu-mode-plan')).not.toBeInTheDocument();
    expect(screen.queryByTestId('plus-menu-mode-ask')).not.toBeInTheDocument();
  });

  it('shows all Craft presets and confirms danger full access before persisting', async () => {
    const onPermissionPresetChange = vi.fn();
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
        onPermissionPresetChange={onPermissionPresetChange}
      />,
    );

    fireEvent.click(screen.getByTestId('plus-menu-mode'));
    expect(await screen.findByTestId('plus-menu-permission-full_access')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('plus-menu-permission-danger_full_access'));
    expect(onPermissionPresetChange).not.toHaveBeenCalled();

    const confirmButton = screen.getAllByRole('button').find((button) => (
      /enable danger full access|确认开启危险完全访问|dangerConfirmAction/i
        .test(button.textContent ?? '')
    ));
    expect(confirmButton).toBeDefined();
    fireEvent.click(confirmButton!);
    await waitFor(() => {
      expect(onPermissionPresetChange).toHaveBeenCalledWith('danger_full_access', true);
    });
  });

  it('shows compact inline downgrade chips while elevated presets are active', () => {
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
    expect(onPermissionPresetChange).toHaveBeenCalledWith('relaxed', undefined);

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

  it('toggles RAG and WebSearch capability switches and disables proactive KB when RAG is off', async () => {
    const onRagEnabledChange = vi.fn();
    const onWebSearchEnabledChange = vi.fn();
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
        webSearchEnabled
        onWebSearchEnabledChange={onWebSearchEnabledChange}
      />,
    );

    const webSearchToggle = screen.getByTestId('plus-menu-web-search');
    expect(webSearchToggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(webSearchToggle);
    expect(onWebSearchEnabledChange).toHaveBeenCalledWith(false);

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
        webSearchEnabled={false}
        onWebSearchEnabledChange={onWebSearchEnabledChange}
      />,
    );

    expect(screen.getByTestId('plus-menu-kb-proactive')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('plus-menu-web-search')).toHaveAttribute('aria-checked', 'false');
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
        sessionId="sess_1"
        permissionPreset="relaxed"
        onPermissionPresetChange={() => undefined}
        knowledgeBaseProactive={false}
        onKnowledgeBaseProactiveChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByTestId('plus-menu-mode'));
    expect(await screen.findByTestId('plus-menu-mode-panel')).toBeInTheDocument();

    // 打开知识库子菜单后，模式子菜单应自动收合
    fireEvent.click(screen.getByTestId('plus-menu-knowledge-base'));
    expect(await screen.findByTestId('plus-menu-knowledge-base-panel')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId('plus-menu-mode-panel')).not.toBeInTheDocument();
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

  it('toggles Plugin Workshop mode from the plus menu and shows active pill', () => {
    const onTogglePluginWorkshop = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ComposerPlusMenu
        open
        onOpenChange={onOpenChange}
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
    fireEvent.click(screen.getByTestId('plus-menu-plugin-workshop'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onTogglePluginWorkshop).toHaveBeenCalledTimes(1);
    fireEvent.click(activePill);
    expect(onTogglePluginWorkshop).toHaveBeenCalledTimes(2);
  });

  // 📱 移动端根层只放动作；模式/档位/知识库进入二级面板
  describe('mobile flat menu', () => {
    it('renders file actions at the top level and nests mode controls behind a second page', () => {
      const onAddAttachment = vi.fn();
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
          permissionPreset="relaxed"
          onPermissionPresetChange={() => undefined}
          knowledgeBaseProactive={false}
          onKnowledgeBaseProactiveChange={() => undefined}
        />,
      );

      expect(screen.queryByTestId('plus-menu-add-file')).not.toBeInTheDocument();
      expect(screen.getByTestId('plus-menu-mode')).toBeInTheDocument();
      expect(screen.getByTestId('plus-menu-resource-library')).toBeInTheDocument();
      expect(screen.queryByTestId('plus-menu-mode-plan')).not.toBeInTheDocument();
      expect(screen.queryByTestId('plus-menu-kb-proactive')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('plus-menu-add-attachment'));
      expect(onAddAttachment).toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);

      fireEvent.click(screen.getByTestId('plus-menu-mode'));
      expect(screen.queryByTestId('plus-menu-mode-plan')).not.toBeInTheDocument();
      expect(screen.queryByTestId('plus-menu-mode-ask')).not.toBeInTheDocument();
      expect(screen.getByTestId('plus-menu-permission-relaxed')).toBeInTheDocument();
      expect(screen.getByTestId('plus-menu-kb-proactive')).toBeInTheDocument();
      expect(onOpenChange).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId('plus-menu-mode-back'));
      expect(screen.queryByTestId('plus-menu-permission-relaxed')).not.toBeInTheDocument();
      expect(screen.getByTestId('plus-menu-add-attachment')).toBeInTheDocument();
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

      // 技能面板内容不再内嵌在菜单里
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

    it('exposes rag inside mobile mode pane and webSearch at mobile root', () => {
      const onRagEnabledChange = vi.fn();
      const onWebSearchEnabledChange = vi.fn();
      render(
        <ComposerPlusMenu
          open
          isMobile
          onOpenChange={() => undefined}
          attachmentCount={0}
          iconButtonClass=""
          onAddAttachment={() => undefined}
          onOpenResourceLibrary={() => undefined}
          sessionId="sess_1"
          permissionPreset="relaxed"
          onPermissionPresetChange={() => undefined}
          ragEnabled
          onRagEnabledChange={onRagEnabledChange}
          webSearchEnabled={false}
          onWebSearchEnabledChange={onWebSearchEnabledChange}
        />,
      );

      fireEvent.click(screen.getByTestId('plus-menu-web-search'));
      expect(onWebSearchEnabledChange).toHaveBeenCalledWith(true);

      fireEvent.click(screen.getByTestId('plus-menu-mode'));
      fireEvent.click(screen.getByTestId('plus-menu-rag'));
      expect(onRagEnabledChange).toHaveBeenCalledWith(false);
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

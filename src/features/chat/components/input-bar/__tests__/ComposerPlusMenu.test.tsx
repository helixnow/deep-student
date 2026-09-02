import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ComposerPlusMenu } from '../ComposerPlusMenu';

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
      expect(onPermissionPresetChange).toHaveBeenCalledWith('danger_full_access');
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
    expect(onPermissionPresetChange).toHaveBeenCalledWith('relaxed');

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
  });
});

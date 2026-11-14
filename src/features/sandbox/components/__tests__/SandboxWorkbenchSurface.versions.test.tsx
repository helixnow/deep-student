import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, dstuCreateMock, notifyMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  dstuCreateMock: vi.fn(),
  notifyMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/dstu', () => ({
  dstu: {
    create: dstuCreateMock,
  },
  sanitizeName: (raw: string) => raw.trim().replace(/[<>:"|?*\\/]/g, '_'),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: notifyMock,
}));

import { SandboxWorkbenchSurface } from '../SandboxWorkbenchSurface';
import { pinArtifactToCanvas } from '../../launchSandboxWorkbench';
import {
  LEGACY_SANDBOX_OWNER_KEY,
  useSandboxWorkbenchStore,
} from '../../store/useSandboxWorkbenchStore';
import { usePinnedArtifactStore } from '@/stores/pinnedArtifactStore';
import { registerArtifactRenderer } from '@/components/previews/artifactRendererRegistry';
import { clearWidgetLocalState, saveWidgetLocalState } from '@/components/previews/widgetLocalState';
import { CodeBlock } from '@/features/chat/components/renderers/CodeBlock';
import { GenerativeUIBlockComponent } from '@/features/chat/plugins/blocks/generativeUI';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import type { Block } from '@/features/chat/core/types/block';

const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

describe('SandboxWorkbenchSurface Pinned Artifact Versions & Save Actions', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearWidgetLocalState({ widgetId: 'widget-surface-html' });
    invokeMock.mockReset();
    dstuCreateMock.mockReset();
    notifyMock.mockReset();
    usePinnedArtifactStore.getState().resetPinnedArtifacts();
    useSandboxWorkbenchStore.setState({
      activeSession: null,
      isOpen: false,
      viewportPreset: 'desktop',
      inspectorOpen: false,
      ownerStates: {},
      activeOwnerKey: LEGACY_SANDBOX_OWNER_KEY,
    });
  });

  it('renders v1/v2 font-mono tabular-nums capsules, switches preview content across versions, syncs widget status dot, and contains zero emojis', () => {
    const ownerKey = 'sandbox:chat:sess_ver';
    const v1Html = '<div class="ds-box">Version One Content</div>';
    const v2Html = '<div class="ds-box">Version Two Content</div>';

    const rec = pinArtifactToCanvas(
      {
        kind: 'html',
        language: 'html-interactive',
        title: '简谐运动画布',
        content: v1Html,
        widgetId: 'widget-surface-html',
        sessionId: 'sess_ver',
        groupId: 'grp_ver',
      },
      ownerKey,
    );

    usePinnedArtifactStore.getState().applyPatchToArtifact(rec.artifactId, {
      search: 'Version One Content',
      replace: 'Version Two Content',
    });

    const { container } = render(<SandboxWorkbenchSurface embedded ownerKey={ownerKey} />);

    const pillV1 = screen.getByTestId('sandbox-version-pill-v1');
    const pillV2 = screen.getByTestId('sandbox-version-pill-v2');

    expect(pillV1).toHaveTextContent('v1');
    expect(pillV2).toHaveTextContent('v2');
    expect(pillV1).toHaveClass('font-mono', 'tabular-nums');
    expect(pillV2).toHaveClass('font-mono', 'tabular-nums');
    expect(pillV2).toHaveAttribute('aria-pressed', 'true');
    expect(pillV2.className).toContain('border-primary/40');
    expect(pillV2.className).toContain('bg-primary/10');

    // InteractiveHtmlCanvas iframe strictly keeps sandbox="allow-scripts" without allow-same-origin
    const iframe = container.querySelector('iframe.interactive-html-canvas-frame');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe?.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe?.getAttribute('srcdoc')).toContain('Version Two Content');

    // Status dot starts in default primary state until widgetLocalState.modelContent is reported
    const statusDot = screen.getByTestId('sandbox-artifact-status-dot');
    expect(statusDot).toHaveClass('h-1.5', 'w-1.5', 'rounded-full', 'bg-primary');
    expect(screen.queryByTestId('sandbox-state-synced-badge')).toBeNull();

    // Reporting modelContent switches status dot to success and shows synced badge
    act(() => {
      saveWidgetLocalState(
        { widgetId: 'widget-surface-html', source: v2Html },
        { modelContent: { amplitude: 2.4 } },
      );
    });
    expect(screen.getByTestId('sandbox-artifact-status-dot').className).toContain(
      'bg-[hsl(var(--success))]',
    );
    expect(screen.getByTestId('sandbox-state-synced-badge')).toBeInTheDocument();

    // Clicking v1 switches preview back to v1 content
    fireEvent.click(pillV1);
    expect(pillV1).toHaveAttribute('aria-pressed', 'true');
    expect(pillV2).toHaveAttribute('aria-pressed', 'false');
    expect(
      container.querySelector('iframe.interactive-html-canvas-frame')?.getAttribute('srcdoc'),
    ).toContain('Version One Content');

    // Clicking v2 restores v2 content
    fireEvent.click(pillV2);
    expect(pillV2).toHaveAttribute('aria-pressed', 'true');
    expect(
      container.querySelector('iframe.interactive-html-canvas-frame')?.getAttribute('srcdoc'),
    ).toContain('Version Two Content');

    // Strict zero-emoji check on rendered DOM text
    expect(EMOJI_PATTERN.test(container.textContent ?? '')).toBe(false);
  });

  it('renders custom registered openui artifact versions and triggers saveArtifactToStudySpace on [存入空间]', async () => {
    registerArtifactRenderer('openui', ({ content }) => (
      <div data-testid="mock-openui-view">{content}</div>
    ));

    dstuCreateMock.mockResolvedValue({
      ok: true,
      value: {
        id: 'note_saved_99',
        name: '收敛曲线图',
        path: '/note_saved_99',
        type: 'note',
      },
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'chat_v2_get_group') {
        return { id: 'grp_1', pinnedResourceIds: [] };
      }
      return { id: 'grp_1', pinnedResourceIds: ['note_saved_99'] };
    });

    const ownerKey = 'sandbox:chat:sess_openui';
    const record = pinArtifactToCanvas(
      {
        kind: 'openui',
        language: 'openui-lang',
        title: '收敛曲线图',
        content: 'root = Stack([Stat("epoch", "10")])',
        sessionId: 'sess_openui',
        groupId: 'grp_1',
      },
      ownerKey,
    );
    usePinnedArtifactStore.getState().applyPatchToArtifact(record.artifactId, {
      search: '"10"',
      replace: '"20"',
    });

    const { container } = render(<SandboxWorkbenchSurface embedded ownerKey={ownerKey} />);

    expect(screen.getByTestId('mock-openui-view')).toHaveTextContent('20');

    fireEvent.click(screen.getByTestId('sandbox-version-pill-v1'));
    expect(screen.getByTestId('mock-openui-view')).toHaveTextContent('10');

    fireEvent.click(screen.getByTestId('sandbox-save-to-space-button'));

    await waitFor(() => {
      expect(dstuCreateMock).toHaveBeenCalledTimes(1);
    });
    expect(dstuCreateMock).toHaveBeenCalledWith(
      '/',
      expect.objectContaining({
        type: 'note',
        name: '收敛曲线图',
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_update_group', {
      groupId: 'grp_1',
      request: { pinnedResourceIds: ['note_saved_99'] },
    });
    expect(EMOJI_PATTERN.test(container.textContent ?? '')).toBe(false);
  });

  it('pins InteractiveHtmlCanvas, openui-lang CodeBlock, and GenerativeUIBlockComponent from chat directly into SandboxWorkbenchSurface', async () => {
    sessionManager.setCurrentSessionId('sess_e2e');
    dstuCreateMock.mockResolvedValue({
      ok: true,
      value: {
        id: 'note_genui_1',
        name: '傅里叶频谱指标',
        path: '/note_genui_1',
        type: 'note',
      },
    });

    // 1. html-interactive CodeBlock -> click [固定到画布]
    const { unmount: unmountHtml } = render(
      <CodeBlock className="language-html-interactive">
        {'<!DOCTYPE html><html><head><title>频谱实验台</title></head><body><div>Live Spectrum</div></body></html>'}
      </CodeBlock>,
    );
    fireEvent.click(screen.getByTestId('canvas-pin-button'));
    expect(
      usePinnedArtifactStore.getState().getActiveArtifactForSession('sess_e2e')?.title,
    ).toBe('频谱实验台');
    unmountHtml();

    // 2. GenerativeUIBlockComponent -> click [固定到画布] & [存入空间], then render SandboxWorkbenchSurface
    const genUiBlock: Block = {
      id: 'blk_genui_1',
      type: 'generative_ui',
      status: 'success',
      messageId: 'msg_genui_1',
      toolOutput: {
        intent: {
          version: '1.0',
          meta: { title: '傅里叶频谱指标' },
          blocks: [
            {
              id: 'stat-1',
              type: 'stat-card',
              props: { title: '主频峰值', value: '440 Hz' },
            },
          ],
        },
      },
    };

    const { container: chatContainer, unmount: unmountGenUi } = render(
      <GenerativeUIBlockComponent block={genUiBlock} isStreaming={false} />,
    );
    expect(EMOJI_PATTERN.test(chatContainer.textContent ?? '')).toBe(false);

    fireEvent.click(screen.getByTestId('generative-ui-pin-button'));
    fireEvent.click(screen.getByTestId('generative-ui-save-space-button'));

    await waitFor(() => {
      expect(dstuCreateMock).toHaveBeenCalledTimes(1);
    });
    unmountGenUi();

    const activeGenUi = usePinnedArtifactStore.getState().getActiveArtifactForSession('sess_e2e');
    expect(activeGenUi?.kind).toBe('generative-ui');
    expect(activeGenUi?.title).toBe('傅里叶频谱指标');

    const { container: surfaceContainer } = render(
      <SandboxWorkbenchSurface embedded ownerKey="sandbox:chat:sess_e2e" />,
    );
    expect(screen.getByTestId('sandbox-custom-artifact-generative-ui')).toHaveTextContent('440 Hz');
    expect(EMOJI_PATTERN.test(surfaceContainer.textContent ?? '')).toBe(false);
    sessionManager.setCurrentSessionId(null);
  });
});

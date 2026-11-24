import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));
vi.mock('@/dstu', () => ({
  dstu: { create: vi.fn() },
  sanitizeName: (raw: string) => raw.trim(),
}));

import {
  createStarterHtmlCanvasInput,
  launchSandboxWorkbench,
  normalizeWorkspaceArtifactPath,
} from '../../launchSandboxWorkbench';
import {
  LEGACY_SANDBOX_OWNER_KEY,
  useSandboxWorkbenchStore,
} from '../../store/useSandboxWorkbenchStore';
import { SandboxWorkbenchSurface } from '../SandboxWorkbenchSurface';

describe('Sandbox starter HTML canvas, path normalization, and sandbox-run upgrade (S3-08)', () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    useSandboxWorkbenchStore.setState({
      activeSession: null,
      isOpen: false,
      viewportPreset: 'desktop',
      inspectorOpen: false,
      ownerStates: {},
      sessionRevisionsByOwner: {},
      activeOwnerKey: LEGACY_SANDBOX_OWNER_KEY,
    });
  });

  it('normalizes relative workspace artifact paths cleanly', () => {
    expect(normalizeWorkspaceArtifactPath('sine-superposition/index.html')).toBe(
      'sine-superposition/index.html',
    );
    expect(normalizeWorkspaceArtifactPath('./sine-superposition/index.html')).toBe(
      'sine-superposition/index.html',
    );
    expect(normalizeWorkspaceArtifactPath('/already/normalized.html')).toBe(
      'already/normalized.html',
    );
    expect(normalizeWorkspaceArtifactPath('')).toBe('');
  });

  it('upgrades HTML launches to sandbox-run mode and keeps starter input emoji-free', () => {
    const starter = createStarterHtmlCanvasInput();
    expect(starter.artifactKind).toBe('html');
    expect(starter.initialMode).toBe('sandbox-run');
    expect(starter.content).toContain('<canvas');
    expect(starter.content).toContain('<script>');
    expect(/\p{Extended_Pictographic}/u.test(starter.title ?? '')).toBe(false);

    launchSandboxWorkbench({
      sourceType: 'chat-code-block',
      language: 'html',
      title: 'Inline Demo',
      content: '<div><script>window.__demo = 1;</script></div>',
      sourcePath: './sine-superposition/index.html',
    });

    const active = useSandboxWorkbenchStore.getState().activeSession;
    expect(active?.artifactKind).toBe('html');
    expect(active?.mode).toBe('sandbox-run');
    expect(active?.sourcePath).toBe('sine-superposition/index.html');
  });

  it('renders starter canvas button in empty state and mounts sandbox="allow-scripts" iframe cleanly', () => {
    render(<SandboxWorkbenchSurface />);

    const starterBtn = screen.getByTestId('sandbox-create-starter-button');
    expect(starterBtn).toHaveTextContent('新建 HTML 画布');
    fireEvent.click(starterBtn);

    const frame = document.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame?.getAttribute('srcdoc')).toContain('data-ds-sandbox-runtime-guard="1"');
  });

  it('tracks runtime errors via postMessage, bumps v1->v2 on Apply & Run, persists draft to localStorage, and renders allow-scripts inspector notice', () => {
    render(<SandboxWorkbenchSurface />);
    fireEvent.click(screen.getByTestId('sandbox-create-starter-button'));

    expect(screen.getByTestId('sandbox-runtime-status-badge')).toHaveTextContent('已运行 · v1');

    // Simulate runtime-error message posted from sandboxed iframe
    fireEvent(
      window,
      new MessageEvent('message', {
        data: {
          source: 'ds-sandbox-runtime',
          type: 'runtime-error',
          message: 'Uncaught ReferenceError: boom is not defined',
          lineno: 12,
          colno: 5,
        },
      }),
    );

    expect(screen.getByTestId('sandbox-runtime-status-badge')).toHaveTextContent('脚本错误');
    expect(screen.getByTestId('sandbox-runtime-error-message')).toHaveTextContent(
      'Uncaught ReferenceError: boom is not defined',
    );
    expect(screen.getByTestId('sandbox-runtime-error-message')).toHaveTextContent('12');

    // Switch to source view and Apply & Run new HTML
    fireEvent.click(screen.getByTestId('canvas-toggle-source'));
    const editor = screen.getByTestId('canvas-source-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '<div>Updated v2 HTML</div>' } });
    fireEvent.click(screen.getByTestId('canvas-run-source-button'));

    expect(screen.getByTestId('sandbox-runtime-status-badge')).toHaveTextContent('已运行 · v2');
    expect(screen.getByTestId('sandbox-version-pill-v2')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('sandbox-runtime-error-message')).toBeNull();

    // Verify expanded mode container enforces non-blocking CSS containment & header z-20
    const canvas = screen.getByTestId('sandbox-runtime-canvas');
    expect(canvas.className).toContain('[&_[data-expanded="true"]]:!relative');
    expect(screen.getByTestId('sandbox-artifact-header').className).toContain('z-20');

    // Open inspector and confirm allow-scripts security text
    const openInspectorBtn =
      screen.queryByTestId('sandbox-status-rail') ??
      screen.getByRole('button', { name: /检查器|属性面板|inspector/i });
    fireEvent.click(openInspectorBtn);
    expect(screen.getByTestId('sandbox-inspector-security-notice')).toHaveTextContent(
      '脚本执行已启用（allow-scripts · 无同源权限）',
    );

    // Simulate reload: reset Zustand in-memory state while keeping localStorage draft
    cleanup();
    useSandboxWorkbenchStore.setState({
      activeSession: null,
      isOpen: false,
      viewportPreset: 'desktop',
      inspectorOpen: false,
      ownerStates: {},
      sessionRevisionsByOwner: {},
      activeOwnerKey: LEGACY_SANDBOX_OWNER_KEY,
    });

    render(<SandboxWorkbenchSurface />);
    expect(screen.getByTestId('sandbox-runtime-status-badge')).toHaveTextContent('已运行 · v2');
    const restoredFrame = document.querySelector('iframe');
    expect(restoredFrame?.getAttribute('srcdoc')).toContain('Updated v2 HTML');

    // Reset returns to clean v1
    fireEvent.click(screen.getByTestId('sandbox-reset-button'));
    expect(screen.getByTestId('sandbox-runtime-status-badge')).toHaveTextContent('已运行 · v1');

    // Close session -> empty state offers "恢复上次草稿"
    act(() => {
      useSandboxWorkbenchStore.getState().closeSession();
    });
    expect(screen.getByTestId('sandbox-restore-draft-button')).toHaveTextContent('恢复上次草稿');
    fireEvent.click(screen.getByTestId('sandbox-restore-draft-button'));
    expect(screen.getByTestId('sandbox-runtime-status-badge')).toHaveTextContent('已运行 · v1');
  });
});

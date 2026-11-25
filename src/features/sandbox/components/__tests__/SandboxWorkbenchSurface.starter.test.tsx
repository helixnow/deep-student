import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

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
  adjustSandboxRuntimeErrorLine,
  applySmartLocalHtmlPatch,
} from '../../requestSandboxHtmlPatch';
import {
  LEGACY_SANDBOX_OWNER_KEY,
  useSandboxWorkbenchStore,
} from '../../store/useSandboxWorkbenchStore';
import { SandboxWorkbenchSurface } from '../SandboxWorkbenchSurface';

describe('Sandbox starter HTML canvas, path normalization, and sandbox-run upgrade (S3-08)', () => {
  beforeEach(() => {
    cleanup();
    invokeMock.mockReset();
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
    const restoredSrcDoc = restoredFrame?.getAttribute('srcdoc') ?? '';
    expect(restoredSrcDoc).toContain('Updated v2 HTML');
    expect(restoredSrcDoc).toContain('data-ds-sandbox-runtime-guard="1"');

    // Source editor displays clean user HTML without leaking runtime guard script
    fireEvent.click(screen.getByTestId('canvas-toggle-source'));
    const sourceEditor = screen.getByTestId('canvas-source-editor') as HTMLTextAreaElement;
    expect(sourceEditor.value).toContain('Updated v2 HTML');
    expect(sourceEditor.value).not.toContain('data-ds-sandbox-runtime-guard');

    // Reset requires two-step confirmation and allows non-destructive undo back to v2
    fireEvent.click(screen.getByTestId('sandbox-reset-button'));
    expect(screen.getByTestId('sandbox-reset-confirm-bar')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-runtime-status-badge')).toHaveTextContent('已运行 · v2');
    fireEvent.click(screen.getByTestId('sandbox-reset-confirm-button'));
    expect(screen.getByTestId('sandbox-runtime-status-badge')).toHaveTextContent('已运行 · v1');

    // Undo reset brings v2 back
    fireEvent.click(screen.getByTestId('sandbox-undo-reset-button'));
    expect(screen.getByTestId('sandbox-runtime-status-badge')).toHaveTextContent('已运行 · v2');

    // Confirm reset again before closing session to test persisted v1 restore
    fireEvent.click(screen.getByTestId('sandbox-reset-button'));
    fireEvent.click(screen.getByTestId('sandbox-reset-confirm-button'));
    expect(screen.getByTestId('sandbox-runtime-status-badge')).toHaveTextContent('已运行 · v1');

    // Close session -> empty state offers "恢复上次草稿"
    act(() => {
      useSandboxWorkbenchStore.getState().closeSession();
    });
    expect(screen.getByTestId('sandbox-restore-draft-button')).toHaveTextContent('恢复上次草稿');
    fireEvent.click(screen.getByTestId('sandbox-restore-draft-button'));
    expect(screen.getByTestId('sandbox-runtime-status-badge')).toHaveTextContent('已运行 · v1');
  });

  it('keeps canvas toolbar & range sliders unclipped across Inspector toggles and viewport switches, supports natural-language local edits, and adjusts runtime error line offsets (S3-08)', async () => {
    render(<SandboxWorkbenchSurface />);
    fireEvent.click(screen.getByTestId('sandbox-create-starter-button'));

    // Verify starter canvas contains interactive <input type="range"> controls and visible toolbar
    const iframe = document.querySelector('iframe.interactive-html-canvas-frame') as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute('srcdoc')).toContain('type="range"');
    expect(screen.getByTestId('canvas-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-toggle-edit')).toBeVisible();
    expect(screen.getByTestId('canvas-toggle-source')).toBeVisible();
    expect(screen.getByTestId('canvas-expand-button')).toBeVisible();

    const postMessageSpy = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      configurable: true,
    });

    // Switch desktop -> mobile -> tablet -> desktop and toggle Inspector open/close
    fireEvent.click(screen.getByRole('button', { name: /手机|手|mobile/i }));
    expect(screen.getByTestId('sandbox-runtime-canvas').className).toContain('max-w-[390px]');
    expect(screen.getByTestId('canvas-toolbar')).toBeVisible();

    const openInspectorBtn =
      screen.queryByTestId('sandbox-status-rail') ??
      screen.getAllByRole('button', { name: /检查器|属性面板|展开|inspector/i })[0];
    fireEvent.click(openInspectorBtn);
    expect(screen.getByTestId('sandbox-inspector-panel')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-toolbar')).toBeVisible();
    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ds-canvas-remeasure' }),
      '*',
    );

    // Close Inspector and switch back to desktop
    const closeInspectorBtns = screen.getAllByRole('button', { name: /收起|关闭属性|collapse|close/i });
    fireEvent.click(closeInspectorBtns[0]);
    fireEvent.click(screen.getByRole('button', { name: /桌面|桌|desktop/i }));
    expect(screen.getByTestId('sandbox-runtime-canvas').className).toContain('max-w-none');
    expect(screen.getByTestId('canvas-toolbar')).toBeVisible();

    // Open inline local edit: SandboxWorkbenchSurface wires onRequestPatch (no exact-only dead end!)
    fireEvent.click(screen.getByTestId('canvas-toggle-edit'));
    expect(screen.queryByTestId('canvas-local-edit-mode-hint')).toBeNull();

    // Case A: LLM-backed natural-language edit via handout_llm_complete
    invokeMock.mockResolvedValueOnce(
      JSON.stringify({
        edits: [{ search: "ctx.strokeStyle = '#3b82f6';", replace: "ctx.strokeStyle = '#10b981';" }],
      }),
    );
    fireEvent.change(screen.getByTestId('canvas-edit-instruction'), {
      target: { value: '把波浪曲线改成翠绿色' },
    });
    fireEvent.click(screen.getByTestId('canvas-apply-patch'));

    await waitFor(() => {
      expect(screen.getByTestId('sandbox-runtime-status-badge')).toHaveTextContent('已运行 · v2');
    });
    expect(
      document.querySelector('iframe.interactive-html-canvas-frame')?.getAttribute('srcdoc'),
    ).toContain("ctx.strokeStyle = '#10b981';");

    // Case B: Offline/unconfigured LLM smart local patch fallback
    invokeMock.mockRejectedValueOnce(new Error('LLM model not configured'));
    fireEvent.change(screen.getByTestId('canvas-edit-instruction'), {
      target: { value: '把波形颜色改成红色' },
    });
    fireEvent.click(screen.getByTestId('canvas-apply-patch'));

    await waitFor(() => {
      expect(screen.getByTestId('sandbox-runtime-status-badge')).toHaveTextContent('已运行 · v3');
    });
    expect(
      document.querySelector('iframe.interactive-html-canvas-frame')?.getAttribute('srcdoc'),
    ).toContain('#ef4444');

    // Verify smart local title & reset button helpers and runtime error line-offset adjustment
    const sampleUserHtml = ['<div>Demo</div>', '<script>', '  undefinedCall();', '</script>'].join('\n');
    const shiftedSrcDoc = [
      '<!DOCTYPE html>',
      '<html>',
      '<head>',
      '<script>/* injected 4 extra lines */</script>',
      '</head>',
      '<body>',
      '<div>Demo</div>',
      '<script>',
      '  undefinedCall();',
      '</script>',
      '</body>',
      '</html>',
    ].join('\n');
    // undefinedCall() is line 3 in user HTML, line 9 in shiftedSrcDoc -> offset = 6 -> 9 - 6 = 3
    expect(adjustSandboxRuntimeErrorLine(9, sampleUserHtml, shiftedSrcDoc)).toBe(3);
    expect(applySmartLocalHtmlPatch('添加一个重置按钮', sampleUserHtml)).toContain('ds-local-reset-btn');
  });
});

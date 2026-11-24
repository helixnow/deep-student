import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

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
  });
});

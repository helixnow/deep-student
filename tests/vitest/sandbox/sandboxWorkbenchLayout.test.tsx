import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { SandboxWorkbenchPage } from '@/features/sandbox/pages/SandboxWorkbenchPage';
import {
  LEGACY_SANDBOX_OWNER_KEY,
  useSandboxWorkbenchStore,
} from '@/features/sandbox/store/useSandboxWorkbenchStore';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => ({
      'sandbox.refresh': '刷新',
      'sandbox.closeInspector': '收起检查器',
      'sandbox.source': '来源',
      'sandbox.stats': '统计',
    }[key] ?? key),
  }),
}));

describe('SandboxWorkbenchPage layout', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    useSandboxWorkbenchStore.setState({
      activeSession: null,
      isOpen: false,
      viewportPreset: 'desktop',
      inspectorOpen: false,
      ownerStates: {},
      activeOwnerKey: LEGACY_SANDBOX_OWNER_KEY,
    });
  });

  it('renders toolbar, runtime area, and inspector controls for an active session', () => {
    useSandboxWorkbenchStore.getState().openSession({
      sourceType: 'chat-code-block',
      sourceMessageId: 'msg_1',
      language: 'html',
      title: 'HTML Preview',
      content: '<div>hello</div>',
    }, LEGACY_SANDBOX_OWNER_KEY);
    useSandboxWorkbenchStore.getState().setInspectorOpen(true, LEGACY_SANDBOX_OWNER_KEY);

    render(<SandboxWorkbenchPage />);

    expect(screen.getByRole('heading', { name: /HTML Preview/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起检查器' })).toBeInTheDocument();
    expect(screen.getByText('来源')).toBeInTheDocument();
    expect(screen.getByText('统计')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-runtime-canvas')).toBeInTheDocument();
  });
});

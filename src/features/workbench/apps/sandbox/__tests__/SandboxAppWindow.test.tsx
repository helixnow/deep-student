import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppWindowProps } from '../../../core/types';
import type { SandboxSessionInput } from '@/features/sandbox/types';
import {
  LEGACY_SANDBOX_OWNER_KEY,
  useSandboxWorkbenchStore,
} from '@/features/sandbox/store/useSandboxWorkbenchStore';

const mocks = vi.hoisted(() => ({
  latestSurfaceProps: null as Record<string, unknown> | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}));

vi.mock('@/features/workbench/apps/system/useWbSysSize', () => ({
  useWbSysSize: () => ({ ref: vi.fn() }),
}));

vi.mock('@/features/workbench/apps/system/SystemWindowShared', () => ({
  WbSysFade: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  WbSysSkeleton: () => <div data-testid="sandbox-skeleton" />,
}));

vi.mock('@/features/sandbox/components/SandboxWorkbenchSurface', () => {
  const Surface = (props: Record<string, unknown>) => {
    mocks.latestSurfaceProps = props;
    return <div data-testid="sandbox-surface" data-owner-key={String(props.ownerKey)} />;
  };
  return { default: Surface, SandboxWorkbenchSurface: Surface };
});

import SandboxAppWindow from '../SandboxAppWindow';

function sandboxInput(title: string): SandboxSessionInput {
  return {
    sourceType: 'chat-code-block',
    sourceMessageId: `message-${title}`,
    language: 'html',
    title,
    content: `<h1>${title}</h1>`,
  };
}

function makeProps(overrides: Partial<AppWindowProps> = {}): AppWindowProps {
  return {
    windowId: 'sandbox_window',
    instanceKey: null,
    launchPayload: null,
    isActive: true,
    isVisible: true,
    onTitleChange: vi.fn(),
    requestClose: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.latestSurfaceProps = null;
  useSandboxWorkbenchStore.setState({
    activeSession: null,
    isOpen: false,
    viewportPreset: 'desktop',
    inspectorOpen: false,
    ownerStates: {},
    activeOwnerKey: LEGACY_SANDBOX_OWNER_KEY,
  });
});

describe('SandboxAppWindow owner isolation', () => {
  it('stays bound to the standalone owner when an unrelated chat owner becomes active', async () => {
    const store = useSandboxWorkbenchStore.getState();
    store.openSession(sandboxInput('Standalone'), LEGACY_SANDBOX_OWNER_KEY);
    store.openSession(sandboxInput('Chat A'), 'sandbox:chat:sess_a');
    const onTitleChange = vi.fn();

    render(<SandboxAppWindow {...makeProps({ onTitleChange })} />);
    await waitFor(() => expect(mocks.latestSurfaceProps).not.toBeNull());

    expect(mocks.latestSurfaceProps?.ownerKey).toBe(LEGACY_SANDBOX_OWNER_KEY);
    expect(onTitleChange).toHaveBeenLastCalledWith('Standalone');

    act(() => {
      useSandboxWorkbenchStore.getState().openSession(
        sandboxInput('Chat B'),
        'sandbox:chat:sess_b',
      );
    });

    expect(mocks.latestSurfaceProps?.ownerKey).toBe(LEGACY_SANDBOX_OWNER_KEY);
    expect(onTitleChange).toHaveBeenLastCalledWith('Standalone');
  });
});

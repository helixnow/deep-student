import { beforeEach, describe, expect, it } from 'vitest';

import { launchSandboxWorkbench } from '../launchSandboxWorkbench';
import type { SandboxSessionInput } from '../types';
import {
  LEGACY_SANDBOX_OWNER_KEY,
  SANDBOX_OWNER_ATTRIBUTE,
  selectSandboxWorkbenchOwnerState,
  useSandboxWorkbenchStore,
} from './useSandboxWorkbenchStore';

function input(title: string): SandboxSessionInput {
  return {
    sourceType: 'chat-code-block',
    sourceMessageId: `message-${title}`,
    language: 'html',
    title,
    content: `<h1>${title}</h1>`,
  };
}

function ownerState(ownerKey: string) {
  return selectSandboxWorkbenchOwnerState(useSandboxWorkbenchStore.getState(), ownerKey);
}

beforeEach(() => {
  useSandboxWorkbenchStore.setState({
    activeSession: null,
    isOpen: false,
    viewportPreset: 'desktop',
    inspectorOpen: false,
    ownerStates: {},
    activeOwnerKey: LEGACY_SANDBOX_OWNER_KEY,
  });
  document.body.replaceChildren();
});

describe('useSandboxWorkbenchStore owner isolation', () => {
  it('keeps the legacy no-owner API behavior', () => {
    const store = useSandboxWorkbenchStore.getState();
    store.openSession(input('legacy'));

    expect(useSandboxWorkbenchStore.getState().activeSession?.title).toBe('legacy');
    expect(ownerState(LEGACY_SANDBOX_OWNER_KEY).activeSession?.title).toBe('legacy');

    useSandboxWorkbenchStore.getState().closeWorkbench();
    expect(useSandboxWorkbenchStore.getState().isOpen).toBe(false);
    useSandboxWorkbenchStore.getState().openWorkbench();
    expect(useSandboxWorkbenchStore.getState().isOpen).toBe(true);

    useSandboxWorkbenchStore.getState().closeSession();
    expect(useSandboxWorkbenchStore.getState().activeSession).toBeNull();
    expect(ownerState(LEGACY_SANDBOX_OWNER_KEY).activeSession).toBeNull();
  });

  it('closing or switching owner B does not clear owner A', () => {
    const ownerA = 'sandbox:chat:sess_a';
    const ownerB = 'sandbox:chat:sess_b';
    const store = useSandboxWorkbenchStore.getState();

    store.openSession(input('A'), ownerA);
    store.openSession(input('B'), ownerB);
    expect(ownerState(ownerA).activeSession?.title).toBe('A');
    expect(ownerState(ownerB).activeSession?.title).toBe('B');

    useSandboxWorkbenchStore.getState().closeSession(ownerB);
    expect(ownerState(ownerB).activeSession).toBeNull();
    expect(ownerState(ownerA).activeSession?.title).toBe('A');

    useSandboxWorkbenchStore.getState().activateOwner(ownerA);
    expect(useSandboxWorkbenchStore.getState().activeSession?.title).toBe('A');
  });

  it('disposing the active chat owner falls back to legacy without touching another owner', () => {
    const ownerA = 'sandbox:chat:sess_a';
    const ownerB = 'sandbox:chat:sess_b';
    const store = useSandboxWorkbenchStore.getState();

    store.openSession(input('legacy'), LEGACY_SANDBOX_OWNER_KEY);
    store.openSession(input('A'), ownerA);
    store.openSession(input('B'), ownerB);
    expect(useSandboxWorkbenchStore.getState().activeOwnerKey).toBe(ownerB);

    useSandboxWorkbenchStore.getState().disposeOwner(ownerB);

    expect(useSandboxWorkbenchStore.getState().activeOwnerKey).toBe(LEGACY_SANDBOX_OWNER_KEY);
    expect(useSandboxWorkbenchStore.getState().activeSession?.title).toBe('legacy');
    expect(ownerState(ownerB).activeSession).toBeNull();
    expect(ownerState(ownerA).activeSession?.title).toBe('A');
  });

  it('isolates viewport, inspector and mode state per owner', () => {
    const ownerA = 'sandbox:chat:sess_a';
    const ownerB = 'sandbox:chat:sess_b';
    const store = useSandboxWorkbenchStore.getState();
    store.openSession(input('A'), ownerA);
    store.openSession(input('B'), ownerB);

    useSandboxWorkbenchStore.getState().setViewportPreset('mobile', ownerA);
    useSandboxWorkbenchStore.getState().setInspectorOpen(true, ownerB);
    useSandboxWorkbenchStore.getState().setWorkbenchMode('sandbox-run', ownerA);

    expect(ownerState(ownerA)).toMatchObject({
      viewportPreset: 'mobile',
      inspectorOpen: false,
      activeSession: expect.objectContaining({ mode: 'sandbox-run' }),
    });
    expect(ownerState(ownerB)).toMatchObject({
      viewportPreset: 'desktop',
      inspectorOpen: true,
      activeSession: expect.objectContaining({ mode: 'safe-preview' }),
    });
  });

  it('routes a legacy launch to the focused sandbox owner host', () => {
    const ownerA = 'sandbox:chat:sess_a';
    const hostA = document.createElement('div');
    const buttonA = document.createElement('button');
    hostA.setAttribute(SANDBOX_OWNER_ATTRIBUTE, ownerA);
    hostA.append(buttonA);
    document.body.append(hostA);

    buttonA.focus();
    launchSandboxWorkbench(input('A'));

    expect(ownerState(ownerA).activeSession?.title).toBe('A');
  });

  it('prefers the latest pointer-activated owner over a stale focused element', () => {
    const ownerA = 'sandbox:chat:sess_a';
    const ownerB = 'sandbox:chat:sess_b';
    const hostB = document.createElement('div');
    const buttonB = document.createElement('button');
    hostB.setAttribute(SANDBOX_OWNER_ATTRIBUTE, ownerB);
    hostB.append(buttonB);
    document.body.append(hostB);
    buttonB.focus();

    useSandboxWorkbenchStore.getState().activateOwner(ownerA);
    launchSandboxWorkbench(input('A'));

    expect(ownerState(ownerA).activeSession?.title).toBe('A');
    expect(ownerState(ownerB).activeSession).toBeNull();
  });
});

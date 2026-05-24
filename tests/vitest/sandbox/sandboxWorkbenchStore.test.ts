import { beforeEach, describe, expect, it } from 'vitest';

import { useSandboxWorkbenchStore } from '@/features/sandbox/store/useSandboxWorkbenchStore';

describe('sandbox workbench store', () => {
  beforeEach(() => {
    useSandboxWorkbenchStore.setState({
      activeSession: null,
      isOpen: false,
      viewportPreset: 'desktop',
      inspectorOpen: false,
    });
  });

  it('creates a session from chat code block input', () => {
    const store = useSandboxWorkbenchStore.getState();

    store.openSession({
      sourceType: 'chat-code-block',
      sourceMessageId: 'msg_1',
      language: 'html',
      title: 'HTML Preview',
      content: '<div>hello</div>',
    });

    const next = useSandboxWorkbenchStore.getState();
    expect(next.activeSession?.sourceType).toBe('chat-code-block');
    expect(next.activeSession?.content).toContain('hello');
    expect(next.activeSession?.mode).toBe('safe-preview');
    expect(next.isOpen).toBe(true);
  });

  it('updates viewport and inspector state independently', () => {
    const store = useSandboxWorkbenchStore.getState();

    store.setViewportPreset('mobile');
    store.setInspectorOpen(true);
    store.refreshSession();

    const next = useSandboxWorkbenchStore.getState();
    expect(next.viewportPreset).toBe('mobile');
    expect(next.inspectorOpen).toBe(true);
  });

  it('can collapse and reopen the workbench without clearing the session', () => {
    const store = useSandboxWorkbenchStore.getState();
    store.openSession({
      sourceType: 'chat-code-block',
      sourceMessageId: 'msg_3',
      language: 'html',
      title: 'Preview',
      content: '<div>keep me</div>',
    });

    store.closeWorkbench();
    expect(useSandboxWorkbenchStore.getState().isOpen).toBe(false);

    store.openWorkbench();
    expect(useSandboxWorkbenchStore.getState().isOpen).toBe(true);
    expect(useSandboxWorkbenchStore.getState().activeSession?.content).toContain('keep me');
  });

  it('closes the active session cleanly', () => {
    const store = useSandboxWorkbenchStore.getState();
    store.openSession({
      sourceType: 'chat-code-block',
      sourceMessageId: 'msg_2',
      language: 'html',
      title: 'Preview',
      content: '<div>bye</div>',
    });

    store.closeSession();

    expect(useSandboxWorkbenchStore.getState().activeSession).toBeNull();
    expect(useSandboxWorkbenchStore.getState().isOpen).toBe(false);
  });
});

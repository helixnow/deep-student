import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('app create navigation contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const createBridgeStart = appSource.indexOf('const handleCreateChatSessionBridge = useCallback');
  const createBridgeEnd = appSource.indexOf('useEventRegistry([', createBridgeStart);
  const createBridgeSource = appSource.slice(createBridgeStart, createBridgeEnd).replace(/\s+/g, ' ');
  const createRegistryEnd = appSource.indexOf('], [handleCreateChatSessionBridge', createBridgeEnd);
  const createRegistrySource = appSource.slice(createBridgeEnd, createRegistryEnd).replace(/\s+/g, ' ');

  it('switches to chat when chat create events fire from outside the active page', () => {
    expect(createRegistrySource).toContain('type: APP_EVENTS.CHAT_NEW_SESSION');
    expect(createRegistrySource).toContain('type: APP_EVENTS.MODERN_SIDEBAR_GROUP_ACTION');
    expect(createRegistrySource).toContain('toAppEventListener(handleCreateChatSessionBridge)');
    expect(createBridgeSource).toContain("detail.action !== 'create-session'");
    expect(createBridgeSource).toContain("setCurrentView('chat-v2');");
  });

  it('switches to chat when topic create events fire from outside the active page', () => {
    expect(createBridgeSource).toContain("detail.action !== 'create-group'");
  });

  it('switches to learning hub when note create events fire from outside the active page', () => {
    expect(createRegistrySource).toContain('type: APP_EVENTS.NOTES_CREATE_NEW');
    expect(createRegistrySource).toContain("setCurrentView('learning-hub');");
  });
});

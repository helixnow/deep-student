import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('hidden draft session lifecycle contract', () => {
  const lifecycleSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/pages/useSessionLifecycle.ts'),
    'utf-8'
  );
  const chatPageSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/pages/ChatV2Page.tsx'),
    'utf-8'
  );
  const repoSource = readFileSync(
    resolve(process.cwd(), 'src-tauri/src/chat_v2/repo.rs'),
    'utf-8'
  );
  const sessionActionsSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/core/store/sessionActions.ts'),
    'utf-8'
  );
  const tauriAdapterSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/adapters/TauriAdapter.ts'),
    'utf-8'
  );
  const restoreActionsSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/core/store/restoreActions.ts'),
    'utf-8'
  );

  it('creates or reuses one hidden draft instead of inserting a blank session into the page list', () => {
    expect(lifecycleSource).toContain('getOrCreateHiddenDraftSession');
    expect(lifecycleSource).toContain('buildHiddenDraftSessionMetadata');
    expect(lifecycleSource).toContain('persistHiddenDraftSessionId');
    expect(lifecycleSource).not.toContain('Created new empty session on startup');
    expect(lifecycleSource).not.toContain('Auto-created session after deleting last one');
  });

  it('promotes the hidden draft when the first message appears', () => {
    expect(chatPageSource).toContain('promoteHiddenDraftSession');
    expect(chatPageSource).toContain('clearHiddenDraftSessionMetadata');
    expect(chatPageSource).toContain('clearHiddenDraftSessionId');
  });

  it('hides hidden draft sessions from backend list and count queries', () => {
    expect(repoSource).toContain("json_extract(metadata_json, '$.chatV2Draft.hidden')");
    expect(repoSource).toContain('append_visible_session_filter');
  });

  it('keeps unsent input text attached to the reusable draft session', () => {
    expect(sessionActionsSource).toContain('setInputValue: (value: string)');
    expect(sessionActionsSource).toContain('scheduleAutoSaveIfReady()');
    expect(tauriAdapterSource).toContain('inputValue: state.inputValue || null');
    expect(restoreActionsSource).toContain("const inputValue = state?.inputValue ?? ''");
  });

  it('routes left-sidebar ungrouped create actions into an ungrouped draft session', () => {
    expect(chatPageSource).toContain("void createSession(typeof groupId === 'string' && groupId.trim() ? groupId : undefined);");
  });
});

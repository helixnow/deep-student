import { afterEach, describe, expect, it } from 'vitest';
import {
  clearComposerDraft,
  composerDraftStorageKey,
  restoreComposerDraftIfSafe,
  writeComposerDraft,
} from '../composerDraftStorage';

const SESSION_ID = 'sess_draft_test';

afterEach(() => {
  clearComposerDraft(SESSION_ID);
});

describe('composerDraftStorage', () => {
  it('builds a stable session-scoped key', () => {
    expect(composerDraftStorageKey(SESSION_ID)).toBe(`dstu.chatv2.draft.${SESSION_ID}`);
    expect(composerDraftStorageKey(null)).toBeNull();
  });

  it('restores draft only when idle and input is empty', () => {
    writeComposerDraft(SESSION_ID, 'hello draft');
    expect(restoreComposerDraftIfSafe(SESSION_ID, '', 'idle')).toBe('hello draft');
    expect(restoreComposerDraftIfSafe(SESSION_ID, 'typed', 'idle')).toBeNull();
  });

  it('discards stale draft while streaming so empty→docked remount cannot revive sent text', () => {
    writeComposerDraft(SESSION_ID, 'already sent');
    expect(restoreComposerDraftIfSafe(SESSION_ID, '', 'streaming')).toBeNull();
    expect(restoreComposerDraftIfSafe(SESSION_ID, '', 'sending')).toBeNull();
    expect(sessionStorage.getItem(composerDraftStorageKey(SESSION_ID)!)).toBeNull();
  });

  it('clearComposerDraft removes persisted text synchronously', () => {
    writeComposerDraft(SESSION_ID, 'pending');
    clearComposerDraft(SESSION_ID);
    expect(sessionStorage.getItem(composerDraftStorageKey(SESSION_ID)!)).toBeNull();
  });
});

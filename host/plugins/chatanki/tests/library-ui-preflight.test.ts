import { expect, it } from 'vitest';
import {
  mutationUiSyncNotRequiredReceipt, preflightLibraryCardMutation,
} from '../src/mutation-target.ts';
import { ChatBlockStoreDouble } from './chat-block-double.ts';

it('test_chatanki_library_ui_preflight_uses_source_session_or_not_required', () => {
  const noSource = { documentId: 'doc-imported', sourceSessionId: null };
  const importedTarget = preflightLibraryCardMutation(null, noSource);
  expect(importedTarget.blockId).toBeNull();
  expect(importedTarget.sessionId).toBe('');
  expect(mutationUiSyncNotRequiredReceipt(importedTarget))
    .toEqual({ status: 'not_required', eventAttempted: false });

  const store = new ChatBlockStoreDouble();
  store.seedAnkiCardsBlock('block-card-source', 'session-card-source', 'doc-card-source');
  const sourceLocator = {
    documentId: 'doc-card-source', sourceSessionId: 'session-card-source',
  };
  const target = preflightLibraryCardMutation(store, sourceLocator);
  expect(target.blockId).toBe('block-card-source');
  expect(target.sessionId).toBe('session-card-source');
  expect(target.documentId).toBe('doc-card-source');
});

import { expect, it } from 'vitest';
import {
  ensureCancelledDocumentSession, ensureFailedDocumentSession,
} from '../src/document-session.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';

it('test_ensure_failed_document_session_inserts_placeholder_once', () => {
  const repo = new CardStoreDouble();
  ensureFailedDocumentSession(
    repo, 'doc-placeholder', 'session-1', 'placeholder-doc',
    'blocks.ankiCards.errors.noContent',
  );

  const tasks = repo.getTasksForDocument('doc-placeholder');
  expect(tasks.length).toBe(1);
  expect(tasks[0]?.status).toBe('Failed');
  expect(tasks[0]?.error_message).toBe('blocks.ankiCards.errors.noContent');
  expect(tasks[0]?.original_document_name).toBe('placeholder-doc');
  expect(tasks[0]?.anki_generation_options_json).toBe('{}');
  expect(repo.getDocumentSessionSource('doc-placeholder')).toBe('session-1');

  ensureFailedDocumentSession(
    repo, 'doc-placeholder', 'session-1', 'placeholder-doc',
    'blocks.ankiCards.errors.startFailed',
  );
  const tasksAfter = repo.getTasksForDocument('doc-placeholder');
  expect(tasksAfter.length).toBe(1);
  expect(tasksAfter[0]?.error_message).toBe('blocks.ankiCards.errors.noContent');
});

it('cancelled placeholder persists the controller marker once', () => {
  const repo = new CardStoreDouble();
  ensureCancelledDocumentSession(repo, 'doc-cancelled', 'session-cancelled', 'cancelled-doc');
  const tasks = repo.getTasksForDocument('doc-cancelled');
  expect(tasks.length).toBe(1);
  expect(tasks[0]?.status).toBe('Cancelled');
  expect(tasks[0]?.error_message).toBe('PIPELINE_CANCELLED_BY_CONTROLLER');

  ensureCancelledDocumentSession(repo, 'doc-cancelled', 'session-cancelled', 'cancelled-doc');
  expect(repo.getTasksForDocument('doc-cancelled').length).toBe(1);
});

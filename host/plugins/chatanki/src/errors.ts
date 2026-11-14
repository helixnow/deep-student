// Rust: chatanki_executor.rs:11883–11960 error key humanization.

// ============================================================================
// Errors (chatanki_executor.rs:11883–11960)
// ============================================================================

const CHATANKI_ERROR_PREFIX = 'blocks.ankiCards.errors.';

const CHATANKI_ERROR_MESSAGES: Record<string, string> = {
  addArgsRequired: 'adding cards requires a documentId and 1-100 cards in the request',
  ankiConnectUnavailable: 'AnkiConnect is unavailable; ask the user to open Anki with the AnkiConnect add-on enabled, then retry',
  ankiSyncEmpty: 'no cards were imported into Anki; check that Anki is running, the note type exists, and card fields are non-empty',
  cardContentRequired: 'each card must have a non-empty front/back or non-empty cloze text',
  contextRefInvalid: 'the attachment reference is invalid; remove and re-add the attachment before retrying',
  databaseUnavailable: 'the card database is currently unavailable; wait and retry later instead of repeating immediately',
  documentIdRequired: 'missing documentId; supply the card-generation document id',
  generationFailed: 'card generation failed with no usable cards produced; check the model configuration or the error details',
  missingClozeNoteType: 'Anki is missing the Cloze note type; ask the user to create it in Anki first',
  noContent: 'no content available for card generation; provide text or upload a file first',
  pipelineTimeout: 'generation took too long and automatic updates stopped; query later with chatanki_status or regenerate',
  retemplateSelectorRequired: 'retemplate requires exactly one of documentId or cardIds',
  reviewSelectorRequired: 'enqueueing a review requires exactly one of documentId or cardIds',
  startFailed: 'failed to start card generation; retry or adjust the template/settings',
  statusNotFound: 'no live card task found for the given id under this session; the id may be wrong, or the content was created in a different card-making session (session-scoped tools cannot touch other sessions\' documents). Do not retry the same id: for cross-session changes call chatanki_list_library_cards to locate the card (cardId + content version), then use the chatanki_*_library_card tools (update/delete/enqueue/set_suspended/undo), or ask the user to edit it in the flashcards app library',
  templateDatabaseUnavailable: 'the template database is currently unavailable; retry later',
  templateLoadFailed: 'failed to load the template; retry or re-import the template',
  templateNotFound: 'template not found; choose another template or import it first',
  updateArgsRequired: 'updating a card requires cardId, expectedVersion and at least one modified field',
  waitInvalidArgs: 'chatanki_wait requires ankiBlockId or documentId',
  waitNotFound: 'no card block found yet; wait a moment or call chatanki_status with the documentId',
  waitTimeout: 'waiting timed out; query later with chatanki_status or retry with a longer timeout',
};

/** 保留 i18n key，追加 LLM 可读描述与修复建议。 */
export function humanizeChatAnkiError(error: string): string {
  if (!error.startsWith(CHATANKI_ERROR_PREFIX)) return error;
  const key = error.slice(CHATANKI_ERROR_PREFIX.length);
  const message = CHATANKI_ERROR_MESSAGES[key] ?? 'unrecognized chatanki error code';
  return `${CHATANKI_ERROR_PREFIX}${key}: ${message}`;
}

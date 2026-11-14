/**
 * `save_anki_cards` 的语义（`src/cmd/anki_connect.rs:495-700,702-923`）：
 * 聊天卡片落库、`INSERT OR IGNORE` 回退映射与变更事件 payload。
 */
import type {
  SaveAnkiCardFailure,
  SaveAnkiCardsRequest,
  SaveAnkiCardsResponse,
} from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { AnkiCard, DocumentTask } from '../../../../contracts/ipc/generated/_shared.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import * as repo from '../repository/anki-cards.ts';
import { serializeAnkiGenerationOptions } from './generation-options.ts';
import { nowRfc3339 } from './time.ts';

export type SaveCardsErrorType = 'Validation' | 'Database';

/** 与 Rust `AppError::validation/database` 对应；由插件入口转成 `CommandError`。 */
export class SaveCardsError extends Error {
  readonly errorType: SaveCardsErrorType;
  constructor(errorType: SaveCardsErrorType, message: string) {
    super(message);
    this.name = 'SaveCardsError';
    this.errorType = errorType;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonEmpty(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim() !== '';
}

/** `is_temporary_anki_card_id`（`cmd/anki_connect.rs:495-499`）。 */
export function isTemporaryAnkiCardId(raw: string): boolean {
  const id = raw.trim();
  return id === '' || id.startsWith('anki_synthetic_') || id.startsWith('chat-batch-');
}

/** `durable_anki_card_id`（`cmd/anki_connect.rs:495-500`）。 */
export function durableAnkiCardId(inputId: string | null | undefined): string {
  if (inputId !== null && inputId !== undefined) {
    const id = inputId.trim();
    if (!isTemporaryAnkiCardId(id)) return id;
  }
  return globalThis.crypto.randomUUID();
}

/** `save_anki_cards_outcome_is_acceptable`（`cmd/anki_connect.rs:662-669`）。 */
export function saveAnkiCardsOutcomeIsAcceptable(response: SaveAnkiCardsResponse): boolean {
  if (response.savedIds.length > 0 || response.duplicatedIds.length > 0) return true;
  return response.skippedIds.length > 0 && response.failed.length === 0;
}

/** `build_save_anki_cards_changed_payload`（`cmd/anki_connect.rs:671-690`）。 */
export function buildSaveAnkiCardsChangedPayload(
  response: SaveAnkiCardsResponse,
): { source: 'user'; action: 'cards_persisted'; entityIds: string[] } | null {
  const seen = new Set<string>();
  const entityIds: string[] = [];
  for (const id of [...response.savedIds, ...response.duplicatedIds]) {
    if (id.trim() === '' || seen.has(id)) continue;
    seen.add(id);
    entityIds.push(id);
  }
  return entityIds.length === 0 ? null : { source: 'user', action: 'cards_persisted', entityIds };
}

/** `apply_card_update_fallback`（`cmd/anki_connect.rs:622-660`）。 */
export function applyCardUpdateFallback(
  db: SqlExecutor,
  documentId: string,
  card: AnkiCard,
  inputIndex: number,
  persistedIds: (string | null)[],
  duplicatedIds: string[],
  skippedIds: string[],
  failed: SaveAnkiCardFailure[],
): void {
  let rows: number;
  try {
    rows = repo.updateAnkiCardRowsForDocument(db, documentId, card, nowRfc3339());
  } catch (error) {
    failed.push({ id: card.id, error: `更新已有卡片失败: ${errorText(error)}` });
    return;
  }
  if (rows > 0) {
    duplicatedIds.push(card.id);
    persistedIds[inputIndex] = card.id;
    return;
  }

  let diagnostic: boolean;
  try {
    diagnostic = repo.ankiCardIsDiagnosticInDocument(db, documentId, card.id);
  } catch (error) {
    throw new SaveCardsError('Database', `查询诊断卡失败: ${errorText(error)}`);
  }
  if (diagnostic) {
    skippedIds.push(card.id);
    return;
  }

  let existingId: string | null;
  try {
    existingId = repo.findExistingCardIdByContent(db, documentId, card);
  } catch (error) {
    throw new SaveCardsError('Database', `查询内容去重卡片失败: ${errorText(error)}`);
  }
  if (existingId !== null) {
    skippedIds.push(card.id);
    persistedIds[inputIndex] = existingId;
    return;
  }
  failed.push({
    id: card.id,
    error: '卡片 ID 不属于当前文档，且未找到可映射的内容去重卡片',
  });
}

/** `save_anki_cards_in_database`（`src/cmd/anki_connect.rs:692-923`）。 */
export function saveAnkiCardsInDatabase(
  db: DatabaseHandle,
  request: SaveAnkiCardsRequest,
): SaveAnkiCardsResponse {
  if (request.cards.length === 0) throw new SaveCardsError('Validation', 'No cards provided for saving');

  const subject = '未分类';
  const documentId =
    [request.document_id, request.block_id, request.message_stable_id].find(nonEmpty) ?? globalThis.crypto.randomUUID();
  const taskId = globalThis.crypto.randomUUID();
  const now = nowRfc3339();
  let optionsJson: string;
  try {
    optionsJson = request.options === null || request.options === undefined
      ? '{}'
      : serializeAnkiGenerationOptions(request.options as unknown as Record<string, unknown>);
  } catch (error) {
    throw new SaveCardsError('Validation', `无法序列化制卡配置: ${errorText(error)}`);
  }

  const contentSegment = nonEmpty(request.document_id)
    ? `chat_document:${request.document_id}`
    : nonEmpty(request.block_id)
      ? `chat_block:${request.block_id}`
      : nonEmpty(request.message_stable_id)
        ? `chat_message:${request.message_stable_id}`
        : nonEmpty(request.business_session_id)
          ? `chat_session:${request.business_session_id}`
          : 'chat_session:anonymous';

  const task: DocumentTask = {
    id: taskId,
    document_id: documentId,
    original_document_name: `Chat Cards ${subject}`,
    segment_index: 0,
    content_segment: contentSegment,
    status: 'Completed',
    created_at: now,
    updated_at: now,
    error_message: null,
    anki_generation_options_json: optionsJson,
  };

  const cards: AnkiCard[] = [];
  const inputIds: (string | null)[] = [];
  const firstInputByCardId = new Map<string, number>();
  for (const [index, payload] of request.cards.entries()) {
    const fields = { ...(payload.fields ?? {}) };
    const front = payload.front ?? fields.Front ?? `Chat card ${index + 1}`;
    const back = payload.back ?? fields.Back ?? '';
    const inputId = payload.id ?? null;
    const cardId = durableAnkiCardId(inputId);
    const firstIndex = firstInputByCardId.get(cardId);
    if (firstIndex !== undefined) {
      throw new SaveCardsError(
        'Validation',
        `duplicate_card_id_in_request: id=${cardId}, firstInputIndex=${firstIndex}, duplicateInputIndex=${index}`,
      );
    }
    firstInputByCardId.set(cardId, index);

    if (!Object.hasOwn(fields, 'Front')) fields.Front = front;
    if (!Object.hasOwn(fields, 'Back')) fields.Back = back;

    const text = payload.text ?? null;
    const card: AnkiCard = {
      front,
      back,
      text,
      tags: [...(payload.tags ?? [])],
      images: [...(payload.images ?? [])],
      id: cardId,
      task_id: taskId,
      is_error_card: false,
      error_content: null,
      created_at: now,
      updated_at: now,
      extra_fields: fields,
      template_id: payload.template_id ?? request.template_id ?? null,
    };
    if (card.text === null) card.text = card.extra_fields.Text ?? null;
    cards.push(card);
    inputIds.push(inputId);
  }

  let savedIds: string[] = [];
  const duplicatedIds: string[] = [];
  const skippedIds: string[] = [];
  const failed: SaveAnkiCardFailure[] = [];
  const persistedIds: (string | null)[] = cards.map(() => null);

  try {
    savedIds = repo.saveDocumentTaskWithCardsAtomic(db, task, cards);
    const inserted = new Set(savedIds);
    for (const [index, card] of cards.entries()) {
      if (inserted.has(card.id)) {
        persistedIds[index] = card.id;
        continue;
      }
      applyCardUpdateFallback(db, documentId, card, index, persistedIds, duplicatedIds, skippedIds, failed);
    }
  } catch (error) {
    const text = errorText(error);
    if (!text.includes('no_cards_saved_in_atomic_insert')) {
      throw new SaveCardsError('Database', `保存卡片事务失败: ${text}`);
    }
    for (const [index, card] of cards.entries()) {
      applyCardUpdateFallback(db, documentId, card, index, persistedIds, duplicatedIds, skippedIds, failed);
    }
  }

  const cardIdMappings = persistedIds
    .map((persistedId, inputIndex) => persistedId === null
      ? null
      : { inputIndex, inputId: inputIds[inputIndex] ?? null, persistedId })
    .filter((mapping): mapping is NonNullable<typeof mapping> => mapping !== null);

  const response: SaveAnkiCardsResponse = {
    savedIds,
    taskId,
    cardIdMappings,
    skippedIds,
    duplicatedIds,
    failed,
  };

  if (!saveAnkiCardsOutcomeIsAcceptable(response)) {
    if (failed.length > 0) {
      const detail = failed.map((failure) => `${failure.id}: ${failure.error}`).join('; ');
      throw new SaveCardsError('Validation', `未能保存任何卡片：${detail}`);
    }
    throw new SaveCardsError('Validation', '未能保存任何卡片，请检查输入数据');
  }

  if (nonEmpty(request.business_session_id)) {
    try {
      repo.setDocumentSessionSource(db, documentId, request.business_session_id);
    } catch (error) {
      throw new SaveCardsError('Database', `保存文档来源会话失败: ${errorText(error)}`);
    }
  }

  return response;
}

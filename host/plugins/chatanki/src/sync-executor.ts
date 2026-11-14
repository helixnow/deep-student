// Rust chatanki_executor.rs:6141–6482 `execute_sync` (+ :14225–14301 block syncStatus patch).
// AnkiConnect, sync options and export receipts go through L16's published
// `anki` facade (`anki_connect_service` / `write_anki_export_receipts`).
import type {
  AnkiCard, ChatAnkiChatBlock, ChatAnkiChatBlockStore, ChatAnkiToolExecutor, CustomAnkiTemplate, ToolCall, ToolConcurrency,
  ToolExecutionContext, ToolResultInfo, ToolSensitivity,
} from '../api.ts';
import { verifyDocumentOwnership } from './card-access.ts';
import { resolveDeckAndNoteType } from './chatanki-executor.ts';
import { parseChatAnkiSyncArgs, type ChatAnkiSyncArgs } from './executor-args.ts';
import { chatankiSensitivityForCall } from './executor-helpers.ts';
import { errorText, stripToolNamespace } from './execution.ts';
import { findOwnedAnkiCardsBlockId } from './mutation-target.ts';
import {
  beginChatAnkiToolCall, chatAnkiHandlerError, finishChatAnkiInlineFailure as finishFailure,
  finishChatAnkiSuccess as finishSuccess,
} from './result.ts';
import { collectRequestedTemplateIds, resolveSingleTemplateId } from './template-selection.ts';
import { rustTrim } from '../../../platform/util/text.ts';

const ANKI_CONNECT_UNAVAILABLE = 'blocks.ankiCards.errors.ankiConnectUnavailable';
const ANKI_SYNC_EMPTY = 'blocks.ankiCards.errors.ankiSyncEmpty';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `contains_cloze_markup` (:9067): substring test, so trimming the ends changes nothing. */
function containsClozeMarkup(text: string): boolean {
  return text.includes('{{c') && text.includes('}}');
}

/** `card_has_cloze_markup` (:9072). */
export function cardHasClozeMarkup(card: AnkiCard): boolean {
  if (card.text !== null && containsClozeMarkup(card.text)) return true;
  if (containsClozeMarkup(card.front) || containsClozeMarkup(card.back)) return true;
  return Object.values(card.extra_fields).some(containsClozeMarkup);
}

/** `infer_single_template_id_from_cards` (:9012). */
export function inferSingleTemplateIdFromCards(cards: readonly AnkiCard[]): string | null {
  const ids = new Set(cards
    .map((card) => resolveSingleTemplateId(card.template_id))
    .filter((id): id is string => id !== null));
  return ids.size === 1 ? [...ids][0]! : null;
}

/** serde_json `Map::remove` under `preserve_order` is `swap_remove`: the last entry takes the removed slot. */
function swapRemove(object: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!Object.hasOwn(object, key)) return object;
  const entries = Object.entries(object);
  const index = entries.findIndex(([name]) => name === key);
  const last = entries.pop()!;
  if (index < entries.length) entries[index] = last;
  return Object.fromEntries(entries);
}

/**
 * `patch_anki_cards_block_sync_status` (:14225): best-effort write of `syncStatus`
 * onto the newest `anki_cards` block for the document, then the live chunk.
 */
export function patchAnkiCardsBlockSyncStatus(
  store: ChatAnkiChatBlockStore, ctx: ToolExecutionContext, documentId: string,
  syncStatus: string, syncError: string | null,
): void {
  const docId = rustTrim(documentId);
  if (docId.length === 0) return;
  let blockId: string | null;
  // RUST-FIX(RF-W22-sync-status-patch-session-scope): Rust scans the newest 40 anki_cards blocks of every session.
  try { blockId = findOwnedAnkiCardsBlockId(store, ctx.sessionId, docId); }
  catch { return; }
  if (blockId === null) return;

  let existing: ChatAnkiChatBlock | null;
  try { existing = store.getBlock(blockId); }
  catch { existing = null; }
  if (existing !== null) {
    let toolOutput = existing.toolOutput ?? { cards: [], documentId: docId };
    if (isRecord(toolOutput)) {
      const patched = { ...toolOutput, syncStatus };
      toolOutput = syncError === null
        ? swapRemove(patched, 'syncError')
        : { ...patched, syncError };
    }
    try { store.updateBlock({ ...existing, toolOutput }); }
    catch { } // boundary-allow empty-catch: :14290 `let _ = ChatV2Repo::update_block_v2(..)` 显式丢弃写入错误
  }
  ctx.emitChunk?.(blockId, { syncStatus, syncError });
}

export async function executeChatAnkiSync(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number,
): Promise<ToolResultInfo> {
  let args: ChatAnkiSyncArgs;
  try { args = parseChatAnkiSyncArgs(call.arguments); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt, `Invalid chatanki_sync arguments: ${errorText(caught)}`);
  }

  const repo = ctx.cards ?? null;
  const templateDb = ctx.mainDb ?? ctx.ankiDb ?? ctx.templateLookup ?? null;
  if (repo === null || templateDb === null) {
    return finishFailure(call, ctx, startedAt, 'Anki database not available');
  }

  try { verifyDocumentOwnership(repo, args.documentId, ctx.sessionId, ctx.warn); }
  catch (caught) { return finishFailure(call, ctx, startedAt, errorText(caught)); }

  let cards: AnkiCard[];
  try { cards = repo.getCardsForDocument(args.documentId); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt, `Failed to load cards for document: ${errorText(caught)}`);
  }
  cards = cards.filter((card) => !card.is_error_card);
  if (cards.length === 0) {
    return finishFailure(call, ctx, startedAt, 'No cards to sync (all cards are empty or error cards)');
  }

  const sync = ctx.ankiConnectSync ?? null;
  if (sync === null) return finishFailure(call, ctx, startedAt, 'AnkiConnect sync service unavailable');
  try { await sync.checkAnkiConnectAvailability(); }
  catch (caught) {
    ctx.warn(`[ChatAnkiToolExecutor] AnkiConnect unavailable: ${errorText(caught)}`);
    return finishFailure(call, ctx, startedAt, ANKI_CONNECT_UNAVAILABLE);
  }

  const noteTypeExplicit = args.noteType !== null && rustTrim(args.noteType).length > 0;
  const [deckName, resolvedNoteType] = resolveDeckAndNoteType(ctx, args.deckName, args.noteType);
  let noteType = resolvedNoteType;
  if (cards.every(cardHasClozeMarkup)) noteType = 'Cloze';

  try { await sync.createDeckIfNotExists(deckName); }
  catch { } // boundary-allow empty-catch: :6269 `let _ = create_deck_if_not_exists(..)`（best-effort，失败由后续 addNotes 报告）

  const explicitTemplateId = resolveSingleTemplateId(args.templateId);
  const requestedTemplateIds = collectRequestedTemplateIds(explicitTemplateId, args.templateIds);
  const fallbackTemplateId = explicitTemplateId ?? inferSingleTemplateIdFromCards(cards);
  const cardModels = new Map<string, string>();
  const templatesByModel = new Map<string, CustomAnkiTemplate>();

  if (!noteTypeExplicit) {
    const templateCache = new Map<string, CustomAnkiTemplate | null>();
    for (const card of cards) {
      if (cardHasClozeMarkup(card)) cardModels.set(card.id, 'Cloze');
      const templateId = resolveSingleTemplateId(card.template_id)
        ?? fallbackTemplateId ?? requestedTemplateIds[0] ?? null;
      if (templateId === null) continue;
      let template: CustomAnkiTemplate | null;
      if (templateCache.has(templateId)) {
        template = templateCache.get(templateId)!;
      } else {
        try { template = templateDb.getCustomTemplateById(templateId); }
        catch (caught) { throw chatAnkiHandlerError(`读取模板失败: ${errorText(caught)}`); }
        templateCache.set(templateId, template);
      }
      if (template === null) throw chatAnkiHandlerError(`模板 ${templateId} 不存在，请先选择可用模板`);
      const modelName = sync.templateModelName(template);
      cardModels.set(card.id, modelName);
      if (!templatesByModel.has(modelName)) templatesByModel.set(modelName, template);
    }
  }

  const cardIds = cards.map((card) => card.id);
  let report;
  try {
    report = await sync.addNotesToAnkiDetailed({
      cards, deckName, noteType, cardModels, templatesByModel, options: sync.readSyncOptions(),
    });
  } catch (caught) {
    return finishFailure(call, ctx, startedAt, errorText(caught));
  }

  const total = report.noteIds.length;
  const { added, duplicates, failed } = report;
  // D1: all duplicates is an idempotent success; real failures with nothing landed is an error.
  const status = failed === 0 ? 'ok' : added > 0 || duplicates > 0 ? 'partial' : 'error';
  const error = status === 'error' ? ANKI_SYNC_EMPTY : null;
  const warning = status === 'partial'
    ? { code: 'anki_sync_partial', details: { total, added, duplicates, failed } }
    : null;

  let receiptWritten = 0;
  if (status !== 'error' && added > 0) {
    try {
      receiptWritten = sync.writeAnkiExportReceipts(cardIds, report.noteIds);
      if (receiptWritten > 0) {
        ctx.info?.(`[ChatAnkiToolExecutor] export receipt written for ${receiptWritten} cards`);
      }
    } catch (caught) {
      ctx.warn(`[ChatAnkiToolExecutor] export receipt writeback failed: ${errorText(caught)}`);
    }
  }

  const output = {
    status,
    documentId: args.documentId,
    deckName,
    noteType,
    total,
    added,
    duplicates,
    failed,
    createdModels: report.createdModels,
    receiptWritten,
    error,
    warning,
  };
  if (error !== null) return finishFailure(call, ctx, startedAt, error, output);

  const chatBlocks = ctx.chatBlocks ?? null;
  if (chatBlocks !== null) patchAnkiCardsBlockSyncStatus(chatBlocks, ctx, args.documentId, 'synced', null);
  return finishSuccess(call, ctx, startedAt, output);
}

export class ChatAnkiSyncExecutor implements ChatAnkiToolExecutor {
  private readonly syncPublished: () => boolean;
  constructor(syncPublished: () => boolean) { this.syncPublished = syncPublished; }
  /** Claimed only while L16 publishes the AnkiConnect sync facade; otherwise no executor can run it. */
  canHandle(toolName: string): boolean {
    return stripToolNamespace(toolName) === 'chatanki_sync' && this.syncPublished();
  }
  sensitivityLevel(toolName: string): ToolSensitivity {
    return chatankiSensitivityForCall(toolName, {});
  }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }
  /** Split handler label; registration uses the folded `ChatAnkiToolExecutor` (`executors.ts`). */
  name(): string { return 'ChatAnkiSyncExecutor'; }
  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    const startedAt = performance.now();
    beginChatAnkiToolCall(call, ctx);
    return executeChatAnkiSync(call, ctx, startedAt);
  }
}

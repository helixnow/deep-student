// Rust: chatanki_executor.rs:4207–4535 (chatanki_retemplate).
// Phase 1 is L16's atomic retemplate batch; phase 2 is the LLM fill loop that
// this lane owns on top of retemplate-fill.ts.
import type {
  AnkiRetemplateBatchResult, AnkiRetemplateCardUpdate, AnkiRetemplateTarget,
  ChatAnkiCardRepository, ChatAnkiRawPrompt, ChatAnkiToolExecutor, ToolCall,
  ToolConcurrency, ToolExecutionContext, ToolResultInfo, ToolSensitivity,
} from '../api.ts';
import { STATUS_NOT_FOUND, verifyDocumentOwnership } from './card-access.ts';
import { convertBackendCard } from './block-patch.ts';
import {
  parseChatAnkiRetemplateArgs, type AnkiRetemplateSelector,
  type NormalizedChatAnkiRetemplateRequest,
} from './executor-args.ts';
import { chatankiSensitivityForCall } from './executor-helpers.ts';
import { errorText, stripToolNamespace } from './execution.ts';
import {
  mutationUiSyncReceipt, persistAndEmitCardMutation, preflightCardMutation,
} from './mutation-target.ts';
import {
  buildRetemplateFillPrompt, CHATANKI_RETEMPLATE_FILL_BATCH_SIZE,
  parseRetemplateFillResponse, retemplateFillFailed, retemplateFillSummary,
  retemplateUpdateForTool, writeRetemplateFill, type RetemplateFillOutcome,
} from './retemplate-fill.ts';
import { fsrsCardsChangedPayload } from './review-payloads.ts';
import {
  beginChatAnkiToolCall,
  finishChatAnkiFailure as finishFailure, finishChatAnkiSuccess as finishSuccess,
} from './result.ts';
import {
  ensureFieldExtractionRules, normalizeTemplateFields,
} from './template-fields.ts';
import { rustTrim } from '../../../platform/util/text.ts';
import { compareUtf8 } from '../../../platform/util/utf8.ts';

const ANKI_DB_UNAVAILABLE = 'blocks.ankiCards.errors.databaseUnavailable';
const TEMPLATE_DB_UNAVAILABLE = 'blocks.ankiCards.errors.templateDatabaseUnavailable';

function cardRepository(ctx: ToolExecutionContext): ChatAnkiCardRepository | null {
  return ctx.cards ?? null;
}

function selectionChangedPayload(cardIds: readonly string[]): Record<string, unknown> {
  return {
    status: 'conflict',
    error: 'selection_changed',
    cardIds: [...cardIds],
    mutationApplied: false,
    retryable: true,
    guidance: 'Call builtin-chatanki_get_cards to refresh the live card set and versions before retrying.',
  };
}

export function retemplateRejectionPayload(
  result: Exclude<AnkiRetemplateBatchResult, { kind: 'updated' }>,
): Record<string, unknown> {
  switch (result.kind) {
    case 'selectionNotFound':
      return selectionChangedPayload(result.cardIds);
    case 'ownershipRejected':
      return {
        status: 'rejected',
        error: 'status_not_found',
        mutationApplied: false,
        retryable: false,
      };
    case 'crossDocumentSelection':
      return {
        status: 'rejected',
        error: 'cross_document_selection',
        documentIds: [...result.documentIds],
        mutationApplied: false,
        retryable: false,
      };
    case 'documentSetChanged':
      return {
        status: 'conflict',
        error: 'selection_changed',
        documentIds: [...result.documentIds],
        mutationApplied: false,
        retryable: true,
        guidance: 'Call builtin-chatanki_get_cards to refresh the live card set and versions before retrying.',
      };
    case 'expectedVersionsMismatch':
      return {
        status: 'conflict',
        error: 'expected_versions_mismatch',
        missingVersionIds: [...result.missingVersionIds],
        unexpectedVersionIds: [...result.unexpectedVersionIds],
        mutationApplied: false,
        retryable: true,
        guidance: 'expectedVersions must contain exactly one current version for every selected live card. Call builtin-chatanki_get_cards before retrying.',
      };
    case 'versionConflict':
      return {
        status: 'conflict',
        error: 'version_conflict',
        conflicts: result.conflicts.map((conflict) => ({
          cardId: conflict.cardId,
          expectedVersion: conflict.expectedVersion,
          currentVersion: conflict.currentVersion,
        })),
        mutationApplied: false,
        retryable: true,
        guidance: 'Call builtin-chatanki_get_cards to refresh current card contents and versions before retrying.',
      };
    case 'invalidCloze':
      return {
        status: 'blocked',
        error: 'invalid_cloze_text',
        offendingCardIds: [...result.cardIds],
        mutationApplied: false,
        retryable: true,
        guidance: "Use builtin-chatanki_update_card to set each offending card's text to valid non-empty {{cN::answer}} Cloze markup, then retry.",
      };
  }
}

function resolveSelectorDocument(
  repo: ChatAnkiCardRepository,
  selector: AnkiRetemplateSelector,
  sessionId: string,
  warn: (message: string) => void,
): { documentId: string | null; missingCardIds: string[] } {
  if (selector.kind === 'document') {
    verifyDocumentOwnership(repo, selector.documentId, sessionId, warn);
    return { documentId: selector.documentId, missingCardIds: [] };
  }
  const documentIds = new Set<string>();
  const missingCardIds: string[] = [];
  for (const cardId of selector.cardIds) {
    let owned: { card: unknown; documentId: string } | null = null;
    try { owned = repo.loadOwnedCard(cardId, sessionId); }
    catch (caught) {
      throw new Error(`Failed to resolve selected card: ${errorText(caught)}`);
    }
    if (owned !== null) {
      documentIds.add(owned.documentId);
      continue;
    }
    let exists: { card: unknown; documentId: string } | null = null;
    try { exists = repo.getCardWithDocument(cardId); }
    catch (caught) {
      throw new Error(`Failed to resolve selected card: ${errorText(caught)}`);
    }
    if (exists !== null) throw new Error(STATUS_NOT_FOUND);
    missingCardIds.push(cardId);
  }
  if (missingCardIds.length > 0) {
    missingCardIds.sort(compareUtf8);
    return { documentId: null, missingCardIds };
  }
  const sorted = [...documentIds].sort(compareUtf8);
  if (sorted.length !== 1) {
    throw new Error(`cross_document_selection:${sorted.join(',')}`);
  }
  const documentId = sorted[0] as string;
  verifyDocumentOwnership(repo, documentId, sessionId, warn);
  return { documentId, missingCardIds: [] };
}

async function runFillPhase(
  repo: ChatAnkiCardRepository,
  sessionId: string,
  targetNoteType: string,
  updates: AnkiRetemplateCardUpdate[],
  rawPrompt: ChatAnkiRawPrompt,
): Promise<Map<string, RetemplateFillOutcome>> {
  const outcomes = new Map<string, RetemplateFillOutcome>();
  const pendingIndices = updates
    .map((update, index) => ({ update, index }))
    .filter(({ update }) => update.missingFields.length > 0)
    .map(({ index }) => index);

  for (let offset = 0; offset < pendingIndices.length; offset += CHATANKI_RETEMPLATE_FILL_BATCH_SIZE) {
    const chunk = pendingIndices.slice(offset, offset + CHATANKI_RETEMPLATE_FILL_BATCH_SIZE);
    const batch = chunk.map((index) => updates[index] as AnkiRetemplateCardUpdate);
    const prompt = buildRetemplateFillPrompt(targetNoteType, batch);
    let generated: Map<string, Map<string, string>>;
    try {
      const response = await rawPrompt.callAnkiModel2RawPrompt(prompt);
      generated = parseRetemplateFillResponse(response.assistantMessage);
    } catch (caught) {
      const failure = retemplateFillFailed(errorText(caught));
      for (const index of chunk) {
        const update = updates[index] as AnkiRetemplateCardUpdate;
        outcomes.set(update.card.id, failure);
      }
      continue;
    }
    for (const index of chunk) {
      const update = updates[index] as AnkiRetemplateCardUpdate;
      const fields = generated.get(update.card.id);
      const outcome = fields === undefined
        ? { status: 'skipped' as const, filledFields: [], error: 'llm_returned_no_fields' }
        : writeRetemplateFill(
          update, fields,
          (card, expectedVersion) =>
            repo.updateCardIfVersionForSession(card, expectedVersion, sessionId),
        );
      outcomes.set(update.card.id, outcome);
    }
  }
  return outcomes;
}

export async function executeRetemplate(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  let request: NormalizedChatAnkiRetemplateRequest;
  try {
    request = parseChatAnkiRetemplateArgs(call.arguments);
  } catch (caught) {
    return finishFailure(call, ctx, startedAt,
      `Invalid chatanki_retemplate arguments: ${errorText(caught)}`);
  }

  const repo = cardRepository(ctx);
  if (repo === null) return finishFailure(call, ctx, startedAt, ANKI_DB_UNAVAILABLE);

  let rawPrompt: ChatAnkiRawPrompt | null = null;
  if (request.strategy === 'fill_missing_llm') {
    rawPrompt = ctx.llmRawPrompt ?? null;
    if (rawPrompt === null) {
      return finishFailure(call, ctx, startedAt,
        'LLM manager not available for fill_missing_llm');
    }
  }

  const templateDb = ctx.mainDb ?? ctx.ankiDb ?? ctx.templateLookup ?? null;
  if (templateDb === null) {
    return finishFailure(call, ctx, startedAt, TEMPLATE_DB_UNAVAILABLE);
  }
  let template;
  try { template = templateDb.getCustomTemplateById(request.targetTemplateId); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt,
      `Failed to load target template: ${errorText(caught)}`);
  }
  if (template === null) {
    return finishFailure(call, ctx, startedAt, 'target_template_not_found');
  }
  if (!template.is_active) {
    return finishFailure(call, ctx, startedAt, 'target_template_inactive');
  }

  const fields = normalizeTemplateFields(template.fields);
  const rules = ensureFieldExtractionRules(fields, template.field_extraction_rules);
  const requiredFields = Object.entries(rules)
    .filter(([, rule]) => rule.is_required)
    .map(([field]) => field);
  const target: AnkiRetemplateTarget = {
    templateId: template.id,
    noteType: template.note_type,
    fields,
    requiredFields,
  };

  let documentId: string;
  try {
    const resolved = resolveSelectorDocument(repo, request.selector, ctx.sessionId, ctx.warn);
    if (resolved.missingCardIds.length > 0) {
      return finishSuccess(call, ctx, startedAt, selectionChangedPayload(resolved.missingCardIds));
    }
    documentId = resolved.documentId as string;
  } catch (caught) {
    const text = errorText(caught);
    if (text.startsWith('cross_document_selection:')) {
      const documentIds = text.slice('cross_document_selection:'.length).split(',').filter(Boolean);
      return finishSuccess(call, ctx, startedAt, {
        status: 'rejected',
        error: 'cross_document_selection',
        documentIds,
        mutationApplied: false,
        retryable: false,
      });
    }
    return finishFailure(call, ctx, startedAt, text);
  }

  let mutationTarget;
  try {
    mutationTarget = preflightCardMutation(ctx.chatBlocks ?? null, ctx.sessionId, documentId);
  } catch (caught) {
    return finishFailure(call, ctx, startedAt,
      `Unable to prepare card UI synchronization: ${errorText(caught)}`);
  }

  let result: AnkiRetemplateBatchResult;
  try {
    result = repo.retemplateCardsForSession(
      request.selector,
      target,
      new Map(Object.entries(request.expectedVersions)),
      ctx.sessionId,
      [documentId],
    );
  } catch (caught) {
    return finishFailure(call, ctx, startedAt,
      `Failed to retemplate cards: ${errorText(caught)}`);
  }
  if (result.kind !== 'updated') {
    return finishSuccess(call, ctx, startedAt, retemplateRejectionPayload(result));
  }

  const targetNoteType = result.targetNoteType;
  const updates = result.updates.map((update) => structuredClone(update));
  const fillOutcomes = rawPrompt === null
    ? new Map<string, RetemplateFillOutcome>()
    : await runFillPhase(repo, ctx.sessionId, targetNoteType, updates, rawPrompt);

  const eventCards = updates.map((update) => convertBackendCard(update.card));
  const uiSync = mutationUiSyncReceipt(persistAndEmitCardMutation(
    { chatBlocks: ctx.chatBlocks ?? null, documents: ctx.documents ?? null, cards: repo },
    mutationTarget,
    documentId,
    { documentId, cardMutation: 'upsert', cards: eventCards },
    (blockId, patch) => { ctx.emitChunk?.(blockId, patch); },
  ));
  const updatedIds = updates.map((update) => update.card.id);
  if (ctx.emitEvent !== undefined && ctx.emitEvent !== null) {
    ctx.emitEvent(
      'fsrs://changed',
      fsrsCardsChangedPayload('cards_retemplated', updatedIds, ctx.runId ?? ''),
    );
  }

  const missingCards = updates.filter((update) => update.missingFields.length > 0).length;
  const cards = updates.map((update) => retemplateUpdateForTool(
    update, request.strategy, fillOutcomes.get(update.card.id) ?? null,
  ));
  const payload: Record<string, unknown> = {
    status: uiSync.status,
    documentId,
    targetTemplateId: target.templateId,
    targetNoteType,
    isCloze: rustTrim(targetNoteType).toLowerCase() === 'cloze',
    strategy: request.strategy,
    updated: cards.length,
    missingCards,
    cards,
    mutationApplied: true,
    retryable: false,
    uiSync: uiSync.receipt,
  };
  if (request.strategy === 'fill_missing_llm') {
    payload.fill = retemplateFillSummary(fillOutcomes);
  }
  return finishSuccess(call, ctx, startedAt, payload);
}

export class ChatAnkiRetemplateExecutor implements ChatAnkiToolExecutor {
  canHandle(toolName: string): boolean {
    return stripToolNamespace(toolName) === 'chatanki_retemplate';
  }
  sensitivityLevel(toolName: string): ToolSensitivity {
    return chatankiSensitivityForCall(toolName, {});
  }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }
  name(): string { return 'ChatAnkiRetemplateExecutor'; }
  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    beginChatAnkiToolCall(call, ctx);
    if (stripToolNamespace(call.name) !== 'chatanki_retemplate') {
      return finishFailure(call, ctx, performance.now(),
        `Unsupported chatanki retemplate tool: ${call.name}`);
    }
    return executeRetemplate(call, ctx);
  }
}

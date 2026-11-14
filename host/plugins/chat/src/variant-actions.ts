/**
 * Variant management. Rust source: `chat_v2/handlers/variant_handlers.rs`.
 * Retry commands need the LLM pipeline and stay unregistered here; switch,
 * delete and cancel are pure DB/state transitions.
 */
import type { ChatMessage, DeleteVariantResult, Variant } from '../api.ts';
import type { SendOptions } from '../../../../contracts/ipc/generated/_shared.ts';
import type { ChatV2State } from '../api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { ChatV2Error } from './error.ts';
import { ensureSessionWritable } from './handlers.ts';
import { deleteBlock } from '../repository/blocks.ts';
import { getMessage, getSessionMessages, updateMessage } from '../repository/messages.ts';
import { saveSessionSkillState } from '../repository/session-state.ts';
import type { SessionSkillState } from '../repository/session-state.ts';
import { incrementSkillVersion, sortedSkillIds } from './session-skill-state.ts';
import { errorText, type ChatLogger } from './logger.ts';

export const VARIANT_STATUS = {
  PENDING: 'pending', STREAMING: 'streaming', SUCCESS: 'success',
  ERROR: 'error', CANCELLED: 'cancelled', INTERRUPTED: 'interrupted',
} as const;

/** `Variant::can_activate` (types.rs:1027-1029). */
export function canActivateVariant(variant: Variant): boolean {
  return variant.status !== VARIANT_STATUS.ERROR;
}

/** `Variant::can_retry` (types.rs:1032-1034). */
export function canRetryVariant(variant: Variant): boolean {
  return variant.status === VARIANT_STATUS.ERROR || variant.status === VARIANT_STATUS.CANCELLED;
}

/** `ChatMessage::get_variant` (types.rs:1705-1707). */
export function getVariant(message: ChatMessage, variantId: string): Variant | undefined {
  return message.variants?.find(variant => variant.id === variantId);
}

/** `session_skill_state_from_snapshot` (variant_handlers.rs:70-87). */
export function sessionSkillStateFromSnapshot(snapshot: {
  manualPinnedSkillIds?: string[]; modeRequiredBundleIds?: string[];
  agenticSessionSkillIds?: string[]; branchLocalSkillIds?: string[];
  effectiveAllowedExternalServers?: string[];
  version: number | bigint;
}): SessionSkillState {
  const agentic = sortedSkillIds(snapshot.agenticSessionSkillIds ?? []);
  return {
    manualPinnedSkillIds: snapshot.manualPinnedSkillIds ?? [],
    modeRequiredBundleIds: snapshot.modeRequiredBundleIds ?? [],
    agenticSessionSkillIds: [...new Set(agentic)],
    branchLocalSkillIds: [],
    effectiveAllowedExternalServers: snapshot.effectiveAllowedExternalServers ?? [],
    version: incrementSkillVersion(snapshot.version),
    legacyMigrated: false,
  };
}

/** `sync_session_skill_state_from_variant` (variant_handlers.rs:89-104); failures are ignored. */
function syncSessionSkillStateFromVariant(db: DatabaseHandle, sessionId: string, variant: Variant, log?: ChatLogger): void {
  const snapshot = variant.meta?.skillSnapshotAfter ?? variant.meta?.skillSnapshotBefore;
  if (snapshot === null || snapshot === undefined) return;
  try {
    saveSessionSkillState(db, sessionId, sessionSkillStateFromSnapshot(snapshot));
  } catch (error) {
    // Rust `let _ = ...` discards the update error; keep it visible in logs.
    log?.warn('[ChatV2::VariantHandler] Failed to sync session skill state: ' + errorText(error));
  }
}

/** `ensure_message_owned_by_session` (variant_handlers.rs:1127-1137). */
function ensureMessageOwnedBySession(message: ChatMessage, sessionId: string, action: string): void {
  if (message.sessionId !== sessionId) {
    throw new ChatV2Error('Validation',
      `Permission denied: cannot ${action} for message in another session`);
  }
}

/** `chat_v2_switch_variant` / `switch_variant_impl` (variant_handlers.rs:153-219). */
export function switchVariantAction(
  db: DatabaseHandle, sessionId: string, messageId: string, variantId: string, log?: ChatLogger,
): void {
  ensureSessionWritable(db, sessionId);
  const message = getMessage(db, messageId);
  if (!message) throw new ChatV2Error('MessageNotFound', messageId);
  ensureMessageOwnedBySession(message, sessionId, 'switch variant');
  const variant = getVariant(message, variantId);
  if (!variant) throw new ChatV2Error('VariantNotFound', variantId);
  if (!canActivateVariant(variant)) throw new ChatV2Error('VariantCannotActivateFailed', variantId);
  updateMessage(db, { ...message, activeVariantId: variantId }, log);
  syncSessionSkillStateFromVariant(db, sessionId, variant, log);
  log?.info(`[ChatV2::VariantHandler] Variant switched: message_id=${messageId}, variant_id=${variantId}`);
}

/** `chat_v2_delete_variant` / `delete_variant_impl` (variant_handlers.rs:224-390). */
export function deleteVariantAction(
  db: DatabaseHandle, sessionId: string, messageId: string, variantId: string, log?: ChatLogger,
): DeleteVariantResult {
  ensureSessionWritable(db, sessionId);
  const message = getMessage(db, messageId);
  if (!message) throw new ChatV2Error('MessageNotFound', messageId);
  ensureMessageOwnedBySession(message, sessionId, 'delete variant');
  const variants = message.variants;
  if (variants === undefined || variants === null) throw new ChatV2Error('VariantNotFound', variantId);
  if (variants.length <= 1) throw new ChatV2Error('VariantCannotDeleteLast');
  const variantIndex = variants.findIndex(variant => variant.id === variantId);
  if (variantIndex < 0) throw new ChatV2Error('VariantNotFound', variantId);
  const variantToDelete = variants[variantIndex];
  if (!variantToDelete) throw new ChatV2Error('VariantNotFound', variantId);
  if (variantToDelete.status === VARIANT_STATUS.STREAMING) {
    throw new ChatV2Error('Other',
      'Cannot delete a streaming variant. Please wait for completion or cancel it first.');
  }
  const blockIdsToDelete = new Set(variantToDelete.blockIds);
  for (const blockId of blockIdsToDelete) {
    try { deleteBlock(db, blockId); } catch (error) {
      log?.warn(`[ChatV2::VariantHandler] Failed to delete block ${blockId}: ` + errorText(error));
    }
  }
  const newVariants = variants.filter((_, index) => index !== variantIndex);
  let newActiveVariantId: string | null = null;
  if (message.activeVariantId === variantId) {
    for (const status of [VARIANT_STATUS.SUCCESS, VARIANT_STATUS.PENDING,
      VARIANT_STATUS.STREAMING, VARIANT_STATUS.CANCELLED]) {
      const found = newVariants.find(variant => variant.status === status);
      if (found) { newActiveVariantId = found.id; break; }
    }
    if (newActiveVariantId === null) {
      const found = newVariants.find(canActivateVariant);
      if (found) newActiveVariantId = found.id;
    }
    if (newActiveVariantId === null) newActiveVariantId = newVariants[0]?.id ?? null;
  }
  const updated: ChatMessage = {
    ...message,
    activeVariantId: message.activeVariantId === variantId ? newActiveVariantId : message.activeVariantId,
    variants: newVariants,
    blockIds: message.blockIds.filter(id => !blockIdsToDelete.has(id)),
  };
  updateMessage(db, updated, log);
  if (newActiveVariantId !== null) {
    const next = newVariants.find(variant => variant.id === newActiveVariantId);
    if (next) syncSessionSkillStateFromVariant(db, message.sessionId, next, log);
  }
  return {
    deletedVariantId: variantId,
    remainingCount: newVariants.length,
    newActiveVariantId,
  };
}

/** `ensure_variant_belongs_to_session` (variant_handlers.rs:1139-1158). */
function ensureVariantBelongsToSession(db: DatabaseHandle, sessionId: string, variantId: string, log?: ChatLogger): void {
  const messages = getSessionMessages(db, sessionId, log);
  const found = messages.some(message => message.variants?.some(variant => variant.id === variantId) ?? false);
  if (!found) {
    throw new ChatV2Error('Validation', `Variant ${variantId} does not belong to session ${sessionId}`);
  }
}

/** `chat_v2_cancel_variant` / `cancel_variant_impl` (variant_handlers.rs:1085-1123). */
export function cancelVariantAction(
  db: DatabaseHandle, state: ChatV2State, sessionId: string, variantId: string,
  log?: ChatLogger,
): void {
  log?.info(`[ChatV2::VariantHandler] cancel_variant: session_id=${sessionId}, variant_id=${variantId}`);
  ensureVariantBelongsToSession(db, sessionId, variantId, log);
  if (state.cancelStream(`${sessionId}:${variantId}`)) {
    log?.info(`[ChatV2::VariantHandler] CancellationToken cancelled: session_id=${sessionId}, variant_id=${variantId}`);
  } else log?.debug(`[ChatV2::VariantHandler] No active CancellationToken for session_id=${sessionId}, variant_id=${variantId}`);
}

/**
 * `resolve_retry_options` (variant_handlers.rs:106-162). Saved chat params are
 * only read when the frontend did not pass a full options object.
 */
export function resolveRetryOptions(
  savedChatParams: Record<string, unknown> | null | undefined,
  modelId: string,
  optionsOverride: SendOptions | null | undefined,
): SendOptions {
  if (optionsOverride !== null && optionsOverride !== undefined) {
    const options: SendOptions = {
      ...optionsOverride,
      modelId,
      model2OverrideId: modelId,
      parallelModelIds: null,
    };
    if (options.replayMode !== null && options.replayMode !== undefined) options.temperature = 0;
    return options;
  }
  const options: SendOptions = { modelId, model2OverrideId: modelId };
  if (savedChatParams !== null && savedChatParams !== undefined) {
    const temperature = savedChatParams.temperature;
    if (typeof temperature === 'number') options.temperature = temperature;
    const maxTokens = savedChatParams.maxTokens;
    if (typeof maxTokens === 'number' && Number.isInteger(maxTokens) && maxTokens >= 0) {
      options.maxTokens = Number(BigInt.asUintN(32, BigInt(maxTokens)));
    }
    const enableThinking = savedChatParams.enableThinking;
    if (typeof enableThinking === 'boolean') options.enableThinking = enableThinking;
    const reasoningEffort = savedChatParams.reasoningEffort;
    if (typeof reasoningEffort === 'string') options.reasoningEffort = reasoningEffort;
    const thinkingBudget = savedChatParams.thinkingBudget;
    if (typeof thinkingBudget === 'number' && Number.isInteger(thinkingBudget)) {
      options.thinkingBudget = Number(BigInt.asIntN(32, BigInt(thinkingBudget)));
    }
  }
  if (options.replayMode !== null && options.replayMode !== undefined) options.temperature = 0;
  return options;
}

// Rust: chatanki_executor.rs execute_transform / apply_transform /
// run_transform_script_mode / transform_dry_run_payload (4553–5050, 12644–12870).
import type {
  AnkiCard, ToolCall, ToolExecutionContext, ToolResultInfo,
} from '../api.ts';
import { errorText } from './execution.ts';
import { verifyDocumentOwnership, STATUS_NOT_FOUND } from './card-access.ts';
import { convertBackendCard } from './block-patch.ts';
import {
  applyCardPatch, CHATANKI_CARD_FIELD_LIMIT, convertCardForTool,
} from './executor-args.ts';
import {
  mutationUiSyncReceipt, persistAndEmitCardMutation, preflightCardMutation,
  type AnkiCardsMutationTarget,
} from './mutation-target.ts';
import { fsrsCardsChangedPayload } from './review-payloads.ts';
import { finishChatAnkiFailure, finishChatAnkiSuccess } from './result.ts';
import {
  changedFieldNames, checkExpectedVersions, compileTransformOps, compileTransformOpsAsync,
  normalizeTransformArgs, parseTransformArgs, planTransformOps, planTransformOpsAsync,
  selectTransformCards, transformFieldsAreValid, transformFieldsFromCard,
  ExpectedVersionsMismatch, TransformSelectionError,
  type AsyncCompiledTransformOp, type CompiledTransformOp, type NormalizedTransformRequest,
  type TransformCardPlan, type TransformFields,
} from './transform.ts';
import {
  evaluateScriptOutput, executionReportToJson, runTransformScript,
  ScriptOutputError, TransformScriptRunError,
  type ScriptExecutionReport,
} from './transform-script.ts';
import { rustTrim } from '../../../platform/util/text.ts';

const CARD_FIELD_LIMIT = CHATANKI_CARD_FIELD_LIMIT;

type ScriptMeta = Record<string, unknown>;

function safeTruncateChars(value: string, maxChars: number): string {
  const chars = [...value];
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join('');
}

/** chatanki_executor.rs:12856–12880: changed fields only, long values truncated. */
export function transformFieldsDisplay(
  fields: TransformFields, changed: readonly string[],
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const name of changed) {
    if (name === 'front') output.front = safeTruncateChars(fields.front, CARD_FIELD_LIMIT);
    else if (name === 'back') output.back = safeTruncateChars(fields.back, CARD_FIELD_LIMIT);
    else if (name === 'text') {
      output.text = fields.text === null
        ? null
        : safeTruncateChars(fields.text, CARD_FIELD_LIMIT);
    } else if (name === 'tags') output.tags = [...fields.tags];
  }
  return output;
}

/** chatanki_executor.rs:12644–12712. */
export function transformDryRunPayload(
  documentId: string,
  selected: readonly AnkiCard[],
  plans: readonly TransformCardPlan[],
): Record<string, unknown> {
  const diff: Array<Record<string, unknown>> = [];
  let changedCount = 0;
  let unchangedCount = 0;
  let invalidCount = 0;
  for (const [index, card] of selected.entries()) {
    const plan = plans[index];
    if (plan === undefined) continue;
    if (plan.kind === 'invalid') {
      invalidCount += 1;
      diff.push({
        cardId: card.id,
        invalid: true,
        error: plan.code,
        detail: plan.detail,
      });
      continue;
    }
    const after = plan.fields;
    const before = transformFieldsFromCard(card);
    const changedFields = changedFieldNames(before, after);
    if (changedFields.length === 0) {
      unchangedCount += 1;
      continue;
    }
    changedCount += 1;
    const valid = transformFieldsAreValid(after);
    if (!valid) invalidCount += 1;
    diff.push({
      cardId: card.id,
      fields: changedFields,
      before: transformFieldsDisplay(before, changedFields),
      after: transformFieldsDisplay(after, changedFields),
      wouldBeInvalid: !valid,
    });
  }
  return {
    status: 'ok',
    mode: 'dry_run',
    documentId,
    total: selected.length,
    changed: changedCount,
    unchanged: unchangedCount,
    invalid: invalidCount,
    diff,
    mutationApplied: false,
    retryable: false,
    uiSync: { status: 'not_required', eventAttempted: false },
    guidance: invalidCount > 0
      ? 'Some cards would be rejected per-card on apply (invalid transform output or empty front+back with no cloze text). Adjust the transform before applying.'
      : 'Review the diff with the user, then re-run with mode=apply and the complete expectedVersions from the latest get_cards.',
  };
}

/** chatanki_executor.rs:12715–12733: script metadata is merged into the top level. */
export function mergeTransformScriptMeta(
  payload: Record<string, unknown>, meta: ScriptMeta | null,
): Record<string, unknown> {
  if (meta === null) return payload;
  return { ...payload, ...meta };
}

/** chatanki_executor.rs:12736–12853: every script failure becomes a payload. */
export function transformScriptRunErrorPayload(
  documentId: string,
  mode: string,
  scriptTimeoutMs: number,
  error: TransformScriptRunError,
): Record<string, unknown> {
  const base = {
    documentId,
    mode,
    mutationApplied: false,
    retryable: false,
  };
  switch (error.kind) {
    case 'sandbox_unavailable':
      return {
        ...base,
        status: 'rejected',
        error: 'script_sandbox_unavailable',
        detail: error.detail,
        guidance: 'Script mode requires the desktop hard sandbox (macOS Seatbelt / Linux bubblewrap / Windows AppContainer) and is unavailable on this platform (e.g. mobile). Use transform.ops instead.',
      };
    case 'interpreter_unavailable':
      return {
        ...base,
        status: 'rejected',
        error: 'interpreter_unavailable',
        language: error.language,
        detail: error.detail,
        guidance: 'No usable interpreter was found on this machine. Ask the user to install it, switch transform.script.language, or use transform.ops.',
      };
    case 'setup':
      return {
        ...base,
        status: 'failed',
        error: 'script_setup_failed',
        detail: error.detail,
      };
    case 'timed_out':
      return {
        ...base,
        status: 'failed',
        error: 'script_timed_out',
        script: scriptReportJson(error.report, scriptTimeoutMs),
        guidance: 'The script exceeded timeoutMs and its process group was terminated; no card was modified. Optimize the script, raise timeoutMs (max 120000), or narrow the selection.',
      };
    case 'non_zero_exit':
      return {
        ...base,
        status: 'failed',
        error: 'script_failed',
        script: scriptReportJson(error.report, scriptTimeoutMs),
        guidance: 'The script exited non-zero; see stderrTail. Fix the script and retry; no card was modified.',
      };
    case 'output_missing':
      return {
        ...base,
        status: 'failed',
        error: 'script_output_missing',
        script: scriptReportJson(error.report, scriptTimeoutMs),
        guidance: 'The script exited 0 but never wrote $CHATANKI_OUTPUT. Write the full {"cards": [...]} JSON to the CHATANKI_OUTPUT path and retry.',
      };
    case 'output_too_large':
      return {
        ...base,
        status: 'failed',
        error: 'script_output_too_large',
        outputBytes: error.bytes,
        limitBytes: error.limit,
        script: scriptReportJson(error.report, scriptTimeoutMs),
        guidance: 'CHATANKI_OUTPUT.json exceeds the size limit. Only include changed cards and changed fields in the output.',
      };
  }
}

function scriptReportJson(
  report: ScriptExecutionReport | null, timeoutMs: number,
): Record<string, unknown> | null {
  return report === null ? null : executionReportToJson(report, timeoutMs);
}

function scriptEnvironmentUnavailablePayload(
  documentId: string, mode: string,
): Record<string, unknown> {
  return {
    status: 'rejected',
    error: 'script_environment_unavailable',
    documentId,
    mode,
    detail: 'script mode requires a desktop app window to resolve the session temp root',
    mutationApplied: false,
    retryable: false,
    guidance: 'Use transform.ops (regex_replace / tag_add / tag_remove) in this environment.',
  };
}

function invalidScriptOutputPayload(
  documentId: string, mode: string, detail: string,
  report: ScriptExecutionReport, scriptTimeoutMs: number, jobPath: string,
): Record<string, unknown> {
  return {
    status: 'failed',
    error: 'invalid_script_output',
    documentId,
    mode,
    detail,
    script: executionReportToJson(report, scriptTimeoutMs),
    jobPath,
    mutationApplied: false,
    retryable: false,
    guidance: "CHATANKI_OUTPUT.json must be a JSON object with a 'cards' array of {id, front?, back?, text?, tags?} entries. Fix the script and retry; no card was modified.",
  };
}

function emitCardUpdateChunk(
  ctx: ToolExecutionContext,
  blockId: string,
  patch: Record<string, unknown>,
): void {
  const emit = ctx.emitChunk ?? null;
  if (emit === null) return;
  try { emit(blockId, patch); }
  catch (caught) {
    ctx.warn(`[ChatAnkiToolExecutor] Failed to emit anki_cards chunk: ${errorText(caught)}`);
  }
}

/** chatanki_executor.rs:13709–13726: best-effort `fsrs://changed` with cards. */
function emitFsrsCardsChanged(
  ctx: ToolExecutionContext,
  action: string,
  cards: readonly AnkiCard[],
): void {
  const emit = ctx.emitEvent ?? null;
  if (emit === null) return;
  const payload = fsrsCardsChangedPayload(
    action, cards.map((card) => card.id), ctx.runId ?? ctx.messageId,
  );
  if (cards.length > 0) payload.cards = cards.map(convertBackendCard);
  try { emit('fsrs://changed', payload); }
  catch (caught) {
    ctx.warn(`[ChatAnkiToolExecutor] Failed to emit fsrs://changed after ${action}: ${errorText(caught)}`);
  }
}

async function applyTransform(
  call: ToolCall,
  ctx: ToolExecutionContext,
  startedAt: number,
  request: NormalizedTransformRequest,
  selected: readonly AnkiCard[],
  plans: readonly TransformCardPlan[],
  scriptMeta: ScriptMeta | null,
): Promise<ToolResultInfo> {
  const repository = ctx.cards;
  if (repository === null || repository === undefined) {
    return finishChatAnkiFailure(
      call, ctx, startedAt, 'blocks.ankiCards.errors.databaseUnavailable',
    );
  }
  const documentId = request.documentId;
  let mutationTarget: AnkiCardsMutationTarget;
  try {
    mutationTarget = preflightCardMutation(
      ctx.chatBlocks ?? null, ctx.sessionId, documentId,
    );
  } catch (caught) {
    return finishChatAnkiFailure(
      call, ctx, startedAt,
      `Unable to prepare card UI synchronization: ${errorText(caught)}`,
    );
  }

  const total = selected.length;
  const results: Array<Record<string, unknown>> = [];
  const updatedCards: AnkiCard[] = [];
  let unchangedCount = 0;
  let conflictCount = 0;
  let invalidCount = 0;
  let failedCount = 0;

  for (const [index, source] of selected.entries()) {
    const plan = plans[index];
    if (plan === undefined) continue;
    const cardId = source.id;
    if (plan.kind === 'invalid') {
      invalidCount += 1;
      results.push({
        cardId, status: 'invalid', error: plan.code, detail: plan.detail,
      });
      continue;
    }
    const before = transformFieldsFromCard(source);
    const after = plan.fields;
    const changedFields = changedFieldNames(before, after);
    if (changedFields.length === 0) {
      unchangedCount += 1;
      results.push({ cardId, status: 'unchanged' });
      continue;
    }
    if (!transformFieldsAreValid(after)) {
      invalidCount += 1;
      results.push({
        cardId, status: 'invalid', fields: changedFields,
        error: 'blocks.ankiCards.errors.cardContentRequired',
      });
      continue;
    }
    const card: AnkiCard = structuredClone(source);
    applyCardPatch(card, {
      ...(changedFields.includes('front') ? { front: after.front } : {}),
      ...(changedFields.includes('back') ? { back: after.back } : {}),
      ...(changedFields.includes('text') ? { text: after.text } : {}),
      ...(changedFields.includes('tags') ? { tags: [...after.tags] } : {}),
    });
    const expectedVersion = Object.hasOwn(request.expectedVersions, cardId)
      ? request.expectedVersions[cardId] as string
      : '';
    let update;
    try {
      update = repository.updateCardIfVersionForSession(
        card, expectedVersion, ctx.sessionId,
      );
    } catch (caught) {
      failedCount += 1;
      results.push({
        cardId, status: 'failed', error: `Failed to update card: ${errorText(caught)}`,
      });
      continue;
    }
    if (update.kind === 'updated') {
      results.push({
        cardId, status: 'ok', fields: changedFields,
        card: convertCardForTool(update.card, null),
      });
      updatedCards.push(update.card);
    } else if (update.kind === 'conflict') {
      conflictCount += 1;
      results.push({
        cardId, status: 'conflict', error: 'version_conflict',
        current: convertCardForTool(update.current, null),
      });
    } else {
      failedCount += 1;
      results.push({
        cardId, status: 'not_found', error: STATUS_NOT_FOUND,
      });
    }
  }

  const updatedCount = updatedCards.length;
  let uiStatus: 'ok' | 'partial' = 'ok';
  let uiSync: Record<string, unknown> = { status: 'not_required', eventAttempted: false };
  if (updatedCount > 0) {
    const eventCards = updatedCards.map(convertBackendCard);
    const sync = mutationUiSyncReceipt(persistAndEmitCardMutation(
      {
        chatBlocks: ctx.chatBlocks ?? null,
        documents: ctx.documents ?? null,
        cards: repository,
      },
      mutationTarget,
      documentId,
      { documentId, cardMutation: 'upsert', cards: eventCards },
      emitCardUpdateChunk.bind(null, ctx),
    ));
    uiStatus = sync.status;
    uiSync = sync.receipt;
    emitFsrsCardsChanged(ctx, 'card_updated', updatedCards);
  }

  const problemCount = conflictCount + invalidCount + failedCount;
  let status: string;
  if (problemCount === 0) status = uiStatus === 'ok' ? 'ok' : 'partial';
  else if (updatedCount > 0) status = 'partial';
  else if (conflictCount > 0) status = 'conflict';
  else if (invalidCount > 0 && failedCount === 0) status = 'blocked';
  else status = 'failed';

  const payload: Record<string, unknown> = {
    status,
    mode: 'apply',
    documentId,
    total,
    updated: updatedCount,
    unchanged: unchangedCount,
    conflicts: conflictCount,
    invalid: invalidCount,
    failed: failedCount,
    results,
    mutationApplied: updatedCount > 0,
    retryable: conflictCount > 0,
    uiSync,
  };
  return finishChatAnkiSuccess(
    call, ctx, startedAt, mergeTransformScriptMeta(payload, scriptMeta),
  );
}

async function runTransformScriptMode(
  ctx: ToolExecutionContext,
  request: NormalizedTransformRequest,
  selected: readonly AnkiCard[],
): Promise<
  | { ok: true; plans: TransformCardPlan[]; meta: ScriptMeta }
  | { ok: false; payload: Record<string, unknown> }
> {
  const documentId = request.documentId;
  const mode = request.mode;
  const script = request.script;
  if (script === null) throw new Error('script mode requires a normalized script');
  const tempRoot = ctx.transformTempRoot ?? null;
  if (tempRoot === null || rustTrim(tempRoot).length === 0) {
    return { ok: false, payload: scriptEnvironmentUnavailablePayload(documentId, mode) };
  }
  const sandbox = ctx.transformSandbox ?? null;
  if (sandbox === null) {
    return {
      ok: false,
      payload: transformScriptRunErrorPayload(
        documentId, mode, script.timeoutMs,
        new TransformScriptRunError(
          'sandbox_unavailable',
          'no desktop hard sandbox backend is available on this host',
        ),
      ),
    };
  }

  let result;
  try {
    result = await runTransformScript(sandbox, {
      tempRoot,
      documentId,
      cards: selected,
      script,
      warn: ctx.warn,
    });
  } catch (caught) {
    if (caught instanceof TransformScriptRunError) {
      return {
        ok: false,
        payload: transformScriptRunErrorPayload(
          documentId, mode, script.timeoutMs, caught,
        ),
      };
    }
    return {
      ok: false,
      payload: transformScriptRunErrorPayload(
        documentId, mode, script.timeoutMs,
        new TransformScriptRunError('setup', errorText(caught)),
      ),
    };
  }

  let evaluation;
  try {
    evaluation = evaluateScriptOutput(result.output, selected);
  } catch (caught) {
    if (caught instanceof ScriptOutputError) {
      return {
        ok: false,
        payload: invalidScriptOutputPayload(
          documentId, mode, caught.detail(), result.report, script.timeoutMs, result.jobRef,
        ),
      };
    }
    return {
      ok: false,
      payload: transformScriptRunErrorPayload(
        documentId, mode, script.timeoutMs,
        new TransformScriptRunError('setup', errorText(caught)),
      ),
    };
  }

  const plans: TransformCardPlan[] = evaluation.cardPlans.map((plan) =>
    plan.ok
      ? { kind: 'after', fields: plan.fields }
      : { kind: 'invalid', code: plan.issue.code, detail: plan.issue.detail });
  const meta: ScriptMeta = {
    script: executionReportToJson(result.report, script.timeoutMs),
    jobPath: result.jobRef,
  };
  if (evaluation.unknownCardIds.length > 0) {
    meta.unknownCardIds = evaluation.unknownCardIds;
  }
  return { ok: true, plans, meta };
}

/** chatanki_executor.rs:4553–4842 `execute_transform`. */
export async function executeChatAnkiTransform(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  let request: NormalizedTransformRequest;
  try {
    request = normalizeTransformArgs(parseTransformArgs(call.arguments));
  } catch (caught) {
    return finishChatAnkiFailure(
      call, ctx, startedAt,
      `Invalid chatanki_transform arguments: ${errorText(caught)}`,
    );
  }

  const repository = ctx.cards ?? null;
  if (repository === null) {
    return finishChatAnkiFailure(
      call, ctx, startedAt, 'blocks.ankiCards.errors.databaseUnavailable',
    );
  }
  const documentId = request.documentId;
  try { verifyDocumentOwnership(repository, documentId, ctx.sessionId, ctx.warn); }
  catch { return finishChatAnkiFailure(call, ctx, startedAt, STATUS_NOT_FOUND); }

  let compiledOps: CompiledTransformOp[] | null = null;
  let asyncOps: AsyncCompiledTransformOp[] | null = null;
  if (request.ops !== null) {
    const nativeRegex = ctx.nativeRegex ?? null;
    const nativeRegexAsync = ctx.nativeRegexAsync ?? null;
    if (nativeRegex === null && nativeRegexAsync === null) {
      return finishChatAnkiFailure(
        call, ctx, startedAt,
        'chatanki_transform regex ops require the F7 nativeRegex engine (Rust regex wasm); '
        + 'refusing to fall back to JS RegExp',
      );
    }
    try {
      if (nativeRegexAsync !== null) {
        asyncOps = await compileTransformOpsAsync(request.ops, nativeRegexAsync);
      } else {
        compiledOps = compileTransformOps(request.ops, nativeRegex as NonNullable<typeof nativeRegex>);
      }
    }
    catch (caught) {
      const invalid = caught as { opIndex?: number; pattern?: string; message?: string };
      return finishChatAnkiSuccess(call, ctx, startedAt, {
        status: 'blocked',
        error: 'invalid_pattern',
        documentId,
        opIndex: invalid.opIndex ?? 0,
        pattern: invalid.pattern ?? '',
        detail: invalid.message ?? errorText(caught),
        mutationApplied: false,
        retryable: false,
        guidance: 'Fix the Rust regex (regex crate syntax) at ops[opIndex] and retry; no card was modified.',
      });
    }
  }

  let cards: AnkiCard[] | null;
  try { cards = repository.getCardsForDocumentForSession(documentId, ctx.sessionId); }
  catch (caught) {
    return finishChatAnkiFailure(
      call, ctx, startedAt, `Failed to load cards for document: ${errorText(caught)}`,
    );
  }
  if (cards === null) {
    return finishChatAnkiFailure(call, ctx, startedAt, STATUS_NOT_FOUND);
  }

  let selected: AnkiCard[];
  try { selected = selectTransformCards(cards, request.selection); }
  catch (caught) {
    if (caught instanceof TransformSelectionError && caught.missingCards !== null) {
      return finishChatAnkiSuccess(call, ctx, startedAt, {
        status: 'conflict',
        error: 'selection_changed',
        documentId,
        cardIds: caught.missingCards,
        mutationApplied: false,
        retryable: true,
        guidance: 'Call builtin-chatanki_get_cards to refresh the live card set before retrying.',
      });
    }
    if (caught instanceof TransformSelectionError && caught.tooLarge !== null) {
      return finishChatAnkiSuccess(call, ctx, startedAt, {
        status: 'blocked',
        error: 'selection_too_large',
        documentId,
        selected: caught.tooLarge.selected,
        limit: caught.tooLarge.limit,
        mutationApplied: false,
        retryable: false,
        guidance: 'Narrow the selection with selection.cardIds or selection.filter and run the transform in batches.',
      });
    }
    throw caught;
  }

  if (request.mode === 'apply') {
    const selectedIds = selected.map((card) => card.id);
    try { checkExpectedVersions(selectedIds, request.expectedVersions); }
    catch (caught) {
      if (!(caught instanceof ExpectedVersionsMismatch)) throw caught;
      return finishChatAnkiSuccess(call, ctx, startedAt, {
        status: 'conflict',
        error: 'expected_versions_mismatch',
        documentId,
        missingVersionIds: caught.missingVersionIds,
        unexpectedVersionIds: caught.unexpectedVersionIds,
        mutationApplied: false,
        retryable: true,
        guidance: 'expectedVersions must contain exactly one current version for every selected card. Call builtin-chatanki_get_cards before retrying.',
      });
    }
  }

  let plans: TransformCardPlan[];
  let scriptMeta: ScriptMeta | null = null;
  if (request.ops !== null) {
    if (asyncOps !== null) {
      plans = await planTransformOpsAsync(asyncOps, selected, ctx.nativeRegexAsync as NonNullable<typeof ctx.nativeRegexAsync>);
    } else {
      if (compiledOps === null) throw new Error('ops mode always compiles before selection');
      plans = planTransformOps(compiledOps, selected);
    }
  } else {
    const scriptRun = await runTransformScriptMode(ctx, request, selected);
    if (scriptRun.ok === false) {
      return finishChatAnkiSuccess(call, ctx, startedAt, scriptRun.payload);
    }
    plans = scriptRun.plans;
    scriptMeta = scriptRun.meta;
  }

  if (request.mode === 'dry_run') {
    return finishChatAnkiSuccess(
      call, ctx, startedAt,
      mergeTransformScriptMeta(
        transformDryRunPayload(documentId, selected, plans), scriptMeta,
      ),
    );
  }
  return applyTransform(call, ctx, startedAt, request, selected, plans, scriptMeta);
}

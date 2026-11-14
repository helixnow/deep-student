// Rust: chatanki_executor.rs:6901–7213 (start_background_pipeline), :7378–7421 (cancelled before
// generation), :7462–8352 (run_chatanki_pipeline_background up to the poll loop; the VfsRef input is
// `run-vfs-input.ts`, the poll loop and terminal block are `run-pipeline-poll.ts`).
import type {
  AnkiGenerationOptions, ChatAnkiCardRepository, ChatAnkiChatBlockStore,
  ChatAnkiDocumentTaskRepository, ChatAnkiGenerationPipeline, ChatAnkiMessageLinks,
  ChatAnkiPreferenceMemory, ChatAnkiSettingsStore, CustomAnkiTemplate,
  FieldExtractionRule, ToolCall, ToolExecutionContext, ToolResultInfo,
} from '../api.ts';
import { persistAnkiCardsRunningPatch, persistAnkiCardsTerminalBlock } from './block-patch.ts';
import { resolveDeckAndNoteType } from './chatanki-executor.ts';
import { ensureCancelledDocumentSession, ensureFailedDocumentSession } from './document-session.ts';
import { errorText, stripToolNamespace } from './execution.ts';
import {
  applyMediaSourceRequirements, buildGenerationOptions, looksLikeGlossaryContent,
  type ChatAnkiGenerationTuning,
} from './generation-options.ts';
import { ChatAnkiPipelineRegistry } from './pipeline-registry.ts';
import { persistPreferenceObservationBestEffort } from './preference-memory.ts';
import type { ChatAnkiRoute } from './routing.ts';
import {
  resolveVfsRefInput, type ChatAnkiPipelineContent, type ChatAnkiRunInputSources,
} from './run-vfs-input.ts';
import {
  chatAnkiHandlerError, finishChatAnkiInlineFailure, finishChatAnkiSuccess,
} from './result.ts';
import { pollUntilTerminal } from './run-pipeline-poll.ts';
import {
  buildPreferenceHint, chatAnkiTemplateSource, clampMaxCardsArg, deriveDocumentName,
  normalizeGlossaryParagraphs, normalizeOutputProtocolArg, resolveTemplateSelection,
  type ChatAnkiPreferencePrompt, type ChatAnkiTemplateSource,
} from './run-options.ts';
import { ensureFieldExtractionRules, normalizeTemplateFields } from './template-fields.ts';
import {
  deriveEffectiveTemplateMode, effectiveSingleTemplateId, normalizeTemplateSelection,
  type ChatAnkiTemplateMode,
} from './template-selection.ts';
import { BLOCK_STATUS, nextChatankiStateRevision } from './workflow-status.ts';
import { now } from '../../../platform/time/index.ts';
import { charCount, rustTrim, takeChars } from '../../../platform/util/text.ts';

const ANKI_CARDS = 'anki_cards';

/** Monotonic clock + sleep of the poll loop (`Instant`, `tokio::time::sleep`). */
export interface ChatAnkiPipelineClock {
  monotonicMs(): number;
  sleep(ms: number): Promise<void>;
}

export const realPipelineClock: ChatAnkiPipelineClock = {
  monotonicMs: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
};

/** `PipelineInput` (:7223–7226). */
export type ChatAnkiPipelineInput =
  | { kind: 'content'; content: string }
  | { kind: 'vfsRef'; extraContent: string | null };

export interface ChatAnkiStartRequest {
  input: ChatAnkiPipelineInput;
  goal: string;
  deckName: string | null;
  noteType: string | null;
  templateMode: ChatAnkiTemplateMode;
  templateId: string | null;
  templateIds: string[] | null;
  debug: boolean;
  forcedRoute: ChatAnkiRoute | null;
  preferredResourceIds: string[] | null;
  maxCards: number | null;
  extraRequirements: string | null;
  tuning: ChatAnkiGenerationTuning;
}

/** All four L16 methods present: the run/start tools are claimable. */
export function generationPipelineOf(value: unknown): ChatAnkiGenerationPipeline | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return typeof record.startDocumentProcessingWithId === 'function'
    && typeof record.cancelStreaming === 'function'
    && typeof record.cancelDocumentProcessing === 'function'
    && typeof record.updateTaskStatus === 'function'
    ? value as ChatAnkiGenerationPipeline : null;
}

/** `upsert_block_allow_orphan` (:14592–14693): the message row fallback id is derived from the message id. */
function orphanFallbackSessionId(messageId: string): string {
  const derived = messageId.startsWith('msg_') ? `sess_${messageId.slice(4)}` : `orphan_sess_${messageId}`;
  return charCount(derived) > 40 ? takeChars(derived, 40) : derived;
}

function upsertBlockAllowOrphan(
  blocks: ChatAnkiChatBlockStore, links: ChatAnkiMessageLinks | null,
  block: Parameters<ChatAnkiChatBlockStore['upsertBlock']>[0] & { messageId: string },
): void {
  if (links !== null) {
    try { links.ensurePlaceholderMessage(block.messageId, orphanFallbackSessionId(block.messageId), Date.now()); }
    catch { /* boundary-allow empty-catch: chatanki_executor.rs:14619 `let _ = conn.execute(INSERT OR IGNORE …)` */ }
  }
  blocks.upsertBlock(block);
  if (links !== null) {
    try { links.appendBlockId(block.messageId, block.id); }
    catch { /* boundary-allow empty-catch: chatanki_executor.rs:14688 `let _ = append_block_id_to_message(…)` */ }
  }
}

export interface BackgroundParams {
  sessionId: string;
  messageId: string;
  ankiBlockId: string;
  toolName: string;
  blocks: ChatAnkiChatBlockStore;
  tasks: ChatAnkiDocumentTaskRepository;
  cards: Pick<ChatAnkiCardRepository, 'getCardsForDocument'>;
  generation: ChatAnkiGenerationPipeline;
  templates: ChatAnkiTemplateSource;
  settings: ChatAnkiSettingsStore | null;
  preferenceMemory: ChatAnkiPreferenceMemory | null;
  retrievePreferencePrompt: ChatAnkiPreferencePrompt | null;
  checkAnkiConnect: (() => Promise<boolean>) | null;
  mediaFileName: ((mediaId: string) => string | null) | null;
  emitChunk: (blockId: string, update: Record<string, unknown>) => void;
  emitBlockError: (blockId: string, error: string) => void;
  emitBlockEnd: (blockId: string, result: unknown) => void;
  emitEvent: (event: string, payload: unknown) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
  input: ChatAnkiPipelineInput;
  runInput: ChatAnkiRunInputSources | null;
  forcedRoute: ChatAnkiRoute | null;
  preferredResourceIds: string[] | null;
  goal: string;
  deckName: string;
  noteType: string;
  templateMode: ChatAnkiTemplateMode;
  templateId: string | null;
  templateIds: string[] | null;
  debugEnabled: boolean;
  documentId: string;
  maxCards: number | null;
  extraRequirements: string | null;
  tuning: ChatAnkiGenerationTuning;
  initialWarnings: Record<string, unknown>[];
  isCancelled: () => boolean;
  clock: ChatAnkiPipelineClock;
}

/** `start_background_pipeline` (:6901–7213): validate, persist the running block, return `started`, spawn. */
export async function startChatAnkiPipeline(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number, request: ChatAnkiStartRequest,
  clock: ChatAnkiPipelineClock = realPipelineClock,
): Promise<ToolResultInfo> {
  const extraRequirements = request.extraRequirements === null || rustTrim(request.extraRequirements).length === 0
    ? null : rustTrim(request.extraRequirements);
  const tuning = { ...request.tuning };
  try { tuning.outputProtocol = normalizeOutputProtocolArg(tuning.outputProtocol); }
  catch (caught) { return finishChatAnkiInlineFailure(call, ctx, startedAt, errorText(caught)); }

  const [maxCards, maxCardsWarning] = clampMaxCardsArg(request.maxCards);
  if (maxCardsWarning !== null) {
    ctx.warn(`[ChatAnkiToolExecutor] maxCards clamped: ${JSON.stringify(maxCardsWarning.messageParams)}`);
  }
  const initialWarnings = maxCardsWarning === null ? [] : [maxCardsWarning];

  if (rustTrim(request.goal).length === 0) return finishChatAnkiInlineFailure(call, ctx, startedAt, 'goal is required');

  const blocks = ctx.chatBlocks ?? null;
  if (blocks === null) throw chatAnkiHandlerError('Chat V2 database not available');
  if (ctx.llmManagerPresent !== true) throw chatAnkiHandlerError('LLM manager not available');
  const runInput = ctx.runInput ?? null;
  if (request.input.kind === 'vfsRef' && runInput === null) throw chatAnkiHandlerError('LLM manager not available');
  const generation = ctx.generation ?? null;
  const tasks = ctx.documents ?? null;
  const cards = ctx.cards ?? null;
  const templates = chatAnkiTemplateSource(ctx);
  if (generation === null || tasks === null || cards === null || templates === null) {
    throw chatAnkiHandlerError('Anki database not available');
  }

  const ankiBlockId = `blk_${globalThis.crypto.randomUUID()}`;
  const links = ctx.messageLinks ?? null;
  let toolBlockIndex: number | null = null;
  try { toolBlockIndex = links?.blockIndex(ctx.messageId, ctx.blockId) ?? null; }
  catch { toolBlockIndex = null; }
  const ankiBlockIndex = toolBlockIndex === null ? 1 : Math.min(toolBlockIndex + 1, 2 ** 31 - 1);
  const documentId = globalThis.crypto.randomUUID();
  const nowMs = now().millis;

  const noteTypeExplicit = request.noteType !== null && rustTrim(request.noteType).length > 0;
  let selection;
  try {
    selection = normalizeTemplateSelection(resolveTemplateSelection(
      templates, request.goal, request.templateMode, request.templateId, request.templateIds,
      (message) => ctx.info?.(message),
    ));
  } catch (caught) {
    return finishChatAnkiInlineFailure(call, ctx, startedAt, errorText(caught));
  }
  const effectiveMode = deriveEffectiveTemplateMode(selection);
  let [deckName, noteType] = resolveDeckAndNoteType(ctx, request.deckName, request.noteType);
  if (!noteTypeExplicit && selection.templateId !== null) {
    try {
      const template = templates.getById(selection.templateId);
      if (template !== null && rustTrim(template.note_type).length > 0) noteType = template.note_type;
    } catch { /* boundary-allow empty-catch: chatanki_executor.rs:7033 `if let Ok(Some(t))` ignores lookup errors */ }
  }
  const optionsForUi = {
    deck_name: deckName,
    note_type: noteType,
    template_id: selection.templateId,
    template_ids: selection.templateIds,
    template_mode: effectiveMode,
    enable_images: false,
    max_cards_per_source: 0,
  };
  const initialToolOutput = {
    schemaVersion: 2,
    stateRevision: nextChatankiStateRevision(),
    warnings: structuredClone(initialWarnings),
    cards: [],
    documentId,
    templateId: selection.templateId,
    templateIds: selection.templateIds,
    templateMode: effectiveMode,
    syncStatus: 'pending',
    workflowStatus: 'running',
    generationStatus: 'running',
    deliveryStatus: 'empty',
    recoveryStatus: 'none',
    businessSessionId: ctx.sessionId,
    messageStableId: ctx.messageId,
    options: optionsForUi,
    progress: {
      stage: 'queued',
      messageKey: 'blocks.ankiCards.progress.messages.queued',
      cardsGenerated: 0,
      counts: { total: 0, pending: 0, processing: 0, streaming: 0, paused: 0, completed: 0, failed: 0, truncated: 0, cancelled: 0 },
      completedRatio: 0,
    },
    ankiConnect: { available: null },
    debug: request.debug
      ? { forcedRoute: request.forcedRoute, preferredResourceIds: request.preferredResourceIds } : null,
  };

  // F2: the guard is registered before the block is visible, so a stored running block
  // without a guard always means a dead pipeline.
  const guards = ctx.pipelineGuards ?? new ChatAnkiPipelineRegistry();
  const guard = guards.register(ankiBlockId, ctx.isCancelled ?? null);
  const toolName = stripToolNamespace(call.name);
  try {
    upsertBlockAllowOrphan(blocks, links, {
      id: ankiBlockId,
      sessionId: ctx.sessionId,
      messageId: ctx.messageId,
      type: ANKI_CARDS,
      status: BLOCK_STATUS.RUNNING,
      toolName,
      toolOutput: initialToolOutput,
      error: null,
      blockIndex: ankiBlockIndex,
      startedAt: nowMs,
      endedAt: null,
      firstChunkAt: nowMs,
    });
  } catch (caught) {
    guard.release();
    throw chatAnkiHandlerError(errorText(caught));
  }

  ctx.emitBlockStart?.(ankiBlockId, {
    templateId: selection.templateId,
    templateIds: selection.templateIds,
    templateMode: effectiveMode,
    options: optionsForUi,
  });
  const toolOutput: Record<string, unknown> = {
    status: 'started',
    ankiBlockId,
    documentId,
    message: 'ChatAnki pipeline started (background)',
  };
  if (initialWarnings.length > 0) toolOutput.warnings = structuredClone(initialWarnings);
  const result = finishChatAnkiSuccess(call, ctx, startedAt, toolOutput);

  const warn = (message: string): void => { ctx.warn(message); };
  const params: BackgroundParams = {
    sessionId: ctx.sessionId,
    messageId: ctx.messageId,
    ankiBlockId,
    toolName,
    blocks,
    tasks,
    cards,
    generation,
    templates,
    settings: ctx.settings ?? null,
    preferenceMemory: ctx.preferenceMemory ?? null,
    retrievePreferencePrompt: ctx.retrievePreferencePrompt ?? null,
    checkAnkiConnect: ctx.ankiConnect === undefined || ctx.ankiConnect === null
      ? null : () => ctx.ankiConnect!.checkAnkiConnectAvailability(),
    mediaFileName: ctx.mediaFileName ?? null,
    emitChunk: (id, update) => { ctx.emitChunk?.(id, update); },
    emitBlockError: (id, error) => { ctx.emitBlockError?.(id, error); },
    emitBlockEnd: (id, output) => { ctx.emitBlockEnd?.(id, output); },
    emitEvent: (event, payload) => { ctx.emitEvent?.(event, payload); },
    warn,
    info: (message) => { ctx.info?.(message); },
    input: request.input,
    runInput,
    forcedRoute: request.forcedRoute,
    preferredResourceIds: request.preferredResourceIds,
    goal: request.goal,
    deckName,
    noteType,
    templateMode: effectiveMode,
    templateId: selection.templateId,
    templateIds: selection.templateIds,
    debugEnabled: request.debug,
    documentId,
    maxCards,
    extraRequirements,
    tuning,
    initialWarnings,
    isCancelled: () => guard.isCancelled(),
    clock,
  };
  const documentName = deriveDocumentName(deckName, request.goal);
  const task = async (): Promise<void> => {
    try {
      await runChatAnkiPipelineBackground(params);
    } catch (caught) {
      const error = errorText(caught);
      warn(`[ChatAnkiToolExecutor] background pipeline error: ${error}`);
      params.emitBlockError(ankiBlockId, error);
      try { ensureFailedDocumentSession(tasks, documentId, ctx.sessionId, documentName, error); }
      catch { /* boundary-allow empty-catch: chatanki_executor.rs:7194 `let _ = ensure_failed_document_session(…)` */ }
      persistAnkiCardsTerminalBlock(blocks, ctx.messageId, ankiBlockId, toolName, BLOCK_STATUS.ERROR, null, error);
    } finally {
      guard.release();
    }
  };
  if (ctx.spawnBackground !== undefined && ctx.spawnBackground !== null) ctx.spawnBackground(task);
  else void task();
  return result;
}

/** Shared terminal for failures before any task row exists (:8064–8089, :8115–8158, :8327–8351). */
function failBeforeTasks(params: BackgroundParams, errorKey: string, output: Record<string, unknown> | null): void {
  params.emitBlockError(params.ankiBlockId, errorKey);
  try {
    ensureFailedDocumentSession(
      params.tasks, params.documentId, params.sessionId, deriveDocumentName(params.deckName, params.goal), errorKey,
    );
  } catch { /* boundary-allow empty-catch: Rust `let _ = ensure_failed_document_session(…)` */ }
  persistAnkiCardsTerminalBlock(
    params.blocks, params.messageId, params.ankiBlockId, params.toolName, BLOCK_STATUS.ERROR, output, errorKey,
  );
}

/** `finish_pipeline_cancelled_before_generation` (:7378–7421). */
function finishCancelledBeforeGeneration(params: BackgroundParams): void {
  try {
    ensureCancelledDocumentSession(
      params.tasks, params.documentId, params.sessionId, deriveDocumentName(params.deckName, params.goal),
    );
  } catch (caught) {
    params.warn(`[ChatAnkiToolExecutor] failed to persist cancelled placeholder for ${params.documentId}: ${errorText(caught)}`);
  }
  const finalOutput = {
    cards: [],
    documentId: params.documentId,
    status: 'cancelled',
    finalStatus: 'cancelled',
    workflowStatus: 'cancelled',
    generationStatus: 'cancelled',
    progress: {
      stage: 'cancelled',
      messageKey: 'blocks.ankiCards.progress.messages.cancelled',
      cardsGenerated: 0,
      completedRatio: 0,
      lastUpdatedAt: now().rfc3339,
    },
  };
  persistAnkiCardsTerminalBlock(
    params.blocks, params.messageId, params.ankiBlockId, params.toolName, BLOCK_STATUS.SUCCESS, structuredClone(finalOutput), null,
  );
  params.emitBlockEnd(params.ankiBlockId, finalOutput);
}

function templateDescriptionOptions(
  params: BackgroundParams, templateIds: readonly string[], options: AnkiGenerationOptions, warnings: Record<string, unknown>[],
): void {
  const descriptions: NonNullable<AnkiGenerationOptions['template_descriptions']> = [];
  const fieldsById: Record<string, string[]> = {};
  const rulesById: Record<string, Record<string, FieldExtractionRule>> = {};
  const missing: string[] = [];
  for (const id of templateIds) {
    let template: CustomAnkiTemplate | null;
    try { template = params.templates.getById(id); }
    catch (caught) {
      params.warn(`[ChatAnkiToolExecutor] load template ${id} failed when building multi-template options: ${errorText(caught)}`);
      missing.push(id);
      continue;
    }
    if (template === null) {
      params.warn(`[ChatAnkiToolExecutor] template ${id} not found when building multi-template options`);
      missing.push(id);
      continue;
    }
    descriptions.push({
      id: template.id,
      name: template.name,
      description: template.description,
      fields: [...template.fields],
      generation_prompt: rustTrim(template.generation_prompt).length === 0 ? null : template.generation_prompt,
    });
    const fields = normalizeTemplateFields(template.fields);
    fieldsById[template.id] = fields;
    rulesById[template.id] = ensureFieldExtractionRules(fields, template.field_extraction_rules);
  }
  if (missing.length > 0) {
    warnings.push({
      code: 'template_load_partial',
      messageKey: 'blocks.ankiCards.warnings.templateLoadPartial',
      messageParams: { count: missing.length },
    });
  }
  if (descriptions.length > 0) {
    options.template_ids = [...templateIds];
    options.template_descriptions = descriptions;
    options.template_fields_by_id = fieldsById;
    options.field_extraction_rules_by_id = rulesById as AnkiGenerationOptions['field_extraction_rules_by_id'];
  }
}

/** `run_chatanki_pipeline_background` (:7462–8892). */
export async function runChatAnkiPipelineBackground(params: BackgroundParams): Promise<void> {
  if (params.isCancelled()) {
    params.warn(`[ChatAnkiToolExecutor] pipeline for ${params.documentId} cancelled before start`);
    finishCancelledBeforeGeneration(params);
    return;
  }
  let ankiAvailable: boolean | null;
  let ankiError: string | null = null;
  try {
    if (params.checkAnkiConnect === null) throw new Error('AnkiConnect service not available');
    ankiAvailable = await params.checkAnkiConnect();
  } catch (caught) {
    ankiAvailable = false;
    ankiError = errorText(caught);
  }
  params.emitChunk(params.ankiBlockId, {
    ankiConnect: { available: ankiAvailable, error: ankiError, checkedAt: now().rfc3339 },
    progress: { stage: 'routing', messageKey: 'blocks.ankiCards.progress.messages.routing' },
  });

  let resolved: ChatAnkiPipelineContent;
  if (params.input.kind === 'content') {
    resolved = {
      route: 'simple_text', content: params.input.content, debugRef: null,
      warnings: structuredClone(params.initialWarnings), contentErrorKey: null, llmGlossaryHint: null,
    };
  } else {
    resolved = await resolveVfsRefInput({
      sources: params.runInput!,
      sessionId: params.sessionId,
      ankiBlockId: params.ankiBlockId,
      goal: params.goal,
      extraContent: params.input.extraContent,
      preferredResourceIds: params.preferredResourceIds,
      forcedRoute: params.forcedRoute,
      visualHint: params.tuning.visualHint,
      maxImages: params.tuning.maxImages,
      initialWarnings: params.initialWarnings,
      emitChunk: params.emitChunk,
      warn: params.warn,
      info: params.info,
    });
  }
  const { route, debugRef, warnings, contentErrorKey } = resolved;
  let contentText = resolved.content;

  const glossaryMode = params.tuning.contentFormat === 'glossary' ? true
    : params.tuning.contentFormat === 'prose' ? false
      : (resolved.llmGlossaryHint ?? false) || looksLikeGlossaryContent(contentText);
  if (glossaryMode) contentText = normalizeGlossaryParagraphs(contentText);

  if (rustTrim(contentText).length === 0) {
    const errorKey = contentErrorKey ?? 'blocks.ankiCards.errors.noContent';
    failBeforeTasks(params, errorKey, {
      cards: [],
      documentId: params.documentId,
      syncStatus: 'error',
      progress: { stage: 'completed', messageKey: errorKey },
    });
    return;
  }

  params.emitChunk(params.ankiBlockId, {
    progress: { stage: 'generating', route, messageKey: 'blocks.ankiCards.progress.messages.generating' },
  });

  const singleTemplateId = effectiveSingleTemplateId(params.templateId, params.templateIds);
  let template: CustomAnkiTemplate | null = null;
  if (singleTemplateId !== null) {
    if (params.templateMode !== 'single') {
      params.info(`[ChatAnkiToolExecutor] single template ${singleTemplateId} resolved under templateMode=${params.templateMode} (forcing template-aware generation)`);
    }
    try {
      template = params.templates.getById(singleTemplateId);
    } catch (caught) {
      params.warn(`[ChatAnkiToolExecutor] load template failed: ${errorText(caught)}`);
      failBeforeTasks(params, 'blocks.ankiCards.errors.templateLoadFailed', null);
      return;
    }
    if (template === null) {
      failBeforeTasks(params, 'blocks.ankiCards.errors.templateNotFound', null);
      return;
    }
  }

  let preferenceHint: string | null = null;
  if (params.tuning.enablePreferenceMemory ?? true) {
    let templateNames: string[];
    try { templateNames = params.templates.listAll().map((candidate) => candidate.name); }
    catch { templateNames = []; }
    preferenceHint = buildPreferenceHint(params.settings, params.retrievePreferencePrompt, params.goal, templateNames);
  }

  const options = buildGenerationOptions(
    params.goal, params.deckName, params.noteType, contentText, template, params.maxCards,
    params.extraRequirements, params.tuning, preferenceHint,
  );
  applyMediaSourceRequirements(options, contentText, params.mediaFileName);
  if (params.extraRequirements !== null) {
    if (params.settings === null || params.preferenceMemory === null) {
      params.warn('[ChatAnkiToolExecutor] preference observation skipped:'
        + ' F4 settings or L16 anki_preference_memory service is not available');
    } else {
      persistPreferenceObservationBestEffort(
        params.settings, params.preferenceMemory,
        { extraRequirements: params.extraRequirements, edits: [], deletions: [], generatedCount: 0, templateUsed: null },
        'extra_requirements', Date.now(), params.warn,
      );
    }
  }

  if (template === null && params.templateIds !== null && params.templateIds.length > 0) {
    templateDescriptionOptions(params, params.templateIds, options, warnings);
  }
  if (warnings.length > 0) {
    const warningsPatch = { warnings: structuredClone(warnings) };
    params.emitChunk(params.ankiBlockId, structuredClone(warningsPatch));
    persistAnkiCardsRunningPatch(params.blocks, params.messageId, params.ankiBlockId, params.toolName, warningsPatch);
  }
  if (params.isCancelled()) {
    params.warn(`[ChatAnkiToolExecutor] pipeline for ${params.documentId} cancelled before generation start`);
    finishCancelledBeforeGeneration(params);
    return;
  }

  let documentId: string;
  try {
    documentId = await params.generation.startDocumentProcessingWithId({
      document_content: contentText,
      original_document_name: deriveDocumentName(params.deckName, params.goal),
      options,
    }, params.documentId);
  } catch (caught) {
    params.warn(`[ChatAnkiToolExecutor] start document processing failed: ${errorText(caught)}`);
    failBeforeTasks(params, 'blocks.ankiCards.errors.startFailed', null);
    return;
  }
  try { params.tasks.setDocumentSessionSource(documentId, params.sessionId); }
  catch (caught) { params.warn(`[ChatAnkiToolExecutor] Failed to set source_session_id: ${errorText(caught)}`); }

  const taskCreated = {
    documentId,
    progress: { messageKey: 'blocks.ankiCards.progress.messages.taskCreated' },
    debug: params.debugEnabled ? debugRef : null,
  };
  params.emitChunk(params.ankiBlockId, structuredClone(taskCreated));
  persistAnkiCardsRunningPatch(params.blocks, params.messageId, params.ankiBlockId, params.toolName, taskCreated);

  await pollUntilTerminal(params, documentId, route, warnings, ankiAvailable, ankiError, debugRef);
}

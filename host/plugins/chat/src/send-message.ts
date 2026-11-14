import type { WindowRef } from '../../../kernel/api.ts';
import type { LLMManager, ApiConfig } from '../../llm/api.ts';
import type { SendMessageRequest, ChatV2Database } from '../api.ts';
import type { SendOptions } from '../../../../contracts/ipc/generated/_shared.ts';
import type { BackendSendOptions } from '../../chat-pipeline/api.ts';
import { charCount, rustTrim, utf8ByteLength } from '../../../platform/util/index.ts';
import { ensureSessionWritable, validateSessionId } from './handlers.ts';
import { generateMessageId } from './message-values.ts';
import { ChatV2Error } from './error.ts';
import { ChatV2State, StreamGuard, KILL_SWITCH_BLOCKED_MESSAGE, type StreamRegistration } from './state.ts';
import { getGoal, updateStatus } from '../repository/goals.ts';
import { buildGoalUpdatedPayload, type BackendEventsLike } from './events.ts';
import { errorText, type ChatLogger } from './logger.ts';

/** Backend-only generation is deliberately absent from the IPC SendOptions schema. */
export type BackendSendRequest = Omit<SendMessageRequest, 'options'> & {
  options?: (BackendSendOptions & { streamGeneration?: bigint }) | null;
};

/** Requested L03 execution seam: send_message.rs:319-321,339-341. */
export interface SendPipelinePort {
  execute(window: WindowRef, request: BackendSendRequest, cancellation: AbortSignal,
    state: ChatV2State): Promise<string>;
}
/** Rust-owned execution only: caller chooses admission, scheduling and goal settlement. */
export interface ChatSendExecution {
  runSendMessage(window: WindowRef, request: BackendSendRequest, registration: StreamRegistration): Promise<string>;
  runHeadlessMessage(window: WindowRef, request: BackendSendRequest, token: AbortController): Promise<string>;
}
export function createSendExecution(pipeline: SendPipelinePort, state: ChatV2State): ChatSendExecution {
  return {
    runSendMessage: (window, request, registration) => runSendMessagePipelineOwned(pipeline, state, window, request, registration),
    runHeadlessMessage: (window, request, token) => runSendMessagePipeline(pipeline, state, window, request, token),
  };
}
export interface SendGoalRuntime {
  spawnContinuation(window: WindowRef, sessionId: string): void;
  settleActive(window: WindowRef, sessionId: string, status: 'paused' | 'blocked'): void;
}
export interface SendModelLookup {
  getApiConfigs(): Promise<Pick<ApiConfig, 'id' | 'model' | 'isMultimodal'>[]>;
  selectModelFor(...args: Parameters<LLMManager['selectModelFor']>): Promise<[Pick<ApiConfig, 'isMultimodal'>, boolean]>;
}
export interface MessageSenderDeps {
  state: ChatV2State;
  pipeline: SendPipelinePort;
  llm: SendModelLookup;
  events: BackendEventsLike;
  goals: SendGoalRuntime;
}

/** send_message.rs:40-83; failed model lookups warn and retain text-model behavior. */
export async function isModelMultimodal(llm: SendModelLookup, modelId: string | null, log: ChatLogger): Promise<boolean> {
  const explicit = modelId === null ? '' : rustTrim(modelId);
  if (explicit) {
    try { return (await llm.getApiConfigs()).find(c => c.id === explicit || c.model === explicit)?.isMultimodal ?? false; }
    catch (error) {
      log.warn(`[ChatV2::handlers] Failed to get API configs for is_multimodal check: ${errorText(error)}`);
      return false;
    }
  }
  try { return (await llm.selectModelFor('default', null, undefined))[0].isMultimodal; }
  catch (error) {
    log.warn(`[ChatV2::handlers] Failed to resolve default model for is_multimodal check: ${errorText(error)}`);
    return false;
  }
}

function auditPayload(request: SendMessageRequest, modelId: string | null, multimodal: boolean) {
  let text = 0, image = 0, hasImageMode = false, hasOcrMode = false;
  const refs = (request.userContextRefs ?? []).map(ref => {
    const textBlocks = ref.formattedBlocks.filter(b => b.type === 'text').length;
    const imageBlocks = ref.formattedBlocks.filter(b => b.type === 'image').length;
    text += textBlocks; image += imageBlocks;
    const modes = { image: ref.injectModes?.image ?? [], pdf: ref.injectModes?.pdf ?? [] };
    hasImageMode ||= modes.image.includes('image') || modes.pdf.includes('image');
    hasOcrMode ||= modes.image.includes('ocr') || modes.pdf.includes('ocr');
    return { resourceId: ref.resourceId, typeId: ref.typeId, displayName: ref.displayName ?? null,
      injectModes: modes, blocks: { total: ref.formattedBlocks.length, text: textBlocks, image: imageBlocks } };
  });
  const textModelImpliesOcr = !multimodal && refs.some(ref => ref.typeId === 'image' || ref.typeId === 'file');
  const expectedImageBlocks = multimodal && hasImageMode;
  const expectedOcrText = hasOcrMode || textModelImpliesOcr;
  const mismatchReasons: string[] = [];
  if (expectedImageBlocks && image === 0) mismatchReasons.push('selected_image_mode_but_no_image_blocks');
  if (expectedOcrText && text === 0) mismatchReasons.push('selected_ocr_mode_but_no_text_blocks');
  if (!multimodal && hasImageMode && image > 0) mismatchReasons.push('text_model_received_image_blocks');
  if (textModelImpliesOcr && text === 0) mismatchReasons.push('text_model_expected_ocr_but_no_text_blocks');
  return { source: 'backend', sessionId: request.sessionId, modelId, isMultimodalModel: multimodal,
    contentLength: charCount(request.content), refCount: refs.length, pathMapCount: Object.keys(request.pathMap ?? {}).length,
    blockTotals: { total: text + image, text, image }, refs,
    expectation: { expectedImageBlocks, expectedOcrText, expectationMet: mismatchReasons.length === 0, mismatchReasons } };
}

function replayOverrides(options: SendOptions): SendOptions {
  return options.replayMode == null ? { ...options } : { ...options, temperature: 0 };
}

/** The guard owns exactly the registration returned by the synchronous admission step. */
export async function runSendMessagePipeline(pipeline: SendPipelinePort, state: ChatV2State,
  window: WindowRef, request: BackendSendRequest, token: AbortController): Promise<string> {
  const guard = StreamGuard.fromRegisteredToken(state, request.sessionId, token);
  try {
    const prepared = guard === null ? request : { ...request,
      options: { ...request.options, streamGeneration: guard.generation } };
    return await pipeline.execute(window, prepared, token.signal, state);
  } finally { guard?.dispose(); }
}

/** send_message.rs:324-342, exact owned registration path. */
export async function runSendMessagePipelineOwned(pipeline: SendPipelinePort, state: ChatV2State,
  window: WindowRef, request: BackendSendRequest, registration: StreamRegistration): Promise<string> {
  const guard = new StreamGuard(state, request.sessionId, registration);
  try {
    return await pipeline.execute(window, { ...request,
      options: { ...request.options, streamGeneration: registration.generation } }, registration.token.signal, state);
  } finally { guard.dispose(); }
}

function debugStrings(values: readonly string[]): string { return `[${values.map(value => JSON.stringify(value)).join(', ')}]`; }

/** Handler orchestration only; the L03 port owns all message/block writes and stream terminal events. */
export class MessageSender {
  private readonly db: ChatV2Database;
  private readonly log: ChatLogger;
  private readonly deps: MessageSenderDeps;
  constructor(db: ChatV2Database, log: ChatLogger, deps: MessageSenderDeps) {
    this.db = db; this.log = log; this.deps = deps;
  }

  async send(input: SendMessageRequest, window: WindowRef): Promise<string> {
    const request = structuredClone(input);
    const { log } = this;
    log.info(`[ChatV2::handlers] chat_v2_send_message: session_id=${request.sessionId}, content_len=${utf8ByteLength(request.content)}`);
    const options = request.options;
    if (options != null) {
      const schemas = options.mcpToolSchemas ?? [];
      log.info(`[ChatV2::handlers] 📦 SendOptions received: mcp_tool_schemas=${schemas.length}, mcp_tools=${options.mcpTools == null ? 'None' : `Some(${options.mcpTools.length})`}, has_options=true`);
      if (schemas.length) log.info(`[ChatV2::handlers] 📦 First 5 tool names: ${debugStrings(schemas.slice(0, 5).map(s => s.name))} (total: ${schemas.length})`);
      else log.warn('[ChatV2::handlers] ⚠️ mcp_tool_schemas is empty or None!');
      log.info(`[ChatV2::handlers] 📦 Skills diag: active_skill_ids=${options.activeSkillIds == null ? 'None' : `Some(${debugStrings(options.activeSkillIds)})`}, skill_contents_keys=${options.skillContents == null ? 'None' : `Some(${debugStrings(Object.keys(options.skillContents))})`}`);
    } else log.warn('[ChatV2::handlers] ⚠️ SendOptions is None!');
    this.validate(request, false);
    await this.audit(request);
    const id = request.assistantMessageId ?? generateMessageId();
    const prepared = { ...request, assistantMessageId: id,
      options: options == null ? options : replayOverrides(options) };
    this.resumeWaitingGoal(request.sessionId);
    this.start(prepared, window, false);
    return id;
  }

  async wake(sessionId: string, content: string, assistantMessageId: string | null,
    options: SendOptions | null, window: WindowRef): Promise<string> {
    this.log.info(`[ChatV2::handlers] chat_v2_wake_session: session_id=${sessionId}, content_len=${utf8ByteLength(content)}`);
    this.validate({ sessionId, content }, true);
    const id = assistantMessageId ?? generateMessageId();
    const request: SendMessageRequest = { sessionId, content, assistantMessageId: id,
      options: replayOverrides({ ...structuredClone(options), skipUserMessageSave: true }),
      userMessageId: null, userContextRefs: null, pathMap: null, workspaceId: null };
    await this.audit(request);
    this.start(request, window, true);
    return id;
  }

  private validate(request: SendMessageRequest, wake: boolean): void {
    validateSessionId(request.sessionId);
    ensureSessionWritable(this.db.getConn(), request.sessionId);
    if (!rustTrim(request.content) && (wake || !request.userContextRefs?.length)) {
      throw new ChatV2Error('Validation', wake ? 'Wake content cannot be empty' : 'Message content or context refs required');
    }
    if (this.deps.state.killSwitch.isTripped()) throw new ChatV2Error('Other', KILL_SWITCH_BLOCKED_MESSAGE);
  }

  private async audit(request: SendMessageRequest): Promise<void> {
    const modelId = request.options?.modelId ?? null;
    const multimodal = await isModelMultimodal(this.deps.llm, modelId, this.log);
    try { this.deps.events.emit('chat_v2_request_audit', auditPayload(request, modelId, multimodal)); }
    catch (error) { this.log.warn(`[ChatV2::handlers] Failed to emit chat_v2_request_audit event: ${errorText(error)}`); }
  }

  private resumeWaitingGoal(sessionId: string): void {
    let conn;
    try { conn = this.db.getConn(); }
    catch (error) { this.log.warn(`[ChatV2::handlers] get_conn failed for waiting_user flip: session=${sessionId}, error=${errorText(error)}`); return; }
    let goal;
    try { goal = getGoal(conn, sessionId); }
    catch (error) { this.log.warn(`[ChatV2::handlers] Failed to load goal for waiting_user flip: session=${sessionId}, error=${errorText(error)}`); return; }
    if (goal?.status !== 'waiting_user') return;
    let updated;
    try { updated = updateStatus(conn, sessionId, goal.goalId, 'active'); }
    catch (error) { this.log.warn(`[ChatV2::handlers] Failed to resume waiting_user goal: session=${sessionId}, error=${errorText(error)}`); return; }
    if (updated !== null) {
      this.log.info(`[ChatV2::handlers] Goal resumed on user reply: session=${sessionId}, goal=${updated.goalId}`);
      try { this.deps.events.emit(`chat_v2_session_${sessionId}`, buildGoalUpdatedPayload(sessionId, updated)); }
      catch (error) { this.log.warn(`[ChatV2::goal] Failed to emit goal_updated event: session=${sessionId}, error=${errorText(error)}`); }
    }
  }

  private start(request: SendMessageRequest, window: WindowRef, wake: boolean): void {
    const { state, pipeline, goals } = this.deps;
    const registration = state.tryRegisterStreamOwned(request.sessionId);
    if (registration === null) throw new ChatV2Error('Other', state.killSwitch.isTripped()
      ? KILL_SWITCH_BLOCKED_MESSAGE : 'Session has an active stream. Please wait for completion or cancel first.');
    const prefix = wake ? 'Wake pipeline' : 'Pipeline';
    const work = async () => {
      let result: string;
      try { result = await runSendMessagePipelineOwned(pipeline, state, window, request, registration); }
      catch (error) {
        if (error instanceof ChatV2Error && error.kind === 'Cancelled') {
          this.log.info(`[ChatV2::handlers] ${prefix} cancelled: session_id=${request.sessionId}`);
          goals.settleActive(window, request.sessionId, 'paused');
        } else {
          this.log.error(`[ChatV2::handlers] ${prefix} error: session_id=${request.sessionId}, error=${errorText(error)}`);
          goals.settleActive(window, request.sessionId, 'blocked');
        }
        return;
      }
      this.log.info(`[ChatV2::handlers] ${prefix} completed: session_id=${request.sessionId}, assistant_message_id=${result}`);
      goals.spawnContinuation(window, request.sessionId);
    };
    state.spawnTracked(work());
  }
}

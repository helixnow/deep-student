/**
 * B2 headless runner (`headless.rs:1275–1975`): orchestrates unattended agent turns
 * over L04 (`chatSession`, `chatState`, `ChatV2Emitter.newHeadless`, `StreamGuard`)
 * and L03 (`chatPipeline.executeWithEmitter`) without requiring a frontend window.
 *
 * Responsibilities owned here (L06):
 * - Session resolution/creation (`isolated` vs `named`)
 * - Atomic stream registration (`tryRegisterStreamOwned`) + `StreamGuard` release
 * - Trusted automation profile installation & cleanup (`installTrustedAutomationSession`)
 * - Strict read-only headless tool allowlist & schema injection (fail-closed)
 * - Hard wall-clock timeout with cancel grace window (`CANCEL_GRACE_SECS`)
 * - Assistant block summarization (`summarizeAssistantBlocks`)
 */
import {
  ChatV2Emitter,
  ChatV2Error,
  KILL_SWITCH_BLOCKED_MESSAGE,
  StreamGuard,
  type ChatSession,
  type ChatV2State,
  type MessageBlock,
  type StreamRegistration,
} from '../../chat/api.ts';
import type { ChatPipelineExecution, PipelineSendRequest } from '../../chat-pipeline/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { chronoRfc3339 } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type {
  HeadlessSessionTurn,
  HeadlessTurnOutcome,
  HeadlessTurnRequest,
  HeadlessTurnResult,
} from '../api.ts';
import { errorMessage } from './automation-errors.ts';
import {
  CANCEL_GRACE_SECS,
  HEADLESS_BLOCKED_TOOLS,
  clampSessionTurnTimeout,
  concludePipelineResult,
  headlessAllowedTools,
  headlessSystemPromptNote,
  headlessToolSchemas,
  installTrustedAutomationSession,
  parseHeadlessSessionMode,
  sessionAutoMemoryExtraction,
  summarizeAssistantBlocks,
  type HeadlessBlock,
} from './headless.ts';

export interface HeadlessRunnerLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface HeadlessRunnerChatSession {
  getSession(sessionId: string): ChatSession | null;
  createSession(session: ChatSession): void;
  getMessageBlocks(messageId: string): MessageBlock[];
}

export interface HeadlessRunnerChatState {
  readonly killSwitch: {
    isTripped(): boolean;
    ensureAllowed(): void;
  };
  tryRegisterStreamOwned(sessionId: string): StreamRegistration | null;
  removeStreamIfGeneration(sessionId: string, generation: bigint): boolean;
}

export type HeadlessRunnerChatPipeline = Pick<ChatPipelineExecution, 'executeWithEmitter'>;

export interface HeadlessRunnerDeps {
  chatSession: HeadlessRunnerChatSession;
  chatState: HeadlessRunnerChatState;
  chatPipeline: HeadlessRunnerChatPipeline;
  ensureRuntimeRoots?: ((sessionId: string) => void) | null;
  log: HeadlessRunnerLog;
  /** Override cancel grace window in ms (defaults to CANCEL_GRACE_SECS * 1000). */
  cancelGraceMs?: number;
}

export interface HeadlessRunner {
  runHeadlessTurn(request: HeadlessTurnRequest): Promise<HeadlessTurnResult>;
  runHeadlessAgentTurn(request: HeadlessSessionTurn): Promise<HeadlessTurnOutcome>;
}

const DEFAULT_HARD_TIMEOUT_SECS = 600;

/** Tools that require a frontend/user bridge and can never run headless even with a trusted profile. */
const UNCONDITIONAL_HEADLESS_BLOCKED = HEADLESS_BLOCKED_TOOLS
  .filter(([, reason]) => reason !== 'write-risk')
  .map(([pattern]) => pattern);

function isUnconditionallyBlockedHeadlessTool(toolName: string): boolean {
  const short = toolName.startsWith('builtin-') ? toolName.slice('builtin-'.length) : toolName;
  for (const blocked of UNCONDITIONAL_HEADLESS_BLOCKED) {
    if (blocked.endsWith('*')) {
      const prefix = blocked.slice(0, -1);
      if (short.startsWith(prefix) || toolName.startsWith(prefix)) return true;
    } else if (short === blocked || toolName === blocked) {
      return true;
    }
  }
  return false;
}

function normalizeHeadlessSessionMode(raw: HeadlessTurnRequest['sessionMode']): 'isolated' | 'named' {
  if (typeof raw === 'string') return parseHeadlessSessionMode(raw);
  if (raw !== null && typeof raw === 'object') {
    if ('named' in raw) return 'named';
    if ('isolated' in raw) return 'isolated';
  }
  throw AppError.validation(`Invalid session_mode '${String(raw)}'. Allowed: isolated, named`);
}

function buildHeadlessAllowedTools(request: HeadlessTurnRequest): string[] {
  const allowed = new Set<string>(headlessAllowedTools());
  if (request.trustedProfile != null) {
    for (const entry of request.trustedProfile.allowedTools) {
      const trimmed = rustTrim(entry);
      if (trimmed !== '' && !isUnconditionallyBlockedHeadlessTool(trimmed)) {
        allowed.add(trimmed);
      }
    }
  }
  return [...allowed];
}

function isCancellationError(error: unknown, signal: AbortSignal): boolean {
  if (error instanceof ChatV2Error && error.kind === 'Cancelled') return true;
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'CancelledError')) return true;
  return signal.aborted;
}

function toHeadlessBlocks(blocks: readonly MessageBlock[]): HeadlessBlock[] {
  return blocks.map((block) => ({
    blockType: block.type,
    status: block.status,
    toolName: block.toolName ?? null,
    content: block.content ?? null,
    toolOutput: block.toolOutput !== null && typeof block.toolOutput === 'object' && !Array.isArray(block.toolOutput)
      ? block.toolOutput as Record<string, unknown>
      : null,
  }));
}

function nowRfc3339(): string {
  return chronoRfc3339(BigInt(Date.now()) * 1_000_000n);
}

function bridgeCancellation(
  externalSignal: AbortSignal | null | undefined,
  internalController: AbortController,
): () => void {
  if (externalSignal == null) return () => {};
  if (externalSignal.aborted) {
    internalController.abort();
    return () => {};
  }
  const onAbort = () => { internalController.abort(); };
  externalSignal.addEventListener('abort', onAbort, { once: true });
  return () => { externalSignal.removeEventListener('abort', onAbort); };
}

type TimedExecutionResult =
  | { kind: 'ok'; assistantMessageId: string }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout'; timeoutSecs: number };

async function runWithHardTimeout(
  work: Promise<string>,
  timeoutSecs: number,
  cancelGraceMs: number,
  controller: AbortController,
  sessionId: string,
  log: HeadlessRunnerLog,
): Promise<TimedExecutionResult> {
  const settled = work.then(
    (assistantMessageId): TimedExecutionResult => ({ kind: 'ok', assistantMessageId }),
    (error: unknown): TimedExecutionResult => ({ kind: 'error', error }),
  );
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<TimedExecutionResult>((resolve) => {
    timeoutTimer = setTimeout(() => {
      resolve({ kind: 'timeout', timeoutSecs });
    }, timeoutSecs * 1000);
    (timeoutTimer as { unref?: () => void }).unref?.();
  });

  const outcome = await Promise.race([settled, timeoutPromise]);
  if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
  if (outcome.kind !== 'timeout') return outcome;

  log.warn(`[ChatV2::headless] Headless turn exceeded ${timeoutSecs}s hard timeout, cancelling: session=${sessionId}`);
  controller.abort();

  if (cancelGraceMs > 0) {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, cancelGraceMs);
        (graceTimer as { unref?: () => void }).unref?.();
      }),
    ]);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }
  return outcome;
}

function resolveOrCreateSession(
  deps: HeadlessRunnerDeps,
  request: HeadlessTurnRequest,
  sessionMode: 'isolated' | 'named',
): ChatSession {
  if (sessionMode === 'named' && request.namedSessionId != null) {
    const candidateId = rustTrim(request.namedSessionId);
    if (candidateId !== '') {
      const existing = deps.chatSession.getSession(candidateId);
      if (existing !== null && existing.persistStatus === 'active') {
        return existing;
      }
    }
  }
  const sessionId = `sess_${globalThis.crypto.randomUUID()}`;
  const timestamp = nowRfc3339();
  const trimmedTitle = request.title != null ? rustTrim(request.title) : '';
  const title = trimmedTitle !== '' ? trimmedTitle : `Automation: ${request.source}`;
  const metadata: Record<string, unknown> = {
    headless: true,
    automation_source: request.source,
    ...(request.trustedProfile != null ? { trusted_profile_hash: request.trustedProfile.profileHash } : {}),
  };
  const session: ChatSession = {
    id: sessionId,
    mode: 'chat',
    title,
    titleLocked: true,
    persistStatus: 'active',
    metadata,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  deps.chatSession.createSession(session);
  try {
    deps.ensureRuntimeRoots?.(sessionId);
  } catch (error) {
    deps.log.warn(`[ChatV2::headless] Failed to initialize runtime roots for ${sessionId}: ${errorMessage(error)}`);
  }
  return session;
}

/**
 * Composes a production B2 {@link HeadlessRunner} from published L03/L04 services.
 */
export function createHeadlessRunner(deps: HeadlessRunnerDeps): HeadlessRunner {
  const cancelGraceMs = deps.cancelGraceMs ?? CANCEL_GRACE_SECS * 1000;

  return {
    async runHeadlessTurn(request: HeadlessTurnRequest): Promise<HeadlessTurnResult> {
      const startedAt = Date.now();
      const prompt = rustTrim(request.prompt);
      if (prompt === '') {
        throw AppError.validation('Headless turn prompt cannot be empty');
      }
      const sessionMode = normalizeHeadlessSessionMode(request.sessionMode);
      deps.chatState.killSwitch.ensureAllowed();

      const session = resolveOrCreateSession(deps, request, sessionMode);
      const sessionId = session.id;

      const registration = deps.chatState.tryRegisterStreamOwned(sessionId);
      if (registration === null) {
        if (deps.chatState.killSwitch.isTripped()) {
          throw new Error(KILL_SWITCH_BLOCKED_MESSAGE);
        }
        return {
          sessionId,
          assistantMessageId: '',
          status: 'error',
          summary: '',
          durationMs: Math.max(0, Date.now() - startedAt),
          error: `Session '${sessionId}' already has an active stream`,
        };
      }

      const streamGuard = new StreamGuard(deps.chatState as ChatV2State, sessionId, registration);
      const unlinkCancel = bridgeCancellation(request.cancellationToken, registration.token);
      const trustedGuard = installTrustedAutomationSession(sessionId, request.trustedProfile ?? null);
      const emitter = ChatV2Emitter.newHeadless(sessionId).withStreamGeneration(Number(registration.generation));

      const userMessageId = `msg_${globalThis.crypto.randomUUID()}`;
      const assistantMessageId = `msg_${globalThis.crypto.randomUUID()}`;
      const requestedModelId = request.modelId != null && rustTrim(request.modelId) !== ''
        ? rustTrim(request.modelId)
        : null;
      const maxToolRounds = request.maxToolRounds
        ?? (request.trustedProfile != null ? Number(request.trustedProfile.maxToolRounds) : null);
      const timeoutSecs = clampSessionTurnTimeout(
        request.hardTimeoutSecs
          ?? (request.trustedProfile != null ? Number(request.trustedProfile.timeoutSeconds) : DEFAULT_HARD_TIMEOUT_SECS),
      );

      const sendRequest: PipelineSendRequest = {
        sessionId,
        content: prompt,
        userMessageId,
        assistantMessageId,
        userContextRefs: null,
        pathMap: null,
        workspaceId: null,
        options: {
          modelId: requestedModelId,
          systemPromptAppend: headlessSystemPromptNote(),
          executionAllowedTools: buildHeadlessAllowedTools(request),
          mcpToolSchemas: headlessToolSchemas(),
          mcpTools: [],
          disableTools: false,
          maxToolRecursion: maxToolRounds,
          autoMemoryExtraction: sessionAutoMemoryExtraction(session.metadata),
          streamGeneration: registration.generation,
        },
      };

      try {
        deps.log.info(
          `[ChatV2::headless] Starting headless turn: session=${sessionId}, source=${request.source}, `
          + `mode=${sessionMode}, timeout=${timeoutSecs}s, trusted=${request.trustedProfile != null}`,
        );
        const execution = deps.chatPipeline.executeWithEmitter(
          emitter,
          sendRequest,
          registration.token.signal,
          deps.chatState as ChatV2State,
        );
        const timed = await runWithHardTimeout(
          execution,
          timeoutSecs,
          cancelGraceMs,
          registration.token,
          sessionId,
          deps.log,
        );
        const durationMs = Math.max(0, Date.now() - startedAt);

        if (timed.kind === 'timeout') {
          return {
            sessionId,
            assistantMessageId,
            status: 'timeout',
            summary: '',
            durationMs,
            error: `Headless turn timed out after ${timed.timeoutSecs}s`,
          };
        }
        if (timed.kind === 'ok') {
          const concluded = concludePipelineResult({ ok: true, value: timed.assistantMessageId });
          const blocks = deps.chatSession.getMessageBlocks(timed.assistantMessageId);
          const summary = summarizeAssistantBlocks(toHeadlessBlocks(blocks));
          return {
            sessionId,
            assistantMessageId: timed.assistantMessageId,
            status: concluded.status,
            summary,
            durationMs,
          };
        }

        const cancelled = isCancellationError(timed.error, registration.token.signal);
        const concluded = concludePipelineResult(
          cancelled
            ? { ok: false, cancelled: true }
            : { ok: false, cancelled: false, message: errorMessage(timed.error) },
        );
        if (concluded.status === 'cancelled') {
          return {
            sessionId,
            assistantMessageId,
            status: 'cancelled',
            summary: '',
            durationMs,
            error: 'Headless turn cancelled',
          };
        }
        return {
          sessionId,
          assistantMessageId,
          status: 'error',
          summary: '',
          durationMs,
          error: concluded.status === 'failed' ? concluded.message : errorMessage(timed.error),
        };
      } finally {
        emitter.dispose();
        trustedGuard?.release();
        unlinkCancel();
        streamGuard.dispose();
      }
    },

    async runHeadlessAgentTurn(request: HeadlessSessionTurn): Promise<HeadlessTurnOutcome> {
      const startedAt = Date.now();
      const prompt = rustTrim(request.prompt);
      if (prompt === '') {
        throw AppError.validation('Headless agent turn prompt cannot be empty');
      }
      deps.chatState.killSwitch.ensureAllowed();

      const session = deps.chatSession.getSession(request.sessionId);
      if (session === null) {
        throw new Error(`Session not found: ${request.sessionId}`);
      }
      const sessionId = session.id;

      const registration = deps.chatState.tryRegisterStreamOwned(sessionId);
      if (registration === null) {
        if (deps.chatState.killSwitch.isTripped()) {
          throw new Error(KILL_SWITCH_BLOCKED_MESSAGE);
        }
        throw new Error(`Session '${sessionId}' already has an active stream`);
      }

      const streamGuard = new StreamGuard(deps.chatState as ChatV2State, sessionId, registration);
      const unlinkCancel = bridgeCancellation(request.cancellationToken, registration.token);
      const emitter = ChatV2Emitter.newHeadless(sessionId).withStreamGeneration(Number(registration.generation));

      const userMessageId = `msg_${globalThis.crypto.randomUUID()}`;
      const assistantMessageId = `msg_${globalThis.crypto.randomUUID()}`;
      const requestedModelId = request.modelId != null && rustTrim(request.modelId) !== ''
        ? rustTrim(request.modelId)
        : null;
      const appendExtra = request.systemPromptAppend != null ? rustTrim(request.systemPromptAppend) : '';
      const systemPromptAppend = appendExtra !== ''
        ? `${headlessSystemPromptNote()}\n\n${appendExtra}`
        : headlessSystemPromptNote();
      const timeoutSecs = clampSessionTurnTimeout(Math.ceil(request.timeoutMs / 1000));

      const sendRequest: PipelineSendRequest = {
        sessionId,
        content: prompt,
        userMessageId,
        assistantMessageId,
        userContextRefs: null,
        pathMap: null,
        workspaceId: null,
        options: {
          modelId: requestedModelId,
          systemPromptAppend,
          executionAllowedTools: headlessAllowedTools(),
          mcpToolSchemas: headlessToolSchemas(),
          mcpTools: [],
          disableTools: false,
          autoMemoryExtraction: sessionAutoMemoryExtraction(session.metadata),
          streamGeneration: registration.generation,
        },
      };

      try {
        const execution = deps.chatPipeline.executeWithEmitter(
          emitter,
          sendRequest,
          registration.token.signal,
          deps.chatState as ChatV2State,
        );
        const timed = await runWithHardTimeout(
          execution,
          timeoutSecs,
          cancelGraceMs,
          registration.token,
          sessionId,
          deps.log,
        );
        const durationMs = Math.max(0, Date.now() - startedAt);
        if (timed.kind === 'timeout') {
          throw new Error(`Headless agent turn timed out after ${timed.timeoutSecs}s`);
        }
        if (timed.kind === 'error') {
          throw timed.error;
        }
        const blocks = deps.chatSession.getMessageBlocks(timed.assistantMessageId);
        const content = summarizeAssistantBlocks(toHeadlessBlocks(blocks));
        return {
          sessionId,
          assistantMessageId: timed.assistantMessageId,
          content,
          durationMs,
        };
      } finally {
        emitter.dispose();
        unlinkCancel();
        streamGuard.dispose();
      }
    },
  };
}

/**
 * Native Chat V2 Timeline Bridge for `dstu.agent-mesh` (T3-Code Single-Pane Experience).
 *
 * Streams external CLI turns (`codex`, `claude`, `opencode`, `pi`, `agy`, `dsh`, `custom`)
 * directly into `dstu.chat` SQLite tables (`chat_v2_sessions`, `chat_v2_messages`, `chat_v2_blocks`)
 * and emits canonical `chat_v2_session_<sessionId>` + `chat_v2_event_<sessionId>` events via
 * `ChatV2Emitter` so native `MessageItem` timelines render thinking, tool calls, nested subagents,
 * assistant Markdown, and git diff footers seamlessly alongside main LLM turns.
 */
import {
  appendBlockContent,
  BackendEventsSink,
  ChatV2Emitter,
  createBlocksBatchWithConn,
  createBlockWithConn,
  createMessageWithConn,
  createSessionWithConn,
  EVENT_TYPE,
  generateMessageId,
  getMessageWithConn,
  getSessionWithConn,
  newAssistantMessage,
  newContentBlock,
  newThinkingBlock,
  newToolBlock,
  newUserMessage,
  setBlockError,
  setBlockRunning,
  setBlockSuccess,
  tokenUsageFromApi,
  updateMessageWithConn,
  updateSessionWithConn,
  type BackendEvent,
  type BackendEventsLike,
  type ChatMessage,
  type ChatSession,
  type ChatV2Database,
  type EventLogger,
  type ExecutionEventSink,
  type MessageBlock,
  type SessionEvent,
  type TokenUsage,
} from '../../chat/api.ts';
import type {
  CustomCliTemplate,
  DetectedCliAgent,
  MeshDiffReport,
  MeshThreadStatus,
  NormalizedRuntimeEvent,
} from './contracts.ts';

type IndexedBlock = MessageBlock & { blockIndex: number };

const STREAMING_PERSIST_INTERVAL_MS = 200;

const BUILTIN_AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  codex: 'Codex CLI',
  claude: 'Claude Code',
  opencode: 'OpenCode',
  pi: 'Pi Agent',
  agy: 'Antigravity CLI',
  dsh: 'DeepSeek Harness',
  deepstudent: 'DeepStudent',
};

export interface TimelineBridgeLoggerLike {
  info?(message: string): void;
  warn(message: string): void;
  error?(message: string): void;
}

export interface ChatTimelinePort {
  readonly database: ChatV2Database;
  readonly backendEvents: BackendEventsLike;
  readonly logger?: TimelineBridgeLoggerLike;
}

export interface PrepareNativeTurnTimelineInput {
  readonly port: ChatTimelinePort;
  readonly chatSessionId: string;
  readonly agentId: string;
  readonly rosterName?: string;
  readonly prompt: string;
  readonly userPrompt?: string;
  readonly userMessageId?: string;
  readonly assistantMessageId?: string;
  readonly skipUserMessageSave?: boolean;
  readonly cachedAgents?: readonly DetectedCliAgent[];
  readonly customTemplates?: readonly CustomCliTemplate[];
}

export interface FinalizeNativeTurnTimelineInput {
  readonly status: MeshThreadStatus;
  readonly diff?: MeshDiffReport | null;
  readonly error?: string | null;
}

export function resolveAgentDisplayModelId(
  agentId: string,
  cachedAgents: readonly DetectedCliAgent[] = [],
  customTemplates: readonly CustomCliTemplate[] = [],
  rosterName?: string,
): string {
  const cleanId = agentId.trim().replace(/^@+/, '');
  const lower = cleanId.toLowerCase();

  const probed = cachedAgents.find((a) => a.id === cleanId || a.id.toLowerCase() === lower);
  if (probed?.displayName?.trim()) {
    return probed.displayName.trim();
  }
  if (probed?.name?.trim() && probed.name.trim() !== cleanId) {
    return probed.name.trim();
  }

  if (cleanId.startsWith('custom:')) {
    const templateId = cleanId.slice('custom:'.length);
    const tpl = customTemplates.find((t) => t.id === templateId);
    if (tpl?.name?.trim()) {
      return tpl.name.trim();
    }
  }

  const builtin = BUILTIN_AGENT_DISPLAY_NAMES[lower];
  if (builtin) {
    return builtin;
  }

  return rosterName?.trim() || cleanId || 'CLI Agent';
}

export function formatDiffMarkdownFooter(diff: MeshDiffReport): string {
  const fileNames = diff.files
    .slice(0, 5)
    .map((f) => '`' + f.path + '`')
    .join('、');
  const suffix = diff.files.length > 5 ? ' 等' : '';
  return `\n\n---\n*📁 修改 ${diff.files.length} 个文件（+${diff.totalAdditions} / -${diff.totalDeletions}）：${fileNames}${suffix}*`;
}

function createBridgeEventSink(
  backendEvents: BackendEventsLike,
  assistantMessageId: string,
  logger?: TimelineBridgeLoggerLike,
): ExecutionEventSink {
  const eventLogger: EventLogger = {
    error: (msg: string) => {
      if (logger?.error) {
        logger.error(msg);
      } else {
        logger?.warn(msg);
      }
    },
    debug: () => undefined,
  };
  const innerSink = new BackendEventsSink(backendEvents, eventLogger);
  return {
    emitBlockEvent(channel: string, event: BackendEvent): void {
      innerSink.emitBlockEvent(channel, event);
    },
    emitSessionEvent(channel: string, event: SessionEvent): void {
      // Populate both canonical `eventType` (ChatV2 SessionEvent wire schema) and `type` + `messageId`
      // so both TauriAdapter (`payload.eventType`) and direct `payload.type` consumers work identically.
      const enriched: SessionEvent & { type: string } = {
        ...event,
        type: event.eventType,
        messageId: event.messageId ?? assistantMessageId,
      };
      innerSink.emitSessionEvent(channel, enriched);
    },
    window(): unknown {
      return innerSink.window();
    },
  };
}

export function prepareNativeTurnTimeline(
  input: PrepareNativeTurnTimelineInput,
): NativeTurnTimelineSession {
  const conn = input.port.database.getConn();
  const chatSessionId = input.chatSessionId.trim();
  const nowIso = new Date().toISOString();

  // 1) Ensure ChatV2 session row exists synchronously before persisting messages.
  let session: ChatSession | null = getSessionWithConn(conn, chatSessionId);
  if (!session) {
    session = {
      id: chatSessionId,
      mode: 'chat',
      titleLocked: false,
      persistStatus: 'active',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    createSessionWithConn(conn, session);
  }

  let userTimestamp = Date.now();
  let persistedUserMsgId: string | null = null;

  // 2) Persist user message & content block unless caller already saved it (`skipUserMessageSave`).
  if (input.skipUserMessageSave !== true) {
    const userMsgId = input.userMessageId?.trim() || generateMessageId();
    persistedUserMsgId = userMsgId;
    const existingUserMsg = getMessageWithConn(conn, userMsgId);
    if (!existingUserMsg) {
      const userContentText = input.userPrompt?.trim() || input.prompt;
      const userBlock = newContentBlock(userMsgId, 0);
      userBlock.status = 'success';
      userBlock.content = userContentText;
      userBlock.startedAt = userTimestamp;
      userBlock.endedAt = userTimestamp;
      userBlock.firstChunkAt = userTimestamp;

      const userMsg = newUserMessage(chatSessionId, [userBlock.id]);
      userMsg.id = userMsgId;
      userMsg.timestamp = userTimestamp;

      // Insert message BEFORE block to satisfy `chat_v2_blocks.message_id -> chat_v2_messages.id` FK.
      createMessageWithConn(conn, userMsg);
      createBlockWithConn(conn, userBlock);
    } else {
      userTimestamp = existingUserMsg.timestamp;
    }
  }

  // 3) Create & persist assistant message with CLI display name as `modelId`.
  const modelId = resolveAgentDisplayModelId(
    input.agentId,
    input.cachedAgents,
    input.customTemplates,
    input.rosterName,
  );
  const asstMsgId = input.assistantMessageId?.trim() || generateMessageId();
  const asstTimestamp = Math.max(Date.now(), userTimestamp + 1);

  let asstMsg = getMessageWithConn(conn, asstMsgId);
  if (!asstMsg) {
    asstMsg = newAssistantMessage(chatSessionId);
    asstMsg.id = asstMsgId;
    asstMsg.timestamp = asstTimestamp;
    asstMsg._meta = { modelId };
    createMessageWithConn(conn, asstMsg);
  } else {
    asstMsg._meta = {
      ...(asstMsg._meta ?? {}),
      modelId,
    };
    updateMessageWithConn(conn, asstMsg);
  }

  session.updatedAt = new Date().toISOString();
  updateSessionWithConn(conn, session);

  return new NativeTurnTimelineSession({
    port: input.port,
    chatSessionId,
    userMessageId: persistedUserMsgId,
    assistantMessage: asstMsg,
    modelId,
  });
}

export class NativeTurnTimelineSession {
  readonly chatSessionId: string;
  readonly userMessageId: string | null;
  readonly assistantMessageId: string;
  readonly modelId: string;

  private readonly port: ChatTimelinePort;
  private readonly asstMsg: ChatMessage;
  private emitter: ChatV2Emitter | null = null;
  private startedAtMs = Date.now();
  private streamBegun = false;
  private finalized = false;

  private nextBlockIndex: number;
  private openThinkingBlock: IndexedBlock | null = null;
  private openContentBlock: IndexedBlock | null = null;
  private readonly openToolBlocks = new Map<string, IndexedBlock>();
  private readonly openSubagentBlocks = new Map<string, IndexedBlock>();
  private readonly allBlocks = new Map<string, IndexedBlock>();
  private lastStreamingPersistMs = 0;
  private usage: TokenUsage | null = null;

  constructor(params: {
    port: ChatTimelinePort;
    chatSessionId: string;
    userMessageId: string | null;
    assistantMessage: ChatMessage;
    modelId: string;
  }) {
    this.port = params.port;
    this.chatSessionId = params.chatSessionId;
    this.userMessageId = params.userMessageId;
    this.asstMsg = params.assistantMessage;
    this.assistantMessageId = params.assistantMessage.id;
    this.modelId = params.modelId;
    this.nextBlockIndex = params.assistantMessage.blockIds.length;
  }

  beginStream(): void {
    if (this.streamBegun || this.finalized) return;
    this.streamBegun = true;
    this.startedAtMs = Date.now();
    const sink = createBridgeEventSink(
      this.port.backendEvents,
      this.assistantMessageId,
      this.port.logger,
    );
    this.emitter = new ChatV2Emitter(sink, this.chatSessionId);
    this.emitter.emitStreamStart(this.assistantMessageId, this.modelId);
  }

  handleRuntimeEvent(event: NormalizedRuntimeEvent): void {
    if (this.finalized) return;
    if (!this.streamBegun) {
      this.beginStream();
    }
    const emitter = this.emitter!;

    switch (event.type) {
      case 'thinking_delta': {
        if (!event.text) return;
        this.closeOpenContentBlock();
        if (!this.openThinkingBlock) {
          const block = newThinkingBlock(this.assistantMessageId, this.nextBlockIndex++);
          setBlockRunning(block);
          this.openThinkingBlock = block;
          this.registerAndPersistBlock(block);
          emitter.emitStart(EVENT_TYPE.THINKING, this.assistantMessageId, block.id, null, null);
        }
        appendBlockContent(this.openThinkingBlock, event.text);
        this.maybePersistStreamingBlock(this.openThinkingBlock);
        emitter.emitChunk(EVENT_TYPE.THINKING, this.openThinkingBlock.id, event.text, null);
        break;
      }

      case 'assistant_delta': {
        if (!event.text) return;
        this.closeOpenThinkingBlock();
        if (!this.openContentBlock) {
          const block = newContentBlock(this.assistantMessageId, this.nextBlockIndex++);
          setBlockRunning(block);
          this.openContentBlock = block;
          this.registerAndPersistBlock(block);
          emitter.emitStart(EVENT_TYPE.CONTENT, this.assistantMessageId, block.id, null, null);
        }
        appendBlockContent(this.openContentBlock, event.text);
        this.maybePersistStreamingBlock(this.openContentBlock);
        emitter.emitChunk(EVENT_TYPE.CONTENT, this.openContentBlock.id, event.text, null);
        break;
      }

      case 'tool_call_start': {
        this.closeOpenThinkingBlock();
        this.closeOpenContentBlock();
        if (this.openToolBlocks.has(event.callId)) {
          return;
        }
        const args = event.args ?? {};
        const block = newToolBlock(
          this.assistantMessageId,
          event.toolName,
          args,
          this.nextBlockIndex++,
        );
        setBlockRunning(block);
        block.firstChunkAt = block.startedAt;
        this.openToolBlocks.set(event.callId, block);
        this.registerAndPersistBlock(block);
        emitter.emitStart(
          EVENT_TYPE.TOOL_CALL,
          this.assistantMessageId,
          block.id,
          {
            toolName: event.toolName,
            toolInput: args,
            arguments: args,
            toolCallId: event.callId,
          },
          null,
        );
        break;
      }

      case 'tool_call_end': {
        let block = this.openToolBlocks.get(event.callId);
        const resolvedToolName = event.toolName ?? block?.toolName ?? 'tool';
        if (!block) {
          this.closeOpenThinkingBlock();
          this.closeOpenContentBlock();
          block = newToolBlock(
            this.assistantMessageId,
            resolvedToolName,
            {},
            this.nextBlockIndex++,
          );
          setBlockRunning(block);
          block.firstChunkAt = block.startedAt;
          this.registerAndPersistBlock(block);
          emitter.emitStart(
            EVENT_TYPE.TOOL_CALL,
            this.assistantMessageId,
            block.id,
            {
              toolName: resolvedToolName,
              toolInput: {},
              arguments: {},
              toolCallId: event.callId,
            },
            null,
          );
        } else {
          this.openToolBlocks.delete(event.callId);
        }

        const formattedOutput =
          typeof event.output === 'string' ? event.output : JSON.stringify(event.output ?? '');
        const resultPayload = { output: formattedOutput };
        block.toolOutput = resultPayload;

        if (event.isError) {
          const errText = formattedOutput || `Tool ${resolvedToolName} failed`;
          setBlockError(block, errText);
          this.persistBlockSafe(block);
          emitter.emitError(EVENT_TYPE.TOOL_CALL, block.id, errText, null);
        } else {
          setBlockSuccess(block);
          this.persistBlockSafe(block);
          emitter.emitEnd(EVENT_TYPE.TOOL_CALL, block.id, resultPayload, null);
        }
        break;
      }

      case 'subagent_started': {
        this.closeOpenThinkingBlock();
        this.closeOpenContentBlock();
        if (this.openSubagentBlocks.has(event.childId)) {
          return;
        }
        const subArgs = { title: event.title ?? event.childId };
        const block = newToolBlock(
          this.assistantMessageId,
          'subagent',
          subArgs,
          this.nextBlockIndex++,
        );
        setBlockRunning(block);
        block.firstChunkAt = block.startedAt;
        this.openSubagentBlocks.set(event.childId, block);
        this.registerAndPersistBlock(block);
        emitter.emitStart(
          EVENT_TYPE.TOOL_CALL,
          this.assistantMessageId,
          block.id,
          {
            toolName: 'subagent',
            toolInput: subArgs,
            arguments: subArgs,
            toolCallId: event.childId,
          },
          null,
        );
        break;
      }

      case 'subagent_completed': {
        let block = this.openSubagentBlocks.get(event.childId);
        if (!block) {
          this.closeOpenThinkingBlock();
          this.closeOpenContentBlock();
          const subArgs = { title: event.childId };
          block = newToolBlock(
            this.assistantMessageId,
            'subagent',
            subArgs,
            this.nextBlockIndex++,
          );
          setBlockRunning(block);
          block.firstChunkAt = block.startedAt;
          this.registerAndPersistBlock(block);
          emitter.emitStart(
            EVENT_TYPE.TOOL_CALL,
            this.assistantMessageId,
            block.id,
            {
              toolName: 'subagent',
              toolInput: subArgs,
              arguments: subArgs,
              toolCallId: event.childId,
            },
            null,
          );
        } else {
          this.openSubagentBlocks.delete(event.childId);
        }

        const subResult = { summary: event.summary || 'Completed' };
        block.toolOutput = subResult;
        setBlockSuccess(block);
        this.persistBlockSafe(block);
        emitter.emitEnd(EVENT_TYPE.TOOL_CALL, block.id, subResult, null);
        break;
      }

      case 'usage': {
        if (typeof event.inputTokens === 'number' || typeof event.outputTokens === 'number') {
          this.usage = tokenUsageFromApi(
            event.inputTokens ?? 0,
            event.outputTokens ?? 0,
            null,
          );
          this.asstMsg._meta = {
            ...(this.asstMsg._meta ?? {}),
            usage: this.usage,
          };
        }
        break;
      }

      default:
        break;
    }
  }

  finalizeTurn(input: FinalizeNativeTurnTimelineInput): void {
    if (this.finalized) return;
    if (!this.streamBegun) {
      this.beginStream();
    }
    this.finalized = true;
    const emitter = this.emitter!;

    try {
      // 1) Append Markdown git diff footer if files changed during this turn.
      if (input.diff && input.diff.files.length > 0) {
        this.closeOpenThinkingBlock();
        if (!this.openContentBlock) {
          const block = newContentBlock(this.assistantMessageId, this.nextBlockIndex++);
          setBlockRunning(block);
          this.openContentBlock = block;
          this.registerAndPersistBlock(block);
          emitter.emitStart(EVENT_TYPE.CONTENT, this.assistantMessageId, block.id, null, null);
        }
        const footer = formatDiffMarkdownFooter(input.diff);
        appendBlockContent(this.openContentBlock, footer);
        emitter.emitChunk(EVENT_TYPE.CONTENT, this.openContentBlock.id, footer, null);
      }

      // 2) Close any open blocks cleanly before terminal session event.
      this.closeOpenThinkingBlock();

      for (const [, toolBlock] of this.openToolBlocks) {
        if (input.status === 'failed') {
          const errText = input.error || 'CLI execution failed';
          setBlockError(toolBlock, errText);
          emitter.emitError(EVENT_TYPE.TOOL_CALL, toolBlock.id, errText, null);
        } else if (input.status === 'stopped') {
          setBlockError(toolBlock, 'Interrupted');
          emitter.emitError(EVENT_TYPE.TOOL_CALL, toolBlock.id, 'Interrupted', null);
        } else {
          setBlockSuccess(toolBlock);
          emitter.emitEnd(EVENT_TYPE.TOOL_CALL, toolBlock.id, toolBlock.toolOutput ?? { output: '' }, null);
        }
      }
      this.openToolBlocks.clear();

      for (const [, subBlock] of this.openSubagentBlocks) {
        if (input.status === 'failed') {
          const errText = input.error || 'CLI execution failed';
          setBlockError(subBlock, errText);
          emitter.emitError(EVENT_TYPE.TOOL_CALL, subBlock.id, errText, null);
        } else if (input.status === 'stopped') {
          setBlockError(subBlock, 'Interrupted');
          emitter.emitError(EVENT_TYPE.TOOL_CALL, subBlock.id, 'Interrupted', null);
        } else {
          const fallbackResult = { summary: 'Completed' };
          subBlock.toolOutput = subBlock.toolOutput ?? fallbackResult;
          setBlockSuccess(subBlock);
          emitter.emitEnd(EVENT_TYPE.TOOL_CALL, subBlock.id, subBlock.toolOutput, null);
        }
      }
      this.openSubagentBlocks.clear();

      this.closeOpenContentBlock();

      if (input.status === 'stopped') {
        this.asstMsg._meta = {
          ...(this.asstMsg._meta ?? {}),
          stoppedByUser: true,
        };
      }

      // 3) Persist all blocks, assistant message, and session `updatedAt` in SQLite.
      this.persistFinalTurnState();
    } catch (persistErr) {
      this.port.logger?.warn(
        `[agent-mesh] failed to persist native chat timeline (${this.assistantMessageId}): ${String(persistErr)}`,
      );
    }

    // 4) Flush chunk batcher buffer & clear timers BEFORE terminal session event so chunks never arrive after stream_complete!
    emitter.dispose();

    // 5) Emit terminal `chat_v2_session_<chatSessionId>` lifecycle event(s).
    if (input.status === 'stopped') {
      emitter.emitStreamCancelled(this.assistantMessageId);
    } else if (input.status === 'failed') {
      emitter.emitStreamError(
        this.assistantMessageId,
        input.error || 'CLI execution failed',
      );
    } else {
      const durationMs = Math.max(0, Date.now() - this.startedAtMs);
      emitter.emitStreamCompleteWithUsage(this.assistantMessageId, durationMs, this.usage);
      emitter.emitSaveComplete();
    }
  }

  cancelQueued(reason = 'Interrupted'): void {
    this.finalizeTurn({ status: 'stopped', error: reason });
  }

  private closeOpenThinkingBlock(): void {
    if (!this.openThinkingBlock) return;
    const block = this.openThinkingBlock;
    this.openThinkingBlock = null;
    setBlockSuccess(block);
    this.persistBlockSafe(block);
    this.emitter?.emitEnd(EVENT_TYPE.THINKING, block.id, null, null);
  }

  private closeOpenContentBlock(): void {
    if (!this.openContentBlock) return;
    const block = this.openContentBlock;
    this.openContentBlock = null;
    setBlockSuccess(block);
    this.persistBlockSafe(block);
    this.emitter?.emitEnd(
      EVENT_TYPE.CONTENT,
      block.id,
      { content: block.content ?? '' },
      null,
    );
  }

  private registerAndPersistBlock(block: IndexedBlock): void {
    this.allBlocks.set(block.id, block);
    if (!this.asstMsg.blockIds.includes(block.id)) {
      this.asstMsg.blockIds.push(block.id);
    }
    try {
      const conn = this.port.database.getConn();
      createBlockWithConn(conn, block);
      updateMessageWithConn(conn, this.asstMsg);
      this.lastStreamingPersistMs = Date.now();
    } catch (err) {
      this.port.logger?.warn(
        `[agent-mesh] failed to insert timeline block ${block.id}: ${String(err)}`,
      );
    }
  }

  private maybePersistStreamingBlock(block: IndexedBlock): void {
    const nowMs = Date.now();
    if (nowMs - this.lastStreamingPersistMs < STREAMING_PERSIST_INTERVAL_MS) {
      return;
    }
    this.lastStreamingPersistMs = nowMs;
    this.persistBlockSafe(block);
  }

  private persistBlockSafe(block: IndexedBlock): void {
    try {
      const conn = this.port.database.getConn();
      createBlockWithConn(conn, block);
    } catch (err) {
      this.port.logger?.warn(
        `[agent-mesh] failed to update timeline block ${block.id}: ${String(err)}`,
      );
    }
  }

  private persistFinalTurnState(): void {
    const conn = this.port.database.getConn();
    const blocks = [...this.allBlocks.values()];
    if (blocks.length > 0) {
      createBlocksBatchWithConn(conn, blocks);
    }
    updateMessageWithConn(conn, this.asstMsg);
    const session = getSessionWithConn(conn, this.chatSessionId);
    if (session) {
      session.updatedAt = new Date().toISOString();
      updateSessionWithConn(conn, session);
    }
  }
}

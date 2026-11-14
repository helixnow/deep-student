import { Service, type Context } from '@deepseek-ai/cordis';
import { definePlugin, SlotOccupied, type Disposer } from '../../../kernel/api.ts';
import type { HostPlugin, PluginPlatform } from '../../../kernel/core.ts';
import type { ChatSessionService } from '../../chat/api.ts';
import { reapStaleRunningAnkiBlocks } from './block-reap.ts';
import type {
  ChatAnkiApkgImporter, ChatAnkiApkgVfs, ChatAnkiAsyncNativeRegex, ChatAnkiCardRepository, ChatAnkiChatBlockStore,
  ChatAnkiConnectSync, ChatAnkiDocumentPipeline, ChatAnkiDocumentTaskRepository, ChatAnkiPreferenceMemory, ChatAnkiPreferenceTimestamp,
  ChatAnkiLibraryCardStore, ChatAnkiLibraryPageService, ChatAnkiLibraryReviewService,
  ChatAnkiLibraryReviewStateService, ChatAnkiMessageLinks,
  ChatAnkiReviewStateService, ChatAnkiSettingsStore, ChatAnkiToolExecutor,
  ChatAnkiToolRegistration, ChatAnkiTools, CustomAnkiTemplate,
  FsrsAgentReviewStateSnapshot, FsrsStats, SchedulerService, ToolCall,
  ToolExecutionContext, ToolResultInfo, TransformSandboxBackend,
} from '../api.ts';
import { agentJsonValue, agentToolResult } from './agent-json.ts';
import { createChatAnkiExecutors, rosterChatAnkiExecutors } from './executors.ts';
import { ChatAnkiPipelineRegistry } from './pipeline-registry.ts';
import { createChatAnkiRunInputSources } from './run-input-sources.ts';
import { generationPipelineOf } from './run-pipeline.ts';
import type { ChatAnkiRunInputSources } from './run-vfs-input.ts';
import {
  createChatAnkiRefResolver, resolveTargetContextRefs,
  type ChatAnkiSessionHistorySource, type ChatAnkiSessionMessageSource,
} from './ref-resolver.ts';
import { createChatAnkiRoutePlanner } from './route-planner.ts';
import { setTransformFs, type TransformFsPort } from './transform-script-fs.ts';
import type { LLMManager, LlmAnkiRouting, LlmRawPrompt } from '../../llm/api.ts';
import type { AnkiTemplateService } from '../../anki/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';

/** L16 `anki` surface this lane consumes at runtime. */
interface AnkiHostSurface
  extends Partial<ChatAnkiLibraryPageService>, ChatAnkiLibraryCardStore, Partial<ChatAnkiConnectSync> {
  pipeline?: ChatAnkiDocumentPipeline;
  retrievePreferencePrompt?: NonNullable<ToolExecutionContext['retrievePreferencePrompt']>;
  getCustomTemplateById?(templateId: string): CustomAnkiTemplate | null;
  templates?: AnkiTemplateService;
  saveJsonFile?(content: string, suggestedName: string): Promise<string>;
  cards?: ChatAnkiCardRepository;
  documents?: ChatAnkiDocumentTaskRepository;
  chatBlocks?: ChatAnkiChatBlockStore;
  settings?: ChatAnkiSettingsStore;
  preferenceMemory?: ChatAnkiPreferenceMemory;
  apkgImporter?: ChatAnkiApkgImporter;
  apkgVfs?: ChatAnkiApkgVfs;
  consolidatePreferenceObservation?(
    store: { entries: unknown[] },
    observation: Record<string, unknown>,
    nowMs: ChatAnkiPreferenceTimestamp,
  ): { added: string[]; reinforced: string[]; evicted: string[] };
}

interface ReviewHostSurface extends Partial<ChatAnkiLibraryReviewStateService>, ChatAnkiLibraryReviewService {
  getReviewStatesForSession?(
    cardIds: readonly string[], sessionId: string,
  ): FsrsAgentReviewStateSnapshot[];
  getStats?(): FsrsStats;
}

/** L04 `MessageBlock` fields the chatanki block adapter reads/writes. */
interface ChatMessageBlock {
  id: string;
  messageId: string;
  type: string;
  status: string;
  /** Only read by L04's `createBlock` upsert; wire reads omit it. */
  blockIndex?: number;
  content?: string | null;
  toolName?: string | null;
  toolInput?: unknown | null;
  toolOutput?: unknown | null;
  citations?: unknown[] | null;
  error?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  firstChunkAt?: number | null;
}

interface ChatSessionSurface {
  getMessage(messageId: string): { id: string; sessionId: string } | null;
  getSessionMessages(sessionId: string): Array<{ id: string }>;
  getMessageBlocks(messageId: string): ChatMessageBlock[];
  getBlock(blockId: string): ChatMessageBlock | null;
  createBlock(block: ChatMessageBlock): void;
  updateBlock(block: ChatMessageBlock): void;
  readonly database?: { getConn(): unknown };
  createMessage?(message: { id: string; sessionId: string; role: 'assistant'; blockIds: string[]; timestamp: number }): void;
  getMessageBlocksWithConn?(conn: unknown, messageId: string): Array<{ id: string; blockIndex: number }>;
  appendBlockIdToMessageWithConn?(conn: unknown, messageId: string, blockId: string): void;
}

/** L04 rows behind `upsert_block_allow_orphan`'s message side (`chatanki_executor.rs:14592–14727`). */
function adaptMessageLinks(session: ChatSessionSurface): ChatAnkiMessageLinks | null {
  const database = session.database;
  const { createMessage, getMessageBlocksWithConn, appendBlockIdToMessageWithConn } = session;
  if (database === undefined || createMessage === undefined || getMessageBlocksWithConn === undefined
    || appendBlockIdToMessageWithConn === undefined) return null;
  return {
    blockIndex: (messageId, blockId) =>
      getMessageBlocksWithConn.call(session, database.getConn(), messageId).find((block) => block.id === blockId)?.blockIndex ?? null,
    ensurePlaceholderMessage: (messageId, fallbackSessionId, timestampMs) => {
      if (session.getMessage(messageId) !== null) return;
      createMessage.call(session, { id: messageId, sessionId: fallbackSessionId, role: 'assistant', blockIds: [], timestamp: timestampMs });
    },
    appendBlockId: (messageId, blockId) => {
      appendBlockIdToMessageWithConn.call(session, database.getConn(), messageId, blockId);
    },
  };
}

interface BackendEventsSurface {
  emit(event: string, payload: unknown): void;
}

type AgentHookRegistry = Pick<ChatSessionService, 'registerStaleAnkiBlockReaper' | 'registerEmergencyCancelHook'>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown> : null;
}

function chatBlockFromWire(block: ChatMessageBlock, sessionId: string) {
  return {
    id: block.id,
    sessionId,
    type: block.type,
    status: block.status,
    toolOutput: block.toolOutput ?? (block.content === null || block.content === undefined
      ? null : safeJson(block.content)),
    error: block.error ?? null,
    messageId: block.messageId,
    toolName: block.toolName ?? null,
    startedAt: block.startedAt ?? null,
    firstChunkAt: block.firstChunkAt ?? null,
    endedAt: block.endedAt ?? null,
  };
}

/** L16 `anki` methods `chatanki_sync` needs; the facade is published only when all are present. */
function publishedAnkiConnectSync(anki: AnkiHostSurface | undefined): ChatAnkiConnectSync | null {
  if (
    anki === undefined
    || typeof anki.checkAnkiConnectAvailability !== 'function'
    || typeof anki.createDeckIfNotExists !== 'function'
    || typeof anki.templateModelName !== 'function'
    || typeof anki.readSyncOptions !== 'function'
    || typeof anki.addNotesToAnkiDetailed !== 'function'
    || typeof anki.writeAnkiExportReceipts !== 'function'
  ) return null;
  return {
    checkAnkiConnectAvailability: anki.checkAnkiConnectAvailability.bind(anki),
    createDeckIfNotExists: anki.createDeckIfNotExists.bind(anki),
    templateModelName: anki.templateModelName.bind(anki),
    readSyncOptions: anki.readSyncOptions.bind(anki),
    addNotesToAnkiDetailed: anki.addNotesToAnkiDetailed.bind(anki),
    writeAnkiExportReceipts: anki.writeAnkiExportReceipts.bind(anki),
  };
}

function publishedDocumentPipeline(anki: AnkiHostSurface | undefined): ChatAnkiDocumentPipeline | null {
  const pipeline = anki?.pipeline;
  return pipeline !== null && typeof pipeline === 'object' ? pipeline : null;
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { return value; } // boundary-allow empty-catch: L04 投影的 content 可能是普通文本块；无法解析时按文本透传，不改变块内容
}

/** L04 `ChatSessionService` → chatanki's block-store boundary. */
function adaptChatBlocks(session: ChatSessionSurface) {
  const owner = (messageId: string): string =>
    session.getMessage(messageId)?.sessionId ?? '';
  const updateBlock = (block: {
    id: string; type: string; status?: string; toolOutput: unknown;
    error?: string | null; toolName?: string | null; startedAt?: number | null;
    firstChunkAt?: number | null; endedAt?: number | null;
  }): void => {
    const existing = session.getBlock(block.id);
    if (existing === null) throw new Error('block_not_found');
    session.updateBlock({
      ...existing,
      type: block.type,
      status: block.status ?? existing.status,
      toolOutput: block.toolOutput,
      error: block.error ?? null,
      toolName: block.toolName ?? existing.toolName ?? null,
      startedAt: block.startedAt ?? existing.startedAt ?? null,
      firstChunkAt: block.firstChunkAt ?? existing.firstChunkAt ?? null,
      endedAt: block.endedAt ?? existing.endedAt ?? null,
    });
  };
  return {
    listSessionBlocks(sessionId: string) {
      return session.getSessionMessages(sessionId).flatMap((message) =>
        session.getMessageBlocks(message.id).map((block) => chatBlockFromWire(block, sessionId)));
    },
    getBlock(blockId: string) {
      const block = session.getBlock(blockId);
      return block === null ? null : chatBlockFromWire(block, owner(block.messageId));
    },
    updateBlock,
    upsertBlock(block: {
      id: string; type: string; status?: string; toolOutput: unknown;
      error?: string | null; messageId?: string; toolName?: string | null; blockIndex?: number;
      startedAt?: number | null; firstChunkAt?: number | null; endedAt?: number | null;
    }) {
      const existing = session.getBlock(block.id);
      if (existing !== null) {
        updateBlock(block);
        return;
      }
      if (block.messageId === undefined || block.messageId.length === 0) {
        throw new Error('message_id_required');
      }
      session.createBlock({
        id: block.id,
        messageId: block.messageId,
        type: block.type,
        status: block.status ?? 'running',
        blockIndex: block.blockIndex ?? 0,
        content: null,
        toolOutput: block.toolOutput,
        toolName: block.toolName ?? null,
        error: block.error ?? null,
        startedAt: block.startedAt ?? null,
        firstChunkAt: block.firstChunkAt ?? null,
        endedAt: block.endedAt ?? null,
      });
    },
  };
}

/** F4 `settings.get/save` → Rust `get_setting`/`save_setting` names. */
function adaptSettings(settings: {
  getSetting?(key: string): string | null;
  get?(key: string): string | null;
  saveSetting?(key: string, value: string): void;
  save?(key: string, value: string): void;
}): ChatAnkiSettingsStore {
  return {
    getSetting: (key) => {
      if (settings.getSetting !== undefined) return settings.getSetting(key);
      if (settings.get !== undefined) return settings.get(key);
      throw new Error('settings store does not expose get/getSetting');
    },
    saveSetting: (key, value) => {
      if (settings.saveSetting !== undefined) settings.saveSetting(key, value);
      else if (settings.save !== undefined) settings.save(key, value);
      else throw new Error('settings store does not expose save/saveSetting');
    },
  };
}

/**
 * Adapts published Cordis services to the chatanki boundary. Optional owner
 * capabilities are resolved at invocation time; missing capabilities fail in
 * the relevant tool rather than being replaced with a local implementation.
 */
class ChatAnkiToolsService extends Service implements ChatAnkiTools {
  readonly executors: readonly ChatAnkiToolExecutor[] = createChatAnkiExecutors({
    libraryCardRead: () => typeof this.lookup<AnkiHostSurface>(['anki'])?.getAnkiAgentLibraryCard === 'function',
    documentPipeline: () => publishedDocumentPipeline(this.lookup<AnkiHostSurface>(['anki'])) !== null,
    ankiConnectSync: () => publishedAnkiConnectSync(this.lookup<AnkiHostSurface>(['anki'])) !== null,
    generationPipeline: () => generationPipelineOf(this.lookup<AnkiHostSurface>(['anki'])?.pipeline) !== null,
    runInput: () => this.runInputSources() !== null,
  });
  /** Background card pipelines alive in this Host; run/start register here before persisting their block. */
  readonly pipelines = new ChatAnkiPipelineRegistry();
  private readonly background = new Set<Promise<void>>();

  /** Rust `tokio::spawn` of the generation pipeline; the plugin keeps the promise until it settles. */
  spawnBackground(task: () => Promise<void>): void {
    const running: Promise<void> = task().finally(() => { this.background.delete(running); });
    this.background.add(running);
  }

  /** Resolves once every background pipeline spawned so far has finished. */
  async backgroundSettled(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  constructor(ctx: Context) { super(ctx, 'chatankiTools'); }

  canHandle(name: string): boolean {
    return this.executors.some((executor) => executor.canHandle(name));
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResultInfo> {
    const executor = this.executors.find((candidate) => candidate.canHandle(call.name));
    if (!executor) throw new Error(`Unsupported ChatAnki tool: ${call.name}`);
    return executor.execute(call, this.hydrate(context));
  }

  /**
   * L07 `agentTools` registration for one provider instance. The caller owns the
   * returned disposer and binds it to that provider's inject scope.
   */
  registerWith(agentTools: unknown): { dispose(): void } | null {
    const candidate = asRecord(agentTools) as Partial<ChatAnkiToolRegistration> | null;
    if (candidate === null || typeof candidate.registerToolExecutors !== 'function') {
      this.ctx.logger.warn(
        '[chatanki] agentTools is present but has no registerToolExecutors();'
        + ' executors remain reachable through ctx.chatankiTools',
      );
      return null;
    }
    // L04's ToolExecutorRegistry executes the objects registered here. They must
    // run through the same hydrate path as ctx.chatankiTools.execute; handing
    // out the raw executors would leave every host service unset.
    const registration = candidate.registerToolExecutors(rosterChatAnkiExecutors(this.executors).map((executor) => ({
      name: () => executor.name(),
      canHandle: (toolName: string) => executor.canHandle(toolName),
      sensitivityLevel: (toolName: string) => executor.sensitivityLevel(toolName),
      sensitivityLevelForCall: executor.sensitivityLevelForCall === undefined ? undefined
        : (toolName: string, args: unknown) => executor.sensitivityLevelForCall!(toolName, args),
      hasDynamicSensitivity: executor.hasDynamicSensitivity === undefined ? undefined
        : (toolName: string) => executor.hasDynamicSensitivity!(toolName),
      concurrencyClass: (toolName: string) => executor.concurrencyClass(toolName),
      execute: async (call: unknown, context: unknown) =>
        agentToolResult(await executor.execute(call as ToolCall, this.hydrate(this.adaptContext(context)))),
    })));
    return registration !== undefined && typeof registration.dispose === 'function' ? registration : null;
  }

  /**
   * L04 `ExecutionContext` uses the Rust snake_case vocabulary; direct
   * `ctx.chatankiTools.execute` callers pass this lane's camelCase boundary.
   */
  private adaptContext(context: unknown): ToolExecutionContext {
    if (context !== null && typeof context === 'object') {
      const record = context as Record<string, unknown>;
      if (typeof record.sessionId === 'string' && typeof record.emitToolCallStart === 'function') {
        return record as unknown as ToolExecutionContext;
      }
      const emitter = asRecord(record.emitter);
      const variantId = typeof record.variant_id === 'string' ? record.variant_id : null;
      const sessionId = typeof record.session_id === 'string' ? record.session_id : '';
      const messageId = typeof record.message_id === 'string' ? record.message_id : '';
      const blockId = typeof record.block_id === 'string' ? record.block_id : '';
      const emit = (value: unknown): value is (...args: never[]) => unknown => typeof value === 'function';
      // L04 `ExecutionContext` exposes the tool-call events as top-level
      // methods. `emitter` is only the chat-v2 stream sink; using it for tool
      // start/end would drop the UI lifecycle events on registry dispatch.
      // `ChatExecutionContext` implements them as prototype methods that read
      // `this.emitter`, so they must stay bound to the context.
      const method = (value: unknown) => (emit(value) ? value.bind(record) : null);
      const topStart = method(record.emitToolCallStart);
      const topEnd = method(record.emitToolCallEnd);
      const topError = method(record.emitToolCallError);
      return {
        sessionId,
        messageId,
        blockId,
        runId: typeof record.runId === 'function' ? (record.runId as () => string)() : null,
        isCancelled: typeof record.isCancelled === 'function'
          ? () => (record.isCancelled as () => boolean)() : null,
        emitToolCallStart: (name, args, callId) => {
          if (topStart !== null) {
            (topStart as (n: string, a: unknown, id: string | null) => void)(name, args, callId);
          } else if (emitter !== null && emit(emitter.emitToolCallStart)) {
            (emitter.emitToolCallStart as (n: string, a: unknown, id: string | null) => void)(name, args, callId);
          }
        },
        emitToolCallEnd: (rawPayload) => {
          const payload = agentJsonValue(rawPayload);
          if (topEnd !== null) {
            (topEnd as (payload: unknown) => void)(payload);
          } else if (emitter !== null && emit(emitter.emitToolCallEnd)) {
            (emitter.emitToolCallEnd as (payload: unknown) => void)(payload);
          }
        },
        emitToolCallError: (error) => {
          if (topError !== null) {
            (topError as (error: string) => void)(error);
          } else if (emitter !== null && emit(emitter.emitError)) {
            (emitter.emitError as (type: string, id: string, error: string, variant: string | null) => void)(
              'tool_call', blockId, error, variantId,
            );
          }
        },
        emitBareToolCallError: emitter !== null && emit(emitter.emitError)
          ? (error) => {
            (emitter.emitError as (type: string, id: string, error: string, variant: string | null) => void)(
              'tool_call', blockId, error, null,
            );
          }
          : null,
        // `emit_anki_cards_error` / `emit_anki_cards_chunk` (chatanki_executor.rs:14212–14309) pass variant `None`.
        emitBlockError: (id, error) => {
          if (emitter !== null && emit(emitter.emitError)) {
            (emitter.emitError as (type: string, block: string, error: string, variant: string | null) => void)(
              'anki_cards', id, error, null,
            );
          }
        },
        emitChunk: (id, update) => {
          if (emitter !== null && emit(emitter.emitChunk)) {
            (emitter.emitChunk as (type: string, block: string, chunk: string, variant: string | null) => void)(
              'anki_cards', id, JSON.stringify(update), null,
            );
          }
        },
        emitBlockStart: (id, payload) => {
          if (emitter !== null && emit(emitter.emitStart)) {
            (emitter.emitStart as (type: string, message: string, block: string | null, payload: unknown, variant: string | null) => void)(
              'anki_cards', messageId, id, payload, null,
            );
          }
        },
        emitBlockEnd: (id, result) => {
          if (emitter !== null && emit(emitter.emitEnd)) {
            (emitter.emitEnd as (type: string, block: string, result: unknown, variant: string | null) => void)(
              'anki_cards', id, result, null,
            );
          }
        },
        saveToolBlock: (result) => {
          if (typeof record.saveToolBlock === 'function') {
            (record.saveToolBlock as (value: ToolResultInfo) => void)(agentToolResult(result));
          }
        },
        warn: (message) => { this.ctx.logger.warn(message); },
        info: (message) => { this.ctx.logger.info(message); },
      };
    }
    throw new Error('chatanki executor requires an execution context');
  }

  private hydrate(context: ToolExecutionContext): ToolExecutionContext {
    const hydrated: ToolExecutionContext = { ...context };
    const anki = this.lookup<AnkiHostSurface>(['anki']);
    const review = this.lookup<ReviewHostSurface>(['review']);
    const llm = this.lookup<LLMManager>(['llm']);
    const rawPrompt = this.lookup<LlmRawPrompt>(['llmRawPrompt']);
    const ankiRouting = this.lookup<LlmAnkiRouting>(['llmAnkiRouting']);
    const chatSession = this.lookup<ChatSessionSurface>(['chatSession']);
    const vfsDatabase = this.lookup<Pick<VfsDatabase, 'getConn'>>(['vfsDatabase']);
    const vfsRepo = this.lookup<VfsReposService>(['vfsRepo']);
    const backendEvents = this.lookup<BackendEventsSurface>(['backendEvents']);
    const nativeRegex = this.lookup<ChatAnkiAsyncNativeRegex>(['nativeRegex']);
    const transformSandbox = this.lookup<TransformSandboxBackend>(['agentTransformSandbox']);
    const settings = this.ctx.get('settings') as Parameters<typeof adaptSettings>[0] | undefined;

    if (hydrated.cards === undefined || hydrated.cards === null) {
      hydrated.cards = anki?.cards ?? null;
    }
    if (hydrated.libraryCards === undefined || hydrated.libraryCards === null) {
      hydrated.libraryCards = anki?.listAnkiAgentLibraryPage === undefined ? null : {
        listAnkiAgentLibraryPage: anki.listAnkiAgentLibraryPage.bind(anki),
      };
    }
    if (hydrated.libraryReviewStates === undefined || hydrated.libraryReviewStates === null) {
      hydrated.libraryReviewStates = review?.getReviewStatesForLibrary === undefined ? null : {
        getReviewStatesForLibrary: review.getReviewStatesForLibrary.bind(review),
      };
    }
    if (hydrated.libraryReviews === undefined || hydrated.libraryReviews === null) {
      hydrated.libraryReviews = review ?? null;
    }
    if (hydrated.libraryCardStore === undefined || hydrated.libraryCardStore === null) {
      hydrated.libraryCardStore = anki ?? null;
    }
    if (hydrated.documents === undefined || hydrated.documents === null) {
      hydrated.documents = anki?.documents ?? null;
    }
    if (hydrated.chatBlocks === undefined || hydrated.chatBlocks === null) {
      hydrated.chatBlocks = anki?.chatBlocks
        ?? (chatSession !== undefined ? adaptChatBlocks(chatSession) : null);
    }
    if (hydrated.settings === undefined || hydrated.settings === null) {
      hydrated.settings = anki?.settings
        ?? (settings !== undefined ? adaptSettings(settings) : null);
    }
    if (hydrated.preferenceMemory === undefined || hydrated.preferenceMemory === null) {
      if (anki?.preferenceMemory !== undefined) {
        hydrated.preferenceMemory = anki.preferenceMemory;
      } else if (anki !== undefined && typeof anki.consolidatePreferenceObservation === 'function') {
        const service = anki;
        hydrated.preferenceMemory = {
          emptyStore: () => ({ entries: [] }),
          consolidateObservation: (store, observation, nowMs) =>
            service.consolidatePreferenceObservation!(
              store,
              {
                extra_requirements: observation.extraRequirements,
                edits: observation.edits.map((edit) => ({
                  field: edit.field, before: edit.before, after: edit.after,
                })),
                deletions: observation.deletions.map((deletion) => ({
                  front: deletion.front, back: deletion.back,
                })),
                generated_count: observation.generatedCount,
                template_used: observation.templateUsed,
              },
              nowMs,
            ),
        };
      }
    }
    if (hydrated.templates === undefined || hydrated.templates === null) {
      hydrated.templates = anki?.templates ?? null;
    }
    if (hydrated.templateLookup === undefined || hydrated.templateLookup === null) {
      if (anki !== undefined && typeof anki.getCustomTemplateById === 'function') {
        hydrated.templateLookup = {
          getCustomTemplateById: (id) => (anki.getCustomTemplateById as (templateId: string) => CustomAnkiTemplate | null)(id),
        };
      }
    }
    if (hydrated.exportSink === undefined || hydrated.exportSink === null) {
      if (anki !== undefined && typeof anki.saveJsonFile === 'function') {
        hydrated.exportSink = {
          saveJsonFile: (content, suggestedName) =>
            (anki.saveJsonFile as (value: string, name: string) => Promise<string>)(content, suggestedName),
        };
      }
    }
    if (hydrated.apkgImporter === undefined || hydrated.apkgImporter === null) {
      hydrated.apkgImporter = anki?.apkgImporter ?? null;
    }
    // L16 publishes apkgVfs unconditionally; without the VFS database it is Rust's `ctx.vfs_db = None`.
    if (hydrated.apkgVfs === undefined || hydrated.apkgVfs === null) {
      hydrated.apkgVfs = vfsDatabase === undefined ? null : anki?.apkgVfs ?? null;
    }
    if (hydrated.ankiConnect === undefined || hydrated.ankiConnect === null) {
      if (anki !== undefined && typeof anki.checkAnkiConnectAvailability === 'function') {
        hydrated.ankiConnect = {
          checkAnkiConnectAvailability: () => anki.checkAnkiConnectAvailability!(),
        };
      }
    }
    if (hydrated.ankiConnectSync === undefined || hydrated.ankiConnectSync === null) {
      hydrated.ankiConnectSync = publishedAnkiConnectSync(anki);
    }
    if (hydrated.pipeline === undefined || hydrated.pipeline === null) {
      hydrated.pipeline = publishedDocumentPipeline(anki);
    }
    if (hydrated.generation === undefined || hydrated.generation === null) {
      hydrated.generation = generationPipelineOf(anki?.pipeline);
    }
    if (hydrated.runInput === undefined || hydrated.runInput === null) {
      hydrated.runInput = this.runInputSources();
    }
    if (hydrated.pipelineGuards === undefined || hydrated.pipelineGuards === null) {
      hydrated.pipelineGuards = this.pipelines;
    }
    if (hydrated.spawnBackground === undefined || hydrated.spawnBackground === null) {
      hydrated.spawnBackground = (task) => { this.spawnBackground(task); };
    }
    if ((hydrated.messageLinks === undefined || hydrated.messageLinks === null) && chatSession !== undefined) {
      hydrated.messageLinks = adaptMessageLinks(chatSession);
    }
    if (hydrated.retrievePreferencePrompt === undefined || hydrated.retrievePreferencePrompt === null) {
      const retrieve = anki?.retrievePreferencePrompt;
      hydrated.retrievePreferencePrompt = typeof retrieve === 'function'
        ? (store, goal, names, maxTokens) => retrieve.call(anki, store, goal, names, maxTokens) : null;
    }
    if (hydrated.reviewStats === undefined || hydrated.reviewStats === null) {
      if (review !== undefined && typeof review.getStats === 'function') {
        hydrated.reviewStats = {
          getStats: () => (review.getStats as () => FsrsStats)(),
        };
      }
    }
    if (hydrated.scheduler === undefined || hydrated.scheduler === null) {
      const service = review as unknown as Partial<SchedulerService> | undefined;
      if (
        service !== undefined
        && typeof service.getSchedulerConfig === 'function'
        && typeof service.updateSchedulerConfig === 'function'
      ) {
        hydrated.scheduler = service as SchedulerService;
      }
    }
    if (hydrated.reviewStates === undefined || hydrated.reviewStates === null) {
      const service = review as unknown as ChatAnkiReviewStateService | undefined;
      if (service !== undefined && typeof service.getReviewStatesForSession === 'function') {
        hydrated.reviewStates = service;
      }
    }
    if (hydrated.llmRawPrompt === undefined || hydrated.llmRawPrompt === null) {
      if (rawPrompt !== undefined) {
        hydrated.llmRawPrompt = {
          // chatanki_executor.rs:4448: no images, CallerType::Anki. L02 owns
          // config selection, retries, provider adapters, audit and usage.
          callAnkiModel2RawPrompt: async (prompt) => {
            const output = await rawPrompt.callModel2RawPrompt(prompt, null, 'anki');
            return { assistantMessage: output.assistant_message };
          },
        };
      }
    }
    // chatanki_analyze refs: L04 session snapshots, then the L11 VFS (absent VFS = unresolved warning).
    if ((hydrated.refs === undefined || hydrated.refs === null) && chatSession !== undefined) {
      hydrated.refs = createChatAnkiRefResolver(
        chatSession as unknown as ChatAnkiSessionMessageSource,
        () => typeof vfsDatabase?.getConn !== 'function' || vfsRepo === undefined ? null
          : { repos: vfsRepo, conn: () => vfsDatabase.getConn() },
      );
    }
    // chatanki_import_apkg ownership (:10178): `resolve_target_context_refs(session, Some([id]))`.
    if ((hydrated.sessionResources === undefined || hydrated.sessionResources === null) && chatSession !== undefined) {
      const history = chatSession as unknown as ChatAnkiSessionHistorySource;
      hydrated.sessionResources = {
        resolveSessionUserRefs: (sessionId, resourceIds) => resolveTargetContextRefs(history, sessionId, resourceIds),
      };
    }
    if ((hydrated.llmPlanner === undefined || hydrated.llmPlanner === null) && rawPrompt !== undefined) {
      hydrated.llmPlanner = createChatAnkiRoutePlanner(
        ankiRouting ?? null, rawPrompt, (message) => { this.ctx.logger.warn(message); },
      );
    }
    if (hydrated.nativeRegexAsync === undefined || hydrated.nativeRegexAsync === null) {
      hydrated.nativeRegexAsync = nativeRegex ?? null;
    }
    if (hydrated.transformSandbox === undefined || hydrated.transformSandbox === null) {
      hydrated.transformSandbox = transformSandbox ?? null;
    }
    // C6: `llm` exists but may not publish the routed-prompt seam yet. Keep the
    // distinction visible to analyze instead of silently skipping LLM routing.
    if (hydrated.llmManagerPresent === undefined) {
      hydrated.llmManagerPresent = llm !== undefined;
    }
    if (hydrated.isCancelled === undefined || hydrated.isCancelled === null) {
      hydrated.isCancelled = null;
    }
    if (hydrated.emitBlockError === undefined || hydrated.emitBlockError === null) {
      hydrated.emitBlockError = null;
    }
    if (hydrated.emitChunk === undefined || hydrated.emitChunk === null) {
      hydrated.emitChunk = null;
    }
    hydrated.emitBlockStart ??= null;
    hydrated.emitBlockEnd ??= null;
    hydrated.mediaFileName ??= null;
    if (hydrated.emitEvent === undefined || hydrated.emitEvent === null) {
      const events = backendEvents;
      hydrated.emitEvent = events === undefined ? null
        : (event, payload) => events.emit(event, payload);
    }
    return hydrated;
  }

  private runInputSources(): ChatAnkiRunInputSources | null {
    const vfsDatabase = this.lookup<Parameters<typeof createChatAnkiRunInputSources>[0]['vfsDatabase']>(['vfsDatabase']);
    return createChatAnkiRunInputSources({
      chatSession: this.lookup(['chatSession']),
      rawPrompt: this.lookup<LlmRawPrompt>(['llmRawPrompt']),
      routing: this.lookup<LlmAnkiRouting>(['llmAnkiRouting']),
      vfsDatabase: typeof vfsDatabase?.getConnSafe === 'function' ? vfsDatabase : undefined,
      vfsRepo: this.lookup<VfsReposService>(['vfsRepo']),
      vfsResolver: this.lookup(['agentVfsResolver']),
      docs: this.lookup(['docs']),
      warn: (message) => { this.ctx.logger.warn(message); },
    });
  }

  private lookup<T>(names: readonly string[]): T | undefined {
    for (const name of names) {
      const service = this.ctx.get(name) as T | undefined;
      if (service !== undefined) return service;
    }
    return undefined;
  }
}

/** 平台差异部分：桌面入口注入 `node:fs` 实现，移动端入口不注入（变换脚本没有文件系统）。 */
export interface ChatAnkiPluginOptions {
  platforms?: readonly PluginPlatform[];
  /** `() => port` 在 apply 时求值并安装；缺省用无文件系统的端口。 */
  transformFs?: () => TransformFsPort;
}

/** 插件本体（可移植）：入口按平台在 `index.ts` / `mobile.ts` 之间选择。 */
export function createChatAnkiPlugin(options: ChatAnkiPluginOptions = {}): HostPlugin {
  return definePlugin({
  meta: {
    id: 'dstu.chatanki', lane: 'L24-chatanki', commands: [], provides: ['chatankiTools'],
    ...(options.platforms === undefined ? {} : { platforms: options.platforms }),
  },
  // L16 publishes the service as `anki`; `anki@1` never existed in the Host.
  // L07 `agentTools` is optional at boot and attached through `ctx.inject`.
  inject: ['settings', 'review', 'llm', 'anki'],
  apply(ctx) {
    setTransformFs(options.transformFs?.() ?? null);
    ctx.effect(() => () => setTransformFs(null));
    const service = new ChatAnkiToolsService(ctx);
    // Unload cancels live pipelines through their non-destructive path (generated cards stay) (V09).
    ctx.effect(() => () => {
      service.pipelines.cancelAll('chatanki plugin unloaded', (message) => ctx.logger.warn(message));
    });
    // One registration per agentTools provider instance, withdrawn when either side leaves (V01-07).
    ctx.inject(['agentTools'], (child) => {
      const registration = service.registerWith(child.get('agentTools'));
      return () => registration?.dispose();
    });
    // chatanki_executor.rs:370–380 install_agent_hooks: the chat delete-gate reaper slot and the
    // kill-switch emergency cancel hook, both backed by the live pipeline registry.
    ctx.inject(['chatSession'], (child) => {
      const session = child.get('chatSession') as ChatSessionSurface & Partial<AgentHookRegistry>;
      const disposers: Disposer[] = [];
      if (typeof session.registerStaleAnkiBlockReaper === 'function') {
        const blocks = adaptChatBlocks(session);
        try {
          disposers.push(session.registerStaleAnkiBlockReaper({
            reapStaleRunningAnkiBlocks: (sessionId) =>
              reapStaleRunningAnkiBlocks(blocks, sessionId, (blockId) => service.pipelines.isActive(blockId)),
          }));
        } catch (error) {
          if (!(error instanceof SlotOccupied)) throw error;
        }
      }
      if (typeof session.registerEmergencyCancelHook === 'function') {
        disposers.push(session.registerEmergencyCancelHook({
          cancelForEmergencyStop: (reason) => service.pipelines.cancelAll(reason, (message) => ctx.logger.warn(message)),
        }));
      }
      return () => { for (const disposer of disposers) disposer.dispose(); };
    });
  },
  });
}

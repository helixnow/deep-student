/**
 * Per-Thread Single-Flight Actor Orchestrator & Remote Service Implementation (`dstu.agent-mesh`).
 *
 * Coordinates:
 * - All 14+ remote UI/Host RPC methods (`probeAgents`, `getWorkspaceBinding`, `setWorkspaceBinding`,
 *   `startTurn`, `steerTurn`, `interruptTurn`, `respondApproval`, `setHumanControlled`,
 *   `getSessionSnapshot`, `getCheckpointDiff`, `revertCheckpoint`, `swarmControl`,
 *   `saveCustomCliTemplate`, `deleteCustomCliTemplate`, plus `askPeer` & `handoff`)
 * - Per-thread queued single-flight execution with `Steer` (mid-turn or head-of-queue) vs `Queue`
 * - Nested subagent & background process quiescence gate (`waiting_children`)
 * - Tool approval interception (`FileLeasePort` auto-lease on file-mutating tools + `waiting_approval`)
 * - `CheckpointPort` before/after turn hidden snapshots & diff attribution
 * - `MeshBridgeHostCallbacks` (8 bidirectional MCP / CLI-shim tools)
 * - `AgentKillSwitch` emergency stop hook + startup orphan crash reconciliation
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import type {
  AgentMeshService,
  AskPeerInput,
  GetCheckpointDiffInput,
  HandoffInput,
  InterruptMeshTurnInput,
  RespondMeshApprovalInput,
  RevertCheckpointInput,
  SetHumanControlledInput,
  StartMeshTurnInput,
  StartMeshTurnResult,
  SteerMeshTurnInput,
  SteerMeshTurnResult,
  SwarmControlInput,
} from '../api.ts';
import {
  prepareNativeTurnTimeline,
  type ChatTimelinePort,
  type NativeTurnTimelineSession,
} from './chat-timeline-bridge.ts';
import {
  DEFAULT_BUILTIN_COORDINATOR_AGENT,
  type AdapterRegistryPort,
  type AgentMeshEvent,
  type CheckpointPort,
  type CoordinatorWakeNotification,
  type CustomCliTemplate,
  type CustomCliTemplateInput,
  type DetectedCliAgent,
  type ExternalCodingAdapter,
  type FileLeasePort,
  type MeshBridgeHostCallbacks,
  type MeshBridgeServerPort,
  type MeshCheckpointRecord,
  type MeshDiffReport,
  type MeshSessionSnapshot,
  type MeshThreadRecord,
  type MeshThreadSnapshot,
  type MeshThreadStatus,
  type MeshThreadToolCallView,
  type NestedSubagentStatus,
  type NormalizedRuntimeEvent,
  type PeerExchangeRecord,
  type PendingToolApproval,
  type RevertCheckpointResult,
  type StudyContextReaderPort,
  type WorkspaceBindingRecord,
} from './contracts.ts';
import {
  ConcreteAdapterRegistryPort,
  ConcreteCheckpointPort,
  ConcreteFileLeasePort,
  ConcreteMeshBridgeServerPort,
} from './port-adapters.ts';
import { AgentMeshStorage } from './storage.ts';
import {
  neutralizeUntrusted,
  SwarmEngine,
  type SwarmSteerRequest,
  type SwarmWakeRequest,
} from './swarm-engine.ts';

const FILE_WRITE_TOOLS = new Set([
  'edit',
  'write',
  'multiedit',
  'notebookedit',
  'patch',
  'apply_patch',
  'write_file',
  'edit_file',
  'create_file',
  'delete_file',
]);

function isFileMutatingTool(toolName: string): boolean {
  const lower = toolName.trim().toLowerCase();
  if (FILE_WRITE_TOOLS.has(lower)) return true;
  return /(?:^|[._:/-])(edit|write|patch|create_file|delete_file|replace)(?:$|[._:/-])/.test(lower);
}

function isFilesystemRootPath(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed === '/' || trimmed === '\\') {
    return true;
  }
  const resolved = path.resolve(trimmed);
  if (resolved === '/') {
    return true;
  }
  if (process.platform === 'win32') {
    const winResolved = path.win32.resolve(trimmed);
    if (winResolved === path.win32.parse(winResolved).root) {
      return true;
    }
  }
  return false;
}

interface QueuedTurnTask {
  id: string;
  prompt: string;
  contextText: string | null;
  ownedGlobs: string[];
  readOnly: boolean;
  model?: string;
  reasoningEffort?: string;
  nativeTimeline?: NativeTurnTimelineSession | null;
  signal?: AbortSignal;
  resolveCompletion: (result: CompletedTurnOutcome) => void;
  rejectCompletion: (error: unknown) => void;
}

interface CompletedTurnOutcome {
  assistantText: string;
  checkpointAfter: MeshCheckpointRecord | null;
  diff: MeshDiffReport | null;
  status: MeshThreadStatus;
}

interface ThreadActorState {
  threadId: string;
  chatSessionId: string;
  assistantText: string;
  thinkingText: string;
  toolCalls: MeshThreadToolCallView[];
  childSubagents: Map<string, NestedSubagentStatus>;
  activeBgTasks: Set<string>;
  pendingApproval: PendingToolApproval | null;
  diffSummary: { filesChanged: number; additions: number; deletions: number } | null;
  queue: QueuedTurnTask[];
  processing: boolean;
  activeTurnAbort: AbortController | null;
  activeAdapter: ExternalCodingAdapter | null;
  mainTurnSettled: boolean;
  lastTurnError: string | null;
  quiescenceResolvers: Array<() => void>;
  idleResolvers: Array<() => void>;
  turnCounter: number;
}

export interface MeshLoggerLike {
  info?(message: string): void;
  warn(message: string): void;
  error?(message: string): void;
}

export interface MeshKillSwitchPort {
  isTripped(): boolean;
  ensureAllowed?(): void;
}

export interface MeshOrchestratorOptions {
  storage?: AgentMeshStorage;
  appDataDir?: string;
  inMemoryDb?: boolean;
  adapters?: AdapterRegistryPort;
  checkpoints?: CheckpointPort;
  fileLeases?: FileLeasePort;
  bridgeServer?: MeshBridgeServerPort;
  studyContextReader?: StudyContextReaderPort;
  chatTimeline?: ChatTimelinePort | null;
  killSwitch?: () => MeshKillSwitchPort | undefined;
  onCoordinatorWake?: (notification: CoordinatorWakeNotification) => Promise<void> | void;
  emitEvent?: (event: AgentMeshEvent) => void;
  logger?: MeshLoggerLike;
  swarmCoalesceMs?: number;
  approvalLeaseWaitMs?: number;
}

function extractChatSessionId(
  input: string | { chatSessionId?: string; sessionId?: string } | null | undefined,
): string {
  if (typeof input === 'string') return input.trim();
  const id = input?.chatSessionId ?? input?.sessionId ?? '';
  return typeof id === 'string' ? id.trim() : '';
}

function formatSwarmWakePrompt(req: SwarmWakeRequest): string {
  const header =
    req.reason === 'stall'
      ? `[Swarm Stall Check] All swarm members are currently parked while session "${req.chatSessionId}" is still active. Review the board below and either assign the next step, synthesize final results, or complete the swarm.`
      : `[Swarm Board Update · seq ${req.sinceSeq + 1}..${req.toSeq}] New messages addressed to @${req.member.rosterName}:`;
  const lines = req.messages.map(
    (msg) =>
      `#${msg.seq} [${msg.senderKind}:${msg.sender} · ${msg.priority}] ${neutralizeUntrusted(msg.text, 4_000)}`,
  );
  const ownedHint =
    req.member.ownedGlobs.length > 0
      ? `\nOwned file globs: ${req.member.ownedGlobs.join(', ')}`
      : '';
  return `${header}\n\n${lines.join('\n')}${ownedHint}\n\nPost your findings/handoffs to the swarm board when done, then settle cleanly.`;
}

export class MeshOrchestrator implements AgentMeshService {
  readonly storage: AgentMeshStorage;
  readonly swarm: SwarmEngine;
  private readonly adapters: AdapterRegistryPort;
  private readonly checkpoints: CheckpointPort;
  private readonly fileLeases: FileLeasePort;
  private readonly bridgeServer: MeshBridgeServerPort;
  private readonly studyContextReader: StudyContextReaderPort | undefined;
  private readonly getKillSwitch: (() => MeshKillSwitchPort | undefined) | undefined;
  private readonly onCoordinatorWake:
    | ((notification: CoordinatorWakeNotification) => Promise<void> | void)
    | undefined;
  private readonly emitEventFn: ((event: AgentMeshEvent) => void) | undefined;
  private readonly logger: MeshLoggerLike;
  private readonly approvalLeaseWaitMs: number;
  private readonly appDataDir: string | undefined;
  private readonly inMemoryDb: boolean;
  private chatTimelinePort: ChatTimelinePort | null;

  private readonly actors = new Map<string, ThreadActorState>();
  private readonly sessionApprovedTools = new Map<string, Set<string>>();
  private readonly coordinatorNotifications = new Map<string, CoordinatorWakeNotification[]>();
  private cachedAgents: DetectedCliAgent[] = [DEFAULT_BUILTIN_COORDINATOR_AGENT];
  private initialProbeCompleted = false;
  private globalTurnSeq = 0;
  private disposed = false;

  constructor(options: MeshOrchestratorOptions = {}) {
    this.logger = options.logger ?? { warn: () => undefined };
    this.appDataDir = options.appDataDir;
    this.inMemoryDb = Boolean(options.inMemoryDb ?? !options.appDataDir);
    this.chatTimelinePort = options.chatTimeline ?? null;
    this.storage =
      options.storage ??
      new AgentMeshStorage({
        appDataDir: options.appDataDir,
        inMemory: this.inMemoryDb,
      });
    const checkpointStorageDir =
      options.appDataDir && options.appDataDir !== ':memory:' && !options.inMemoryDb
        ? path.join(options.appDataDir, 'agent-mesh-checkpoints')
        : undefined;
    const concreteFileLeases = options.fileLeases ? null : new ConcreteFileLeasePort();
    this.adapters = options.adapters ?? new ConcreteAdapterRegistryPort();
    this.checkpoints =
      options.checkpoints ?? new ConcreteCheckpointPort({ storageDir: checkpointStorageDir });
    this.fileLeases = options.fileLeases ?? concreteFileLeases!;
    this.bridgeServer =
      options.bridgeServer ??
      new ConcreteMeshBridgeServerPort({
        fileLeaseTable: concreteFileLeases?.table,
      });
    this.studyContextReader = options.studyContextReader;
    this.getKillSwitch = options.killSwitch;
    this.onCoordinatorWake = options.onCoordinatorWake;
    this.emitEventFn = options.emitEvent;
    this.approvalLeaseWaitMs = options.approvalLeaseWaitMs ?? 5_000;

    // Reconcile any orphaned active records from an earlier crash/exit so they become cleanly resumable.
    this.storage.reconcileOrphanedActiveRecords();

    this.swarm = new SwarmEngine({
      storage: this.storage,
      coalesceWindowMs: options.swarmCoalesceMs,
      callbacks: {
        onWakeMember: (req) => this.handleSwarmWakeMember(req),
        onSteerMember: (req) => this.handleSwarmSteerMember(req),
        onEmitEvent: (ev) => this.emit(ev),
      },
    });

    this.bridgeServer.bindCallbacks?.(this.createBridgeCallbacks());
  }

  setChatTimelinePort(port: ChatTimelinePort | null): void {
    this.chatTimelinePort = port;
  }

  resolveSafeWorkspaceRoot(
    chatSessionId: string,
    requestedRootPath?: string | null,
    boundRootPath?: string | null,
  ): string {
    const candidate = (requestedRootPath?.trim() || boundRootPath?.trim() || '').trim();
    if (candidate.length > 0 && !isFilesystemRootPath(candidate)) {
      return candidate;
    }
    const baseDir =
      this.appDataDir && this.appDataDir !== ':memory:' && !this.inMemoryDb
        ? path.join(this.appDataDir, 'agent-mesh-workspaces')
        : path.join(os.tmpdir(), 'dstu-agent-mesh-workspaces');
    const sessionDir = path.join(
      baseDir,
      chatSessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default',
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    return sessionDir;
  }

  // ---- Emergency Stop Hook (`ChatSessionService.registerEmergencyCancelHook`) ----

  cancelForEmergencyStop(reason: string): number {
    let cancelled = 0;
    for (const actor of this.actors.values()) {
      if (actor.processing || actor.activeTurnAbort) {
        cancelled += 1;
        void this.interruptTurn({ threadId: actor.threadId, reason });
      }
    }
    return cancelled;
  }

  getCoordinatorNotifications(chatSessionId: string): CoordinatorWakeNotification[] {
    return [...(this.coordinatorNotifications.get(chatSessionId) ?? [])];
  }

  async waitForThreadIdle(threadId: string): Promise<MeshThreadSnapshot | null> {
    const actor = this.actors.get(threadId);
    if (actor && (actor.processing || actor.queue.length > 0)) {
      await new Promise<void>((resolve) => {
        actor.idleResolvers.push(resolve);
      });
    }
    const record = this.storage.getThread(threadId);
    return record ? this.toThreadSnapshot(record) : null;
  }

  // ---- 1. Agent Probing & Custom Templates ----------------------------------

  async probeAgents(options?: { forceRefresh?: boolean } | boolean): Promise<DetectedCliAgent[]> {
    const forceRefresh = typeof options === 'boolean' ? options : options?.forceRefresh === true;
    const customTemplates = this.storage.listCustomTemplates();
    const detected = await this.adapters.probeAgents({ forceRefresh, customTemplates });
    const hasBuiltin = detected.some((a) => a.id === 'deepstudent');
    const merged = hasBuiltin ? [...detected] : [DEFAULT_BUILTIN_COORDINATOR_AGENT, ...detected];
    this.cachedAgents = merged;
    this.initialProbeCompleted = true;
    this.emit({ type: 'agents_probed', agents: merged });
    return merged;
  }

  async saveCustomCliTemplate(input: CustomCliTemplateInput): Promise<CustomCliTemplate> {
    const saved = this.storage.saveCustomTemplate(input);
    const all = this.storage.listCustomTemplates();
    this.emit({ type: 'templates_updated', templates: all });
    await this.probeAgents({ forceRefresh: true });
    return saved;
  }

  async deleteCustomCliTemplate(
    input: { id: string } | string,
  ): Promise<{ deleted: boolean; id: string }> {
    const id = typeof input === 'string' ? input.trim() : String(input?.id ?? '').trim();
    if (!id) throw new Error('AGENT_MESH_INVALID_TEMPLATE: id is required');
    const deleted = this.storage.deleteCustomTemplate(id);
    const all = this.storage.listCustomTemplates();
    this.emit({ type: 'templates_updated', templates: all });
    await this.probeAgents({ forceRefresh: true });
    return { deleted, id };
  }

  // ---- 2. Workspace Directory Binding ---------------------------------------

  async getWorkspaceBinding(
    input: string | { chatSessionId?: string; sessionId?: string },
  ): Promise<WorkspaceBindingRecord | null> {
    const chatSessionId = extractChatSessionId(input);
    if (!chatSessionId) return null;
    return this.storage.getWorkspaceBinding(chatSessionId);
  }

  async setWorkspaceBinding(
    input: { chatSessionId?: string; sessionId?: string; rootPath: string | null } | string,
    positionalRootPath?: string | null,
  ): Promise<WorkspaceBindingRecord | null> {
    const chatSessionId =
      typeof input === 'string' ? input.trim() : extractChatSessionId(input);
    const rootPath =
      typeof input === 'string' ? (positionalRootPath ?? null) : (input.rootPath ?? null);
    if (!chatSessionId) {
      throw new Error('AGENT_MESH_INVALID_SESSION: chatSessionId is required');
    }
    const binding = this.storage.setWorkspaceBinding(chatSessionId, rootPath);
    this.emit({ type: 'workspace_bound', chatSessionId, binding });
    return binding;
  }

  // ---- 3. Per-Thread Single-Flight Turn Execution ---------------------------

  async startTurn(rawInput: StartMeshTurnInput): Promise<StartMeshTurnResult> {
    this.ensureKillSwitchClear();
    const chatSessionId = rawInput.chatSessionId?.trim();
    const agentId = rawInput.agentId?.trim().replace(/^@+/, '');
    const prompt = rawInput.prompt?.trim();
    if (!chatSessionId || !agentId || !prompt) {
      throw new Error('AGENT_MESH_INVALID_TURN: chatSessionId, agentId, and prompt are required');
    }

    const existingBinding = this.storage.getWorkspaceBinding(chatSessionId);
    const explicitRootPath = rawInput.rootPath?.trim() ?? '';
    const rootPath = this.resolveSafeWorkspaceRoot(
      chatSessionId,
      explicitRootPath || null,
      existingBinding?.rootPath ?? null,
    );
    if (!existingBinding && explicitRootPath.length > 0 && !isFilesystemRootPath(explicitRootPath)) {
      const bound = this.storage.setWorkspaceBinding(chatSessionId, rootPath);
      this.emit({ type: 'workspace_bound', chatSessionId, binding: bound });
    }

    const rosterName = (rawInput.rosterName?.trim().replace(/^@+/, '') || agentId).toLowerCase();

    // Reuse existing thread if `threadId` given or if session already has a resumable thread for this rosterName.
    const reusable = rawInput.threadId
      ? this.storage.getThread(rawInput.threadId)
      : this.storage.findLatestThreadForAgent(chatSessionId, rosterName);
    const threadId = rawInput.threadId?.trim() || reusable?.threadId || `thr_${randomUUID()}`;
    const resumeSessionId =
      rawInput.resumeSessionId !== undefined
        ? rawInput.resumeSessionId
        : (reusable?.externalSessionId ?? null);

    let nativeTimeline: NativeTurnTimelineSession | null = null;
    if (rawInput.timelineMode === 'native_chat' && this.chatTimelinePort) {
      nativeTimeline = prepareNativeTurnTimeline({
        port: this.chatTimelinePort,
        chatSessionId,
        agentId,
        rosterName,
        model: rawInput.model,
        prompt,
        userPrompt: rawInput.userPrompt,
        userMessageId: rawInput.userMessageId,
        assistantMessageId: rawInput.assistantMessageId,
        skipUserMessageSave: rawInput.skipUserMessageSave,
        cachedAgents: this.cachedAgents,
        customTemplates: this.storage.listCustomTemplates(),
      });
    }

    const record = this.storage.upsertThread({
      threadId,
      chatSessionId,
      agentId,
      rosterName,
      rootPath,
      externalSessionId: resumeSessionId,
      status: reusable && this.isActorBusy(threadId) ? reusable.status : 'running',
      humanControlled: reusable?.humanControlled ?? false,
    });

    const actor = this.getOrCreateActor(record);
    const wasBusy = actor.processing || actor.queue.length > 0;

    let completionResolve!: (res: CompletedTurnOutcome) => void;
    let completionReject!: (err: unknown) => void;
    const completionPromise = new Promise<CompletedTurnOutcome>((resolve, reject) => {
      completionResolve = resolve;
      completionReject = reject;
    });

    actor.queue.push({
      id: `task_${randomUUID()}`,
      prompt,
      contextText: rawInput.contextText ?? null,
      ownedGlobs: rawInput.ownedGlobs ?? [],
      readOnly: rawInput.readOnly === true,
      model: rawInput.model?.trim() || undefined,
      reasoningEffort: rawInput.reasoningEffort?.trim() || undefined,
      nativeTimeline,
      signal: rawInput.signal,
      resolveCompletion: completionResolve,
      rejectCompletion: completionReject,
    });

    this.emitThreadUpdated(threadId);
    void this.pumpActor(actor);

    if (rawInput.awaitCompletion === true) {
      const completed = await completionPromise;
      const finalRecord = this.storage.getThread(threadId)!;
      return {
        threadId,
        status: completed.status,
        queued: false,
        thread: this.toThreadSnapshot(finalRecord),
        ...(nativeTimeline ? { nativeTimelineAttached: true } : {}),
        assistantText: completed.assistantText,
        checkpointAfter: completed.checkpointAfter,
        diff: completed.diff,
      };
    }

    // Prevent unhandled rejection when caller opts for non-blocking streaming mode.
    completionPromise.catch((err) => {
      this.logger.warn(`[agent-mesh] async turn error on ${threadId}: ${String(err)}`);
    });

    const latestRecord = this.storage.getThread(threadId)!;
    return {
      threadId,
      status: latestRecord.status,
      queued: wasBusy,
      thread: this.toThreadSnapshot(latestRecord),
      ...(nativeTimeline ? { nativeTimelineAttached: true } : {}),
    };
  }

  // ---- 4. Graded Steer vs Queue-at-Head -------------------------------------

  async steerTurn(
    rawInput: SteerMeshTurnInput | string,
    positionalText?: string,
  ): Promise<SteerMeshTurnResult> {
    this.ensureKillSwitchClear();
    const normalized: SteerMeshTurnInput =
      typeof rawInput === 'string'
        ? { threadId: rawInput, text: positionalText ?? '' }
        : rawInput;
    const text = normalized.text?.trim();
    if (!text) {
      throw new Error('AGENT_MESH_INVALID_STEER: steer text must be non-empty');
    }

    const thread = this.resolveTargetThread(normalized);
    if (!thread) {
      throw new Error('AGENT_MESH_THREAD_NOT_FOUND: no matching thread to steer');
    }

    const actor = this.getOrCreateActor(thread);
    const isBusy = actor.processing;

    if (!isBusy) {
      const started = await this.startTurn({
        chatSessionId: thread.chatSessionId,
        threadId: thread.threadId,
        agentId: thread.agentId,
        rosterName: thread.rosterName,
        rootPath: thread.rootPath,
        prompt: text,
      });
      this.emit({
        type: 'turn_steered',
        chatSessionId: thread.chatSessionId,
        threadId: started.threadId,
        mode: 'started_turn',
        text,
      });
      return {
        delivered: true,
        mode: 'started_turn',
        threadId: started.threadId,
        canInterruptAndResume: false,
      };
    }

    const adapter = actor.activeAdapter;
    if (adapter?.capabilities.midTurnSteer && typeof adapter.steer === 'function') {
      const ok = await adapter.steer(thread.threadId, text);
      if (ok) {
        this.emit({
          type: 'turn_steered',
          chatSessionId: thread.chatSessionId,
          threadId: thread.threadId,
          mode: 'mid_turn_steer',
          text,
        });
        return {
          delivered: true,
          mode: 'mid_turn_steer',
          threadId: thread.threadId,
          canInterruptAndResume: false,
        };
      }
    }

    if (normalized.interruptIfUnsupported === true) {
      await this.interruptActiveTaskOnly(actor, 'interrupt_for_steer');
      await this.startTurn({
        chatSessionId: thread.chatSessionId,
        threadId: thread.threadId,
        agentId: thread.agentId,
        rosterName: thread.rosterName,
        rootPath: thread.rootPath,
        prompt: text,
      });
      this.emit({
        type: 'turn_steered',
        chatSessionId: thread.chatSessionId,
        threadId: thread.threadId,
        mode: 'interrupt_and_resume',
        text,
      });
      return {
        delivered: true,
        mode: 'interrupt_and_resume',
        threadId: thread.threadId,
        canInterruptAndResume: false,
      };
    }

    // Adapter lacks native mid-turn steer: enqueue at HEAD of queue so it runs next immediately!
    actor.queue.unshift({
      id: `steer_${randomUUID()}`,
      prompt: text,
      contextText: null,
      ownedGlobs: [],
      readOnly: false,
      resolveCompletion: () => undefined,
      rejectCompletion: () => undefined,
    });
    this.emitThreadUpdated(thread.threadId);
    this.emit({
      type: 'turn_steered',
      chatSessionId: thread.chatSessionId,
      threadId: thread.threadId,
      mode: 'queued_at_head',
      text,
    });
    return {
      delivered: false,
      mode: 'queued_at_head',
      threadId: thread.threadId,
      canInterruptAndResume: true,
    };
  }

  // ---- 5. Interrupt & Cascading Cleanup -------------------------------------

  async interruptTurn(
    rawInput: InterruptMeshTurnInput | string,
    positionalReason?: string,
  ): Promise<{ interruptedThreadIds: string[] }> {
    const input: InterruptMeshTurnInput =
      typeof rawInput === 'string'
        ? { threadId: rawInput, reason: positionalReason }
        : rawInput;
    const reason = input.reason?.trim() || 'user_interrupted';
    const targets: MeshThreadRecord[] = [];

    if (input.threadId) {
      const found = this.storage.getThread(input.threadId);
      if (found) targets.push(found);
    } else if (input.chatSessionId) {
      for (const t of this.storage.listThreadsBySession(input.chatSessionId)) {
        if (
          t.status === 'running' ||
          t.status === 'waiting_children' ||
          t.status === 'waiting_approval' ||
          this.isActorBusy(t.threadId)
        ) {
          targets.push(t);
        }
      }
    }

    const interruptedThreadIds: string[] = [];
    for (const thread of targets) {
      const actor = this.actors.get(thread.threadId);
      if (actor) {
        while (actor.queue.length > 0) {
          const dropped = actor.queue.shift()!;
          dropped.nativeTimeline?.cancelQueued(`Interrupted: ${reason}`);
          dropped.rejectCompletion(new Error(`Interrupted: ${reason}`));
        }
        await this.interruptActiveTaskOnly(actor, reason);
      }
      await this.fileLeases.releaseAgentLeases(thread.rosterName, thread.threadId);
      this.emitLeasesUpdated(thread.rootPath);
      this.storage.updateThreadPatch(thread.threadId, { status: 'stopped' });
      this.swarm.setMemberActivity(thread.chatSessionId, thread.rosterName, {
        activeChildCount: 0,
        activeBgTaskCount: 0,
        status: 'stopped',
      });
      this.emitThreadUpdated(thread.threadId);
      interruptedThreadIds.push(thread.threadId);
    }
    return { interruptedThreadIds };
  }

  // ---- 6. Tool Approval Callback Resolution ---------------------------------

  async respondApproval(
    input: RespondMeshApprovalInput,
  ): Promise<{ delivered: boolean; threadId: string | null }> {
    let targetActor: ThreadActorState | undefined;
    if (input.threadId) {
      targetActor = this.actors.get(input.threadId);
    } else {
      for (const candidate of this.actors.values()) {
        if (candidate.pendingApproval?.requestId === input.requestId) {
          targetActor = candidate;
          break;
        }
      }
    }

    if (!targetActor || !targetActor.pendingApproval) {
      return { delivered: false, threadId: input.threadId ?? null };
    }

    const approval = targetActor.pendingApproval;
    const thread = this.storage.getThread(targetActor.threadId);
    if (input.approved && input.scope === 'session' && thread) {
      const set = this.sessionApprovedTools.get(thread.chatSessionId) ?? new Set<string>();
      set.add(approval.toolName);
      this.sessionApprovedTools.set(thread.chatSessionId, set);
    }

    // If approving a file-mutating tool with a target path, acquire FileLease before releasing CLI!
    if (input.approved && thread && approval.targetPath && isFileMutatingTool(approval.toolName)) {
      const leaseRes = await this.fileLeases.acquireLease({
        rootPath: thread.rootPath,
        patterns: [approval.targetPath],
        holderAgentId: thread.rosterName,
        threadId: thread.threadId,
        waitMs: this.approvalLeaseWaitMs,
      });
      this.emitLeasesUpdated(thread.rootPath);
      if (!leaseRes.granted && leaseRes.conflict) {
        const conflictReason = `Path "${approval.targetPath}" is currently leased by @${leaseRes.conflict.holderAgentId}. Coordinate on the board or edit disjoint files first.`;
        await targetActor.activeAdapter?.respondApproval?.(
          targetActor.threadId,
          input.requestId,
          { approved: false, reason: conflictReason },
        );
        targetActor.pendingApproval = null;
        this.restoreThreadRunningStatusAfterApproval(targetActor);
        return { delivered: true, threadId: targetActor.threadId };
      }
    }

    const delivered =
      (await targetActor.activeAdapter?.respondApproval?.(targetActor.threadId, input.requestId, {
        approved: input.approved,
        reason: input.reason,
      })) ?? false;

    targetActor.pendingApproval = null;
    this.restoreThreadRunningStatusAfterApproval(targetActor);
    if (thread) {
      this.emit({
        type: 'approval_resolved',
        chatSessionId: thread.chatSessionId,
        threadId: thread.threadId,
        requestId: input.requestId,
        approved: input.approved,
      });
    }
    return { delivered, threadId: targetActor.threadId };
  }

  // ---- 7. Human Takeover Lock (`human_controlled`) --------------------------

  async setHumanControlled(
    input: SetHumanControlledInput,
  ): Promise<{ chatSessionId: string; target: string; humanControlled: boolean }> {
    const chatSessionId = input.chatSessionId.trim();
    const humanControlled = Boolean(input.humanControlled);
    let targetLabel = input.rosterName || input.agentId || input.threadId || '';

    if (input.threadId) {
      const updatedThread = this.storage.updateThreadPatch(input.threadId, { humanControlled });
      if (updatedThread) {
        targetLabel = updatedThread.rosterName;
        this.swarm.setMemberHumanControlled(
          updatedThread.chatSessionId,
          updatedThread.rosterName,
          humanControlled,
        );
        this.emitThreadUpdated(updatedThread.threadId);
      }
    } else if (input.rosterName || input.agentId) {
      const handle = (input.rosterName ?? input.agentId ?? '').trim().replace(/^@+/, '');
      targetLabel = handle;
      this.swarm.setMemberHumanControlled(chatSessionId, handle, humanControlled);
      const thread = this.storage.findLatestThreadForAgent(chatSessionId, handle);
      if (thread) {
        this.storage.updateThreadPatch(thread.threadId, { humanControlled });
        this.emitThreadUpdated(thread.threadId);
      }
    }

    this.emit({
      type: 'human_controlled_changed',
      chatSessionId,
      target: targetLabel,
      humanControlled,
    });
    return { chatSessionId, target: targetLabel, humanControlled };
  }

  // ---- 8. Session Snapshot, Checkpoints & In-Place Time Machine -------------

  async getSessionSnapshot(
    input: string | { chatSessionId?: string; sessionId?: string },
  ): Promise<MeshSessionSnapshot> {
    const chatSessionId = extractChatSessionId(input);
    const workspaceBinding = chatSessionId
      ? this.storage.getWorkspaceBinding(chatSessionId)
      : null;
    const threads = chatSessionId
      ? this.storage.listThreadsBySession(chatSessionId).map((t) => this.toThreadSnapshot(t))
      : [];
    const peerExchanges = chatSessionId
      ? this.storage.listPeerExchangesBySession(chatSessionId)
      : [];
    const checkpoints = chatSessionId
      ? this.storage.listCheckpointsBySession(chatSessionId)
      : [];
    const fileLeases = this.fileLeases.listActiveLeases(workspaceBinding?.rootPath);
    const swarm = chatSessionId ? this.swarm.getSnapshot(chatSessionId) : null;
    const customTemplates = this.storage.listCustomTemplates();

    return {
      chatSessionId,
      workspaceBinding,
      agents: this.cachedAgents,
      threads,
      peerExchanges,
      checkpoints,
      fileLeases,
      swarm,
      customTemplates,
    };
  }

  async getCheckpointDiff(input: GetCheckpointDiffInput | string): Promise<MeshDiffReport> {
    const opts: GetCheckpointDiffInput =
      typeof input === 'string' ? { checkpointId: input } : input;

    if (opts.fromCheckpointId && opts.toCheckpointId) {
      const fromChk = this.storage.getCheckpoint(opts.fromCheckpointId);
      const toChk = this.storage.getCheckpoint(opts.toCheckpointId);
      if (!fromChk || !toChk) {
        throw new Error('AGENT_MESH_CHECKPOINT_NOT_FOUND: checkpoint range not found');
      }
      const diff = await this.checkpoints.diffCheckpoints(
        fromChk.rootPath,
        fromChk.ref,
        toChk.ref,
        toChk.agentId,
      );
      return this.filterDiffByAgent(diff, opts.agentId);
    }

    if (opts.checkpointId) {
      const target = this.storage.getCheckpoint(opts.checkpointId);
      if (!target) {
        throw new Error(`AGENT_MESH_CHECKPOINT_NOT_FOUND: ${opts.checkpointId}`);
      }
      const sessionCheckpoints = this.storage.listCheckpointsBySession(target.chatSessionId);
      if (target.kind === 'after') {
        const matchingBefore = sessionCheckpoints.find(
          (c) =>
            c.threadId === target.threadId &&
            c.turnSeq === target.turnSeq &&
            c.kind === 'before',
        );
        if (matchingBefore) {
          const diff = await this.checkpoints.diffCheckpoints(
            target.rootPath,
            matchingBefore.ref,
            target.ref,
            target.agentId,
          );
          return this.filterDiffByAgent(diff, opts.agentId);
        }
      }
      if (typeof this.checkpoints.diffWorkingTreeFromCheckpoint === 'function') {
        const diff = await this.checkpoints.diffWorkingTreeFromCheckpoint(
          target.rootPath,
          target.ref,
          target.agentId,
        );
        return this.filterDiffByAgent(diff, opts.agentId);
      }
      return { files: [], totalAdditions: 0, totalDeletions: 0, fromRef: target.ref };
    }

    if (opts.chatSessionId) {
      const all = this.storage.listCheckpointsBySession(opts.chatSessionId);
      const firstBefore = all.find((c) => c.kind === 'before');
      const lastAfter = [...all].reverse().find((c) => c.kind === 'after');
      if (firstBefore && lastAfter) {
        const diff = await this.checkpoints.diffCheckpoints(
          firstBefore.rootPath,
          firstBefore.ref,
          lastAfter.ref,
        );
        return this.filterDiffByAgent(diff, opts.agentId);
      }
    }

    return { files: [], totalAdditions: 0, totalDeletions: 0 };
  }

  async revertCheckpoint(
    rawInput: RevertCheckpointInput | string,
    positionalPaths?: string[],
  ): Promise<RevertCheckpointResult & { checkpointId: string }> {
    const input: RevertCheckpointInput =
      typeof rawInput === 'string'
        ? { checkpointId: rawInput, paths: positionalPaths }
        : rawInput;
    const checkpoint = this.storage.getCheckpoint(input.checkpointId);
    if (!checkpoint) {
      throw new Error(`AGENT_MESH_CHECKPOINT_NOT_FOUND: ${input.checkpointId}`);
    }
    const sessionCheckpoints = this.storage.listCheckpointsBySession(checkpoint.chatSessionId);
    const matchingAfter =
      checkpoint.kind === 'before'
        ? sessionCheckpoints.find(
            (c) =>
              c.threadId === checkpoint.threadId &&
              c.turnSeq === checkpoint.turnSeq &&
              c.kind === 'after',
          )
        : checkpoint;

    const result = await this.checkpoints.revertToCheckpoint(
      input.rootPath ?? checkpoint.rootPath,
      checkpoint,
      {
        paths: input.paths,
        postTurnHashes: matchingAfter?.postTurnHashes ?? checkpoint.postTurnHashes,
        forceOverwriteUserEdits: input.forceOverwriteUserEdits,
      },
    );

    this.emit({
      type: 'checkpoint_reverted',
      chatSessionId: checkpoint.chatSessionId,
      checkpointId: checkpoint.checkpointId,
      revertedPaths: result.revertedPaths,
      skippedUserModifiedPaths: result.skippedUserModifiedPaths,
    });

    return {
      checkpointId: checkpoint.checkpointId,
      revertedPaths: result.revertedPaths,
      skippedUserModifiedPaths: result.skippedUserModifiedPaths,
    };
  }

  // ---- 9. Swarm Control Dispatcher ------------------------------------------

  async swarmControl(input: SwarmControlInput): Promise<unknown> {
    const chatSessionId = input.chatSessionId?.trim();
    if (!chatSessionId) {
      throw new Error('AGENT_MESH_INVALID_SWARM: chatSessionId is required');
    }

    switch (input.action) {
      case 'start':
      case 'init':
      case 'create':
        return this.swarm.startSession({
          chatSessionId,
          title: input.title ?? 'Swarm Task',
          goal: input.goal ?? '',
          coordinatorAgent: input.coordinatorAgent,
          maxAutonomousHops: input.maxAutonomousHops,
          members: input.members,
          initialBrief: input.initialBrief,
        });

      case 'add_member':
      case 'addMember': {
        if (!input.rosterName || !input.agentId) {
          throw new Error('AGENT_MESH_INVALID_SWARM: rosterName and agentId are required');
        }
        const member = this.swarm.addOrUpdateMember({
          chatSessionId,
          rosterName: input.rosterName,
          agentId: input.agentId,
          roleTitle: input.roleTitle,
          ownedGlobs: input.ownedGlobs,
        });
        if (input.initialBrief?.trim()) {
          this.swarm.postMessage({
            chatSessionId,
            sender: input.sender ?? 'coordinator',
            senderKind: input.senderKind ?? 'coordinator',
            priority: 'task',
            text: `@${member.rosterName} ${input.initialBrief.trim()}`,
            mentions: [member.rosterName],
          });
        }
        return member;
      }

      case 'remove_member':
      case 'removeMember': {
        if (!input.rosterName) {
          throw new Error('AGENT_MESH_INVALID_SWARM: rosterName is required');
        }
        const existing = this.storage.getSwarmMember(chatSessionId, input.rosterName.toLowerCase());
        if (existing?.threadId) {
          await this.interruptTurn({ threadId: existing.threadId, reason: 'member_removed' });
        }
        return this.swarm.removeMember(chatSessionId, input.rosterName);
      }

      case 'swap_member_cli':
      case 'swap_agent':
      case 'swapAgent': {
        const targetId =
          input.agentId ?? (input as SwarmControlInput & { targetAgentId?: string }).targetAgentId;
        if (!input.rosterName || !targetId) {
          throw new Error('AGENT_MESH_INVALID_SWARM: rosterName and agentId are required');
        }
        const existing = this.storage.getSwarmMember(chatSessionId, input.rosterName.toLowerCase());
        if (existing?.threadId) {
          await this.interruptTurn({ threadId: existing.threadId, reason: 'cli_swapped' });
        }
        return this.swarm.swapMemberCli({
          chatSessionId,
          rosterName: input.rosterName,
          newAgentId: targetId,
          roleTitle: input.roleTitle,
        });
      }

      case 'handoff_member': {
        const extra = input as SwarmControlInput & {
          targetAgentId?: string;
          summary?: string;
          nextTask?: string;
        };
        const fromAgent = input.rosterName ?? 'claude';
        const targetAgent = extra.targetAgentId ?? input.agentId ?? '';
        if (!targetAgent) {
          throw new Error('AGENT_MESH_INVALID_SWARM: targetAgentId is required for handoff_member');
        }
        const summary = extra.summary?.trim() || `Handoff from @${fromAgent}`;
        const nextTask = extra.nextTask?.trim() || summary;
        this.swarm.addOrUpdateMember({
          chatSessionId,
          rosterName: targetAgent,
          agentId: targetAgent,
          roleTitle: input.roleTitle,
        });
        await this.handoff({
          chatSessionId,
          fromAgent,
          targetAgent,
          summary,
          nextTask,
        });
        return this.swarm.getSnapshot(chatSessionId);
      }

      case 'post':
      case 'post_board':
      case 'post_message':
      case 'postMessage': {
        if (!input.text?.trim()) {
          throw new Error('AGENT_MESH_INVALID_SWARM: post text is required');
        }
        return this.swarm.postMessage({
          chatSessionId,
          sender: input.sender ?? 'human',
          senderKind: input.senderKind ?? 'human',
          priority: input.priority,
          text: input.text,
          mentions: input.mentions,
          channel: input.channel,
          replyToSeq: input.replyToSeq,
          diffRef: input.diffRef,
        });
      }

      case 'read_board':
      case 'readBoard':
        return this.swarm.readBoard(chatSessionId, {
          sinceSeq: input.sinceSeq,
          limit: input.limit,
        });

      case 'pause':
        this.swarm.pauseSwarm(chatSessionId);
        return this.swarm.getSnapshot(chatSessionId);

      case 'resume':
        this.swarm.resumeSwarm(chatSessionId);
        return this.swarm.getSnapshot(chatSessionId);

      case 'reset_circuit_breaker':
        this.swarm.setMaxAutonomousHops(chatSessionId, input.maxAutonomousHops ?? 24);
        this.swarm.resumeSwarm(chatSessionId);
        return this.swarm.getSnapshot(chatSessionId);

      case 'emergency_stop_all':
        this.swarm.pauseSwarm(chatSessionId);
        await this.interruptTurn({ chatSessionId, reason: 'emergency_stop_all' });
        return this.swarm.getSnapshot(chatSessionId);

      case 'complete':
      case 'close':
      case 'stop': {
        const result = this.swarm.completeSwarm(chatSessionId);
        if (input.stopActiveThreads !== false) {
          await this.interruptTurn({ chatSessionId, reason: 'swarm_completed' });
        }
        return result;
      }

      case 'set_max_hops':
      case 'setMaxHops':
        return this.swarm.setMaxAutonomousHops(
          chatSessionId,
          input.maxAutonomousHops ?? 12,
        );

      case 'status':
        return this.swarm.getSnapshot(chatSessionId);

      default:
        throw new Error(`AGENT_MESH_INVALID_SWARM: unsupported action "${String(input.action)}"`);
    }
  }

  // ---- 10. Peer-to-Peer Consultation (`askPeer`) & Baton Handoff (`handoff`) ----

  async askPeer(input: AskPeerInput): Promise<PeerExchangeRecord> {
    this.ensureKillSwitchClear();
    const chatSessionId = input.chatSessionId.trim();
    const fromAgent = input.fromAgent.trim().replace(/^@+/, '');
    const targetAgent = input.targetAgent.trim().replace(/^@+/, '');
    const question = input.question.trim();
    if (!chatSessionId || !targetAgent || !question) {
      throw new Error('AGENT_MESH_INVALID_ASK_PEER: chatSessionId, targetAgent, and question are required');
    }

    const exchange = this.storage.createPeerExchange({
      chatSessionId,
      fromAgent,
      toAgent: targetAgent,
      kind: 'ask_peer',
      questionOrSummary: question,
      changedFiles: input.contextPaths ?? [],
      status: 'running',
    });
    this.emit({ type: 'peer_exchange_updated', chatSessionId, exchange });

    const contextHint =
      input.contextPaths && input.contextPaths.length > 0
        ? `\nRelevant paths: ${input.contextPaths.join(', ')}`
        : '';
    const consultPrompt =
      `[Peer Consultation from @${fromAgent} — Read-Only 1-Turn Answer]\n` +
      `Question: ${neutralizeUntrusted(question, 6_000)}${contextHint}\n\n` +
      `Reply concisely and directly without modifying unrelated files.`;

    try {
      const turn = await this.startTurn({
        chatSessionId,
        agentId: targetAgent,
        rosterName: targetAgent,
        rootPath: input.rootPath,
        prompt: consultPrompt,
        readOnly: true,
        awaitCompletion: true,
        signal: input.signal,
      });
      const completed = this.storage.completePeerExchange(exchange.id, {
        responseText: turn.assistantText ?? '',
        status: turn.status === 'failed' ? 'failed' : 'completed',
      })!;
      this.emit({ type: 'peer_exchange_updated', chatSessionId, exchange: completed });
      return completed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.storage.completePeerExchange(exchange.id, {
        responseText: message,
        status: 'failed',
      })!;
      this.emit({ type: 'peer_exchange_updated', chatSessionId, exchange: failed });
      throw error;
    }
  }

  async handoff(
    input: HandoffInput,
  ): Promise<{ exchange: PeerExchangeRecord; targetTurn: StartMeshTurnResult }> {
    this.ensureKillSwitchClear();
    const chatSessionId = input.chatSessionId.trim();
    const fromAgent = input.fromAgent.trim().replace(/^@+/, '');
    const targetAgent = input.targetAgent.trim().replace(/^@+/, '');
    if (!chatSessionId || !targetAgent || !input.nextTask.trim()) {
      throw new Error('AGENT_MESH_INVALID_HANDOFF: chatSessionId, targetAgent, and nextTask are required');
    }

    const binding = this.storage.getWorkspaceBinding(chatSessionId);
    const rootPath = this.resolveSafeWorkspaceRoot(
      chatSessionId,
      input.rootPath,
      binding?.rootPath ?? null,
    );

    // 1) Release caller's file leases so the downstream agent can edit handed-off files cleanly!
    await this.fileLeases.releaseAgentLeases(fromAgent.toLowerCase(), input.fromThreadId);
    this.emitLeasesUpdated(rootPath);

    // 2) Capture an explicit handoff checkpoint before downstream agent begins!
    const handoffTurnSeq = ++this.globalTurnSeq;
    const handoffCheckpoint = await this.checkpoints.captureCheckpoint({
      chatSessionId,
      threadId: input.fromThreadId ?? `handoff_${fromAgent}`,
      agentId: fromAgent,
      rosterName: fromAgent,
      rootPath,
      turnSeq: handoffTurnSeq,
      kind: 'after',
    });
    this.storage.saveCheckpoint(handoffCheckpoint);
    this.emit({ type: 'checkpoint_captured', chatSessionId, checkpoint: handoffCheckpoint });

    // 3) Record PeerExchangeRecord (`kind: 'handoff'`) for UI PeerExchangeStrip!
    const changedFiles = input.changedFiles ?? [];
    const exchange = this.storage.createPeerExchange({
      chatSessionId,
      fromAgent,
      toAgent: targetAgent,
      kind: 'handoff',
      questionOrSummary: `${input.summary.trim()}\nNext: ${input.nextTask.trim()}`,
      changedFiles,
      status: 'running',
    });
    this.emit({ type: 'peer_exchange_updated', chatSessionId, exchange });

    // Also record on swarm board if an active swarm exists for this session.
    const swarmSession = this.storage.getSwarmSession(chatSessionId);
    if (swarmSession && swarmSession.status === 'active') {
      this.storage.appendBoardMessage({
        chatSessionId,
        sender: fromAgent,
        senderKind: 'worker',
        priority: 'task',
        text: `@${targetAgent} [handoff] ${neutralizeUntrusted(input.summary, 2_000)} -> ${neutralizeUntrusted(input.nextTask, 2_000)}`,
        mentions: [targetAgent.toLowerCase()],
        diffRef: handoffCheckpoint.checkpointId,
      });
    }

    const filesLine =
      changedFiles.length > 0 ? `\nChanged files from @${fromAgent}: ${changedFiles.join(', ')}` : '';
    const handoffPrompt =
      `[Baton Handoff from @${fromAgent} · checkpoint ${handoffCheckpoint.checkpointId}]\n` +
      `Upstream Summary: ${neutralizeUntrusted(input.summary, 4_000)}${filesLine}\n` +
      `Your Assigned Next Task: ${neutralizeUntrusted(input.nextTask, 4_000)}`;

    const targetTurn = await this.startTurn({
      chatSessionId,
      agentId: targetAgent,
      rosterName: targetAgent,
      rootPath,
      prompt: handoffPrompt,
      awaitCompletion: input.awaitCompletion === true,
      signal: input.signal,
    });

    const finalized = this.storage.completePeerExchange(exchange.id, {
      responseText: targetTurn.assistantText ?? `Handed off to @${targetAgent} (thread ${targetTurn.threadId})`,
      changedFiles,
      status: targetTurn.status === 'failed' ? 'failed' : 'completed',
    })!;
    this.emit({ type: 'peer_exchange_updated', chatSessionId, exchange: finalized });

    return { exchange: finalized, targetTurn };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.chatTimelinePort = null;
    this.swarm.dispose();
    for (const actor of this.actors.values()) {
      await this.interruptActiveTaskOnly(actor, 'host_disposing');
    }
    this.actors.clear();
    await this.bridgeServer.dispose();
    await this.adapters.dispose?.();
    this.fileLeases.dispose?.();
    this.storage.close();
  }

  // ---- Internal Actor Loop & Event Projection -------------------------------

  private getOrCreateActor(record: MeshThreadRecord): ThreadActorState {
    let actor = this.actors.get(record.threadId);
    if (!actor) {
      actor = {
        threadId: record.threadId,
        chatSessionId: record.chatSessionId,
        assistantText: '',
        thinkingText: '',
        toolCalls: [],
        childSubagents: new Map(),
        activeBgTasks: new Set(),
        pendingApproval: null,
        diffSummary: null,
        queue: [],
        processing: false,
        activeTurnAbort: null,
        activeAdapter: null,
        mainTurnSettled: false,
        lastTurnError: null,
        quiescenceResolvers: [],
        idleResolvers: [],
        turnCounter: 0,
      };
      this.actors.set(record.threadId, actor);
    }
    return actor;
  }

  private isActorBusy(threadId: string): boolean {
    const actor = this.actors.get(threadId);
    return Boolean(actor && (actor.processing || actor.queue.length > 0));
  }

  private async pumpActor(actor: ThreadActorState): Promise<void> {
    if (actor.processing || this.disposed) return;
    actor.processing = true;

    try {
      while (actor.queue.length > 0 && !this.disposed) {
        const task = actor.queue.shift()!;
        try {
          const outcome = await this.executeSingleTurnTask(actor, task);
          task.resolveCompletion(outcome);
        } catch (error) {
          task.rejectCompletion(error);
        }
      }
    } finally {
      actor.processing = false;
      for (const resolve of actor.idleResolvers.splice(0)) {
        resolve();
      }
    }
  }

  private async executeSingleTurnTask(
    actor: ThreadActorState,
    task: QueuedTurnTask,
  ): Promise<CompletedTurnOutcome> {
    const timeline = task.nativeTimeline ?? null;
    try {
      this.ensureKillSwitchClear();
    } catch (killErr) {
      const msg = killErr instanceof Error ? killErr.message : String(killErr);
      timeline?.finalizeTurn({ status: 'failed', error: msg });
      throw killErr;
    }

    const record = this.storage.getThread(actor.threadId);
    if (!record) {
      const missingMsg = `AGENT_MESH_THREAD_NOT_FOUND: ${actor.threadId}`;
      timeline?.finalizeTurn({ status: 'failed', error: missingMsg });
      throw new Error(missingMsg);
    }

    if (this.cachedAgents.length <= 1 && !this.initialProbeCompleted) {
      this.initialProbeCompleted = true;
      await this.probeAgents().catch(() => undefined);
    }

    const customTemplates = this.storage.listCustomTemplates();
    const adapter = this.adapters.getAdapter(record.agentId, customTemplates);
    if (!adapter) {
      const unavailableMsg = `AGENT_MESH_ADAPTER_UNAVAILABLE: CLI adapter "${record.agentId}" is not available`;
      this.storage.updateThreadPatch(actor.threadId, { status: 'failed' });
      this.swarm.setMemberActivity(record.chatSessionId, record.rosterName, { status: 'failed' });
      this.emitThreadUpdated(actor.threadId);
      timeline?.finalizeTurn({ status: 'failed', error: unavailableMsg });
      throw new Error(unavailableMsg);
    }

    timeline?.beginStream();

    const turnSeq = ++this.globalTurnSeq;
    actor.turnCounter += 1;
    actor.assistantText = '';
    actor.thinkingText = '';
    actor.toolCalls = [];
    actor.childSubagents.clear();
    actor.activeBgTasks.clear();
    actor.pendingApproval = null;
    actor.mainTurnSettled = false;
    actor.lastTurnError = null;

    const abortController = new AbortController();
    actor.activeTurnAbort = abortController;
    actor.activeAdapter = adapter;

    const onExternalAbort = () => abortController.abort();
    task.signal?.addEventListener('abort', onExternalAbort, { once: true });

    let beforeCheckpoint: MeshCheckpointRecord | null = null;
    let afterCheckpoint: MeshCheckpointRecord | null = null;
    let diff: MeshDiffReport | null = null;
    let terminalStatus: MeshThreadStatus = 'idle';
    let turnFailureError: string | null = null;

    try {
      // Pre-acquire declared ownedGlobs leases if provided.
      if (task.ownedGlobs.length > 0 && !task.readOnly) {
        await this.fileLeases.acquireLease({
          rootPath: record.rootPath,
          patterns: task.ownedGlobs,
          holderAgentId: record.rosterName,
          threadId: record.threadId,
          waitMs: 2_000,
        });
        this.emitLeasesUpdated(record.rootPath);
      }

      this.storage.updateThreadPatch(actor.threadId, { status: 'running' });
      this.swarm.setMemberActivity(record.chatSessionId, record.rosterName, {
        activeChildCount: 0,
        activeBgTaskCount: 0,
        status: 'working',
        threadId: record.threadId,
      });
      this.emitThreadUpdated(actor.threadId);

      // 1) Capture BEFORE hidden checkpoint (GIT_INDEX_FILE or non-git SHA-256 fallback).
      beforeCheckpoint = await this.checkpoints.captureCheckpoint({
        chatSessionId: record.chatSessionId,
        threadId: record.threadId,
        agentId: record.agentId,
        rosterName: record.rosterName,
        rootPath: record.rootPath,
        turnSeq,
        kind: 'before',
      });
      this.storage.saveCheckpoint(beforeCheckpoint);
      this.emit({
        type: 'checkpoint_captured',
        chatSessionId: record.chatSessionId,
        checkpoint: beforeCheckpoint,
      });

      // 2) Issue scoped dual-channel MCP + CLI shim session token.
      const mcpSpec = await this.bridgeServer.issueAgentSession({
        chatSessionId: record.chatSessionId,
        agentId: record.agentId,
        rosterName: record.rosterName,
        threadId: record.threadId,
        rootPath: record.rootPath,
      });

      const fullPrompt = task.contextText
        ? `${task.prompt}\n\n<study_context>\n${neutralizeUntrusted(task.contextText, 12_000)}\n</study_context>`
        : task.prompt;

      try {
        const refreshedThread = this.storage.getThread(actor.threadId)!;
        const streamOrHandle = await adapter.startOrResumeTurn({
          threadId: record.threadId,
          cwd: record.rootPath,
          prompt: fullPrompt,
          resumeSessionId: refreshedThread.externalSessionId,
          mcp: mcpSpec,
          env: mcpSpec.envVars,
          signal: abortController.signal,
          readOnly: task.readOnly,
          model: task.model,
          reasoningEffort: task.reasoningEffort,
          onEvent: (ev) => this.handleAdapterRuntimeEvent(actor, record, ev, timeline),
        });

        if (streamOrHandle && Symbol.asyncIterator in Object(streamOrHandle)) {
          for await (const ev of streamOrHandle as AsyncIterable<NormalizedRuntimeEvent>) {
            this.handleAdapterRuntimeEvent(actor, record, ev, timeline);
          }
        } else if (
          streamOrHandle &&
          typeof streamOrHandle === 'object' &&
          'events' in streamOrHandle &&
          streamOrHandle.events
        ) {
          for await (const ev of streamOrHandle.events) {
            this.handleAdapterRuntimeEvent(actor, record, ev, timeline);
          }
          if (streamOrHandle.completion) {
            await streamOrHandle.completion;
          }
        }

        actor.mainTurnSettled = true;

        // 3) Quiescence Gate (Spec §IV.1): NEVER settle checkpoint, release leases, or park
        // while nested child subagents or background tasks are still running!
        if (this.actorHasActiveChildren(actor) && !abortController.signal.aborted) {
          this.storage.updateThreadPatch(actor.threadId, { status: 'waiting_children' });
          if (this.storage.getSwarmMember(record.chatSessionId, record.rosterName)) {
            this.swarm.settleMemberTurn(record.chatSessionId, record.rosterName, {
              hasActiveChildren: true,
            });
          }
          this.emitThreadUpdated(actor.threadId);
          await this.waitForActorQuiescence(actor, abortController.signal);
        }

        if (abortController.signal.aborted) {
          terminalStatus = 'stopped';
        } else if (this.storage.getThread(actor.threadId)?.status === 'failed') {
          terminalStatus = 'failed';
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          terminalStatus = 'stopped';
        } else {
          terminalStatus = 'failed';
          turnFailureError = error instanceof Error ? error.message : String(error);
        }
      } finally {
        await this.bridgeServer.revokeAgentSession(record.threadId);
        // Release file leases ONLY AFTER full quiescence!
        await this.fileLeases.releaseAgentLeases(record.rosterName, record.threadId);
        this.emitLeasesUpdated(record.rootPath);
      }

      // 4) Capture AFTER hidden checkpoint & compute per-turn diff attribution!
      afterCheckpoint = await this.checkpoints.captureCheckpoint({
        chatSessionId: record.chatSessionId,
        threadId: record.threadId,
        agentId: record.agentId,
        rosterName: record.rosterName,
        rootPath: record.rootPath,
        turnSeq,
        kind: 'after',
      });
      this.storage.saveCheckpoint(afterCheckpoint);
      this.emit({
        type: 'checkpoint_captured',
        chatSessionId: record.chatSessionId,
        checkpoint: afterCheckpoint,
      });

      diff = await this.checkpoints.diffCheckpoints(
        record.rootPath,
        beforeCheckpoint.ref,
        afterCheckpoint.ref,
        record.agentId,
      );
      actor.diffSummary = {
        filesChanged: diff.files.length,
        additions: diff.totalAdditions,
        deletions: diff.totalDeletions,
      };
    } catch (setupOrCheckpointErr) {
      terminalStatus = abortController.signal.aborted ? 'stopped' : 'failed';
      turnFailureError =
        turnFailureError ??
        (setupOrCheckpointErr instanceof Error
          ? setupOrCheckpointErr.message
          : String(setupOrCheckpointErr));
    } finally {
      task.signal?.removeEventListener('abort', onExternalAbort);
      actor.activeTurnAbort = null;
      actor.activeAdapter = null;
    }

    this.storage.updateThreadPatch(actor.threadId, {
      status: terminalStatus,
      ...(afterCheckpoint ? { lastCheckpointId: afterCheckpoint.checkpointId } : {}),
    });
    this.emitThreadUpdated(actor.threadId);

    // Finalize Native Chat V2 Timeline BEFORE resolving turn completion or throwing!
    timeline?.finalizeTurn({
      status: terminalStatus,
      diff,
      error: turnFailureError ?? actor.lastTurnError,
    });

    // 5) Settle swarm member if registered in a swarm session!
    const swarmMember = this.storage.getSwarmMember(record.chatSessionId, record.rosterName);
    if (swarmMember) {
      if (terminalStatus === 'idle') {
        this.swarm.settleMemberTurn(record.chatSessionId, record.rosterName, {
          hasActiveChildren: false,
        });
      } else if (terminalStatus === 'failed') {
        this.swarm.setMemberActivity(record.chatSessionId, record.rosterName, {
          activeChildCount: 0,
          activeBgTaskCount: 0,
          status: 'failed',
        });
      }
    }

    if (turnFailureError !== null) {
      throw new Error(turnFailureError);
    }

    return {
      assistantText: actor.assistantText,
      checkpointAfter: afterCheckpoint,
      diff,
      status: terminalStatus,
    };
  }

  private handleAdapterRuntimeEvent(
    actor: ThreadActorState,
    record: MeshThreadRecord,
    event: NormalizedRuntimeEvent,
    timeline?: NativeTurnTimelineSession | null,
  ): void {
    timeline?.handleRuntimeEvent(event);

    switch (event.type) {
      case 'assistant_delta': {
        actor.assistantText += event.text;
        this.emit({
          type: 'thread_delta',
          chatSessionId: record.chatSessionId,
          threadId: record.threadId,
          deltaKind: 'assistant',
          text: event.text,
        });
        break;
      }
      case 'thinking_delta': {
        actor.thinkingText += event.text;
        this.emit({
          type: 'thread_delta',
          chatSessionId: record.chatSessionId,
          threadId: record.threadId,
          deltaKind: 'thinking',
          text: event.text,
        });
        break;
      }
      case 'tool_call_start': {
        actor.toolCalls.push({
          callId: event.callId,
          toolName: event.toolName,
          args: event.args,
          targetPath: event.targetPath ?? null,
          command: event.command ?? null,
          status: 'running',
        });
        this.emitThreadUpdated(actor.threadId);
        break;
      }
      case 'tool_call_end': {
        const existing = actor.toolCalls.find((c) => c.callId === event.callId);
        if (existing) {
          existing.status = event.isError ? 'error' : 'completed';
          existing.output = event.output;
        }
        this.emitThreadUpdated(actor.threadId);
        break;
      }
      case 'subagent_started': {
        actor.childSubagents.set(event.childId, {
          childId: event.childId,
          parentToolUseId: event.parentToolUseId ?? null,
          title: event.title ?? event.childId,
          status: 'running',
          startedAt: new Date().toISOString(),
        });
        this.syncActorChildActivity(actor, record);
        break;
      }
      case 'subagent_completed': {
        const sub = actor.childSubagents.get(event.childId);
        if (sub) {
          sub.status = 'completed';
          sub.completedAt = new Date().toISOString();
          sub.summary = event.summary;
        }
        this.syncActorChildActivity(actor, record);
        break;
      }
      case 'bg_task_started': {
        actor.activeBgTasks.add(event.taskId);
        this.syncActorChildActivity(actor, record);
        break;
      }
      case 'bg_task_completed': {
        actor.activeBgTasks.delete(event.taskId);
        this.syncActorChildActivity(actor, record);
        break;
      }
      case 'approval_requested': {
        void this.handleIncomingApprovalRequest(actor, record, event);
        break;
      }
      case 'session_bound': {
        this.storage.updateThreadPatch(actor.threadId, {
          externalSessionId: event.externalSessionId,
        });
        this.swarm.setMemberActivity(record.chatSessionId, record.rosterName, {
          externalSessionId: event.externalSessionId,
        });
        this.emitThreadUpdated(actor.threadId);
        break;
      }
      case 'turn_settled': {
        actor.mainTurnSettled = true;
        this.syncActorChildActivity(actor, record);
        break;
      }
      case 'quiescent_completed': {
        for (const sub of actor.childSubagents.values()) {
          if (sub.status === 'running') {
            sub.status = 'completed';
            sub.completedAt = new Date().toISOString();
          }
        }
        actor.activeBgTasks.clear();
        this.syncActorChildActivity(actor, record);
        break;
      }
      case 'turn_error': {
        actor.lastTurnError = event.error;
        this.storage.updateThreadPatch(actor.threadId, { status: 'failed' });
        this.emitThreadUpdated(actor.threadId);
        break;
      }
      case 'turn_interrupted': {
        this.storage.updateThreadPatch(actor.threadId, { status: 'stopped' });
        this.emitThreadUpdated(actor.threadId);
        break;
      }
      case 'usage':
        break;
    }
  }

  private async handleIncomingApprovalRequest(
    actor: ThreadActorState,
    record: MeshThreadRecord,
    event: Extract<NormalizedRuntimeEvent, { type: 'approval_requested' }>,
  ): Promise<void> {
    // Auto-check FileLeaseTable for file-mutating tools when session approval is remembered!
    const remembered = this.sessionApprovedTools
      .get(record.chatSessionId)
      ?.has(event.toolName);
    if (remembered) {
      if (event.targetPath && isFileMutatingTool(event.toolName)) {
        const lease = await this.fileLeases.acquireLease({
          rootPath: record.rootPath,
          patterns: [event.targetPath],
          holderAgentId: record.rosterName,
          threadId: record.threadId,
          waitMs: this.approvalLeaseWaitMs,
        });
        this.emitLeasesUpdated(record.rootPath);
        if (!lease.granted && lease.conflict) {
          await actor.activeAdapter?.respondApproval?.(record.threadId, event.requestId, {
            approved: false,
            reason: `File "${event.targetPath}" is leased by @${lease.conflict.holderAgentId}.`,
          });
          return;
        }
      }
      await actor.activeAdapter?.respondApproval?.(record.threadId, event.requestId, {
        approved: true,
      });
      return;
    }

    const pending: PendingToolApproval = {
      requestId: event.requestId,
      threadId: record.threadId,
      toolName: event.toolName,
      targetPath: event.targetPath ?? null,
      command: event.command ?? null,
      reason: event.reason ?? null,
      requestedAt: new Date().toISOString(),
    };
    actor.pendingApproval = pending;
    this.storage.updateThreadPatch(record.threadId, { status: 'waiting_approval' });
    this.swarm.setMemberActivity(record.chatSessionId, record.rosterName, {
      status: 'waiting_approval',
    });
    this.emitThreadUpdated(record.threadId);
    this.emit({
      type: 'approval_requested',
      chatSessionId: record.chatSessionId,
      threadId: record.threadId,
      approval: pending,
    });
  }

  private actorRunningChildCount(actor: ThreadActorState): number {
    let count = 0;
    for (const child of actor.childSubagents.values()) {
      if (child.status === 'running') count += 1;
    }
    return count;
  }

  private actorHasActiveChildren(actor: ThreadActorState): boolean {
    return this.actorRunningChildCount(actor) > 0 || actor.activeBgTasks.size > 0;
  }

  private syncActorChildActivity(actor: ThreadActorState, record: MeshThreadRecord): void {
    const runningChildren = this.actorRunningChildCount(actor);
    const bgCount = actor.activeBgTasks.size;
    const hasChildren = runningChildren > 0 || bgCount > 0;

    if (actor.mainTurnSettled && hasChildren && !actor.pendingApproval) {
      this.storage.updateThreadPatch(record.threadId, { status: 'waiting_children' });
      this.swarm.setMemberActivity(record.chatSessionId, record.rosterName, {
        activeChildCount: runningChildren,
        activeBgTaskCount: bgCount,
        status: 'waiting_children',
      });
    } else {
      this.swarm.setMemberActivity(record.chatSessionId, record.rosterName, {
        activeChildCount: runningChildren,
        activeBgTaskCount: bgCount,
      });
    }
    this.emitThreadUpdated(record.threadId);

    if (!hasChildren) {
      for (const wake of actor.quiescenceResolvers.splice(0)) {
        wake();
      }
    }
  }

  private waitForActorQuiescence(actor: ThreadActorState, signal: AbortSignal): Promise<void> {
    if (!this.actorHasActiveChildren(actor) || signal.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const done = () => {
        signal.removeEventListener('abort', done);
        resolve();
      };
      signal.addEventListener('abort', done, { once: true });
      actor.quiescenceResolvers.push(done);
    });
  }

  private restoreThreadRunningStatusAfterApproval(actor: ThreadActorState): void {
    const nextStatus: MeshThreadStatus =
      actor.mainTurnSettled && this.actorHasActiveChildren(actor)
        ? 'waiting_children'
        : 'running';
    const record = this.storage.updateThreadPatch(actor.threadId, { status: nextStatus });
    if (record) {
      this.swarm.setMemberActivity(record.chatSessionId, record.rosterName, {
        status: nextStatus === 'waiting_children' ? 'waiting_children' : 'working',
      });
      this.emitThreadUpdated(record.threadId);
    }
  }

  private async interruptActiveTaskOnly(actor: ThreadActorState, reason: string): Promise<void> {
    actor.activeTurnAbort?.abort();
    if (actor.activeAdapter) {
      try {
        await actor.activeAdapter.interrupt(actor.threadId, reason);
      } catch (error) {
        this.logger.warn(`[agent-mesh] adapter interrupt failed (${actor.threadId}): ${String(error)}`);
      }
    }
    actor.activeBgTasks.clear();
    for (const child of actor.childSubagents.values()) {
      child.status = 'completed';
    }
    for (const wake of actor.quiescenceResolvers.splice(0)) {
      wake();
    }
  }

  // ---- Swarm Callbacks & Bridge Callbacks -----------------------------------

  private async handleSwarmWakeMember(req: SwarmWakeRequest): Promise<void> {
    // Built-in `@deepstudent` coordinator wakes via event/notification rather than spawning an external CLI binary!
    if (req.member.agentId === 'deepstudent') {
      const notification: CoordinatorWakeNotification = {
        chatSessionId: req.chatSessionId,
        reason: req.reason === 'stall' ? 'stall' : 'mention',
        messages: req.messages,
        summary: formatSwarmWakePrompt(req),
      };
      const list = this.coordinatorNotifications.get(req.chatSessionId) ?? [];
      list.push(notification);
      this.coordinatorNotifications.set(req.chatSessionId, list);
      this.emit({
        type: 'coordinator_wakeup',
        chatSessionId: req.chatSessionId,
        notification,
      });
      await this.onCoordinatorWake?.(notification);
      // Settle builtin coordinator back to `parked` once notified so any new mentions during notification aren't missed!
      this.swarm.settleMemberTurn(req.chatSessionId, req.member.rosterName, {
        hasActiveChildren: false,
      });
      return;
    }

    const binding = this.storage.getWorkspaceBinding(req.chatSessionId);
    await this.startTurn({
      chatSessionId: req.chatSessionId,
      threadId: req.member.threadId ?? undefined,
      agentId: req.member.agentId,
      rosterName: req.member.rosterName,
      rootPath: binding?.rootPath,
      ownedGlobs: req.member.ownedGlobs,
      resumeSessionId: req.member.externalSessionId,
      prompt: formatSwarmWakePrompt(req),
    });
  }

  private async handleSwarmSteerMember(req: SwarmSteerRequest): Promise<boolean> {
    if (req.member.agentId === 'deepstudent') {
      return false;
    }
    const thread = req.member.threadId
      ? this.storage.getThread(req.member.threadId)
      : this.storage.findLatestThreadForAgent(req.chatSessionId, req.member.rosterName);
    if (!thread) return false;
    const res = await this.steerTurn({
      threadId: thread.threadId,
      chatSessionId: req.chatSessionId,
      text: `[Human Correction #${req.message.seq}] ${req.message.text}`,
    });
    return res.mode === 'mid_turn_steer';
  }

  createBridgeCallbacks(): MeshBridgeHostCallbacks {
    return {
      meshPostBoard: async (scope, args) => {
        const member = this.storage.getSwarmMember(scope.chatSessionId, scope.rosterName);
        const session = this.storage.getSwarmSession(scope.chatSessionId);
        const senderKind =
          session && session.coordinatorAgent === scope.rosterName ? 'coordinator' : 'worker';
        return this.swarm.postMessage({
          chatSessionId: scope.chatSessionId,
          sender: member?.rosterName ?? scope.rosterName,
          senderKind,
          priority: args.priority ?? 'progress',
          text: args.text,
          mentions: args.mentions,
          channel: args.channel,
          replyToSeq: args.replyToSeq,
          diffRef: args.diffRef,
        });
      },
      meshReadBoard: async (scope, args) => {
        return {
          messages: this.swarm.readBoard(scope.chatSessionId, {
            sinceSeq: args.sinceSeq,
            limit: args.limit,
          }),
        };
      },
      meshAskPeer: async (scope, args) => {
        return this.askPeer({
          chatSessionId: scope.chatSessionId,
          fromAgent: scope.rosterName,
          targetAgent: args.targetAgent,
          question: args.question,
          contextPaths: args.contextPaths,
          rootPath: scope.rootPath,
        });
      },
      meshHandoff: async (scope, args) => {
        return this.handoff({
          chatSessionId: scope.chatSessionId,
          fromAgent: scope.rosterName,
          fromThreadId: scope.threadId,
          targetAgent: args.targetAgent,
          summary: args.summary,
          nextTask: args.nextTask,
          changedFiles: args.changedFiles,
          rootPath: scope.rootPath,
        });
      },
      meshClaimFiles: async (scope, args) => {
        const res = await this.fileLeases.acquireLease({
          rootPath: scope.rootPath,
          patterns: args.paths,
          holderAgentId: scope.rosterName,
          threadId: scope.threadId,
          waitMs: args.waitMs ?? 5_000,
        });
        this.emitLeasesUpdated(scope.rootPath);
        return res;
      },
      meshReleaseFiles: async (scope, args) => {
        const released = await this.fileLeases.releaseAgentLeases(
          scope.rosterName,
          scope.threadId,
          args.paths,
        );
        this.emitLeasesUpdated(scope.rootPath);
        return { released };
      },
      meshPark: async (scope, args) => {
        if (args.summary?.trim()) {
          this.swarm.postMessage({
            chatSessionId: scope.chatSessionId,
            sender: scope.rosterName,
            senderKind: 'worker',
            priority: 'result',
            text: args.summary.trim(),
          });
        }
        return { acknowledged: true, rosterName: scope.rosterName };
      },
      studyReadContext: async (scope, args) => {
        if (!this.studyContextReader) {
          return { content: '', sources: [] };
        }
        const res = await this.studyContextReader.readStudyContext({
          chatSessionId: scope.chatSessionId,
          query: args.query,
          resourceId: args.resourceId,
          maxChars: args.maxChars ?? 8_000,
        });
        return {
          content: neutralizeUntrusted(res.content, args.maxChars ?? 8_000),
          sources: res.sources,
        };
      },
    };
  }

  // ---- Helpers --------------------------------------------------------------

  private resolveTargetThread(input: SteerMeshTurnInput): MeshThreadRecord | null {
    if (input.threadId) {
      return this.storage.getThread(input.threadId);
    }
    if (input.chatSessionId) {
      const handle = (input.rosterName ?? input.agentId ?? '').trim().replace(/^@+/, '');
      if (handle) {
        return this.storage.findLatestThreadForAgent(input.chatSessionId, handle);
      }
      const threads = this.storage.listThreadsBySession(input.chatSessionId);
      const running = [...threads]
        .reverse()
        .find(
          (t) =>
            t.status === 'running' ||
            t.status === 'waiting_children' ||
            t.status === 'waiting_approval',
        );
      return running ?? threads[threads.length - 1] ?? null;
    }
    return null;
  }

  private filterDiffByAgent(diff: MeshDiffReport, agentId?: string): MeshDiffReport {
    if (!agentId) return diff;
    const clean = agentId.trim().replace(/^@+/, '').toLowerCase();
    const files = diff.files.filter(
      (f) => !f.attributedAgentId || f.attributedAgentId.toLowerCase() === clean,
    );
    return {
      ...diff,
      files,
      totalAdditions: files.reduce((s, f) => s + f.additions, 0),
      totalDeletions: files.reduce((s, f) => s + f.deletions, 0),
    };
  }

  private toThreadSnapshot(record: MeshThreadRecord): MeshThreadSnapshot {
    const actor = this.actors.get(record.threadId);
    return {
      ...record,
      assistantText: actor?.assistantText ?? '',
      thinkingText: actor?.thinkingText ?? '',
      toolCalls: actor ? actor.toolCalls.map((c) => ({ ...c })) : [],
      childSubagents: actor ? [...actor.childSubagents.values()].map((s) => ({ ...s })) : [],
      activeBgTasks: actor ? [...actor.activeBgTasks] : [],
      pendingApproval: actor?.pendingApproval ? { ...actor.pendingApproval } : null,
      queuedCount: actor?.queue.length ?? 0,
      diffSummary: actor?.diffSummary ? { ...actor.diffSummary } : null,
    };
  }

  private ensureKillSwitchClear(): void {
    const ks = this.getKillSwitch?.();
    if (!ks) return;
    if (typeof ks.ensureAllowed === 'function') {
      ks.ensureAllowed();
    } else if (ks.isTripped()) {
      throw new Error('AgentKillSwitch tripped: all external CLI agent activity is stopped.');
    }
  }

  private emitThreadUpdated(threadId: string): void {
    const record = this.storage.getThread(threadId);
    if (!record) return;
    this.emit({
      type: 'thread_updated',
      chatSessionId: record.chatSessionId,
      thread: this.toThreadSnapshot(record),
    });
  }

  private emitLeasesUpdated(rootPath: string): void {
    this.emit({
      type: 'file_leases_updated',
      rootPath,
      leases: this.fileLeases.listActiveLeases(rootPath),
    });
  }

  private emit(event: AgentMeshEvent): void {
    try {
      this.emitEventFn?.(event);
    } catch (error) {
      this.logger.warn(`[agent-mesh] failed to emit backend event ${event.type}: ${String(error)}`);
    }
  }
}

export function createMeshOrchestrator(options: MeshOrchestratorOptions = {}): MeshOrchestrator {
  return new MeshOrchestrator(options);
}

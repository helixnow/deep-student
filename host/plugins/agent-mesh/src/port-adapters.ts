/**
 * Concrete Production Port Adapters for `dstu.agent-mesh`.
 *
 * Bridges the structural orchestrator contracts (`src/contracts.ts`) to the real
 * Host subsystems without circular dependencies:
 * - `ExternalAdapterRegistry` + `CliAgentProber` + `ProcessTreeSupervisor` -> `AdapterRegistryPort`
 * - `CheckpointEngine` (`GIT_INDEX_FILE` + SHA-256 non-Git fallback) -> `CheckpointPort`
 * - `FileLeaseTable` (path/glob concurrent lease queue) -> `FileLeasePort`
 * - `MeshMcpServer` (`127.0.0.1:0` HTTP MCP + `/api/call`) + `dstu-mesh` `PATH` CLI shim -> `MeshBridgeServerPort`
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import type {
  CustomCliTemplate as AdapterCustomCliTemplate,
  DetectedCliAgent as AdapterDetectedCliAgent,
  ExternalCodingAdapter as AdapterExternalCodingAdapter,
  NormalizedRuntimeEvent as AdapterRuntimeEvent,
} from './adapter-types.ts';
import {
  ExternalAdapterRegistry,
  extractApprovalMetadata,
  type ExternalAdapterRegistryOptions,
} from './adapters/index.ts';
import { CheckpointEngine } from './checkpoints.ts';
import {
  buildCliShimEnv,
  createCliShim,
  type CreatedCliShim,
} from './cli-shim.ts';
import {
  DEFAULT_BUILTIN_COORDINATOR_AGENT,
  type AcquireFileLeaseResult,
  type ActiveFileLease as ContractActiveFileLease,
  type AdapterRegistryPort,
  type CheckpointPort,
  type CliBinaryOverride as ContractCliBinaryOverride,
  type CustomCliTemplate as ContractCustomCliTemplate,
  type DetectedCliAgent as ContractDetectedCliAgent,
  type ExternalCodingAdapter as ContractExternalCodingAdapter,
  type ExternalTurnStartInput as ContractTurnStartInput,
  type FileLeasePort,
  type McpInjectionSpec,
  type MeshBridgeHostCallbacks as ContractMeshBridgeHostCallbacks,
  type MeshBridgeServerPort,
  type MeshBridgeTokenScope,
  type MeshCheckpointRecord,
  type MeshDiffReport,
  type NormalizedRuntimeEvent as ContractRuntimeEvent,
  type RevertCheckpointResult,
} from './contracts.ts';
import { FileLeaseTable, type ActiveFileLease as TableActiveFileLease } from './file-leases.ts';
import {
  buildMcpInjectionConfig,
  MeshMcpServer,
  type MeshBridgeHostCallbacks as ServerMeshBridgeCallbacks,
} from './mesh-mcp-server.ts';

function ignoreCleanupError(_error: unknown): void {
  // Cleanup errors on ephemeral files must not mask turn or shutdown results.
}

function toAdapterCustomTemplate(tpl: ContractCustomCliTemplate): AdapterCustomCliTemplate {
  return {
    id: tpl.id,
    name: tpl.name,
    command: tpl.command,
    argsTemplate: tpl.args.length > 0 ? tpl.args : ['{{prompt}}'],
    ...(tpl.resumeArgs.length > 0 ? { resumeArgsTemplate: tpl.resumeArgs } : {}),
    ...(Object.keys(tpl.env).length > 0 ? { env: tpl.env } : {}),
  };
}

function toContractDetectedAgent(agent: AdapterDetectedCliAgent): ContractDetectedCliAgent {
  const authenticated =
    agent.authStatus === 'authenticated' ||
    (agent.driver === 'custom' && agent.installed && agent.authStatus !== 'unauthenticated');
  return {
    id: agent.id,
    kind: agent.driver,
    name: agent.displayName || agent.id,
    displayName: agent.displayName,
    command: agent.command,
    installed: agent.installed,
    authenticated,
    version: agent.version,
    executablePath: agent.resolvedPath,
    ...(agent.customExecutablePath !== undefined
      ? { customExecutablePath: agent.customExecutablePath }
      : {}),
    ...(agent.extraArgs && agent.extraArgs.length > 0 ? { extraArgs: [...agent.extraArgs] } : {}),
    ...(agent.probeError !== undefined ? { probeError: agent.probeError } : {}),
    authHint: agent.authHint ?? null,
    ...(agent.defaultModel !== undefined ? { defaultModel: agent.defaultModel } : {}),
    ...(agent.availableModels ? { availableModels: [...agent.availableModels] } : {}),
    capabilities: { ...agent.capabilities },
  };
}

function toContractRuntimeEvent(event: AdapterRuntimeEvent): ContractRuntimeEvent {
  switch (event.type) {
    case 'session_bound':
      return {
        type: 'session_bound',
        externalSessionId: event.externalSessionId,
      };
    case 'assistant_delta':
      return {
        type: 'assistant_delta',
        text: event.text,
      };
    case 'thinking_delta':
      return {
        type: 'thinking_delta',
        text: event.text,
      };
    case 'tool_call_start': {
      const meta = extractApprovalMetadata(event.toolName, event.args);
      return {
        type: 'tool_call_start',
        callId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        targetPath: meta.targetPath ?? null,
        command: meta.command ?? null,
        parentToolUseId: event.parentToolUseId ?? null,
      };
    }
    case 'tool_call_end':
      return {
        type: 'tool_call_end',
        callId: event.toolCallId,
        toolName: event.toolName,
        output: event.output,
        isError: event.isError,
      };
    case 'subagent_started':
      return {
        type: 'subagent_started',
        childId: event.childId,
        parentToolUseId: event.parentToolUseId,
        title: event.title,
      };
    case 'subagent_completed':
      return {
        type: 'subagent_completed',
        childId: event.childId,
        summary: event.summary,
      };
    case 'bg_task_started':
      return {
        type: 'bg_task_started',
        taskId: event.taskId,
        command: event.command,
      };
    case 'bg_task_completed':
      return {
        type: 'bg_task_completed',
        taskId: event.taskId,
        exitCode: event.exitCode ?? null,
      };
    case 'approval_requested':
      return {
        type: 'approval_requested',
        requestId: event.requestId,
        toolName: event.toolName,
        targetPath: event.targetPath ?? null,
        command: event.command ?? null,
        reason: event.reason ?? null,
      };
    case 'waiting_children':
      return {
        type: 'turn_settled',
        summary: `Waiting for ${event.activeSubagents.length} subagent(s) and ${event.activeBgTasks.length} background task(s)`,
      };
    case 'turn_settled':
      return {
        type: 'turn_settled',
        summary: event.stopReason,
      };
    case 'quiescent_completed':
      return {
        type: 'quiescent_completed',
      };
    case 'turn_error':
      return {
        type: 'turn_error',
        error: event.message,
        recoverable: event.recoverable,
      };
    case 'turn_interrupted':
      return {
        type: 'turn_interrupted',
        reason: event.reason,
      };
    case 'usage':
      return {
        type: 'usage',
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        totalCostUsd: event.totalCostUsd,
      };
  }
}

function wrapConcreteAdapter(inner: AdapterExternalCodingAdapter): ContractExternalCodingAdapter {
  return {
    kind: inner.driver,
    capabilities: inner.capabilities,
    startOrResumeTurn(input: ContractTurnStartInput): AsyncIterable<ContractRuntimeEvent> {
      // Omit `onEvent` when forwarding because `MeshOrchestrator` iterates the returned
      // AsyncIterable directly; forwarding both would deliver every streaming delta twice.
      const stream = inner.startOrResumeTurn({
        threadId: input.threadId,
        cwd: input.cwd,
        prompt: input.prompt,
        resumeSessionId: input.resumeSessionId ?? undefined,
        mcp: input.mcp,
        env: input.env,
        signal: input.signal,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      });
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<ContractRuntimeEvent> {
          for await (const rawEvent of stream) {
            yield toContractRuntimeEvent(rawEvent);
          }
        },
      };
    },
    async steer(threadId: string, text: string): Promise<boolean> {
      const result = await inner.steer(threadId, text);
      return result.accepted;
    },
    async interrupt(threadId: string): Promise<void> {
      await inner.interrupt(threadId);
    },
    async respondApproval(
      threadId: string,
      requestId: string,
      decision: { approved: boolean; reason?: string },
    ): Promise<boolean> {
      return inner.respondApproval(threadId, requestId, {
        decision: decision.approved ? 'allow_once' : 'deny',
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
    },
    async dispose(): Promise<void> {
      await inner.dispose();
    },
  };
}

export class ConcreteAdapterRegistryPort implements AdapterRegistryPort {
  readonly registry: ExternalAdapterRegistry;
  private readonly knownTemplateSignatures = new Map<string, string>();
  private readonly knownOverrideSignatures = new Map<string, string>();
  private wrappedAdapters = new WeakMap<AdapterExternalCodingAdapter, ContractExternalCodingAdapter>();

  constructor(options: ExternalAdapterRegistryOptions = {}) {
    this.registry = new ExternalAdapterRegistry(options);
  }

  private syncCustomTemplates(customTemplates?: readonly ContractCustomCliTemplate[]): void {
    if (!customTemplates) return;
    const incomingIds = new Set<string>();
    for (const tpl of customTemplates) {
      incomingIds.add(tpl.id);
      const signature = JSON.stringify([
        tpl.name,
        tpl.command,
        tpl.args,
        tpl.resumeArgs,
        tpl.env,
        tpl.updatedAt,
      ]);
      if (this.knownTemplateSignatures.get(tpl.id) !== signature) {
        this.registry.registerCustomTemplate(toAdapterCustomTemplate(tpl));
        this.knownTemplateSignatures.set(tpl.id, signature);
      }
    }
    for (const existingId of [...this.knownTemplateSignatures.keys()]) {
      if (!incomingIds.has(existingId)) {
        this.registry.removeCustomTemplate(existingId);
        this.knownTemplateSignatures.delete(existingId);
      }
    }
  }

  private syncCliOverrides(cliOverrides?: readonly ContractCliBinaryOverride[]): void {
    if (!cliOverrides) return;
    const incomingIds = new Set<string>();
    for (const ov of cliOverrides) {
      const cleanId = ov.agentId.trim().replace(/^@+/, '').toLowerCase();
      if (!cleanId) continue;
      incomingIds.add(cleanId);
      const signature = JSON.stringify([
        ov.executablePath ?? null,
        ov.extraArgs,
        ov.env,
        ov.updatedAt,
      ]);
      if (this.knownOverrideSignatures.get(cleanId) !== signature) {
        this.registry.setCliOverride({
          agentId: cleanId,
          executablePath: ov.executablePath,
          extraArgs: ov.extraArgs,
          env: ov.env,
          updatedAt: ov.updatedAt,
        });
        this.knownOverrideSignatures.set(cleanId, signature);
      }
    }
    for (const existingId of [...this.knownOverrideSignatures.keys()]) {
      if (!incomingIds.has(existingId)) {
        this.registry.removeCliOverride(existingId);
        this.knownOverrideSignatures.delete(existingId);
      }
    }
  }

  async probeAgents(options?: {
    forceRefresh?: boolean;
    customTemplates?: readonly ContractCustomCliTemplate[];
    cliOverrides?: readonly ContractCliBinaryOverride[];
  }): Promise<ContractDetectedCliAgent[]> {
    this.syncCustomTemplates(options?.customTemplates);
    this.syncCliOverrides(options?.cliOverrides);
    const probed = await this.registry.probeAgents(options?.forceRefresh === true);
    return [DEFAULT_BUILTIN_COORDINATOR_AGENT, ...probed.map(toContractDetectedAgent)];
  }

  getAdapter(
    agentId: string,
    customTemplates?: readonly ContractCustomCliTemplate[],
    cliOverrides?: readonly ContractCliBinaryOverride[],
  ): ContractExternalCodingAdapter | null {
    const cleanId = agentId.trim().replace(/^@+/, '');
    if (!cleanId || cleanId === 'deepstudent') {
      return null;
    }
    this.syncCustomTemplates(customTemplates);
    this.syncCliOverrides(cliOverrides);
    try {
      const inner = this.registry.getAdapter(cleanId);
      let wrapped = this.wrappedAdapters.get(inner);
      if (!wrapped) {
        wrapped = wrapConcreteAdapter(inner);
        this.wrappedAdapters.set(inner, wrapped);
      }
      return wrapped;
    } catch (error) {
      ignoreCleanupError(error);
      return null;
    }
  }

  async dispose(): Promise<void> {
    this.wrappedAdapters = new WeakMap();
    this.knownTemplateSignatures.clear();
    this.knownOverrideSignatures.clear();
    await this.registry.dispose();
  }
}

export class ConcreteCheckpointPort implements CheckpointPort {
  readonly engine: CheckpointEngine;

  constructor(options?: { storageDir?: string; maxFileBytes?: number; engine?: CheckpointEngine }) {
    this.engine =
      options?.engine ??
      new CheckpointEngine({
        storageDir: options?.storageDir,
        maxFileBytes: options?.maxFileBytes,
      });
  }

  async captureCheckpoint(input: {
    chatSessionId: string;
    threadId: string;
    agentId: string;
    rosterName?: string | null;
    rootPath: string;
    turnSeq: number;
    kind: 'before' | 'after';
  }): Promise<MeshCheckpointRecord> {
    const captured = await this.engine.capture({
      rootPath: input.rootPath,
      chatSessionId: input.chatSessionId,
      threadId: input.threadId,
      agentId: input.agentId,
      turnSeq: input.turnSeq,
      kind: input.kind,
    });
    return {
      checkpointId: captured.checkpointId,
      chatSessionId: captured.chatSessionId,
      threadId: captured.threadId,
      agentId: captured.agentId,
      rosterName: input.rosterName ?? null,
      rootPath: captured.rootPath,
      turnSeq: captured.turnSeq,
      kind: captured.kind,
      ref: captured.ref,
      isGit: captured.backend === 'git',
      postTurnHashes: { ...captured.fileHashes },
      createdAt: new Date(captured.createdAt).toISOString(),
    };
  }

  async diffCheckpoints(
    rootPath: string,
    fromRef: string,
    toRef: string,
    attributedAgentId?: string,
  ): Promise<MeshDiffReport> {
    const diff = await this.engine.diff(rootPath, fromRef, toRef);
    return {
      fromRef: diff.fromRef,
      toRef: diff.toRef,
      totalAdditions: diff.totalAdditions,
      totalDeletions: diff.totalDeletions,
      files: diff.files.map((file) => ({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch,
        attributedAgentId: file.attributedAgentId ?? attributedAgentId,
      })),
    };
  }

  async diffWorkingTreeFromCheckpoint(
    rootPath: string,
    fromRef: string,
    attributedAgentId?: string,
  ): Promise<MeshDiffReport> {
    const diff = await this.engine.diffWorkingTree(rootPath, fromRef);
    return {
      fromRef: diff.fromRef,
      toRef: diff.toRef,
      totalAdditions: diff.totalAdditions,
      totalDeletions: diff.totalDeletions,
      files: diff.files.map((file) => ({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch,
        attributedAgentId: file.attributedAgentId ?? attributedAgentId,
      })),
    };
  }

  async revertToCheckpoint(
    rootPath: string,
    targetCheckpoint: MeshCheckpointRecord | string,
    options?: {
      paths?: string[];
      postTurnHashes?: Record<string, string>;
      forceOverwriteUserEdits?: boolean;
    },
  ): Promise<RevertCheckpointResult> {
    const targetRef =
      typeof targetCheckpoint === 'string' ? targetCheckpoint : targetCheckpoint.ref;
    const reverted = await this.engine.revert(rootPath, targetRef, {
      paths: options?.paths,
      postTurnHashes: options?.postTurnHashes,
      forceOverwriteUserEdits: options?.forceOverwriteUserEdits,
    });
    const combinedReverted = [
      ...new Set([...reverted.revertedPaths, ...reverted.deletedPaths]),
    ];
    return {
      revertedPaths: combinedReverted,
      skippedUserModifiedPaths: reverted.skippedUserModifiedPaths,
    };
  }
}

function toContractActiveLease(lease: TableActiveFileLease): ContractActiveFileLease {
  return {
    leaseId: lease.leaseId,
    rootPath: lease.canonicalRoot,
    pattern: lease.pattern,
    holderAgentId: lease.holderAgentId,
    holderThreadId: lease.threadId,
    heldSince: new Date(lease.heldSince).toISOString(),
    expiresAtMs: lease.expiresAt,
  };
}

export class ConcreteFileLeasePort implements FileLeasePort {
  readonly table: FileLeaseTable;

  constructor(options?: { defaultTtlMs?: number; table?: FileLeaseTable }) {
    this.table = options?.table ?? new FileLeaseTable({ defaultTtlMs: options?.defaultTtlMs });
  }

  async acquireLease(input: {
    rootPath: string;
    patterns: string[];
    holderAgentId: string;
    threadId: string;
    ttlMs?: number;
    waitMs?: number;
  }): Promise<AcquireFileLeaseResult> {
    const res = await this.table.acquireLease({
      rootPath: input.rootPath,
      patterns: input.patterns,
      holderAgentId: input.holderAgentId,
      threadId: input.threadId,
      ttlMs: input.ttlMs,
      waitMs: input.waitMs,
    });
    if (res.granted) {
      return {
        granted: true,
        leases: res.leases.map(toContractActiveLease),
      };
    }
    return {
      granted: false,
      conflict: {
        holderAgentId: res.conflict.holderAgentId,
        holderThreadId: res.conflict.holderThreadId,
        conflictingPattern: res.conflict.conflictingPattern,
        heldSince: new Date(res.conflict.heldSince).toISOString(),
      },
    };
  }

  releaseAgentLeases(holderAgentId: string, threadId?: string, paths?: string[]): number {
    return this.table.releaseAgentLeases(
      holderAgentId,
      threadId,
      paths && paths.length > 0 ? { patterns: paths } : undefined,
    );
  }

  listActiveLeases(rootPath?: string): ContractActiveFileLease[] {
    return this.table.listActiveLeases(rootPath).map(toContractActiveLease);
  }

  dispose(): void {
    this.table.dispose();
  }
}

export class ConcreteMeshBridgeServerPort implements MeshBridgeServerPort {
  readonly server: MeshMcpServer;
  private boundCallbacks: ContractMeshBridgeHostCallbacks | null = null;
  private cliShim: CreatedCliShim | null = null;
  private mcpConfigTempDir: string | null = null;
  private startPromise: Promise<{
    port: number;
    baseUrl: string;
    mcpUrl: string;
    apiCallUrl: string;
    shimBinDir: string;
  }> | null = null;
  private readonly threadTempFiles = new Map<string, string[]>();
  private readonly nodeExecPath: string | undefined;
  private disposed = false;

  constructor(options?: { fileLeaseTable?: FileLeaseTable; nodeExecPath?: string }) {
    this.nodeExecPath = options?.nodeExecPath;
    const serverCallbacks: ServerMeshBridgeCallbacks = {
      postBoard: (scope, input) => this.requireCallbacks().meshPostBoard(scope, input),
      readBoard: (scope, input) => this.requireCallbacks().meshReadBoard(scope, input),
      askPeer: (scope, input) => this.requireCallbacks().meshAskPeer(scope, input),
      handoff: (scope, input) => this.requireCallbacks().meshHandoff(scope, input),
      claimFiles: (scope, input) => this.requireCallbacks().meshClaimFiles(scope, input),
      releaseFiles: (scope, input) => this.requireCallbacks().meshReleaseFiles(scope, input),
      park: (scope, input) => this.requireCallbacks().meshPark(scope, input),
      readStudyContext: (scope, input) => this.requireCallbacks().studyReadContext(scope, input),
    };
    this.server = new MeshMcpServer({
      callbacks: serverCallbacks,
      fileLeaseTable: options?.fileLeaseTable,
    });
  }

  private requireCallbacks(): ContractMeshBridgeHostCallbacks {
    if (!this.boundCallbacks) {
      throw new Error('MeshBridgeHostCallbacks have not been bound to ConcreteMeshBridgeServerPort');
    }
    return this.boundCallbacks;
  }

  bindCallbacks(callbacks: ContractMeshBridgeHostCallbacks): void {
    this.boundCallbacks = callbacks;
  }

  get isListening(): boolean {
    return this.server.isListening;
  }

  get shimBinDir(): string | null {
    return this.cliShim?.binDir ?? null;
  }

  async start(): Promise<{
    port: number;
    baseUrl: string;
    mcpUrl: string;
    apiCallUrl: string;
    shimBinDir: string;
  }> {
    if (this.disposed) {
      throw new Error('ConcreteMeshBridgeServerPort has already been disposed');
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = (async () => {
      const listening = await this.server.start();
      if (!this.cliShim) {
        this.cliShim = await createCliShim({
          ...(this.nodeExecPath ? { nodeExecPath: this.nodeExecPath } : {}),
        });
      }
      if (!this.mcpConfigTempDir) {
        this.mcpConfigTempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dstu-mesh-mcp-cfg-'));
      }
      return {
        ...listening,
        shimBinDir: this.cliShim.binDir,
      };
    })();

    try {
      return await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  async issueAgentSession(scope: MeshBridgeTokenScope): Promise<McpInjectionSpec> {
    const started = await this.start();
    const token = this.server.issueAgentToken(scope);
    const injection = buildMcpInjectionConfig(
      scope.agentId,
      started.baseUrl,
      token,
      this.mcpConfigTempDir!,
    );

    if (injection.configFilePath) {
      const list = this.threadTempFiles.get(scope.threadId) ?? [];
      list.push(injection.configFilePath);
      this.threadTempFiles.set(scope.threadId, list);
    }

    const shimEnv = buildCliShimEnv({
      shimBinDir: started.shimBinDir,
      endpointUrl: started.baseUrl,
      token,
    });

    const envVars: Record<string, string> = {
      ...injection.envVars,
      DSTU_MESH_URL: started.baseUrl,
      DSTU_MESH_MCP_URL: started.mcpUrl,
      DSTU_MESH_API_URL: started.apiCallUrl,
      DSTU_MESH_TOKEN: token,
      ...(shimEnv.PATH ? { PATH: shimEnv.PATH } : {}),
      ...(injection.cliArgs.length > 0
        ? { DSTU_MESH_CLI_ARGS_JSON: JSON.stringify(injection.cliArgs) }
        : {}),
    };

    return {
      httpUrl: started.mcpUrl,
      bearerToken: token,
      shimBinDir: started.shimBinDir,
      envVars,
    };
  }

  async revokeAgentSession(threadId: string): Promise<void> {
    this.server.revokeThreadTokens(threadId);
    const files = this.threadTempFiles.get(threadId);
    if (files) {
      this.threadTempFiles.delete(threadId);
      await Promise.all(
        files.map((filePath) => fsp.rm(filePath, { force: true }).catch(ignoreCleanupError)),
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.startPromise = null;

    if (this.cliShim) {
      const shimDir = this.cliShim.binDir;
      this.cliShim = null;
      try {
        fs.rmSync(shimDir, { recursive: true, force: true });
      } catch (error) {
        ignoreCleanupError(error);
      }
    }
    if (this.mcpConfigTempDir) {
      const cfgDir = this.mcpConfigTempDir;
      this.mcpConfigTempDir = null;
      try {
        fs.rmSync(cfgDir, { recursive: true, force: true });
      } catch (error) {
        ignoreCleanupError(error);
      }
    }
    this.threadTempFiles.clear();

    await this.server.stop();
  }
}

export interface CreateConcreteMeshPortsOptions {
  appDataDir?: string;
  inMemoryDb?: boolean;
  adapterRegistryOptions?: ExternalAdapterRegistryOptions;
  nodeExecPath?: string;
}

export function createConcreteMeshPorts(options: CreateConcreteMeshPortsOptions = {}): {
  adapters: ConcreteAdapterRegistryPort;
  checkpoints: ConcreteCheckpointPort;
  fileLeases: ConcreteFileLeasePort;
  bridgeServer: ConcreteMeshBridgeServerPort;
} {
  const storageDir =
    options.appDataDir && options.appDataDir !== ':memory:' && !options.inMemoryDb
      ? path.join(options.appDataDir, 'agent-mesh-checkpoints')
      : undefined;
  const fileLeases = new ConcreteFileLeasePort();
  const checkpoints = new ConcreteCheckpointPort({ storageDir });
  const adapters = new ConcreteAdapterRegistryPort(options.adapterRegistryOptions);
  const bridgeServer = new ConcreteMeshBridgeServerPort({
    fileLeaseTable: fileLeases.table,
    nodeExecPath: options.nodeExecPath,
  });
  return {
    adapters,
    checkpoints,
    fileLeases,
    bridgeServer,
  };
}

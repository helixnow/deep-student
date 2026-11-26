// OpenAI Codex CLI protocol adapter.
// Primary transport: `codex app-server` JSON-RPC 2.0 over stdio (`initialize`, `thread/start`,
// `thread/resume`, `turn/start`, native `turn/steer`, `turn/interrupt`, server->client approvals,
// and `-c mcp_servers.dstu_mesh=...` runtime overrides without touching `~/.codex/config.toml`).
// Fallback transport: `codex exec --json` when `app-server` subcommand is unavailable.

import {
  isApprovalAllowed,
  normalizeApprovalResponse,
  type AdapterCapabilities,
  type ApprovalDecisionKind,
  type ApprovalResponseInput,
  type ExternalCodingAdapter,
  type ExternalTurnStartInput,
  type McpInjectionSpec,
  type NormalizedRuntimeEvent,
  type SteerResult,
} from '../adapter-types.ts';
import { DRIVER_DEFAULT_CAPABILITIES } from '../probe.ts';
import {
  buildInjectedSubprocessEnv,
  ProcessTreeSupervisor,
  type ManagedProcessTree,
} from '../process-tree.ts';
import { QuiescenceTracker } from '../quiescence.ts';
import {
  asNumber,
  asRecord,
  asString,
  attachLineReader,
  AsyncEventQueue,
  extractApprovalMetadata,
  isTerminalRuntimeEvent,
  tryParseJsonObject,
} from './base.ts';

export interface CodexAdapterOptions {
  readonly command?: string;
  readonly processSupervisor?: ProcessTreeSupervisor;
  readonly preferExecFallback?: boolean;
  readonly initializeTimeoutMs?: number;
  readonly safetyIdleTimeoutMs?: number;
  readonly extraArgs?: readonly string[];
  readonly now?: () => number;
}

interface PendingRpcCall {
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingCodexApproval {
  readonly rpcId: string | number;
  readonly method: string;
}

interface ActiveCodexTurn {
  readonly threadId: string;
  readonly queue: AsyncEventQueue<NormalizedRuntimeEvent>;
  readonly quiescence: QuiescenceTracker;
  readonly pendingRpc: Map<string, PendingRpcCall>;
  readonly pendingApprovals: Map<string, PendingCodexApproval>;
  readonly streamedItemIds: Set<string>;
  mode: 'app-server' | 'exec-json';
  tree: ManagedProcessTree | null;
  codexThreadId: string | undefined;
  activeTurnId: string | undefined;
  nextRpcId: number;
  interrupted: boolean;
}

class AppServerUnavailableError extends Error {
  override name = 'AppServerUnavailableError';
}

function buildCodexMcpConfigArgs(mcp: McpInjectionSpec | undefined): string[] {
  if (!mcp) return [];
  return [
    '-c',
    `mcp_servers.dstu_mesh.url=${JSON.stringify(mcp.httpUrl)}`,
    '-c',
    'mcp_servers.dstu_mesh.bearer_token_env_var="DSTU_MESH_TOKEN"',
  ];
}

export class CodexAdapter implements ExternalCodingAdapter {
  readonly driver = 'codex' as const;
  readonly capabilities: AdapterCapabilities = DRIVER_DEFAULT_CAPABILITIES.codex;

  private readonly command: string;
  private readonly supervisor: ProcessTreeSupervisor;
  private readonly ownsSupervisor: boolean;
  private readonly preferExecFallback: boolean;
  private readonly initializeTimeoutMs: number;
  private readonly safetyIdleTimeoutMs: number | undefined;
  private readonly extraArgs: readonly string[];
  private readonly now: () => number;
  private readonly activeTurns = new Map<string, ActiveCodexTurn>();

  constructor(options: CodexAdapterOptions = {}) {
    this.command = options.command ?? 'codex';
    this.ownsSupervisor = !options.processSupervisor;
    this.supervisor =
      options.processSupervisor ?? new ProcessTreeSupervisor({ registerExitHook: true });
    this.preferExecFallback = options.preferExecFallback ?? false;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? 5_000;
    this.safetyIdleTimeoutMs = options.safetyIdleTimeoutMs;
    this.extraArgs = options.extraArgs ?? [];
    this.now = options.now ?? Date.now;
  }

  startOrResumeTurn(input: ExternalTurnStartInput): AsyncIterable<NormalizedRuntimeEvent> {
    const queue = new AsyncEventQueue<NormalizedRuntimeEvent>((event) => {
      input.onEvent?.(event);
      if (isTerminalRuntimeEvent(event)) {
        const active = this.activeTurns.get(input.threadId);
        if (active?.tree?.isRunning()) {
          void active.tree.terminate({ sigintGraceMs: 150, sigtermGraceMs: 250 });
        }
        queue.close();
      }
    });

    const quiescence = new QuiescenceTracker({
      threadId: input.threadId,
      safetyIdleTimeoutMs: this.safetyIdleTimeoutMs,
      now: this.now,
      onEvent: (event) => {
        queue.push(event);
      },
    });
    quiescence.markTurnStarted();

    const turn: ActiveCodexTurn = {
      threadId: input.threadId,
      queue,
      quiescence,
      pendingRpc: new Map(),
      pendingApprovals: new Map(),
      streamedItemIds: new Set(),
      mode: this.preferExecFallback ? 'exec-json' : 'app-server',
      tree: null,
      codexThreadId: input.resumeSessionId,
      activeTurnId: undefined,
      nextRpcId: 1,
      interrupted: false,
    };

    if (input.resumeSessionId) {
      quiescence.setExternalSessionId(input.resumeSessionId);
    }

    this.activeTurns.set(input.threadId, turn);
    void this.runTurnWithFallback(turn, input);
    return queue;
  }

  async steer(threadId: string, message: string): Promise<SteerResult> {
    const turn = this.activeTurns.get(threadId);
    if (!turn || !turn.tree || !turn.tree.isRunning()) {
      return {
        accepted: false,
        mode: 'not_running',
        reason: 'No active Codex turn for thread',
      };
    }

    if (turn.mode !== 'app-server' || !turn.codexThreadId) {
      return {
        accepted: false,
        mode: 'unsupported',
        reason: 'Codex exec fallback mode does not support mid-turn steer',
      };
    }

    try {
      await this.sendRpcRequest(turn, 'turn/steer', {
        threadId: turn.codexThreadId,
        expectedTurnId: turn.activeTurnId ?? null,
        turnId: turn.activeTurnId ?? null,
        input: [{ type: 'text', text: message }],
      });
      return { accepted: true, mode: 'native_steer' };
    } catch (err) {
      return {
        accepted: false,
        mode: 'not_running',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async interrupt(threadId: string): Promise<void> {
    const turn = this.activeTurns.get(threadId);
    if (!turn) return;
    turn.interrupted = true;

    if (turn.mode === 'app-server' && turn.tree?.isRunning() && turn.codexThreadId) {
      try {
        await Promise.race([
          this.sendRpcRequest(
            turn,
            'turn/interrupt',
            {
              threadId: turn.codexThreadId,
              turnId: turn.activeTurnId ?? null,
            },
            400,
          ),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 400);
            t.unref?.();
          }),
        ]);
      } catch (err) {
        if (err instanceof Error) {
          // Proceed directly to process-tree cascade termination.
        }
      }
    }

    this.rejectAllPendingRpc(turn, new Error('Turn interrupted'));
    turn.pendingApprovals.clear();
    if (turn.tree) {
      await turn.tree.terminate();
    }
    turn.quiescence.markInterrupted('Interrupted by caller');
    this.activeTurns.delete(threadId);
  }

  async respondApproval(
    threadId: string,
    requestId: string,
    response: ApprovalResponseInput | ApprovalDecisionKind,
  ): Promise<boolean> {
    const turn = this.activeTurns.get(threadId);
    if (!turn || !turn.tree || !turn.tree.isRunning()) return false;

    const pending = turn.pendingApprovals.get(requestId);
    if (!pending) return false;
    turn.pendingApprovals.delete(requestId);

    const normalized = normalizeApprovalResponse(response);
    const allowed = isApprovalAllowed(normalized.decision);

    const codexDecision =
      normalized.decision === 'allow_for_session'
        ? 'acceptForSession'
        : allowed
          ? 'accept'
          : 'decline';

    const replyFrame = JSON.stringify({
      jsonrpc: '2.0',
      id: pending.rpcId,
      result: {
        decision: codexDecision,
        approved: allowed,
        ...(normalized.reason ? { reason: normalized.reason } : {}),
      },
    });

    return turn.tree.writeStdin(`${replyFrame}\n`);
  }

  async dispose(): Promise<void> {
    const turns = [...this.activeTurns.values()];
    await Promise.all(
      turns.map(async (turn) => {
        turn.interrupted = true;
        this.rejectAllPendingRpc(turn, new Error('Adapter disposed'));
        turn.quiescence.dispose();
        turn.queue.close();
        if (turn.tree) {
          await turn.tree.terminate();
        }
      }),
    );
    this.activeTurns.clear();
    if (this.ownsSupervisor) {
      await this.supervisor.dispose();
    }
  }

  private async runTurnWithFallback(
    turn: ActiveCodexTurn,
    input: ExternalTurnStartInput,
  ): Promise<void> {
    try {
      if (!this.preferExecFallback) {
        try {
          await this.runAppServerTurn(turn, input);
          return;
        } catch (err) {
          if (!(err instanceof AppServerUnavailableError) || turn.interrupted) {
            throw err;
          }
          turn.mode = 'exec-json';
        }
      }
      await this.runExecJsonTurn(turn, input);
    } catch (err) {
      if (!turn.interrupted) {
        const message = err instanceof Error ? err.message : String(err);
        turn.quiescence.markFailed(message, 'CODEX_ERROR', true);
      }
      turn.queue.close();
    } finally {
      this.rejectAllPendingRpc(turn, new Error('Turn ended'));
      this.activeTurns.delete(turn.threadId);
      turn.quiescence.dispose();
    }
  }

  private async runAppServerTurn(
    turn: ActiveCodexTurn,
    input: ExternalTurnStartInput,
  ): Promise<void> {
    const mcpArgs = buildCodexMcpConfigArgs(input.mcp);
    const args = [...mcpArgs, 'app-server', ...this.extraArgs];
    const env = buildInjectedSubprocessEnv({
      baseEnv: process.env,
      extraEnv: input.env,
      mcp: input.mcp,
    });

    const tree = this.supervisor.spawn({
      command: this.command,
      args,
      cwd: input.cwd,
      env,
      signal: input.signal,
    });
    turn.tree = tree;

    let stderrBuf = '';
    let initialized = false;

    const stdoutReader = attachLineReader(tree.stdout, (line) => {
      this.handleAppServerLine(turn, line);
    });

    attachLineReader(tree.stderr, (line) => {
      if (stderrBuf.length < 4_096 && line.trim().length > 0) {
        stderrBuf += (stderrBuf ? '\n' : '') + line.trim();
      }
    });

    const earlyExitPromise = tree.exited.then((outcome) => {
      stdoutReader.flush();
      if (!initialized) {
        const lowerErr = stderrBuf.toLowerCase();
        const isMissingSubcommand =
          lowerErr.includes('unrecognized subcommand') ||
          lowerErr.includes('unknown command') ||
          lowerErr.includes('invalid subcommand') ||
          lowerErr.includes('app-server') ||
          (outcome.exitCode !== null && outcome.exitCode !== 0 && !outcome.spawnError);
        if (isMissingSubcommand) {
          this.rejectAllPendingRpc(
            turn,
            new AppServerUnavailableError(stderrBuf || 'codex app-server unavailable'),
          );
        } else if (outcome.spawnError) {
          this.rejectAllPendingRpc(turn, outcome.spawnError);
        } else {
          this.rejectAllPendingRpc(
            turn,
            new Error(stderrBuf || `codex app-server exited (${outcome.exitCode})`),
          );
        }
      }
      return outcome;
    });

    if (input.signal) {
      if (input.signal.aborted) {
        await this.interrupt(input.threadId);
        return;
      }
      input.signal.addEventListener(
        'abort',
        () => {
          void this.interrupt(input.threadId);
        },
        { once: true },
      );
    }

    await this.sendRpcRequest(
      turn,
      'initialize',
      {
        clientInfo: {
          name: 'deepstudent-agent-mesh',
          version: '1.0.0',
        },
        capabilities: {},
      },
      this.initializeTimeoutMs,
    );
    initialized = true;

    await this.sendRpcNotification(turn, 'initialized', {});

    const threadResponse = input.resumeSessionId
      ? await this.sendRpcRequest(turn, 'thread/resume', {
          threadId: input.resumeSessionId,
          cwd: input.cwd,
          ...(input.model ? { model: input.model } : {}),
        })
      : await this.sendRpcRequest(turn, 'thread/start', {
          cwd: input.cwd,
          ...(input.model ? { model: input.model } : {}),
        });

    const threadObj = asRecord(threadResponse.thread);
    const resolvedThreadId =
      asString(threadObj?.id) ??
      asString(threadResponse.threadId) ??
      input.resumeSessionId ??
      `codex_${this.now()}`;

    this.bindSession(turn, resolvedThreadId);

    const turnStartResponse = await this.sendRpcRequest(turn, 'turn/start', {
      threadId: resolvedThreadId,
      cwd: input.cwd,
      input: [{ type: 'text', text: input.prompt }],
    });

    const turnObj = asRecord(turnStartResponse.turn);
    turn.activeTurnId = asString(turnObj?.id) ?? asString(turnStartResponse.turnId);

    const outcome = await earlyExitPromise;
    if (turn.interrupted) {
      turn.quiescence.markInterrupted('Turn interrupted');
      return;
    }

    if (outcome.spawnError) {
      throw outcome.spawnError;
    }

    if (turn.quiescence.phase === 'running') {
      if (outcome.exitCode !== 0 && outcome.exitCode !== null) {
        throw new Error(stderrBuf || `codex app-server exited with code ${outcome.exitCode}`);
      }
      turn.quiescence.settleMainTurn({
        externalSessionId: turn.codexThreadId,
        stopReason: 'eof',
      });
    } else if (turn.quiescence.phase === 'waiting_children') {
      for (const childId of [...turn.quiescence.activeChildSubagents.keys()]) {
        turn.quiescence.completeSubagent({ id: childId, status: 'completed' });
      }
      for (const taskId of [...turn.quiescence.activeBgTasks]) {
        turn.quiescence.completeBgTask({ taskId, exitCode: outcome.exitCode });
      }
    }
  }

  private async runExecJsonTurn(
    turn: ActiveCodexTurn,
    input: ExternalTurnStartInput,
  ): Promise<void> {
    const mcpArgs = buildCodexMcpConfigArgs(input.mcp);
    const args: string[] = [...mcpArgs, 'exec', '--json'];
    if (input.model) {
      args.push('--model', input.model);
    }
    args.push(...this.extraArgs);

    if (input.resumeSessionId) {
      args.push('resume', input.resumeSessionId, input.prompt);
    } else {
      args.push(input.prompt);
    }

    const env = buildInjectedSubprocessEnv({
      baseEnv: process.env,
      extraEnv: input.env,
      mcp: input.mcp,
    });

    const tree = this.supervisor.spawn({
      command: this.command,
      args,
      cwd: input.cwd,
      env,
      signal: input.signal,
    });
    turn.tree = tree;
    tree.endStdin();

    let stderrBuf = '';
    const stdoutReader = attachLineReader(tree.stdout, (line) => {
      this.handleExecJsonLine(turn, line);
    });
    attachLineReader(tree.stderr, (line) => {
      if (stderrBuf.length < 4_096 && line.trim().length > 0) {
        stderrBuf += (stderrBuf ? '\n' : '') + line.trim();
      }
    });

    const outcome = await tree.exited;
    stdoutReader.flush();

    if (turn.interrupted || input.signal?.aborted) {
      turn.quiescence.markInterrupted('Turn interrupted');
      return;
    }

    if (outcome.spawnError) {
      throw outcome.spawnError;
    }

    if (outcome.exitCode !== 0 && outcome.exitCode !== null && turn.quiescence.phase !== 'quiescent') {
      throw new Error(stderrBuf || `codex exec exited with code ${outcome.exitCode}`);
    }

    if (turn.quiescence.phase === 'running') {
      turn.quiescence.settleMainTurn({
        externalSessionId: turn.codexThreadId,
        stopReason: 'completed',
      });
    }
  }

  private bindSession(turn: ActiveCodexTurn, sessionId: string | undefined): void {
    if (!sessionId) return;
    const isChanged = turn.codexThreadId !== sessionId;
    turn.codexThreadId = sessionId;
    turn.quiescence.setExternalSessionId(sessionId);
    if (isChanged || sessionId) {
      turn.queue.push({
        type: 'session_bound',
        threadId: turn.threadId,
        externalSessionId: sessionId,
        timestamp: this.now(),
      });
    }
  }

  private handleAppServerLine(turn: ActiveCodexTurn, rawLine: string): void {
    const msg = tryParseJsonObject(rawLine);
    if (!msg) return;

    const method = asString(msg.method);
    const hasId = typeof msg.id === 'number' || typeof msg.id === 'string';

    // JSON-RPC Response to a client->server request
    if (hasId && !method) {
      const idKey = String(msg.id);
      const pending = turn.pendingRpc.get(idKey);
      if (!pending) return;
      turn.pendingRpc.delete(idKey);
      clearTimeout(pending.timer);

      const errObj = asRecord(msg.error);
      if (errObj) {
        pending.reject(
          new Error(asString(errObj.message) ?? `Codex RPC error (${String(errObj.code ?? '')})`),
        );
      } else {
        pending.resolve(asRecord(msg.result) ?? {});
      }
      return;
    }

    // Server -> Client JSON-RPC Request (e.g. tool/command/patch approval)
    if (hasId && method) {
      const rpcId = msg.id as string | number;
      const params = asRecord(msg.params) ?? {};
      this.handleServerApprovalRequest(turn, rpcId, method, params);
      return;
    }

    // Server -> Client Notification
    if (method) {
      const params = asRecord(msg.params) ?? {};
      this.handleAppServerNotification(turn, method, params);
    }
  }

  private handleServerApprovalRequest(
    turn: ActiveCodexTurn,
    rpcId: string | number,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const requestId = String(rpcId);
    turn.pendingApprovals.set(requestId, { rpcId, method });

    const item = asRecord(params.item);
    const mergedInput: Record<string, unknown> = {
      ...(item ?? {}),
      ...params,
    };
    const toolName =
      asString(params.toolName) ??
      asString(item?.type) ??
      (method.toLowerCase().includes('file') || method.toLowerCase().includes('patch')
        ? 'FileChange'
        : 'CommandExecution');

    const { targetPath, command } = extractApprovalMetadata(toolName, mergedInput);

    turn.queue.push({
      type: 'approval_requested',
      threadId: turn.threadId,
      requestId,
      toolName,
      targetPath,
      command,
      reason: asString(params.reason),
      rawInput: mergedInput,
      timestamp: this.now(),
    });
  }

  private handleAppServerNotification(
    turn: ActiveCodexTurn,
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method === 'thread/started') {
      const thread = asRecord(params.thread);
      const id = asString(thread?.id) ?? asString(params.threadId);
      if (id && id !== turn.codexThreadId) {
        this.bindSession(turn, id);
      }
      return;
    }

    if (method === 'turn/started') {
      const turnObj = asRecord(params.turn);
      const turnId = asString(turnObj?.id) ?? asString(params.turnId);
      if (turnId) {
        turn.activeTurnId = turnId;
      }
      return;
    }

    if (method === 'item/agentMessage/delta' || method === 'codex/event/agent_message_delta') {
      const delta = asString(params.delta) ?? asString(asRecord(params.msg)?.delta);
      const itemId = asString(params.itemId) ?? asString(params.id);
      if (itemId) turn.streamedItemIds.add(itemId);
      if (delta && delta.length > 0) {
        turn.queue.push({
          type: 'assistant_delta',
          threadId: turn.threadId,
          text: delta,
          messageId: itemId,
          timestamp: this.now(),
        });
      }
      return;
    }

    if (
      method === 'item/reasoning/summaryTextDelta' ||
      method === 'item/reasoning/textDelta' ||
      method === 'codex/event/agent_reasoning_delta'
    ) {
      const delta = asString(params.delta) ?? asString(asRecord(params.msg)?.delta);
      if (delta && delta.length > 0) {
        turn.queue.push({
          type: 'thinking_delta',
          threadId: turn.threadId,
          text: delta,
          timestamp: this.now(),
        });
      }
      return;
    }

    if (method === 'item/started') {
      const item = asRecord(params.item);
      if (!item) return;
      const itemType = asString(item.type) ?? '';
      const itemId = asString(item.id) ?? `item_${this.now()}`;

      if (itemType === 'collabAgentToolCall' || itemType === 'subagent') {
        turn.quiescence.startSubagent({
          id: itemId,
          parentToolUseId: null,
          title: asString(item.prompt) ?? asString(item.title) ?? 'Codex Subagent',
          agentType: itemType,
        });
      } else if (
        itemType === 'commandExecution' ||
        itemType === 'mcpToolCall' ||
        itemType === 'fileChange'
      ) {
        turn.queue.push({
          type: 'tool_call_start',
          threadId: turn.threadId,
          toolCallId: itemId,
          toolName: asString(item.tool) ?? itemType,
          args: item,
          timestamp: this.now(),
        });
      }
      return;
    }

    if (method === 'item/completed') {
      const item = asRecord(params.item);
      if (!item) return;
      const itemType = asString(item.type) ?? '';
      const itemId = asString(item.id) ?? '';

      if (itemType === 'agentMessage') {
        const text = asString(item.text);
        if (text && text.length > 0 && (!itemId || !turn.streamedItemIds.has(itemId))) {
          turn.queue.push({
            type: 'assistant_delta',
            threadId: turn.threadId,
            text,
            messageId: itemId || undefined,
            timestamp: this.now(),
          });
        }
        return;
      }

      if (itemType === 'collabAgentToolCall' || itemType === 'subagent') {
        turn.quiescence.completeSubagent({
          id: itemId,
          status: item.status === 'failed' ? 'failed' : 'completed',
          summary: asString(item.output),
        });
        return;
      }

      if (
        itemType === 'commandExecution' ||
        itemType === 'mcpToolCall' ||
        itemType === 'fileChange'
      ) {
        turn.queue.push({
          type: 'tool_call_end',
          threadId: turn.threadId,
          toolCallId: itemId,
          toolName: asString(item.tool) ?? itemType,
          output: asString(item.aggregatedOutput) ?? asString(item.output),
          isError: item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0),
          timestamp: this.now(),
        });
      }
      return;
    }

    if (method === 'thread/tokenUsage/updated' || method === 'turn/usage') {
      const usageRoot = asRecord(params.tokenUsage) ?? params;
      const total = asRecord(usageRoot.total) ?? usageRoot;
      turn.queue.push({
        type: 'usage',
        threadId: turn.threadId,
        inputTokens: asNumber(total.inputTokens) ?? asNumber(total.input_tokens) ?? 0,
        outputTokens: asNumber(total.outputTokens) ?? asNumber(total.output_tokens) ?? 0,
        cachedInputTokens:
          asNumber(total.cachedInputTokens) ?? asNumber(total.cached_input_tokens),
        timestamp: this.now(),
      });
      return;
    }

    if (method === 'turn/completed') {
      const turnObj = asRecord(params.turn);
      const status = asString(turnObj?.status) ?? asString(params.status) ?? 'completed';
      if (status === 'interrupted') {
        turn.quiescence.markInterrupted('Codex turn interrupted');
        return;
      }
      if (status === 'failed') {
        const errRec = asRecord(turnObj?.error) ?? asRecord(params.error);
        const errMsg = asString(errRec?.message) ?? 'Codex turn failed';
        turn.quiescence.markFailed(errMsg, 'TURN_FAILED', true);
        turn.queue.close();
        return;
      }
      turn.quiescence.settleMainTurn({
        externalSessionId: turn.codexThreadId,
        stopReason: status,
      });
    }
  }

  private handleExecJsonLine(turn: ActiveCodexTurn, rawLine: string): void {
    const event = tryParseJsonObject(rawLine);
    if (!event) return;
    const eventType = asString(event.type);

    if (eventType === 'thread.started') {
      const tid = asString(event.thread_id) ?? asString(event.threadId);
      if (tid) this.bindSession(turn, tid);
      return;
    }

    if (eventType === 'item.started') {
      const item = asRecord(event.item);
      if (!item) return;
      const itemType = asString(item.type) ?? '';
      const itemId = asString(item.id) ?? `exec_item_${this.now()}`;
      if (itemType === 'command_execution' || itemType === 'mcp_tool_call' || itemType === 'file_change') {
        turn.queue.push({
          type: 'tool_call_start',
          threadId: turn.threadId,
          toolCallId: itemId,
          toolName: itemType,
          args: item,
          timestamp: this.now(),
        });
      }
      return;
    }

    if (eventType === 'item.completed') {
      const item = asRecord(event.item);
      if (!item) return;
      const itemType = asString(item.type) ?? '';
      const itemId = asString(item.id) ?? '';
      if (itemType === 'agent_message') {
        const text = asString(item.text);
        if (text) {
          turn.queue.push({
            type: 'assistant_delta',
            threadId: turn.threadId,
            text,
            messageId: itemId || undefined,
            timestamp: this.now(),
          });
        }
      } else if (itemType === 'reasoning') {
        const text = asString(item.text);
        if (text) {
          turn.queue.push({
            type: 'thinking_delta',
            threadId: turn.threadId,
            text,
            timestamp: this.now(),
          });
        }
      } else if (itemType === 'command_execution' || itemType === 'mcp_tool_call' || itemType === 'file_change') {
        turn.queue.push({
          type: 'tool_call_end',
          threadId: turn.threadId,
          toolCallId: itemId,
          toolName: itemType,
          output: asString(item.aggregated_output) ?? asString(item.output),
          isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
          timestamp: this.now(),
        });
      }
      return;
    }

    if (eventType === 'turn.completed') {
      const usage = asRecord(event.usage);
      if (usage) {
        turn.queue.push({
          type: 'usage',
          threadId: turn.threadId,
          inputTokens: asNumber(usage.input_tokens) ?? 0,
          outputTokens: asNumber(usage.output_tokens) ?? 0,
          cachedInputTokens: asNumber(usage.cached_input_tokens),
          timestamp: this.now(),
        });
      }
      turn.quiescence.settleMainTurn({
        externalSessionId: turn.codexThreadId,
        stopReason: 'completed',
      });
      return;
    }

    if (eventType === 'turn.failed' || eventType === 'error') {
      const errRec = asRecord(event.error);
      const errMsg = asString(errRec?.message) ?? asString(event.message) ?? 'Codex exec turn failed';
      turn.quiescence.markFailed(errMsg, 'EXEC_TURN_FAILED', true);
      turn.queue.close();
    }
  }

  private async sendRpcNotification(
    turn: ActiveCodexTurn,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (!turn.tree) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    await turn.tree.writeStdin(`${payload}\n`);
  }

  private sendRpcRequest(
    turn: ActiveCodexTurn,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    const tree = turn.tree;
    if (!tree || !tree.isRunning()) {
      return Promise.reject(new Error(`Codex process is not running for RPC ${method}`));
    }

    const id = turn.nextRpcId;
    turn.nextRpcId += 1;
    const idKey = String(id);

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        turn.pendingRpc.delete(idKey);
        reject(new Error(`Timed out waiting for Codex RPC response to ${method}`));
      }, timeoutMs);
      timer.unref?.();

      turn.pendingRpc.set(idKey, { resolve, reject, timer });

      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      void tree.writeStdin(`${payload}\n`).then((ok) => {
        if (!ok) {
          const pending = turn.pendingRpc.get(idKey);
          if (pending) {
            turn.pendingRpc.delete(idKey);
            clearTimeout(pending.timer);
            pending.reject(new Error(`Failed to write Codex RPC ${method} to stdin`));
          }
        }
      });
    });
  }

  private rejectAllPendingRpc(turn: ActiveCodexTurn, error: Error): void {
    for (const [key, pending] of turn.pendingRpc) {
      clearTimeout(pending.timer);
      turn.pendingRpc.delete(key);
      pending.reject(error);
    }
  }
}

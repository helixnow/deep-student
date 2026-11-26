// Pi Coding Agent protocol adapter (`pi --mode rpc`).
// Bidirectional line-delimited JSON RPC over stdio supporting streaming text/thinking deltas,
// mid-turn `steer`, `abort` interrupt, tool/extension UI approval callbacks, and session resume.

import {
  isApprovalAllowed,
  normalizeApprovalResponse,
  type AdapterCapabilities,
  type ApprovalDecisionKind,
  type ApprovalResponseInput,
  type ExternalCodingAdapter,
  type ExternalTurnStartInput,
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

export interface PiAdapterOptions {
  readonly command?: string;
  readonly processSupervisor?: ProcessTreeSupervisor;
  readonly safetyIdleTimeoutMs?: number;
  readonly extraArgs?: readonly string[];
  readonly now?: () => number;
}

interface PendingPiApproval {
  readonly requestId: string;
  readonly requestType: 'extension_ui_request' | 'tool_approval_request';
}

interface ActivePiTurn {
  readonly threadId: string;
  readonly queue: AsyncEventQueue<NormalizedRuntimeEvent>;
  readonly quiescence: QuiescenceTracker;
  readonly pendingApprovals: Map<string, PendingPiApproval>;
  tree: ManagedProcessTree | null;
  externalSessionId: string | undefined;
  nextCmdSeq: number;
  interrupted: boolean;
}

export class PiAdapter implements ExternalCodingAdapter {
  readonly driver = 'pi' as const;
  readonly capabilities: AdapterCapabilities = DRIVER_DEFAULT_CAPABILITIES.pi;

  private readonly command: string;
  private readonly supervisor: ProcessTreeSupervisor;
  private readonly ownsSupervisor: boolean;
  private readonly safetyIdleTimeoutMs: number | undefined;
  private readonly extraArgs: readonly string[];
  private readonly now: () => number;
  private readonly activeTurns = new Map<string, ActivePiTurn>();

  constructor(options: PiAdapterOptions = {}) {
    this.command = options.command ?? 'pi';
    this.ownsSupervisor = !options.processSupervisor;
    this.supervisor =
      options.processSupervisor ?? new ProcessTreeSupervisor({ registerExitHook: true });
    this.safetyIdleTimeoutMs = options.safetyIdleTimeoutMs;
    this.extraArgs = options.extraArgs ?? [];
    this.now = options.now ?? Date.now;
  }

  startOrResumeTurn(input: ExternalTurnStartInput): AsyncIterable<NormalizedRuntimeEvent> {
    const queue = new AsyncEventQueue<NormalizedRuntimeEvent>((event) => {
      input.onEvent?.(event);
      if (isTerminalRuntimeEvent(event)) {
        const active = this.activeTurns.get(input.threadId);
        active?.tree?.endStdin();
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

    const turn: ActivePiTurn = {
      threadId: input.threadId,
      queue,
      quiescence,
      pendingApprovals: new Map(),
      tree: null,
      externalSessionId: input.resumeSessionId,
      nextCmdSeq: 1,
      interrupted: false,
    };

    if (input.resumeSessionId) {
      quiescence.setExternalSessionId(input.resumeSessionId);
    }

    this.activeTurns.set(input.threadId, turn);
    void this.launchPiProcess(turn, input);
    return queue;
  }

  async steer(threadId: string, message: string): Promise<SteerResult> {
    const turn = this.activeTurns.get(threadId);
    if (!turn || !turn.tree || !turn.tree.isRunning()) {
      return {
        accepted: false,
        mode: 'not_running',
        reason: 'No active Pi RPC process for thread',
      };
    }

    const id = `steer_${turn.nextCmdSeq++}`;
    const ok = await turn.tree.writeStdin(
      `${JSON.stringify({ id, type: 'steer', message })}\n`,
    );
    if (!ok) {
      return { accepted: false, mode: 'not_running', reason: 'Pi stdin closed' };
    }
    return { accepted: true, mode: 'native_steer' };
  }

  async interrupt(threadId: string): Promise<void> {
    const turn = this.activeTurns.get(threadId);
    if (!turn) return;
    turn.interrupted = true;
    turn.pendingApprovals.clear();

    if (turn.tree?.isRunning()) {
      const id = `abort_${turn.nextCmdSeq++}`;
      await turn.tree.writeStdin(`${JSON.stringify({ id, type: 'abort' })}\n`);
    }
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
    turn.pendingApprovals.delete(requestId);

    const normalized = normalizeApprovalResponse(response);
    const allowed = isApprovalAllowed(normalized.decision);

    const responseType =
      pending?.requestType === 'tool_approval_request'
        ? 'tool_approval_response'
        : 'extension_ui_response';

    const payload = JSON.stringify({
      type: responseType,
      id: requestId,
      confirmed: allowed,
      approved: allowed,
      decision: normalized.decision,
      ...(normalized.reason ? { reason: normalized.reason } : {}),
    });

    return turn.tree.writeStdin(`${payload}\n`);
  }

  async dispose(): Promise<void> {
    const turns = [...this.activeTurns.values()];
    await Promise.all(
      turns.map(async (turn) => {
        turn.interrupted = true;
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

  private async launchPiProcess(
    turn: ActivePiTurn,
    input: ExternalTurnStartInput,
  ): Promise<void> {
    let stderrBuf = '';
    try {
      const args: string[] = ['--mode', 'rpc'];
      if (input.resumeSessionId) {
        args.push('--session', input.resumeSessionId);
      }
      if (input.model) {
        args.push('--model', input.model);
      }
      if (input.reasoningEffort) {
        args.push('--thinking', input.reasoningEffort);
      }
      args.push(...this.extraArgs);

      const mcpExtraEnv: Record<string, string> = {};
      if (input.mcp) {
        mcpExtraEnv.PI_MCP_SERVERS = JSON.stringify({
          dstu_mesh: {
            url: input.mcp.httpUrl,
            headers: { Authorization: `Bearer ${input.mcp.bearerToken}` },
          },
        });
      }

      const env = buildInjectedSubprocessEnv({
        baseEnv: process.env,
        extraEnv: {
          ...mcpExtraEnv,
          ...input.env,
        },
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

      const stdoutReader = attachLineReader(tree.stdout, (line) => {
        this.handlePiRpcLine(turn, line);
      });
      attachLineReader(tree.stderr, (line) => {
        if (stderrBuf.length < 4_096 && line.trim().length > 0) {
          stderrBuf += (stderrBuf ? '\n' : '') + line.trim();
        }
      });

      if (!input.resumeSessionId) {
        const stateCmdId = `state_${turn.nextCmdSeq++}`;
        await tree.writeStdin(`${JSON.stringify({ id: stateCmdId, type: 'get_state' })}\n`);
      }

      const promptCmdId = `prompt_${turn.nextCmdSeq++}`;
      await tree.writeStdin(
        `${JSON.stringify({ id: promptCmdId, type: 'prompt', message: input.prompt })}\n`,
      );

      const outcome = await tree.exited;
      stdoutReader.flush();

      if (turn.interrupted || input.signal?.aborted) {
        turn.quiescence.markInterrupted('Turn interrupted');
        turn.queue.close();
        return;
      }

      if (outcome.spawnError) {
        turn.quiescence.markFailed(outcome.spawnError.message, 'SPAWN_ERROR', false);
        turn.queue.close();
        return;
      }

      if (outcome.exitCode !== 0 && outcome.exitCode !== null && turn.quiescence.phase !== 'quiescent') {
        turn.quiescence.markFailed(
          stderrBuf || `Pi CLI exited with code ${outcome.exitCode}`,
          `EXIT_${outcome.exitCode}`,
          true,
        );
        turn.queue.close();
        return;
      }

      if (turn.quiescence.phase === 'running') {
        turn.quiescence.settleMainTurn({
          externalSessionId: turn.externalSessionId,
          stopReason: 'eof',
        });
      } else if (turn.quiescence.phase === 'waiting_children') {
        for (const cid of [...turn.quiescence.activeChildSubagents.keys()]) {
          turn.quiescence.completeSubagent({ id: cid, status: 'completed' });
        }
      }
      turn.queue.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      turn.quiescence.markFailed(msg, 'PI_RPC_ERROR', true);
      turn.queue.close();
    } finally {
      this.activeTurns.delete(turn.threadId);
      turn.quiescence.dispose();
    }
  }

  private bindSession(turn: ActivePiTurn, sessionId: string | undefined): void {
    if (!sessionId) return;
    if (turn.externalSessionId === sessionId) return;
    turn.externalSessionId = sessionId;
    turn.quiescence.setExternalSessionId(sessionId);
    turn.queue.push({
      type: 'session_bound',
      threadId: turn.threadId,
      externalSessionId: sessionId,
      timestamp: this.now(),
    });
  }

  private handlePiRpcLine(turn: ActivePiTurn, rawLine: string): void {
    const frame = tryParseJsonObject(rawLine);
    if (!frame) return;

    const frameType = asString(frame.type);
    const topSessionId =
      asString(frame.sessionId) ?? asString(frame.sessionFile) ?? asString(frame.session_id);
    if (topSessionId) {
      this.bindSession(turn, topSessionId);
    }

    if (frameType === 'response') {
      const data = asRecord(frame.data);
      const stateSession = asString(data?.sessionFile) ?? asString(data?.sessionId);
      if (stateSession) {
        this.bindSession(turn, stateSession);
      }
      if (frame.success === false && asString(frame.command) === 'prompt') {
        turn.quiescence.markFailed(
          asString(frame.error) ?? 'Pi prompt RPC rejected',
          'PROMPT_REJECTED',
          true,
        );
        turn.queue.close();
      }
      return;
    }

    if (frameType === 'message_update') {
      const sub = asRecord(frame.assistantMessageEvent) ?? frame;
      const subType = asString(sub.type);
      const delta = asString(sub.delta) ?? asString(sub.text);
      if (subType === 'text_delta' && delta) {
        turn.queue.push({
          type: 'assistant_delta',
          threadId: turn.threadId,
          text: delta,
          timestamp: this.now(),
        });
      } else if (subType === 'thinking_delta' && delta) {
        turn.queue.push({
          type: 'thinking_delta',
          threadId: turn.threadId,
          text: delta,
          timestamp: this.now(),
        });
      }
      return;
    }

    if (frameType === 'tool_execution_start') {
      const toolCallId = asString(frame.toolCallId) ?? asString(frame.id) ?? `pi_tool_${this.now()}`;
      const toolName = asString(frame.toolName) ?? 'tool';
      const args = asRecord(frame.args) ?? asRecord(frame.input);

      turn.queue.push({
        type: 'tool_call_start',
        threadId: turn.threadId,
        toolCallId,
        toolName,
        args: args ?? undefined,
        timestamp: this.now(),
      });

      if (toolName === 'subagent' || toolName === 'agent' || toolName === 'task') {
        turn.quiescence.startSubagent({
          id: toolCallId,
          parentToolUseId: null,
          title: asString(args?.description) ?? asString(args?.prompt) ?? 'Pi Subagent',
        });
      }
      return;
    }

    if (frameType === 'tool_execution_end') {
      const toolCallId = asString(frame.toolCallId) ?? asString(frame.id) ?? '';
      const toolName = asString(frame.toolName);
      const isError = Boolean(frame.isError);
      const resultObj = asRecord(frame.result);
      const output =
        typeof frame.result === 'string'
          ? frame.result
          : asString(resultObj?.output) ?? asString(frame.output);

      turn.queue.push({
        type: 'tool_call_end',
        threadId: turn.threadId,
        toolCallId,
        toolName,
        output,
        isError,
        timestamp: this.now(),
      });

      if (turn.quiescence.activeChildSubagents.has(toolCallId)) {
        turn.quiescence.completeSubagent({
          id: toolCallId,
          status: isError ? 'failed' : 'completed',
          summary: output,
        });
      }
      return;
    }

    if (frameType === 'extension_ui_request' || frameType === 'tool_approval_request') {
      const method = asString(frame.method);
      if (frameType === 'extension_ui_request' && method && method !== 'confirm' && method !== 'approval') {
        return;
      }
      const requestId = asString(frame.id) ?? asString(frame.requestId) ?? `pi_req_${this.now()}`;
      const toolName = asString(frame.toolName) ?? asString(frame.title) ?? 'tool_confirm';
      const rawInput = asRecord(frame.input) ?? asRecord(frame.args) ?? frame;
      const { targetPath, command } = extractApprovalMetadata(toolName, rawInput);

      turn.pendingApprovals.set(requestId, {
        requestId,
        requestType: frameType,
      });

      turn.queue.push({
        type: 'approval_requested',
        threadId: turn.threadId,
        requestId,
        toolName,
        targetPath,
        command,
        reason: asString(frame.message) ?? asString(frame.title),
        rawInput,
        timestamp: this.now(),
      });
      return;
    }

    if (frameType === 'turn_end') {
      const message = asRecord(frame.message);
      const usage = asRecord(message?.usage) ?? asRecord(frame.usage);
      if (usage) {
        const costObj = asRecord(usage.cost);
        turn.queue.push({
          type: 'usage',
          threadId: turn.threadId,
          inputTokens: asNumber(usage.input) ?? asNumber(usage.inputTokens) ?? 0,
          outputTokens: asNumber(usage.output) ?? asNumber(usage.outputTokens) ?? 0,
          cachedInputTokens: asNumber(usage.cacheRead) ?? asNumber(usage.cachedInputTokens),
          totalCostUsd: asNumber(costObj?.total) ?? asNumber(usage.totalCostUsd),
          timestamp: this.now(),
        });
      }
      return;
    }

    if (frameType === 'agent_end') {
      turn.quiescence.settleMainTurn({
        externalSessionId: turn.externalSessionId,
        stopReason: 'agent_end',
      });
      return;
    }

    if (frameType === 'error') {
      turn.quiescence.markFailed(
        asString(frame.message) ?? asString(frame.error) ?? 'Pi runtime error',
        'PI_RUNTIME_ERROR',
        true,
      );
      turn.queue.close();
    }
  }
}

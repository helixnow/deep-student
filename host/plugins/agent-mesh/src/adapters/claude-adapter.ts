// Claude Code CLI protocol adapter (`claude -p --verbose --output-format stream-json --input-format stream-json`).
// Supports bidirectional NDJSON frames over stdio: session resume/fork, ephemeral `--mcp-config`,
// nested `parent_tool_use_id` subagent quiescence, `control_request`/`can_use_tool` approvals,
// and live mid-turn user frame steering on stdin.

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
  writeEphemeralJsonFile,
} from './base.ts';

export interface ClaudeAdapterOptions {
  readonly command?: string;
  readonly processSupervisor?: ProcessTreeSupervisor;
  readonly safetyIdleTimeoutMs?: number;
  readonly enablePermissionToolStdio?: boolean;
  readonly extraArgs?: readonly string[];
  readonly now?: () => number;
}

interface PendingClaudeApproval {
  readonly requestId: string;
  readonly toolName: string;
  readonly originalInput: Record<string, unknown>;
}

interface ActiveClaudeTurn {
  readonly threadId: string;
  readonly queue: AsyncEventQueue<NormalizedRuntimeEvent>;
  readonly quiescence: QuiescenceTracker;
  readonly pendingApprovals: Map<string, PendingClaudeApproval>;
  readonly taskIdToSubagentId: Map<string, string>;
  readonly streamedMessageBlocks: Set<string>;
  tree: ManagedProcessTree | null;
  externalSessionId: string | undefined;
  interrupted: boolean;
  cleanupMcpFile: (() => Promise<void>) | null;
}

const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task', 'dispatch_agent', 'Subagent']);

function isSubagentToolName(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name);
}

function extractSubagentTitle(
  toolName: string,
  input: Readonly<Record<string, unknown>> | null,
): string {
  if (!input) return toolName;
  const desc = asString(input.description) ?? asString(input.title) ?? asString(input.name);
  if (desc && desc.trim().length > 0) return desc.trim();
  const prompt = asString(input.prompt);
  if (prompt && prompt.trim().length > 0) {
    const oneLine = prompt.trim().replace(/\s+/gu, ' ');
    return oneLine.length > 64 ? `${oneLine.slice(0, 61)}...` : oneLine;
  }
  return toolName;
}

function extractToolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const rec = asRecord(item);
      if (rec && rec.type === 'text' && typeof rec.text === 'string') {
        parts.push(rec.text);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return undefined;
}

export class ClaudeAdapter implements ExternalCodingAdapter {
  readonly driver = 'claude' as const;
  readonly capabilities: AdapterCapabilities = DRIVER_DEFAULT_CAPABILITIES.claude;

  private readonly command: string;
  private readonly supervisor: ProcessTreeSupervisor;
  private readonly ownsSupervisor: boolean;
  private readonly safetyIdleTimeoutMs: number | undefined;
  private readonly enablePermissionToolStdio: boolean;
  private readonly extraArgs: readonly string[];
  private readonly now: () => number;
  private readonly activeTurns = new Map<string, ActiveClaudeTurn>();

  constructor(options: ClaudeAdapterOptions = {}) {
    this.command = options.command ?? 'claude';
    this.ownsSupervisor = !options.processSupervisor;
    this.supervisor =
      options.processSupervisor ?? new ProcessTreeSupervisor({ registerExitHook: true });
    this.safetyIdleTimeoutMs = options.safetyIdleTimeoutMs;
    this.enablePermissionToolStdio = options.enablePermissionToolStdio ?? true;
    this.extraArgs = options.extraArgs ?? [];
    this.now = options.now ?? Date.now;
  }

  startOrResumeTurn(input: ExternalTurnStartInput): AsyncIterable<NormalizedRuntimeEvent> {
    const queue = new AsyncEventQueue<NormalizedRuntimeEvent>((event) => {
      input.onEvent?.(event);
      if (isTerminalRuntimeEvent(event)) {
        const current = this.activeTurns.get(input.threadId);
        current?.tree?.endStdin();
        if (current?.tree?.isRunning()) {
          void current.tree.terminate({ sigintGraceMs: 100, sigtermGraceMs: 150 });
        }
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

    const turn: ActiveClaudeTurn = {
      threadId: input.threadId,
      queue,
      quiescence,
      pendingApprovals: new Map(),
      taskIdToSubagentId: new Map(),
      streamedMessageBlocks: new Set(),
      tree: null,
      externalSessionId: input.resumeSessionId,
      interrupted: false,
      cleanupMcpFile: null,
    };

    if (input.resumeSessionId) {
      quiescence.setExternalSessionId(input.resumeSessionId);
    }

    this.activeTurns.set(input.threadId, turn);
    void this.launchTurnProcess(turn, input);
    return queue;
  }

  async steer(threadId: string, message: string): Promise<SteerResult> {
    const turn = this.activeTurns.get(threadId);
    if (!turn || !turn.tree || !turn.tree.isRunning()) {
      return {
        accepted: false,
        mode: 'not_running',
        reason: 'No active Claude process for thread',
      };
    }

    if (!turn.quiescence.turnActive) {
      turn.quiescence.markTurnStarted();
    }

    const frame = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: message }],
      },
    });
    const written = await turn.tree.writeStdin(`${frame}\n`);
    if (!written) {
      return {
        accepted: false,
        mode: 'not_running',
        reason: 'Claude stdin stream is closed',
      };
    }
    return { accepted: true, mode: 'stdin_frame' };
  }

  async interrupt(threadId: string): Promise<void> {
    const turn = this.activeTurns.get(threadId);
    if (!turn) return;
    turn.interrupted = true;
    turn.pendingApprovals.clear();
    if (turn.tree) {
      await turn.tree.terminate();
    }
    turn.quiescence.markInterrupted('Interrupted by caller');
    await this.cleanupTurnResources(turn);
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

    const innerResponse = allowed
      ? {
          behavior: 'allow',
          updatedInput: normalized.updatedInput ?? pending?.originalInput ?? {},
        }
      : {
          behavior: 'deny',
          message: normalized.reason ?? 'Tool execution denied by user',
        };

    const controlResponse = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: innerResponse,
      },
    });

    return turn.tree.writeStdin(`${controlResponse}\n`);
  }

  async dispose(): Promise<void> {
    const turns = [...this.activeTurns.values()];
    await Promise.all(
      turns.map(async (turn) => {
        turn.interrupted = true;
        turn.quiescence.dispose();
        turn.queue.close();
        await this.cleanupTurnResources(turn);
      }),
    );
    this.activeTurns.clear();
    if (this.ownsSupervisor) {
      await this.supervisor.dispose();
    }
  }

  private async launchTurnProcess(
    turn: ActiveClaudeTurn,
    input: ExternalTurnStartInput,
  ): Promise<void> {
    let stderrSummary = '';
    try {
      const args: string[] = [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--include-partial-messages',
      ];

      if (this.enablePermissionToolStdio) {
        args.push('--permission-prompt-tool', 'stdio');
      }

      if (input.resumeSessionId) {
        args.push('--resume', input.resumeSessionId);
      }
      if (input.forkSession) {
        args.push('--fork-session');
      }
      if (input.model) {
        args.push('--model', input.model);
      }
      if (input.reasoningEffort) {
        args.push('--effort', input.reasoningEffort);
      }

      if (input.mcp) {
        const ephemeral = await writeEphemeralJsonFile('claude-mcp', {
          mcpServers: {
            dstu_mesh: {
              type: 'http',
              url: input.mcp.httpUrl,
              headers: {
                Authorization: `Bearer ${input.mcp.bearerToken}`,
              },
            },
          },
        });
        turn.cleanupMcpFile = ephemeral.cleanup;
        args.push('--mcp-config', ephemeral.filePath);
      }

      args.push(...this.extraArgs);

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

      if (input.signal) {
        const onAbort = (): void => {
          void this.interrupt(input.threadId);
        };
        if (input.signal.aborted) {
          await this.interrupt(input.threadId);
          return;
        }
        input.signal.addEventListener('abort', onAbort, { once: true });
      }

      const stdoutReader = attachLineReader(tree.stdout, (line) => {
        this.handleStdoutLine(turn, line);
      });

      attachLineReader(tree.stderr, (line) => {
        if (stderrSummary.length < 4_096 && line.trim().length > 0) {
          stderrSummary += (stderrSummary ? '\n' : '') + line.trim();
        }
      });

      // Deliver initial user prompt over stream-json stdin while keeping stdin open for steer/approvals.
      const initialFrame = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: input.prompt }],
        },
      });
      await tree.writeStdin(`${initialFrame}\n`);

      const outcome = await tree.exited;
      stdoutReader.flush();

      if (turn.interrupted || input.signal?.aborted) {
        turn.quiescence.markInterrupted('Turn interrupted');
        return;
      }

      if (outcome.spawnError) {
        turn.quiescence.markFailed(
          `Failed to spawn Claude CLI (${this.command}): ${outcome.spawnError.message}`,
          'SPAWN_ERROR',
          false,
        );
        return;
      }

      if (outcome.exitCode !== 0 && outcome.exitCode !== null && turn.quiescence.phase !== 'quiescent') {
        const detail = stderrSummary || `Claude CLI exited with code ${outcome.exitCode}`;
        turn.quiescence.markFailed(detail, `EXIT_${outcome.exitCode}`, true);
        return;
      }

      // If process exited cleanly (0) after closing stdout, drain any orphaned child markers and settle.
      if (turn.quiescence.phase === 'running') {
        turn.quiescence.activeChildSubagents.clear();
        turn.quiescence.activeBgTasks.clear();
        turn.quiescence.settleMainTurn({
          externalSessionId: turn.externalSessionId,
          stopReason: 'process_exit',
        });
      } else if (turn.quiescence.phase === 'waiting_children') {
        for (const childId of [...turn.quiescence.activeChildSubagents.keys()]) {
          turn.quiescence.completeSubagent({ id: childId, status: 'completed' });
        }
        for (const taskId of [...turn.quiescence.activeBgTasks]) {
          turn.quiescence.completeBgTask({ taskId, exitCode: outcome.exitCode });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      turn.quiescence.markFailed(message, 'ADAPTER_ERROR', true);
    } finally {
      await this.cleanupTurnResources(turn);
      turn.queue.close();
    }
  }

  private bindSessionIfNew(turn: ActiveClaudeTurn, sessionId: string | undefined): void {
    if (!sessionId || sessionId.trim().length === 0) return;
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

  private handleStdoutLine(turn: ActiveClaudeTurn, rawLine: string): void {
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    const frame = tryParseJsonObject(trimmed);
    if (!frame) return;

    const frameSessionId = asString(frame.session_id) ?? asString(frame.sessionId);
    this.bindSessionIfNew(turn, frameSessionId);

    const frameType = asString(frame.type);
    const parentToolUseId =
      frame.parent_tool_use_id === null ? null : (asString(frame.parent_tool_use_id) ?? null);

    if (
      parentToolUseId &&
      !turn.quiescence.activeChildSubagents.has(parentToolUseId) &&
      !turn.quiescence.isCompletedChild(parentToolUseId)
    ) {
      turn.quiescence.startSubagent({
        id: parentToolUseId,
        parentToolUseId: null,
        title: `Subagent ${parentToolUseId}`,
      });
    } else if (parentToolUseId) {
      turn.quiescence.touchChildActivity();
    }

    if (frameType === 'system') {
      this.handleSystemFrame(turn, frame);
      return;
    }

    if (frameType === 'task_notification') {
      this.handleTaskNotification(turn, frame);
      return;
    }

    if (frameType === 'subagent_completed') {
      const childId = asString(frame.child_id) ?? asString(frame.childId) ?? asString(frame.tool_use_id);
      if (childId) {
        turn.quiescence.completeSubagent({
          id: childId,
          status: frame.status === 'failed' ? 'failed' : 'completed',
          summary: asString(frame.summary),
        });
      }
      return;
    }

    if (frameType === 'bg_task_started') {
      const taskId = asString(frame.task_id) ?? asString(frame.taskId);
      if (taskId) {
        turn.quiescence.startBgTask({
          taskId,
          title: asString(frame.title),
          command: asString(frame.command),
          pid: asNumber(frame.pid),
        });
      }
      return;
    }

    if (frameType === 'bg_task_completed') {
      const taskId = asString(frame.task_id) ?? asString(frame.taskId);
      if (taskId) {
        turn.quiescence.completeBgTask({
          taskId,
          exitCode: asNumber(frame.exit_code) ?? null,
          summary: asString(frame.summary),
        });
      }
      return;
    }

    if (frameType === 'stream_event') {
      this.handleStreamDeltaFrame(turn, frame, parentToolUseId);
      return;
    }

    if (frameType === 'assistant') {
      this.handleAssistantFrame(turn, frame, parentToolUseId);
      return;
    }

    if (frameType === 'user') {
      this.handleUserToolResultFrame(turn, frame, parentToolUseId);
      return;
    }

    if (frameType === 'control_request') {
      this.handleControlRequestFrame(turn, frame);
      return;
    }

    if (frameType === 'result') {
      this.handleResultFrame(turn, frame);
    }
  }

  private handleSystemFrame(turn: ActiveClaudeTurn, frame: Record<string, unknown>): void {
    const subtype = asString(frame.subtype);
    if (subtype === 'task_started' || subtype === 'background_task_started') {
      const taskId = asString(frame.task_id) ?? asString(frame.id);
      const toolUseId = asString(frame.tool_use_id);
      if (taskId && toolUseId && turn.quiescence.activeChildSubagents.has(toolUseId)) {
        turn.taskIdToSubagentId.set(taskId, toolUseId);
      } else if (taskId) {
        turn.quiescence.startBgTask({
          taskId,
          title: asString(frame.description) ?? asString(frame.title),
          command: asString(frame.command),
        });
      }
      return;
    }

    if (subtype === 'task_notification' || subtype === 'task_completed') {
      this.handleTaskNotification(turn, frame);
    }
  }

  private handleTaskNotification(turn: ActiveClaudeTurn, frame: Record<string, unknown>): void {
    const rawStatus = asString(frame.status);
    const status: 'completed' | 'failed' | 'stopped' =
      rawStatus === 'failed' || rawStatus === 'error'
        ? 'failed'
        : rawStatus === 'stopped' || rawStatus === 'killed'
          ? 'stopped'
          : 'completed';
    const summary = asString(frame.summary) ?? asString(frame.output);
    const toolUseId = asString(frame.tool_use_id) ?? asString(frame.toolUseId);
    const taskId = asString(frame.task_id) ?? asString(frame.taskId) ?? asString(frame.id);

    const mappedSubagentId =
      toolUseId ?? (taskId ? turn.taskIdToSubagentId.get(taskId) : undefined) ?? taskId;

    if (mappedSubagentId && turn.quiescence.activeChildSubagents.has(mappedSubagentId)) {
      turn.quiescence.completeSubagent({
        id: mappedSubagentId,
        status,
        summary,
      });
    }

    if (taskId && turn.quiescence.activeBgTasks.has(taskId)) {
      turn.quiescence.completeBgTask({
        taskId,
        exitCode: asNumber(frame.exit_code) ?? (status === 'completed' ? 0 : 1),
        summary,
      });
    }
  }

  private handleStreamDeltaFrame(
    turn: ActiveClaudeTurn,
    frame: Record<string, unknown>,
    parentToolUseId: string | null,
  ): void {
    const event = asRecord(frame.event);
    if (!event) return;
    const eventType = asString(event.type);

    if (eventType === 'message_start') {
      const msg = asRecord(event.message);
      const msgId = asString(msg?.id);
      if (msgId) {
        turn.streamedMessageBlocks.add(`msg:${msgId}`);
      }
      return;
    }

    if (eventType === 'content_block_delta') {
      const delta = asRecord(event.delta);
      const deltaType = asString(delta?.type);
      const index = asNumber(event.index) ?? 0;

      if (deltaType === 'text_delta') {
        const text = asString(delta?.text);
        if (text && text.length > 0) {
          turn.streamedMessageBlocks.add(`text:${parentToolUseId ?? 'root'}:${index}`);
          turn.queue.push({
            type: 'assistant_delta',
            threadId: turn.threadId,
            text,
            parentToolUseId,
            timestamp: this.now(),
          });
        }
      } else if (deltaType === 'thinking_delta') {
        const thinking = asString(delta?.thinking) ?? asString(delta?.text);
        if (thinking && thinking.length > 0) {
          turn.streamedMessageBlocks.add(`thinking:${parentToolUseId ?? 'root'}:${index}`);
          turn.queue.push({
            type: 'thinking_delta',
            threadId: turn.threadId,
            text: thinking,
            parentToolUseId,
            timestamp: this.now(),
          });
        }
      }
    }
  }

  private handleAssistantFrame(
    turn: ActiveClaudeTurn,
    frame: Record<string, unknown>,
    parentToolUseId: string | null,
  ): void {
    const message = asRecord(frame.message);
    if (!message) return;
    const messageId = asString(message.id);
    const content = message.content;
    if (!Array.isArray(content)) return;

    for (let i = 0; i < content.length; i += 1) {
      const block = asRecord(content[i]);
      if (!block) continue;
      const blockType = asString(block.type);

      if (blockType === 'text') {
        const text = asString(block.text);
        const streamKey = `text:${parentToolUseId ?? 'root'}:${i}`;
        const alreadyStreamed =
          turn.streamedMessageBlocks.has(streamKey) ||
          Boolean(messageId && turn.streamedMessageBlocks.has(`msg:${messageId}`) && turn.streamedMessageBlocks.size > 1);
        turn.streamedMessageBlocks.delete(streamKey);

        if (text && text.length > 0 && !alreadyStreamed) {
          turn.queue.push({
            type: 'assistant_delta',
            threadId: turn.threadId,
            text,
            messageId,
            parentToolUseId,
            timestamp: this.now(),
          });
        }
        continue;
      }

      if (blockType === 'thinking') {
        const thinking = asString(block.thinking) ?? asString(block.text);
        const streamKey = `thinking:${parentToolUseId ?? 'root'}:${i}`;
        const alreadyStreamed = turn.streamedMessageBlocks.has(streamKey);
        turn.streamedMessageBlocks.delete(streamKey);

        if (thinking && thinking.length > 0 && !alreadyStreamed) {
          turn.queue.push({
            type: 'thinking_delta',
            threadId: turn.threadId,
            text: thinking,
            parentToolUseId,
            timestamp: this.now(),
          });
        }
        continue;
      }

      if (blockType === 'tool_use') {
        const toolCallId = asString(block.id) ?? `tool_${this.now()}_${i}`;
        const toolName = asString(block.name) ?? 'unknown';
        const args = asRecord(block.input) ?? undefined;

        turn.queue.push({
          type: 'tool_call_start',
          threadId: turn.threadId,
          toolCallId,
          toolName,
          args,
          parentToolUseId,
          timestamp: this.now(),
        });

        if (isSubagentToolName(toolName)) {
          turn.quiescence.startSubagent({
            id: toolCallId,
            parentToolUseId,
            title: extractSubagentTitle(toolName, args ?? null),
            agentType: asString(args?.subagent_type) ?? asString(args?.agent_type),
          });
        } else if (
          (toolName === 'Bash' || toolName === 'bash') &&
          args?.run_in_background === true
        ) {
          turn.quiescence.startBgTask({
            taskId: toolCallId,
            title: asString(args.description),
            command: asString(args.command),
          });
        }
      }
    }
  }

  private handleUserToolResultFrame(
    turn: ActiveClaudeTurn,
    frame: Record<string, unknown>,
    parentToolUseId: string | null,
  ): void {
    const message = asRecord(frame.message);
    const toolUseResultMeta = asRecord(frame.tool_use_result) ?? asRecord(frame.toolUseResult);
    const content = message?.content;
    if (!Array.isArray(content)) return;

    for (const entry of content) {
      const block = asRecord(entry);
      if (!block || block.type !== 'tool_result') continue;
      const toolUseId = asString(block.tool_use_id);
      if (!toolUseId) continue;

      const output = extractToolResultText(block.content);
      const isError = Boolean(block.is_error);

      turn.queue.push({
        type: 'tool_call_end',
        threadId: turn.threadId,
        toolCallId: toolUseId,
        output,
        isError,
        parentToolUseId,
        timestamp: this.now(),
      });

      const isAsyncLaunched =
        block.is_async === true ||
        toolUseResultMeta?.isAsync === true ||
        toolUseResultMeta?.status === 'async_launched' ||
        Boolean(output && /^async agent launched/iu.test(output.trim()));

      if (isAsyncLaunched) {
        const asyncTaskId =
          asString(toolUseResultMeta?.agentId) ??
          asString(toolUseResultMeta?.task_id) ??
          asString(toolUseResultMeta?.backgroundTaskId);
        if (asyncTaskId) {
          turn.taskIdToSubagentId.set(asyncTaskId, toolUseId);
        }
        continue;
      }

      if (turn.quiescence.activeChildSubagents.has(toolUseId)) {
        turn.quiescence.completeSubagent({
          id: toolUseId,
          status: isError ? 'failed' : 'completed',
          summary: output,
        });
      }
      if (turn.quiescence.activeBgTasks.has(toolUseId)) {
        turn.quiescence.completeBgTask({
          taskId: toolUseId,
          exitCode: isError ? 1 : 0,
          summary: output,
        });
      }
    }
  }

  private handleControlRequestFrame(
    turn: ActiveClaudeTurn,
    frame: Record<string, unknown>,
  ): void {
    const request = asRecord(frame.request) ?? frame;
    const subtype = asString(request.subtype) ?? asString(frame.subtype);
    if (subtype !== 'can_use_tool' && subtype !== 'permission_request') {
      return;
    }

    const requestId =
      asString(frame.request_id) ??
      asString(frame.id) ??
      asString(request.request_id) ??
      `req_${this.now()}`;
    const toolName =
      asString(request.tool_name) ?? asString(request.toolName) ?? 'unknown_tool';
    const rawInput = asRecord(request.input) ?? {};
    const { targetPath, command } = extractApprovalMetadata(toolName, rawInput);

    turn.pendingApprovals.set(requestId, {
      requestId,
      toolName,
      originalInput: rawInput,
    });

    turn.queue.push({
      type: 'approval_requested',
      threadId: turn.threadId,
      requestId,
      toolName,
      targetPath,
      command,
      reason: asString(request.decision_reason) ?? asString(request.reason),
      rawInput,
      timestamp: this.now(),
    });
  }

  private handleResultFrame(turn: ActiveClaudeTurn, frame: Record<string, unknown>): void {
    const usage = asRecord(frame.usage);
    const totalCostUsd = asNumber(frame.total_cost_usd) ?? asNumber(frame.cost_usd);
    if (usage || totalCostUsd !== undefined) {
      turn.queue.push({
        type: 'usage',
        threadId: turn.threadId,
        inputTokens: asNumber(usage?.input_tokens) ?? 0,
        outputTokens: asNumber(usage?.output_tokens) ?? 0,
        cachedInputTokens:
          asNumber(usage?.cache_read_input_tokens) ?? asNumber(usage?.cached_input_tokens),
        totalCostUsd,
        timestamp: this.now(),
      });
    }

    const isError = frame.is_error === true || frame.subtype === 'error_during_execution';
    if (isError) {
      const errorMsg =
        asString(frame.result) ??
        asString(frame.error) ??
        'Claude Code reported an error result';
      turn.queue.push({
        type: 'turn_error',
        threadId: turn.threadId,
        message: errorMsg,
        code: asString(frame.subtype),
        recoverable: true,
        timestamp: this.now(),
      });
    }

    turn.quiescence.settleMainTurn({
      externalSessionId: turn.externalSessionId,
      stopReason: asString(frame.subtype) ?? 'end_turn',
    });
  }

  private async cleanupTurnResources(turn: ActiveClaudeTurn): Promise<void> {
    this.activeTurns.delete(turn.threadId);
    turn.quiescence.dispose();
    if (turn.cleanupMcpFile) {
      const fn = turn.cleanupMcpFile;
      turn.cleanupMcpFile = null;
      await fn();
    }
  }
}

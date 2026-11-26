// OpenCode protocol adapter.
// Supports both CLI JSON streaming mode (`opencode run --format json [--session <sid>]`)
// and HTTP/SSE Server mode (`opencode serve` / session REST + `/event` SSE stream)
// with inline `OPENCODE_CONFIG_CONTENT` MCP injection and PATH/env shim bridging.

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
  LineStreamSplitter,
  tryParseJsonObject,
} from './base.ts';

export interface OpenCodeAdapterOptions {
  readonly command?: string;
  readonly processSupervisor?: ProcessTreeSupervisor;
  readonly serverUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly safetyIdleTimeoutMs?: number;
  readonly extraArgs?: readonly string[];
  readonly now?: () => number;
}

interface ActiveOpenCodeTurn {
  readonly threadId: string;
  readonly queue: AsyncEventQueue<NormalizedRuntimeEvent>;
  readonly quiescence: QuiescenceTracker;
  readonly mode: 'cli' | 'server';
  readonly partLengths: Map<string, number>;
  tree: ManagedProcessTree | null;
  sseAbort: AbortController | null;
  serverBaseUrl: string | undefined;
  externalSessionId: string | undefined;
  interrupted: boolean;
}

function buildOpenCodeInlineConfig(mcp: McpInjectionSpec | undefined): Record<string, string> {
  if (!mcp) return {};
  const inlineConfig = {
    mcp: {
      dstu_mesh: {
        type: 'remote',
        url: mcp.httpUrl,
        enabled: true,
        headers: {
          Authorization: `Bearer ${mcp.bearerToken}`,
        },
      },
    },
  };
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig),
  };
}

export class OpenCodeAdapter implements ExternalCodingAdapter {
  readonly driver = 'opencode' as const;
  readonly capabilities: AdapterCapabilities;

  private readonly command: string;
  private readonly supervisor: ProcessTreeSupervisor;
  private readonly ownsSupervisor: boolean;
  private readonly serverUrl: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly safetyIdleTimeoutMs: number | undefined;
  private readonly extraArgs: readonly string[];
  private readonly now: () => number;
  private readonly activeTurns = new Map<string, ActiveOpenCodeTurn>();

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.command = options.command ?? 'opencode';
    this.ownsSupervisor = !options.processSupervisor;
    this.supervisor =
      options.processSupervisor ?? new ProcessTreeSupervisor({ registerExitHook: true });
    this.serverUrl = options.serverUrl?.replace(/\/+$/u, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.safetyIdleTimeoutMs = options.safetyIdleTimeoutMs;
    this.extraArgs = options.extraArgs ?? [];
    this.now = options.now ?? Date.now;

    const serverMode = Boolean(this.serverUrl);
    this.capabilities = {
      ...DRIVER_DEFAULT_CAPABILITIES.opencode,
      midTurnSteer: serverMode,
      approvalCallback: serverMode,
    };
  }

  startOrResumeTurn(input: ExternalTurnStartInput): AsyncIterable<NormalizedRuntimeEvent> {
    const queue = new AsyncEventQueue<NormalizedRuntimeEvent>((event) => {
      input.onEvent?.(event);
      if (isTerminalRuntimeEvent(event)) {
        const current = this.activeTurns.get(input.threadId);
        current?.sseAbort?.abort();
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

    const mode: 'cli' | 'server' = this.serverUrl ? 'server' : 'cli';
    const turn: ActiveOpenCodeTurn = {
      threadId: input.threadId,
      queue,
      quiescence,
      mode,
      partLengths: new Map(),
      tree: null,
      sseAbort: mode === 'server' ? new AbortController() : null,
      serverBaseUrl: this.serverUrl,
      externalSessionId: input.resumeSessionId,
      interrupted: false,
    };

    if (input.resumeSessionId) {
      quiescence.setExternalSessionId(input.resumeSessionId);
    }

    this.activeTurns.set(input.threadId, turn);
    if (mode === 'server') {
      void this.runServerModeTurn(turn, input);
    } else {
      void this.runCliModeTurn(turn, input);
    }
    return queue;
  }

  async steer(threadId: string, message: string): Promise<SteerResult> {
    const turn = this.activeTurns.get(threadId);
    if (!turn) {
      return { accepted: false, mode: 'not_running', reason: 'No active OpenCode turn' };
    }
    if (turn.mode !== 'server' || !turn.serverBaseUrl || !turn.externalSessionId) {
      return {
        accepted: false,
        mode: 'unsupported',
        reason: 'OpenCode CLI run mode does not support mid-turn steer; queue or interrupt+resume',
      };
    }

    const res = await this.fetchImpl(
      `${turn.serverBaseUrl}/session/${encodeURIComponent(turn.externalSessionId)}/prompt_async`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: message }],
        }),
      },
    );
    if (!res.ok) {
      return {
        accepted: false,
        mode: 'not_running',
        reason: `OpenCode server steer HTTP ${res.status}`,
      };
    }
    return { accepted: true, mode: 'native_steer' };
  }

  async interrupt(threadId: string): Promise<void> {
    const turn = this.activeTurns.get(threadId);
    if (!turn) return;
    turn.interrupted = true;
    turn.sseAbort?.abort();

    if (turn.mode === 'server' && turn.serverBaseUrl && turn.externalSessionId) {
      try {
        await this.fetchImpl(
          `${turn.serverBaseUrl}/session/${encodeURIComponent(turn.externalSessionId)}/abort`,
          { method: 'POST' },
        );
      } catch (err) {
        if (err instanceof Error) {
          // Server unreachable during abort; local SSE stream already aborted.
        }
      }
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
    if (!turn || turn.mode !== 'server' || !turn.serverBaseUrl || !turn.externalSessionId) {
      return false;
    }

    const normalized = normalizeApprovalResponse(response);
    const allowed = isApprovalAllowed(normalized.decision);
    const replyValue =
      normalized.decision === 'allow_for_session'
        ? 'always'
        : allowed
          ? 'once'
          : 'reject';

    const res = await this.fetchImpl(
      `${turn.serverBaseUrl}/session/${encodeURIComponent(turn.externalSessionId)}/permissions/${encodeURIComponent(requestId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response: replyValue }),
      },
    );
    return res.ok;
  }

  async dispose(): Promise<void> {
    const turns = [...this.activeTurns.values()];
    await Promise.all(
      turns.map(async (turn) => {
        turn.interrupted = true;
        turn.sseAbort?.abort();
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

  private async runCliModeTurn(
    turn: ActiveOpenCodeTurn,
    input: ExternalTurnStartInput,
  ): Promise<void> {
    let stderrBuf = '';
    try {
      const args: string[] = ['run', '--format', 'json'];
      if (input.resumeSessionId) {
        args.push('--session', input.resumeSessionId);
      }
      if (input.model) {
        args.push('--model', input.model);
      }
      args.push(...this.extraArgs, input.prompt);

      const env = buildInjectedSubprocessEnv({
        baseEnv: process.env,
        extraEnv: {
          ...buildOpenCodeInlineConfig(input.mcp),
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
      tree.endStdin();

      const stdoutReader = attachLineReader(tree.stdout, (line) => {
        this.handleCliJsonLine(turn, line);
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
          stderrBuf || `OpenCode exited with code ${outcome.exitCode}`,
          `EXIT_${outcome.exitCode}`,
          true,
        );
        turn.queue.close();
        return;
      }

      if (turn.quiescence.phase === 'running') {
        turn.quiescence.settleMainTurn({
          externalSessionId: turn.externalSessionId,
          stopReason: 'completed',
        });
      } else if (turn.quiescence.phase === 'waiting_children') {
        for (const cid of [...turn.quiescence.activeChildSubagents.keys()]) {
          turn.quiescence.completeSubagent({ id: cid, status: 'completed' });
        }
      }
      turn.queue.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      turn.quiescence.markFailed(msg, 'OPENCODE_CLI_ERROR', true);
      turn.queue.close();
    } finally {
      this.activeTurns.delete(turn.threadId);
      turn.quiescence.dispose();
    }
  }

  private async runServerModeTurn(
    turn: ActiveOpenCodeTurn,
    input: ExternalTurnStartInput,
  ): Promise<void> {
    const baseUrl = turn.serverBaseUrl!;
    try {
      let sessionId = input.resumeSessionId;
      if (!sessionId) {
        const createRes = await this.fetchImpl(`${baseUrl}/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            directory: input.cwd,
            ...(input.mcp
              ? {
                  mcp: {
                    dstu_mesh: {
                      type: 'remote',
                      url: input.mcp.httpUrl,
                      headers: { Authorization: `Bearer ${input.mcp.bearerToken}` },
                    },
                  },
                }
              : {}),
          }),
          signal: turn.sseAbort?.signal,
        });
        if (!createRes.ok) {
          throw new Error(`OpenCode server failed to create session (${createRes.status})`);
        }
        const created = asRecord(await createRes.json());
        sessionId = asString(created?.id) ?? asString(created?.sessionID);
      }

      if (!sessionId) {
        throw new Error('OpenCode server returned no session ID');
      }
      this.bindSession(turn, sessionId);

      // Start SSE event listener before dispatching prompt so zero deltas are missed.
      const ssePromise = this.consumeServerSse(turn, baseUrl, sessionId);

      const promptRes = await this.fetchImpl(
        `${baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            parts: [{ type: 'text', text: input.prompt }],
            ...(input.model ? { model: input.model } : {}),
          }),
          signal: turn.sseAbort?.signal,
        },
      );
      if (!promptRes.ok) {
        throw new Error(`OpenCode prompt_async failed (${promptRes.status})`);
      }

      await ssePromise;
    } catch (err) {
      if (turn.interrupted || input.signal?.aborted) {
        turn.quiescence.markInterrupted('Turn interrupted');
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        turn.quiescence.markFailed(msg, 'OPENCODE_SERVER_ERROR', true);
      }
      turn.queue.close();
    } finally {
      this.activeTurns.delete(turn.threadId);
      turn.quiescence.dispose();
    }
  }

  private async consumeServerSse(
    turn: ActiveOpenCodeTurn,
    baseUrl: string,
    sessionId: string,
  ): Promise<void> {
    const res = await this.fetchImpl(`${baseUrl}/event`, {
      headers: { accept: 'text/event-stream' },
      signal: turn.sseAbort?.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`OpenCode SSE /event failed (${res.status})`);
    }

    let dataLines: string[] = [];
    const splitter = new LineStreamSplitter((line) => {
      if (line === '') {
        if (dataLines.length > 0) {
          const payload = dataLines.join('\n');
          dataLines = [];
          this.handleServerSsePayload(turn, sessionId, payload);
        }
        return;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (!turn.interrupted && turn.quiescence.phase !== 'quiescent') {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        splitter.feed(decoder.decode(value, { stream: true }));
      }
    }
    splitter.flush();
  }

  private handleServerSsePayload(
    turn: ActiveOpenCodeTurn,
    targetSessionId: string,
    payloadText: string,
  ): void {
    const envelope = tryParseJsonObject(payloadText);
    if (!envelope) return;

    const eventObj = asRecord(envelope.payload) ?? envelope;
    const eventType = asString(eventObj.type);
    const props = asRecord(eventObj.properties) ?? eventObj;

    const eventSessionId =
      asString(props.sessionID) ??
      asString(asRecord(props.part)?.sessionID) ??
      asString(asRecord(props.info)?.sessionID);
    if (eventSessionId && eventSessionId !== targetSessionId) {
      return;
    }

    if (eventType === 'message.part.updated') {
      const part = asRecord(props.part);
      if (!part) return;
      const partId = asString(part.id) ?? 'part';
      const partType = asString(part.type);
      const explicitDelta = asString(props.delta);

      if (partType === 'text') {
        const fullText = asString(part.text) ?? '';
        const prevLen = turn.partLengths.get(partId) ?? 0;
        const delta = explicitDelta ?? fullText.slice(prevLen);
        turn.partLengths.set(partId, fullText.length);
        if (delta.length > 0) {
          turn.queue.push({
            type: 'assistant_delta',
            threadId: turn.threadId,
            text: delta,
            messageId: partId,
            timestamp: this.now(),
          });
        }
      } else if (partType === 'reasoning') {
        const fullText = asString(part.text) ?? '';
        const prevLen = turn.partLengths.get(partId) ?? 0;
        const delta = explicitDelta ?? fullText.slice(prevLen);
        turn.partLengths.set(partId, fullText.length);
        if (delta.length > 0) {
          turn.queue.push({
            type: 'thinking_delta',
            threadId: turn.threadId,
            text: delta,
            timestamp: this.now(),
          });
        }
      } else if (partType === 'tool') {
        const state = asRecord(part.state);
        const status = asString(state?.status);
        const toolName = asString(part.tool) ?? 'tool';
        if (status === 'running' && !turn.partLengths.has(`tool:${partId}`)) {
          turn.partLengths.set(`tool:${partId}`, 1);
          turn.queue.push({
            type: 'tool_call_start',
            threadId: turn.threadId,
            toolCallId: partId,
            toolName,
            args: asRecord(state?.input) ?? undefined,
            timestamp: this.now(),
          });
        } else if (status === 'completed' || status === 'error') {
          turn.queue.push({
            type: 'tool_call_end',
            threadId: turn.threadId,
            toolCallId: partId,
            toolName,
            output: asString(state?.output) ?? asString(state?.error),
            isError: status === 'error',
            timestamp: this.now(),
          });
        }
      }
      return;
    }

    if (eventType === 'permission.updated' || eventType === 'permission.asked') {
      const requestId = asString(props.id) ?? `perm_${this.now()}`;
      const toolName = asString(props.tool) ?? asString(props.type) ?? 'permission';
      const metadata = asRecord(props.metadata) ?? props;
      const { targetPath, command } = extractApprovalMetadata(toolName, metadata);
      turn.queue.push({
        type: 'approval_requested',
        threadId: turn.threadId,
        requestId,
        toolName,
        targetPath,
        command,
        reason: asString(props.title),
        rawInput: metadata,
        timestamp: this.now(),
      });
      return;
    }

    if (eventType === 'session.error') {
      const errRec = asRecord(props.error);
      turn.quiescence.markFailed(
        asString(errRec?.message) ?? 'OpenCode session error',
        'SESSION_ERROR',
        true,
      );
      turn.sseAbort?.abort();
      turn.queue.close();
      return;
    }

    if (eventType === 'session.idle') {
      turn.quiescence.settleMainTurn({
        externalSessionId: turn.externalSessionId,
        stopReason: 'idle',
      });
    }
  }

  private bindSession(turn: ActiveOpenCodeTurn, sessionId: string | undefined): void {
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

  private handleCliJsonLine(turn: ActiveOpenCodeTurn, rawLine: string): void {
    const frame = tryParseJsonObject(rawLine);
    if (!frame) return;

    const sid = asString(frame.sessionID) ?? asString(frame.sessionId) ?? asString(frame.session_id);
    this.bindSession(turn, sid);

    const frameType = asString(frame.type);
    const part = asRecord(frame.part);

    if (frameType === 'text') {
      const text = asString(part?.text) ?? asString(frame.text);
      if (text) {
        turn.queue.push({
          type: 'assistant_delta',
          threadId: turn.threadId,
          text,
          messageId: asString(part?.id),
          timestamp: this.now(),
        });
      }
      return;
    }

    if (frameType === 'reasoning') {
      const text = asString(part?.text) ?? asString(frame.text);
      if (text) {
        turn.queue.push({
          type: 'thinking_delta',
          threadId: turn.threadId,
          text,
          timestamp: this.now(),
        });
      }
      return;
    }

    if (frameType === 'tool_use' || (part && part.type === 'tool')) {
      const toolCallId =
        asString(part?.callID) ?? asString(part?.id) ?? asString(frame.id) ?? `oc_tool_${this.now()}`;
      const toolName = asString(part?.tool) ?? asString(frame.tool) ?? 'tool';
      const state = asRecord(part?.state);
      const status = asString(state?.status) ?? 'completed';
      const inputArgs = asRecord(state?.input) ?? asRecord(frame.input);

      if (status === 'running' || status === 'pending') {
        turn.queue.push({
          type: 'tool_call_start',
          threadId: turn.threadId,
          toolCallId,
          toolName,
          args: inputArgs ?? undefined,
          timestamp: this.now(),
        });
        if (toolName === 'task' || toolName === 'subagent') {
          turn.quiescence.startSubagent({
            id: toolCallId,
            parentToolUseId: null,
            title: asString(inputArgs?.description) ?? 'OpenCode Subagent',
          });
        }
      } else {
        turn.queue.push({
          type: 'tool_call_start',
          threadId: turn.threadId,
          toolCallId,
          toolName,
          args: inputArgs ?? undefined,
          timestamp: this.now(),
        });
        turn.queue.push({
          type: 'tool_call_end',
          threadId: turn.threadId,
          toolCallId,
          toolName,
          output: asString(state?.output) ?? asString(frame.output),
          isError: status === 'error',
          timestamp: this.now(),
        });
        if (turn.quiescence.activeChildSubagents.has(toolCallId)) {
          turn.quiescence.completeSubagent({
            id: toolCallId,
            status: status === 'error' ? 'failed' : 'completed',
          });
        }
      }
      return;
    }

    if (frameType === 'step_finish') {
      const tokens = asRecord(part?.tokens) ?? asRecord(frame.tokens);
      const cost = asNumber(part?.cost) ?? asNumber(frame.cost);
      if (tokens || cost !== undefined) {
        const cache = asRecord(tokens?.cache);
        turn.queue.push({
          type: 'usage',
          threadId: turn.threadId,
          inputTokens: asNumber(tokens?.input) ?? 0,
          outputTokens: asNumber(tokens?.output) ?? 0,
          cachedInputTokens: asNumber(cache?.read),
          totalCostUsd: cost,
          timestamp: this.now(),
        });
      }
      return;
    }

    if (frameType === 'error') {
      const errRec = asRecord(frame.error);
      turn.quiescence.markFailed(
        asString(errRec?.message) ?? asString(frame.message) ?? 'OpenCode error',
        'OPENCODE_ERROR',
        true,
      );
      turn.queue.close();
    }
  }
}

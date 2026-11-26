// Configurable CLI adapter for Antigravity CLI (`agy`), DeepSeek Harness (`dsh`),
// and user-defined `CustomCliTemplate`s.
// Provides per-token template substitution, automatic JSON-line detection with clean
// plain-text streaming fallback, PATH CLI shim + `DSTU_MESH_TOKEN` env injection,
// and honest capability reporting (`midTurnSteer: false`).

import {
  type AdapterCapabilities,
  type ApprovalDecisionKind,
  type ApprovalResponseInput,
  type CustomCliTemplate,
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
  isTerminalRuntimeEvent,
  tryParseJsonObject,
} from './base.ts';

export type GenericDriverKind = 'agy' | 'dsh' | 'custom';

export const BUILT_IN_GENERIC_TEMPLATES: Readonly<Record<'agy' | 'dsh', CustomCliTemplate>> = {
  agy: {
    id: 'agy',
    name: 'Antigravity CLI',
    command: 'agy',
    argsTemplate: ['--prompt', '{{prompt}}'],
    resumeArgsTemplate: ['--resume', '{{sessionId}}', '--prompt', '{{prompt}}'],
    outputFormat: 'auto',
  },
  dsh: {
    id: 'dsh',
    name: 'DeepSeek Harness',
    command: 'dsh',
    argsTemplate: ['run', '--prompt', '{{prompt}}'],
    resumeArgsTemplate: ['run', '--resume', '{{sessionId}}', '--prompt', '{{prompt}}'],
    outputFormat: 'auto',
  },
};

export interface GenericCliAdapterOptions {
  readonly driver?: GenericDriverKind;
  readonly template?: CustomCliTemplate;
  readonly processSupervisor?: ProcessTreeSupervisor;
  readonly safetyIdleTimeoutMs?: number;
  readonly now?: () => number;
}

interface ActiveGenericTurn {
  readonly threadId: string;
  readonly queue: AsyncEventQueue<NormalizedRuntimeEvent>;
  readonly quiescence: QuiescenceTracker;
  tree: ManagedProcessTree | null;
  externalSessionId: string | undefined;
  emittedLineCount: number;
  interrupted: boolean;
}

function renderTemplateTokens(
  templateTokens: readonly string[],
  vars: Readonly<Record<string, string>>,
): { args: string[]; usedPromptToken: boolean } {
  let usedPromptToken = false;
  const args = templateTokens.map((token) => {
    if (token.includes('{{prompt}}')) {
      usedPromptToken = true;
    }
    return token.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/gu, (full, key: string) => {
      if (key === 'prompt') usedPromptToken = true;
      return Object.prototype.hasOwnProperty.call(vars, key) ? (vars[key] ?? '') : full;
    });
  });
  return { args, usedPromptToken };
}

export class GenericCliAdapter implements ExternalCodingAdapter {
  readonly driver: GenericDriverKind;
  readonly capabilities: AdapterCapabilities;
  readonly template: CustomCliTemplate;

  private readonly supervisor: ProcessTreeSupervisor;
  private readonly ownsSupervisor: boolean;
  private readonly safetyIdleTimeoutMs: number | undefined;
  private readonly now: () => number;
  private readonly activeTurns = new Map<string, ActiveGenericTurn>();

  constructor(options: GenericCliAdapterOptions = {}) {
    const driver = options.driver ?? (options.template ? 'custom' : 'agy');
    this.driver = driver;

    if (options.template) {
      this.template = options.template;
    } else if (driver === 'dsh') {
      this.template = BUILT_IN_GENERIC_TEMPLATES.dsh;
    } else if (driver === 'agy') {
      this.template = BUILT_IN_GENERIC_TEMPLATES.agy;
    } else {
      throw new Error('GenericCliAdapter with driver="custom" requires a CustomCliTemplate');
    }

    const baseCaps = DRIVER_DEFAULT_CAPABILITIES[driver];
    const hasResume = Boolean(
      this.template.resumeArgsTemplate && this.template.resumeArgsTemplate.length > 0,
    );

    this.capabilities = {
      ...baseCaps,
      ...this.template.capabilitiesOverride,
      midTurnSteer: false,
      approvalCallback: false,
      sessionResume: this.template.capabilitiesOverride?.sessionResume ?? hasResume,
      mcpInjection: true,
    };

    this.ownsSupervisor = !options.processSupervisor;
    this.supervisor =
      options.processSupervisor ?? new ProcessTreeSupervisor({ registerExitHook: true });
    this.safetyIdleTimeoutMs = options.safetyIdleTimeoutMs;
    this.now = options.now ?? Date.now;
  }

  startOrResumeTurn(input: ExternalTurnStartInput): AsyncIterable<NormalizedRuntimeEvent> {
    const queue = new AsyncEventQueue<NormalizedRuntimeEvent>((event) => {
      input.onEvent?.(event);
      if (isTerminalRuntimeEvent(event)) {
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

    const turn: ActiveGenericTurn = {
      threadId: input.threadId,
      queue,
      quiescence,
      tree: null,
      externalSessionId: input.resumeSessionId,
      emittedLineCount: 0,
      interrupted: false,
    };

    if (input.resumeSessionId) {
      quiescence.setExternalSessionId(input.resumeSessionId);
    }

    this.activeTurns.set(input.threadId, turn);
    void this.launchGenericProcess(turn, input);
    return queue;
  }

  async steer(_threadId: string, _message: string): Promise<SteerResult> {
    return {
      accepted: false,
      mode: 'unsupported',
      reason: `${this.template.name} does not support mid-turn steering; queue message or interrupt+resume`,
    };
  }

  async interrupt(threadId: string): Promise<void> {
    const turn = this.activeTurns.get(threadId);
    if (!turn) return;
    turn.interrupted = true;
    if (turn.tree) {
      await turn.tree.terminate();
    }
    turn.quiescence.markInterrupted('Interrupted by caller');
    this.activeTurns.delete(threadId);
  }

  async respondApproval(
    _threadId: string,
    _requestId: string,
    _response: ApprovalResponseInput | ApprovalDecisionKind,
  ): Promise<boolean> {
    return false;
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

  private async launchGenericProcess(
    turn: ActiveGenericTurn,
    input: ExternalTurnStartInput,
  ): Promise<void> {
    let stderrBuf = '';
    try {
      const useResume = Boolean(
        input.resumeSessionId &&
          this.template.resumeArgsTemplate &&
          this.template.resumeArgsTemplate.length > 0,
      );
      const rawTokens = useResume
        ? this.template.resumeArgsTemplate!
        : this.template.argsTemplate;

      const { args: renderedArgs, usedPromptToken } = renderTemplateTokens(rawTokens, {
        prompt: input.prompt,
        sessionId: input.resumeSessionId ?? '',
        cwd: input.cwd,
        threadId: input.threadId,
        model: input.model ?? '',
      });

      const prefixFlags: string[] = [];
      const templateUsesModelToken = rawTokens.some((tok) => /\{\{\s*model\s*\}\}/u.test(tok));
      if (input.model && !templateUsesModelToken && this.driver === 'agy') {
        prefixFlags.push('--model', input.model);
      }
      if (input.reasoningEffort && this.driver === 'agy') {
        prefixFlags.push('--effort', input.reasoningEffort);
      }
      const args = prefixFlags.length > 0 ? [...prefixFlags, ...renderedArgs] : renderedArgs;

      const deliverViaStdin = this.template.promptMode === 'stdin' || !usedPromptToken;

      const env = buildInjectedSubprocessEnv({
        baseEnv: process.env,
        extraEnv: {
          ...this.template.env,
          ...input.env,
        },
        mcp: input.mcp,
      });

      const tree = this.supervisor.spawn({
        command: this.template.command,
        args,
        cwd: input.cwd,
        env,
        signal: input.signal,
      });
      turn.tree = tree;

      const stdoutReader = attachLineReader(tree.stdout, (line) => {
        this.handleOutputLine(turn, line);
      });
      attachLineReader(tree.stderr, (line) => {
        if (stderrBuf.length < 4_096 && line.trim().length > 0) {
          stderrBuf += (stderrBuf ? '\n' : '') + line.trim();
        }
      });

      if (deliverViaStdin) {
        await tree.writeStdin(`${input.prompt}\n`);
      }
      tree.endStdin();

      const outcome = await tree.exited;
      stdoutReader.flush();

      if (turn.interrupted || input.signal?.aborted) {
        turn.quiescence.markInterrupted('Turn interrupted');
        turn.queue.close();
        return;
      }

      if (outcome.spawnError) {
        turn.quiescence.markFailed(
          `Failed to spawn ${this.template.command}: ${outcome.spawnError.message}`,
          'SPAWN_ERROR',
          false,
        );
        turn.queue.close();
        return;
      }

      if (outcome.exitCode !== 0 && outcome.exitCode !== null && turn.quiescence.phase !== 'quiescent') {
        turn.quiescence.markFailed(
          stderrBuf || `${this.template.name} exited with code ${outcome.exitCode}`,
          `EXIT_${outcome.exitCode}`,
          true,
        );
        turn.queue.close();
        return;
      }

      if (turn.quiescence.phase === 'running') {
        turn.quiescence.settleMainTurn({
          externalSessionId: turn.externalSessionId,
          stopReason: 'exit_0',
        });
      } else if (turn.quiescence.phase === 'waiting_children') {
        for (const cid of [...turn.quiescence.activeChildSubagents.keys()]) {
          turn.quiescence.completeSubagent({ id: cid, status: 'completed' });
        }
      }
      turn.queue.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      turn.quiescence.markFailed(msg, 'GENERIC_ADAPTER_ERROR', true);
      turn.queue.close();
    } finally {
      this.activeTurns.delete(turn.threadId);
      turn.quiescence.dispose();
    }
  }

  private bindSession(turn: ActiveGenericTurn, sessionId: string | undefined): void {
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

  private handleOutputLine(turn: ActiveGenericTurn, line: string): void {
    const outputMode = this.template.outputFormat ?? 'auto';

    if (outputMode !== 'text') {
      const jsonObj = tryParseJsonObject(line);
      if (jsonObj && this.tryEmitStructuredJsonLine(turn, jsonObj)) {
        return;
      }
      if (outputMode === 'jsonl' && line.trim().length === 0) {
        return;
      }
    }

    // Plain-text streaming fallback preserving line breaks across multi-line output.
    const prefix = turn.emittedLineCount > 0 ? '\n' : '';
    turn.emittedLineCount += 1;
    turn.queue.push({
      type: 'assistant_delta',
      threadId: turn.threadId,
      text: `${prefix}${line}`,
      timestamp: this.now(),
    });
  }

  private tryEmitStructuredJsonLine(
    turn: ActiveGenericTurn,
    obj: Record<string, unknown>,
  ): boolean {
    const sid =
      asString(obj.session_id) ?? asString(obj.sessionId) ?? asString(obj.thread_id);
    if (sid) {
      this.bindSession(turn, sid);
    }

    const type = asString(obj.type);
    const deltaText =
      asString(obj.delta) ??
      asString(obj.text) ??
      asString(obj.content) ??
      asString(asRecord(obj.message)?.content);

    if (type === 'session' || type === 'session_bound' || type === 'init') {
      return Boolean(sid);
    }

    if (type === 'thinking' || type === 'reasoning' || type === 'thinking_delta') {
      if (deltaText) {
        turn.queue.push({
          type: 'thinking_delta',
          threadId: turn.threadId,
          text: deltaText,
          timestamp: this.now(),
        });
      }
      return true;
    }

    if (
      type === 'assistant' ||
      type === 'assistant_delta' ||
      type === 'text' ||
      type === 'delta' ||
      type === 'message'
    ) {
      if (deltaText) {
        turn.queue.push({
          type: 'assistant_delta',
          threadId: turn.threadId,
          text: deltaText,
          timestamp: this.now(),
        });
      }
      return true;
    }

    if (type === 'tool_call' || type === 'tool_use' || type === 'tool_call_start') {
      const toolCallId = asString(obj.id) ?? asString(obj.toolCallId) ?? `gen_tool_${this.now()}`;
      const toolName = asString(obj.name) ?? asString(obj.toolName) ?? asString(obj.tool) ?? 'tool';
      turn.queue.push({
        type: 'tool_call_start',
        threadId: turn.threadId,
        toolCallId,
        toolName,
        args: asRecord(obj.input) ?? asRecord(obj.args) ?? undefined,
        timestamp: this.now(),
      });
      return true;
    }

    if (type === 'tool_result' || type === 'tool_call_end') {
      const toolCallId = asString(obj.tool_use_id) ?? asString(obj.id) ?? asString(obj.toolCallId) ?? '';
      turn.queue.push({
        type: 'tool_call_end',
        threadId: turn.threadId,
        toolCallId,
        output: asString(obj.output) ?? deltaText,
        isError: Boolean(obj.is_error ?? obj.isError),
        timestamp: this.now(),
      });
      return true;
    }

    if (type === 'usage') {
      turn.queue.push({
        type: 'usage',
        threadId: turn.threadId,
        inputTokens: asNumber(obj.input_tokens) ?? asNumber(obj.inputTokens) ?? 0,
        outputTokens: asNumber(obj.output_tokens) ?? asNumber(obj.outputTokens) ?? 0,
        cachedInputTokens: asNumber(obj.cached_input_tokens) ?? asNumber(obj.cachedInputTokens),
        totalCostUsd: asNumber(obj.total_cost_usd) ?? asNumber(obj.totalCostUsd),
        timestamp: this.now(),
      });
      return true;
    }

    if (type === 'error' || type === 'turn_error') {
      turn.quiescence.markFailed(
        asString(obj.error) ?? asString(obj.message) ?? 'CLI reported error',
        asString(obj.code),
        true,
      );
      turn.queue.close();
      return true;
    }

    if (type === 'result' || type === 'done' || type === 'completed') {
      if (deltaText) {
        turn.queue.push({
          type: 'assistant_delta',
          threadId: turn.threadId,
          text: deltaText,
          timestamp: this.now(),
        });
      }
      turn.quiescence.settleMainTurn({
        externalSessionId: turn.externalSessionId,
        stopReason: type,
      });
      return true;
    }

    // Unrecognized JSON object without event discriminator: only treat as structured if session_id alone.
    if (sid && Object.keys(obj).length === 1) {
      return true;
    }
    return false;
  }
}

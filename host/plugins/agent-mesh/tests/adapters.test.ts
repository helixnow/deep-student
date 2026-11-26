import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { NormalizedRuntimeEvent } from '../src/adapter-types.ts';
import {
  ClaudeAdapter,
  CodexAdapter,
  ExternalAdapterRegistry,
  GenericCliAdapter,
  LineStreamSplitter,
  OpenCodeAdapter,
  PiAdapter,
} from '../src/adapters/index.ts';
import {
  buildInjectedSubprocessEnv,
  ProcessTreeSupervisor,
  type ProcessSpawnPort,
  type SpawnedProcessLike,
} from '../src/process-tree.ts';
import { QuiescenceTracker } from '../src/quiescence.ts';

class SimulatedChildProcess extends EventEmitter implements SpawnedProcessLike {
  readonly pid: number | undefined;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly writtenStdinLines: string[] = [];

  private readonly splitter: LineStreamSplitter;
  private readonly onStdinLine?: (line: string, proc: SimulatedChildProcess) => void;
  private readonly onKillSignal?: (
    signal: NodeJS.Signals | number | undefined,
    proc: SimulatedChildProcess,
  ) => void;

  constructor(options: {
    pid?: number;
    onStdinLine?: (line: string, proc: SimulatedChildProcess) => void;
    onKillSignal?: (
      signal: NodeJS.Signals | number | undefined,
      proc: SimulatedChildProcess,
    ) => void;
  } = {}) {
    super();
    this.pid = options.pid ?? 42_420;
    this.onStdinLine = options.onStdinLine;
    this.onKillSignal = options.onKillSignal;
    this.splitter = new LineStreamSplitter((line) => {
      this.writtenStdinLines.push(line);
      this.onStdinLine?.(line, this);
    });
    this.stdin.on('data', (chunk: Buffer | string) => {
      this.splitter.feed(chunk);
    });
    this.stdin.on('end', () => {
      this.splitter.flush();
    });
  }

  emitStdoutJson(payload: unknown): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  emitStdoutText(text: string): void {
    this.stdout.write(text);
  }

  finishProcess(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    if (this.onKillSignal) {
      this.onKillSignal(signal, this);
      return true;
    }
    const sigName: NodeJS.Signals =
      typeof signal === 'string' ? signal : 'SIGTERM';
    this.finishProcess(null, sigName);
    return true;
  }
}

async function collectEvents(
  stream: AsyncIterable<NormalizedRuntimeEvent>,
): Promise<NormalizedRuntimeEvent[]> {
  const out: NormalizedRuntimeEvent[] = [];
  for await (const event of stream) {
    out.push(event);
  }
  return out;
}

describe('ProcessTreeSupervisor & buildInjectedSubprocessEnv', () => {
  it('injects DSTU_MESH_TOKEN, DSTU_MESH_URL, strips CLAUDECODE, and prepends shimBinDir to PATH', () => {
    const env = buildInjectedSubprocessEnv({
      baseEnv: {
        PATH: '/usr/bin:/bin',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        HOME: '/Users/dev',
      },
      extraEnv: {
        CUSTOM_FLAG: 'yes',
      },
      mcp: {
        httpUrl: 'http://127.0.0.1:54321/mcp',
        bearerToken: 'mesh-secret-tok',
        shimBinDir: '/tmp/dstu-shim/bin',
        envVars: { DSTU_SESSION: 'sess-1' },
      },
      platform: 'darwin',
    });

    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.DSTU_MESH_URL).toBe('http://127.0.0.1:54321/mcp');
    expect(env.DSTU_MESH_TOKEN).toBe('mesh-secret-tok');
    expect(env.DSTU_SESSION).toBe('sess-1');
    expect(env.CUSTOM_FLAG).toBe('yes');
    expect(env.PATH).toBe(
      [
        '/tmp/dstu-shim/bin',
        '/usr/bin',
        '/bin',
        '/Users/dev/.local/bin',
        '/Users/dev/.grok/bin',
        '/Users/dev/.bun/bin',
        '/Users/dev/.cargo/bin',
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/local/bin',
      ].join(':'),
    );
  });

  it('escalates POSIX process-group signals SIGINT -> SIGTERM -> SIGKILL across -pid when stubborn', async () => {
    const sentSignals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    let groupAlive = true;
    let procRef: SimulatedChildProcess | null = null;

    const supervisor = new ProcessTreeSupervisor({
      platform: 'linux',
      registerExitHook: false,
      timings: { sigintGraceMs: 25, sigtermGraceMs: 25, pollIntervalMs: 5 },
      spawnPort: (_cmd, _args, options) => {
        expect(options.detached).toBe(true);
        procRef = new SimulatedChildProcess({
          pid: 99_001,
          onKillSignal: () => {
            // Stubborn process ignores direct kills until group SIGKILL
          },
        });
        return procRef;
      },
      sendSignal: (pid, signal) => {
        if (signal === 0) {
          if (!groupAlive) {
            const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
            throw err;
          }
          return;
        }
        sentSignals.push({ pid, signal });
        if (signal === 'SIGKILL') {
          groupAlive = false;
          procRef?.finishProcess(null, 'SIGKILL');
        }
      },
    });

    const tree = supervisor.spawn({
      command: 'claude',
      args: ['-p'],
      cwd: '/tmp',
    });

    await tree.terminate();

    expect(sentSignals).toEqual([
      { pid: -99_001, signal: 'SIGINT' },
      { pid: -99_001, signal: 'SIGTERM' },
      { pid: -99_001, signal: 'SIGKILL' },
    ]);
    expect(supervisor.activeCount).toBe(0);
  });

  it('uses taskkill /T /F on Windows when child does not exit on SIGINT', async () => {
    const taskkilledPids: number[] = [];
    let procRef: SimulatedChildProcess | null = null;

    const supervisor = new ProcessTreeSupervisor({
      platform: 'win32',
      registerExitHook: false,
      timings: { sigintGraceMs: 20, sigtermGraceMs: 20, pollIntervalMs: 5 },
      spawnPort: (file, args, options) => {
        expect(options.detached).toBe(false);
        expect(file.toLowerCase()).toContain('cmd.exe');
        expect(args.join(' ')).toContain('codex.cmd');
        procRef = new SimulatedChildProcess({
          pid: 51_200,
          onKillSignal: () => {
            // Ignore SIGINT so Windows taskkill /T /F runs
          },
        });
        return procRef;
      },
      windowsTreeKiller: async (pid) => {
        taskkilledPids.push(pid);
        procRef?.finishProcess(1, null);
      },
    });

    const tree = supervisor.spawn({
      command: 'C:\\npm\\codex.cmd',
      args: ['app-server'],
      cwd: 'C:\\proj',
      env: { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32' },
    });

    await tree.terminate();
    expect(taskkilledPids).toEqual([51_200]);
  });

  it('terminates real POSIX process groups including nested grandchild subagent processes', async () => {
    if (process.platform === 'win32') return;

    const supervisor = new ProcessTreeSupervisor({
      registerExitHook: false,
      timings: { sigintGraceMs: 80, sigtermGraceMs: 120, pollIntervalMs: 15 },
    });

    // Parent script spawns a stubborn grandchild that ignores SIGINT, prints grandchild PID, and sleeps.
    const parentScript = `
      const { spawn } = require('node:child_process');
      process.on('SIGINT', () => {});
      const child = spawn(process.execPath, ['-e', 'process.on("SIGINT", () => {}); setInterval(() => {}, 1000);'], {
        stdio: 'ignore',
      });
      process.stdout.write(String(child.pid) + '\\n');
      setInterval(() => {}, 1000);
    `;

    const tree = supervisor.spawn({
      command: process.execPath,
      args: ['-e', parentScript],
      cwd: os.tmpdir(),
    });

    const grandchildPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for grandchild PID')), 5_000);
      const splitter = new LineStreamSplitter((line) => {
        const parsed = Number(line.trim());
        if (Number.isInteger(parsed) && parsed > 0) {
          clearTimeout(timer);
          resolve(parsed);
        }
      });
      tree.stdout?.on('data', (chunk: Buffer | string) => splitter.feed(chunk));
    });

    // Verify grandchild is alive before terminate()
    expect(() => process.kill(grandchildPid, 0)).not.toThrow();

    await tree.terminate();

    // Verify grandchild was killed along with the process group (zero orphans!)
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });
});

describe('QuiescenceTracker', () => {
  it('holds waiting_children while subagents/bg tasks run and supports safety idle timeout fallback', async () => {
    const events: NormalizedRuntimeEvent[] = [];
    const tracker = new QuiescenceTracker({
      threadId: 'th-q1',
      safetyIdleTimeoutMs: 40,
      onEvent: (ev) => events.push(ev),
    });

    tracker.markTurnStarted();
    tracker.startSubagent({ id: 'sub-1', title: 'Audit auth', parentToolUseId: null });
    tracker.startBgTask({ taskId: 'bg-1', command: 'npm test' });

    const phaseAfterMain = tracker.settleMainTurn({
      externalSessionId: 'sess-q1',
      stopReason: 'end_turn',
    });
    expect(phaseAfterMain).toBe('waiting_children');
    expect(events.some((e) => e.type === 'quiescent_completed')).toBe(false);

    // Completing only sub-1 still keeps waiting_children because bg-1 is active
    tracker.completeSubagent({ id: 'sub-1' });
    expect(tracker.phase).toBe('waiting_children');
    expect(events.some((e) => e.type === 'quiescent_completed')).toBe(false);

    // Wait for safetyIdleTimeoutMs (40ms) when bg-1 never emits completion
    await new Promise((r) => setTimeout(r, 70));
    expect(tracker.phase).toBe('quiescent');
    const completed = events.find((e) => e.type === 'quiescent_completed');
    expect(completed).toMatchObject({
      type: 'quiescent_completed',
      externalSessionId: 'sess-q1',
      timedOut: true,
    });
  });
});

describe('ClaudeAdapter', () => {
  it('handles nested parent_tool_use_id quiescence, approvals, mid-turn stdin steering, and ephemeral MCP config', async () => {
    let capturedArgs: readonly string[] = [];
    let capturedEnv: NodeJS.ProcessEnv = {};
    let mcpFileContentDuringRun: string | null = null;
    let mcpFilePathCaptured: string | null = null;
    let activeSimProc: SimulatedChildProcess | null = null;

    let resolveReadyForSteer!: () => void;
    const readyForSteer = new Promise<void>((r) => {
      resolveReadyForSteer = r;
    });

    const spawnPort: ProcessSpawnPort = (_cmd, args, options) => {
      capturedArgs = args;
      capturedEnv = options.env ?? {};

      const mcpFlagIdx = args.indexOf('--mcp-config');
      if (mcpFlagIdx >= 0 && args[mcpFlagIdx + 1]) {
        mcpFilePathCaptured = args[mcpFlagIdx + 1]!;
        mcpFileContentDuringRun = readFileSync(mcpFilePathCaptured, 'utf8');
      }

      const proc = new SimulatedChildProcess({
        onStdinLine: (line, self) => {
          const parsed = JSON.parse(line) as Record<string, unknown>;

          // 1. Initial prompt frame arrives
          if (parsed.type === 'user' && self.writtenStdinLines.length === 1) {
            self.emitStdoutJson({
              type: 'system',
              subtype: 'init',
              session_id: 'claude-sess-888',
            });

            // Root assistant spawns two subagents: toolu_sub_1 (foreground/nested) and toolu_sub_2 (async background)
            self.emitStdoutJson({
              type: 'assistant',
              session_id: 'claude-sess-888',
              parent_tool_use_id: null,
              message: {
                id: 'msg_root_1',
                content: [
                  { type: 'thinking', thinking: 'Splitting parser and unit test tasks.' },
                  { type: 'text', text: 'Dispatching two subagents.' },
                  {
                    type: 'tool_use',
                    id: 'toolu_sub_1',
                    name: 'Agent',
                    input: { description: 'Inspect parser AST', subagent_type: 'Explore' },
                  },
                  {
                    type: 'tool_use',
                    id: 'toolu_sub_2',
                    name: 'Agent',
                    input: {
                      description: 'Run integration suite',
                      run_in_background: true,
                    },
                  },
                ],
              },
            });

            // Async launch acknowledgement for toolu_sub_2 (must NOT prematurely complete toolu_sub_2!)
            self.emitStdoutJson({
              type: 'user',
              parent_tool_use_id: null,
              tool_use_result: {
                isAsync: true,
                status: 'async_launched',
                agentId: 'bg_agent_42',
              },
              message: {
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'toolu_sub_2',
                    content: 'Async agent launched successfully.',
                  },
                ],
              },
            });

            // Nested tool call inside toolu_sub_1 (`parent_tool_use_id: 'toolu_sub_1'`)
            self.emitStdoutJson({
              type: 'assistant',
              session_id: 'claude-sess-888',
              parent_tool_use_id: 'toolu_sub_1',
              message: {
                id: 'msg_child_1',
                content: [
                  {
                    type: 'tool_use',
                    id: 'toolu_child_read',
                    name: 'Read',
                    input: { file_path: 'src/parser.ts' },
                  },
                ],
              },
            });

            // Request tool permission via stdio control_request
            self.emitStdoutJson({
              type: 'control_request',
              request_id: 'req_edit_1',
              request: {
                subtype: 'can_use_tool',
                tool_name: 'Edit',
                input: { file_path: 'src/parser.ts', new_string: 'export const ok = true;' },
              },
            });
            return;
          }

          // 2. Approval control_response arrives from adapter.respondApproval()
          if (parsed.type === 'control_response') {
            resolveReadyForSteer();
            return;
          }

          // 3. Mid-turn steer user frame arrives on stdin
          if (parsed.type === 'user' && self.writtenStdinLines.length > 1) {
            // Main turn settles BEFORE toolu_sub_1 and toolu_sub_2 finish!
            self.emitStdoutJson({
              type: 'result',
              subtype: 'success',
              session_id: 'claude-sess-888',
              is_error: false,
              total_cost_usd: 0.042,
              usage: {
                input_tokens: 1200,
                output_tokens: 340,
                cache_read_input_tokens: 800,
              },
            });
          }
        },
      });
      activeSimProc = proc;
      return proc;
    };

    const supervisor = new ProcessTreeSupervisor({ spawnPort, registerExitHook: false });
    const adapter = new ClaudeAdapter({ processSupervisor: supervisor });

    const observedEvents: NormalizedRuntimeEvent[] = [];
    let approvalTriggerResolve!: (reqId: string) => void;
    const approvalTriggered = new Promise<string>((r) => {
      approvalTriggerResolve = r;
    });
    let waitingChildrenResolve!: () => void;
    const waitingChildrenReached = new Promise<void>((r) => {
      waitingChildrenResolve = r;
    });

    const stream = adapter.startOrResumeTurn({
      threadId: 'thread-claude-1',
      cwd: '/workspace/proj',
      prompt: 'Fix parser edge cases',
      resumeSessionId: 'claude-prev-session',
      mcp: {
        httpUrl: 'http://127.0.0.1:43110/mcp',
        bearerToken: 'tok-claude-99',
        shimBinDir: '/tmp/mesh-shims',
      },
      onEvent: (ev) => {
        observedEvents.push(ev);
        if (ev.type === 'approval_requested') {
          approvalTriggerResolve(ev.requestId);
        }
        if (ev.type === 'waiting_children') {
          waitingChildrenResolve();
        }
      },
    });

    const consumerPromise = collectEvents(stream);

    // Wait for approval_requested and approve it
    const reqId = await approvalTriggered;
    expect(reqId).toBe('req_edit_1');
    const approvalEvent = observedEvents.find((e) => e.type === 'approval_requested');
    expect(approvalEvent).toMatchObject({
      type: 'approval_requested',
      toolName: 'Edit',
      targetPath: 'src/parser.ts',
    });

    const approvedOk = await adapter.respondApproval('thread-claude-1', reqId, 'allow_once');
    expect(approvedOk).toBe(true);

    await readyForSteer;
    const controlRespLine = activeSimProc!.writtenStdinLines.find((l) =>
      l.includes('"control_response"'),
    );
    expect(controlRespLine).toBeDefined();
    expect(JSON.parse(controlRespLine!)).toMatchObject({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req_edit_1',
        response: {
          behavior: 'allow',
          updatedInput: { file_path: 'src/parser.ts', new_string: 'export const ok = true;' },
        },
      },
    });

    // Steer mid-turn via stdin JSON frame
    const steerRes = await adapter.steer('thread-claude-1', 'Use randomized 150-300ms backoff');
    expect(steerRes).toEqual({ accepted: true, mode: 'stdin_frame' });

    // Wait for main `result` to arrive -> MUST enter `waiting_children`, NOT `quiescent_completed`!
    await waitingChildrenReached;
    expect(observedEvents.some((e) => e.type === 'quiescent_completed')).toBe(false);
    const waitingEv = observedEvents.find((e) => e.type === 'waiting_children')!;
    if (waitingEv.type === 'waiting_children') {
      expect(waitingEv.activeSubagents.map((s) => s.id)).toEqual(['toolu_sub_1', 'toolu_sub_2']);
    }

    // Complete first subagent (`toolu_sub_1`) -> STILL waiting on `toolu_sub_2`!
    activeSimProc!.emitStdoutJson({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_sub_1',
            content: 'AST inspection done',
          },
        ],
      },
    });
    expect(observedEvents.some((e) => e.type === 'quiescent_completed')).toBe(false);

    // Complete second background subagent via `task_notification` referencing `bg_agent_42` -> IMMEDIATELY emits `quiescent_completed`!
    activeSimProc!.emitStdoutJson({
      type: 'task_notification',
      task_id: 'bg_agent_42',
      status: 'completed',
      summary: 'All 28 integration tests passed',
    });
    activeSimProc!.finishProcess(0);

    const allEvents = await consumerPromise;
    const types = allEvents.map((e) => e.type);

    // Verify causal ordering: waiting_children BEFORE subagent_completed(2) BEFORE quiescent_completed
    const idxWaiting = types.indexOf('waiting_children');
    const idxQuiescent = types.indexOf('quiescent_completed');
    expect(idxWaiting).toBeGreaterThan(-1);
    expect(idxQuiescent).toBeGreaterThan(idxWaiting);

    // Verify CLI flags, env, and ephemeral MCP file cleanup
    expect(capturedArgs).toEqual(
      expect.arrayContaining([
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--resume',
        'claude-prev-session',
        '--mcp-config',
      ]),
    );
    expect(capturedEnv.DSTU_MESH_TOKEN).toBe('tok-claude-99');
    expect(capturedEnv.PATH?.startsWith('/tmp/mesh-shims')).toBe(true);
    expect(mcpFileContentDuringRun).not.toBeNull();
    expect(JSON.parse(mcpFileContentDuringRun!)).toMatchObject({
      mcpServers: {
        dstu_mesh: {
          type: 'http',
          url: 'http://127.0.0.1:43110/mcp',
          headers: { Authorization: 'Bearer tok-claude-99' },
        },
      },
    });

    // Ephemeral MCP config file must be cleaned up after turn completion
    await expect(fs.stat(mcpFilePathCaptured!)).rejects.toThrow();
    await adapter.dispose();
  });
});

describe('CodexAdapter', () => {
  it('drives codex app-server JSON-RPC 2.0: initialize, thread/start, turn/start, turn/steer, and approval round-trip', async () => {
    let capturedArgs: readonly string[] = [];
    let capturedEnv: NodeJS.ProcessEnv = {};
    const rpcMethodsSeen: string[] = [];
    let steerPayloadSeen: Record<string, unknown> | null = null;
    let approvalDecisionSeen: Record<string, unknown> | null = null;
    let simProc: SimulatedChildProcess | null = null;

    const spawnPort: ProcessSpawnPort = (_cmd, args, options) => {
      capturedArgs = args;
      capturedEnv = options.env ?? {};
      const proc = new SimulatedChildProcess({
        onStdinLine: (line, self) => {
          const rpc = JSON.parse(line) as Record<string, unknown>;
          const method = rpc.method as string | undefined;
          const id = rpc.id as number | string | undefined;

          if (method) {
            rpcMethodsSeen.push(method);
          }

          if (method === 'initialize') {
            self.emitStdoutJson({
              jsonrpc: '2.0',
              id,
              result: { serverInfo: { name: 'codex-app-server', version: '0.116.0' } },
            });
            return;
          }

          if (method === 'thread/start') {
            self.emitStdoutJson({
              jsonrpc: '2.0',
              id,
              result: { thread: { id: 'codex-thread-77' } },
            });
            return;
          }

          if (method === 'turn/start') {
            self.emitStdoutJson({
              jsonrpc: '2.0',
              id,
              result: { turn: { id: 'codex-turn-1', status: 'inProgress' } },
            });
            self.emitStdoutJson({
              jsonrpc: '2.0',
              method: 'item/reasoning/summaryTextDelta',
              params: { delta: 'Checking Raft election timeout...' },
            });
            self.emitStdoutJson({
              jsonrpc: '2.0',
              method: 'item/agentMessage/delta',
              params: { itemId: 'msg-1', delta: 'Updating heartbeat timer. ' },
            });
            // Server -> Client approval request
            self.emitStdoutJson({
              jsonrpc: '2.0',
              id: 'srv-approval-9',
              method: 'item/commandExecution/requestApproval',
              params: {
                threadId: 'codex-thread-77',
                turnId: 'codex-turn-1',
                command: 'npm run test:raft',
                reason: 'Run raft test suite',
              },
            });
            return;
          }

          if (method === 'turn/steer') {
            steerPayloadSeen = rpc.params as Record<string, unknown>;
            self.emitStdoutJson({
              jsonrpc: '2.0',
              id,
              result: { turnId: 'codex-turn-1' },
            });
            self.emitStdoutJson({
              jsonrpc: '2.0',
              method: 'item/agentMessage/delta',
              params: { itemId: 'msg-1', delta: 'Applied 150-300ms jitter.' },
            });
            self.emitStdoutJson({
              jsonrpc: '2.0',
              method: 'thread/tokenUsage/updated',
              params: {
                tokenUsage: {
                  total: { inputTokens: 640, outputTokens: 190, cachedInputTokens: 200 },
                },
              },
            });
            self.emitStdoutJson({
              jsonrpc: '2.0',
              method: 'turn/completed',
              params: { turn: { id: 'codex-turn-1', status: 'completed' } },
            });
            return;
          }

          // Client -> Server approval response
          if (!method && id === 'srv-approval-9') {
            approvalDecisionSeen = rpc.result as Record<string, unknown>;
          }
        },
      });
      simProc = proc;
      return proc;
    };

    const supervisor = new ProcessTreeSupervisor({ spawnPort, registerExitHook: false });
    const adapter = new CodexAdapter({ processSupervisor: supervisor });

    let approvalResolve!: (reqId: string) => void;
    const approvalPromise = new Promise<string>((r) => {
      approvalResolve = r;
    });

    const stream = adapter.startOrResumeTurn({
      threadId: 'th-codex-1',
      cwd: '/workspace/raft',
      prompt: 'Implement election timer',
      mcp: {
        httpUrl: 'http://127.0.0.1:49999/mcp',
        bearerToken: 'codex-tok-1',
        shimBinDir: '/tmp/codex-shim',
      },
      onEvent: (ev) => {
        if (ev.type === 'approval_requested') {
          approvalResolve(ev.requestId);
        }
      },
    });

    const allEventsPromise = collectEvents(stream);

    const approvalId = await approvalPromise;
    expect(approvalId).toBe('srv-approval-9');
    const approved = await adapter.respondApproval('th-codex-1', approvalId, 'allow_for_session');
    expect(approved).toBe(true);

    // Give stdin flush a microtask, then send mid-turn steer
    await new Promise((r) => setTimeout(r, 10));
    expect(approvalDecisionSeen).toEqual({
      decision: 'acceptForSession',
      approved: true,
    });

    const steerOut = await adapter.steer('th-codex-1', 'Switch heartbeat to 150-300ms');
    expect(steerOut).toEqual({ accepted: true, mode: 'native_steer' });
    expect(steerPayloadSeen).toMatchObject({
      threadId: 'codex-thread-77',
      expectedTurnId: 'codex-turn-1',
      input: [{ type: 'text', text: 'Switch heartbeat to 150-300ms' }],
    });

    const events = await allEventsPromise;
    expect(rpcMethodsSeen).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
      'turn/steer',
    ]);

    expect(capturedArgs).toEqual([
      '-c',
      'mcp_servers.dstu_mesh.url="http://127.0.0.1:49999/mcp"',
      '-c',
      'mcp_servers.dstu_mesh.bearer_token_env_var="DSTU_MESH_TOKEN"',
      'app-server',
    ]);
    expect(capturedEnv.DSTU_MESH_TOKEN).toBe('codex-tok-1');

    const textCombined = events
      .filter((e): e is Extract<NormalizedRuntimeEvent, { type: 'assistant_delta' }> => e.type === 'assistant_delta')
      .map((e) => e.text)
      .join('');
    expect(textCombined).toBe('Updating heartbeat timer. Applied 150-300ms jitter.');
    expect(events.some((e) => e.type === 'quiescent_completed')).toBe(true);
    expect(simProc).not.toBeNull();

    await adapter.dispose();
  });

  it('automatically falls back to `codex exec --json` when `app-server` subcommand is unavailable', async () => {
    const invocations: string[][] = [];

    const spawnPort: ProcessSpawnPort = (_cmd, args) => {
      invocations.push([...args]);
      const proc = new SimulatedChildProcess();
      if (args.includes('app-server')) {
        queueMicrotask(() => {
          proc.stderr.write("error: unrecognized subcommand 'app-server'\n");
          proc.finishProcess(2);
        });
      } else {
        queueMicrotask(() => {
          proc.emitStdoutJson({ type: 'thread.started', thread_id: 'exec-thread-55' });
          proc.emitStdoutJson({
            type: 'item.completed',
            item: { id: 'm1', type: 'agent_message', text: 'Fallback exec succeeded.' },
          });
          proc.emitStdoutJson({
            type: 'turn.completed',
            usage: { input_tokens: 100, output_tokens: 25 },
          });
          proc.finishProcess(0);
        });
      }
      return proc;
    };

    const supervisor = new ProcessTreeSupervisor({ spawnPort, registerExitHook: false });
    const adapter = new CodexAdapter({ processSupervisor: supervisor });

    const events = await collectEvents(
      adapter.startOrResumeTurn({
        threadId: 'th-codex-fallback',
        cwd: '/workspace/proj',
        prompt: 'Explain deadlock',
        resumeSessionId: 'prev-exec-55',
      }),
    );

    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toContain('app-server');
    expect(invocations[1]).toEqual(['exec', '--json', 'resume', 'prev-exec-55', 'Explain deadlock']);
    expect(events.find((e) => e.type === 'session_bound')).toMatchObject({
      externalSessionId: 'exec-thread-55',
    });
    expect(events.find((e) => e.type === 'assistant_delta')).toMatchObject({
      text: 'Fallback exec succeeded.',
    });
    expect(events.some((e) => e.type === 'quiescent_completed')).toBe(true);

    await adapter.dispose();
  });
});

describe('OpenCodeAdapter', () => {
  it('streams JSON events in CLI mode (`opencode run --format json --session <sid>`) with inline MCP config', async () => {
    let capturedArgs: readonly string[] = [];
    let capturedEnv: NodeJS.ProcessEnv = {};

    const spawnPort: ProcessSpawnPort = (_cmd, args, options) => {
      capturedArgs = args;
      capturedEnv = options.env ?? {};
      const proc = new SimulatedChildProcess();
      queueMicrotask(() => {
        proc.emitStdoutJson({
          type: 'text',
          sessionID: 'ses_opencode_1',
          part: { id: 'p1', type: 'text', text: 'Refactored sync handler.' },
        });
        proc.emitStdoutJson({
          type: 'step_finish',
          sessionID: 'ses_opencode_1',
          part: { tokens: { input: 500, output: 120, cache: { read: 50 } }, cost: 0.01 },
        });
        proc.finishProcess(0);
      });
      return proc;
    };

    const supervisor = new ProcessTreeSupervisor({ spawnPort, registerExitHook: false });
    const adapter = new OpenCodeAdapter({ processSupervisor: supervisor });

    const events = await collectEvents(
      adapter.startOrResumeTurn({
        threadId: 'th-oc-1',
        cwd: '/workspace/app',
        prompt: 'Refactor sync handler',
        resumeSessionId: 'ses_prev_0',
        mcp: {
          httpUrl: 'http://127.0.0.1:41234/mcp',
          bearerToken: 'oc-bearer-1',
          shimBinDir: '/tmp/oc-shim',
        },
      }),
    );

    expect(capturedArgs).toEqual([
      'run',
      '--format',
      'json',
      '--session',
      'ses_prev_0',
      'Refactor sync handler',
    ]);
    expect(JSON.parse(capturedEnv.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      mcp: {
        dstu_mesh: {
          type: 'remote',
          url: 'http://127.0.0.1:41234/mcp',
          headers: { Authorization: 'Bearer oc-bearer-1' },
        },
      },
    });
    expect(events.find((e) => e.type === 'assistant_delta')).toMatchObject({
      text: 'Refactored sync handler.',
    });
    expect(events.some((e) => e.type === 'quiescent_completed')).toBe(true);
    await adapter.dispose();
  });

  it('supports HTTP/SSE Server mode with mid-turn steer and permission approval', async () => {
    const httpCalls: Array<{ url: string; method: string; body?: unknown }> = [];
    const encoder = new TextEncoder();
    let sseController!: ReadableStreamDefaultController<Uint8Array>;

    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        sseController = controller;
      },
    });

    const pushSse = (payload: unknown): void => {
      sseController.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    };

    const customFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const parsedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      httpCalls.push({ url, method, body: parsedBody });

      if (url.endsWith('/session') && method === 'POST') {
        return new Response(JSON.stringify({ id: 'oc_srv_sess_9' }), { status: 200 });
      }
      if (url.endsWith('/event')) {
        return new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (url.endsWith('/prompt_async') && httpCalls.filter((c) => c.url.endsWith('/prompt_async')).length === 1) {
        queueMicrotask(() => {
          pushSse({
            type: 'message.part.updated',
            properties: {
              sessionID: 'oc_srv_sess_9',
              part: { id: 'prt_1', sessionID: 'oc_srv_sess_9', type: 'text', text: 'Step 1. ' },
            },
          });
          pushSse({
            type: 'permission.asked',
            properties: {
              id: 'perm_77',
              sessionID: 'oc_srv_sess_9',
              tool: 'bash',
              title: 'Run migration check',
              metadata: { command: 'node scripts/check-migrations.mjs' },
            },
          });
        });
        return new Response('{}', { status: 200 });
      }
      if (url.includes('/permissions/perm_77')) {
        return new Response('{}', { status: 200 });
      }
      if (url.endsWith('/prompt_async')) {
        queueMicrotask(() => {
          pushSse({
            type: 'message.part.updated',
            properties: {
              sessionID: 'oc_srv_sess_9',
              part: {
                id: 'prt_1',
                sessionID: 'oc_srv_sess_9',
                type: 'text',
                text: 'Step 1. Step 2 steered.',
              },
            },
          });
          pushSse({
            type: 'session.idle',
            properties: { sessionID: 'oc_srv_sess_9' },
          });
        });
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const adapter = new OpenCodeAdapter({
      serverUrl: 'http://127.0.0.1:4096',
      fetchImpl: customFetch,
    });
    expect(adapter.capabilities.midTurnSteer).toBe(true);
    expect(adapter.capabilities.approvalCallback).toBe(true);

    let permResolve!: (id: string) => void;
    const permPromise = new Promise<string>((r) => {
      permResolve = r;
    });

    const stream = adapter.startOrResumeTurn({
      threadId: 'th-oc-srv',
      cwd: '/workspace/app',
      prompt: 'Verify migrations',
      onEvent: (ev) => {
        if (ev.type === 'approval_requested') permResolve(ev.requestId);
      },
    });
    const eventsPromise = collectEvents(stream);

    const permId = await permPromise;
    expect(permId).toBe('perm_77');
    expect(await adapter.respondApproval('th-oc-srv', permId, 'allow_once')).toBe(true);

    const steerRes = await adapter.steer('th-oc-srv', 'Also check schema parity');
    expect(steerRes).toEqual({ accepted: true, mode: 'native_steer' });

    const events = await eventsPromise;
    const fullText = events
      .filter((e): e is Extract<NormalizedRuntimeEvent, { type: 'assistant_delta' }> => e.type === 'assistant_delta')
      .map((e) => e.text)
      .join('');
    expect(fullText).toBe('Step 1. Step 2 steered.');
    expect(events.some((e) => e.type === 'quiescent_completed')).toBe(true);

    await adapter.dispose();
  });
});

describe('PiAdapter', () => {
  it('drives `pi --mode rpc` with streaming deltas, tool execution, approval callback, and mid-turn steer', async () => {
    let capturedArgs: readonly string[] = [];
    const stdinCommands: Array<Record<string, unknown>> = [];

    const spawnPort: ProcessSpawnPort = (_cmd, args) => {
      capturedArgs = args;
      const proc = new SimulatedChildProcess({
        onStdinLine: (line, self) => {
          const cmd = JSON.parse(line) as Record<string, unknown>;
          stdinCommands.push(cmd);

          if (cmd.type === 'prompt') {
            self.emitStdoutJson({
              type: 'response',
              id: cmd.id,
              command: 'prompt',
              success: true,
              data: { sessionFile: '/sessions/pi-sess-42.jsonl' },
            });
            self.emitStdoutJson({
              type: 'message_update',
              assistantMessageEvent: { type: 'thinking_delta', delta: 'Inspecting state...' },
            });
            self.emitStdoutJson({
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: 'Running test. ' },
            });
            self.emitStdoutJson({
              type: 'tool_execution_start',
              toolCallId: 'pi_call_1',
              toolName: 'bash',
              args: { command: 'vitest run' },
            });
            self.emitStdoutJson({
              type: 'extension_ui_request',
              id: 'pi_confirm_1',
              method: 'confirm',
              title: 'bash',
              message: 'Allow running vitest?',
              input: { command: 'vitest run' },
            });
            return;
          }

          if (cmd.type === 'extension_ui_response') {
            self.emitStdoutJson({
              type: 'tool_execution_end',
              toolCallId: 'pi_call_1',
              toolName: 'bash',
              result: '12 passed',
              isError: false,
            });
            return;
          }

          if (cmd.type === 'steer') {
            self.emitStdoutJson({
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: 'Steered summary complete.' },
            });
            self.emitStdoutJson({
              type: 'turn_end',
              message: { usage: { input: 310, output: 85, cacheRead: 100, cost: { total: 0.008 } } },
            });
            self.emitStdoutJson({ type: 'agent_end' });
          }
        },
      });
      return proc;
    };

    const supervisor = new ProcessTreeSupervisor({ spawnPort, registerExitHook: false });
    const adapter = new PiAdapter({ processSupervisor: supervisor });

    let confirmResolve!: (id: string) => void;
    const confirmPromise = new Promise<string>((r) => {
      confirmResolve = r;
    });

    const stream = adapter.startOrResumeTurn({
      threadId: 'th-pi-1',
      cwd: '/workspace/pi-proj',
      prompt: 'Run unit tests',
      resumeSessionId: '/sessions/pi-sess-42.jsonl',
      onEvent: (ev) => {
        if (ev.type === 'approval_requested') confirmResolve(ev.requestId);
      },
    });
    const collectPromise = collectEvents(stream);

    const confirmId = await confirmPromise;
    expect(confirmId).toBe('pi_confirm_1');
    expect(await adapter.respondApproval('th-pi-1', confirmId, 'allow_once')).toBe(true);

    const steerRes = await adapter.steer('th-pi-1', 'Add concise summary');
    expect(steerRes).toEqual({ accepted: true, mode: 'native_steer' });

    const events = await collectPromise;
    expect(capturedArgs).toEqual(['--mode', 'rpc', '--session', '/sessions/pi-sess-42.jsonl']);
    expect(stdinCommands.map((c) => c.type)).toEqual([
      'prompt',
      'extension_ui_response',
      'steer',
    ]);

    const combinedText = events
      .filter((e): e is Extract<NormalizedRuntimeEvent, { type: 'assistant_delta' }> => e.type === 'assistant_delta')
      .map((e) => e.text)
      .join('');
    expect(combinedText).toBe('Running test. Steered summary complete.');
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      inputTokens: 310,
      outputTokens: 85,
      cachedInputTokens: 100,
    });
    expect(events.some((e) => e.type === 'quiescent_completed')).toBe(true);

    await adapter.dispose();
  });
});

describe('GenericCliAdapter & ExternalAdapterRegistry', () => {
  it('supports agy, dsh, and CustomCliTemplate with JSON-line auto-detection, plain-text fallback, and honest capabilities', async () => {
    const spawnedCalls: Array<{ cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];

    const spawnPort: ProcessSpawnPort = (cmd, args, options) => {
      spawnedCalls.push({ cmd, args, env: options.env ?? {} });
      const proc = new SimulatedChildProcess();
      queueMicrotask(() => {
        if (cmd === 'agy') {
          // Plain-text multi-line output
          proc.emitStdoutText('Analyzing workspace...\nPatch applied cleanly to 2 files.\n');
          proc.finishProcess(0);
        } else if (cmd === 'dsh') {
          // Structured JSONL output
          proc.emitStdoutJson({ type: 'init', session_id: 'dsh-sess-101' });
          proc.emitStdoutJson({ type: 'thinking', text: 'Checking invariants' });
          proc.emitStdoutJson({ type: 'assistant', text: 'DSH verification passed.' });
          proc.emitStdoutJson({ type: 'usage', input_tokens: 220, output_tokens: 45 });
          proc.emitStdoutJson({ type: 'done' });
          proc.finishProcess(0);
        } else {
          // Custom CLI template
          proc.emitStdoutText('Custom agent output ok\n');
          proc.finishProcess(0);
        }
      });
      return proc;
    };

    const registry = new ExternalAdapterRegistry({
      supervisorOptions: { spawnPort, registerExitHook: false },
    });

    const agyAdapter = registry.getAdapter('agy');
    expect(agyAdapter.capabilities.midTurnSteer).toBe(false);
    expect(await agyAdapter.steer('th-agy', 'steer attempt')).toMatchObject({
      accepted: false,
      mode: 'unsupported',
    });

    const agyEvents = await collectEvents(
      registry.startTurn('agy', {
        threadId: 'th-agy',
        cwd: '/workspace/demo',
        prompt: 'Apply lint fix',
        mcp: {
          httpUrl: 'http://127.0.0.1:45555/mcp',
          bearerToken: 'agy-shim-token',
          shimBinDir: '/tmp/agy-shim-bin',
        },
      }),
    );

    const agyText = agyEvents
      .filter((e): e is Extract<NormalizedRuntimeEvent, { type: 'assistant_delta' }> => e.type === 'assistant_delta')
      .map((e) => e.text)
      .join('');
    expect(agyText).toBe('Analyzing workspace...\nPatch applied cleanly to 2 files.');
    expect(spawnedCalls[0]?.args).toEqual(['--prompt', 'Apply lint fix']);
    expect(spawnedCalls[0]?.env.DSTU_MESH_TOKEN).toBe('agy-shim-token');
    expect(spawnedCalls[0]?.env.PATH?.startsWith('/tmp/agy-shim-bin')).toBe(true);

    // DSH with resumeSessionId + JSONL auto-detection
    const dshEvents = await collectEvents(
      registry.startTurn('dsh', {
        threadId: 'th-dsh',
        cwd: '/workspace/demo',
        prompt: 'Verify invariants',
        resumeSessionId: 'dsh-sess-100',
      }),
    );
    expect(spawnedCalls[1]?.args).toEqual([
      'run',
      '--resume',
      'dsh-sess-100',
      '--prompt',
      'Verify invariants',
    ]);
    expect(dshEvents.find((e) => e.type === 'session_bound')).toMatchObject({
      externalSessionId: 'dsh-sess-101',
    });
    expect(dshEvents.find((e) => e.type === 'thinking_delta')).toMatchObject({
      text: 'Checking invariants',
    });
    expect(dshEvents.find((e) => e.type === 'assistant_delta')).toMatchObject({
      text: 'DSH verification passed.',
    });

    // Custom CLI template via registry
    registry.registerCustomTemplate({
      id: 'local-runner',
      name: 'Local Runner',
      command: 'local-runner-bin',
      argsTemplate: ['--cwd', '{{cwd}}', '--ask', '{{prompt}}'],
    });
    const customEvents = await collectEvents(
      registry.startTurn('custom:local-runner', {
        threadId: 'th-custom',
        cwd: '/workspace/custom-dir',
        prompt: 'Hello custom',
      }),
    );
    expect(spawnedCalls[2]?.cmd).toBe('local-runner-bin');
    expect(spawnedCalls[2]?.args).toEqual(['--cwd', '/workspace/custom-dir', '--ask', 'Hello custom']);
    expect(customEvents.some((e) => e.type === 'quiescent_completed')).toBe(true);

    // Direct constructor check for GenericCliAdapter requiring template when driver='custom'
    expect(() => new GenericCliAdapter({ driver: 'custom' })).toThrow();

    await registry.dispose();
  });

  it('forwards prober resolvedPath to ClaudeAdapter, CodexAdapter, and GenericCliAdapter even if getAdapter was called before probeAgents', async () => {
    const spawnedCommands: string[] = [];

    const registry = new ExternalAdapterRegistry({
      proberOptions: {
        fileExists: async () => false,
        env: { ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai', PATH: '/usr/bin:/bin' },
        homeDir: '/Users/dev',
        commandRunner: async (cmd, args) => {
          if (cmd === 'claude' && args[0] === '--version') {
            return {
              exitCode: 0,
              stdout: '2.1.90 (Claude Code)',
              stderr: '',
              resolvedPath: '/Users/dev/.local/bin/claude',
            };
          }
          if (cmd === 'codex' && args[0] === '--version') {
            return {
              exitCode: 0,
              stdout: 'codex-cli 0.119.0',
              stderr: '',
              resolvedPath: '/Users/dev/.grok/bin/codex',
            };
          }
          if (cmd === 'codex' && args[0] === 'app-server') {
            return {
              exitCode: 2,
              stdout: '',
              stderr: 'unrecognized subcommand app-server',
              resolvedPath: '/Users/dev/.grok/bin/codex',
            };
          }
          if (cmd === 'agy' && args[0] === '--version') {
            return {
              exitCode: 0,
              stdout: 'agy 2.1.0',
              stderr: '',
              resolvedPath: '/opt/homebrew/bin/agy',
            };
          }
          return { exitCode: null, stdout: '', stderr: '', notFound: true };
        },
      },
      supervisorOptions: {
        registerExitHook: false,
        spawnPort: (cmd) => {
          spawnedCommands.push(cmd);
          const proc = new SimulatedChildProcess();
          setImmediate(() => {
            proc.stdout.write('ok\n');
            proc.exitCode = 0;
            proc.emit('close', 0, null);
          });
          return proc;
        },
      },
    });

    // Call getAdapter BEFORE probeAgents runs (cached with default bare command)
    const preProbeCodex = registry.getAdapter('codex');
    const preProbeClaude = registry.getAdapter('claude');
    expect(preProbeCodex).toBeDefined();
    expect(preProbeClaude).toBeDefined();

    // Now probeAgents discovers absolute paths in ~/.grok/bin, ~/.local/bin, /opt/homebrew/bin
    await registry.probeAgents(true);

    // Subsequent getAdapter must recreate idle adapters with the probed resolvedPath!
    const postProbeCodex = registry.getAdapter('codex');
    const postProbeClaude = registry.getAdapter('claude');
    const postProbeAgy = registry.getAdapter('agy');
    expect(postProbeCodex).not.toBe(preProbeCodex);
    expect(postProbeClaude).not.toBe(preProbeClaude);
    expect((postProbeAgy as GenericCliAdapter).template.command).toBe('/opt/homebrew/bin/agy');

    await collectEvents(
      registry.startTurn('claude', {
        threadId: 'th-claude-path',
        cwd: '/workspace/demo',
        prompt: 'ping claude',
      }),
    );
    await collectEvents(
      registry.startTurn('agy', {
        threadId: 'th-agy-path',
        cwd: '/workspace/demo',
        prompt: 'ping agy',
      }),
    );

    expect(spawnedCommands).toContain('/Users/dev/.local/bin/claude');
    expect(spawnedCommands).toContain('/opt/homebrew/bin/agy');

    await registry.dispose();
  });
});

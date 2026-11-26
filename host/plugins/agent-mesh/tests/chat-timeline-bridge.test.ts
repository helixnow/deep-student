import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { MigrationCoordinator } from '../../../platform/storage/migration/coordinator.ts';
import { StorageServiceImpl } from '../../../platform/storage/service.ts';
import { AgentToolExecutorRegistry } from '../../agent-skills/api.ts';
import chatPlugin from '../../chat/index.ts';
import {
  EVENT_PHASE,
  EVENT_TYPE,
  SESSION_EVENT_TYPE,
  type BackendEvent,
  type SessionEvent,
} from '../../chat/api.ts';
import agentMeshPlugin, { createMeshOrchestrator } from '../index.ts';
import {
  DEFAULT_BUILTIN_COORDINATOR_AGENT,
  DefaultInMemoryFileLeasePort,
  type AdapterCapabilities,
  type AdapterRegistryPort,
  type CheckpointPort,
  type DetectedCliAgent,
  type ExternalCodingAdapter,
  type ExternalTurnStartInput,
  type MeshCheckpointRecord,
  type MeshDiffReport,
  type NormalizedRuntimeEvent,
} from '../src/contracts.ts';

function createRealChatStorage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dstu-mesh-native-timeline-'));
  const storage = new StorageServiceImpl({ baseDir: root, dataLocalDir: root });
  const coordinator = new MigrationCoordinator({
    appDataDir: storage.locations.activeDir,
    auditDbPath: null,
  });
  const report = coordinator.migrateSingle('chat_v2');
  if (!report.success) {
    throw new Error(`chat_v2 migration failed: ${JSON.stringify(report)}`);
  }
  return {
    root,
    storage,
    dispose() {
      storage.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const vfsStub = {
  version: 1 as const,
  database: {
    getConnSafe(): never {
      throw new Error('vfsStub unused');
    },
  },
};

function defaultCaps(): AdapterCapabilities {
  return {
    streamingEvents: true,
    midTurnSteer: true,
    interrupt: true,
    approvalCallback: true,
    sessionResume: true,
    sessionFork: false,
    nativeSubagentTree: true,
    backgroundTaskEvents: true,
    mcpInjection: true,
  };
}

class ScriptedCliAdapter implements ExternalCodingAdapter {
  readonly capabilities = defaultCaps();
  readonly startedInputs: ExternalTurnStartInput[] = [];

  constructor(
    private readonly runScript: (
      input: ExternalTurnStartInput,
    ) => AsyncGenerator<NormalizedRuntimeEvent, void, unknown>,
  ) {}

  startOrResumeTurn(input: ExternalTurnStartInput): AsyncIterable<NormalizedRuntimeEvent> {
    this.startedInputs.push(input);
    return this.runScript(input);
  }

  steer(): boolean {
    return false;
  }

  interrupt(): void {
    // Signal handles abort in scripted generator.
  }
}

class StaticDiffCheckpointPort implements CheckpointPort {
  private seq = 0;
  readonly capturedRoots: string[] = [];

  constructor(private readonly diffToReturn: MeshDiffReport) {}

  async captureCheckpoint(input: {
    chatSessionId: string;
    threadId: string;
    agentId: string;
    rosterName?: string | null;
    rootPath: string;
    turnSeq: number;
    kind: 'before' | 'after';
  }): Promise<MeshCheckpointRecord> {
    this.capturedRoots.push(input.rootPath);
    return {
      checkpointId: `chk_${++this.seq}_${input.kind}`,
      chatSessionId: input.chatSessionId,
      threadId: input.threadId,
      agentId: input.agentId,
      rosterName: input.rosterName ?? null,
      rootPath: input.rootPath,
      turnSeq: input.turnSeq,
      kind: input.kind,
      ref: `ref_${this.seq}_${input.kind}`,
      isGit: true,
      postTurnHashes: {},
      createdAt: new Date().toISOString(),
    };
  }

  async diffCheckpoints(): Promise<MeshDiffReport> {
    return this.diffToReturn;
  }

  async revertToCheckpoint() {
    return { revertedPaths: [], skippedUserModifiedPaths: [] };
  }
}

describe('Native Chat V2 Timeline Bridge & Safe Scratch Workspace', () => {
  let fixture: ReturnType<typeof createRealChatStorage>;

  beforeEach(() => {
    fixture = createRealChatStorage();
  });

  afterEach(() => {
    fixture.dispose();
  });

  it('persists UserMessage, AssistantMessage, interleaved Thinking/Tool/Subagent/Content blocks + Diff footer into real dstu.chat SQLite DB and emits ordered chat_v2_session_* & chat_v2_event_* events', async () => {
    const codexAdapter = new ScriptedCliAdapter(async function* () {
      yield { type: 'session_bound', externalSessionId: 'codex_sess_01' };
      yield { type: 'thinking_delta', text: 'Inspecting AST... ' };
      yield { type: 'thinking_delta', text: 'found root cause.' };
      yield {
        type: 'tool_call_start',
        callId: 'call_read_1',
        toolName: 'read_file',
        args: { path: 'src/parser.ts' },
      };
      yield {
        type: 'tool_call_end',
        callId: 'call_read_1',
        toolName: 'read_file',
        output: 'export const parse = () => null;',
        isError: false,
      };
      yield {
        type: 'subagent_started',
        childId: 'child_verifier_1',
        title: 'Run edge-case verifier',
      };
      yield {
        type: 'subagent_completed',
        childId: 'child_verifier_1',
        summary: 'Verified 6 parser edge cases',
      };
      yield { type: 'assistant_delta', text: 'Fixed the parser bug in ' };
      yield { type: 'assistant_delta', text: '`src/parser.ts`.' };
      yield { type: 'usage', inputTokens: 240, outputTokens: 85 };
      yield { type: 'turn_settled', summary: 'end_turn' };
    });

    const adapterRegistry: AdapterRegistryPort = {
      probeCalls: 0,
      async probeAgents(): Promise<DetectedCliAgent[]> {
        (this as { probeCalls: number }).probeCalls += 1;
        return [
          DEFAULT_BUILTIN_COORDINATOR_AGENT,
          {
            id: 'codex',
            kind: 'codex',
            name: 'Codex CLI',
            displayName: 'Codex CLI',
            command: 'codex',
            executablePath: '/Users/dev/.grok/bin/codex',
            installed: true,
            authenticated: true,
            version: '0.118.0',
            capabilities: defaultCaps(),
          },
        ];
      },
      getAdapter(agentId: string) {
        return agentId === 'codex' ? codexAdapter : null;
      },
    } as AdapterRegistryPort & { probeCalls: number };

    const checkpoints = new StaticDiffCheckpointPort({
      fromRef: 'ref_1_before',
      toRef: 'ref_2_after',
      totalAdditions: 19,
      totalDeletions: 4,
      files: [
        {
          path: 'src/parser.ts',
          status: 'modified',
          additions: 15,
          deletions: 4,
          patch: '@@ -1,4 +1,15 @@\n+export const parse = () => true;',
          attributedAgentId: 'codex',
        },
        {
          path: 'tests/parser.test.ts',
          status: 'added',
          additions: 4,
          deletions: 0,
          patch: '@@ -0,0 +1,4 @@\n+expect(parse()).toBe(true);',
          attributedAgentId: 'codex',
        },
      ],
    });

    const executorRegistry = new AgentToolExecutorRegistry();
    const workspaceDir = path.join(fixture.root, 'project');
    await fsp.mkdir(workspaceDir, { recursive: true });

    const host = await createTestHost({
      provide: {
        paths: { appDataDir: fixture.root },
        storage: fixture.storage,
        vfs: vfsStub,
        agentTools: {
          registerToolExecutors: (execs: Parameters<typeof executorRegistry.register>[0]) =>
            executorRegistry.register(execs),
          toolExecutors: () => executorRegistry.all(),
        },
      },
      plugins: [
        chatPlugin,
        [
          agentMeshPlugin,
          {
            inMemoryDb: true,
            ports: {
              adapters: adapterRegistry,
              checkpoints,
              fileLeases: new DefaultInMemoryFileLeasePort(),
            },
          },
        ],
      ],
    });

    try {
      const sessionId = 'sess_t3_native_01';
      const userMessageId = 'msg_user_01';
      const assistantMessageId = 'msg_asst_01';

      const result = await host.ctx.agentMesh.startTurn({
        chatSessionId: sessionId,
        agentId: 'codex',
        rootPath: workspaceDir,
        prompt: 'Fix the parser bug with full workspace context',
        userPrompt: 'Fix the parser bug',
        timelineMode: 'native_chat',
        userMessageId,
        assistantMessageId,
        awaitCompletion: true,
      });

      expect(result.status).toBe('idle');
      expect(result.nativeTimelineAttached).toBe(true);
      // Prober ran automatically on first turn even though caller never invoked probeAgents()!
      expect((adapterRegistry as AdapterRegistryPort & { probeCalls: number }).probeCalls).toBe(1);

      // 1. Verify SQLite persistence via real `dstu.chat` ChatSessionService!
      const savedSession = host.ctx.chatSession.getSession(sessionId);
      expect(savedSession).not.toBeNull();
      expect(savedSession?.persistStatus).toBe('active');

      const messages = host.ctx.chatSession.getSessionMessages(sessionId);
      expect(messages.map((m) => m.id)).toEqual([userMessageId, assistantMessageId]);

      const userMsg = messages[0]!;
      expect(userMsg.role).toBe('user');
      const userBlocks = host.ctx.chatSession.getMessageBlocks(userMessageId);
      expect(userBlocks).toHaveLength(1);
      expect(userBlocks[0]?.type).toBe('content');
      expect(userBlocks[0]?.status).toBe('success');
      expect(userBlocks[0]?.content).toBe('Fix the parser bug');

      const asstMsg = messages[1]!;
      expect(asstMsg.role).toBe('assistant');
      expect(asstMsg._meta?.modelId).toBe('Codex CLI');
      expect(asstMsg._meta?.usage?.totalTokens).toBe(325);
      expect(asstMsg.blockIds).toHaveLength(4);

      const asstBlocks = host.ctx.chatSession.getMessageBlocks(assistantMessageId);
      expect(asstBlocks.map((b) => b.id)).toEqual(asstMsg.blockIds);
      expect(asstBlocks.map((b) => b.type)).toEqual([
        'thinking',
        'mcp_tool',
        'mcp_tool',
        'content',
      ]);

      expect(asstBlocks[0]?.status).toBe('success');
      expect(asstBlocks[0]?.content).toBe('Inspecting AST... found root cause.');

      expect(asstBlocks[1]?.status).toBe('success');
      expect(asstBlocks[1]?.toolName).toBe('read_file');
      expect(asstBlocks[1]?.toolInput).toEqual({ path: 'src/parser.ts' });
      expect(asstBlocks[1]?.toolOutput).toEqual({ output: 'export const parse = () => null;' });

      expect(asstBlocks[2]?.status).toBe('success');
      expect(asstBlocks[2]?.toolName).toBe('subagent');
      expect(asstBlocks[2]?.toolInput).toEqual({ title: 'Run edge-case verifier' });
      expect(asstBlocks[2]?.toolOutput).toEqual({ summary: 'Verified 6 parser edge cases' });

      expect(asstBlocks[3]?.status).toBe('success');
      expect(asstBlocks[3]?.content).toBe(
        'Fixed the parser bug in `src/parser.ts`.\n\n---\n*📁 修改 2 个文件（+19 / -4）：`src/parser.ts`、`tests/parser.test.ts`*',
      );

      // 2. Verify live backend events order (all chunks flushed BEFORE stream_complete)!
      const sessionChannel = `chat_v2_session_${sessionId}`;
      const blockChannel = `chat_v2_event_${sessionId}`;

      const relevantEvents = host.events.filter(
        (e) => e.event === sessionChannel || e.event === blockChannel,
      );
      expect(relevantEvents.length).toBeGreaterThan(6);

      const sessionEvents = host.events
        .filter((e) => e.event === sessionChannel)
        .map((e) => e.payload as SessionEvent & { type?: string });
      expect(sessionEvents.map((e) => e.eventType)).toEqual([
        SESSION_EVENT_TYPE.STREAM_START,
        SESSION_EVENT_TYPE.STREAM_COMPLETE,
        SESSION_EVENT_TYPE.SAVE_COMPLETE,
      ]);
      expect(sessionEvents[0]?.type).toBe(SESSION_EVENT_TYPE.STREAM_START);
      expect(sessionEvents[0]?.messageId).toBe(assistantMessageId);
      expect(sessionEvents[0]?.modelId).toBe('Codex CLI');
      expect(sessionEvents[1]?.messageId).toBe(assistantMessageId);
      expect(sessionEvents[2]?.messageId).toBe(assistantMessageId);

      // Every `chat_v2_event_<sessionId>` event must have arrived strictly BEFORE `stream_complete`!
      const lastBlockEventIdx = relevantEvents.reduce(
        (acc, ev, idx) => (ev.event === blockChannel ? idx : acc),
        -1,
      );
      const streamCompleteIdx = relevantEvents.findIndex(
        (ev) =>
          ev.event === sessionChannel &&
          (ev.payload as SessionEvent).eventType === SESSION_EVENT_TYPE.STREAM_COMPLETE,
      );
      expect(lastBlockEventIdx).toBeGreaterThan(0);
      expect(streamCompleteIdx).toBeGreaterThan(lastBlockEventIdx);

      const blockEvents = host.events
        .filter((e) => e.event === blockChannel)
        .map((e) => e.payload as BackendEvent);
      expect(
        blockEvents.some(
          (e) => e.type === EVENT_TYPE.THINKING && e.phase === EVENT_PHASE.START,
        ),
      ).toBe(true);
      expect(
        blockEvents.some(
          (e) =>
            e.type === EVENT_TYPE.TOOL_CALL &&
            e.phase === EVENT_PHASE.START &&
            (e.payload as { toolName?: string })?.toolName === 'read_file',
        ),
      ).toBe(true);
      expect(
        blockEvents.some(
          (e) =>
            e.type === EVENT_TYPE.CONTENT &&
            e.phase === EVENT_PHASE.CHUNK &&
            e.chunk?.includes('📁 修改 2 个文件'),
        ),
      ).toBe(true);
    } finally {
      await host.dispose();
    }
  });

  it('supports skipUserMessageSave, tool errors, STREAM_ERROR on failure, and STREAM_CANCELLED on interrupt', async () => {
    let releaseInterruptWait!: () => void;
    const interruptGate = new Promise<void>((resolve) => {
      releaseInterruptWait = resolve;
    });

    const claudeAdapter = new ScriptedCliAdapter(async function* (input) {
      if (input.prompt.includes('FAIL_CASE')) {
        yield {
          type: 'tool_call_start',
          callId: 'call_err',
          toolName: 'bash',
          args: { command: 'exit 1' },
        };
        yield {
          type: 'tool_call_end',
          callId: 'call_err',
          toolName: 'bash',
          output: 'Command exited with code 1',
          isError: true,
        };
        yield { type: 'turn_error', error: 'Claude CLI exited unexpectedly', recoverable: false };
        return;
      }

      yield { type: 'assistant_delta', text: 'Working before cancel...' };
      input.signal?.addEventListener('abort', () => releaseInterruptWait(), { once: true });
      await interruptGate;
      yield { type: 'turn_interrupted', reason: 'user_cancelled' };
    });

    const adapterRegistry: AdapterRegistryPort = {
      async probeAgents(): Promise<DetectedCliAgent[]> {
        return [
          DEFAULT_BUILTIN_COORDINATOR_AGENT,
          {
            id: 'claude',
            kind: 'claude',
            name: 'Claude Code',
            displayName: 'Claude Code',
            command: 'claude',
            installed: true,
            authenticated: true,
            version: '2.1.80',
            capabilities: defaultCaps(),
          },
        ];
      },
      getAdapter(agentId: string) {
        return agentId === 'claude' ? claudeAdapter : null;
      },
    };

    const checkpoints = new StaticDiffCheckpointPort({
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    });
    const executorRegistry = new AgentToolExecutorRegistry();
    const workspaceDir = path.join(fixture.root, 'project-err');
    await fsp.mkdir(workspaceDir, { recursive: true });

    const host = await createTestHost({
      provide: {
        paths: { appDataDir: fixture.root },
        storage: fixture.storage,
        vfs: vfsStub,
        agentTools: {
          registerToolExecutors: (execs: Parameters<typeof executorRegistry.register>[0]) =>
            executorRegistry.register(execs),
          toolExecutors: () => executorRegistry.all(),
        },
      },
      plugins: [
        chatPlugin,
        [
          agentMeshPlugin,
          {
            inMemoryDb: true,
            ports: {
              adapters: adapterRegistry,
              checkpoints,
              fileLeases: new DefaultInMemoryFileLeasePort(),
            },
          },
        ],
      ],
    });

    try {
      // Case A: skipUserMessageSave + tool error + STREAM_ERROR
      const failSid = 'sess_fail_case';
      const failRes = await host.ctx.agentMesh.startTurn({
        chatSessionId: failSid,
        agentId: 'claude',
        rootPath: workspaceDir,
        prompt: 'FAIL_CASE',
        timelineMode: 'native_chat',
        assistantMessageId: 'msg_fail_asst',
        skipUserMessageSave: true,
        awaitCompletion: true,
      });

      expect(failRes.status).toBe('failed');
      const failMsgs = host.ctx.chatSession.getSessionMessages(failSid);
      expect(failMsgs.map((m) => m.id)).toEqual(['msg_fail_asst']);
      expect(failMsgs[0]?._meta?.modelId).toBe('Claude Code');

      const failBlocks = host.ctx.chatSession.getMessageBlocks('msg_fail_asst');
      expect(failBlocks).toHaveLength(1);
      expect(failBlocks[0]?.status).toBe('error');
      expect(failBlocks[0]?.error).toContain('Command exited with code 1');

      const failSessionEvents = host.events
        .filter((e) => e.event === `chat_v2_session_${failSid}`)
        .map((e) => e.payload as SessionEvent);
      expect(failSessionEvents.map((e) => e.eventType)).toEqual([
        SESSION_EVENT_TYPE.STREAM_START,
        SESSION_EVENT_TYPE.STREAM_ERROR,
      ]);
      expect(failSessionEvents[1]?.error).toBe('Claude CLI exited unexpectedly');

      // Case B: Interrupt mid-stream -> STREAM_CANCELLED + partial content saved
      const cancelSid = 'sess_cancel_case';
      const started = await host.ctx.agentMesh.startTurn({
        chatSessionId: cancelSid,
        agentId: 'claude',
        rootPath: workspaceDir,
        prompt: 'LONG_RUNNING_CASE',
        timelineMode: 'native_chat',
        assistantMessageId: 'msg_cancel_asst',
        awaitCompletion: false,
      });
      expect(started.nativeTimelineAttached).toBe(true);

      await new Promise((r) => setTimeout(r, 40));
      await host.ctx.agentMesh.interruptTurn({
        threadId: started.threadId,
        reason: 'user_pressed_stop',
      });
      await new Promise((r) => setTimeout(r, 40));

      const cancelAsst = host.ctx.chatSession.getMessage('msg_cancel_asst');
      expect(cancelAsst?._meta?.stoppedByUser).toBe(true);
      const cancelBlocks = host.ctx.chatSession.getMessageBlocks('msg_cancel_asst');
      expect(cancelBlocks[0]?.content).toBe('Working before cancel...');

      const cancelSessionEvents = host.events
        .filter((e) => e.event === `chat_v2_session_${cancelSid}`)
        .map((e) => e.payload as SessionEvent);
      expect(cancelSessionEvents.map((e) => e.eventType)).toEqual([
        SESSION_EVENT_TYPE.STREAM_START,
        SESSION_EVENT_TYPE.STREAM_CANCELLED,
      ]);
    } finally {
      await host.dispose();
    }
  });

  it('resolves empty or "/" rootPath to an isolated per-session scratch workspace without binding "/" permanently', async () => {
    const tempAppData = await fsp.mkdtemp(path.join(os.tmpdir(), 'dstu-mesh-scratch-appdata-'));
    try {
      const adapter = new ScriptedCliAdapter(async function* () {
        yield { type: 'assistant_delta', text: 'Done in scratch workspace.' };
        yield { type: 'turn_settled', summary: 'end_turn' };
      });

      const checkpoints = new StaticDiffCheckpointPort({
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      });

      const orchestrator = createMeshOrchestrator({
        appDataDir: tempAppData,
        inMemoryDb: false,
        adapters: {
          async probeAgents() {
            return [
              DEFAULT_BUILTIN_COORDINATOR_AGENT,
              {
                id: 'codex',
                kind: 'codex',
                name: 'Codex CLI',
                command: 'codex',
                installed: true,
                authenticated: true,
                version: '0.118.0',
                capabilities: defaultCaps(),
              },
            ];
          },
          getAdapter: () => adapter,
        },
        checkpoints,
        fileLeases: new DefaultInMemoryFileLeasePort(),
      });

      try {
        // 1) Passing "/" (as happens in packaged macOS .app where process.cwd() === "/")
        const resSlash = await orchestrator.startTurn({
          chatSessionId: 'sess/slash:1',
          agentId: 'codex',
          rootPath: '/',
          prompt: 'Quick coding question',
          awaitCompletion: true,
        });

        const expectedScratchDir = path.join(
          tempAppData,
          'agent-mesh-workspaces',
          'sess_slash_1',
        );
        expect(resSlash.thread.rootPath).toBe(expectedScratchDir);
        expect(resSlash.thread.rootPath).not.toBe('/');
        expect(fs.existsSync(expectedScratchDir)).toBe(true);
        expect(adapter.startedInputs[0]?.cwd).toBe(expectedScratchDir);
        expect(checkpoints.capturedRoots[0]).toBe(expectedScratchDir);

        // Scratch fallback MUST NOT be auto-saved as a permanent workspaceBinding!
        expect(await orchestrator.getWorkspaceBinding('sess/slash:1')).toBeNull();

        // 2) Omitting rootPath entirely also resolves to isolated per-session scratch dir
        const resEmpty = await orchestrator.startTurn({
          chatSessionId: 'sess-empty-root',
          agentId: 'codex',
          prompt: 'Another standalone turn',
          awaitCompletion: true,
        });
        const expectedEmptyScratch = path.join(
          tempAppData,
          'agent-mesh-workspaces',
          'sess-empty-root',
        );
        expect(resEmpty.thread.rootPath).toBe(expectedEmptyScratch);
        expect(await orchestrator.getWorkspaceBinding('sess-empty-root')).toBeNull();
      } finally {
        await orchestrator.dispose();
      }
    } finally {
      await fsp.rm(tempAppData, { recursive: true, force: true });
    }
  });
});

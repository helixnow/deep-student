/**
 * G21 regression suite: B2 headless runner (`headless-runner.ts`), plugin.ts composition,
 * `chat_v2_automation_run_now` execution pipeline, terminal `spawn_error` classification,
 * and real official-profile end-to-end `Run Now` execution.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityAcl } from '../../../kernel/acl.ts';
import { ContractSet } from '../../../kernel/contracts.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { ChatV2State, type ChatSession, type MessageBlock } from '../../chat/api.ts';
import type { PipelineSendRequest } from '../../chat-pipeline/api.ts';
import plugin from '../index.ts';
import type { AgentSubagentService } from '../api.ts';
import { listAutomationRuns, saveAutomations, type AutomationDefinition } from '../repository/automations.ts';
import { formatTimestampMillis, type AutomationSchedule } from '../src/automation-schedule.ts';
import { isPermanentHeadlessFailure } from '../src/automation-runtime.ts';
import { createHeadlessRunner } from '../src/headless-runner.ts';
import { isTrustedAutomationPreauthorized } from '../src/headless.ts';
import { computedProfileHash, type TrustedAutomationProfile } from '../src/trusted-profile.ts';

const contracts = ContractSet.fromDirectory();

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeAgentAutomation(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  const schedule: AutomationSchedule = {
    kind: 'daily', time: '09:00', weekday: null, weekdays: null,
    day_of_month: null, interval_minutes: null, date: null, timezone: null,
  };
  return {
    id: 'auto_headless_test',
    name: 'Morning Agent Check',
    schedule,
    prompt: 'Check due reviews and summarize',
    enabled: true,
    created_at: formatTimestampMillis(Date.now()),
    session_id: '',
    last_run_at: null,
    next_run_at: null,
    action_type: 'agent_turn',
    heartbeat: false,
    agent_prompt: null,
    session_mode: 'isolated',
    model_id: null,
    agent_session_id: null,
    catch_up_policy: 'run_once',
    max_retries: 2,
    retry_backoff_seconds: 60,
    timeout_seconds: 600,
    trusted_profile: null,
    version: 1,
    ...overrides,
  };
}

function makeTrustedProfile(): TrustedAutomationProfile {
  const profile: TrustedAutomationProfile = {
    schemaVersion: 1,
    profileHash: '',
    allowedTools: ['builtin-local_shell_execute'],
    runtimeRoots: [{ rootId: 'workspace', access: 'read_write' }],
    shellCommandPrefixes: ['unzip'],
    networkDomains: [],
    maxToolRounds: 6,
    timeoutSeconds: 120,
    maxOutputBytes: 32_768,
    rollbackRequired: true,
  };
  profile.profileHash = computedProfileHash(profile);
  return profile;
}

describe('B2 headless runner & Run Now composition', () => {
  it('composes headless runner from chatSession + chatPipeline.executeWithEmitter + chatState and runs agent_turn end-to-end', async () => {
    const host = await createTestHost({ contracts });
    const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    const db = storage.database('mistakes');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
      db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
    }
    const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
    const chatState = new ChatV2State();
    const sessions = new Map<string, ChatSession>();
    const blocksByMessage = new Map<string, MessageBlock[]>();
    const capturedRequests: Array<{ request: PipelineSendRequest; hasWindow: boolean; preauthorizedDuringRun: boolean }> = [];

    host.ctx.provide('settings', settings);
    host.ctx.provide('storage', storage);
    host.ctx.provide('chatState', chatState);
    host.ctx.provide('chatSession', {
      getSession: (id: string) => sessions.get(id) ?? null,
      createSession: (session: ChatSession) => { sessions.set(session.id, session); },
      getMessageBlocks: (messageId: string) => blocksByMessage.get(messageId) ?? [],
    });
    host.ctx.provide('chatPipeline', {
      executeWithEmitter: async (emitter: { tryWindow(): unknown }, request: PipelineSendRequest) => {
        const preauthorizedDuringRun = isTrustedAutomationPreauthorized(
          request.sessionId,
          'builtin-local_shell_execute',
          { root_id: 'workspace', command: 'unzip notes.zip', track_file_changes: true, max_output_bytes: 4096 },
        );
        capturedRequests.push({
          request,
          hasWindow: emitter.tryWindow() !== null,
          preauthorizedDuringRun,
        });
        const assistantId = request.assistantMessageId ?? 'msg_assistant_1';
        blocksByMessage.set(assistantId, [{
          id: 'blk_1',
          messageId: assistantId,
          type: 'tool',
          status: 'success',
          toolName: 'attempt_completion',
          toolOutput: { result: 'Reviewed 4 due items; all clear.' },
          startedAt: Date.now(),
        }]);
        return assistantId;
      },
    });
    await host.install(plugin);

    try {
      const subagent = host.ctx.get('agentSubagent') as AgentSubagentService;
      expect(typeof subagent.runHeadlessTurn).toBe('function');
      expect(typeof subagent.runHeadlessAgentTurn).toBe('function');

      const trustedProfile = makeTrustedProfile();
      saveAutomations(db, [makeAgentAutomation({ trusted_profile: trustedProfile })]);

      const started = await host.invoke<Record<string, unknown>>('chat_v2_automation_run_now', {
        automationId: 'auto_headless_test',
        expectedVersion: 1,
      });
      expect(started.status).toBe('started');

      await waitFor(() => host.eventsNamed('chat_v2_automation_run_completed').length === 1);

      expect(capturedRequests).toHaveLength(1);
      const call = capturedRequests[0]!;
      expect(call.hasWindow).toBe(false);
      expect(call.preauthorizedDuringRun).toBe(true);
      expect(call.request.options?.systemPromptAppend).toContain('<headless_mode>');
      expect(call.request.options?.executionAllowedTools).toContain('attempt_completion');
      expect(call.request.options?.executionAllowedTools).toContain('builtin-local_shell_execute');
      expect(call.request.options?.executionAllowedTools).not.toContain('builtin-ask_user');
      expect(call.request.options?.mcpTools).toEqual([]);

      // Trusted session guard & stream guard must be released after completion.
      expect(isTrustedAutomationPreauthorized(
        call.request.sessionId,
        'builtin-local_shell_execute',
        { root_id: 'workspace', command: 'unzip notes.zip', track_file_changes: true, max_output_bytes: 4096 },
      )).toBe(false);
      expect(chatState.hasActiveStream(call.request.sessionId)).toBe(false);

      const [run] = listAutomationRuns(db, 'auto_headless_test', 10);
      expect(run).toMatchObject({
        status: 'success',
        session_id: call.request.sessionId,
        summary: 'Reviewed 4 due items; all clear.',
        error: null,
      });
      expect(host.eventsNamed('chat_v2_automation_run_completed')).toEqual([
        expect.objectContaining({
          automationId: 'auto_headless_test',
          sessionId: call.request.sessionId,
          status: 'success',
          summary: 'Reviewed 4 due items; all clear.',
        }),
      ]);
    } finally {
      await host.unload('dstu.agent-orchestration');
      storage.dispose();
      await host.dispose();
    }
  });

  it('finalizes permanent infrastructure/model failures as terminal spawn_error instead of silent retrying', async () => {
    const host = await createTestHost({
      contracts,
      shell: (op) => {
        if (op === 'plugin:notification|notify') return null;
        if (op === 'plugin:window|is_focused' || op === 'plugin:window|is_visible') return true;
        if (op === 'plugin:window|is_minimized') return false;
        return null;
      },
    });
    const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    const db = storage.database('mistakes');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
      db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
    }
    const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
    const chatState = new ChatV2State();
    host.ctx.provide('settings', settings);
    host.ctx.provide('storage', storage);
    host.ctx.provide('chatState', chatState);
    // Deliberately omit chatPipeline so headless pipeline is unpublished.
    await host.install(plugin);

    try {
      // Default max_retries = 2 would previously transition into "retrying" silently!
      saveAutomations(db, [makeAgentAutomation({ id: 'auto_missing_runner', max_retries: 2 })]);

      await host.invoke('chat_v2_automation_run_now', {
        automationId: 'auto_missing_runner',
        expectedVersion: 1,
      });

      await waitFor(() => host.eventsNamed('chat_v2_automation_run_completed').length === 1);
      const [run] = listAutomationRuns(db, 'auto_missing_runner', 10);
      expect(run?.status).toBe('spawn_error');
      expect(run?.error).toContain('requires the headless pipeline');
      expect(run?.next_attempt_at).toBeNull();
      expect(host.eventsNamed('chat_v2_automation_run_completed')).toEqual([
        expect.objectContaining({
          automationId: 'auto_missing_runner',
          status: 'spawn_error',
        }),
      ]);
    } finally {
      await host.unload('dstu.agent-orchestration');
      storage.dispose();
      await host.dispose();
    }
  });

  it('classifies permanent config errors vs transient runtime errors accurately', () => {
    expect(isPermanentHeadlessFailure('没有可用的文本或多模态生成模型')).toBe(true);
    expect(isPermanentHeadlessFailure('能力规划未解析到可执行模型')).toBe(true);
    expect(isPermanentHeadlessFailure('Automation agent turn requires the headless pipeline, which is not published.')).toBe(true);
    expect(isPermanentHeadlessFailure('HTTP 401 Unauthorized: invalid api key')).toBe(true);
    expect(isPermanentHeadlessFailure('network timeout ETIMEDOUT')).toBe(false);
    expect(isPermanentHeadlessFailure('HTTP 503 Service Unavailable')).toBe(false);
    expect(isPermanentHeadlessFailure("Automation 'a' is already running (single-flight)", undefined, 'spawn_error')).toBe(false);
  });

  it('enforces hard timeout with cancel grace window and releases stream guard', async () => {
    const chatState = new ChatV2State();
    const sessions = new Map<string, ChatSession>();
    let signalAborted = false;

    const runner = createHeadlessRunner({
      chatSession: {
        getSession: (id) => sessions.get(id) ?? null,
        createSession: (session) => { sessions.set(session.id, session); },
        getMessageBlocks: () => [],
      },
      chatState,
      chatPipeline: {
        executeWithEmitter: (_emitter, _request, signal) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            signalAborted = true;
            reject(new Error('aborted'));
          }, { once: true });
        }),
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      cancelGraceMs: 50,
    });

    const result = await runner.runHeadlessTurn({
      prompt: 'Run slow check',
      sessionMode: 'isolated',
      source: 'test',
      hardTimeoutSecs: 1,
    });

    expect(result.status).toBe('timeout');
    expect(result.error).toContain('timed out after 1s');
    expect(signalAborted).toBe(true);
    expect(chatState.hasActiveStream(result.sessionId)).toBe(false);
  });

  it('supports named session reuse and runHeadlessAgentTurn on existing sessions', async () => {
    const chatState = new ChatV2State();
    const sessions = new Map<string, ChatSession>();
    const blocks = new Map<string, MessageBlock[]>();

    const runner = createHeadlessRunner({
      chatSession: {
        getSession: (id) => sessions.get(id) ?? null,
        createSession: (session) => { sessions.set(session.id, session); },
        getMessageBlocks: (id) => blocks.get(id) ?? [],
      },
      chatState,
      chatPipeline: {
        executeWithEmitter: async (_emitter, request) => {
          const assistantId = request.assistantMessageId ?? 'msg_a';
          blocks.set(assistantId, [{
            id: `blk_${assistantId}`,
            messageId: assistantId,
            type: 'content',
            status: 'success',
            content: `Reply to: ${request.content}`,
            startedAt: Date.now(),
          }]);
          return assistantId;
        },
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const first = await runner.runHeadlessTurn({
      prompt: 'Turn 1',
      sessionMode: 'named',
      namedSessionId: null,
      source: 'automation:named:manual',
    });
    expect(first.status).toBe('completed');
    expect(first.summary).toBe('Reply to: Turn 1');

    const second = await runner.runHeadlessTurn({
      prompt: 'Turn 2',
      sessionMode: 'named',
      namedSessionId: first.sessionId,
      source: 'automation:named:manual',
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.summary).toBe('Reply to: Turn 2');

    const wake = await runner.runHeadlessAgentTurn({
      sessionId: first.sessionId,
      prompt: 'Wake check',
      systemPromptAppend: 'Check worker completion',
      timeoutMs: 10_000,
    });
    expect(wake.sessionId).toBe(first.sessionId);
    expect(wake.content).toBe('Reply to: Wake check');
    expect(chatState.hasActiveStream(first.sessionId)).toBe(false);
  });
});

describe('Official desktop profile Run Now end-to-end', () => {
  it('runs a real agent_turn automation via Run Now and surfaces terminal spawn_error when no model is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dstu-automation-run-now-profile-'));
    vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
    vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
    vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');

    const streamingRequests: Array<{ stream?: boolean; messages?: Array<{ role: string; content: unknown }> }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        stream?: boolean;
        messages?: Array<{ role: string; content: unknown }>;
      };

      // Background non-streaming RAW_PROMPT calls (e.g. session title generation) expect JSON,
      // not SSE; respond with a valid chat.completion payload so they do not trigger transient retries.
      if (payload.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: 'chatcmpl-auto-raw',
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Daily Study Digest' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
        }));
        return;
      }

      streamingRequests.push(payload);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'Today review plan: 3 flashcards due.' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } },
      ].map((frame) => `data: ${JSON.stringify({ id: 'chatcmpl-auto', object: 'chat.completion.chunk', ...frame })}\n\n`).join('')
        + 'data: [DONE]\n\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const host = await createTestHost({
      app: { dataDir: join(root, 'app'), platform: 'linux' },
      acl: CapabilityAcl.fromDirectory('linux'),
      shell: (op) => {
        if (op === 'plugin:notification|notify') return null;
        if (op === 'plugin:window|is_focused' || op === 'plugin:window|is_visible') return true;
        if (op === 'plugin:window|is_minimized') return false;
        return null;
      },
    });

    try {
      new PluginAdmin({
        runtime: host.runtime,
        official: OFFICIAL_PROFILE_PATH,
        store: new UserProfileStore(join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH),
      }).register();
      const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
      expect(loaded.degraded).toEqual([]);

      expect(typeof host.ctx.agentSubagent.runHeadlessTurn).toBe('function');
      expect(typeof host.ctx.agentSubagent.runHeadlessAgentTurn).toBe('function');

      // 1) No model configured yet -> Run Now must NOT silently spin in `retrying`;
      //    it must immediately surface terminal `spawn_error` with the real error detail.
      const unconfigured = await host.invoke<{ automation: { id: string; version: number } }>(
        'chat_v2_automation_create',
        {
          request: {
            name: 'Unconfigured Check',
            schedule: { kind: 'daily', time: '09:00' },
            prompt: 'Summarize today',
            actionType: 'agent_turn',
            maxRetries: 2,
          },
        },
      );
      await host.invoke('chat_v2_automation_run_now', {
        automationId: unconfigured.automation.id,
        expectedVersion: unconfigured.automation.version,
      });

      await vi.waitFor(async () => {
        const res = await host.invoke<{ runs: Array<{ status: string; error?: string }> }>(
          'chat_v2_automation_runs',
          { automationId: unconfigured.automation.id, limit: 10 },
        );
        expect(res.runs).toHaveLength(1);
        expect(res.runs[0]?.status).toBe('spawn_error');
        expect(res.runs[0]?.error).toBeTruthy();
      }, { timeout: 15_000 });

      // 2) With a configured LLM -> Run Now executes a real headless AI turn and records summary + sessionId.
      await host.ctx.llm.saveApiConfigurations([{
        id: 'auto-local-config',
        name: 'Automation Local Model',
        apiKey: '',
        authMode: 'none',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        model: 'auto-local-model',
        apiProtocol: 'openai_chat_completions',
        modelAdapter: 'general',
        enabled: true,
        supportsTools: false,
        isMultimodal: false,
        isReasoning: false,
        isEmbedding: false,
        isReranker: false,
        contextWindow: 32768,
        maxOutputTokens: 256,
      }]);
      await host.ctx.llm.saveModelAssignments({ model2_config_id: 'auto-local-config' });

      const configured = await host.invoke<{ automation: { id: string; version: number } }>(
        'chat_v2_automation_create',
        {
          request: {
            name: 'Daily Study Digest',
            schedule: { kind: 'daily', time: '09:00' },
            prompt: 'List today flashcards',
            actionType: 'agent_turn',
            maxRetries: 2,
          },
        },
      );
      await host.invoke('chat_v2_automation_run_now', {
        automationId: configured.automation.id,
        expectedVersion: configured.automation.version,
      });

      await vi.waitFor(async () => {
        const res = await host.invoke<{ runs: Array<{ status: string; summary?: string; session_id?: string }> }>(
          'chat_v2_automation_runs',
          { automationId: configured.automation.id, limit: 10 },
        );
        expect(res.runs).toHaveLength(1);
        expect(res.runs[0]?.status).toBe('success');
        expect(res.runs[0]?.summary).toContain('Today review plan: 3 flashcards due.');
        expect(res.runs[0]?.session_id).toMatch(/^sess_/);
      }, { timeout: 15_000 });

      const headlessRequests = streamingRequests.filter((req) => {
        const serialized = JSON.stringify(req.messages ?? []);
        return serialized.includes('<headless_mode>') && serialized.includes('List today flashcards');
      });
      expect(headlessRequests).toHaveLength(1);
    } finally {
      await host.dispose();
      server.close();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createNodeFiles } from '../../../platform/files/index.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import { StorageServiceImpl } from '../../../platform/storage/service.ts';
import { MigrationCoordinator } from '../../../platform/storage/migration/coordinator.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createSecretsService } from '../../../platform/secrets/index.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import diagnostics from '../../../platform/diagnostics/index.ts';
import { InjectionBudgetManager, defaultBudgetConfig, newInjectionItem } from '../../../platform/storage/injection-budget.ts';
import type { InjectionBudgetService } from '../../../platform/storage/api.ts';
import {
  LLM_REPLAY_SCRIPTS, llmReplayPlugin, type LlmCodexAuthService, type LlmReplayConfig, type LlmReplayScriptId,
} from '../../../plugins/llm-providers/api.ts';
import native from '../../../platform/native/index.ts';
import vfs from '../../../plugins/vfs/index.ts';
import repos from '../../../plugins/vfs-repos/index.ts';
import notes from '../../../plugins/notes/index.ts';
import vfsIndex from '../../../plugins/vfs-index/index.ts';
import llm from '../../../plugins/llm/index.ts';
import llmProviders from '../../../plugins/llm-providers/index.ts';
import chat from '../../../plugins/chat/index.ts';
import pipeline from '../../../plugins/chat-pipeline/index.ts';
import workspace from '../../../plugins/agent-workspace/index.ts';
import { FakeLlmAdapters, type Scenario } from './fake-llm.ts';

/**
 * X5 scenarios never select an openai_codex provider. The real L01 plugin cannot
 * be installed next to the fake `llmAdapters` (duplicate providers), so Codex auth
 * reports signed-out and refuses any request instead of silently succeeding.
 */
function signedOutCodexAuth(): LlmCodexAuthService {
  const refuse = async (): Promise<never> => { throw new Error('X5 fixture: Codex auth is not part of streaming scenarios'); };
  return {
    status: async () => ({ phase: 'signed_out', hasUsableSession: false, accountHint: null, email: null, planType: null,
      isFedramp: false, expiresAtUnixMs: null, generation: 0, activeLoginKind: null, activeAttemptId: null,
      authorizationUrl: null, verificationUrl: null, userCode: null, pollIntervalSeconds: null, lastError: null }),
    requestAuth: refuse, refreshAfterUnauthorized: refuse, markReauthenticationRequired: refuse,
    responsesEndpoint: refuse, prepareRequest: refuse, sendWithSingleRefresh: refuse, sendStreamWithSingleRefresh: refuse,
  };
}

/** Same pure F3 functions the storage plugin publishes as `injectionBudget`. */
const injectionBudget: InjectionBudgetService = {
  defaultConfig: defaultBudgetConfig,
  createManager: (config) => new InjectionBudgetManager(config),
  newItem: newInjectionItem,
};

/**
 * `streamingHost` installs no tool runtime (`chatToolRuntime`), so a WAVE0 tool scenario's round 0
 * tool call cannot execute and its `stream_complete` wait is only reachable on the desktop profile
 * (wave0/streaming-b.test.mjs). On this host the same turn fails closed in `stream_error`.
 */
export function withoutToolExecutors<T extends { steps: Array<{ waitAfter?: { event: string } }> }>(scenario: T): T {
  return { ...scenario, steps: scenario.steps.map(step =>
    step.waitAfter?.event === 'stream_complete' ? { ...step, waitAfter: { ...step.waitAfter, event: 'stream_error' } } : step) };
}

/**
 * Replay whose only script is the builtin single-round `id`, answered with the builtin round through
 * `derive` so that `atArrival` runs when the request reaches the provider (for example to read whether
 * the user message is already saved, as a socket server could).
 */
export function observedBuiltinReplay(id: Exclude<LlmReplayScriptId, 'w0.directive'>, atArrival: () => void): LlmReplayConfig {
  const { description, rounds } = LLM_REPLAY_SCRIPTS[id];
  const [round] = rounds;
  if (rounds.length !== 1 || !round) throw new Error(`${id}: observedBuiltinReplay serves single-round scripts only`);
  return { scripts: { [id]: { description, derive() { atArrival(); return { ok: true, index: 0, round }; } } } };
}

/** Real migrated storage/settings/secrets and dependency plugins, not a fake chat service. */
export async function streamingHost(scenario: Scenario = 'answer', options: {
  diagnostics?: boolean;
  providerUrl?: string;
  /**
   * WAVE0: install the real L01 llm-providers plugin (real OpenAI parser) instead of the fake
   * `llmAdapters`; provider bytes then come only from the WAVE0 LLM service. `fake` stays unused.
   */
  realProviders?: boolean;
  /**
   * Install the llm-providers replay provider with these scripts (`host.ctx.llmReplay`). Provider
   * bytes for `${LLM_REPLAY_ORIGIN}` base URLs then come from it in-process; other URLs are untouched.
   */
  llmReplay?: LlmReplayConfig;
  /** Test-only phase observation; never supplies or replaces a production service. */
  onPhase?: (phase: string) => void;
} = {}) {
  const phase = (name: string) => options.onPhase?.(name);
  phase('host:temp:start');
  const root = mkdtempSync('/tmp/opencode/x5-stream-');
  phase('host:temp:ready');
  const storage = new StorageServiceImpl({ baseDir: root, dataLocalDir: root });
  phase('host:storage:ready');
  let host: Awaited<ReturnType<typeof createTestHost>> | undefined;
  try {
    phase('host:locations:start');
    const activeDir = storage.locations.activeDir;
    phase('host:locations:ready');
    phase('host:schema-definitions:start');
    const migrations = new MigrationCoordinator({ appDataDir: activeDir, auditDbPath: null });
    phase('host:schema-definitions:ready');
    for (const name of ['chat_v2', 'mistakes', 'vfs'] as const) {
      phase(`host:migrate:${name}:start`);
      const report = migrations.migrateSingle(name);
      if (!report.success) throw new Error(JSON.stringify(report));
      phase(`host:migrate:${name}:ready`);
    }
    phase('host:secrets:start');
    const secrets = createSecretsService({
      os: { home: root, data: root, dataLocal: root, config: root, cache: root, temp: root, download: null },
      keystore: null,
      log: { target: 'x5::test_secrets', error() {}, warn() {}, info() {}, debug() {}, trace() {} },
    });
    phase('host:secrets:ready');
    const settings = createSettingsStore({ db: () => storage.database('mistakes'),
      secureStore: () => secrets.openStore(root, { keystore: null }), isSensitiveKey: secrets.isSensitiveKey });
    phase('host:settings:ready');
    const fake = new FakeLlmAdapters(scenario, options.providerUrl);
    phase('host:paths:start');
    const paths = createPaths({ dataDir: root, platform: 'linux', env: {
      HOME: root, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root,
    } });
    const files = createNodeFiles({ roots: [{ name: 'appData', path: root }, { name: 'temp', path: tmpdir() }] });
    phase('host:paths:ready');
    phase('host:plugins:start');
    host = await createTestHost({
      app: { dataDir: root },
      provide: options.realProviders
        ? { storage, settings, secrets, paths, files, injectionBudget }
        : { storage, settings, secrets, paths, files, llmAdapters: fake, injectionBudget, llmCodexAuth: signedOutCodexAuth() },
      plugins: [native, vfs, repos, notes, vfsIndex, ...(options.realProviders ? [llmProviders] : []),
        ...(options.llmReplay ? [[llmReplayPlugin, options.llmReplay] as const] : []), llm, chat, workspace, pipeline,
        ...(options.diagnostics ? [diagnostics] : [])],
    });
    phase('host:plugins:ready');
    const installed = host;
    return { host: installed, fake, async dispose() {
      phase('host:dispose:start');
      try { await installed.dispose(); }
      finally { storage.dispose(); rmSync(root, { recursive: true, force: true }); phase('host:dispose:done'); }
    } };
  } catch (error) {
    phase('host:failed');
    try { await host?.dispose(); }
    finally { storage.dispose(); rmSync(root, { recursive: true, force: true }); }
    throw error;
  }
}

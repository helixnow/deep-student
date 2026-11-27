import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ExternalCandidateModelDto,
  ExternalLlmImportResult,
  ExternalLlmScanReport,
} from '../../../../contracts/ipc/generated/L02-llm-manager.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import { image } from '../../../platform/native/image/index.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
import type { CryptoService, EncryptedData } from '../../../platform/secrets/api.ts';
import type { SettingsStore, SettingRow } from '../../../platform/settings/api.ts';
import type { ExternalConfigRawSource, ExternalLlmConfigsService } from '../../../platform/storage/api.ts';
// boundary-allow cross-plugin-import: install real L01 plugin alongside L02 in TestHost.
import providers from '../../llm-providers/index.ts';
import type { ModelAssignments, ModelProfile, VendorConfig } from '../api.ts';
import llm from '../index.ts';
import { realInjectionBudget } from './host.ts';

function createInMemorySettings(): SettingsStore & { secrets: Map<string, string>; plain: Map<string, string> } {
  const plain = new Map<string, string>();
  const secrets = new Map<string, string>();
  return {
    plain,
    secrets,
    get: (key: string) => plain.get(key) ?? null,
    save: (key: string, value: string) => {
      plain.set(key, value);
    },
    delete: (key: string) => plain.delete(key),
    listByPrefix: (prefix: string): SettingRow[] =>
      [...plain.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value, updatedAt: '2026-11-26T00:00:00Z' })),
    deleteByPrefix: (prefix: string) => {
      let count = 0;
      for (const k of [...plain.keys()]) {
        if (k.startsWith(prefix)) {
          plain.delete(k);
          count += 1;
        }
      }
      return count;
    },
    getSecret: async (key: string) => secrets.get(key) ?? null,
    saveSecret: async (key: string, value: string) => {
      secrets.set(key, value);
    },
    deleteSecret: async (key: string) => secrets.delete(key),
  };
}

function createReversibleCrypto(): {
  isEncryptedFormat: (value: string) => boolean;
  openCrypto: () => Promise<CryptoService>;
} {
  return {
    isEncryptedFormat(value: string) {
      try {
        const parsed = JSON.parse(value) as Partial<EncryptedData>;
        return typeof parsed.ciphertext === 'string' && typeof parsed.nonce === 'string';
      } catch {
        return false;
      }
    },
    async openCrypto(): Promise<CryptoService> {
      return {
        encryptApiKey: (plain: string): EncryptedData => ({
          ciphertext: Buffer.from(plain, 'utf8').toString('base64'),
          nonce: 'bm9uY2U=',
          version: 1,
        }),
        decryptApiKey: (data: EncryptedData): string =>
          Buffer.from(data.ciphertext, 'base64').toString('utf8'),
        migratePlaintextKey: (plain: string): string =>
          JSON.stringify({
            ciphertext: Buffer.from(plain, 'utf8').toString('base64'),
            nonce: 'bm9uY2U=',
            version: 1,
          }),
      } as unknown as CryptoService;
    },
  };
}

const activeServers: http.Server[] = [];
let activeHost: Awaited<ReturnType<typeof createTestHost>> | undefined;

afterEach(async () => {
  await activeHost?.dispose();
  activeHost = undefined;
  while (activeServers.length > 0) {
    const server = activeServers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function startModelsServer(models: Array<{ id: string; context_length?: number }>): Promise<string> {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer sk-')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  activeServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}/v1`;
}

describe('L02 external LLM config import commands', () => {
  it('scans Magpie + CC Switch + OpenCode, filters proxy placeholders, merges multi-keys, aligns builtins, and supports incremental re-sync', async () => {
    const relayBaseUrl = await startModelsServer([
      { id: 'claude-sonnet-4-5', context_length: 200000 },
      { id: 'gpt-5.4-mini', context_length: 128000 },
      { id: 'bge-reranker-v2-m3', context_length: 8192 },
    ]);

    const fixtureSources: ExternalConfigRawSource[] = [
      {
        source: 'magpie',
        kind: 'json',
        pathLabel: '~/.config/magpie/providers.json',
        text: JSON.stringify([
          {
            id: 'deepseek',
            name: 'DeepSeek',
            baseAPI: 'openai',
            chat: 'https://api.deepseek.com/v1',
            key: 'sk-deepseek-real-11112222',
            models: ['deepseek-v4-pro', 'deepseek-flash'],
          },
          {
            id: 'custom-relay',
            name: 'Alpha Relay',
            baseAPI: 'openai',
            chat: relayBaseUrl,
            accounts: [{ key: 'sk-alpha-primary-aaaa' }, { key: 'sk-alpha-backup-bbbb' }],
            models: [],
          },
        ]),
        companionText: null,
        sqliteTables: null,
        error: null,
      },
      {
        source: 'cc-switch',
        kind: 'sqlite-rows',
        pathLabel: '~/.cc-switch/cc-switch.db',
        text: null,
        companionText: null,
        sqliteTables: {
          providers: [
            {
              id: 'cc-claude-1',
              app_type: 'claude',
              name: 'Claude Relay',
              website_url: 'https://relay.example.com',
              settings_config: JSON.stringify({
                env: {
                  ANTHROPIC_BASE_URL: 'https://anthropic-relay.example.com',
                  ANTHROPIC_AUTH_TOKEN: 'sk-ant-relay-987654321',
                  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5',
                  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
                },
              }),
              meta: '{}',
            },
            {
              id: 'cc-codex-same-relay',
              app_type: 'codex',
              name: 'Alpha Relay Codex',
              settings_config: JSON.stringify({
                auth: { OPENAI_API_KEY: 'sk-alpha-third-cccc' },
                config: `model_provider = "alpha"\n[model_providers.alpha]\nbase_url = "${relayBaseUrl}"\nwire_api = "chat"\n`,
              }),
              meta: '{}',
            },
            {
              // Local CC Switch proxy takeover placeholder -> MUST be skipped
              id: 'cc-proxy-placeholder',
              app_type: 'claude',
              name: 'Proxy Takeover',
              settings_config: JSON.stringify({
                env: {
                  ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
                  ANTHROPIC_AUTH_TOKEN: 'PROXY_MANAGED',
                },
              }),
              meta: '{}',
            },
          ],
          universalProviders: [],
        },
        error: null,
      },
      {
        // Magpie takeover written into ~/.claude/settings.json -> MUST be skipped
        source: 'claude-code',
        kind: 'json',
        pathLabel: '~/.claude/settings.json',
        text: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425',
            ANTHROPIC_AUTH_TOKEN: 'magpie',
          },
        }),
        companionText: null,
        sqliteTables: null,
        error: null,
      },
    ];

    const settings = createInMemorySettings();
    const externalLlmConfigs: ExternalLlmConfigsService = {
      scanDefaultSources: async () => ({ supported: true, sources: fixtureSources }),
      readExternalFile: async () => fixtureSources[0]!,
    };

    activeHost = await createTestHost({
      plugins: [providers, llm],
      provide: {
        settings,
        secrets: createReversibleCrypto(),
        nativeImage: image,
        nativeTokenizer: tokenizer,
        injectionBudget: realInjectionBudget,
        vfsDatabase: {},
        vfsRepo: { essays: {} },
        externalLlmConfigs,
      },
    });

    // Pre-populate an existing embedding assignment to verify it is NEVER overwritten
    await activeHost.invoke('save_model_assignments', {
      assignments: {
        model2_config_id: null,
        anki_card_model_config_id: null,
        qbank_ai_grading_model_config_id: null,
        qbank_ai_generation_model_config_id: null,
        embedding_model_config_id: 'existing-embedding-id',
        reranker_model_config_id: null,
        chat_title_model_config_id: null,
        exam_sheet_ocr_model_config_id: null,
        translation_model_config_id: null,
        vl_embedding_model_config_id: null,
        vl_reranker_model_config_id: null,
        memory_decision_model_config_id: null,
        review_analysis_model_config_id: null,
        voice_input_asr_model_config_id: null,
        image_generation_model_config_id: null,
        compaction_model_config_id: null,
        translation_display_mode: null,
      },
    });

    const scanReport = await activeHost.invoke<ExternalLlmScanReport>('scan_external_llm_configs', {});
    expect(scanReport.autoScanSupported).toBe(true);
    expect(scanReport.skippedProxyCount).toBe(2);
    expect(scanReport.candidates).toHaveLength(3);

    // Ensure no raw API keys leaked into scan DTOs
    const serializedScan = JSON.stringify(scanReport);
    expect(serializedScan).not.toContain('sk-deepseek-real-11112222');
    expect(serializedScan).not.toContain('sk-alpha-primary-aaaa');
    expect(serializedScan).not.toContain('sk-ant-relay-987654321');

    const deepseekCand = scanReport.candidates.find((c) => c.matchedVendorId === 'builtin-deepseek')!;
    expect(deepseekCand).toBeDefined();
    expect(deepseekCand.syncStatus).toBe('match_builtin');

    // Alpha Relay merged across Magpie (2 keys) + CC Switch Codex (1 key) -> primary + 2 extra keys!
    const alphaCand = scanReport.candidates.find((c) => c.baseUrl === relayBaseUrl)!;
    expect(alphaCand).toBeDefined();
    expect(alphaCand.extraKeyCount).toBe(2);
    expect(alphaCand.sources).toEqual(['magpie', 'cc-switch']);
    expect(alphaCand.models).toHaveLength(0);

    const claudeRelayCand = scanReport.candidates.find(
      (c) => c.apiProtocol === 'anthropic_messages',
    )!;
    expect(claudeRelayCand.providerType).toBe('anthropic');
    expect(claudeRelayCand.models.map((m) => m.id)).toEqual(['claude-sonnet-5', 'claude-haiku-4-5']);

    // Live probe models on Alpha Relay before importing (sorted: recommended first, then alphabetical)
    const probed = await activeHost.invoke<ExternalCandidateModelDto[]>(
      'probe_external_llm_candidate_models',
      {
        sessionId: scanReport.sessionId,
        candidateId: alphaCand.candidateId,
      },
    );
    expect(probed.map((m) => m.id)).toEqual([
      'claude-sonnet-4-5',
      'gpt-5.4-mini',
      'bge-reranker-v2-m3',
    ]);

    // Import all 3 candidates
    const importResult = await activeHost.invoke<ExternalLlmImportResult>(
      'import_external_llm_configs',
      {
        sessionId: scanReport.sessionId,
        selections: [
          {
            candidateId: deepseekCand.candidateId,
            selectedModelIds: ['deepseek-v4-pro', 'deepseek-flash'],
          },
          {
            candidateId: alphaCand.candidateId,
            selectedModelIds: ['claude-sonnet-4-5', 'bge-reranker-v2-m3'],
          },
          {
            candidateId: claudeRelayCand.candidateId,
            selectedModelIds: ['claude-sonnet-5', 'claude-haiku-4-5'],
          },
        ],
        autoFetchMissingModels: true,
        autoAssignEmptySlots: true,
      },
    );

    expect(importResult.importedVendorCount).toBe(2);
    expect(importResult.updatedVendorCount).toBe(1); // builtin-deepseek
    expect(importResult.importedModelCount).toBeGreaterThanOrEqual(4);
    expect(importResult.assignedSlotCount).toBeGreaterThan(0);

    // Builtin DeepSeek key stored in secure store
    expect(settings.secrets.get('builtin-deepseek.api_key')).toBe('sk-deepseek-real-11112222');

    // Saved custom vendors have encrypted keys and 2 backup keys on Alpha Relay
    const savedVendors = await activeHost.invoke<VendorConfig[]>('get_vendor_configs', {});
    const savedAlpha = savedVendors.find((v) => v.baseUrl === relayBaseUrl)!;
    expect(savedAlpha.apiKey).toBe('***');
    expect(savedAlpha.apiKeys).toEqual(['***', '***']);

    const savedProfiles = await activeHost.invoke<ModelProfile[]>('get_model_profiles', {});
    expect(savedProfiles.some((p) => p.model === 'claude-sonnet-5' && p.apiProtocol === 'anthropic_messages')).toBe(true);
    expect(savedProfiles.some((p) => p.model === 'bge-reranker-v2-m3' && p.isReranker)).toBe(true);

    // Existing embedding slot preserved, empty primary/reranker slots filled
    const nextAssignments = await activeHost.invoke<ModelAssignments>('get_model_assignments', {});
    expect(nextAssignments.embedding_model_config_id).toBe('existing-embedding-id');
    expect(nextAssignments.model2_config_id).not.toBeNull();
    expect(nextAssignments.reranker_model_config_id).not.toBeNull();

    // Re-scanning immediately reports all 3 vendors as `synced` (idempotent incremental sync)
    const secondScan = await activeHost.invoke<ExternalLlmScanReport>('scan_external_llm_configs', {});
    expect(secondScan.candidates.map((c) => c.syncStatus)).toEqual(['synced', 'synced', 'synced']);
  });

  it('parses ccswitch://v1/import deep links (query & Base64 config) and SQL backup dumps via textInput', async () => {
    const settings = createInMemorySettings();
    activeHost = await createTestHost({
      plugins: [providers, llm],
      provide: {
        settings,
        secrets: createReversibleCrypto(),
        nativeImage: image,
        nativeTokenizer: tokenizer,
        injectionBudget: realInjectionBudget,
        vfsDatabase: {},
        vfsRepo: { essays: {} },
      },
    });

    const b64Config = Buffer.from(
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://relay-deeplink.example.com',
          ANTHROPIC_AUTH_TOKEN: 'sk-deeplink-token-5555',
          ANTHROPIC_MODEL: 'claude-opus-5',
        },
      }),
      'utf8',
    ).toString('base64');

    const deepLinkScan = await activeHost.invoke<ExternalLlmScanReport>('scan_external_llm_configs', {
      textInput: `ccswitch://v1/import?resource=provider&app=claude&name=DeepLinkRelay&config=${encodeURIComponent(b64Config)}`,
    });
    expect(deepLinkScan.autoScanSupported).toBe(false);
    expect(deepLinkScan.candidates).toHaveLength(1);
    expect(deepLinkScan.candidates[0]?.name).toBe('DeepLinkRelay');
    expect(deepLinkScan.candidates[0]?.apiProtocol).toBe('anthropic_messages');
    expect(deepLinkScan.candidates[0]?.models.map((m) => m.id)).toEqual(['claude-opus-5']);

    const sqlDump = `
      INSERT INTO "providers" ("id", "app_type", "name", "settings_config", "website_url", "meta")
      VALUES ('sql-1', 'gemini', 'Gemini Hub', '{"env":{"GEMINI_API_KEY":"AIzaSySqlBackupKey1234567890","GOOGLE_GEMINI_BASE_URL":"https://gemini-proxy.example.com","GEMINI_MODEL":"gemini-3-pro"}}', NULL, '{}');
    `;
    const sqlScan = await activeHost.invoke<ExternalLlmScanReport>('scan_external_llm_configs', {
      textInput: sqlDump,
    });
    expect(sqlScan.candidates).toHaveLength(1);
    expect(sqlScan.candidates[0]?.apiProtocol).toBe('google_generate_content');
    expect(sqlScan.candidates[0]?.models.map((m) => m.id)).toEqual(['gemini-3-pro']);

    // PowerShell $env: + inline shell env command + Anthropic relay `/v1/models` Bearer fallback
    const oneApiServer = http.createServer((req, res) => {
      if (req.url?.startsWith('/anthropic/v1/models')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Anthropic models endpoint not implemented' }));
        return;
      }
      if (req.url?.startsWith('/v1/models') && req.headers.authorization === 'Bearer sk-oneapi-999') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'zzz-legacy-model' }, { id: 'claude-sonnet-5' }],
          }),
        );
        return;
      }
      res.writeHead(401);
      res.end();
    });
    activeServers.push(oneApiServer);
    await new Promise<void>((resolve) => oneApiServer.listen(0, '127.0.0.1', resolve));
    const oneApiPort = (oneApiServer.address() as { port: number }).port;

    const psAndInlineScan = await activeHost.invoke<ExternalLlmScanReport>('scan_external_llm_configs', {
      textInput: `$env:ANTHROPIC_BASE_URL="http://127.0.0.1:${oneApiPort}/anthropic"\n$env:ANTHROPIC_AUTH_TOKEN="sk-oneapi-999"`,
    });
    expect(psAndInlineScan.candidates).toHaveLength(1);
    const relayProbed = await activeHost.invoke<ExternalCandidateModelDto[]>(
      'probe_external_llm_candidate_models',
      {
        sessionId: psAndInlineScan.sessionId,
        candidateId: psAndInlineScan.candidates[0]!.candidateId,
      },
    );
    // Fallback to /v1/models succeeded AND recommended model sorted first!
    expect(relayProbed.map((m) => m.id)).toEqual(['claude-sonnet-5', 'zzz-legacy-model']);
  });
});

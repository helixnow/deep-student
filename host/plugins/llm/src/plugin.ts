import { join } from '../../../platform/util/path.ts';
import { CommandError, definePlugin } from '../../../kernel/api.ts';
import type { HostPlugin, PluginPlatform } from '../../../kernel/core.ts';
import type {} from '../../../platform/settings/api.ts';
import type {} from '../../../platform/secrets/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type {
  ApiConfig__De, ModelAssignments__De, ModelProfile__De, VendorConfig__De,
} from '../api.ts';
import type { EstimateTokensRequest } from '../../../../contracts/ipc/generated/L02-llm-manager.ts';
import { LlmControl } from './control.ts';
import { decodeFailoverPolicy } from './policy.ts';
import {
  ConfigError, LlmConfigStore, modelAssignmentsFromDe, modelProfileFromDe, vendorConfigFromDe,
} from './config_store.ts';
import { requestAdapterIdForConfig, effectiveApiProtocolForConfig } from './protocol.ts';
import { createBudgetCommands } from './budget_commands.ts';
import {
  createDefaultApiConfigs, createDefaultModelAssignments,
} from './config_recovery.ts';
import { estimateTokens, estimateTokensForRequest } from './tokens.ts';
import { OpenCodeGoUsageError, VENDOR_ID, fetchUsage } from './opencode_go.ts';
import { fetchVendorModels } from './vendor_models.ts';
import { createLlmService } from './service.ts';
import { createLlmStreamingService } from './streaming_service.ts';
import type { LlmHttpClient } from './http_proxy.ts';
import { withLlmReplay } from './replay_fetch.ts';
import type { LlmReplayService } from '../../llm-providers/api.ts';
import { listAdapterInfos } from './adapters/registry.ts';
import { createEmbeddingModels } from './embedding_service.ts';
import { createTextEmbeddingService } from './embedding_transport.ts';
import { createLlmReranker } from './reranker.ts';
import type {} from '../../../platform/storage/api.ts';
import { createOcrModelsService } from './ocr_models_service.ts';
import { createOcrRegionsService } from './ocr_regions_service.ts';
import { createOcrHedgeService } from './ocr_hedge_service.ts';
import { createOcrPagesService, resolveImagePath, type OcrImageFiles } from './ocr_pages_service.ts';
import { createQuestionParsingService } from './question_parsing_service.ts';
import { buildModel2Messages } from './model2_messages.ts';
import { createProviderRequests } from './provider_requests_service.ts';
import { createStreamEventsService } from './model2_stream_events.ts';
import { createModel2StreamingService, type Model2UsageRecorder } from './model2_streaming_service.ts';
import type { WebSearchFallback } from './model2_request.ts';
import { createAnkiRoutingService } from './anki_routing_service.ts';
import { createMcpToolsService } from './mcp_tools_service.ts';
import { createLlmRagService } from './rag_service.ts';
import type {} from '../../vfs/api.ts';
import type {} from '../../vfs-repos/api.ts';
import type {} from '../../llm-providers/api.ts';
import { createEssayGradingService } from './essay_grading/service.ts';
import { CustomModeManager } from './essay_grading/custom_modes.ts';
import { createEssayTransport } from './essay_grading/transport.ts';
import { createRawPromptService } from './raw_prompt_service.ts';
import { buildDebugPersistConfig, setDebugLogFiles } from './audit_log.ts';
import { runQuestionJson } from './question_authoring.ts';
import { testApiConnection } from './connection_test.ts';
import { testDeepseekCapability } from './deepseek_capability_test.ts';
import { setLlmLogger, logDebug, logError, logInfo } from './logging.ts';
import type { LogService } from '../../../platform/log/api.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import type {} from '../../agent-skills/api.ts';
import type {} from '../../media/api.ts';
import { SettingsModelsRuntimeExecutor } from './settings_models_tool_runtime.ts';
import type { LLMManager, LlmFileManagerPaths, LlmUsageRecorder } from '../api.ts';
import { createUnifiedModel2 } from './unified_model2.ts';
import type {
  ConnectionTestOutcome, TestApiConnectionCommandArgs, TestDeepseekCapabilityCommandArgs,
} from '../../../../contracts/ipc/generated/L02-llm-manager.ts';

export interface LlmPluginOptions {
  platforms?: readonly PluginPlatform[];
  createHttpClient?: () => LlmHttpClient;
}

function createDirectHttpClient(): LlmHttpClient {
  return {
    fetch: (url, init) => fetch(url, init as RequestInit),
    async close() {},
  };
}

function throwAppError(error: unknown): never {
  if (error instanceof CommandError) throw error;
  if (error instanceof ConfigError) {
    const factory =
      error.kind === 'database' ? AppError.database
        : error.kind === 'configuration' ? AppError.configuration
          : AppError.validation;
    throw new CommandError(factory(error.message));
  }
  throw new CommandError(AppError.unknown(error instanceof Error ? error.message : String(error)));
}

export function createLlmPlugin(options: LlmPluginOptions = {}): HostPlugin {
  const createHttpClient = options.createHttpClient ?? createDirectHttpClient;
  return definePlugin({
    meta: {
      id: 'dstu.llm', lane: 'L02-llm-manager',
      commands: [
        'cancel_stream', 'llm_get_failover_policy', 'llm_set_failover_policy',
        'get_api_configurations', 'save_api_configurations', 'get_vendor_configs', 'save_vendor_configs',
        'get_model_profiles', 'save_model_profiles', 'get_model_assignments', 'save_model_assignments',
        'get_injection_budget_config', 'simulate_budget_allocation', 'estimate_tokens',
        'opencode_go_get_usage', 'check_api_config_status', 'restore_default_api_configs',
        'fetch_vendor_models', 'call_llm_for_boundary', 'test_api_connection', 'test_deepseek_capability',
      ],
      provides: ['llm', 'embedding@1', 'llmReranker', 'essayGrading', 'llmStreaming', 'llmAdapterInfos', 'llmEmbeddingModels', 'llmOcrModels', 'llmRag', 'llmOcrRegions', 'llmOcrHedge', 'llmQuestionParsing', 'llmModel2Messages', 'llmProviderRequests', 'llmStreamEvents', 'llmAnkiRouting', 'llmMcpTools', 'llmModel2Streaming', 'llmHttp', 'llmRawPrompt', 'llmQuestionAuthoring', 'llmOcrPages', 'llmFileOcr', 'llmContextCompiler'],
      ...(options.platforms === undefined ? {} : { platforms: options.platforms }),
    },
    inject: options.platforms?.includes('mobile')
      ? ['settings', 'secrets', 'vfsDatabase', 'vfsRepo', 'llmAdapters', 'injectionBudget', 'llmCodexAuth']
      : ['settings', 'secrets', 'vfsDatabase', 'vfsRepo', 'llmAdapters', 'nativeTokenizer', 'nativeImage', 'injectionBudget', 'llmCodexAuth'],
    apply(ctx) {
      const nativeTokenizer: import('../../../platform/native/tokenizer/api.ts').NativeTokenizer =
        (ctx.reflect.get('nativeTokenizer', false) as import('../../../platform/native/tokenizer/api.ts').NativeTokenizer | undefined) ?? {
          encode: () => { throw new Error('Exact token encoding is unavailable on mobile'); },
          estimateTokensWithModel: (text: string) => estimateTokens(text),
        };
      const nativeImage: import('../../../platform/native/image/api.ts').NativeImage =
        (ctx.reflect.get('nativeImage', false) as import('../../../platform/native/image/api.ts').NativeImage | undefined) ?? ({
          cropNormalizedRegionToPngBase64: () => { throw new Error('nativeImage is unavailable on mobile'); },
        } as unknown as import('../../../platform/native/image/api.ts').NativeImage);
      const logService = ctx.reflect.get('log', false) as LogService | undefined;
      const filesService = (): FilesService | undefined => ctx.reflect.get('files', false) as FilesService | undefined;
      setLlmLogger(logService?.logger('dstu_llm::llm_manager') ?? ctx.logger);
      setDebugLogFiles(filesService);
      ctx.effect(() => () => setDebugLogFiles(null));
      const replay = () => ctx.reflect.get('llmReplay', false) as LlmReplayService | undefined;
      const client = createHttpClient();
      ctx.effect(() => () => client.close());
      const http = { fetch: withLlmReplay(client.fetch, replay) };
      const directFetch = withLlmReplay((url, init) => fetch(url, init), replay);
      ctx.provide('llmHttp', { fetch: http.fetch });
      const control = new LlmControl(ctx.settings);
      const store = new LlmConfigStore({
        settings: ctx.settings,
        isEncryptedFormat: (value) => ctx.secrets.isEncryptedFormat(value),
        openCrypto: () => ctx.secrets.openCrypto(ctx.app.dataDir),
        hasUsableCodexSession: async () => (await ctx.llmCodexAuth.status()).hasUsableSession,
      });
      const core = createLlmService(store, control);
      const service: LLMManager = Object.assign(core, { callUnifiedModel2: createUnifiedModel2({ manager: core,
        candidateApiKeysFor: config => store.candidateApiKeysFor(config), adapters: ctx.llmAdapters,
        codex: ctx.llmCodexAuth, fetch: http.fetch,
        debugPersistConfig: () => buildDebugPersistConfig(ctx.settings, logService, ctx.app.dataDir) }) });
      const streaming = createLlmStreamingService(ctx.llmAdapters, http.fetch, ctx.llmCodexAuth);
      ctx.provide('llmStreaming', streaming);
      ctx.provide('llmQuestionParsing', createQuestionParsingService(service, streaming));
      ctx.provide('llmModel2Messages', { build: buildModel2Messages });
      const requests = createProviderRequests(ctx.llmAdapters, ctx.llmCodexAuth);
      const events = createStreamEventsService();
      ctx.provide('llmProviderRequests', requests);
      ctx.provide('llmStreamEvents', events);
      ctx.provide('llmAnkiRouting', createAnkiRoutingService(service));
      const mcp = createMcpToolsService(ctx.settings, {
        listenWindow: (window, event, receive) => ctx.backendEvents.listenWindow(window, event, receive),
        emit: (event, payload) => ctx.backendEvents.emit(event, payload),
      });
      ctx.provide('llmMcpTools', mcp);
      ctx.provide('llmModel2Streaming', createModel2StreamingService({ manager: service, settings: ctx.settings,
        requests, events, mcp, codex: ctx.llmCodexAuth, fetch: http.fetch,
        candidateApiKeysFor: config => store.candidateApiKeysFor(config), dataDir: ctx.app.dataDir, log: logService,
        usage: () => ctx.reflect.get('llmUsage', false) as Model2UsageRecorder | undefined,
        webSearch: () => ctx.reflect.get('llmWebSearchFallback', false) as WebSearchFallback | null ?? null,
      }));
      const rawPrompt = createRawPromptService({ manager: service,
        candidateApiKeysFor: config => store.candidateApiKeysFor(config), adapters: ctx.llmAdapters,
        codex: ctx.llmCodexAuth, fetch: http.fetch, emit: (channel, payload) => ctx.backendEvents.emit(channel, payload),
        debugPersistConfig: () => buildDebugPersistConfig(ctx.settings, logService, ctx.app.dataDir),
        usage: () => ctx.reflect.get('llmUsage', false) as LlmUsageRecorder | undefined });
      ctx.provide('llmRawPrompt', rawPrompt);
      ctx.provide('llmQuestionAuthoring', {
        async runQuestionJson(config, systemPrompt, userContent, cancel = null) {
          try {
            return await runQuestionJson({ streaming, decryptApiKey: apiKey => service.decryptApiKey(apiKey) },
              config, systemPrompt, userContent, cancel);
          } catch (error) {
            if (error instanceof CommandError) throw error;
            if (typeof error === 'object' && error !== null && 'error_type' in error && 'message' in error) {
              const value = error as { error_type: string; message: string; details?: unknown };
              throw new CommandError({ ...value, details: value.details ?? null });
            }
            throwAppError(error);
          }
        },
        buildDebugPersistConfig: () => buildDebugPersistConfig(ctx.settings, logService, ctx.app.dataDir),
      });
      ctx.provide('llmAdapterInfos', { listAdapterInfos });
      const embeddingModels = createEmbeddingModels(ctx.settings, service);
      ctx.provide('llmEmbeddingModels', embeddingModels);
      ctx.provide('embedding@1', createTextEmbeddingService(service, embeddingModels, http.fetch, () => {
        const usage = ctx.reflect.get('llmUsage', false) as import('../../../platform/storage/api.ts').LlmUsageService | undefined;
        if (!usage) throw AppError.configuration('F3 llmUsage service is required for text embedding');
        return usage;
      }, () => control.getFailoverPolicyExact()));
      ctx.provide('llmReranker', createLlmReranker(service, http.fetch, () => {
        const usage = ctx.reflect.get('llmUsage', false) as import('../../../platform/storage/api.ts').LlmUsageService | undefined;
        if (!usage) throw AppError.configuration('F3 llmUsage service is required for reranking');
        return usage;
      }));
      const ocrModels = createOcrModelsService(ctx.settings, service);
      ctx.provide('llmOcrModels', ocrModels);
      const hedge = createOcrHedgeService({ fetch: http.fetch, adapters: ctx.llmAdapters, codex: ctx.llmCodexAuth }, streaming, service, ocrModels);
      ctx.provide('llmOcrHedge', hedge);
      const ocrRegions = createOcrRegionsService(nativeImage, ocrModels,
        (name, payload) => ctx.backendEvents.emit(name, payload));
      ctx.provide('llmOcrRegions', ocrRegions);
      const ocrPages = createOcrPagesService({ manager: service, models: ocrModels, regions: ocrRegions, streaming,
        image: nativeImage, adapters: ctx.llmAdapters, codex: ctx.llmCodexAuth, fetch: http.fetch, hedge,
        files: (): OcrImageFiles => {
          const files = filesService();
          if (files === undefined) throw AppError.configuration('OCR 页面图片读取需要 files 服务');
          return files;
        },
        resolveImagePath: path => {
          const paths = ctx.reflect.get('fileManagerPaths', false) as LlmFileManagerPaths | undefined;
          return paths ? paths.resolveImagePath(path) : resolveImagePath(join(ctx.app.dataDir, 'images'), path);
        },
        platform: ctx.app.platform,
        emit: (name, payload) => ctx.backendEvents.emit(name, payload),
        usage: () => ctx.reflect.get('llmUsage', false) as LlmUsageRecorder | undefined });
      ctx.provide('llmOcrPages', ocrPages);
      ctx.provide('llmContextCompiler', {
        callRawPromptWithConfigIdAndImagesCancellable: rawPrompt.callRawPromptWithConfigIdAndImagesCancellable,
        callDedicatedOcrFreeTextWithFallback: ocrPages.callDedicatedOcrFreeTextWithFallback,
      });
      const asCommandError = async <T>(run: () => Promise<T>): Promise<T> => {
        try { return await run(); } catch (error) {
          if (error instanceof CommandError) throw error;
          if (typeof error === 'object' && error !== null && 'error_type' in error && 'message' in error) {
            const value = error as { error_type: string; message: string; details?: unknown };
            throw new CommandError({ ...value, details: value.details ?? null });
          }
          throwAppError(error);
        }
      };
      ctx.provide('llmFileOcr', {
        callOcrFreeTextWithFallback: (imagePath: string) => asCommandError(() => ocrPages.callOcrFreeTextWithFallback(imagePath)),
        callDedicatedOcrFreeTextWithFallback: (imagePath: string, cancellation: AbortSignal) =>
          asCommandError(() => ocrPages.callDedicatedOcrFreeTextWithFallback(imagePath, cancellation)),
      });
      ctx.provide('llmRag', createLlmRagService(service, ctx.llmAdapters, http.fetch, ctx.llmCodexAuth));
      {
        const modesFiles = (): FilesService => {
          const files = filesService();
          if (files === undefined) throw AppError.configuration('自定义批阅模式需要 files 服务');
          return files;
        };
        const modes = new CustomModeManager(ctx.app.dataDir, {
          exists: path => modesFiles().exists(path),
          mkdir: (path, options) => modesFiles().mkdir(path, options),
          readText: (path, options) => modesFiles().readText(path, options),
          rename: (from, to, options) => modesFiles().rename(from, to, options),
          rm: (path, options) => modesFiles().rm(path, options),
          writeText: (path, text, options) => modesFiles().writeText(path, text, options),
        });
        const transport = createEssayTransport(service, config => {
          const protocol = effectiveApiProtocolForConfig(config);
          return ctx.llmAdapters.createAdapter(protocol === 'anthropic_messages' ? 'anthropic'
            : protocol === 'google_generate_content' ? 'gemini'
              : protocol === 'openai_responses' ? 'openai_responses' : 'openai');
        }, http.fetch, undefined, ctx.llmCodexAuth);
        ctx.provide('essayGrading', createEssayGradingService({ llm: service,
          repository: ctx.vfsRepo.essays, connection: () => ctx.vfsDatabase.getConnSafe(),
          customModes: () => modes.listModes(), transport }, modes));
      }

      ctx.commands.register<{ streamEventName: string }, boolean>('cancel_stream', async ({ streamEventName }) => {
        logInfo(`[Backend] cancel_stream 收到前端请求: ${streamEventName}`);
        logDebug('[Backend] 调用 llm_manager.request_cancel_stream...');
        await control.requestCancelStream(streamEventName);
        logInfo('[Backend] cancel_stream 命令处理完成，返回成功');
        return true;
      });
      ctx.commands.register('llm_get_failover_policy', () => control.getFailoverPolicy());
      ctx.commands.register<{ policy: import('../api.ts').FailoverPolicy__De }, void>('llm_set_failover_policy', ({ policy }) =>
        control.saveFailoverPolicy(decodeFailoverPolicy(JSON.stringify(policy))));

      ctx.commands.register('get_api_configurations', async () => {
        try {
          const configs = await store.getApiConfigs();
          for (const config of configs) {
            if (config.isBuiltin) config.apiKey = '***';
            config.resolvedAdapterId = requestAdapterIdForConfig(config);
          }
          return configs;
        } catch (error) {
          throwAppError(error);
        }
      });

      ctx.commands.register<{ configs: ApiConfig__De[] }, void>('save_api_configurations', async ({ configs }) => {
        logInfo('[后端] 接收到保存API配置请求');
        logDebug(`  - 配置数量: ${configs.length}`);
        logDebug(`  - 配置ID列表: ${JSON.stringify(configs.map(config => config.id))}`);
        logDebug(`  - 配置名称列表: ${JSON.stringify(configs.map(config => config.name))}`);
        try {
          await store.saveApiConfigurations(configs);
          logInfo('[后端] API配置保存成功');
        } catch (error) {
          const detail = error instanceof ConfigError
            ? `AppError { error_type: ${error.kind === 'database' ? 'Database' : error.kind === 'configuration' ? 'Configuration' : 'Validation'}, message: ${JSON.stringify(error.message)}, details: None }`
            : error instanceof Error ? error.message : String(error);
          logError(`[后端] API配置保存失败: ${detail}`);
          throwAppError(error);
        }
      });

      ctx.commands.register('get_vendor_configs', async () => {
        try {
          return await store.getVendorConfigs();
        } catch (error) {
          throwAppError(error);
        }
      });

      ctx.commands.register<{ configs: VendorConfig__De[] }, void>('save_vendor_configs', async ({ configs }) => {
        try {
          await store.saveVendorConfigs(configs.map(vendorConfigFromDe));
        } catch (error) {
          throwAppError(error);
        }
      });

      ctx.commands.register('get_model_profiles', async () => {
        try {
          return await store.getModelProfiles();
        } catch (error) {
          throwAppError(error);
        }
      });

      ctx.commands.register<{ profiles: ModelProfile__De[] }, void>('save_model_profiles', async ({ profiles }) => {
        try {
          await store.saveModelProfiles(profiles.map(modelProfileFromDe));
        } catch (error) {
          throwAppError(error);
        }
      });

      ctx.commands.register('get_model_assignments', async () => {
        try {
          return await store.getModelAssignments();
        } catch (error) {
          throwAppError(error);
        }
      });

      ctx.commands.register<{ assignments: ModelAssignments__De }, void>('save_model_assignments', async ({ assignments }) => {
        try {
          await store.saveModelAssignments(modelAssignmentsFromDe(assignments));
        } catch (error) {
          throwAppError(error);
        }
      });

      const budgetCommands = createBudgetCommands(ctx.settings, ctx.injectionBudget);
      ctx.commands.register('get_injection_budget_config', () => budgetCommands.getConfig());
      ctx.commands.register<{ testItems: unknown[] }, unknown>('simulate_budget_allocation', ({ testItems }) => budgetCommands.simulate(testItems));

      ctx.commands.register('check_api_config_status', async () => {
        let configs;
        try {
          configs = await store.getApiConfigs();
        } catch (error) {
          throw new CommandError(`获取配置失败: ${error instanceof Error ? error.message : String(error)}`);
        }
        let hasAssignments = false;
        try {
          const assignments = await store.getModelAssignments();
          hasAssignments =
            assignments.model2_config_id !== null ||
            assignments.review_analysis_model_config_id !== null;
        } catch { // boundary-allow empty-catch: Rust `if let Ok(ref assigns) = assignments` 忽略分配读取错误
        }
        return {
          config_count: configs.length,
          enabled_count: configs.filter((config) => config.enabled).length,
          has_assignments: hasAssignments,
          needs_recovery: configs.length === 0,
        };
      });

      ctx.commands.register('restore_default_api_configs', async () => {
        try {
          await store.saveApiConfigurations(createDefaultApiConfigs());
        } catch (error) {
          throw new CommandError(`保存默认配置失败: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
          await store.saveModelAssignments(createDefaultModelAssignments());
        } catch (error) {
          throw new CommandError(`保存模型分配失败: ${error instanceof Error ? error.message : String(error)}`);
        }
        return '✅ 默认API配置已恢复！请填入您的API密钥并启用相应配置。';
      });

      ctx.commands.register<{ request: EstimateTokensRequest }, unknown>('estimate_tokens', ({ request }) => {
        return estimateTokensForRequest(request.texts, request.model, nativeTokenizer);
      });

      ctx.commands.register<{ vendorId?: string | null }, unknown>('opencode_go_get_usage', async ({ vendorId }) => {
        const id = vendorId ?? VENDOR_ID;
        try {
          const vendor = await store.vendorConfigForRuntime(id);
          const isGoVendor =
            vendor.id === VENDOR_ID || vendor.providerType.toLowerCase() === 'opencode_go';
          if (!isGoVendor) throw new CommandError(AppError.validation('该供应商不是 OpenCode Go'));
          const primary = vendor.isBuiltin
            ? vendor.apiKey.trim()
            : (await store.decryptApiKeyIfNeeded(vendor.apiKey)).trim();
          const key = [primary, ...vendor.apiKeys.map((item) => item.trim())].find(
            (candidate) => candidate !== '' && ![...candidate].every((ch) => ch === '*'),
          );
          if (key === undefined) throw new CommandError(AppError.validation('请先填写 OpenCode Go 的 API Key'));
          return await fetchUsage(key, ctx.app.version);
        } catch (error) {
          if (error instanceof CommandError) throw error;
          if (error instanceof OpenCodeGoUsageError) {
            throw new CommandError(
              error.kind === 'Network' ? AppError.network(error.message) : AppError.llm(error.message),
            );
          }
          throwAppError(error);
        }
      });

      ctx.commands.register<{ vendorId: string }>('fetch_vendor_models', async ({ vendorId }) => {
        try {
          const vendor = await store.vendorConfigForRuntime(vendorId.trim());
          return await fetchVendorModels(vendor, {
            fetch: directFetch,
          });
        } catch (error) {
          if (error instanceof CommandError) throw error;
          if (
            typeof error === 'object' && error !== null && 'error_type' in error && 'message' in error
          ) {
            const value = error as { error_type: string; message: string; details?: unknown };
            throw new CommandError({ ...value, details: value.details ?? null });
          }
          throwAppError(error);
        }
      });

      ctx.commands.register<TestDeepseekCapabilityCommandArgs, number>('test_deepseek_capability', async (args) => {
        try {
          const vendor = await store.vendorConfigForRuntime('builtin-deepseek');
          return await testDeepseekCapability(args, {
            fetch: http.fetch, baseUrl: vendor.baseUrl,
            providerKey: () => store.decryptApiKeyIfNeeded(vendor.apiKey),
            searchKey: () => ctx.settings.getSecret('web_search.api_key.deepseek'),
            needContent: ctx.settings.get('web_search.deepseek.need_content') === 'true',
            flash: () => store.runtimeConfigForVendorModel(vendor.id, 'deepseek-flash'),
          });
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'error_type' in error && 'message' in error) {
            const value = error as { error_type: string; message: string; details?: unknown };
            throw new CommandError({ ...value, details: value.details ?? null });
          }
          throwAppError(error);
        }
      });

      ctx.commands.register<TestApiConnectionCommandArgs, ConnectionTestOutcome>(
        'test_api_connection',
        async (args) => {
          try {
            return await testApiConnection(args, {
              store,
              fetch: directFetch,
              now: () => Date.now(),
              getSecret: (key) => ctx.settings.getSecret(key),
              codex: ctx.llmCodexAuth,
            });
          } catch (error) {
            if (error instanceof CommandError) throw error;
            if (typeof error === 'object' && error !== null && 'error_type' in error && 'message' in error) {
              const value = error as { error_type: string; message: string; details?: unknown };
              throw new CommandError({ ...value, details: value.details ?? null });
            }
            throwAppError(error);
          }
        },
      );

      ctx.commands.register<{ prompt: string }>('call_llm_for_boundary', async ({ prompt }) => {
        logInfo('调用 LLM 进行边界定界');
        try {
          const output = await rawPrompt.callModel2RawPrompt(prompt, null, { other: 'boundary_detection' });
          logInfo('LLM 定界成功');
          return { assistant_message: output.assistant_message, input_tokens: 0, output_tokens: 0 };
        } catch (error) {
          logError(`LLM 定界失败: ${error instanceof Error ? error.message : String(error)}`);
          if (error instanceof CommandError) throw error;
          if (typeof error === 'object' && error !== null && 'error_type' in error && 'message' in error) {
            const value = error as { error_type: string; message: string; details?: unknown };
            throw new CommandError({ ...value, details: value.details ?? null });
          }
          throwAppError(error);
        }
      });

      ctx.provide('llm', service);

      ctx.inject(['agentTools', 'media'], scope => {
        const executor = new SettingsModelsRuntimeExecutor({
          settings: ctx.settings,
          manager: {
            getApiConfigs: () => service.getApiConfigs(),
            getVendorConfigs: () => service.getVendorConfigs(),
            getModelProfiles: () => service.getModelProfiles(),
            getModelAssignments: () => service.getModelAssignments(),
            saveVendorModelConfigs: (vendors, profiles) => store.saveVendorModelConfigs(vendors, profiles),
            saveModelAssignments: assignments => store.saveModelAssignments(assignments),
          },
          probe: {
            fetchVendorModels: async vendor => {
              const models = await fetchVendorModels(vendor, { fetch: directFetch });
              return models.map(model => ({
                id: model.id,
                label: model.label,
                context_window: model.contextWindow ?? null,
                max_output_tokens: model.maxOutputTokens ?? null,
              }));
            },
            testConnection: async (vendor, model, persisted) => {
              const outcome = await testApiConnection({
                apiKey: vendor.apiKey,
                apiBase: vendor.baseUrl,
                model,
                providerType: vendor.providerType,
                authMode: vendor.authMode,
                apiProtocol: vendor.apiProtocol,
                supportsOpenaiResponses: vendor.supportsOpenaiResponses,
                headers: vendor.headers,
                vendorId: persisted ? vendor.id : null,
              }, {
                store,
                fetch: directFetch,
                now: () => Date.now(),
                getSecret: key => ctx.settings.getSecret(key),
                codex: ctx.llmCodexAuth,
              });
              return {
                ok: outcome.ok,
                latency_ms: outcome.latencyMs,
                message: outcome.message ?? '',
                warning: outcome.warning ?? null,
                category: outcome.category ?? null,
              };
            },
          },
          voiceInput: scope.media,
          emit: (event, payload) => ctx.backendEvents.emit(event, payload),
          warn: message => ctx.logger.warn(message),
        });
        const registration = scope.agentTools.registerToolExecutors([executor]);
        scope.effect(() => () => registration.dispose());
      });
    },
  });
}

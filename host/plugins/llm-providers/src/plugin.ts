import { CommandError, definePlugin } from '../../../kernel/api.ts';
import type { HostPlugin, PluginPlatform } from '../../../kernel/core.ts';
import type {} from '../../../platform/settings/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L01-llm-providers.ts';
import { CodexAuthError } from './openai-codex/error.ts';
import { CodexAuthManager, type CodexAuthCapabilities } from './openai-codex/manager.ts';
import {
  prepareProviderRequest, sendCodexRequestWithSingleRefresh, sendCodexStreamRequestWithSingleRefresh,
} from './openai-codex/prepare.ts';
import { CodexEndpointConfig } from './openai-codex/protocol.ts';
import { DatabaseCodexCredentialStore } from './openai-codex/store.ts';
import { codexUsageToWire } from './openai-codex/usage-wire.ts';
import {
  cachedRemoteImage, prepareRemoteImages, setRemoteImageDownloader, setRemoteImageFetcher,
  type RemoteImageDownloader,
} from './media/remote-image.ts';
import { OpenAIAdapter } from './providers/openai-chat.ts';
import { OpenAIResponsesAdapter } from './providers/openai-responses.ts';
import { AnthropicAdapter } from './providers/anthropic.ts';
import { GeminiAdapter } from './providers/gemini.ts';
import { OcrAdapterService } from './ocr/service.ts';
import { MultimodalService } from './multimodal/service.ts';
import {
  type LlmAdapterService, type LlmCodexAuthService, type ProviderKind,
} from '../api.ts';

/** src/cmd/openai_codex.rs:8 `command_error`. */
const CODEX_COMMAND_ERROR = 'OpenAI Codex authentication request failed';
/** src/cmd/openai_codex.rs:31. */
const UNSUPPORTED_LOGIN_FLOW = 'Unsupported OpenAI Codex login flow';

/** Dependency injection for tests / alternate deployments; production defaults to the real endpoints. */
export interface LlmProvidersPluginConfig {
  codexEndpoints?: CodexEndpointConfig;
}

/** 平台差异部分：桌面入口注入回环回调服务，移动端入口不注入（浏览器登录不可用）。 */
export interface LlmProvidersPluginOptions extends LlmProvidersPluginConfig {
  platforms?: readonly PluginPlatform[];
  capabilities?: CodexAuthCapabilities;
  remoteImageDownloader?: RemoteImageDownloader | null;
}

/**
 * 插件本体（可移植）：文件/网络只经平台服务与 Web 标准 API，桌面与移动端共用。
 * 入口按平台在 `index.ts`（桌面，注入 node:http 回环回调服务）与 `mobile.ts`（移动端）之间选择。
 */
export function createLlmProvidersPlugin(options: LlmProvidersPluginOptions = {}): HostPlugin<LlmProvidersPluginConfig> {
  return definePlugin<LlmProvidersPluginConfig>({
    meta: {
      id: 'dstu.llm-providers', lane: 'L01-llm-providers',
      commands: ['openai_codex_auth_status', 'openai_codex_login_cancel', 'openai_codex_login_start', 'openai_codex_logout', 'openai_codex_usage'],
      provides: ['llmAdapters', 'llmOcr', 'llmMultimodal', 'llmCodexAuth'],
      ...(options.platforms === undefined ? {} : { platforms: options.platforms }),
    },
    inject: ['settings'],
    apply(ctx, config) {
    // providers/mod.rs:98,828,2306,3809: one fresh stateful adapter per request.
    const adapterService: LlmAdapterService = {
      createAdapter(kind: ProviderKind) {
        switch (kind) {
          case 'openai': return new OpenAIAdapter(ctx.logger);
          case 'openai_responses': return new OpenAIResponsesAdapter(ctx.logger);
          case 'anthropic': return new AnthropicAdapter(ctx.logger);
          case 'gemini': return new GeminiAdapter(ctx.logger);
        }
      },
      prepareRemoteImages,
    };
    // providers/mod.rs:3509: production registration for the synchronous
    // buildRequest reader. `prepareRemoteImages` fills the same cache.
    setRemoteImageFetcher({ fetchImage: cachedRemoteImage });
    setRemoteImageDownloader(options.remoteImageDownloader ?? null);
    ctx.effect(() => () => { setRemoteImageFetcher(null); setRemoteImageDownloader(null); });
    ctx.provide('llmAdapters', adapterService);
    // OCR adapter construction and multimodal indexing helpers are consumed by
    // media/docs and indexing lanes; both are pure library logic with no I/O.
    ctx.provide('llmOcr', new OcrAdapterService());
    ctx.provide('llmMultimodal', new MultimodalService(ctx.logger));

    // src-tauri/crates/dstu-llm/src/llm_manager/mod.rs:4754 `CodexAuthManager::new(db)`.
    const manager = CodexAuthManager.create(
      new DatabaseCodexCredentialStore(ctx.settings),
      ctx.app.version,
      config?.codexEndpoints ?? new CodexEndpointConfig(),
      options.capabilities,
    );
    ctx.effect(() => () => { void manager.then((value) => value.dispose()); });

    // The five IPC commands and this service share one manager promise; L02
    // consumes the service instead of reading the credential store again.
    const codexAuthService: LlmCodexAuthService = {
      async status() { return (await manager).status(); },
      async requestAuth(forceRefresh = false) { return (await manager).requestAuth(forceRefresh); },
      async refreshAfterUnauthorized(observedGeneration) {
        return (await manager).refreshAfterUnauthorized(observedGeneration);
      },
      async markReauthenticationRequired(observedGeneration) {
        return (await manager).markReauthenticationRequired(observedGeneration);
      },
      async responsesEndpoint() { return (await manager).responsesEndpoint(); },
      async prepareRequest(adapter, config, body, options) {
        return prepareProviderRequest(await manager, adapter, config, body, options, ctx.logger, ctx.app.version);
      },
      async sendWithSingleRefresh(request, options) {
        return sendCodexRequestWithSingleRefresh(await manager, request, options, ctx.logger);
      },
      async sendStreamWithSingleRefresh(request, options) {
        return sendCodexStreamRequestWithSingleRefresh(await manager, request, options, ctx.logger);
      },
    };
    ctx.provide('llmCodexAuth', codexAuthService);

    // src/cmd/openai_codex.rs:8: log the Rust Display text, then return the fixed frontend string.
    const mapError = (error: unknown): never => {
      if (!(error instanceof CodexAuthError)) throw error;
      ctx.logger.warn('[OpenAI Codex OAuth] command failed: %s', error.message);
      throw new CommandError(CODEX_COMMAND_ERROR);
    };

    ctx.commands.register<Commands['openai_codex_auth_status']['args'], Commands['openai_codex_auth_status']['result']>(
      'openai_codex_auth_status', async () => {
        const status = await (await manager).status();
        // D3: only this IPC DTO boundary may round the internal i64 timestamp.
        return { ...status, expiresAtUnixMs: status.expiresAtUnixMs === null ? null : Number(status.expiresAtUnixMs) };
      });

    ctx.commands.register<Commands['openai_codex_login_start']['args'], Commands['openai_codex_login_start']['result']>(
      'openai_codex_login_start', async ({ flow }) => {
        const auth = await manager;
        if (flow === 'browser') {
          try { return await auth.startBrowserLogin(); } catch (error) { return mapError(error); }
        }
        if (flow === 'device_code' || flow === 'device') {
          try { return await auth.startDeviceLogin(); } catch (error) { return mapError(error); }
        }
        throw new CommandError(UNSUPPORTED_LOGIN_FLOW);
      });

    ctx.commands.register<Commands['openai_codex_login_cancel']['args'], Commands['openai_codex_login_cancel']['result']>(
      'openai_codex_login_cancel', async ({ attemptId }) => {
        try { await (await manager).cancelLogin(attemptId); } catch (error) { return mapError(error); }
        return null;
      });

    ctx.commands.register<Commands['openai_codex_logout']['args'], Commands['openai_codex_logout']['result']>(
      'openai_codex_logout', async () => {
        try { await (await manager).logout(); } catch (error) { return mapError(error); }
        return null;
      });

    ctx.commands.register<Commands['openai_codex_usage']['args'], Commands['openai_codex_usage']['result']>(
      'openai_codex_usage', async () => {
        try { return codexUsageToWire(await (await manager).usageSnapshot()); } catch (error) { return mapError(error); }
      });
  },
  });
}

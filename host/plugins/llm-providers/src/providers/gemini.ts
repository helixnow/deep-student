import type { JsonValue, PluginLogger, ProviderAdapter, ProviderRequest, StreamEvent } from '../../api.ts';
import { object, string } from '../json.ts';
import {
  AdapterError, buildGeminiRequestWithVersion, parseGeminiStreamLine, type GeminiPendingToolCall,
} from '../adapters/gemini-openai-converter.ts';

/** providers/mod.rs:3809 `GeminiAdapter`. Keeps OpenAI-compatible wire semantics. */
export class GeminiAdapter implements ProviderAdapter {
  _logger?: PluginLogger;
  _pendingToolCalls = new Map<number, GeminiPendingToolCall>();

  constructor(logger?: PluginLogger) { this._logger = logger; }

  requiresExplicitStreamCompletion(): boolean { return true; }

  buildRequest(baseUrl: string, apiKey: string, model: string, body: JsonValue): ProviderRequest {
    // providers/mod.rs:3833: "v1beta:model" / "v1:model" prefixes select the API version.
    let apiVersion: string | undefined;
    let actualModel = model;
    const colon = model.indexOf(':');
    if (colon >= 0) {
      const prefix = model.slice(0, colon);
      if (prefix === 'v1' || prefix === 'v1beta') {
        apiVersion = prefix;
        actualModel = model.slice(colon + 1);
      }
    }

    // providers/mod.rs:3848: the body field wins only when the model has no prefix.
    if (apiVersion === undefined) {
      const explicitVersion = string(object(body)?.gemini_api_version);
      if (explicitVersion === 'v1' || explicitVersion === 'v1beta') apiVersion = explicitVersion;
    }

    try {
      return buildGeminiRequestWithVersion(baseUrl, apiKey, actualModel, body, apiVersion, this._logger);
    } catch (error) {
      if (!(error instanceof AdapterError)) throw error;
      throw new Error(`Gemini 请求构建失败: ${error.message}`);
    }
  }

  parseStream(line: string): StreamEvent[] {
    // The converter's StreamEvent already matches providers/mod.rs, including
    // Done/Usage/SafetyBlocked, so no shape translation is needed.
    return parseGeminiStreamLine(line, this._pendingToolCalls);
  }

  finishStream(): StreamEvent[] { return []; }
}

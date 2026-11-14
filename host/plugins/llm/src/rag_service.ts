/** Nonstream translation entry of LLMManager (rag_extension.rs:896–1004). */
import type { LLMManager, LlmRagService } from '../api.ts';
import type { LlmAdapterService, LlmCodexAuthService } from '../../llm-providers/api.ts';
import { buildSystemPrompt, buildUserPrompt } from '../../translation/api.ts';
import { AppError, type JsonValue } from '../../../platform/errors/api.ts';
import { statusLine, utf8ByteLength } from '../../../platform/util/portable.ts';
import { effectiveApiProtocolForConfig } from './protocol.ts';
import { prepareProviderRequest } from './prepared_request.ts';
import { normalizeNonstreamResponseToOpenaiForConfig } from './mod_compat.ts';
import { ragTranslationRequestBody } from './rag_extension.ts';
import { logError, logInfo } from './logging.ts';

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function createLlmRagService(llm: LLMManager, adapters: LlmAdapterService, fetcher: typeof fetch, codex?: LlmCodexAuthService): LlmRagService {
  return {
    async translateText(text, srcLang, tgtLang, customPrompt) {
      logInfo(`开始翻译：${srcLang} -> ${tgtLang}, 文本长度：${utf8ByteLength(text)}`);
      const config = await llm.getTranslationModelConfig();
      const apiKey = await llm.decryptApiKey(config.apiKey);
      const request = { text, src_lang: srcLang, tgt_lang: tgtLang, prompt_override: customPrompt,
        session_id: '', formality: null, glossary: null, domain: null };
      const body = ragTranslationRequestBody(config, [
        { role: 'system', content: buildSystemPrompt(request) },
        { role: 'user', content: buildUserPrompt(request, text) },
      ]);
      const protocol = effectiveApiProtocolForConfig(config);
      const adapter = adapters.createAdapter(protocol === 'anthropic_messages' ? 'anthropic'
        : protocol === 'google_generate_content' ? 'gemini'
          : protocol === 'openai_responses' ? 'openai_responses' : 'openai');
      const { request: prepared, codexRequest } = await prepareProviderRequest(adapters, codex, adapter,
        config, body, apiKey, null, '翻译请求构建失败');
      let response: Response;
      if (codexRequest !== null && codex !== undefined) response = await codex.sendWithSingleRefresh(codexRequest, { fetch: fetcher });
      else try {
        response = await fetcher(prepared.url, { method: 'POST', headers: prepared.headers, body: JSON.stringify(prepared.body) });
      } catch (error) { throw AppError.llm(`翻译请求失败: ${messageOf(error)}`); }
      if (!response.ok) {
        const errorText = await response.text().catch(() => ''); // Rust unwrap_or_default
        logError(`[Translation] API error ${statusLine(response.status)}: ${errorText}`);
        throw AppError.llm(response.status === 401 ? 'API 密钥无效或已过期，请检查设置'
          : response.status === 403 ? 'API 访问被拒绝，请检查账户权限'
            : response.status === 429 ? '请求过于频繁，请稍后重试'
              : response.status >= 500 && response.status <= 599 ? '翻译服务暂时不可用，请稍后重试' : '翻译请求失败，请重试');
      }
      let responseText: string;
      try { responseText = await response.text(); }
      catch (error) { throw AppError.llm(`读取翻译响应失败: ${messageOf(error)}`); }
      let json: JsonValue;
      try { json = JSON.parse(responseText) as JsonValue; }
      catch (error) { throw AppError.llm(`解析翻译响应JSON失败: ${messageOf(error)}, 原始内容: ${responseText}`); }
      const normalized = normalizeNonstreamResponseToOpenaiForConfig(config, json);
      const content = (normalized as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw AppError.llm('翻译响应中未找到内容');
      logInfo(`翻译完成，结果长度：${utf8ByteLength(content)}`);
      return content;
    },
  };
}

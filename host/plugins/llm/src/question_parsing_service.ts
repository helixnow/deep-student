/** mod.rs:3017–3130 and 8717–8867. */
import type { ApiConfig, LLMManager, LlmQuestionParsing, LlmStreamingService } from '../api.ts';
import { AppError, type JsonValue } from '../../../platform/errors/api.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import { defaultSingleShotOptions } from './single_shot_stream.ts';
import { questionParsingRequestBody } from './mod_compat.ts';
import { logWarn } from './logging.ts';

export class IncrementalJsonArrayParser {
  private buffer = '';
  private inArray = false;
  private braceDepth = 0;
  private inString = false;
  private escapeNext = false;

  feed(chunk: string): JsonValue[] | null {
    const results: JsonValue[] = [];
    for (const ch of chunk) {
      if (this.escapeNext) {
        this.escapeNext = false;
        if (this.braceDepth > 0) this.buffer += ch;
        continue;
      }
      if (ch === '\\' && this.inString) {
        this.escapeNext = true;
        if (this.braceDepth > 0) this.buffer += ch;
        continue;
      }
      if (ch === '"' && !this.escapeNext) {
        this.inString = !this.inString;
        if (this.braceDepth > 0) this.buffer += ch;
        continue;
      }
      if (this.inString) { if (this.braceDepth > 0) this.buffer += ch; continue; }
      if (ch === '[' && !this.inArray && this.braceDepth === 0) { this.inArray = true; continue; }
      if (ch === ']' && this.inArray && this.braceDepth === 0) { this.inArray = false; continue; }
      if (ch === '{') {
        if (this.braceDepth === 0) this.buffer = '';
        this.braceDepth++; this.buffer += ch; continue;
      }
      if (ch === '}') {
        this.braceDepth--; this.buffer += ch;
        if (this.braceDepth === 0 && this.buffer !== '') {
          try { results.push(JSON.parse(this.buffer) as JsonValue); }
          catch { // boundary-allow empty-catch: mod.rs:3096 ignores complete objects that fail JSON parsing without logging
          }
          this.buffer = '';
        }
        continue;
      }
      if (this.braceDepth > 0) this.buffer += ch;
    }
    return results.length ? results : null;
  }

  finalize(): JsonValue[] | null {
    if (rustTrim(this.buffer) === '') return null;
    try {
      const value = JSON.parse(this.buffer) as JsonValue;
      this.buffer = ''; return [value];
    } catch { return null; }
  }
}

export function createQuestionParsingService(llm: LLMManager, streaming: LlmStreamingService): LlmQuestionParsing {
  async function resolve(id?: string | null): Promise<[ApiConfig, string]> {
    let config: ApiConfig;
    if (id == null) config = await llm.getModel2Config();
    else {
      const found = (await llm.getApiConfigs()).find(config => config.id === id);
      if (found === undefined) throw AppError.configuration(`找不到指定的模型配置: ${id}`);
      config = found;
    }
    return [config, await llm.decryptApiKey(config.apiKey)];
  }
  return {
    async parse(prompt, id) {
      const [config, key] = await resolve(id);
      return (await streaming.singleShotCompletion(config, questionParsingRequestBody(config, prompt), key, null,
        '题目解析请求构建失败', defaultSingleShotOptions(`题目解析(${config.model})`))).content;
    },
    async parseStreaming(prompt, id, onQuestion) {
      const [config, key] = await resolve(id);
      const questions: JsonValue[] = [], parser = new IncrementalJsonArrayParser();
      const completion = await streaming.singleShotCompletion(config, questionParsingRequestBody(config, prompt), key, null,
        '题目解析流式请求构建失败', defaultSingleShotOptions(`题目解析流式(${config.model})`), delta => {
          for (const question of parser.feed(delta) ?? []) {
            if (!onQuestion(structuredClone(question))) return false;
            questions.push(question);
          }
          return true;
        });
      if (completion.interrupted !== null) logWarn(`[LLM] 题目解析流中断，保留已解析的 ${questions.length} 题（${utf8ByteLength(completion.content)} 字符）: ${completion.interrupted}`);
      if (!completion.aborted) for (const question of parser.finalize() ?? []) {
        if (onQuestion(structuredClone(question))) questions.push(question);
      }
      return questions;
    },
  };
}

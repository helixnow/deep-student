import { AppError } from '../../../platform/errors/api.ts';
import { fromBase64 } from '../../../platform/crypto/encoding.ts';
import { openaiEndpointUrl } from '../../llm-providers/api.ts';
import { isOfficialDeepseekFlashResponses, uploadDeepseekDocument } from './deepseek_files.ts';
import { recognizeDeepseekPage } from './deepseek_ocr_api.ts';
import type { ApiConfig } from '../api.ts';
import type { TestDeepseekCapabilityCommandArgs } from '../../../../contracts/ipc/generated/L02-llm-manager.ts';

const official = 'https://api.deepseek.com';
const testPage = 'https://www.iana.org/help/example-domains';
const sampleCode = '34971';

interface ProbeDeps {
  fetch: typeof fetch;
  baseUrl: string;
  providerKey(): Promise<string | null>;
  searchKey(): Promise<string | null>;
  flash(): Promise<ApiConfig | null>;
  needContent: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Probes bypass app switches and fallback engines, so a successful test identifies the actual endpoint. */
export async function testDeepseekCapability(args: TestDeepseekCapabilityCommandArgs, deps: ProbeDeps): Promise<number> {
  const start = performance.now();
  if (URL.parse(deps.baseUrl)?.origin !== official) throw AppError.configuration('An official DeepSeek connection is required');
  const standalone = args.capability === 'search' || args.capability === 'fetch';
  const key = (standalone ? await deps.searchKey() : null) || await deps.providerKey();
  if (!key || /^\*+$/.test(key)) throw AppError.configuration('The DeepSeek provider has no API key');
  const send = async (url: string, body: object): Promise<Record<string, unknown>> => {
    const response = await deps.fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw AppError.llm(`DeepSeek API: HTTP ${response.status}`);
    const data = record(await response.json());
    if (data.error) throw AppError.llm(`DeepSeek API: ${String(record(data.error).code ?? 'request failed')}`);
    return data;
  };
  const assertResult = (ok: boolean) => {
    if (!ok) throw AppError.llm('DeepSeek did not return a usable result for this capability');
  };

  switch (args.capability) {
    case 'search': {
      const data = await send(`${official}/v1/tools/search`, { query: 'IANA example domains', count: 1, need_content: deps.needContent });
      assertResult(Array.isArray(data.results) && data.results.some(row => typeof record(row).url === 'string'));
      break;
    }
    case 'fetch': {
      const data = await send(`${official}/v1/tools/fetch`, { url: testPage });
      assertResult(typeof data.content === 'string' && Boolean(data.content.trim()));
      break;
    }
    case 'ocr': {
      if (!args.image || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(args.image) || args.image.length > 128_000) {
        throw AppError.validation('A small PNG test image is required');
      }
      const result = await recognizeDeepseekPage(deps.fetch, key, args.image, 'rich_layout_recognition');
      assertResult(result.includes(sampleCode));
      break;
    }
    case 'asr': {
      if (!args.audio || !/^[A-Za-z0-9+/=]+$/.test(args.audio) || args.audio.length > 16_000) {
        throw AppError.validation('A small Ogg test clip is required');
      }
      const bytes = fromBase64(args.audio);
      if (new TextDecoder().decode(bytes.slice(0, 4)) !== 'OggS') throw AppError.validation('The test clip must be Ogg audio');
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/ogg' }), 'test.ogg');
      const response = await deps.fetch(`${official}/v1/tools/asr`, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(90_000), body: form });
      if (!response.ok) throw AppError.llm(`DeepSeek ASR: HTTP ${response.status}`);
      const result = record(await response.json());
      assertResult(!result.error && typeof result.text === 'string' && /\btest\b/i.test(result.text));
      break;
    }
    case 'chat_search': case 'chat_read_url': case 'chat_safety': case 'chat_files': {
      const config = await deps.flash();
      if (!config || !isOfficialDeepseekFlashResponses(config)) throw AppError.configuration('Configure deepseek-flash with OpenAI Responses');
      const url = openaiEndpointUrl(config.baseUrl, 'responses');
      let fileId: string | undefined;
      if (args.capability === 'chat_files') {
        fileId = await uploadDeepseekDocument(deps.fetch, key, 'deepstudent-capability-test.txt',
          new TextEncoder().encode(`Verification code: ${sampleCode}`), 'user_data', AbortSignal.timeout(90_000), 3600);
      }
      const search = args.capability === 'chat_search';
      const read = args.capability === 'chat_read_url';
      const result = await send(url, {
        model: config.model, stream: false, reasoning: { effort: 'none' }, max_output_tokens: 512,
        input: fileId ? [{ role: 'user', content: [{ type: 'input_file', file_id: fileId },
          { type: 'input_text', text: 'Reply with the verification code in this file, digits only.' }] }]
          : search ? 'Use web search to look up the IANA example domains help page and give its title with a citation.'
          : read ? `Use the URL reading tool to open ${testPage} and report the page title.` : 'Reply with the word OK.',
        ...(search || read ? { tools: [{ type: search ? 'deepseek_web_search' : 'deepseek_read_url' }] } : {}),
        ...(args.capability === 'chat_safety' ? { safety_check: { level: 'high' } } : {}),
      });
      const output = Array.isArray(result.output) ? result.output.map(record) : [];
      const answer = output.filter(item => item.type === 'message').flatMap(item => Array.isArray(item.content) ? item.content.map(record) : [])
        .filter(part => part.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('');
      assertResult(result.status === 'completed' && Boolean(answer.trim()));
      if (fileId) assertResult(answer.includes(sampleCode));
      if (search || read) assertResult(output.some(item => item.type === 'web_search_call' && item.status === 'completed'
        && (search ? item.kind === 'search' && Array.isArray(record(item.action).sources) && (record(item.action).sources as unknown[]).length > 0
          : item.kind === 'read_link' && typeof item.signature === 'string' && item.signature.length > 0)));
      break;
    }
    default: throw AppError.validation('Unknown DeepSeek capability');
  }
  return Math.round(performance.now() - start);
}

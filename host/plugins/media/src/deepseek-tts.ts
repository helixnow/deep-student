import { AppError, CommandError, isAppErrorValue } from '../../../platform/errors/api.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import type { LLMManager } from '../../llm/api.ts';

export async function synthesizeDeepseek(llm: Pick<LLMManager, 'getApiConfigs' | 'decryptApiKey'> | null,
  fetcher: typeof fetch, text: string, voiceId?: string | null): Promise<string> {
  try { return await requestSynthesis(llm, fetcher, text, voiceId); }
  catch (error) { throw new CommandError(isAppErrorValue(error) ? error : AppError.network('DeepSeek speech synthesis request failed')); }
}

async function requestSynthesis(llm: Pick<LLMManager, 'getApiConfigs' | 'decryptApiKey'> | null,
  fetcher: typeof fetch, text: string, voiceId?: string | null): Promise<string> {
  if (!text.trim() || (voiceId != null && voiceId !== 'stella' && voiceId !== 'tide')) {
    throw AppError.validation('DeepSeek TTS requires text and a supported voice');
  }
  const config = (await llm?.getApiConfigs())?.find(c => c.id === 'builtin-deepseek-flash');
  let official = false;
  try { official = new URL(config?.baseUrl ?? '').origin === 'https://api.deepseek.com'; }
  catch { /* boundary-allow empty-catch: Missing or invalid provider URL handled below. */ }
  if (!llm || !config || !official) throw AppError.configuration('Configure the official DeepSeek provider in Model Services');
  const key = await llm.decryptApiKey(config.apiKey);
  if (!key || /^\*+$/.test(key)) throw AppError.configuration('The DeepSeek provider has no API key');
  const response = await fetcher('https://api.deepseek.com/v1/tools/tts', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voiceId ?? 'stella', format: 'wav' }), signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw AppError.llm(`DeepSeek TTS: HTTP ${response.status}`);
  if (response.headers.get('content-type')?.split(';')[0] !== 'audio/wav') throw AppError.llm('DeepSeek TTS returned an invalid audio response');
  return toBase64(new Uint8Array(await response.arrayBuffer()));
}

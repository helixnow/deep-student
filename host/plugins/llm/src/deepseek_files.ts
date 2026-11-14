import type { ApiConfig } from '../api.ts';
import { effectiveApiProtocolForConfig } from './protocol.ts';
import { AppError } from '../../../platform/errors/api.ts';

export function isOfficialDeepseekFlashResponses(config: ApiConfig): boolean {
  if (config.model !== 'deepseek-flash' || effectiveApiProtocolForConfig(config) !== 'openai_responses') return false;
  try { return new URL(config.baseUrl).origin === 'https://api.deepseek.com'; }
  catch { return false; }
}

export function deepseekDocumentPurpose(name: string): 'rich_layout_recognition' | 'user_data' | null {
  if (/\.(pdf|docx?|pptx?|png|jpe?g|webp|gif|bmp|tiff?)$/i.test(name)) return 'rich_layout_recognition';
  if (/\.(txt|md|csv|tsv|json|xlsx?|epub|mobi|html?|xml|ya?ml|js|jsx|ts|tsx|py|java|go|rs|c|cpp|h|sql|sh|log)$/i.test(name)) return 'user_data';
  return null;
}

export async function uploadDeepseekDocument(fetcher: typeof fetch, key: string, name: string, bytes: Uint8Array,
  purpose: NonNullable<ReturnType<typeof deepseekDocumentPurpose>>, signal: AbortSignal | null,
  expiresAfterSeconds?: number): Promise<string> {
  const form = new FormData();
  form.append('purpose', purpose);
  if (expiresAfterSeconds !== undefined) {
    form.append('expires_after[anchor]', 'created_at');
    form.append('expires_after[seconds]', String(expiresAfterSeconds));
  }
  form.append('file', new Blob([new Uint8Array(bytes)]), name);
  const deadline = AbortSignal.timeout(245_000);
  const response = await fetcher('https://api.deepseek.com/files', {
    method: 'POST', body: form, headers: { Authorization: `Bearer ${key}` },
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!response.ok) throw AppError.llm(`DeepSeek Files: HTTP ${response.status}`);
  const result = await response.json() as { id?: unknown } | null;
  if (typeof result?.id !== 'string' || !result.id.startsWith('file-api-')) throw AppError.llm('DeepSeek Files did not return a file ID');
  return result.id;
}

import type { ApiConfig } from '../api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { fromBase64 } from '../../../platform/crypto/encoding.ts';

export function isOfficialDeepseekOcr(config: ApiConfig): boolean {
  if (config.model !== 'deepseek-ocr') return false;
  try { return new URL(config.baseUrl).origin === 'https://api.deepseek.com'; }
  catch { return false; }
}

export async function recognizeDeepseekPage(fetcher: typeof fetch, apiKey: string, dataUrl: string,
  purpose: 'text_recognition' | 'rich_layout_recognition', signal?: AbortSignal): Promise<string> {
  const match = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) throw AppError.validation('DeepSeek OCR requires an image');
  const mime = match[1]!, base64 = match[2]!;
  const form = new FormData();
  form.append('purpose', purpose);
  form.append('file', new Blob([new Uint8Array(fromBase64(base64))], { type: mime }), `page.${mime.split('/')[1]}`);
  const deadline = AbortSignal.timeout(185_000);
  const response = await fetcher('https://api.deepseek.com/v1/tools/ocr', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  const result = await response.json().catch(() => null) as {
    error?: { message?: string }; pages?: { index?: number; text?: string; finish_reason?: string }[];
  } | null;
  if (!response.ok) throw { ...AppError.llm(`DeepSeek OCR: HTTP ${response.status}${result?.error?.message ? `: ${result.error.message}` : ''}`),
    details: { status: response.status } };
  if (result?.error) throw AppError.llm(`DeepSeek OCR: ${result.error.message ?? 'recognition failed'}`);
  const page = result?.pages?.[0];
  if (result?.pages?.length !== 1 || page?.index !== 0 || page.finish_reason !== 'stop' || !page.text?.trim()) {
    throw AppError.llm('DeepSeek OCR did not return a complete page');
  }
  // Reuse the existing grounding parser after translating the official marker spelling.
  const text = page.text.replaceAll('<｜ref｜>', '<|ref|>').replaceAll('<｜/ref｜>', '<|/ref|>')
    .replaceAll('<｜box｜>', '<|det|>').replaceAll('<｜/box｜>', '<|/det|>');
  return purpose === 'text_recognition' ? text.replace(/<\|ref\|>([\s\S]*?)<\|\/ref\|><\|det\|>[\s\S]*?<\|\/det\|>/g, '$1') : text;
}

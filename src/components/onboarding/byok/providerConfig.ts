import type { ApiProtocol } from '@/types';
import { getAllowedProtocolsForProviderType, resolveOfficialNativeProtocol, resolvePreferredProtocol } from '@/utils/providerProtocolRegistry';

export const normalizeBaseUrl = (url: string): string => url.trim().replace(/\/+$/u, '');

export function defaultApiProtocolForProvider(providerType: string, options: { baseUrl: string }): ApiProtocol {
  const preferred = resolvePreferredProtocol({ providerType, baseUrl: options.baseUrl });
  const allowed = getAllowedProtocolsForProviderType(providerType);
  return allowed.includes(preferred) || preferred === resolveOfficialNativeProtocol(options.baseUrl)
    ? preferred
    : allowed[0] ?? 'openai_chat_completions';
}

export function buildModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  url.pathname = `${url.pathname.replace(/\/+$/u, '').replace(/\/(?:chat\/completions|responses|models|embeddings)$/iu, '')}/models`;
  url.hash = '';
  return url.toString();
}

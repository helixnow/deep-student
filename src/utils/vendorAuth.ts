import type { VendorConfig } from '@/types';

export const OPENAI_CODEX_PROVIDER_TYPE = 'openai_codex';
export const OPENAI_CODEX_AUTH_MODE = 'openai_codex_oauth';

type VendorAuthFields = Pick<VendorConfig, 'apiKey' | 'authMode' | 'baseUrl' | 'noApiKey' | 'providerType'>;

const normalize = (value?: string | null): string => value?.trim().toLowerCase() ?? '';

export const hasUsableVendorApiKey = (apiKey?: string | null): boolean => {
  const value = apiKey?.trim() ?? '';
  if (!value || value === '***') return false;
  return !value.split('').every(character => character === '*');
};

export const isOpenAICodexOAuthVendor = (
  vendor?: Pick<VendorConfig, 'authMode' | 'providerType'> | null,
): boolean => {
  if (!vendor) return false;
  return (
    normalize(vendor.providerType) === OPENAI_CODEX_PROVIDER_TYPE ||
    normalize(vendor.authMode) === OPENAI_CODEX_AUTH_MODE
  );
};

/** Whether model configs can be exposed to runtime model selection. */
export const vendorHasUsableCredentials = (
  vendor: VendorAuthFields,
  openAICodexAuthenticated = false,
): boolean => {
  const authMode = normalize(vendor.authMode);
  if (authMode === OPENAI_CODEX_AUTH_MODE) return openAICodexAuthenticated;
  if (authMode === 'none') return true;
  if (vendor.noApiKey) return true;
  return hasUsableVendorApiKey(vendor.apiKey);
};

/** Synchronous settings-list status. Masked API keys still mean a credential is stored. */
export const isVendorConfiguredForSidebar = (
  vendor: VendorAuthFields,
  openAICodexAuthenticated = false,
): boolean => {
  const authMode = normalize(vendor.authMode);
  if (authMode === OPENAI_CODEX_AUTH_MODE) return openAICodexAuthenticated;
  if (authMode === 'none' || vendor.noApiKey) return Boolean(vendor.baseUrl?.trim());
  return Boolean(vendor.apiKey?.trim());
};

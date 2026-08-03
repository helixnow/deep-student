import { describe, expect, it } from 'vitest';

import type { ModelProfile, VendorConfig } from '@/types';
import { buildResolvedConfigs, codexStatusHasUsableSession } from '../useVendorModels';
import { isVendorConfiguredForSidebar } from '@/utils/vendorAuth';
import { supportsModelFetching } from '@/features/settings/components/VendorModelFetcher';

const codexVendor: VendorConfig = {
  id: 'builtin-openai-codex',
  name: 'OpenAI Codex',
  providerType: 'openai_codex',
  authMode: 'openai_codex_oauth',
  baseUrl: '',
  apiKey: '',
  isBuiltin: true,
  isReadOnly: true,
};

const codexProfile: ModelProfile = {
  id: 'codex-gpt',
  vendorId: codexVendor.id,
  label: 'GPT Codex',
  model: 'gpt-5.4',
  modelAdapter: 'openai',
  status: 'enabled',
  enabled: true,
  isMultimodal: true,
  isReasoning: true,
  isEmbedding: false,
  isReranker: false,
  supportsTools: true,
};

describe('Codex OAuth vendor model resolution', () => {
  it('enables OAuth-backed models only while the account is authenticated', () => {
    const [signedOut] = buildResolvedConfigs([codexVendor], [codexProfile], false);
    const [resolved] = buildResolvedConfigs([codexVendor], [codexProfile], true);

    expect(signedOut.enabled).toBe(false);
    expect(resolved).toMatchObject({
      id: codexProfile.id,
      authMode: 'openai_codex_oauth',
      apiKey: '',
      enabled: true,
    });
    expect(isVendorConfiguredForSidebar(codexVendor, false)).toBe(false);
    expect(isVendorConfiguredForSidebar(codexVendor, true)).toBe(true);
  });

  it('does not route Codex OAuth through the generic API-key model fetcher', () => {
    expect(supportsModelFetching('openai_codex')).toBe(false);
    expect(supportsModelFetching('openai')).toBe(true);
  });

  it('separates an authorizing flow from the usability of its existing session', () => {
    const usableRelogin = codexStatusHasUsableSession({
      phase: 'authorizing',
      hasUsableSession: true,
    });
    const requiredRelogin = codexStatusHasUsableSession({
      phase: 'authorizing',
      hasUsableSession: false,
    });

    expect(usableRelogin).toBe(true);
    expect(requiredRelogin).toBe(false);
    expect(buildResolvedConfigs([codexVendor], [codexProfile], usableRelogin)[0].enabled).toBe(true);
    expect(buildResolvedConfigs([codexVendor], [codexProfile], requiredRelogin)[0].enabled).toBe(false);
    expect(codexStatusHasUsableSession({ phase: 'authenticated' })).toBe(true);
    expect(codexStatusHasUsableSession({ state: 'signed_in' })).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import registryData from '../../../scripts/provider-protocol-registry.json';

type ProviderProtocolRecord = {
  provider_type: string;
  allowed_protocols: string[];
  default_protocol: string;
  official?: boolean;
  supports_openai_responses?: boolean;
};

type ProviderProtocolRegistryDocument = {
  schema_version: string;
  updated_at: string;
  providers: ProviderProtocolRecord[];
};

const registry = registryData as ProviderProtocolRegistryDocument;

describe('providerProtocolRegistry contract', () => {
  it('keeps required top-level fields for frontend and Rust parsers', () => {
    expect(registry.schema_version).toBeTruthy();
    expect(registry.updated_at).toBeTruthy();
    expect(Array.isArray(registry.providers)).toBe(true);
    expect(registry.providers.length).toBeGreaterThan(0);
  });

  it('keeps every provider record internally consistent', () => {
    for (const provider of registry.providers) {
      expect(provider.provider_type).toBeTruthy();
      expect(Array.isArray(provider.allowed_protocols)).toBe(true);
      expect(provider.allowed_protocols.length).toBeGreaterThan(0);
      expect(provider.default_protocol).toBeTruthy();
      expect(provider.allowed_protocols).toContain(provider.default_protocol);
    }
  });

  it('preserves key provider routing expectations shared with Rust', () => {
    const openai = registry.providers.find((provider) => provider.provider_type === 'openai');
    const anthropic = registry.providers.find((provider) => provider.provider_type === 'anthropic');
    const gemini = registry.providers.find((provider) => provider.provider_type === 'gemini');
    const custom = registry.providers.find((provider) => provider.provider_type === 'custom');

    expect(openai).toMatchObject({
      provider_type: 'openai',
      default_protocol: 'openai_responses',
      supports_openai_responses: true,
    });
    expect(openai?.allowed_protocols).toContain('openai_responses');

    expect(anthropic).toMatchObject({
      provider_type: 'anthropic',
      default_protocol: 'anthropic_messages',
    });
    expect(anthropic?.allowed_protocols).toEqual(['anthropic_messages']);

    expect(gemini).toMatchObject({
      provider_type: 'gemini',
      default_protocol: 'google_generate_content',
    });
    expect(gemini?.allowed_protocols).toEqual(['google_generate_content']);

    expect(custom).toMatchObject({
      provider_type: 'custom',
      default_protocol: 'openai_chat_completions',
      supports_openai_responses: false,
    });
  });
});

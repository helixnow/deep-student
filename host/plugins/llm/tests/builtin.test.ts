import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MODELS, BUILTIN_VENDORS, OPENCODE_GO_BUILTIN_MODELS, OPENCODE_GO_VENDOR_ID,
} from '../src/data/builtin_catalog.ts';
import { loadBuiltinModels, loadBuiltinVendors, loadAllBuiltins } from '../src/config_store.ts';
import type { ModelProfile, VendorConfig } from '../api.ts';
import { GEMINI_MODEL_REGISTRY_DOCUMENT } from '../src/data/gemini_model_registry.ts';

const allVendors = (): VendorConfig[] => loadBuiltinVendors([]);
const allProfiles = (): ModelProfile[] => loadBuiltinModels([]);

function vendorById(id: string): VendorConfig {
  const vendor = allVendors().find((item) => item.id === id);
  expect(vendor, `builtin vendor ${id}`).toBeDefined();
  return vendor!;
}

function profileById(id: string): ModelProfile {
  const profile = allProfiles().find((item) => item.id === id);
  expect(profile, `builtin model ${id}`).toBeDefined();
  return profile!;
}

describe('builtin_vendors.rs', () => {
  it('opencode_go_builtins_declare_protocol_per_model', () => {
    const vendor = vendorById(OPENCODE_GO_VENDOR_ID);
    expect(vendor.providerType).toBe('opencode_go');
    expect(vendor.supportsOpenaiResponses).toBe(true);

    const profiles = allProfiles().filter((profile) => profile.vendorId === OPENCODE_GO_VENDOR_ID);
    expect(profiles.length).toBe(OPENCODE_GO_BUILTIN_MODELS.length);
    for (const profile of profiles) {
      expect(profile.apiProtocol).not.toBeNull();
      const protocol = profile.apiProtocol!;
      const expectedAdapter =
        protocol === 'anthropic_messages' ? 'anthropic'
          : protocol === 'google_generate_content' ? 'google'
            : 'general';
      expect(profile.modelAdapter).toBe(expectedAdapter);
      expect(profile.providerScope).toBe('opencode_go');
    }
    const gemini = profiles.find((profile) => profile.model === 'gemini-4-argon');
    expect(gemini?.geminiApiVersion).toBe('v1beta');
  });

  it('codex_subscription_catalog_is_separate_and_oauth_only', () => {
    const vendor = vendorById('builtin-openai-codex');
    expect(vendor.name).toBe('Codex');
    expect(vendor.providerType).toBe('openai_codex');
    expect(vendor.authMode).toBe('openai_codex_oauth');
    expect(vendor.apiKey).toBe('');
    expect(vendor.apiProtocol).toBe('openai_responses');
    expect(vendor.supportsOpenaiResponses).toBe(true);

    const expectedModels = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];
    const models = BUILTIN_MODELS.filter((model) => model.vendorId === 'builtin-openai-codex');
    expect(models.length).toBe(expectedModels.length);
    for (const modelId of expectedModels) {
      const model = models.find((item) => item.model === modelId);
      expect(model, `missing Codex subscription model ${modelId}`).toBeDefined();
      expect(model!.isMultimodal).toBe(true);
      expect(model!.isReasoning).toBe(true);
      expect(model!.supportsTools).toBe(true);
    }
  });

  it('official_deepseek_vendor_has_empty_notes_and_advertises_v4', () => {
    const vendor = BUILTIN_VENDORS.find((item) => item.id === 'builtin-deepseek');
    expect(vendor?.notes).toBe('');
    expect(vendor?.maxTokensLimit).toBe(393_216);
  });

  it('official_deepseek_builtin_profiles_include_multimodal_flash', () => {
    const flash = profileById('builtin-deepseek-flash');
    const v4Flash = profileById('builtin-deepseek-v4-flash');
    const v4Pro = profileById('builtin-deepseek-v4-pro');

    expect(flash.model).toBe('deepseek-flash');
    expect(flash.isMultimodal).toBe(true);
    expect(flash.isReasoning).toBe(true);
    expect(flash.supportsTools).toBe(true);
    expect(flash.contextWindow).toBe(1_000_000);
    expect(v4Flash.model).toBe('deepseek-v4-flash');
    expect(v4Pro.model).toBe('deepseek-v4-pro');
    expect(v4Flash.providerScope).toBe('deepseek');
    expect(v4Flash.modelAdapter).toBe('deepseek');
    expect(v4Flash.maxTokensLimit).toBe(393_216);
    expect(v4Flash.contextWindow).toBe(1_000_000);
    expect(v4Pro.contextWindow).toBe(1_000_000);
    expect(v4Flash.maxOutputTokens).toBe(65_536);
    expect(v4Flash.reasoningEffort).toBe('high');

    expect(BUILTIN_MODELS.some((model) => model.model === 'deepseek-chat' || model.model === 'deepseek-reasoner')).toBe(false);
  });

  it('retired_models_are_absent_from_builtin_catalog', () => {
    const retired = [
      'kimi-k2', 'kimi-k2-thinking', 'kimi-latest', 'mimo-v2-pro', 'mimo-v2-omni',
      'mimo-v2-flash', 'deepseek-chat', 'deepseek-reasoner', '01-ai/yi-large',
      'doubao-seed-1-8-251215',
    ];
    for (const model of retired) {
      expect(BUILTIN_MODELS.some((item) => item.model === model), `retired model ${model}`).toBe(false);
    }
  });

  it('builtin_catalog_includes_2026_flagships', () => {
    const k26 = profileById('builtin-kimi-k2.6');
    expect(k26.model).toBe('kimi-k2.6');
    expect(k26.isMultimodal).toBe(true);
    expect(k26.isReasoning).toBe(true);
    expect(k26.contextWindow).toBe(262_144);
    expect(k26.temperature).toBeCloseTo(1.0, 5);

    const k27Code = profileById('builtin-kimi-k2.7-code');
    expect(k27Code.model).toBe('kimi-k2.7-code');
    expect(k27Code.isReasoning).toBe(true);
    expect(k27Code.contextWindow).toBe(262_144);

    const glm52 = profileById('builtin-glm-5.2');
    expect(glm52.model).toBe('glm-5.2');
    expect(glm52.isReasoning).toBe(true);
    expect(glm52.contextWindow).toBe(1_000_000);

    const glm51 = profileById('builtin-glm-5.1');
    expect(glm51.model).toBe('glm-5.1');
    expect(glm51.contextWindow).toBe(200_000);

    const m3 = profileById('builtin-minimax-m3');
    expect(m3.model).toBe('MiniMax-M3');
    expect(m3.isMultimodal).toBe(true);
    expect(m3.contextWindow).toBe(1_000_000);

    const qwen37Max = profileById('builtin-qwen3.7-max');
    expect(qwen37Max.model).toBe('qwen3.7-max');
    expect(qwen37Max.isReasoning).toBe(true);
    expect(qwen37Max.contextWindow).toBe(1_000_000);

    expect(profileById('builtin-qwen3.7-plus').isMultimodal).toBe(true);
    expect(profileById('builtin-qwen3.6-flash').isMultimodal).toBe(true);

    const seed21Pro = profileById('builtin-doubao-seed-2.1-pro');
    expect(seed21Pro.model).toBe('doubao-seed-2-1-pro-260628');
    expect(seed21Pro.isReasoning).toBe(true);
    expect(seed21Pro.contextWindow).toBe(262_144);

    expect(profileById('builtin-doubao-seed-2.1-turbo').model).toBe('doubao-seed-2-1-turbo-260628');
    expect(profileById('builtin-doubao-seed-evolving').model).toBe('doubao-seed-evolving');
    expect(profileById('builtin-doubao-1.8-pro').model).toBe('doubao-seed-1-8-251228');
  });

  it('nvidia_builtin_vendor_uses_integrate_api_openai_compatible_endpoint', () => {
    const vendor = BUILTIN_VENDORS.find((item) => item.id === 'builtin-nvidia');
    expect(vendor?.name).toBe('NVIDIA');
    expect(vendor?.providerType).toBe('nvidia');
    expect(vendor?.baseUrl).toBe('https://integrate.api.nvidia.com/v1');
    expect(vendor?.notes).toContain('OpenAI-compatible');
    expect(vendor?.websiteUrl).toContain('build.nvidia.com');
  });

  it('nvidia_builtin_profiles_use_generic_adapter_without_thinking_defaults', () => {
    const nemotron = profileById('builtin-nvidia-nemotron-3-nano');
    const llama = profileById('builtin-nvidia-llama-3.1-405b');

    expect(nemotron.vendorId).toBe('builtin-nvidia');
    expect(nemotron.providerScope).toBe('nvidia');
    expect(nemotron.modelAdapter).toBe('general');
    expect(nemotron.model).toBe('nvidia/nemotron-3-nano-30b-a3b');
    expect(nemotron.isReasoning).toBe(true);
    expect(nemotron.thinkingEnabled).toBe(false);
    expect(nemotron.includeThoughts).toBe(false);
    expect(nemotron.reasoningEffort).toBeNull();
    expect(nemotron.contextWindow).toBe(1_000_000);

    expect(llama.model).toBe('meta/llama-3.1-405b-instruct');
    expect(llama.modelAdapter).toBe('general');
    expect(llama.reasoningEffort).toBeNull();
  });

  it('mimo_builtin_vendor_uses_openai_compatible_endpoint', () => {
    const vendor = BUILTIN_VENDORS.find((item) => item.id === 'builtin-mimo');
    expect(vendor?.name).toBe('Xiaomi MiMo');
    expect(vendor?.providerType).toBe('mimo');
    expect(vendor?.baseUrl).toBe('https://api.xiaomimimo.com/v1');
    expect(vendor?.notes).toContain('OpenAI-compatible');
    expect(vendor?.notes).toContain('Token Plan');
    expect(vendor?.websiteUrl).toContain('xiaomimimo.com');
  });

  it('mimo_builtin_vendor_notes_call_out_v25_scope', () => {
    const vendor = BUILTIN_VENDORS.find((item) => item.id === 'builtin-mimo');
    expect(vendor?.notes).toContain('V2.5-Pro');
    expect(vendor?.notes).toContain('V2.5');
    expect(vendor?.notes).toContain('TTS');
    expect(vendor?.notes).toContain('ASR');
  });

  it('mimo_builtin_profiles_use_mimo_adapter_and_thinking_defaults', () => {
    const pro = profileById('builtin-mimo-v2.5-pro');
    const multimodal = profileById('builtin-mimo-v2.5');

    expect(pro.vendorId).toBe('builtin-mimo');
    expect(pro.providerScope).toBe('mimo');
    expect(pro.modelAdapter).toBe('mimo');
    expect(pro.model).toBe('mimo-v2.5-pro');
    expect(pro.isReasoning).toBe(true);
    expect(pro.thinkingEnabled).toBe(true);
    expect(pro.includeThoughts).toBe(true);
    expect(pro.maxOutputTokens).toBe(131_072);
    expect(pro.contextWindow).toBe(1_000_000);

    expect(multimodal.model).toBe('mimo-v2.5');
    expect(multimodal.isMultimodal).toBe(true);
    expect(multimodal.maxOutputTokens).toBe(131_072);
    expect(multimodal.contextWindow).toBe(1_000_000);
  });

  it('anthropic_builtin_vendor_uses_official_messages_endpoint', () => {
    const vendor = BUILTIN_VENDORS.find((item) => item.id === 'builtin-anthropic');
    expect(vendor?.name).toBe('Anthropic');
    expect(vendor?.providerType).toBe('anthropic');
    expect(vendor?.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(vendor?.notes).toContain('adaptive');
    expect(vendor?.websiteUrl).toContain('platform.claude.com');

    const config = vendorById('builtin-anthropic');
    expect(config.apiProtocol).toBe('anthropic_messages');
    expect(config.apiKey).toBe('');
  });

  it('anthropic_builtin_profiles_cover_official_2026_catalog', () => {
    const opus = profileById('builtin-claude-opus-5');
    expect(opus.model).toBe('claude-opus-5');
    expect(opus.vendorId).toBe('builtin-anthropic');
    expect(opus.providerScope).toBe('anthropic');
    expect(opus.modelAdapter).toBe('anthropic');
    expect(opus.isMultimodal).toBe(true);
    expect(opus.isReasoning).toBe(true);
    expect(opus.supportsTools).toBe(true);
    expect(opus.thinkingEnabled).toBe(true);
    expect(opus.includeThoughts).toBe(true);
    expect(opus.maxOutputTokens).toBe(128_000);
    expect(opus.contextWindow).toBe(1_000_000);

    const sonnet = profileById('builtin-claude-sonnet-5');
    expect(sonnet.model).toBe('claude-sonnet-5');
    expect(sonnet.modelAdapter).toBe('anthropic');
    expect(sonnet.maxOutputTokens).toBe(128_000);
    expect(sonnet.contextWindow).toBe(1_000_000);

    const fable = profileById('builtin-claude-fable-5');
    expect(fable.model).toBe('claude-fable-5');
    expect(fable.isReasoning).toBe(true);
    expect(fable.contextWindow).toBe(1_000_000);

    const haiku = profileById('builtin-claude-haiku-4-5');
    expect(haiku.model).toBe('claude-haiku-4-5');
    expect(haiku.isMultimodal).toBe(true);
    expect(haiku.isReasoning).toBe(true);
    expect(haiku.maxOutputTokens).toBe(64_000);
    expect(haiku.contextWindow).toBe(200_000);
  });

  it('builtin_catalog_has_no_fabricated_claude_haiku_5', () => {
    expect(BUILTIN_MODELS.some((m) => m.model.includes('claude-haiku-5') || m.id.includes('claude-haiku-5'))).toBe(false);
    expect(BUILTIN_MODELS.some((m) => m.model.includes('mythos'))).toBe(false);
    expect(BUILTIN_MODELS.some((m) => m.model === 'claude-haiku-4-5')).toBe(true);
  });

  it('openai_builtin_profiles_include_reasoning_effort_and_verbosity_defaults', () => {
    const flagship = profileById('builtin-gpt-5.5');
    const pro = profileById('builtin-gpt-5.5-pro');
    const nano = profileById('builtin-gpt-5.4-nano');

    expect(flagship.modelAdapter).toBe('general');
    expect(flagship.reasoningEffort).toBe('medium');
    expect(flagship.verbosity).toBe('medium');
    expect(flagship.thinkingEnabled).toBe(true);
    expect(flagship.includeThoughts).toBe(true);

    expect(pro.reasoningEffort).toBe('high');
    expect(pro.verbosity).toBe('medium');

    expect(nano.reasoningEffort).toBe('low');
    expect(nano.verbosity).toBe('low');
  });

  it('gemini_builtin_vendor_notes_track_current_google_models', () => {
    const vendor = (GEMINI_MODEL_REGISTRY_DOCUMENT as unknown as { vendor: { notes: string } }).vendor;
    expect(vendor.notes).toContain('gemini-3.5-flash');
    expect(vendor.notes).toContain('gemini-3.5-flash-lite');
    expect(vendor.notes).toContain('gemini-3.1-pro-preview');
    expect(vendor.notes).toContain('gemini-3.1-flash-lite');
    expect(vendor.notes).toContain('v1beta');
  });

  it('gemini_3x_models_do_not_pin_default_temperature', () => {
    const doc = GEMINI_MODEL_REGISTRY_DOCUMENT as unknown as {
      models: { model: string; temperature?: number | null }[];
    };
    for (const model of doc.models) {
      if (model.model.startsWith('gemini-3')) {
        expect(model.temperature ?? null, `${model.model} should not carry a default temperature`).toBeNull();
      } else {
        expect(model.temperature, `${model.model} (2.5 series) should keep its default temperature`).not.toBeNull();
      }
    }
  });

  it('gemini_builtin_catalog_is_loaded_from_registry', () => {
    const { vendors, profiles } = loadAllBuiltins([], []);
    expect(vendors.some((vendor) => vendor.id === 'builtin-gemini')).toBe(true);
    expect(profiles.some((profile) => profile.id === 'builtin-gemini-3-flash')).toBe(true);
    expect(profiles.some((profile) => profile.model === 'gemini-3.5-flash')).toBe(true);
  });

  it('gemini_builtin_profiles_promote_current_3x_models', () => {
    const doc = GEMINI_MODEL_REGISTRY_DOCUMENT as unknown as { vendor: unknown; models: unknown[] };
    void doc;
    const flash = profileById('builtin-gemini-3-flash');
    const pro = profileById('builtin-gemini-3-pro');
    const flashLite = profileById('builtin-gemini-3.5-flash-lite');
    const flashLite31 = profileById('builtin-gemini-3.1-flash-lite');

    expect(flash.model).toBe('gemini-3.5-flash');
    expect(pro.model).toBe('gemini-3.1-pro-preview');
    expect(flashLite.model).toBe('gemini-3.5-flash-lite');
    expect(flashLite.reasoningEffort).toBe('minimal');
    expect(flashLite31.model).toBe('gemini-3.1-flash-lite');
    expect(flashLite31.reasoningEffort).toBe('minimal');

    for (const profile of [flash, pro, flashLite, flashLite31]) {
      expect(profile.providerScope).toBe('gemini');
      expect(profile.modelAdapter).toBe('google');
      expect(profile.isReasoning).toBe(true);
      expect(profile.supportsTools).toBe(true);
      expect(profile.includeThoughts).toBe(true);
      expect(profile.thinkingEnabled).toBe(true);
    }
  });
});

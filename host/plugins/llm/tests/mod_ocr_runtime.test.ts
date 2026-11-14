import { describe, expect, it } from 'vitest';
import {
  buildOcrRuntimeCandidates, inspectFreeTextOcrAvailableFromSettings, SYSTEM_OCR_CONFIG_ID,
  encodeOcrModels, type ApiConfigLike, type OcrModelConfig,
} from '../src/ocr_runtime.ts';

function systemModel(enabled: boolean): OcrModelConfig {
  return {
    config_id: SYSTEM_OCR_CONFIG_ID,
    model: 'system',
    engine_type: 'system_ocr',
    name: 'System OCR',
    is_free: true,
    enabled,
    priority: 0,
  };
}

function genericVlm(): [OcrModelConfig, ApiConfigLike] {
  return [
    {
      config_id: 'vlm',
      model: 'vision-model',
      engine_type: 'generic_vlm',
      name: 'Vision',
      is_free: false,
      enabled: true,
      priority: 1,
    },
    { id: 'vlm', model: 'vision-model', enabled: true, isMultimodal: true },
  ];
}

describe('llm_manager/mod.rs', () => {
  it('system_ocr_is_native_free_text_candidate_but_never_structured', () => {
    const models = [systemModel(true)];
    const free = buildOcrRuntimeCandidates(models, [], 'FreeText', true);
    expect(free).toEqual([{ kind: 'systemOcr' }]);

    const structured = buildOcrRuntimeCandidates(models, [], 'Structured', true);
    expect(structured).toEqual([]);
  });

  it('system_ocr_candidate_respects_enabled_state_alongside_remote_engine', () => {
    const [remoteModel, remoteConfig] = genericVlm();
    const cases: Array<[boolean, boolean, boolean]> = [
      [false, true, false],
      [true, true, true],
      [true, false, false],
    ];
    for (const [enabled, supported, expectedNative] of cases) {
      const candidates = buildOcrRuntimeCandidates(
        [remoteModel, systemModel(enabled)], [remoteConfig], 'FreeText', supported,
      );
      const hasNative = candidates.some((candidate) => candidate.kind === 'systemOcr');
      expect(hasNative).toBe(expectedNative);
      const hasRemote = candidates.some((candidate) => candidate.kind === 'remote'
        && candidate.config.id === remoteConfig.id);
      expect(hasRemote).toBe(true);
    }
  });

  it('readonly_ocr_inspection_uses_native_default_until_explicit_engine_list_exists', () => {
    expect(inspectFreeTextOcrAvailableFromSettings(null, null, [], true)).toBe(true);
    expect(inspectFreeTextOcrAvailableFromSettings(null, null, [], false)).toBe(false);

    const disabled = encodeOcrModels([systemModel(false)]);
    expect(inspectFreeTextOcrAvailableFromSettings(disabled, null, [], true)).toBe(false);

    const enabled = encodeOcrModels([systemModel(true)]);
    expect(inspectFreeTextOcrAvailableFromSettings(enabled, null, [], true)).toBe(true);
    expect(inspectFreeTextOcrAvailableFromSettings(enabled, null, [], false)).toBe(false);
  });

  it('readonly_ocr_inspection_accepts_enabled_remote_vlm_and_legacy_selection', () => {
    const [model, config] = genericVlm();
    const raw = encodeOcrModels([model]);
    expect(inspectFreeTextOcrAvailableFromSettings(raw, null, [config], false)).toBe(true);
    expect(inspectFreeTextOcrAvailableFromSettings(null, 'generic_vlm', [config], false)).toBe(true);
  });

  it('invalid model JSON falls back to legacy while a valid empty list remains authoritative', () => {
    expect(inspectFreeTextOcrAvailableFromSettings('{', null, [], true)).toBe(true);
    expect(inspectFreeTextOcrAvailableFromSettings('[{}]', null, [], true)).toBe(true);
    expect(inspectFreeTextOcrAvailableFromSettings('[]', null, [], true)).toBe(false);
    const raw = JSON.stringify([{ configId: SYSTEM_OCR_CONFIG_ID, model: 'system', engineType: 'system_ocr', name: 'Native' }]);
    expect(inspectFreeTextOcrAvailableFromSettings(raw, null, [], true)).toBe(true);
  });
});

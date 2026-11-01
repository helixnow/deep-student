import { describe, expect, it } from 'vitest';

import {
  excludeOpenCodeGo,
  findOpenCodeGoDefaultConfig,
  OPENCODE_GO_ASSIGNABLE_FIELDS,
  isOpenCodeGoConfig,
  isOpenCodeGoVendor,
  OPENCODE_GO_VENDOR_ID,
} from '../opencodeGo';

describe('opencodeGo', () => {
  it('detects OpenCode Go by vendor id, provider type or endpoint (mirrors Rust)', () => {
    expect(isOpenCodeGoConfig({ vendorId: OPENCODE_GO_VENDOR_ID })).toBe(true);
    expect(isOpenCodeGoConfig({ providerType: 'OpenCode_Go' })).toBe(true);
    expect(isOpenCodeGoConfig({ vendorId: 'custom', baseUrl: 'https://opencode.ai/inference/go/anthropic/v1/' })).toBe(true);
    expect(isOpenCodeGoConfig({ baseUrl: 'https://opencode.ai/zen/go/v1' })).toBe(true);
    // Zen（按量付费）与其他供应商不是 Go。
    expect(isOpenCodeGoConfig({ baseUrl: 'https://opencode.ai/zen/v1' })).toBe(false);
    expect(isOpenCodeGoConfig({ vendorId: 'builtin-deepseek', providerType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' })).toBe(false);
    expect(isOpenCodeGoConfig({ baseUrl: 'not a url' })).toBe(false);
    expect(isOpenCodeGoConfig(null)).toBe(false);
  });

  it('treats the vendor object id as vendorId', () => {
    expect(isOpenCodeGoVendor({ id: OPENCODE_GO_VENDOR_ID })).toBe(true);
    expect(isOpenCodeGoVendor({ id: 'builtin-deepseek', providerType: 'deepseek' })).toBe(false);
  });

  it('removes Go models from non-agent candidates only', () => {
    const configs = [
      { id: 'a', vendorId: OPENCODE_GO_VENDOR_ID },
      { id: 'b', vendorId: 'builtin-deepseek', providerType: 'deepseek' },
      { id: 'c', providerType: 'opencode_go' },
    ];
    expect(excludeOpenCodeGo(configs).map((config) => config.id)).toEqual(['b']);
  });
});

describe('OpenCode Go one-click assign', () => {
  it('only targets the agent-conversation slots', () => {
    expect([...OPENCODE_GO_ASSIGNABLE_FIELDS]).toEqual([
      'model2_config_id',
      'chat_title_model_config_id',
      'compaction_model_config_id',
    ]);
  });

  it('picks the enabled DeepSeek V4.1 Flash config on the Go vendor only', () => {
    const configs = [
      { id: 'ds-official', model: 'deepseek-v4.1-flash', providerType: 'deepseek', enabled: true },
      { id: 'go-disabled', model: 'deepseek-v4.1-flash', vendorId: 'builtin-opencode-go', enabled: false },
      { id: 'go-pro', model: 'deepseek-v4-pro', vendorId: 'builtin-opencode-go', enabled: true },
      { id: 'go-flash', model: 'deepseek-v4.1-flash', providerType: 'opencode_go', enabled: true },
    ];
    expect(findOpenCodeGoDefaultConfig(configs)?.id).toBe('go-flash');
    expect(findOpenCodeGoDefaultConfig(configs.slice(0, 3))).toBeUndefined();
  });
});

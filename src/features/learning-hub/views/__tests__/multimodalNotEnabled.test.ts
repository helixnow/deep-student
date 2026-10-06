import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { isMultimodalNotEnabledError } from '../IndexStatusView';

describe('isMultimodalNotEnabledError', () => {
  it('recognises the backend "multimodal indexing not enabled" errors, old and new wording', () => {
    expect(isMultimodalNotEnabledError('还没有启用多模态索引：请在「设置 → 模型 …')).toBe(true);
    expect(isMultimodalNotEnabledError('未配置多模态嵌入模型，请在设置中配置 VL Embedding 模型')).toBe(true);
    expect(isMultimodalNotEnabledError('网络错误：timeout')).toBe(false);
  });
});

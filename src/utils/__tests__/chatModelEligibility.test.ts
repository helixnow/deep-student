import { describe, expect, it } from 'vitest';
import { isAvailableChatModel, isChatGenerationModel } from '../chatModelEligibility';

describe('chatModelEligibility (G22)', () => {
  it('rejects empty, whitespace-only, null, and undefined model IDs', () => {
    expect(isChatGenerationModel({ model: '' })).toBe(false);
    expect(isChatGenerationModel({ model: '   \t\n ' })).toBe(false);
    expect(isChatGenerationModel({ model: null })).toBe(false);
    expect(isChatGenerationModel({ model: undefined })).toBe(false);
    expect(isAvailableChatModel({ model: '', enabled: true })).toBe(false);
    expect(isAvailableChatModel({ model: '   ', enabled: true })).toBe(false);
  });

  it('accepts valid chat generation models and excludes non-chat models', () => {
    expect(isChatGenerationModel({ model: 'gpt-4o' })).toBe(true);
    expect(isAvailableChatModel({ model: 'deepseek-chat', enabled: true })).toBe(true);
    expect(isAvailableChatModel({ model: 'deepseek-chat', enabled: false })).toBe(false);
    expect(isChatGenerationModel({ model: 'system' })).toBe(false);
    expect(isChatGenerationModel({ model: 'PaddlePaddle/PaddleOCR-VL' })).toBe(false);
    expect(isChatGenerationModel({ model: 'BAAI/bge-m3', isEmbedding: true })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { classifyModelFamily, groupByModelFamily } from '../modelFamily';

describe('classifyModelFamily', () => {
  describe('OpenAI', () => {
    it.each([
      ['o1-preview', 'openai-o'],
      ['o1-mini', 'openai-o'],
      ['o3-mini', 'openai-o'],
      ['gpt-5', 'gpt-5'],
      ['gpt-5-mini', 'gpt-5'],
      ['gpt-4o', 'gpt-4'],
      ['gpt-4o-mini', 'gpt-4'],
      ['gpt-4-turbo', 'gpt-4'],
      ['gpt-4', 'gpt-4'],
      ['chatgpt-4o-latest', 'gpt-4'],
      ['gpt-3.5-turbo', 'gpt-3.5'],
    ])('classifies %s as %s', (id, expectedFamilyId) => {
      expect(classifyModelFamily(id).id).toBe(expectedFamilyId);
    });
  });

  describe('Anthropic', () => {
    it.each([
      ['claude-opus-4-7', 'claude-opus'],
      ['claude-3-opus-20240229', 'claude-opus'],
      ['claude-sonnet-4-6', 'claude-sonnet'],
      ['claude-3-7-sonnet-20250219', 'claude-sonnet'],
      ['claude-haiku-4-5-20251001', 'claude-haiku'],
      ['claude-3-5-haiku-20241022', 'claude-haiku'],
      ['claude-2.1', 'claude-legacy'],
      ['claude-2.0', 'claude-legacy'],
      ['claude-instant-1.2', 'claude-legacy'],
    ])('classifies %s as %s', (id, expectedFamilyId) => {
      expect(classifyModelFamily(id).id).toBe(expectedFamilyId);
    });
  });

  describe('Google', () => {
    it.each([
      ['gemini-3.1-pro-preview', 'gemini-3'],
      ['gemini-3.1-pro-preview-customtools', 'gemini-3'],
      ['gemini-3.5-flash', 'gemini-3'],
      ['gemini-2.5-pro', 'gemini-2.5'],
      ['gemini-2.5-flash', 'gemini-2.5'],
      ['gemini-2.0-flash', 'gemini-2.0'],
      ['gemini-1.5-pro', 'gemini-1.5'],
      ['gemini-1.5-flash', 'gemini-1.5'],
      ['gemma-2-9b', 'gemma'],
    ])('classifies %s as %s', (id, expectedFamilyId) => {
      expect(classifyModelFamily(id).id).toBe(expectedFamilyId);
    });
  });

  describe('DeepSeek', () => {
    it.each([
      ['deepseek-r1', 'deepseek-r'],
      ['deepseek-reasoner', 'deepseek-r'],
      ['deepseek-r1-distill-llama-70b', 'deepseek-r'],
      ['deepseek-vl2-tiny', 'deepseek-vl'],
      ['deepseek-vl-7b-chat', 'deepseek-vl'],
      ['deepseek-coder', 'deepseek-coder'],
      ['deepseek-coder-v2-instruct', 'deepseek-coder'],
      ['deepseek-v3', 'deepseek-v'],
      ['deepseek-v2.5', 'deepseek-v'],
      ['deepseek-chat', 'deepseek-chat'],
    ])('classifies %s as %s', (id, expectedFamilyId) => {
      expect(classifyModelFamily(id).id).toBe(expectedFamilyId);
    });
  });

  describe('Qwen', () => {
    it.each([
      ['qwen3-72b-instruct', 'qwen-3'],
      ['qwen2.5-7b-instruct', 'qwen-2.5'],
      ['qwen2-72b-instruct', 'qwen-2'],
      ['qwen-vl-plus', 'qwen-vl'],
      ['qwq-32b-preview', 'qwq'],
      ['qvq-72b-preview', 'qvq'],
    ])('classifies %s as %s', (id, expectedFamilyId) => {
      expect(classifyModelFamily(id).id).toBe(expectedFamilyId);
    });
  });

  describe('xAI', () => {
    it.each([
      ['grok-4.5', 'grok'],
      ['grok-4.3', 'grok'],
      ['grok-4-0709', 'grok'],
      ['grok-4-1-fast-reasoning', 'grok'],
      ['grok-4-1-fast-non-reasoning', 'grok'],
      ['grok-3-mini', 'grok'],
    ])('classifies %s as %s', (id, expectedFamilyId) => {
      expect(classifyModelFamily(id).id).toBe(expectedFamilyId);
    });
  });

  describe('Meta Llama', () => {
    it.each([
      ['llama-4-scout', 'llama-4'],
      ['llama-4-maverick', 'llama-4'],
    ])('classifies %s as %s', (id, expectedFamilyId) => {
      expect(classifyModelFamily(id).id).toBe(expectedFamilyId);
    });

    it('keeps DeepSeek distills out of the Llama family', () => {
      expect(classifyModelFamily('deepseek-r1-distill-llama-70b').id).toBe('deepseek-r');
    });
  });

  describe('Mistral', () => {
    it.each([
      ['magistral-medium-latest', 'magistral'],
      ['magistral-small-latest', 'magistral'],
      ['mistral-large-3', 'mistral'],
      ['mistral-medium-3-5', 'mistral'],
      ['mistral-small-4', 'mistral'],
    ])('classifies %s as %s', (id, expectedFamilyId) => {
      expect(classifyModelFamily(id).id).toBe(expectedFamilyId);
    });
  });

  describe('Domestic vendors', () => {
    it.each([
      ['minimax-m3', 'minimax'],
      ['minimax-m2.7', 'minimax'],
      ['MiniMax-M2.5', 'minimax'],
      ['ernie-5.1', 'ernie'],
      ['ernie-5.0', 'ernie'],
      ['ernie-5.0-thinking-latest', 'ernie'],
      ['ernie-x1.1', 'ernie'],
      ['ernie-x1-turbo', 'ernie'],
      ['ernie-4.5', 'ernie'],
    ])('classifies %s as %s', (id, expectedFamilyId) => {
      expect(classifyModelFamily(id).id).toBe(expectedFamilyId);
    });
  });

  describe('Provider prefix handling', () => {
    it('strips slash prefix (e.g. SiliconFlow "Qwen/Qwen2.5-7B")', () => {
      expect(classifyModelFamily('Qwen/Qwen2.5-7B-Instruct').id).toBe('qwen-2.5');
      expect(classifyModelFamily('openai/gpt-4o').id).toBe('gpt-4');
      expect(classifyModelFamily('deepseek-ai/DeepSeek-R1').id).toBe('deepseek-r');
    });
  });

  describe('Capability fallbacks', () => {
    it.each([
      ['text-embedding-3-large', 'embedding'],
      ['bge-m3', 'embedding'],
      ['bge-reranker-v2-m3', 'reranker'],
      ['whisper-1', 'whisper'],
      ['tts-1', 'tts'],
      ['dall-e-3', 'dalle'],
    ])('classifies %s as %s', (id, expectedFamilyId) => {
      expect(classifyModelFamily(id).id).toBe(expectedFamilyId);
    });
  });

  describe('Unknown models', () => {
    it('falls back to "other" family', () => {
      expect(classifyModelFamily('totally-unknown-model').id).toBe('other');
    });
    it('handles empty input', () => {
      expect(classifyModelFamily('').id).toBe('other');
    });
  });
});

describe('groupByModelFamily', () => {
  it('groups models and sorts by family order', () => {
    const models = [
      { id: 'gpt-3.5-turbo' },
      { id: 'gpt-4o' },
      { id: 'o1-mini' },
      { id: 'gpt-4o-mini' },
    ];
    const groups = groupByModelFamily(models, (m) => m.id);
    expect(groups.map((g) => g.family.id)).toEqual(['openai-o', 'gpt-4', 'gpt-3.5']);
    expect(groups[1].items.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('preserves original order within a family', () => {
    const models = [
      { id: 'gpt-4o-mini' },
      { id: 'gpt-4o' },
      { id: 'gpt-4-turbo' },
    ];
    const groups = groupByModelFamily(models, (m) => m.id);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((m) => m.id)).toEqual(['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo']);
  });

  it('puts Embeddings/Reranker after main families', () => {
    const models = [
      { id: 'bge-reranker-v2' },
      { id: 'text-embedding-3-large' },
      { id: 'gpt-4o' },
    ];
    const groups = groupByModelFamily(models, (m) => m.id);
    expect(groups.map((g) => g.family.id)).toEqual(['gpt-4', 'embedding', 'reranker']);
  });

  it('puts "other" family last', () => {
    const models = [
      { id: 'some-unknown-model' },
      { id: 'gpt-4o' },
    ];
    const groups = groupByModelFamily(models, (m) => m.id);
    expect(groups.map((g) => g.family.id)).toEqual(['gpt-4', 'other']);
  });
});

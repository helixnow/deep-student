/**
 * Chat V2 - parseModelMentions 单元测试
 *
 * 测试 @模型 解析逻辑
 */

import { describe, it, expect } from 'vitest';
import {
  parseModelMentions,
  getCurrentMentionContext,
  filterModelSuggestions,
  formatMention,
  shouldShowAutoComplete,
  type ModelInfo,
} from '@/chat-v2/utils/parseModelMentions';

// ============================================================================
// 测试数据
// ============================================================================

const mockModels: ModelInfo[] = [
  {
    id: 'gpt-4',
    name: 'GPT-4',
    aliases: ['gpt4', 'gpt'],
    provider: 'OpenAI',
  },
  {
    id: 'gpt-4-turbo',
    name: 'GPT-4 Turbo',
    aliases: ['gpt4turbo'],
    provider: 'OpenAI',
  },
  {
    id: 'claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet',
    aliases: ['claude', 'sonnet'],
    provider: 'Anthropic',
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    aliases: ['deepseek', 'ds'],
    provider: 'DeepSeek',
  },
  {
    id: 'gemini-pro',
    name: 'Gemini Pro',
    aliases: ['gemini'],
    provider: 'Google',
  },
];

// ============================================================================
// parseModelMentions 测试
// ============================================================================

describe('parseModelMentions', () => {
  describe('基本解析', () => {
    it('应该正确解析单个 @模型', () => {
      const result = parseModelMentions('@gpt-4 你好', mockModels);

      expect(result.cleanContent).toBe('你好');
      expect(result.modelIds).toEqual(['gpt-4']);
      expect(result.rawInput).toBe('@gpt-4 你好');
      expect(result.isMultiVariant).toBe(false);
    });

    it('应该正确解析多个 @模型（触发多变体模式）', () => {
      const result = parseModelMentions('@gpt-4 @claude 请解释量子纠缠', mockModels);

      expect(result.cleanContent).toBe('请解释量子纠缠');
      expect(result.modelIds).toEqual(['gpt-4', 'claude-3-5-sonnet']);
      expect(result.isMultiVariant).toBe(true);
    });

    it('应该支持模型别名', () => {
      const result = parseModelMentions('@gpt @deepseek 你好', mockModels);

      expect(result.modelIds).toEqual(['gpt-4', 'deepseek-chat']);
      expect(result.isMultiVariant).toBe(true);
    });

    it('应该处理无 @模型 的输入', () => {
      const result = parseModelMentions('请解释量子纠缠', mockModels);

      expect(result.cleanContent).toBe('请解释量子纠缠');
      expect(result.modelIds).toEqual([]);
      expect(result.isMultiVariant).toBe(false);
    });

    it('应该处理空输入', () => {
      const result = parseModelMentions('', mockModels);

      expect(result.cleanContent).toBe('');
      expect(result.modelIds).toEqual([]);
      expect(result.isMultiVariant).toBe(false);
    });

    it('应该处理空模型列表', () => {
      const result = parseModelMentions('@gpt-4 你好', []);

      expect(result.cleanContent).toBe('@gpt-4 你好');
      expect(result.modelIds).toEqual([]);
      expect(result.isMultiVariant).toBe(false);
    });
  });

  describe('去重与保序', () => {
    it('应该去重重复的模型', () => {
      const result = parseModelMentions('@gpt-4 @gpt-4 @claude 你好', mockModels);

      expect(result.modelIds).toEqual(['gpt-4', 'claude-3-5-sonnet']);
    });

    it('应该去重通过别名重复的模型', () => {
      const result = parseModelMentions('@gpt-4 @gpt4 @gpt 你好', mockModels);

      expect(result.modelIds).toEqual(['gpt-4']);
    });

    it('应该保持模型出现的顺序', () => {
      const result = parseModelMentions('@deepseek @gpt-4 @claude 你好', mockModels);

      expect(result.modelIds).toEqual(['deepseek-chat', 'gpt-4', 'claude-3-5-sonnet']);
    });
  });

  describe('大小写不敏感', () => {
    it('应该大小写不敏感匹配模型 ID', () => {
      const result = parseModelMentions('@GPT-4 @CLAUDE 你好', mockModels);

      expect(result.modelIds).toEqual(['gpt-4', 'claude-3-5-sonnet']);
    });

    it('应该大小写不敏感匹配模型别名', () => {
      const result = parseModelMentions('@GPT @DeepSeek 你好', mockModels);

      expect(result.modelIds).toEqual(['gpt-4', 'deepseek-chat']);
    });

    it('应该大小写不敏感匹配模型名称', () => {
      const result = parseModelMentions('@"GPT-4" @"Claude 3.5 Sonnet" 你好', mockModels);

      expect(result.modelIds).toEqual(['gpt-4', 'claude-3-5-sonnet']);
    });
  });

  describe('带引号格式', () => {
    it('应该支持双引号格式（带空格的模型名）', () => {
      const result = parseModelMentions('@"Claude 3.5 Sonnet" 你好', mockModels);

      expect(result.modelIds).toEqual(['claude-3-5-sonnet']);
      expect(result.cleanContent).toBe('你好');
    });

    it('应该支持单引号格式', () => {
      const result = parseModelMentions("@'GPT-4 Turbo' 你好", mockModels);

      expect(result.modelIds).toEqual(['gpt-4-turbo']);
    });

    it('应该混合支持有引号和无引号格式', () => {
      const result = parseModelMentions('@gpt-4 @"Claude 3.5 Sonnet" 你好', mockModels);

      expect(result.modelIds).toEqual(['gpt-4', 'claude-3-5-sonnet']);
    });
  });

  describe('无效模型处理', () => {
    it('应该保留无效模型的原文', () => {
      const result = parseModelMentions('@invalid-model 你好', mockModels);

      expect(result.cleanContent).toBe('@invalid-model 你好');
      expect(result.modelIds).toEqual([]);
    });

    it('应该混合处理有效和无效模型', () => {
      const result = parseModelMentions('@gpt-4 @invalid @claude 你好', mockModels);

      expect(result.cleanContent).toBe('@invalid 你好');
      expect(result.modelIds).toEqual(['gpt-4', 'claude-3-5-sonnet']);
    });

    it('应该将连续 @ 解析为独立的 mentions', () => {
      // @model@special 被解析为 @model 和 @special 两个独立 mentions
      const result = parseModelMentions('@gpt-4@claude 你好', mockModels);

      expect(result.modelIds).toEqual(['gpt-4', 'claude-3-5-sonnet']);
      expect(result.cleanContent).toBe('你好');
    });

    it('应该正确处理包含斜杠的模型名（只匹配斜杠前的部分）', () => {
      const result = parseModelMentions('@gpt-4/turbo 你好', mockModels);

      // 只匹配 @gpt-4，/turbo 被保留
      expect(result.modelIds).toEqual(['gpt-4']);
      expect(result.cleanContent).toBe('/turbo 你好');
    });
  });

  describe('清理内容', () => {
    it('应该正确清理多余空格', () => {
      const result = parseModelMentions('@gpt-4   @claude    你好   世界', mockModels);

      expect(result.cleanContent).toBe('你好 世界');
    });

    it('应该处理 @模型 在文本中间的情况', () => {
      const result = parseModelMentions('请 @gpt-4 帮我 @claude 解答问题', mockModels);

      expect(result.cleanContent).toBe('请 帮我 解答问题');
      expect(result.modelIds).toEqual(['gpt-4', 'claude-3-5-sonnet']);
    });

    it('应该处理 @模型 在文本末尾的情况', () => {
      const result = parseModelMentions('请解答问题 @gpt-4 @claude', mockModels);

      expect(result.cleanContent).toBe('请解答问题');
      expect(result.modelIds).toEqual(['gpt-4', 'claude-3-5-sonnet']);
    });

    it('应该处理只有 @模型 没有文本内容的情况', () => {
      const result = parseModelMentions('@gpt-4 @claude', mockModels);

      expect(result.cleanContent).toBe('');
      expect(result.modelIds).toEqual(['gpt-4', 'claude-3-5-sonnet']);
      expect(result.isMultiVariant).toBe(true);
    });

    it('应该处理单个 @模型 没有文本内容的情况', () => {
      const result = parseModelMentions('@gpt-4', mockModels);

      expect(result.cleanContent).toBe('');
      expect(result.modelIds).toEqual(['gpt-4']);
      expect(result.isMultiVariant).toBe(false);
    });
  });
});

// ============================================================================
// getCurrentMentionContext 测试
// ============================================================================

describe('getCurrentMentionContext', () => {
  it('应该在 @ 之后返回上下文', () => {
    const result = getCurrentMentionContext('@gpt', 4);

    expect(result).toEqual({
      query: 'gpt',
      startIndex: 0,
    });
  });

  it('应该在输入中间的 @ 后返回上下文', () => {
    const result = getCurrentMentionContext('你好 @gpt', 8);

    expect(result).toEqual({
      query: 'gpt',
      startIndex: 3, // "你好 @" 中 @ 在索引 3
    });
  });

  it('应该在没有 @ 时返回 null', () => {
    const result = getCurrentMentionContext('你好世界', 4);

    expect(result).toBeNull();
  });

  it('应该处理引号内的内容', () => {
    const result = getCurrentMentionContext('@"GPT-4 Tur', 11);

    expect(result).toEqual({
      query: 'GPT-4 Tur',
      startIndex: 0,
    });
  });

  it('应该在引号闭合后返回 null', () => {
    const result = getCurrentMentionContext('@"GPT-4" 你好', 12);

    expect(result).toBeNull();
  });

  it('应该在 @ 后只有空格时返回空查询', () => {
    const result = getCurrentMentionContext('你好 @', 5);

    expect(result).toEqual({
      query: '',
      startIndex: 3, // "你好 @" 中 @ 在索引 3
    });
  });
});

// ============================================================================
// filterModelSuggestions 测试
// ============================================================================

describe('filterModelSuggestions', () => {
  it('应该在无查询时返回前 N 个模型', () => {
    const result = filterModelSuggestions('', mockModels, 3);

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('gpt-4');
  });

  it('应该按 ID 前缀匹配', () => {
    const result = filterModelSuggestions('gpt', mockModels);

    expect(result.map((m: ModelInfo) => m.id)).toContain('gpt-4');
    expect(result.map((m: ModelInfo) => m.id)).toContain('gpt-4-turbo');
  });

  it('应该按名称匹配', () => {
    const result = filterModelSuggestions('Claude', mockModels);

    expect(result.map((m: ModelInfo) => m.id)).toContain('claude-3-5-sonnet');
  });

  it('应该按别名匹配', () => {
    const result = filterModelSuggestions('ds', mockModels);

    expect(result.map((m: ModelInfo) => m.id)).toContain('deepseek-chat');
  });

  it('应该优先返回完全匹配的结果', () => {
    const result = filterModelSuggestions('gpt-4', mockModels);

    expect(result[0].id).toBe('gpt-4');
  });

  it('应该限制结果数量', () => {
    const result = filterModelSuggestions('g', mockModels, 2);

    expect(result).toHaveLength(2);
  });

  it('应该在无匹配时返回空数组', () => {
    const result = filterModelSuggestions('xyz123', mockModels);

    expect(result).toHaveLength(0);
  });
});

// ============================================================================
// formatMention 测试
// ============================================================================

describe('formatMention', () => {
  it('应该格式化简单模型 ID', () => {
    expect(formatMention('gpt-4', 'GPT-4')).toBe('@"GPT-4"');
  });

  it('应该始终使用引号包裹显示名称', () => {
    expect(formatMention('model with space', 'Model')).toBe('@"Model"');
  });

  it('应该忽略 modelId 的特殊字符并仍可格式化', () => {
    expect(formatMention('model@special', 'Model')).toBe('@"Model"');
  });
});

// ============================================================================
// shouldShowAutoComplete 测试
// ============================================================================

describe('shouldShowAutoComplete', () => {
  it('应该在 @ 后返回 true', () => {
    expect(shouldShowAutoComplete('@', 1)).toBe(true);
    expect(shouldShowAutoComplete('@gpt', 4)).toBe(true);
  });

  it('应该在没有 @ 时返回 false', () => {
    expect(shouldShowAutoComplete('你好', 2)).toBe(false);
  });

  it('应该在 @mention 完成后返回 false', () => {
    // 光标在 @gpt 后的空格之后
    expect(shouldShowAutoComplete('@gpt 你好', 5)).toBe(false);
  });
});

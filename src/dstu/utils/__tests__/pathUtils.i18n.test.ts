import { describe, expect, it, vi } from 'vitest';

import zhLlmUsage from '@/locales/zh-CN/llm_usage.json';
import enLlmUsage from '@/locales/en-US/llm_usage.json';

// 模拟 i18next 在 key 缺失时的 defaultValue 回退 + 插值行为，
// 验证纯函数在无 locale 资源时输出与主干一致的中文原文。
vi.mock('i18next', () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) => {
      const template = typeof options?.defaultValue === 'string' ? options.defaultValue : key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(options?.[name] ?? ''),
      );
    },
  },
}));

import { buildPath, validateResourceId, MAX_RESOURCE_ID_LENGTH } from '../pathUtils';

describe('pathUtils resource ID validation i18n', () => {
  it('locale files contain the dstu_path keys in both languages', () => {
    const expectedKeys = ['emptyId', 'idLengthExceeded', 'invalidPrefix'];
    for (const key of expectedKeys) {
      expect(zhLlmUsage.dstu_path).toHaveProperty(key);
      expect(enLlmUsage.dstu_path).toHaveProperty(key);
    }
  });

  it('zh-CN locale texts match the original hardcoded messages', () => {
    expect(zhLlmUsage.dstu_path.emptyId).toBe('资源ID不能为空');
    expect(zhLlmUsage.dstu_path.idLengthExceeded).toBe(
      '资源ID长度超限: {{length}} 字符（最大 {{max}}）',
    );
    expect(zhLlmUsage.dstu_path.invalidPrefix).toBe('资源ID格式无效：缺少有效前缀');
  });

  it('validateResourceId returns the original Chinese message for empty id', () => {
    const result = validateResourceId('');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('资源ID不能为空');
  });

  it('validateResourceId returns the original Chinese message with interpolation for overlong id', () => {
    const overlongId = `note_${'a'.repeat(MAX_RESOURCE_ID_LENGTH)}`;
    const result = validateResourceId(overlongId);
    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      `资源ID长度超限: ${overlongId.length} 字符（最大 ${MAX_RESOURCE_ID_LENGTH}）`,
    );
  });

  it('validateResourceId returns the original Chinese message for missing prefix', () => {
    const result = validateResourceId('unknownprefix_abc');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('资源ID格式无效：缺少有效前缀');
  });

  it('buildPath throws the original Chinese message for overlong resource id', () => {
    const overlongId = `note_${'a'.repeat(MAX_RESOURCE_ID_LENGTH)}`;
    expect(() => buildPath('/folder', overlongId)).toThrowError(
      `资源ID长度超限: ${overlongId.length} 字符（最大 ${MAX_RESOURCE_ID_LENGTH}）`,
    );
  });

  it('validateResourceId still accepts a valid id', () => {
    expect(validateResourceId('note_abc123')).toEqual({ valid: true });
  });
});

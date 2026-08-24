/**
 * useAIEditState 用户可见错误文案 i18n 契约测试。
 *
 * 错误文案走 `i18n.t('learningHub:ai_edit.*', { defaultValue: 主干中文原文 })`，
 * 同时在两个 locale 中注册与 defaultValue 一致的消息。
 * 因此分两层守卫：
 * 1. source 守卫：每条错误必须经 i18n.t 且 defaultValue 与主干原文逐字相等，
 *    不允许硬编码中文直接赋给 error；learningHub locale JSON 必须包含完整
 *    ai_edit 段。
 * 2. 行为守卫：mock `@/i18n` 复刻 i18next 的 defaultValue + {{var}} 插值语义，
 *    断言 computeProposedContent / reject 返回给 UI 的中文与切换前完全一致。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const i18nMock = vi.hoisted(() => {
  // 复刻 i18next 语义：key 未在任何 locale 注册时返回 defaultValue，并做 {{var}} 插值。
  const t = (key: string, options?: Record<string, unknown>) => {
    const template =
      typeof options?.defaultValue === 'string' ? (options.defaultValue as string) : key;
    return template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (placeholder, name) => {
      const value = options?.[name];
      return value == null ? placeholder : String(value);
    });
  };
  return { t };
});
vi.mock('@/i18n', () => ({ default: i18nMock }));

import {
  computeProposedContent,
  useAIEditState,
  type CanvasAIEditRequest,
} from '../useAIEditState';

const source = readFileSync(
  resolve(process.cwd(), 'src/features/notes/hooks/useAIEditState.ts'),
  'utf8',
);

/** key ↔ 主干中文原文（defaultValue 必须逐字相等，插值统一 {{var}}） */
const EXPECTED_MESSAGES: Array<[key: string, defaultValue: string]> = [
  ['append_content_empty', '追加内容为空'],
  ['search_pattern_empty', '搜索模式为空'],
  ['invalid_regex', '无效的正则表达式: {{message}}'],
  ['regex_syntax_error', '语法错误'],
  ['replace_target_not_found', '未找到要替换的内容'],
  ['unknown_operation', '未知的操作类型: {{operation}}'],
  ['section_not_found', '未找到章节: {{section}}'],
  ['user_rejected', '用户拒绝修改'],
];

describe('useAIEditState i18n source contract', () => {
  it('imports the shared i18n instance', () => {
    expect(source).toContain("import i18n from '@/i18n';");
  });

  it('routes every user-facing error through learningHub:ai_edit.* with the original text as defaultValue', () => {
    for (const [key, defaultValue] of EXPECTED_MESSAGES) {
      expect(source).toContain(`i18n.t('learningHub:ai_edit.${key}'`);
      expect(source).toContain(`defaultValue: '${defaultValue}'`);
    }
  });

  it('no longer assigns hardcoded string literals to error fields', () => {
    // 切换后所有 error 赋值要么是 i18n.t(...) 要么是透传变量，
    // 不允许再出现 error: '中文' / error: `模板串` 这类硬编码。
    expect(source).not.toMatch(/error:\s*['"`]/);
  });

  it('registers every defaultValue in both learningHub locale bundles', () => {
    for (const lang of ['zh-CN', 'en-US']) {
      const bundle = JSON.parse(
        readFileSync(resolve(process.cwd(), `src/locales/${lang}/learningHub.json`), 'utf8'),
      ) as { ai_edit?: Record<string, string> };
      for (const [key, defaultValue] of EXPECTED_MESSAGES) {
        expect(bundle.ai_edit?.[key]).toBe(defaultValue);
      }
    }
  });
});

describe('computeProposedContent keeps the original Chinese wording under defaultValue', () => {
  const ORIGINAL = '# 标题\n\n正文内容';

  const request = (overrides: Partial<CanvasAIEditRequest>): CanvasAIEditRequest => ({
    requestId: 'req-1',
    noteId: 'note-1',
    operation: 'append',
    ...overrides,
  });

  it('append with empty content', () => {
    const result = computeProposedContent(request({ operation: 'append', content: '' }), ORIGINAL);
    expect(result.error).toBe('追加内容为空');
    expect(result.content).toBe(ORIGINAL);
  });

  it('append targeting a missing section interpolates the section title', () => {
    const result = computeProposedContent(
      request({ operation: 'append', content: '新增内容', section: '概述' }),
      ORIGINAL,
    );
    expect(result.error).toBe('未找到章节: 概述');
    expect(result.content).toBe(ORIGINAL);
  });

  it('replace with an empty search pattern', () => {
    const result = computeProposedContent(
      request({ operation: 'replace', search: '', replace: 'x' }),
      ORIGINAL,
    );
    expect(result.error).toBe('搜索模式为空');
    expect(result.content).toBe(ORIGINAL);
  });

  it('replace with an invalid regex keeps the prefix and carries the engine message', () => {
    const result = computeProposedContent(
      request({ operation: 'replace', search: '[', replace: 'x', isRegex: true }),
      ORIGINAL,
    );
    expect(result.error).toMatch(/^无效的正则表达式: /);
    expect(result.error!.length).toBeGreaterThan('无效的正则表达式: '.length);
    expect(result.content).toBe(ORIGINAL);
  });

  it('replace with no match', () => {
    const result = computeProposedContent(
      request({ operation: 'replace', search: '不存在的片段', replace: 'x' }),
      ORIGINAL,
    );
    expect(result.error).toBe('未找到要替换的内容');
    expect(result.content).toBe(ORIGINAL);
  });

  it('unknown operation interpolates the operation name', () => {
    const result = computeProposedContent(
      request({ operation: 'delete' as CanvasAIEditRequest['operation'] }),
      ORIGINAL,
    );
    expect(result.error).toBe('未知的操作类型: delete');
    expect(result.content).toBe(ORIGINAL);
  });

  it('valid operations still succeed without error', () => {
    const result = computeProposedContent(
      request({ operation: 'replace', search: '正文', replace: '主体' }),
      ORIGINAL,
    );
    expect(result.error).toBeUndefined();
    expect(result.replaceCount).toBe(1);
    expect(result.content).toContain('主体内容');
  });
});

describe('useAIEditState.reject keeps the original Chinese wording', () => {
  it('returns 用户拒绝修改 on reject', () => {
    const { result } = renderHook(() => useAIEditState());

    act(() => {
      const startError = result.current.startEdit(
        {
          requestId: 'req-reject',
          noteId: 'note-1',
          operation: 'append',
          content: '追加一段',
        },
        '原文',
      );
      expect(startError).toBeNull();
    });

    let rejectResult: ReturnType<typeof result.current.reject> = null;
    act(() => {
      rejectResult = result.current.reject();
    });

    expect(rejectResult).not.toBeNull();
    expect(rejectResult!.success).toBe(false);
    expect(rejectResult!.error).toBe('用户拒绝修改');
    expect(result.current.state.isActive).toBe(false);
  });
});

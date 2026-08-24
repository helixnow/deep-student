import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: (ns?: string | string[]) => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const namespace = Array.isArray(ns) ? ns[0] : ns;
      if (namespace === 'common') {
        const common: Record<string, string> = {
          'aiContentLabel.label': 'AI 生成',
          'aiContentLabel.tooltip': 'AI',
          'aiContentLabel.ariaLabel': 'AI',
        };
        return common[key] ?? key;
      }
      const map: Record<string, string> = {
        parse_error_title: '无法解析 AI 界面意图',
        parse_error_invalid: '格式无效',
        unknown_block_title: `未知组件：${params?.type ?? ''}`,
        unknown_block_desc: '已跳过，请检查组件注册表',
        validation_failed_title: `${params?.type ?? ''} 参数校验失败`,
        'chrome.accept': '接受',
        'chrome.regenerate': '重新生成',
        'chrome.dismiss': '忽略',
        'chrome.streaming': '生成中…',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

import {
  parseGenerativeUIIntent,
  validateBlockProps,
  generativeUIRegistry,
} from '@/features/generative-ui';
import { statCardPropsSchema } from '@/features/generative-ui/schema';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { LEARNING_DASHBOARD_EXAMPLE } from '@/features/generative-ui/prompts';

describe('generative-ui schema', () => {
  it('parses valid intent JSON', () => {
    const json = JSON.stringify(LEARNING_DASHBOARD_EXAMPLE);
    const result = parseGenerativeUIIntent(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.blocks.length).toBeGreaterThan(0);
    }
  });

  it('rejects invalid JSON', () => {
    const result = parseGenerativeUIIntent('{ invalid');
    expect(result.ok).toBe(false);
  });

  it('rejects unknown top-level shape', () => {
    const result = parseGenerativeUIIntent(JSON.stringify({ foo: 1 }));
    expect(result.ok).toBe(false);
  });

  it('validates stat-card props', () => {
    const result = validateBlockProps(statCardPropsSchema, {
      title: 'Test',
      value: 42,
    });
    expect(result.ok).toBe(true);
  });
});

describe('generativeUIRegistry', () => {
  it('registers built-in block types', () => {
    expect(generativeUIRegistry.has('stat-card')).toBe(true);
    expect(generativeUIRegistry.has('list')).toBe(true);
    expect(generativeUIRegistry.has('action-bar')).toBe(true);
    expect(generativeUIRegistry.has('flashcard-preview')).toBe(true);
    expect(generativeUIRegistry.keys().length).toBeGreaterThanOrEqual(10);
  });
});

describe('GenerativeUIRenderer', () => {
  it('renders learning dashboard example', () => {
    render(<GenerativeUIRenderer intent={LEARNING_DASHBOARD_EXAMPLE} showChrome={false} />);
    expect(screen.getByText('本周学习概览')).toBeInTheDocument();
    expect(screen.getByText('完成练习')).toBeInTheDocument();
    expect(screen.getByText('待巩固知识点')).toBeInTheDocument();
    expect(screen.getByText('开始复习')).toBeInTheDocument();
  });

  it('shows error for invalid JSON string', () => {
    render(<GenerativeUIRenderer intent="{ bad json" showChrome={false} />);
    expect(screen.getByText('无法解析 AI 界面意图')).toBeInTheDocument();
  });

  it('shows warning for unknown block type', () => {
    render(
      <GenerativeUIRenderer
        intent={{
          version: '1',
          blocks: [{ type: 'unknown-widget', props: {} }],
        }}
        showChrome={false}
      />,
    );
    expect(screen.getByText(/未知组件/)).toBeInTheDocument();
  });

  it('renders AI chrome with accept actions when onAction provided', () => {
    render(
      <GenerativeUIRenderer
        intent={LEARNING_DASHBOARD_EXAMPLE}
        showChrome
        onAction={() => {}}
      />,
    );
    expect(screen.getByText('AI 生成')).toBeInTheDocument();
    expect(screen.getByText('接受')).toBeInTheDocument();
  });
});

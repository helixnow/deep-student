/**
 * 渲染期容错：LLM 的 props 别名与整份 schema 失败（多余 version / 少量非法块）
 * 都不应把可展示的仪表盘降级成「参数校验失败」或解析错误。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        parse_error_title: '无法解析 AI 界面意图',
        parse_error_invalid: '格式无效',
        unknown_block_title: `未知组件：${params?.type ?? ''}`,
        unknown_block_desc: '已跳过',
        validation_failed_title: `${params?.type ?? ''} 参数校验失败`,
        'chrome.accept': '接受',
        'chrome.regenerate': '重新生成',
        'chrome.dismiss': '忽略',
        'chrome.streaming': '生成中…',
        'a11y.region_label': 'AI 生成界面',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { extractGenerativeUIIntent } from '@/features/generative-ui/bridge/chatBlockBridge';
import '@/features/generative-ui/blocks';

const ALIAS_INTENT = {
  version: '1',
  blocks: [
    { type: 'stat-card', props: { title: '连续打卡', value: 12, unit: '天', hint: '比上周多 2 天' } },
    { type: 'alert', props: { title: '复习提醒', level: 'warn', message: '今天还有 8 张闪卡到期' } },
    { type: 'list', props: { title: '待办', items: ['背单词', { text: '做题', meta: '30 分钟' }] } },
    { type: 'progress', props: { title: '本周目标', value: 3, max: 5 } },
    {
      type: 'flashcard-preview',
      props: {
        title: '第三章',
        cards: [
          { front: '问题一', back: '答案一' },
          { front: '问题二', back: '答案二', tag: '难点' },
        ],
      },
    },
    { type: 'table', props: { columns: ['方案', '复杂度'], rows: [['Parameter Server', 'O(K)']] } },
    { type: 'steps', props: { items: [{ title: '复习闪卡', status: 'completed' }] } },
  ],
};

describe('GenerativeUIRenderer — props alias normalization', () => {
  it('renders alias-shaped blocks instead of validation errors', () => {
    const { container } = render(
      <GenerativeUIRenderer intent={ALIAS_INTENT} showChrome={false} />,
    );

    expect(screen.queryByText(/参数校验失败/)).not.toBeInTheDocument();
    expect(screen.queryByText('无法解析 AI 界面意图')).not.toBeInTheDocument();

    expect(screen.getByText('连续打卡')).toBeInTheDocument();
    expect(screen.getByText('12 天')).toBeInTheDocument();
    expect(screen.getByText('比上周多 2 天')).toBeInTheDocument();

    expect(screen.getByText('复习提醒')).toBeInTheDocument();
    expect(screen.getByText('今天还有 8 张闪卡到期')).toBeInTheDocument();

    expect(screen.getByText('背单词')).toBeInTheDocument();
    expect(screen.getByText('做题')).toBeInTheDocument();
    expect(screen.getByText('30 分钟')).toBeInTheDocument();

    expect(screen.getByText('本周目标')).toBeInTheDocument();

    // 多卡闪卡展开成两个块
    expect(container.querySelectorAll('[data-block-type="flashcard-preview"]')).toHaveLength(2);
    expect(screen.getByText('问题一')).toBeInTheDocument();
    expect(screen.getByText('答案一')).toBeInTheDocument();
    expect(screen.getByText('问题二')).toBeInTheDocument();
    expect(screen.getByText('答案二')).toBeInTheDocument();
    expect(screen.getAllByText('第三章')).toHaveLength(2);

    expect(screen.getByText('Parameter Server')).toBeInTheDocument();
    expect(screen.getByText('O(K)')).toBeInTheDocument();
    expect(screen.getByText('复习闪卡')).toBeInTheDocument();
  });
});

describe('GenerativeUIRenderer — intent recovery', () => {
  it('recovers renderable blocks when the document version drifts and one block is invalid', () => {
    render(
      <GenerativeUIRenderer
        intent={{
          version: '2',
          blocks: [
            { type: 'text', props: { body: '保留下来的正文' } },
            { type: '', props: {} },
          ],
        }}
        showChrome={false}
      />,
    );

    expect(screen.getByText('保留下来的正文')).toBeInTheDocument();
    expect(screen.queryByText('无法解析 AI 界面意图')).not.toBeInTheDocument();
  });
});

describe('chatBlockBridge — intent recovery', () => {
  it('returns recovered intent for a partially invalid object intent', () => {
    const result = extractGenerativeUIIntent({
      intent: {
        version: '1.1',
        blocks: [{ type: 'text', props: { body: '正文' } }, { props: { body: '缺少 type' } }],
      },
      isStreaming: false,
    });

    expect(result).not.toBeNull();
    expect(typeof result!.intent).not.toBe('string');
    if (typeof result!.intent !== 'string') {
      expect(result!.intent.blocks).toHaveLength(1);
      expect(result!.intent.blocks[0].type).toBe('text');
    }
  });

  it('still returns null when nothing is recoverable', () => {
    expect(extractGenerativeUIIntent({ intent: { blocks: [{}] }, isStreaming: false })).toBeNull();
  });
});

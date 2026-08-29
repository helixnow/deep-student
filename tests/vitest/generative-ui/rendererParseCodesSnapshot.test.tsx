/**
 * Renderer parse-failure Alert 挂 data-parse-error-codes，
 * 成功 displayIntent 写入 default snapshot ring。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { fingerprintGenerativeUIIntent } from '@/features/generative-ui/utils/fingerprintGenerativeUIIntent';
import {
  getDefaultGenerativeUIIntentSnapshotRing,
  resetDefaultGenerativeUIIntentSnapshotRing,
} from '@/features/generative-ui/utils/intentSnapshotRing';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';
import '@/features/generative-ui/blocks';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        parse_error_title: '无法解析 AI 界面意图',
        parse_error_invalid: '格式无效',
        unknown_block_title: `未知组件：${params?.type ?? ''}`,
        unknown_block_desc: '已跳过',
        validation_failed_title: '校验失败',
        'chrome.accept': '接受',
        'chrome.regenerate': '重新生成',
        'chrome.dismiss': '忽略',
        'chrome.streaming': '生成中…',
        'a11y.region_label': 'AI 界面',
        'a11y.skip_to_actions': '跳到操作栏',
        'a11y.text_label': '文本',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

const VALID_INTENT: GenerativeUIIntent = {
  version: '1',
  blocks: [{ type: 'text', props: { body: 'snapshot-body' } }],
};

describe('GenerativeUIRenderer parse-error codes + intent snapshot', () => {
  afterEach(() => {
    resetDefaultGenerativeUIIntentSnapshotRing();
  });

  it('stamps data-parse-error-codes with invalid-json on a non-streaming parse Alert', () => {
    const { container } = render(
      <GenerativeUIRenderer intent="{ not-json" showChrome={false} />,
    );

    const alert = container.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert?.getAttribute('data-parse-error-codes')).toContain('invalid-json');
  });

  it('pushes a successful displayIntent into the default snapshot ring', () => {
    render(<GenerativeUIRenderer intent={VALID_INTENT} showChrome={false} />);

    expect(getDefaultGenerativeUIIntentSnapshotRing().latest()?.fingerprint).toBe(
      fingerprintGenerativeUIIntent(VALID_INTENT),
    );
  });

  it('does not snapshot an intent recovered from a strict parse failure', () => {
    render(
      <GenerativeUIRenderer
        intent={JSON.stringify({
          version: '2',
          blocks: [{ type: 'text', props: { body: 'recovered-only' } }],
        })}
        showChrome={false}
      />,
    );

    expect(getDefaultGenerativeUIIntentSnapshotRing().size).toBe(0);
  });

  it('does not snapshot an object that only passes schema validation after block capping', () => {
    const oversizedBlockList: GenerativeUIIntent = {
      version: '1',
      blocks: Array.from({ length: 33 }, (_, index) => ({
        type: 'text',
        props: { body: `block-${index}` },
      })),
    };
    const { container } = render(
      <GenerativeUIRenderer intent={oversizedBlockList} showChrome={false} />,
    );

    expect(container.querySelectorAll('[data-generative-block]')).toHaveLength(32);
    expect(getDefaultGenerativeUIIntentSnapshotRing().size).toBe(0);
  });

  it('waits for a valid streaming intent to complete before snapshotting it', () => {
    const { rerender } = render(
      <GenerativeUIRenderer intent={VALID_INTENT} isStreaming showChrome={false} />,
    );
    expect(getDefaultGenerativeUIIntentSnapshotRing().size).toBe(0);

    rerender(<GenerativeUIRenderer intent={VALID_INTENT} showChrome={false} />);
    expect(getDefaultGenerativeUIIntentSnapshotRing().size).toBe(1);
  });
});

/**
 * Renderer 在传入 actionHandlers 时表面未注册 action-bar id
 *（data-unregistered-actions）；省略 handlers 则不强制注册表。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { collectUnregisteredActionIds } from '@/features/generative-ui/utils/collectUnregisteredActionIds';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';
import '@/features/generative-ui/blocks';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'overflow.unregistered_actions': '有操作未注册，对应按钮已禁用',
        'a11y.region_label': 'AI 生成界面',
        'a11y.skip_to_actions': '跳到操作栏',
        'a11y.action_bar_label': '操作栏',
        'action.unregistered_hint': '未注册',
        'action.unregistered_label': '未注册操作',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

const UNREGISTERED_INTENT: GenerativeUIIntent = {
  version: '1',
  blocks: [
    {
      type: 'action-bar',
      props: {
        actions: [{ id: 'not-a-real-action', label: 'Ghost', riskLevel: 'low' }],
      },
    },
  ],
};

function unregisteredHint(): HTMLElement | null {
  return document.querySelector('[data-unregistered-actions]');
}

describe('GenerativeUIRenderer unregistered action-bar ids', () => {
  it('surfaces unregistered ids when actionHandlers is provided', () => {
    render(
      <GenerativeUIRenderer
        intent={UNREGISTERED_INTENT}
        showChrome={false}
        actionHandlers={{}}
      />,
    );

    const hint = unregisteredHint();
    expect(hint).not.toBeNull();
    expect(hint).toHaveAttribute('data-unregistered-count', '1');
    expect(hint).toHaveTextContent('有操作未注册，对应按钮已禁用');
  });

  it('does not show the hint when actionHandlers is omitted', () => {
    render(<GenerativeUIRenderer intent={UNREGISTERED_INTENT} showChrome={false} />);
    expect(unregisteredHint()).toBeNull();
  });

  it('updates a memoized action bar when handler enforcement changes', () => {
    const { rerender } = render(
      <GenerativeUIRenderer intent={UNREGISTERED_INTENT} showChrome={false} />,
    );
    const button = screen.getByRole('button', { name: 'Ghost' });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('data-action-unregistered');
    expect(unregisteredHint()).toBeNull();

    rerender(
      <GenerativeUIRenderer
        intent={UNREGISTERED_INTENT}
        showChrome={false}
        actionHandlers={{}}
      />,
    );
    expect(screen.getByRole('button', { name: '未注册操作' })).toBeDisabled();
    expect(button).toHaveAttribute('data-action-unregistered', '');
    expect(button).toHaveAttribute('title', '未注册');
    expect(screen.queryByRole('button', { name: 'Ghost' })).not.toBeInTheDocument();
    expect(unregisteredHint()).not.toBeNull();
  });
});

describe('collectUnregisteredActionIds', () => {
  it('returns [] when actionHandlers is undefined', () => {
    expect(collectUnregisteredActionIds(UNREGISTERED_INTENT)).toEqual([]);
  });

  it('returns unique ids in first-seen order', () => {
    const intent: GenerativeUIIntent = {
      version: '1',
      blocks: [
        {
          type: 'text',
          props: { body: 'ignore' },
        },
        {
          type: 'action-bar',
          props: {
            actions: [
              { id: 'missing-a', label: 'A' },
              { id: 'registered', label: 'R' },
              { id: 'missing-a', label: 'A again' },
            ],
          },
        },
        {
          type: 'action-bar',
          props: {
            actions: [
              { id: 'missing-b', label: 'B' },
              { id: 'registered', label: 'R2' },
            ],
          },
        },
      ],
    };

    expect(collectUnregisteredActionIds(intent, { registered: true })).toEqual([
      'missing-a',
      'missing-b',
    ]);
  });

  it('does not treat inherited prototype keys as registered handlers', () => {
    const intent: GenerativeUIIntent = {
      version: '1',
      blocks: [
        {
          type: 'action-bar',
          props: { actions: [{ id: 'toString', label: 'Proto' }] },
        },
      ],
    };

    expect(collectUnregisteredActionIds(intent, Object.create(null))).toEqual(['toString']);
    expect(collectUnregisteredActionIds(intent, {})).toEqual(['toString']);
  });
});

/**
 * 每个 GenerativeUIRenderer 使用独立 undo 栈，避免后一条消息
 * 在挂载时继承上一条 HITL 的撤销按钮。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import {
  getDefaultGenerativeActionUndoStack,
  resetDefaultGenerativeActionUndoStack,
} from '@/features/generative-ui/handlers/actionUndoStack';
import type { GenerativeActionDefinition, GenerativeUIIntent } from '@/features/generative-ui/types';
import '@/features/generative-ui/blocks';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'a11y.region_label': 'AI 生成界面',
        'a11y.skip_to_actions': '跳到操作栏',
        'a11y.action_bar_label': '操作栏',
        'action.undo': '撤销',
        'action.undo_empty': '没有可撤销的操作',
        'action.live_ok': '完成',
        'action.live_undo': '已撤销',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

const INTENT: GenerativeUIIntent = {
  version: '1',
  blocks: [
    {
      type: 'action-bar',
      props: { actions: [{ id: 'save-note', label: '保存', riskLevel: 'low' }] },
    },
  ],
};

function reversibleHandlers(
  undo: () => void,
): Record<string, GenerativeActionDefinition> {
  return {
    'save-note': {
      id: 'save-note',
      label: '保存',
      riskLevel: 'low',
      handler: async () => ({ undo }),
    },
  };
}

describe('GenerativeUIRenderer undo isolation', () => {
  it('does not inherit undo from a previous renderer or the default stack', async () => {
    const user = userEvent.setup();
    const leaked = resetDefaultGenerativeActionUndoStack();
    leaked.push({ actionId: 'save-note', undo: vi.fn() });
    expect(getDefaultGenerativeActionUndoStack().canUndo()).toBe(true);

    const firstUndo = vi.fn();
    const { unmount } = render(
      <GenerativeUIRenderer
        intent={INTENT}
        showChrome={false}
        actionHandlers={reversibleHandlers(firstUndo)}
      />,
    );

    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '撤销' })).toBeInTheDocument();
    });

    unmount();

    const secondUndo = vi.fn();
    render(
      <GenerativeUIRenderer
        intent={INTENT}
        showChrome={false}
        actionHandlers={reversibleHandlers(secondUndo)}
      />,
    );

    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument();
    expect(firstUndo).not.toHaveBeenCalled();
    expect(getDefaultGenerativeActionUndoStack().canUndo()).toBe(true);
  });

  it('keeps sibling renderers on separate undo stacks', async () => {
    const user = userEvent.setup();
    resetDefaultGenerativeActionUndoStack();
    const undoA = vi.fn();
    const undoB = vi.fn();

    render(
      <>
        <div data-testid="surface-a">
          <GenerativeUIRenderer
            intent={INTENT}
            showChrome={false}
            actionHandlers={reversibleHandlers(undoA)}
          />
        </div>
        <div data-testid="surface-b">
          <GenerativeUIRenderer
            intent={INTENT}
            showChrome={false}
            actionHandlers={reversibleHandlers(undoB)}
          />
        </div>
      </>,
    );

    const surfaceA = screen.getByTestId('surface-a');
    const surfaceB = screen.getByTestId('surface-b');
    await user.click(surfaceA.querySelector('button') as HTMLButtonElement);
    await waitFor(() => {
      expect(surfaceA.querySelector('[aria-label="撤销"]')).not.toBeNull();
    });
    expect(surfaceB.querySelector('[aria-label="撤销"]')).toBeNull();

    await user.click(surfaceA.querySelector('[aria-label="撤销"]') as HTMLButtonElement);
    await waitFor(() => {
      expect(undoA).toHaveBeenCalledTimes(1);
    });
    expect(undoB).not.toHaveBeenCalled();
  });
});

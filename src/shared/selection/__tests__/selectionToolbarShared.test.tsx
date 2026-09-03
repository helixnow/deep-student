/**
 * 共享划词工具条契约。
 *
 * 锁定两件事：
 * 1. chat 的老引用路径（`@/features/chat/components/SelectionToolbar`、
 *    `@/features/chat/hooks/useTextSelection`）仍然指向共享层同一个实现
 * 2. 宿主只传自己真的有的能力：hideUnavailableActions 下不渲染假入口，
 *    聊天默认（不传）保持历史的灰显占位行为
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('@/stores/viewStore', () => ({
  useViewStore: (selector: (s: { currentView: string }) => unknown) =>
    selector({ currentView: 'chat-v2' }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

import { SelectionToolbar as SharedSelectionToolbar } from '../SelectionToolbar';
import { useTextSelection as sharedUseTextSelection } from '../useTextSelection';
import { SelectionToolbar as ChatSelectionToolbar } from '@/features/chat/components/SelectionToolbar';
import { useTextSelection as chatUseTextSelection } from '@/features/chat/hooks/useTextSelection';

const rect = { top: 100, left: 100, width: 80, height: 20, bottom: 120 };

function renderToolbar(props: Partial<React.ComponentProps<typeof SharedSelectionToolbar>> = {}) {
  const Host: React.FC = () => {
    const containerRef = React.useRef<HTMLDivElement>(null);
    return (
      <div ref={containerRef} style={{ position: 'relative' }}>
        <SharedSelectionToolbar
          selectedText="选中的一段话"
          selectionRect={rect}
          isVisible
          containerRef={containerRef}
          onClear={() => {}}
          {...props}
        />
      </div>
    );
  };
  const utils = render(<Host />);
  const action = (label: string) =>
    utils.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  return { ...utils, action };
}

describe('shared SelectionToolbar', () => {
  beforeEach(cleanup);

  it('is re-exported unchanged from the legacy chat paths', () => {
    expect(ChatSelectionToolbar).toBe(SharedSelectionToolbar);
    expect(chatUseTextSelection).toBe(sharedUseTextSelection);
  });

  it('keeps the chat default: unwired actions render disabled, not hidden', () => {
    const { action } = renderToolbar();
    expect(action('解释')).not.toBeNull();
    expect(action('解释')?.disabled).toBe(true);
    expect(action('翻译')?.disabled).toBe(true);
    expect(action('制卡')?.disabled).toBe(true);
    expect(action('添加到聊天')?.disabled).toBe(true);
    // 聊天没接「保存为笔记」时不该凭空多出一个按钮
    expect(action('保存为笔记')).toBeNull();
  });

  it('hides unwired actions for hosts that opt into hideUnavailableActions', () => {
    const { action } = renderToolbar({
      hideUnavailableActions: true,
      onExplain: vi.fn(),
      onSaveAsNote: vi.fn(),
    });
    expect(action('解释')?.disabled).toBe(false);
    expect(action('保存为笔记')?.disabled).toBe(false);
    // 未接的能力不摆假入口
    expect(action('翻译')).toBeNull();
    expect(action('制卡')).toBeNull();
    expect(action('添加到聊天')).toBeNull();
  });

  it('renders save-as-note whenever the host wires it', () => {
    const { action } = renderToolbar({ onSaveAsNote: vi.fn() });
    expect(action('保存为笔记')?.disabled).toBe(false);
  });

  it('accepts a host className for stacking overrides', () => {
    const { container } = renderToolbar({ className: 'z-[150]' });
    expect(container.querySelector('[data-selection-toolbar]')?.className).toContain('z-[150]');
  });
});

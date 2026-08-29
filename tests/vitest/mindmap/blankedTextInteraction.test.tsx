import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlankedText } from '@/features/mindmap/components/shared/BlankedText';

// 保留模块其余导出（initReactI18next 等）：src/i18n.ts 在模块加载时消费它们，
// 只导出 useTranslation 会让本文件在收集阶段崩溃。t 需跨渲染身份稳定。
vi.mock('react-i18next', async (importOriginal) => {
  const t = (key: string) => key;
  return {
    ...(await importOriginal<typeof import('react-i18next')>()),
    useTranslation: () => ({ t }),
  };
});

describe('BlankedText recite interaction', () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it('creates a blank when WebKit reports the selection at element boundaries', async () => {
    const onAddBlank = vi.fn();
    const { container } = render(
      <BlankedText text="中心主题" reciteMode onAddBlank={onAddBlank} />,
    );
    const textContainer = container.querySelector('.nopan.nodrag');
    expect(textContainer).toBeInstanceOf(HTMLElement);
    expect(screen.getByText('中心主题')).toHaveClass('mm-blankable-text-segment');

    const range = document.createRange();
    range.selectNodeContents(textContainer as HTMLElement);
    Object.defineProperty(range, 'getBoundingClientRect', {
      value: () => ({ left: 10, top: 20, width: 40, height: 16 }),
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.mouseUp(textContainer as HTMLElement);
    fireEvent.click(await screen.findByRole('button', { name: 'recite.blank' }));

    expect(onAddBlank).toHaveBeenCalledWith({ start: 0, end: 4 });
  });

  it('does not present empty placeholder text as blankable content', () => {
    const { container } = render(
      <BlankedText text="未命名" reciteMode />,
    );

    expect(container.querySelector('.nopan.nodrag')).toBeNull();
  });

  it('opens the blank action from the selected text context menu', async () => {
    const onAddBlank = vi.fn();
    const { container } = render(
      <BlankedText text="中心主题" reciteMode onAddBlank={onAddBlank} />,
    );
    const textContainer = container.querySelector('.nopan.nodrag') as HTMLElement;
    const textNode = textContainer.querySelector('.mm-blankable-text-segment')?.firstChild;
    expect(textNode).toBeInstanceOf(Text);

    const range = document.createRange();
    range.setStart(textNode as Text, 0);
    range.setEnd(textNode as Text, 4);
    Object.defineProperty(range, 'getBoundingClientRect', {
      value: () => ({ left: 10, top: 20, width: 40, height: 16 }),
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.contextMenu(textContainer, { clientX: 80, clientY: 90 });
    fireEvent.click(await screen.findByRole('button', { name: 'recite.blank' }));

    expect(onAddBlank).toHaveBeenCalledWith({ start: 0, end: 4 });
  });
});

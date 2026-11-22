/**
 * useTextSelectionBubble 缩放坐标修正 & Escape 捕获层级测试
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MindMapActiveContext } from '../../MindMapActiveContext';
import { measureSelectionByMirror, useTextSelectionBubble } from '../useTextSelectionBubble';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  BACK_PRIORITY: { overlay: 10 },
  registerBackHandler: () => () => {},
}));

function makeDomRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('measureSelectionByMirror zoom scaling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  function runWithZoom(zoom: number) {
    const textarea = document.createElement('textarea');
    textarea.value = 'Hello World';
    document.body.appendChild(textarea);

    Object.defineProperty(textarea, 'offsetWidth', { configurable: true, value: 200 });
    Object.defineProperty(textarea, 'scrollLeft', { configurable: true, value: 10 });
    Object.defineProperty(textarea, 'scrollTop', { configurable: true, value: 5 });

    const elLeft = 100;
    const elTop = 200;
    const elWidth = 200 * zoom;
    const elHeight = 100 * zoom;

    vi.spyOn(textarea, 'getBoundingClientRect').mockReturnValue(
      makeDomRect(elLeft, elTop, elWidth, elHeight),
    );

    // 镜像 div 与内部选区 span 均挂在 body（未缩放坐标系）
    const origAppendChild = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, 'appendChild').mockImplementation((node: Node) => {
      const appended = origAppendChild(node);
      if (node instanceof HTMLDivElement) {
        vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(makeDomRect(0, 0, 200, 100));
        const span = node.querySelector('span');
        if (span) {
          // 镜像内偏移：left=60, top=25, width=40, height=20
          vi.spyOn(span, 'getBoundingClientRect').mockReturnValue(makeDomRect(60, 25, 40, 20));
        }
      }
      return appended;
    });

    const result = measureSelectionByMirror(textarea, 6, 11);
    textarea.remove();
    return result;
  }

  it('scales mirror offset accurately at 50%, 100%, and 150% viewport zoom', () => {
    // localX = (60 - 0) + 40/2 - 10 = 70; localY = (25 - 0) - 5 = 20; height = 20
    const z100 = runWithZoom(1.0);
    expect(z100).toEqual({ x: 170, y: 220, bottom: 240 });

    const z50 = runWithZoom(0.5);
    expect(z50).toEqual({ x: 135, y: 210, bottom: 220 });

    const z150 = runWithZoom(1.5);
    expect(z150).toEqual({ x: 205, y: 230, bottom: 260 });
  });
});

describe('useTextSelectionBubble Escape hierarchy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('intercepts Escape in document capture phase to close bubble first without reaching textarea', () => {
    const onTextareaEscape = vi.fn();

    const Harness: React.FC = () => {
      const { handleMouseUp, bubble } = useTextSelectionBubble({
        onAddBlank: vi.fn(),
        onToggleBold: vi.fn(),
      });
      return (
        <MindMapActiveContext.Provider value={{ isActive: true, resourceId: null }}>
          <textarea
            aria-label="editor"
            defaultValue="Deep Student MindMap"
            onMouseUp={handleMouseUp}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onTextareaEscape();
            }}
          />
          {bubble}
        </MindMapActiveContext.Provider>
      );
    };

    render(<Harness />);
    const textarea = screen.getByLabelText('editor') as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(0, 4);

    fireEvent.mouseUp(textarea);
    act(() => {
      vi.runAllTimers();
    });

    // 选区气泡已打开
    expect(screen.getByRole('toolbar')).toBeTruthy();

    // 第一次按 Escape：气泡捕获并消费，不得穿透到 textarea 退出编辑
    act(() => {
      const firstEsc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      textarea.dispatchEvent(firstEsc);
      expect(firstEsc.defaultPrevented).toBe(true);
    });

    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(onTextareaEscape).not.toHaveBeenCalled();

    // 第二次按 Escape：气泡已关闭，正常到达 textarea 退出编辑
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onTextareaEscape).toHaveBeenCalledTimes(1);
  });
});

/**
 * PDF 划词能力接入的行为契约。
 *
 * `pdfSelectionToolbar.source.test.ts` 只锁「接线接对了」；这里跑真组件，
 * 验证用户实际点下去会发生什么：
 * 1. 文本层关闭时整套能力不挂载（不能在没有选区的阅读器上冒出工具条）
 * 2. 工具条只渲染 PDF 真的接了的能力，不摆灰色假入口
 * 3. 保存为笔记 → 先弹目录选择器，而不是闷头写根目录
 * 4. 解释 / 翻译 → 内联结果面板，且面板打开时工具条让位
 * 5. 制卡 → 复用 selectionCardGeneration，带上下文
 * 6. 添加到聊天 → 优先 onQuoteToChat locator 回调（资源引用 + page）；
 *    无回调或页码不可得时走 PREFILL_CHAT_INPUT 包装（带 sourceName），
 *    任何情况下都不派发裸 CHAT_V2_SET_INPUT
 * 7. documentTitle 契约：宿主必须传人类可读 fileName（EnhancedPdfViewer 的
 *    documentTitle={fileName} 由 pdfSelectionToolbar.source.test.ts 锁定），
 *    这里验证它确实落到笔记来源行与 PREFILL 的 sourceName
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent, waitFor } from '@testing-library/react';

const generateCardsFromSelection = vi.fn();
const saveAsNoteStart = vi.fn();

let selectionState = {
  selectedText: '',
  selectionRect: null as null | { top: number; left: number; width: number; height: number; bottom: number },
  isVisible: false,
  contextBefore: '',
  contextAfter: '',
  clear: vi.fn(),
};

vi.mock('@/stores/viewStore', () => ({
  useViewStore: (selector: (s: { currentView: string }) => unknown) =>
    selector({ currentView: 'workbench' }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));

vi.mock('@/shared/selection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/selection')>();
  return { ...actual, useTextSelection: () => selectionState };
});

vi.mock('@/shared/notes', () => ({
  useSaveAsNoteFlow: () => ({
    start: saveAsNoteStart,
    isSaving: false,
    pickerProps: { open: false, onOpenChange: () => {}, onConfirm: () => {}, title: '选择保存目录', inline: false },
  }),
  SaveAsNoteFolderPicker: () => null,
}));

vi.mock('@/features/chat/components/ExplainPopover', () => ({
  ExplainPopover: ({ sourceText }: { sourceText: string }) => (
    <div data-testid="explain-popover">{sourceText}</div>
  ),
}));

vi.mock('@/features/chat/components/TranslationPopover', () => ({
  TranslationPopover: ({ sourceText, contextBefore }: { sourceText: string; contextBefore: string }) => (
    <div data-testid="translate-popover" data-context-before={contextBefore}>
      {sourceText}
    </div>
  ),
}));

vi.mock('@/features/chat/services/selectionCardGeneration', () => ({
  generateCardsFromSelection: (...args: unknown[]) => generateCardsFromSelection(...args),
}));

import { PdfSelectionActions } from '../PdfSelectionActions';

const SELECTED = '费曼路径积分表述';

function renderActions(props: Partial<React.ComponentProps<typeof PdfSelectionActions>> = {}) {
  // 阅读器根节点先于选区存在；延后一帧挂载，工具条才量得到定位容器
  const Host: React.FC = () => {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const [mounted, setMounted] = React.useState(false);
    React.useEffect(() => setMounted(true), []);
    return (
      <div ref={containerRef} style={{ position: 'relative' }}>
        {/* 模拟 pdf.js 页面包裹层：resolveSelectionPage 靠 data-page-number 定位 */}
        <div data-page-number="3">
          <span data-testid="page-text">{SELECTED}</span>
        </div>
        {mounted && (
          <PdfSelectionActions
            containerRef={containerRef}
            enabled
            isMobileLike={false}
            documentTitle="量子力学讲义"
            {...props}
          />
        )}
      </div>
    );
  };
  return render(<Host />);
}

/** 在页面包裹层内建立真实 DOM 选区，让 resolveSelectionPage 解析出页码 3 */
function selectTextInsidePage() {
  const range = document.createRange();
  range.selectNodeContents(screen.getByTestId('page-text'));
  const domSelection = window.getSelection()!;
  domSelection.removeAllRanges();
  domSelection.addRange(range);
}

const button = (name: string) => screen.getByRole('button', { name, hidden: true });

beforeEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  generateCardsFromSelection.mockReset();
  saveAsNoteStart.mockReset();
  selectionState = {
    selectedText: SELECTED,
    selectionRect: { top: 200, left: 100, width: 120, height: 20, bottom: 220 },
    isVisible: true,
    contextBefore: '前文',
    contextAfter: '后文',
    clear: vi.fn(),
  };
});

describe('PdfSelectionActions mounting', () => {
  it('renders nothing while the text layer is off', () => {
    renderActions({ enabled: false });
    expect(screen.queryByRole('toolbar', { hidden: true })).toBeNull();
  });

  it('renders nothing when there is no active selection', () => {
    selectionState = { ...selectionState, isVisible: false, selectedText: '', selectionRect: null };
    renderActions();
    expect(screen.queryByRole('toolbar', { hidden: true })).toBeNull();
  });

  it('shows only the capabilities the reader actually wired', () => {
    renderActions();
    for (const label of ['复制', '解释', '翻译', '保存为笔记', '制卡', '添加到聊天']) {
      expect(button(label)).toBeEnabled();
    }
  });

  it('mounts exactly one toolbar — learning actions live on a single surface', () => {
    renderActions();
    // 单工具条契约：学习动作只由这一条共享 SelectionToolbar 承载；
    // viewer 内建 ds-highlight-menu 只留高亮选色 + 复制（由 source contract 锁定）
    expect(screen.getAllByRole('toolbar', { hidden: true })).toHaveLength(1);
  });
});

describe('save as note', () => {
  it('opens the folder picker flow with the document title as provenance', () => {
    renderActions();
    fireEvent.click(button('保存为笔记'));

    expect(saveAsNoteStart).toHaveBeenCalledWith({
      content: `> 量子力学讲义\n\n${SELECTED}`,
    });
  });

  it('omits the quote line when the document has no title', () => {
    renderActions({ documentTitle: undefined });
    fireEvent.click(button('保存为笔记'));
    expect(saveAsNoteStart).toHaveBeenCalledWith({ content: SELECTED });
  });
});

describe('explain / translate results', () => {
  it('opens the explain panel inline and yields the toolbar to it', async () => {
    renderActions();
    act(() => {
      fireEvent.click(button('解释'));
    });

    expect((await screen.findByTestId('explain-popover')).textContent).toBe(SELECTED);
    expect(screen.queryByRole('toolbar', { hidden: true })).toBeNull();
  });

  it('passes the surrounding context to the translation popover', async () => {
    renderActions();
    act(() => {
      fireEvent.click(button('翻译'));
    });

    const popover = await screen.findByTestId('translate-popover');
    expect(popover.textContent).toBe(SELECTED);
    expect(popover.getAttribute('data-context-before')).toBe('前文');
  });

  it('closes the panel from its close button', () => {
    renderActions();
    act(() => {
      fireEvent.click(button('解释'));
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '关闭', hidden: true }));
    });

    expect(screen.queryByTestId('explain-popover')).toBeNull();
  });

  it('shows results in an inline region, never a modal dialog', () => {
    renderActions();
    act(() => {
      fireEvent.click(button('翻译'));
    });
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
    expect(screen.getByRole('region', { hidden: true })).toBeTruthy();
  });
});

describe('cards and chat handoff', () => {
  it('routes card generation through the shared selection pipeline', async () => {
    renderActions();
    fireEvent.click(button('制卡'));

    await waitFor(() => expect(generateCardsFromSelection).toHaveBeenCalledTimes(1));
    const input = generateCardsFromSelection.mock.calls[0][0];
    expect(input.selectedText).toBe(SELECTED);
    expect(input.contextBefore).toBe('前文');
    expect(input.contextAfter).toBe('后文');
  });

  it('prefers the onQuoteToChat locator callback when the selection page is known', () => {
    const onQuoteToChat = vi.fn();
    renderActions({ onQuoteToChat });
    selectTextInsidePage();

    const prefills: CustomEvent[] = [];
    const rawInputs: CustomEvent[] = [];
    const prefillListener = (e: Event) => prefills.push(e as CustomEvent);
    const rawListener = (e: Event) => rawInputs.push(e as CustomEvent);
    window.addEventListener('PREFILL_CHAT_INPUT', prefillListener);
    window.addEventListener('CHAT_V2_SET_INPUT', rawListener);
    fireEvent.click(button('添加到聊天'));
    window.removeEventListener('PREFILL_CHAT_INPUT', prefillListener);
    window.removeEventListener('CHAT_V2_SET_INPUT', rawListener);

    expect(onQuoteToChat).toHaveBeenCalledWith({ text: SELECTED, page: 3 });
    // locator 回调命中时不再走任何事件通道（既无 PREFILL 也无裸通道）
    expect(prefills).toHaveLength(0);
    expect(rawInputs).toHaveLength(0);
  });

  it('falls back to the PREFILL_CHAT_INPUT wrapper when no locator callback is wired', () => {
    renderActions();
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener('PREFILL_CHAT_INPUT', listener);
    fireEvent.click(button('添加到聊天'));
    window.removeEventListener('PREFILL_CHAT_INPUT', listener);

    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({
      content: SELECTED,
      autoSend: false,
      sourceName: '量子力学讲义',
    });
  });

  it('falls back to PREFILL when the callback exists but the page cannot be resolved', () => {
    const onQuoteToChat = vi.fn();
    renderActions({ onQuoteToChat });
    // 不建 DOM 选区：resolveSelectionPage 拿不到页码，locator 语义不成立

    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener('PREFILL_CHAT_INPUT', listener);
    fireEvent.click(button('添加到聊天'));
    window.removeEventListener('PREFILL_CHAT_INPUT', listener);

    expect(onQuoteToChat).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    // 降级不丢来源标注（documentTitle → sourceName），也不伪造页码
    expect(events[0].detail).toEqual({
      content: SELECTED,
      autoSend: false,
      sourceName: '量子力学讲义',
    });
  });

  it('never dispatches the raw CHAT_V2_SET_INPUT channel from the reader', () => {
    renderActions();
    const rawInputs: CustomEvent[] = [];
    const prefills: CustomEvent[] = [];
    const rawListener = (e: Event) => rawInputs.push(e as CustomEvent);
    const prefillListener = (e: Event) => prefills.push(e as CustomEvent);
    window.addEventListener('CHAT_V2_SET_INPUT', rawListener);
    window.addEventListener('PREFILL_CHAT_INPUT', prefillListener);
    fireEvent.click(button('添加到聊天'));
    window.removeEventListener('CHAT_V2_SET_INPUT', rawListener);
    window.removeEventListener('PREFILL_CHAT_INPUT', prefillListener);

    // PREFILL 确实发出 → 点击走完了派发路径，「无裸通道」断言不是空转
    expect(prefills).toHaveLength(1);
    expect(rawInputs).toHaveLength(0);
  });
});

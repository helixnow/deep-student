import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  selectionToChatMock,
  exportHandoutMock,
  notifyMock,
  writeClipboardMock,
  readClipboardMock,
  isDarkMock,
} = vi.hoisted(() => ({
  selectionToChatMock: vi.fn(),
  exportHandoutMock: vi.fn(),
  notifyMock: vi.fn(),
  writeClipboardMock: vi.fn(),
  readClipboardMock: vi.fn(),
  isDarkMock: vi.fn(() => false),
}));

vi.mock('@/features/chat/context/selectionRef', () => ({
  selectionToChat: selectionToChatMock,
}));

vi.mock('../../../interop/handoutExport', () => ({
  exportMindMapSelectionToHandoutNote: exportHandoutMock,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: notifyMock,
}));

vi.mock('../../../utils/clipboardCodec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/clipboardCodec')>();
  return {
    ...actual,
    writeMindMapClipboard: writeClipboardMock,
    readMindMapClipboard: readClipboardMock,
  };
});

vi.mock('../../../hooks/useMindMapTheme', () => ({
  useMindMapDarkMode: isDarkMock,
}));

vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  BACK_PRIORITY: { overlay: 10 },
  registerBackHandler: () => () => {},
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (
      key: string,
      opts?: { defaultValue?: string; title?: string; error?: string; count?: number; level?: number; percent?: number; color?: string },
    ) => {
      const base = opts?.defaultValue ?? key;
      return base
        .replace('{{title}}', opts?.title ?? '')
        .replace('{{error}}', opts?.error ?? '')
        .replace('{{count}}', String(opts?.count ?? ''))
        .replace('{{level}}', String(opts?.level ?? ''))
        .replace('{{percent}}', String(opts?.percent ?? ''))
        .replace('{{color}}', opts?.color ?? '');
    },
  }),
}));

import { createMindMapStore, MindMapStoreContext } from '../../../store';
import { MindMapActiveContext } from '../../../MindMapActiveContext';
import { QUICK_BG_COLORS, QUICK_BG_COLORS_DARK, QUICK_TEXT_COLORS, QUICK_TEXT_COLORS_DARK } from '../../../constants';
import { CanvasContextMenu, type MindMapAiNodeAction } from '../CanvasContextMenu';

describe('CanvasContextMenu upgrades', () => {
  beforeEach(() => {
    selectionToChatMock.mockReset();
    exportHandoutMock.mockReset();
    notifyMock.mockReset();
    writeClipboardMock.mockReset().mockResolvedValue({ fingerprint: 'fp1', copiedAt: 1 });
    readClipboardMock.mockReset().mockResolvedValue({ kind: 'empty', text: null });
    isDarkMock.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
  });

  function setupMenu(opts?: {
    multiSelect?: boolean;
    onAiNodeAction?: (action: MindMapAiNodeAction, nodeId: string) => void;
    onClose?: () => void;
  }) {
    const store = createMindMapStore();
    const rootId = store.getState().document.root.id;
    store.setState({ mindmapId: 'mm_ctx_1' });
    const n1 = store.getState().addNode(rootId)!;
    const n2 = store.getState().addNode(rootId)!;
    store.getState().updateNode(n1, { text: '微积分基本定理' });
    store.getState().updateNode(n2, { text: '牛顿莱布尼茨公式' });
    if (opts?.multiSelect) {
      store.setState({ selection: [n1, n2], focusedNodeId: n1 });
    } else {
      store.setState({ selection: [n1], focusedNodeId: n1 });
    }

    const onClose = opts?.onClose ?? vi.fn();
    const view = render(
      <MindMapStoreContext.Provider value={store}>
        <MindMapActiveContext.Provider value={{ isActive: true, resourceId: null }}>
          <CanvasContextMenu
            isOpen={true}
            position={{ x: 100, y: 100 }}
            nodeId={n1}
            onClose={onClose}
            onAiNodeAction={opts?.onAiNodeAction}
          />
        </MindMapActiveContext.Provider>
      </MindMapStoreContext.Provider>,
    );

    return { store, rootId, n1, n2, onClose, ...view };
  }

  it('uses dark-mode adaptive palettes from getQuickTextColors/getQuickBgColors', () => {
    isDarkMock.mockReturnValue(false);
    const { unmount } = setupMenu();
    expect(screen.getByRole('button', { name: `选择颜色 ${QUICK_TEXT_COLORS[0]}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `选择颜色 ${QUICK_BG_COLORS[0]}` })).toBeTruthy();
    unmount();

    isDarkMock.mockReturnValue(true);
    setupMenu();
    expect(screen.getByRole('button', { name: `选择颜色 ${QUICK_TEXT_COLORS_DARK[0]}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `选择颜色 ${QUICK_BG_COLORS_DARK[0]}` })).toBeTruthy();
  });

  it('applies batch style, priority, progress, checkbox, flashcard, copy, and delete across multi-selection', async () => {
    const { store, n1, n2 } = setupMenu({ multiSelect: true });

    // 批量加粗 + 优先级 P2 + 进度 50% + 待办勾选框
    fireEvent.click(screen.getByTitle('contextMenu.bold'));
    fireEvent.click(screen.getByRole('button', { name: '优先级 2' }));
    fireEvent.click(screen.getByRole('button', { name: '进度 50%' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '显示待办勾选框' }));

    const children = store.getState().document.root.children;
    const node1 = children.find((c) => c.id === n1)!;
    const node2 = children.find((c) => c.id === n2)!;
    expect(node1.style?.fontWeight).toBe('bold');
    expect(node2.style?.fontWeight).toBe('bold');
    expect(node1.priority).toBe(2);
    expect(node2.priority).toBe(2);
    expect(node1.progress).toBe(50);
    expect(node2.progress).toBe(50);
    expect(node1.style?.showCheckbox).toBe(true);
    expect(node2.style?.showCheckbox).toBe(true);

    // 批量转闪卡
    fireEvent.click(screen.getByRole('menuitem', { name: '转为闪卡' }));
    expect(store.getState().document.root.children.find((c) => c.id === n1)?.isFlashcard).toBe(true);
    expect(store.getState().document.root.children.find((c) => c.id === n2)?.isFlashcard).toBe(true);

    // 批量归纳总结大括号
    fireEvent.click(screen.getByRole('menuitem', { name: '添加归纳总结' }));
    expect(store.getState().document.summaries?.length).toBe(1);

    // 批量复制写入系统剪贴板
    fireEvent.click(screen.getByRole('menuitem', { name: /contextMenu\.copy \(2\)/ }));
    expect(writeClipboardMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: n1 }),
        expect.objectContaining({ id: n2 }),
      ]),
    );

    // 批量删除触发内联二次确认并删除整组选中节点
    fireEvent.click(screen.getByRole('menuitem', { name: /actions\.delete \(2\)/ }));
    const confirmBtn = await screen.findByRole('button', { name: '删除' });
    fireEvent.click(confirmBtn);
    expect(store.getState().document.root.children).toHaveLength(0);
  });

  it('pastes external Markdown list from system clipboard even when internal clipboard is empty', async () => {
    readClipboardMock.mockResolvedValueOnce({
      kind: 'markdown',
      markdown: '- 外来主干\n  - 外来叶子',
      text: '- 外来主干\n  - 外来叶子',
    });
    const { store, n1 } = setupMenu();
    expect(store.getState().clipboard).toBeNull();

    const pasteItem = screen.getByRole('menuitem', { name: /contextMenu\.pasteAsChild/ });
    expect((pasteItem as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(pasteItem);

    await waitFor(() => {
      const target = store.getState().document.root.children.find((c) => c.id === n1)!;
      expect(target.children).toHaveLength(1);
      expect(target.children[0].text).toBe('外来主干');
      expect(target.children[0].children[0].text).toBe('外来叶子');
    });
  });

  it('dispatches AI actions to onAiNodeAction prop when provided', () => {
    const onAiNodeAction = vi.fn();
    const { n1 } = setupMenu({ onAiNodeAction });

    fireEvent.click(screen.getByRole('menuitem', { name: 'AI 扩写子节点' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'AI 总结当前分支' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'AI 智能生成挖空' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '追问当前知识点' }));

    expect(onAiNodeAction).toHaveBeenNthCalledWith(1, 'expand', n1);
    expect(onAiNodeAction).toHaveBeenNthCalledWith(2, 'summarize', n1);
    expect(onAiNodeAction).toHaveBeenNthCalledWith(3, 'cloze', n1);
    expect(onAiNodeAction).toHaveBeenNthCalledWith(4, 'ask', n1);
  });

  it('falls back to mindmap:ai-action custom event and selectionToChat when onAiNodeAction is omitted', async () => {
    const eventSpy = vi.fn();
    window.addEventListener('mindmap:ai-action', eventSpy);
    const { n1 } = setupMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'AI 扩写子节点' }));

    expect(eventSpy).toHaveBeenCalledTimes(1);
    const detail = (eventSpy.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toMatchObject({ action: 'expand', nodeId: n1, mindmapId: 'mm_ctx_1' });

    await waitFor(() => {
      expect(selectionToChatMock).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining('微积分基本定理'),
        source: expect.objectContaining({ kind: 'mindmap', sourceId: 'mm_ctx_1', locator: `node:${n1}` }),
      }));
    });
    window.removeEventListener('mindmap:ai-action', eventSpy);
  });

  it('supports quote to chat, handout export, and W08 inline hyperlink editor with safe URL validation', async () => {
    exportHandoutMock.mockResolvedValueOnce({ noteId: 'note_ctx_1', noteTitle: '微积分讲义' });
    const { store, n1 } = setupMenu();

    // 引用到聊天
    fireEvent.click(screen.getByRole('menuitem', { name: '引用到 AI 对话' }));
    await waitFor(() => {
      expect(selectionToChatMock).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining('微积分基本定理'),
      }));
    });

    // 导出讲义
    fireEvent.click(screen.getByRole('menuitem', { name: '导出讲义笔记' }));
    await waitFor(() => {
      expect(exportHandoutMock).toHaveBeenCalledTimes(1);
      expect(notifyMock).toHaveBeenCalledWith('success', expect.stringContaining('微积分讲义'));
    });

    // 添加超链接：拦截危险协议 + 接受合法 URL + 清除
    fireEvent.click(screen.getByRole('menuitem', { name: '添加超链接' }));
    const input = screen.getByLabelText('超链接地址');
    fireEvent.change(input, { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(store.getState().document.root.children.find((c) => c.id === n1)?.href).toBeUndefined();
    expect(notifyMock).toHaveBeenCalledWith('warning', expect.stringContaining('链接'));

    fireEvent.change(input, { target: { value: 'example.com/calculus' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(store.getState().document.root.children.find((c) => c.id === n1)?.href).toBe(
      'https://example.com/calculus',
    );
  });

  it('aggregates multi-select flashcard toggle into 1 Undo step and keeps consecutive batch style updates separate (coalesceKey: null)', () => {
    const { store, n1, n2 } = setupMenu({ multiSelect: true });
    // 清空 setupMenu 初始化阶段产生的历史栈
    store.setState({ history: { past: [], future: [] } });

    // 1. 800ms 内连续执行加粗 + 改文字色：因首变更节点使用 { coalesceKey: null }，应产生 2 条独立 Undo 记录
    fireEvent.click(screen.getByTitle('contextMenu.bold'));
    fireEvent.click(screen.getByRole('button', { name: `选择颜色 ${QUICK_TEXT_COLORS[0]}` }));
    expect(store.getState().history.past).toHaveLength(2);

    // Undo 1 步仅撤销文字色，保留加粗
    store.getState().undo();
    let children = store.getState().document.root.children;
    expect(children.find((c) => c.id === n1)?.style?.textColor).toBeUndefined();
    expect(children.find((c) => c.id === n2)?.style?.textColor).toBeUndefined();
    expect(children.find((c) => c.id === n1)?.style?.fontWeight).toBe('bold');
    expect(children.find((c) => c.id === n2)?.style?.fontWeight).toBe('bold');

    // Undo 第 2 步撤销加粗
    store.getState().undo();
    children = store.getState().document.root.children;
    expect(children.find((c) => c.id === n1)?.style?.fontWeight).toBeUndefined();
    expect(children.find((c) => c.id === n2)?.style?.fontWeight).toBeUndefined();

    // 2. 多选「转为闪卡」仅产生 1 条 Undo 记录，单步撤销恢复全部节点
    store.setState({ history: { past: [], future: [] } });
    fireEvent.click(screen.getByRole('menuitem', { name: '转为闪卡' }));
    expect(store.getState().history.past).toHaveLength(1);
    expect(store.getState().document.root.children.find((c) => c.id === n1)?.isFlashcard).toBe(true);
    expect(store.getState().document.root.children.find((c) => c.id === n2)?.isFlashcard).toBe(true);

    store.getState().undo();
    expect(store.getState().document.root.children.find((c) => c.id === n1)?.isFlashcard).toBeUndefined();
    expect(store.getState().document.root.children.find((c) => c.id === n2)?.isFlashcard).toBeUndefined();
  });

  it('handles capture-phase Escape with sub-panel priority, IME safety, and no hover:scale on swatches', async () => {
    const onClose = vi.fn();
    setupMenu({ onClose });

    expect(screen.getByTestId('mm-context-menu')).toBeTruthy();

    // 色盘色块不使用 hover:scale-* / scale-110
    const firstColorBtn = screen.getByRole('button', { name: `选择颜色 ${QUICK_TEXT_COLORS[0]}` });
    expect(firstColorBtn.className).not.toContain('hover:scale-');
    expect(firstColorBtn.className).not.toContain('scale-110');

    // 打开内联超链接面板后：IME 合成中按 Escape 不关闭任何面板
    fireEvent.click(screen.getByRole('menuitem', { name: '添加超链接' }));
    const hrefInput = screen.getByLabelText('超链接地址');
    fireEvent.compositionStart(hrefInput);
    fireEvent.keyDown(hrefInput, { key: 'Escape', isComposing: true, keyCode: 229, bubbles: true });
    expect(screen.getByLabelText('超链接地址')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    // IME 合成结束并完成一帧复位后，按 Escape 优先收起超链接面板且阻止传播，不直接关闭主菜单
    fireEvent.compositionEnd(hrefInput);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const escInner = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(escInner);
    expect(escInner.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(screen.queryByLabelText('超链接地址')).toBeNull();
    });
    expect(onClose).not.toHaveBeenCalled();

    // 再次按 Escape：capture 阶段消费并关闭右键菜单
    const escMenu = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(escMenu);
    expect(escMenu.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

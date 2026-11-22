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
    t: (key: string, opts?: { defaultValue?: string; title?: string; error?: string; color?: string }) => {
      const base = opts?.defaultValue ?? key;
      return base
        .replace('{{title}}', opts?.title ?? '')
        .replace('{{error}}', opts?.error ?? '')
        .replace('{{color}}', opts?.color ?? '');
    },
  }),
}));

import { createMindMapStore, MindMapStoreContext } from '../../../store';
import { MindMapActiveContext } from '../../../MindMapActiveContext';
import { QUICK_BG_COLORS_DARK, QUICK_TEXT_COLORS_DARK } from '../../../constants';
import { MobileNodeToolbar, type MobileToolbarPanel } from '../MobileNodeToolbar';

describe('MobileNodeToolbar learning loop actions', () => {
  beforeEach(() => {
    selectionToChatMock.mockReset();
    exportHandoutMock.mockReset();
    notifyMock.mockReset();
    writeClipboardMock.mockReset().mockResolvedValue({ fingerprint: 'fp', copiedAt: 1 });
    readClipboardMock.mockReset().mockResolvedValue({ kind: 'empty', text: null });
    isDarkMock.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
  });

  function renderToolbar(panel: MobileToolbarPanel = 'more') {
    const store = createMindMapStore();
    const rootId = store.getState().document.root.id;
    store.setState({ mindmapId: 'mm_test_1' });
    const childId = store.getState().addNode(rootId)!;
    store.getState().updateNode(childId, { text: '虚拟语气条件句' });
    const onPanelChange = vi.fn();

    const view = render(
      <MindMapStoreContext.Provider value={store}>
        <MindMapActiveContext.Provider value={true}>
          <MobileNodeToolbar
            nodeId={childId}
            panel={panel}
            onPanelChange={onPanelChange}
            onClose={vi.fn()}
          />
        </MindMapActiveContext.Provider>
      </MindMapStoreContext.Provider>,
    );

    return { store, childId, onPanelChange, ...view };
  }

  it('toggles FSRS flashcard state on the selected node', () => {
    const { store, childId } = renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '转为闪卡' }));
    const child = store.getState().document.root.children.find((n) => n.id === childId);
    expect(child?.isFlashcard).toBe(true);

    // 再点取消闪卡
    fireEvent.click(screen.getByRole('button', { name: '取消闪卡' }));
    const updated = store.getState().document.root.children.find((n) => n.id === childId);
    expect(Boolean(updated?.isFlashcard)).toBe(false);
  });

  it('quotes the selected node to AI chat via selectionToChat', async () => {
    const { childId } = renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '引用到 AI 对话' }));

    await waitFor(() => {
      expect(selectionToChatMock).toHaveBeenCalledWith({
        text: expect.stringContaining('虚拟语气条件句'),
        source: expect.objectContaining({
          kind: 'mindmap',
          sourceId: 'mm_test_1',
          locator: `node:${childId}`,
        }),
      });
    });
  });

  it('exports the selected node as a handout note and notifies on success', async () => {
    exportHandoutMock.mockResolvedValueOnce({ noteId: 'note_h1', noteTitle: '导图讲义' });
    renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: '导出讲义笔记' }));

    await waitFor(() => {
      expect(exportHandoutMock).toHaveBeenCalledWith(expect.objectContaining({
        mindmapId: 'mm_test_1',
        nodes: [expect.objectContaining({ text: '虚拟语气条件句' })],
      }));
      expect(notifyMock).toHaveBeenCalledWith('success', expect.stringContaining('导图讲义'));
    });
  });

  it('uses dark-mode adaptive color palette in style panel', () => {
    isDarkMock.mockReturnValue(true);
    renderToolbar('style');

    expect(screen.getByRole('button', { name: `选择颜色 ${QUICK_TEXT_COLORS_DARK[0]}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `选择颜色 ${QUICK_BG_COLORS_DARK[0]}` })).toBeTruthy();
  });

  it('copies to system clipboard and pastes external Markdown list as child subtree on touch devices', async () => {
    readClipboardMock.mockResolvedValueOnce({
      kind: 'markdown',
      markdown: '- 触屏粘贴父项\n  - 触屏粘贴子项',
      text: '- 触屏粘贴父项\n  - 触屏粘贴子项',
    });
    const { store, childId } = renderToolbar('more');

    fireEvent.click(screen.getByRole('button', { name: 'contextMenu.copy' }));
    expect(writeClipboardMock).toHaveBeenCalledWith([
      expect.objectContaining({ id: childId, text: '虚拟语气条件句' }),
    ]);

    // 即使内部 clipboard 清空，粘贴按钮仍可用并从系统剪贴板解析 Markdown 子树
    store.setState({ clipboard: null });
    fireEvent.click(screen.getByRole('button', { name: 'contextMenu.pasteAsChild' }));

    await waitFor(() => {
      const target = store.getState().document.root.children.find((n) => n.id === childId)!;
      expect(target.children).toHaveLength(1);
      expect(target.children[0].text).toBe('触屏粘贴父项');
      expect(target.children[0].children[0].text).toBe('触屏粘贴子项');
    });
  });
});

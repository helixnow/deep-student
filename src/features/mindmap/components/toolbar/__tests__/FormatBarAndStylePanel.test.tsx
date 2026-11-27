import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { selectionToChatMock, openQuickAssistantMock, exportHandoutMock, notifyMock } = vi.hoisted(
  () => ({
    selectionToChatMock: vi.fn(async () => ({ success: true })),
    openQuickAssistantMock: vi.fn(async () => true),
    exportHandoutMock: vi.fn(async () => ({ noteTitle: '测试讲义' })),
    notifyMock: vi.fn(),
  }),
);

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: notifyMock,
}));

vi.mock('@/features/chat/context/selectionRef', () => ({
  selectionToChat: selectionToChatMock,
}));

vi.mock('@/quick-assistant/window', () => ({
  openQuickAssistantWindow: openQuickAssistantMock,
}));

vi.mock('../../../interop/handoutExport', () => ({
  exportMindMapSelectionToHandoutNote: exportHandoutMock,
}));

vi.mock('react-i18next', async () => {
  const zhMm = (await import('@/locales/zh-CN/mindmap.json')).default as Record<string, unknown>;
  function lookup(root: Record<string, unknown> | undefined, pathStr: string): string | undefined {
    if (!root) return undefined;
    let cur: unknown = root;
    for (const part of pathStr.split('.')) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return typeof cur === 'string' ? cur : undefined;
  }
  const interpolate = (tpl: string, opts?: Record<string, unknown>) =>
    opts
      ? tpl.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (m, k: string) =>
          opts[k] === undefined ? m : String(opts[k]),
        )
      : tpl;
  const t = (key: string, opts?: Record<string, unknown>) => {
    const bare = key.includes(':') ? key.split(':', 2)[1] : key;
    const found = lookup(zhMm, bare);
    if (found) return interpolate(found, opts);
    return interpolate(typeof opts?.defaultValue === 'string' ? opts.defaultValue : key, opts);
  };
  return {
    useTranslation: () => ({ t }),
    initReactI18next: { type: '3rdParty', init: () => {} },
  };
});

import { useMindMapStore } from '../../../store/mindmapStore';
import type { MindMapDocument } from '../../../types';
import { findNodeById } from '../../../utils/node/find';
import { MindMapFormatBar } from '../FormatBar';
import { StyleSettings } from '../StylePanel';
import { StructureSelector } from '../../mindmap/StructureSelector';
import { MindMapStagingTray } from '../../mindmap/MindMapStagingTray';
import { OutlineNodeMenu } from '../../../views/outline/OutlineNodeMenu';
import { QUICK_TEXT_COLORS_DARK } from '../../../constants/colors';

function createSampleDoc(): MindMapDocument {
  return {
    version: '1.0',
    root: {
      id: 'root',
      text: '数据结构与算法',
      children: [
        {
          id: 'l1_a',
          text: '树与图',
          children: [
            { id: 'l2_a1', text: '红黑树', children: [] },
            { id: 'l2_a2', text: 'B+ 树', children: [] },
          ],
        },
        {
          id: 'l1_b',
          text: '动态规划',
          children: [],
        },
      ],
    },
    meta: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

beforeEach(() => {
  selectionToChatMock.mockClear();
  openQuickAssistantMock.mockClear();
  exportHandoutMock.mockClear();
  notifyMock.mockClear();
  document.documentElement.classList.remove('dark');
  useMindMapStore.getState().reset();
  useMindMapStore.setState({
    mindmapId: 'mm_toolbar_test',
    metadata: { id: 'mm_toolbar_test', title: '算法导图' } as never,
    document: JSON.parse(JSON.stringify(createSampleDoc())) as MindMapDocument,
    focusedNodeId: 'l2_a1',
    selection: ['l2_a1', 'l2_a2'],
    styleId: 'default',
    stagingTrayOpen: true,
    reciteMode: false,
  });
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  useMindMapStore.getState().reset();
});

describe('MindMapFormatBar upgrades', () => {
  it('aggregates batch style and batch flashcard toggles into a single Undo step', () => {
    render(<MindMapFormatBar />);

    const boldBtn = screen.getByRole('button', { name: '加粗' });
    fireEvent.click(boldBtn);

    let root = useMindMapStore.getState().document.root;
    expect(findNodeById(root, 'l2_a1')?.style?.fontWeight).toBe('bold');
    expect(findNodeById(root, 'l2_a2')?.style?.fontWeight).toBe('bold');
    expect(useMindMapStore.getState().history.past).toHaveLength(1);

    // Single undo restores BOTH nodes
    act(() => {
      useMindMapStore.getState().undo();
    });
    root = useMindMapStore.getState().document.root;
    expect(findNodeById(root, 'l2_a1')?.style?.fontWeight).toBeUndefined();
    expect(findNodeById(root, 'l2_a2')?.style?.fontWeight).toBeUndefined();

    // Batch flashcard toggle -> single undo step
    fireEvent.click(screen.getByTestId('mm-format-flashcard-toggle'));
    root = useMindMapStore.getState().document.root;
    expect(findNodeById(root, 'l2_a1')?.isFlashcard).toBe(true);
    expect(findNodeById(root, 'l2_a2')?.isFlashcard).toBe(true);
    expect(useMindMapStore.getState().history.past).toHaveLength(1);

    act(() => {
      useMindMapStore.getState().undo();
    });
    root = useMindMapStore.getState().document.root;
    expect(findNodeById(root, 'l2_a1')?.isFlashcard).toBeUndefined();
    expect(findNodeById(root, 'l2_a2')?.isFlashcard).toBeUndefined();
  });

  it('exposes compact color popovers, W08 attributes, checkbox toggle, and AI expand/summarize', async () => {
    render(<MindMapFormatBar />);

    // Compact color palette trigger exists instead of 16 flat swatches
    expect(screen.getByTestId('mm-format-text-color-trigger')).toBeTruthy();
    expect(screen.getByTestId('mm-format-bg-color-trigger')).toBeTruthy();

    // Toggle todo checkbox across multi-selection
    fireEvent.click(screen.getByTestId('mm-format-checkbox-toggle'));
    expect(findNodeById(useMindMapStore.getState().document.root, 'l2_a1')?.style?.showCheckbox).toBe(true);
    expect(findNodeById(useMindMapStore.getState().document.root, 'l2_a2')?.style?.showCheckbox).toBe(true);

    // Open W08 attributes popover -> set Priority P2 + Progress 50% + Hyperlink
    fireEvent.click(screen.getByTestId('mm-format-w08-trigger'));
    fireEvent.click(screen.getByTestId('mm-format-priority-2'));
    fireEvent.click(screen.getByTestId('mm-format-progress-50'));
    fireEvent.change(screen.getByTestId('mm-format-href-input'), {
      target: { value: 'https://example.com/rb-tree' },
    });
    fireEvent.click(screen.getByTestId('mm-format-href-apply'));

    const n1 = findNodeById(useMindMapStore.getState().document.root, 'l2_a1');
    const n2 = findNodeById(useMindMapStore.getState().document.root, 'l2_a2');
    expect(n1?.priority).toBe(2);
    expect(n2?.priority).toBe(2);
    expect(n1?.progress).toBe(50);
    expect(n2?.href).toBe('https://example.com/rb-tree');

    // AI expand triggers selectionToChat with expand instruction
    fireEvent.click(screen.getByTestId('mm-format-ai-trigger'));
    fireEvent.click(screen.getByTestId('mm-format-ai-expand'));

    await waitFor(() => {
      expect(selectionToChatMock).toHaveBeenCalledTimes(1);
    });
    expect(selectionToChatMock.mock.calls[0][0].text).toContain('扩写');
  });

  it('attaches mindmap-container class to all 3 FormatBar portal popovers and avoids scale hover on color swatches', () => {
    render(<MindMapFormatBar />);

    // 1. 文字色盘 Portal 含 mindmap-container，色块无 hover:scale-*
    fireEvent.click(screen.getByTestId('mm-format-text-color-trigger'));
    const colorDialog = document.body.querySelector('[role="dialog"].mm-format-popover');
    expect(colorDialog).not.toBeNull();
    expect(colorDialog?.className).toContain('mindmap-container');
    const swatchBtns = Array.from(colorDialog?.querySelectorAll('button') ?? []);
    expect(swatchBtns.length).toBeGreaterThan(0);
    for (const btn of swatchBtns) {
      expect(btn.className).not.toContain('hover:scale-');
      expect(btn.className).not.toContain('scale-110');
    }
    fireEvent.click(screen.getByTestId('mm-format-text-color-trigger'));

    // 2. W08 属性 Portal 含 mindmap-container
    fireEvent.click(screen.getByTestId('mm-format-w08-trigger'));
    const w08Input = screen.getByTestId('mm-format-href-input');
    const w08Dialog = w08Input.closest('[role="dialog"]');
    expect(w08Dialog?.className).toContain('mindmap-container');
    fireEvent.click(screen.getByTestId('mm-format-w08-trigger'));

    // 3. AI 扩写/总结 Portal 含 mindmap-container
    fireEvent.click(screen.getByTestId('mm-format-ai-trigger'));
    const aiExpandBtn = screen.getByTestId('mm-format-ai-expand');
    const aiDialog = aiExpandBtn.closest('[role="dialog"]');
    expect(aiDialog?.className).toContain('mindmap-container');

    // 引用按钮文案统一使用 toolbar.quoteToChat
    expect(screen.getByRole('button', { name: /引用到/ })).toBeTruthy();
  });

  it('applies uniform target state across mixed multi-selection for B/I/U/S, H1-H3, and checkbox', () => {
    // l2_a1 开启加粗/H1/待办勾选框；l2_a2 均未开启 -> 混合态
    act(() => {
      useMindMapStore.getState().updateNode('l2_a1', {
        style: { fontWeight: 'bold', headingLevel: 'h1', showCheckbox: true },
      });
    });

    render(<MindMapFormatBar />);

    // primaryNode (l2_a1) active === true -> 点击加粗应统一取消两者加粗（而非各自取反）
    fireEvent.click(screen.getByRole('button', { name: '加粗' }));
    let root = useMindMapStore.getState().document.root;
    expect(findNodeById(root, 'l2_a1')?.style?.fontWeight).toBeUndefined();
    expect(findNodeById(root, 'l2_a2')?.style?.fontWeight).toBeUndefined();

    // H1 混合态 -> 点击 H1 统一取消两者 H1
    fireEvent.click(screen.getByRole('button', { name: '标题 1' }));
    root = useMindMapStore.getState().document.root;
    expect(findNodeById(root, 'l2_a1')?.style?.headingLevel).toBeUndefined();
    expect(findNodeById(root, 'l2_a2')?.style?.headingLevel).toBeUndefined();

    // 待办勾选框混合态 -> 点击统一关闭两者
    fireEvent.click(screen.getByTestId('mm-format-checkbox-toggle'));
    root = useMindMapStore.getState().document.root;
    expect(findNodeById(root, 'l2_a1')?.style?.showCheckbox).toBeUndefined();
    expect(findNodeById(root, 'l2_a2')?.style?.showCheckbox).toBeUndefined();
  });

  it('pins mm-format-ai-trigger outside the horizontal overflow-x-auto scroll group so it never clips (W8B-03)', () => {
    render(<MindMapFormatBar />);
    const scrollGroup = screen.getByTestId('mm-format-scroll-group');
    const pinnedGroup = screen.getByTestId('mm-format-ai-pinned');
    const aiTrigger = screen.getByTestId('mm-format-ai-trigger');

    expect(scrollGroup.className).toContain('overflow-x-auto');
    expect(pinnedGroup.className).toContain('shrink-0');
    expect(pinnedGroup.contains(aiTrigger)).toBe(true);
    expect(scrollGroup.contains(aiTrigger)).toBe(false);
  });

  it('uses unified Tooltip bubbles instead of native HTML title attributes on FormatBar buttons', () => {
    const { container } = render(<MindMapFormatBar />);
    const titledButtons = container.querySelectorAll('button[title]');
    expect(titledButtons).toHaveLength(0);
  });

  it('provides high-distinction, AAA-contrast dark and light highlight palettes', async () => {
    const { QUICK_BG_COLORS, QUICK_BG_COLORS_DARK } = await import('../../../constants/colors');

    const hexToRgb = (hex: string) => [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ] as const;

    const luminance = ([r, g, b]: readonly [number, number, number]) => {
      const toLin = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
    };

    const contrastRatio = (hex1: string, hex2: string) => {
      const l1 = luminance(hexToRgb(hex1));
      const l2 = luminance(hexToRgb(hex2));
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    const saturation = ([r, g, b]: readonly [number, number, number]) => {
      const rn = r / 255;
      const gn = g / 255;
      const bn = b / 255;
      const max = Math.max(rn, gn, bn);
      const min = Math.min(rn, gn, bn);
      if (max === min) return 0;
      const l = (max + min) / 2;
      return (max - min) / (l > 0.5 ? 2 - max - min : max + min);
    };

    expect(QUICK_BG_COLORS_DARK).toHaveLength(7);
    for (const hex of QUICK_BG_COLORS_DARK) {
      // Dark highlights must stay clearly chromatic (not muddy charcoal) and >= 7:1 vs dark-mode ink
      expect(saturation(hexToRgb(hex))).toBeGreaterThanOrEqual(0.35);
      expect(contrastRatio(hex, '#eef2f0')).toBeGreaterThanOrEqual(7);
    }

    expect(QUICK_BG_COLORS).toHaveLength(7);
    for (const hex of QUICK_BG_COLORS) {
      expect(saturation(hexToRgb(hex))).toBeGreaterThanOrEqual(0.4);
      expect(contrastRatio(hex, '#182220')).toBeGreaterThanOrEqual(10);
    }
  });
});

describe('StyleSettings upgrades', () => {
  it('shows level-accurate default fontSize (Root 18 / L1 15 / L2+ 14) and batch-updates selection', () => {
    const { rerender } = render(<StyleSettings placement="inline" />);

    // L2 node default = 14
    const input = screen.getByLabelText('字号') as HTMLInputElement;
    expect(input.value).toBe('14');

    // Switch focus to Root -> 18
    act(() => {
      useMindMapStore.setState({ focusedNodeId: 'root', selection: [] });
    });
    rerender(<StyleSettings placement="inline" />);
    expect((screen.getByLabelText('字号') as HTMLInputElement).value).toBe('18');

    // Switch focus to L1 -> 15
    act(() => {
      useMindMapStore.setState({ focusedNodeId: 'l1_a', selection: [] });
    });
    rerender(<StyleSettings placement="inline" />);
    expect((screen.getByLabelText('字号') as HTMLInputElement).value).toBe('15');

    // Multi-select batch style update in 1 undo step
    act(() => {
      useMindMapStore.setState({ focusedNodeId: 'l2_a1', selection: ['l2_a1', 'l2_a2'] });
    });
    rerender(<StyleSettings placement="inline" />);
    fireEvent.click(screen.getByRole('button', { name: '加粗' }));
    expect(findNodeById(useMindMapStore.getState().document.root, 'l2_a1')?.style?.fontWeight).toBe('bold');
    expect(findNodeById(useMindMapStore.getState().document.root, 'l2_a2')?.style?.fontWeight).toBe('bold');
    expect(useMindMapStore.getState().history.past).toHaveLength(1);
  });

  it('renders real dark theme thumbnails under html.dark and exposes W08 attributes without hardcoded checkerboard SVG', () => {
    document.documentElement.classList.add('dark');
    const { container } = render(<StyleSettings placement="inline" />);

    const darkPreview = container.querySelector('[data-preview-theme-id="default-dark"]');
    expect(darkPreview).not.toBeNull();

    // Transparent swatch uses semantic CSS class instead of inline data:image/svg+xml
    const transparentSwatch = container.querySelector('.mm-style-swatch-transparent');
    expect(transparentSwatch).not.toBeNull();
    expect(transparentSwatch?.className).not.toContain('data:image/svg+xml');

    // W08 section updates priority and showCheckbox
    fireEvent.click(screen.getByTestId('mm-style-priority-1'));
    const checkboxToggle = screen.getByTestId('mm-style-checkbox-toggle');
    expect(checkboxToggle.textContent).toContain('关闭');
    fireEvent.click(checkboxToggle);
    expect(checkboxToggle.textContent).toContain('已开启');
    const node = findNodeById(useMindMapStore.getState().document.root, 'l2_a1');
    expect(node?.priority).toBe(1);
    expect(node?.style?.showCheckbox).toBe(true);
  });

  it('portals desktop StyleSettings & StructureSelector to document.body with mindmap-container and handles capture Escape', () => {
    const onStyleOpenChange = vi.fn();
    const onStructureOpenChange = vi.fn();
    const { container } = render(
      <div className="mm-toolbar" style={{ overflowX: 'auto' }}>
        <StyleSettings open={true} onOpenChange={onStyleOpenChange} />
        <StructureSelector open={true} onOpenChange={onStructureOpenChange} />
      </div>,
    );

    const stylePopover = screen.getByTestId('mm-style-popover');
    const structurePopover = screen.getByTestId('mm-structure-popover');
    expect(container.contains(stylePopover)).toBe(false);
    expect(container.contains(structurePopover)).toBe(false);
    expect(document.body.contains(stylePopover)).toBe(true);
    expect(document.body.contains(structurePopover)).toBe(true);
    expect(stylePopover.className).toContain('mindmap-container');
    expect(stylePopover.className).toContain('fixed');
    expect(structurePopover.className).toContain('mindmap-container');
    expect(structurePopover.className).toContain('fixed');

    // Capture-phase Escape 阻止传播并关闭面板（冒泡监听器收不到）
    const bubbleSpy = vi.fn();
    document.body.addEventListener('keydown', bubbleSpy);
    const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(escEvent);
    document.body.removeEventListener('keydown', bubbleSpy);

    expect(escEvent.defaultPrevented).toBe(true);
    expect(bubbleSpy).not.toHaveBeenCalled();
    expect(onStyleOpenChange).toHaveBeenCalledWith(false);
    expect(onStructureOpenChange).not.toHaveBeenCalled();
  });
});

describe('MindMapStagingTray & OutlineNodeMenu upgrades', () => {
  it('uses mobile-friendly responsive width and safe-area bottom padding on MindMapStagingTray', () => {
    useMindMapStore.setState((state) => ({
      document: {
        ...state.document,
        stagingExcerpts: [
          {
            id: 'stg-1',
            title: '红黑树性质',
            text: '根节点为黑色',
            anchor: { kind: 'pdf', resourceId: 'pdf-1', page: 3 },
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    }));
    render(<MindMapStagingTray />);
    const tray = screen.getByTestId('mm-staging-tray');
    expect(tray.className).toContain('max-w-[min(360px,calc(100vw-24px))]');
    expect(tray.className).not.toContain('max-w-[42vw]');
    expect(tray.innerHTML).toContain('--mobile-safe-area-bottom');
  });

  it('OutlineNodeMenu uses dark-adaptive colors and exposes learning + AI actions', async () => {
    document.documentElement.classList.add('dark');
    const node = findNodeById(useMindMapStore.getState().document.root, 'l1_a')!;
    render(
      <OutlineNodeMenu
        node={node}
        isRoot={false}
        parentId="root"
        indexInParent={0}
        keymap="deep-student"
        onEditNote={vi.fn()}
        onOpenResourcePicker={vi.fn()}
      />,
    );

    const trigger = document.querySelector('button.action-btn') as HTMLButtonElement;
    fireEvent.click(trigger);

    // Learning & AI entries present
    expect(screen.getByTestId('outline-menu-flashcard')).toBeTruthy();
    expect(screen.getByTestId('outline-menu-blank-branch')).toBeTruthy();
    expect(screen.getByTestId('outline-menu-export-handout')).toBeTruthy();
    expect(screen.getByTestId('outline-menu-quote-chat')).toBeTruthy();
    expect(screen.getByTestId('outline-menu-ai-expand')).toBeTruthy();
    expect(screen.getByTestId('outline-menu-ai-summarize')).toBeTruthy();

    // Dark-adaptive quick text color palette rendered (no hover:scale-*)
    const firstDarkColorBtn = screen.getByRole('button', {
      name: `选择颜色 ${QUICK_TEXT_COLORS_DARK[0]}`,
    });
    expect(firstDarkColorBtn).toBeTruthy();
    expect(firstDarkColorBtn.className).not.toContain('hover:scale-');
    expect(firstDarkColorBtn.className).not.toContain('scale-110');

    // Trigger flashcard projection
    fireEvent.click(screen.getByTestId('outline-menu-flashcard'));
    expect(findNodeById(useMindMapStore.getState().document.root, 'l1_a')?.isFlashcard).toBe(true);
  });
});

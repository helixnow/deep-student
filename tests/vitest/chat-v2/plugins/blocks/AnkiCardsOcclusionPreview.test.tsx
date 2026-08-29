/**
 * anki_cards Image Occlusion 预览接线测试。
 *
 * 覆盖 extra_fields._occlusion 的成功、缺失、损坏、VFS/本地图片解析，
 * 以及遮挡揭开交互不误触块展开。
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Block } from '@/features/chat/core/types';
import type { AnkiCard } from '@/types';
import type { AnkiCardsBlockData } from '@/features/chat/plugins/blocks/ankiCardsBlock';

const { mockConvertFileSrc, mockInvoke } = vi.hoisted(() => ({
  mockConvertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
  mockInvoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
}));

// Mock i18n：occlusion 词条与 zh-CN anki.json 保持一致，支持 {{var}} 插值；
// 未知 key 回退 defaultValue 或 key 本身。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        'blocks.ankiCards.edit': 'Edit',
        'blocks.ankiCards.addToLibrary': 'Add to card library',
        'blocks.ankiCards.reviewBatch': 'Review batch',
        'blocks.ankiCards.moreActions': 'More card actions',
        'agent.occlusion.imageAlt': '图像遮挡卡片',
        'agent.occlusion.revealBox': '揭开遮挡区域 {{index}}',
      };
      const template = dict[key];
      if (!template) return (options?.defaultValue as string) || key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(options?.[name] ?? ''),
      );
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@/features/chat/anki', () => ({
  saveCardsToLibrary: vi.fn(async () => undefined),
  exportCardsAsApkg: vi.fn(async () => undefined),
  importCardsViaAnkiConnect: vi.fn(async () => undefined),
  logChatAnkiEvent: vi.fn(),
  AnkiCardStackPreview: ({ cards, onClick }: {
    cards: AnkiCard[];
    onClick?: () => void;
  }) => (
    <button
      type="button"
      data-testid="anki-preview"
      data-count={cards.length}
      onClick={onClick}
    >
      preview
    </button>
  ),
  FullWidthCardWrapper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: mockConvertFileSrc,
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@/features/workbench/core/workbenchBus', () => ({
  workbenchBus: {
    activate: vi.fn(async () => ({ delivered: true, result: { handled: true } })),
    launch: vi.fn(),
  },
}));

import { AnkiCardsBlock } from '@/features/chat/plugins/blocks/ankiCardsBlock';
import { resetAnkiBlockUiState } from '@/features/chat/plugins/blocks/components/ankiCardsBlockState';

const DIRECT_IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

function occlusionJson(
  imageRef = DIRECT_IMAGE,
  boxes: Array<Record<string, unknown>> = [
    { x: 0.1, y: 0.2, w: 0.3, h: 0.25, label: '左心房', clozeIndex: 1 },
  ],
): string {
  return JSON.stringify({ imageRef, boxes });
}

function card(id: string, occlusion?: unknown): AnkiCard {
  return {
    id,
    front: `Q-${id}`,
    back: `A-${id}`,
    tags: [],
    images: [],
    ...(occlusion === undefined
      ? {}
      : { extra_fields: { _occlusion: occlusion } as Record<string, string> }),
  };
}

function renderBlock(cards: AnkiCard[]) {
  const block: Block = {
    id: 'anki-occlusion-block',
    type: 'anki_cards',
    status: 'success',
    messageId: 'message-1',
  };
  const data: AnkiCardsBlockData = {
    cards,
    syncStatus: 'pending',
    businessSessionId: 'session-1',
    messageStableId: 'stable-1',
  };
  return render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);
}

describe('AnkiCardsBlock Image Occlusion preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    resetAnkiBlockUiState();
  });

  it('renders the image and masks from a valid extra_fields._occlusion spec', () => {
    renderBlock([
      card('occluded', occlusionJson(DIRECT_IMAGE, [
        { x: 0.1, y: 0.2, w: 0.3, h: 0.25, label: '左心房', clozeIndex: 1 },
        { x: 0.55, y: 0.4, w: 0.2, h: 0.2, label: '右心室', clozeIndex: 2 },
      ])),
    ]);

    expect(screen.getByTestId('anki-occlusion-preview-gallery')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '图像遮挡卡片' })).toHaveAttribute('src', DIRECT_IMAGE);
    expect(screen.getAllByTestId('occlusion-box-masked')).toHaveLength(2);
    expect(screen.getAllByTestId('occlusion-box-masked')[0]).toHaveStyle({
      left: '10%',
      top: '20%',
    });
  });

  it('renders one overlay for every valid occlusion card in a mixed preview', () => {
    renderBlock([
      card('one', occlusionJson()),
      card('plain'),
      card('two', occlusionJson('https://example.test/two.png')),
    ]);

    expect(screen.getAllByTestId('anki-occlusion-card-preview')).toHaveLength(2);
    expect(screen.getAllByTestId('image-occlusion-overlay')).toHaveLength(2);
    expect(screen.getByTestId('anki-preview')).toHaveAttribute('data-count', '3');
  });

  it('does not add any occlusion DOM for cards without _occlusion', () => {
    renderBlock([card('plain')]);

    expect(screen.queryByTestId('anki-occlusion-preview-gallery')).not.toBeInTheDocument();
    expect(screen.queryByTestId('image-occlusion-overlay')).not.toBeInTheDocument();
    expect(screen.getByTestId('anki-preview')).toBeInTheDocument();
  });

  it('ignores malformed _occlusion JSON without crashing the ordinary preview', () => {
    expect(() => renderBlock([card('bad-json', '{"imageRef":')])).not.toThrow();

    expect(screen.queryByTestId('image-occlusion-overlay')).not.toBeInTheDocument();
    expect(screen.getByTestId('anki-preview')).toBeInTheDocument();
  });

  it('ignores structurally invalid _occlusion JSON without rendering masks', () => {
    renderBlock([card('bad-shape', JSON.stringify({
      imageRef: DIRECT_IMAGE,
      boxes: 'not-an-array',
    }))]);

    expect(screen.queryByTestId('anki-occlusion-card-preview')).not.toBeInTheDocument();
    expect(screen.queryByTestId('occlusion-box-masked')).not.toBeInTheDocument();
    expect(screen.getByTestId('anki-preview')).toBeInTheDocument();
  });

  it('filters bad boxes while keeping valid masks in the same spec', () => {
    renderBlock([card('mixed-boxes', occlusionJson(DIRECT_IMAGE, [
      { x: Number.NaN, y: 0, w: 0.2, h: 0.2, label: 'not-finite', clozeIndex: 1 },
      { x: 0.9, y: 0.9, w: 0.2, h: 0.2, label: 'overflow', clozeIndex: 2 },
      { x: 0.2, y: 0.2, w: 0.2, h: 0.2, label: 'valid', clozeIndex: 3 },
    ]))]);

    expect(screen.getAllByTestId('occlusion-box-masked')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '揭开遮挡区域 3' })).toBeInTheDocument();
  });

  it('resolves a VFS image source to a safe data URL', async () => {
    mockInvoke.mockImplementation(async (command: unknown) => {
      if (command === 'vfs_resolve_resource_refs') {
        return [{
          found: true,
          content: 'iVBORw0KGgo=',
          metadata: { mimeType: 'image/png' },
        }];
      }
      return undefined;
    });

    renderBlock([card('vfs', occlusionJson('att_image-123'))]);

    expect(screen.getByTestId('image-occlusion-overlay')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('img', { name: '图像遮挡卡片' })).toHaveAttribute(
        'src',
        'data:image/png;base64,iVBORw0KGgo=',
      );
    });
    expect(mockInvoke).toHaveBeenCalledWith('vfs_resolve_resource_refs', {
      refs: [expect.objectContaining({
        sourceId: 'att_image-123',
        type: 'image',
        injectModes: { image: ['image'] },
      })],
    });
  });

  it('keeps the overlay mounted over a fallback when VFS image resolution fails', async () => {
    mockInvoke.mockRejectedValue(new Error('missing image'));
    renderBlock([card('missing-vfs', occlusionJson('vfs://att_missing'))]);

    expect(screen.getByTestId('image-occlusion-overlay')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('anki-occlusion-image-placeholder')).toHaveAttribute(
        'data-state',
        'unavailable',
      );
    });
    expect(screen.getByTestId('anki-preview')).toBeInTheDocument();
  });

  it('reveals a mask without bubbling into the block expand action', () => {
    renderBlock([card('reveal', occlusionJson())]);

    fireEvent.click(screen.getByRole('button', { name: '揭开遮挡区域 1' }));

    expect(screen.getByText('左心房')).toBeInTheDocument();
    expect(screen.getByTestId('occlusion-box-revealed')).toBeInTheDocument();
    expect(screen.getByTestId('anki-preview')).toBeInTheDocument();
  });

  it('reveals every mask in the selected cloze group', () => {
    renderBlock([card('grouped', occlusionJson(DIRECT_IMAGE, [
      { x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: 'group-a', clozeIndex: 1 },
      { x: 0.4, y: 0.1, w: 0.2, h: 0.2, label: 'other', clozeIndex: 2 },
      { x: 0.1, y: 0.5, w: 0.2, h: 0.2, label: 'group-b', clozeIndex: 1 },
    ]))]);

    fireEvent.click(screen.getAllByRole('button', { name: '揭开遮挡区域 1' })[1]);

    expect(screen.getByText('group-a')).toBeInTheDocument();
    expect(screen.getByText('group-b')).toBeInTheDocument();
    expect(screen.getAllByTestId('occlusion-box-revealed')).toHaveLength(2);
    expect(screen.getAllByTestId('occlusion-box-masked')).toHaveLength(1);
  });

  it('reveals a group with Enter without expanding the collapsed block', () => {
    renderBlock([card('keyboard', occlusionJson())]);

    fireEvent.keyDown(screen.getByRole('button', { name: '揭开遮挡区域 1' }), { key: 'Enter' });

    expect(screen.getByText('左心房')).toBeInTheDocument();
    expect(screen.getByTestId('anki-occlusion-preview-gallery')).toBeInTheDocument();
    expect(screen.getByTestId('anki-preview')).toBeInTheDocument();
  });

  it('converts local image paths through the Tauri asset protocol', () => {
    renderBlock([card('local', occlusionJson('/tmp/diagram.png'))]);

    expect(mockConvertFileSrc).toHaveBeenCalledWith('/tmp/diagram.png');
    expect(screen.getByRole('img', { name: '图像遮挡卡片' })).toHaveAttribute(
      'src',
      'asset://localhost//tmp/diagram.png',
    );
    expect(screen.getByTestId('image-occlusion-overlay')).toBeInTheDocument();
  });

  it('keeps the occlusion preview when the anki_cards block expands inline', () => {
    renderBlock([card('expanded', occlusionJson())]);

    fireEvent.click(screen.getByTestId('anki-preview'));

    expect(screen.queryByTestId('anki-occlusion-preview-gallery')).not.toBeInTheDocument();
    expect(screen.getByTestId('anki-occlusion-card-preview')).toBeInTheDocument();
    expect(screen.getByTestId('image-occlusion-overlay')).toBeInTheDocument();
    expect(screen.getByText('Q-expanded')).toBeInTheDocument();
  });

  it('reveals with Space inside an expanded card without entering edit mode', () => {
    renderBlock([card('expanded-keyboard', occlusionJson())]);
    fireEvent.click(screen.getByTestId('anki-preview'));

    fireEvent.keyDown(screen.getByRole('button', { name: '揭开遮挡区域 1' }), { key: ' ' });

    expect(screen.getByText('左心房')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Q-expanded-keyboard')).toBeInTheDocument();
  });
});

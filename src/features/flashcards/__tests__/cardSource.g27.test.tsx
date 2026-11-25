import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnkiLibraryCard } from '@/types';
import type { MediaPlayerHandle, MediaPlayerStatus } from '@/features/learning-hub/apps/views/media/mediaPlayerHandle';
import type { TranscriptSegment } from '@/features/learning-hub/apps/views/media/mediaTranscriptApi';

const {
  invokeMock,
  generateCardsFromTextMock,
  revealMock,
  registerRevealMock,
  openMediaMock,
  rememberPendingMock,
  takePendingMock,
  transcriptState,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  generateCardsFromTextMock: vi.fn(async () => ({ ok: true, documentId: 'doc_1' })),
  revealMock: vi.fn(async () => ({ ok: true, outcome: 'opened-and-revealed', elapsedMs: 5 })),
  registerRevealMock: vi.fn(() => () => {}),
  openMediaMock: vi.fn(),
  rememberPendingMock: vi.fn(),
  takePendingMock: vi.fn<[(matches: (id: string) => boolean) => number | null]>(() => null),
  transcriptState: {
    segments: [
      { idx: 0, startMs: 0, endMs: 12_000, text: '开场导言', status: 'done' as const },
      { idx: 1, startMs: 13_000, endMs: 24_000, text: '核心定理证明', status: 'done' as const },
      { idx: 2, startMs: 25_000, endMs: 40_000, text: '例题演练', status: 'done' as const },
    ] as TranscriptSegment[],
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  convertFileSrc: (p: string, scheme: string) => `${scheme}://localhost/${encodeURIComponent(p)}`,
}));

vi.mock('@/features/anki/generateCardsFromText', () => ({
  generateCardsFromText: generateCardsFromTextMock,
}));

vi.mock('@/ui-kernel/bootstrap', () => ({
  getAppKernel: () => ({
    anchors: {
      reveal: revealMock,
      registerAnchorRevealHandler: registerRevealMock,
      queryAnchorEdgesByTarget: vi.fn(async () => []),
      subscribeAnchorEdgesChanged: vi.fn(() => () => {}),
    },
    dnd: {
      startExcerptDrag: vi.fn(),
      emitAutoExcerpt: vi.fn(),
    },
  }),
}));

vi.mock('@/features/learning-hub/apps/views/media/mediaRefEvents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/learning-hub/apps/views/media/mediaRefEvents')>();
  return {
    ...actual,
    dispatchOpenMediaRef: openMediaMock,
    rememberPendingMediaFocus: rememberPendingMock,
    takePendingMediaFocus: takePendingMock,
  };
});

vi.mock('@/hooks/useAnkiTemplateLoader', () => ({
  useAnkiTemplateLoader: () => ({ template: null }),
}));
vi.mock('@/components/anki/AnkiCardPreviewPanel', () => ({
  AnkiCardPreviewPanel: () => null,
}));
vi.mock('@/utils/lazyStyles', () => ({ ensureKatexStyles: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

let lastPlayerProps: {
  handleRef?: React.Ref<MediaPlayerHandle>;
  onStatusChange?: (s: MediaPlayerStatus) => void;
} | null = null;
const playerSeekSpy = vi.fn();
const playerPlaySpy = vi.fn();

vi.mock('@/features/learning-hub/apps/views/media/VideoPlayer', () => ({
  VideoPlayer: function MockVideoPlayer(props: {
    handleRef?: React.Ref<MediaPlayerHandle>;
    onStatusChange?: (s: MediaPlayerStatus) => void;
  }) {
    lastPlayerProps = props;
    React.useImperativeHandle(props.handleRef, () => ({
      getElement: () => null,
      seekTo: playerSeekSpy,
      play: playerPlaySpy,
      pause: vi.fn(),
    }));
    React.useEffect(() => {
      props.onStatusChange?.({ currentTime: 0, duration: 75, isPlaying: false, isReady: true, canSeek: true });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="mock-video-player" />;
  },
}));
vi.mock('@/features/learning-hub/apps/views/media/AudioPlayer', () => ({
  AudioPlayer: () => <div data-testid="mock-audio-player" />,
}));
vi.mock('@/features/learning-hub/apps/views/media/BilibiliEmbedPlayer', () => ({
  BilibiliEmbedPlayer: () => <div data-testid="mock-bilibili-embed" />,
}));
vi.mock('@/features/learning-hub/apps/views/media/useMediaTranscript', () => ({
  useMediaTranscript: () => ({
    transcript: { status: 'completed', segments: transcriptState.segments, progress: null },
    loading: false,
    error: null,
    estimate: null,
    estimating: false,
    starting: false,
    cancelling: false,
    requestEstimate: vi.fn(),
    clearEstimate: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    refresh: vi.fn(),
    importFromPath: vi.fn(),
    exportToPath: vi.fn(),
  }),
}));
vi.mock('@/features/learning-hub/apps/views/media/useMediaProgressSync', () => ({
  useMediaProgressSync: () => ({ onStatus: vi.fn(), resumedFromRef: { current: null } }),
}));
vi.mock('@/features/learning-hub/apps/views/media/useTranscriptTrack', () => ({
  useTranscriptTrack: () => ({ trackSrc: null, trackRef: { current: null }, captionsOn: false, toggleCaptions: vi.fn() }),
}));
vi.mock('@/features/media-handout', () => ({ HandoutGenerateButton: () => null }));
vi.mock('@/features/learning-hub/useReferenceToChat', () => ({
  useReferenceToChat: () => ({ referenceToChat: vi.fn() }),
}));
vi.mock('@/features/chat/context/vfsRefApi', () => ({ uploadAttachmentBlob: vi.fn() }));
vi.mock('@/features/media-studio/mediaStudioNavigation', () => ({ openMediaStudio: vi.fn() }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'library.viewSource') return '查看出处';
      if (key === 'library.playMediaSource') return `跳转到 ${String(opts?.time ?? '')}`;
      if (key === 'library.meta.source') return '出处';
      if (key === 'library.source.resource') return '学习资料';
      if (typeof opts?.defaultValue === 'string') return opts.defaultValue;
      return key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

import { buildMediaCardSourceRef, makeMediaCards } from '@/features/learning-hub/apps/views/media/mediaCards';
import { MEDIA_REF_FOCUS_EVENT } from '@/features/learning-hub/apps/views/media/mediaRefEvents';
import { MediaStudyView } from '@/features/learning-hub/apps/views/media/MediaStudyView';
import {
  MEDIA_STUDY_TRANSCRIPT_TAB,
  MediaStudyCompanionContext,
} from '@/features/learning-hub/apps/views/media/mediaStudyCompanion';
import {
  cardMediaSourceTexts,
  openCardSourceTarget,
  resolveCardMediaSource,
  resolveCardSource,
} from '../cardSource';
import { openReviewCardSource } from '../review/openReviewCardSource';
import { LibraryCardRow } from '../library/LibraryCardRow';

class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe() {
    this.cb([{ contentRect: { width: 1100 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  disconnect() {}
  unobserve() {}
}

describe('G27 mediaCards deterministic anchor attachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('attaches ds-anchor://v1/media/<id>?t=13000 while keeping kind=resource and id=resourceId for media ledger', async () => {
    const ref = buildMediaCardSourceRef({
      resourceId: 'file_lec_1',
      fileName: '微积分第1讲.mp4',
      segments: [
        { idx: 1, startMs: 13_000, endMs: 24_000, text: '核心定理证明', status: 'done' },
      ],
    });

    expect(ref.kind).toBe('resource');
    expect(ref.id).toBe('file_lec_1');
    expect(ref.title).toBe('微积分第1讲.mp4');
    expect(ref.startMs).toBe(13_000);
    expect(ref.seconds).toBe(13);
    expect(ref.locatorLabel).toBe('00:13');
    expect(ref.anchorUri).toContain('ds-anchor://v1/media/file_lec_1?t=13000');

    await makeMediaCards({
      resourceId: 'file_lec_1',
      fileName: '微积分第1讲.mp4',
      segments: [{ idx: 1, startMs: 13_000, endMs: 24_000, text: '核心定理证明', status: 'done' }],
      t: (k) => k,
    });
    expect(generateCardsFromTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRef: expect.objectContaining({
          kind: 'resource',
          id: 'file_lec_1',
          startMs: 13_000,
          seconds: 13,
          anchorUri: expect.stringContaining('ds-anchor://v1/media/file_lec_1?t=13000'),
        }),
      }),
    );
  });
});

describe('G27 cardSource & openReviewCardSource mm:ss preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prioritizes per-card [媒体@id:00:13] over bare resource sourceRef AND over batch-level media anchorUri', () => {
    const targetFromBareRef = resolveCardSource(
      { sourceRef: { kind: 'resource', id: 'file_lec_1', title: 'lecture.mp4' } },
      ['核心结论\n[媒体@file_lec_1:00:13]'],
    );
    expect(targetFromBareRef).toEqual({
      kind: 'media',
      media: { resourceId: 'file_lec_1', seconds: 13, label: '00:13' },
    });

    // Whole-lecture batch anchor starts at 00:00, but individual card cites 02:45
    const targetFromBatchAnchor = resolveCardSource(
      {
        sourceRef: {
          kind: 'resource',
          id: 'file_lec_1',
          title: 'lecture.mp4',
          anchorUri: 'ds-anchor://v1/media/file_lec_1?t=0',
        },
      },
      ['公式推导\n[媒体@file_lec_1:02:45]'],
    );
    expect(targetFromBatchAnchor).toEqual({
      kind: 'media',
      media: { resourceId: 'file_lec_1', seconds: 165, label: '02:45' },
    });
  });

  it('falls back to sourceRef.anchorUri (00:13) when LLM omits [媒体@id:mm:ss] in card back, and remembers pending focus before anchor reveal', async () => {
    const card = {
      sourceRef: {
        kind: 'resource',
        id: 'file_lec_1',
        title: 'lecture.mp4',
        anchorUri: 'ds-anchor://v1/media/file_lec_1?t=13000&end=24000',
      },
    };
    const target = resolveCardSource(card, ['纯文本背面，无内联标记']);
    expect(target).toEqual({
      kind: 'anchor',
      anchorUri: 'ds-anchor://v1/media/file_lec_1?t=13000&end=24000',
      locatorLabel: '00:13',
    });
    expect(resolveCardMediaSource(card, ['纯文本背面，无内联标记'])).toEqual({
      resourceId: 'file_lec_1',
      seconds: 13,
      label: '00:13',
    });

    await openCardSourceTarget(target!, 'flashcards-review');
    expect(rememberPendingMock).toHaveBeenCalledWith('file_lec_1', 13);
    expect(revealMock).toHaveBeenCalledWith(
      'ds-anchor://v1/media/file_lec_1?t=13000&end=24000',
      { splitIfClosed: true, pulse: true },
    );
  });

  it('openReviewCardSource preserves 00:13 timestamp instead of dropping to bare resource 0:00', async () => {
    invokeMock.mockResolvedValue({
      items: [
        {
          id: 'anki_m1',
          front: '核心定理是什么？',
          back: '证明要点\n[媒体@file_lec_1:00:13]',
          sourceRef: { kind: 'resource', id: 'file_lec_1', title: 'lecture.mp4' },
        },
      ],
    });

    const opened = await openReviewCardSource({
      id: 'state_m1',
      ankiCardId: 'anki_m1',
      front: '核心定理是什么？',
      back: '证明要点\n[媒体@file_lec_1:00:13]',
    });

    expect(opened).toBe(true);
    expect(openMediaMock).toHaveBeenCalledWith('file_lec_1', 13);
  });

  it('also preserves bracketed [00:13] on media sourceRef when LLM dropped the 媒体@id prefix', () => {
    const card = {
      sourceRef: { kind: 'resource', id: 'file_lec_1', title: 'lecture.mp4' },
      back: '证明要点 [00:13]',
    };
    const texts = cardMediaSourceTexts(card);
    expect(resolveCardMediaSource(card, texts)).toEqual({
      resourceId: 'file_lec_1',
      seconds: 13,
      label: '00:13',
    });
    expect(resolveCardSource(card, texts)).toEqual({
      kind: 'media',
      media: { resourceId: 'file_lec_1', seconds: 13, label: '00:13' },
    });
  });
});

describe('G27 LibraryCardRow ▶ mm:ss badge & timestamp-preserving 查看出处', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function renderExpandedRow(card: AnkiLibraryCard) {
    const noop = () => {};
    return render(
      <ul>
        <LibraryCardRow
          card={card}
          busy={false}
          deleting={false}
          selected={false}
          expanded
          confirmingDelete={false}
          onToggleSelect={noop}
          onToggleExpand={noop}
          onStartReview={noop}
          onEnqueue={noop}
          onToggleSuspended={noop}
          onRequestDelete={noop}
          onCancelDelete={noop}
          onConfirmDelete={noop}
          onSaveEdit={async () => true}
          onUndoReview={noop}
          onResetProgress={noop}
          onRowKeyDown={noop}
          rowRef={noop}
        />
      </ul>,
    );
  }

  it('shows ▶ 00:13 badge from sourceRef.anchorUri and routes both 查看出处 and ▶ 00:13 with timestamp 13s', () => {
    const card = {
      id: 'card_media_anchor',
      task_id: 'task_1',
      front: '核心定理',
      back: '答案内容（无内联标记）',
      tags: [],
      images: [],
      fields: {},
      extra_fields: {},
      template_id: null,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      enqueued: false,
      suspended: false,
      isDue: false,
      sourceRef: {
        kind: 'resource',
        id: 'file_lec_1',
        title: 'lecture.mp4',
        anchorUri: 'ds-anchor://v1/media/file_lec_1?t=13000',
      },
    } as unknown as AnkiLibraryCard;

    renderExpandedRow(card);

    const playBadge = screen.getByRole('button', { name: '跳转到 00:13' });
    expect(playBadge).toHaveTextContent('00:13');
    fireEvent.click(playBadge);
    expect(openMediaMock).toHaveBeenCalledWith('file_lec_1', 13);

    fireEvent.click(screen.getByRole('button', { name: '查看出处' }));
    expect(rememberPendingMock).toHaveBeenCalledWith('file_lec_1', 13);
    expect(revealMock).toHaveBeenCalledWith(
      'ds-anchor://v1/media/file_lec_1?t=13000',
      { splitIfClosed: true, pulse: true },
    );
  });

  it('routes 查看出处 through dispatchOpenMediaRef(id, 13) when bare resource sourceRef + [媒体@id:00:13] coexist', () => {
    const card = {
      id: 'card_media_inline',
      task_id: 'task_1',
      front: '核心定理',
      back: '答案内容\n[媒体@file_lec_1:00:13]',
      tags: [],
      images: [],
      fields: {},
      extra_fields: {},
      template_id: null,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      enqueued: false,
      suspended: false,
      isDue: false,
      sourceRef: {
        kind: 'resource',
        id: 'file_lec_1',
        title: 'lecture.mp4',
      },
    } as unknown as AnkiLibraryCard;

    renderExpandedRow(card);

    expect(screen.getByRole('button', { name: '跳转到 00:13' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看出处' }));
    expect(openMediaMock).toHaveBeenCalledWith('file_lec_1', 13);
  });
});

describe('G27 MediaStudyView seeks to 00:13 and highlights transcript cue on media-ref:focus & pending cold-open', () => {
  const OriginalRO = globalThis.ResizeObserver;

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    playerSeekSpy.mockClear();
    playerPlaySpy.mockClear();
    lastPlayerProps = null;
    takePendingMock.mockReturnValue(null);
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    globalThis.ResizeObserver = OriginalRO;
  });

  it('seeks to 13s, switches companion to transcript tab, and pulses cue idx=1 on media-ref:focus', async () => {
    const onActiveTabChange = vi.fn();
    const { container } = render(
      <MediaStudyCompanionContext.Provider
        value={{
          ariaLabel: '伴随面板',
          activeTab: MEDIA_STUDY_TRANSCRIPT_TAB,
          onActiveTabChange,
          tabs: [{ id: 'ask', label: '问答', render: () => null }],
        }}
      >
        <MediaStudyView
          kind="video"
          src="/api/protocol/filestream/%2Ftmp%2Flec.mp4?mime=video%2Fmp4"
          sourceKind="stream"
          resourceId="file_lec_1"
          fileName="lecture.mp4"
          onError={vi.fn()}
        />
      </MediaStudyCompanionContext.Provider>,
    );

    expect(lastPlayerProps).not.toBeNull();
    const ack = vi.fn();
    await act(async () => {
      document.dispatchEvent(
        new CustomEvent(MEDIA_REF_FOCUS_EVENT, {
          detail: { resourceId: 'file_lec_1', seconds: 13, play: true, acknowledge: ack },
        }),
      );
    });

    await waitFor(() => {
      expect(playerSeekSpy).toHaveBeenCalledWith(13);
    });
    expect(playerPlaySpy).toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(true);
    expect(onActiveTabChange).toHaveBeenCalledWith(MEDIA_STUDY_TRANSCRIPT_TAB);
    expect(container.querySelector('[data-cue-index="1"]')?.getAttribute('data-cue-pulse')).toBe('true');
  });

  it('consumes cold-open pending media focus (13s), seeks to 13s, and pulses cue idx=1', async () => {
    takePendingMock.mockImplementationOnce((matches) => (matches('file_lec_1') ? 13 : null));

    const { container } = render(
      <MediaStudyView
        kind="video"
        src="/api/protocol/filestream/%2Ftmp%2Flec.mp4?mime=video%2Fmp4"
        sourceKind="blob"
        resourceId="file_lec_1"
        fileName="lecture.mp4"
        onError={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(playerSeekSpy).toHaveBeenCalledWith(13);
    });
    expect(playerPlaySpy).toHaveBeenCalled();
    expect(container.querySelector('[data-cue-index="1"]')?.getAttribute('data-cue-pulse')).toBe('true');
  });
});

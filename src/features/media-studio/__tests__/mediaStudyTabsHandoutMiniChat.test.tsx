import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { MediaStudyCompanionRenderContext } from '@/features/learning-hub/apps/views/media/mediaStudyCompanion';
import type { TranscriptSegment } from '@/features/learning-hub/apps/views/media/mediaTranscriptApi';

const {
  useGenerateHandoutMock,
  openHandoutNoteMock,
  useReferenceToChatMock,
  relatedNotesMock,
  startMediaChatMock,
  showGlobalNotificationMock,
} = vi.hoisted(() => ({
  useGenerateHandoutMock: vi.fn(),
  openHandoutNoteMock: vi.fn(),
  useReferenceToChatMock: vi.fn(),
  relatedNotesMock: vi.fn(),
  startMediaChatMock: vi.fn(),
  showGlobalNotificationMock: vi.fn(),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) =>
        options ? `${key} ${JSON.stringify(options)}` : key,
      i18n: { resolvedLanguage: 'zh-CN', language: 'zh-CN' },
    }),
  };
});

vi.mock('@/features/media-handout', () => ({
  useGenerateHandout: useGenerateHandoutMock,
  openHandoutNote: openHandoutNoteMock,
}));

vi.mock('@/features/learning-hub/useReferenceToChat', () => ({
  useReferenceToChat: useReferenceToChatMock,
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    mediaStudioApi: {
      ...actual.mediaStudioApi,
      relatedNotes: relatedNotesMock,
    },
  };
});

vi.mock('../mediaChat', () => ({
  startMediaChat: startMediaChatMock,
}));

vi.mock('@/components/UnifiedNotification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/UnifiedNotification')>();
  return {
    ...actual,
    showGlobalNotification: showGlobalNotificationMock,
  };
});

import {
  MediaHandoutTab,
  MediaAskTab,
  buildMediaHandoutDocument,
} from '../components/MediaStudyTabs';

const sampleSegments: TranscriptSegment[] = [
  {
    idx: 0,
    startMs: 5_000,
    endMs: 25_000,
    text: '特征值与特征向量描述了线性变换的不变方向',
    status: 'done',
  },
  {
    idx: 1,
    startMs: 95_000,
    endMs: 115_000,
    text: '实对称矩阵必定可以正交对角化',
    status: 'done',
  },
];

function createMockContext(
  overrides: Partial<MediaStudyCompanionRenderContext> = {},
): MediaStudyCompanionRenderContext {
  return {
    resourceId: 'file_lec_03',
    kind: 'video',
    src: 'blob:video-lec-03',
    fileName: '线性代数第3讲.mp4',
    transcriptStatus: 'done',
    hasTranscript: true,
    doneSegments: 2,
    totalSegments: 2,
    segments: sampleSegments,
    chapters: [
      { seconds: 0, title: '特征值与特征向量导引' },
      { seconds: 90, title: '实对称矩阵的正交对角化' },
    ],
    currentChapterIndex: 1,
    seekTo: vi.fn(),
    getCurrentTime: () => 110,
    ...overrides,
  };
}

describe('MediaStudyTabs — HandoutReaderView & ContextualMiniChat integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGenerateHandoutMock.mockReturnValue({
      running: false,
      progress: null,
      result: null,
      start: vi.fn(),
      cancel: vi.fn(),
    });
    useReferenceToChatMock.mockReturnValue({
      referenceToChat: vi.fn().mockResolvedValue({ success: true }),
    });
    relatedNotesMock.mockResolvedValue([
      { id: 'note-handout-1', title: '线性代数第3讲 · 课堂讲义', updatedAt: Date.now() },
    ]);
    startMediaChatMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('1. builds a structured HandoutDocument from course title, chapters, and transcript segments', () => {
    const ctx = createMockContext();
    const doc = buildMediaHandoutDocument(ctx);

    expect(doc.title).toBe('线性代数第3讲 · 精读讲义');
    expect(doc.sections).toHaveLength(2);
    expect(doc.sections[0].heading).toBe('特征值与特征向量导引');
    expect(doc.sections[1].heading).toBe('实对称矩阵的正交对角化');
    expect(doc.sections[0].blocks.some((b) => b.type === 'callout')).toBe(true);
    expect(doc.sections[0].blocks.some((b) => b.type === 'checkpoint')).toBe(true);
  });

  it('2. toggles inline HandoutReaderView in MediaHandoutTab and renders chapters & interactive checkpoints', async () => {
    const ctx = createMockContext();
    render(<MediaHandoutTab ctx={ctx} visible={true} />);

    const toggleBtn = screen.getByTestId('toggle-inline-handout-reader');
    expect(toggleBtn).toBeTruthy();
    expect(screen.queryByTestId('handout-reader-view')).toBeNull();

    // 展开内联印刷级讲义阅读器
    fireEvent.click(toggleBtn);
    expect(screen.getByTestId('handout-reader-view')).toBeTruthy();
    expect(screen.getByText('线性代数第3讲 · 精读讲义')).toBeTruthy();

    // 校验随堂自测判题交互
    const checkpointCard = screen.getByTestId('handout-checkpoint-media-cp-1');
    expect(checkpointCard).toBeTruthy();
    const optionButtons = checkpointCard.querySelectorAll('button');
    expect(optionButtons.length).toBeGreaterThanOrEqual(3);

    fireEvent.click(optionButtons[0]);
    expect(screen.getByText('回答正确')).toBeTruthy();
    expect(screen.getByTestId('checkpoint-explanation-media-cp-1')).toBeTruthy();
  });

  it('3. links HandoutReaderView "转存至笔记" action to openHandoutNote when a handout note exists', async () => {
    useGenerateHandoutMock.mockReturnValue({
      running: false,
      progress: null,
      result: {
        noteId: 'note-generated-99',
        title: '生成的讲义',
        sectionCount: 2,
        figureCount: 0,
        framesDegraded: false,
      },
      start: vi.fn(),
      cancel: vi.fn(),
    });

    const ctx = createMockContext();
    render(<MediaHandoutTab ctx={ctx} visible={true} />);

    fireEvent.click(screen.getByTestId('toggle-inline-handout-reader'));
    const saveToNoteBtn = screen.getByText('转存至笔记');
    fireEvent.click(saveToNoteBtn);

    expect(openHandoutNoteMock).toHaveBeenCalledWith('note-generated-99');
  });

  it('4. preserves existing MediaHandoutTab generate button, chapter list seek, and related notes list', async () => {
    const ctx = createMockContext();
    render(<MediaHandoutTab ctx={ctx} visible={true} />);

    // 保留 data-media-handout-generate 与 data-media-chapters
    expect(document.querySelector('[data-media-handout-generate]')).toBeTruthy();
    expect(document.querySelector('[data-media-chapters]')).toBeTruthy();

    // 点击章节跳转时间轴
    fireEvent.click(screen.getByText('实对称矩阵的正交对角化'));
    expect(ctx.seekTo).toHaveBeenCalledWith(90);

    // 等待关联笔记加载并点击打开
    await waitFor(() => {
      expect(screen.getByText('线性代数第3讲 · 课堂讲义')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('线性代数第3讲 · 课堂讲义'));
    expect(openHandoutNoteMock).toHaveBeenCalledWith('note-handout-1');
  });

  it('5. mounts ContextualMiniChat in MediaAskTab bound to the current video timestamp anchor', () => {
    const ctx = createMockContext({ getCurrentTime: () => 110 });
    render(<MediaAskTab ctx={ctx} meta={{ name: '线性代数第3讲.mp4', mimeType: 'video/mp4' }} />);

    expect(screen.getByTestId('contextual-mini-chat')).toBeTruthy();
    const anchorPill = screen.getByTestId('mini-chat-anchor-pill');
    expect(anchorPill.textContent).toContain('视频时间点');
    expect(anchorPill.textContent).toContain('01:50 · 线性代数第3讲');
  });

  it('6. supports asking in ContextualMiniChat and promoting to main chat via startMediaChat with video anchor', async () => {
    const ctx = createMockContext({ getCurrentTime: () => 110 });
    render(<MediaAskTab ctx={ctx} meta={{ name: '线性代数第3讲.mp4', mimeType: 'video/mp4' }} />);

    // 点击伴读小窗内的预设指令「解释当前段落」
    fireEvent.click(screen.getByText('解释当前段落'));

    // 点击「迁入主会话」
    fireEvent.click(screen.getByTestId('promote-to-main-chat-btn'));

    await waitFor(() => {
      expect(startMediaChatMock).toHaveBeenCalledTimes(1);
    });
    expect(startMediaChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: 'file_lec_03',
        name: '线性代数第3讲.mp4',
        prompt: expect.stringContaining('[媒体@file_lec_03:01:50]'),
      }),
    );
  });

  it('7. preserves existing MediaAskTab quick ask buttons (data-media-ask and data-media-ask-moment)', async () => {
    const ctx = createMockContext({ getCurrentTime: () => 110 });
    render(<MediaAskTab ctx={ctx} meta={{ name: '线性代数第3讲.mp4', mimeType: 'video/mp4' }} />);

    const askMomentBtn = document.querySelector('[data-media-ask-moment]') as HTMLElement;
    expect(askMomentBtn).toBeTruthy();
    fireEvent.click(askMomentBtn);

    await waitFor(() => {
      expect(startMediaChatMock).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: 'file_lec_03',
          prompt: expect.stringContaining('mediaStudio:ask.prompt.moment'),
        }),
      );
    });
  });

  it('8. triggers handout generation and does NOT fake "已转存至笔记" when no handout note exists yet', async () => {
    const generateSpy = vi.fn();
    useGenerateHandoutMock.mockReturnValue({
      running: false,
      progress: null,
      result: null,
      start: generateSpy,
      cancel: vi.fn(),
    });
    relatedNotesMock.mockResolvedValue([]);

    const ctx = createMockContext();
    render(<MediaHandoutTab ctx={ctx} visible={true} />);

    await waitFor(() => {
      expect(relatedNotesMock).toHaveBeenCalledWith('file_lec_03');
    });

    fireEvent.click(screen.getByTestId('toggle-inline-handout-reader'));
    const saveBtn = screen.getByRole('button', { name: '转存至笔记' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(generateSpy).toHaveBeenCalledTimes(1);
    });
    expect(openHandoutNoteMock).not.toHaveBeenCalled();
    expect(showGlobalNotificationMock).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('正在生成讲义笔记'),
    );
    expect(saveBtn).toHaveAttribute('data-saved', 'false');
    expect(screen.queryByText('已转存至笔记')).toBeNull();
  });

  it('9. answers immediately in ContextualMiniChat using chapter & nearby transcript segments (and guides clearly when no transcript)', () => {
    const ctx = createMockContext({ getCurrentTime: () => 110 });
    const { unmount } = render(
      <MediaAskTab ctx={ctx} meta={{ name: '线性代数第3讲.mp4', mimeType: 'video/mp4' }} />,
    );

    const input = screen.getByRole('textbox', { name: '伴读提问输入框' });
    fireEvent.change(input, { target: { value: '这一段讲的核心结论是什么？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送伴读提问' }));

    const msgList = screen.getByTestId('mini-chat-message-list');
    expect(msgList.textContent).toContain('01:50');
    expect(msgList.textContent).toContain('实对称矩阵的正交对角化');
    expect(msgList.textContent).toContain('[01:35] 实对称矩阵必定可以正交对角化');
    expect(msgList.textContent).toContain('迁入主会话');

    unmount();

    // 当尚无字幕时，返回清晰引导而非无响应死胡同
    const noTranscriptCtx = createMockContext({
      hasTranscript: false,
      segments: [],
      getCurrentTime: () => 40,
    });
    render(
      <MediaAskTab
        ctx={noTranscriptCtx}
        meta={{ name: '线性代数第3讲.mp4', mimeType: 'video/mp4' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '解释当前段落' }));
    const emptyMsgList = screen.getByTestId('mini-chat-message-list');
    expect(emptyMsgList.textContent).toContain('尚无可用字幕转写');
    expect(emptyMsgList.textContent).toContain('迁入主会话');
  });

  it('10. refreshes ContextualMiniChat video_timestamp anchor in real time while MediaAskTab is visible', () => {
    vi.useFakeTimers();
    let currentTime = 110;
    const ctx = createMockContext({ getCurrentTime: () => currentTime });

    render(
      <MediaAskTab
        ctx={ctx}
        meta={{ name: '线性代数第3讲.mp4', mimeType: 'video/mp4' }}
        visible={true}
      />,
    );

    expect(screen.getByTestId('mini-chat-anchor-pill').textContent).toContain('01:50');

    currentTime = 125;
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByTestId('mini-chat-anchor-pill').textContent).toContain('02:05');
  });

  it('11. imports HandoutReaderView & ContextualMiniChat strictly via top-level feature barrels and uses @/utils/cn', () => {
    const sourcePath = path.resolve(__dirname, '../components/MediaStudyTabs.tsx');
    const code = fs.readFileSync(sourcePath, 'utf-8');

    expect(code).toContain("from '@/utils/cn'");
    expect(code).not.toContain("from '@/lib/utils'");
    expect(code).toContain("from '@/features/learning-hub'");
    expect(code).toContain("from '@/features/chat'");
    expect(code).not.toContain('@/features/learning-hub/components/HandoutReaderView');
    expect(code).not.toContain('@/features/chat/components/ContextualMiniChat');
  });
});

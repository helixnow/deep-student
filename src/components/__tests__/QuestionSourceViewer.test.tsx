import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mobile: false,
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => state.invokeMock(...args),
}));
vi.mock('@/hooks/useBreakpoint', () => ({
  useIsMobile: () => state.mobile,
}));
vi.mock('@/hooks/useKeyboardHeight', () => ({
  useKeyboardHeight: () => 0,
  getLayoutViewportObscuredHeight: () => 0,
}));

import {
  QuestionSourceViewer,
  buildViewerSourceRefs,
  normalizeSourceBBox,
  type SourcePageResult,
} from '../QuestionSourceViewer';

function pageResult(overrides: Partial<SourcePageResult> = {}): SourcePageResult {
  return {
    source_id: 'qsrc_1',
    page: 2,
    blob_hash: 'blob_page_2',
    width: 1200,
    height: 1600,
    text: 'Page two text layer',
    source_name: 'midterm.pdf',
    source_format: 'pdf',
    original_path: '/library/midterm.pdf',
    page_count: 3,
    available_pages: [1, 2, 3],
    ...overrides,
  };
}

function mockPageAndBlob(result: SourcePageResult) {
  state.invokeMock.mockImplementation(async (command: string) => {
    if (command === 'qbank_get_source_page') return result;
    if (command === 'vfs_get_blob_base64') {
      return { base64: 'iVBORw0KGgo=', mimeType: 'image/png', size: 8 };
    }
    throw new Error(`unexpected command: ${command}`);
  });
}

beforeEach(() => {
  state.mobile = false;
  state.invokeMock.mockReset();
  // JSDOM has no layout; the dialog focus trap checks visibility.
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function () {
    return this.parentElement;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('QuestionSourceViewer', () => {
  it('opens the full page image and overlays the normalized bbox over it', async () => {
    mockPageAndBlob(pageResult());

    render(
      <QuestionSourceViewer
        isOpen
        onClose={() => {}}
        examId="exam_1"
        sourceRefs={[
          { source_id: 'qsrc_1', page: 2, bbox: [0.1, 0.2, 0.5, 0.6] },
        ]}
      />,
    );

    const image = await screen.findByRole('img', { name: /第 2 页/ });
    expect(image).toBeInTheDocument();
    await waitFor(() =>
      expect(state.invokeMock).toHaveBeenCalledWith('qbank_get_source_page', {
        examId: 'exam_1',
        sourceId: 'qsrc_1',
        page: 2,
      }),
    );
    expect(state.invokeMock).toHaveBeenCalledWith('vfs_get_blob_base64', {
      blobHash: 'blob_page_2',
    });

    const bbox = screen.getByTestId('source-page-bbox');
    expect(bbox).toHaveStyle({
      left: '10%',
      top: '20%',
      width: '40%',
      height: '40%',
    });
    expect(screen.getByText('/library/midterm.pdf')).toBeInTheDocument();
  });

  it('keeps a page-less ref page-less and shows descriptor native text without fabricating page one', async () => {
    mockPageAndBlob(
      pageResult({
        source_id: 'qsrc_text',
        page: null,
        blob_hash: null,
        width: null,
        height: null,
        text: 'Native transcript text',
        source_name: 'lecture-transcript.txt',
        source_format: 'media_transcript',
        original_path: '/library/lecture-transcript.txt',
        page_count: null,
        available_pages: [],
      }),
    );

    render(
      <QuestionSourceViewer
        isOpen
        onClose={() => {}}
        examId="exam_1"
        sourceRefs={[{ source_id: 'qsrc_text' }]}
      />,
    );

    expect(await screen.findByTestId('source-viewer-no-page')).toHaveTextContent('该来源没有页码');
    expect(screen.getByText('Native transcript text')).toBeInTheDocument();
    expect(screen.getByText('/library/lecture-transcript.txt')).toBeInTheDocument();
    expect(screen.queryByText('第 1 页')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(state.invokeMock).toHaveBeenCalledWith('qbank_get_source_page', {
      examId: 'exam_1',
      sourceId: 'qsrc_text',
      page: null,
    });
  });

  it('shows an explicit legacy error with the original ref instead of silently hiding it', async () => {
    state.invokeMock.mockRejectedValue({ message: '来源不存在或不属于该题目集' });

    render(
      <QuestionSourceViewer
        isOpen
        onClose={() => {}}
        examId="exam_1"
        sourceRefs={[{ source_id: 'legacy_s1', page: 4 }]}
      />,
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('旧版来源引用不可用');
    expect(alert).toHaveTextContent('legacy_s1');
    expect(alert).toHaveTextContent('第 4 页');
    expect(alert).toHaveTextContent('来源不存在或不属于该题目集');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('offers original VFS file metadata for a chat attachment without a rasterized page', async () => {
    mockPageAndBlob(
      pageResult({
        source_id: 'att_chat_pdf',
        page: 3,
        blob_hash: null,
        width: null,
        height: null,
        text: null,
        source_name: 'chat-notes.pdf',
        source_format: 'pdf',
        original_path: '/library/chat-notes.pdf',
        page_count: 12,
        available_pages: [],
      }),
    );

    render(
      <QuestionSourceViewer
        isOpen
        onClose={() => {}}
        examId="exam_1"
        sourceRefs={[{ source_id: 'att_chat_pdf', page: 3 }]}
      />,
    );

    expect(await screen.findByTestId('source-viewer-page-image-unavailable')).toHaveTextContent(
      '该页没有可用的页面图像',
    );
    expect(screen.getByText('/library/chat-notes.pdf')).toBeInTheDocument();
    expect(screen.getByText('未提供页面图像，仅显示原始文件信息。')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('navigates question and answer refs with real source ids/pages and only overlays matching-page bboxes', async () => {
    state.invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'qbank_get_source_page') {
        const page = args?.page as number | null;
        const sourceId = args?.sourceId as string;
        return pageResult({
          source_id: sourceId,
          page,
          blob_hash: `blob_${page}`,
          text: `text ${page}`,
        });
      }
      if (command === 'vfs_get_blob_base64') {
        return { base64: 'AAAA', mimeType: 'image/png', size: 3 };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(
      <QuestionSourceViewer
        isOpen
        onClose={() => {}}
        examId="exam_1"
        sourceRefs={[
          { source_id: 'qsrc_q', page: 1, bbox: [0.05, 0.05, 0.95, 0.4] },
          { source_id: 'qsrc_q', page: 2 },
        ]}
        answerSourceRefs={[{ source_id: 'qsrc_a', page: 5, bbox: [0.2, 0.3, 0.4, 0.5] }]}
      />,
    );

    expect(await screen.findByTestId('source-page-bbox')).toBeInTheDocument();
    expect(state.invokeMock).toHaveBeenCalledWith('qbank_get_source_page', {
      examId: 'exam_1',
      sourceId: 'qsrc_q',
      page: 1,
    });

    // Keyboard navigation follows the same ordered ref list (question refs first).
    await act(async () => {
      fireEvent.keyDown(document, { key: 'ArrowRight' });
    });
    await waitFor(() =>
      expect(state.invokeMock).toHaveBeenCalledWith('qbank_get_source_page', {
        examId: 'exam_1',
        sourceId: 'qsrc_q',
        page: 2,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('source-page-bbox')).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId('source-ref-2'));
    await waitFor(() =>
      expect(state.invokeMock).toHaveBeenCalledWith('qbank_get_source_page', {
        examId: 'exam_1',
        sourceId: 'qsrc_a',
        page: 5,
      }),
    );
    expect(await screen.findByTestId('source-page-bbox')).toBeInTheDocument();
  });

  it('uses a desktop side rail and a mobile top strip for the same refs', async () => {
    mockPageAndBlob(pageResult());
    const refs = [{ source_id: 'qsrc_1', page: 2, bbox: [0.1, 0.1, 0.3, 0.3] }];

    const desktop = render(
      <QuestionSourceViewer isOpen onClose={() => {}} examId="exam_1" sourceRefs={refs} />,
    );
    expect(screen.getByTestId('question-source-viewer')).toHaveAttribute(
      'data-source-viewer-layout',
      'desktop',
    );
    expect(await screen.findByRole('img', { name: /第 2 页/ })).toBeInTheDocument();
    desktop.unmount();
    cleanup();

    state.mobile = true;
    render(
      <QuestionSourceViewer isOpen onClose={() => {}} examId="exam_1" sourceRefs={refs} />,
    );
    expect(screen.getByTestId('question-source-viewer')).toHaveAttribute(
      'data-source-viewer-layout',
      'mobile',
    );
    expect(screen.getByTestId('source-viewer-refs')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: /第 2 页/ })).toBeInTheDocument();
  });
});

describe('source ref/bbox normalization', () => {
  it('does not turn missing/invalid page numbers into page one', () => {
    const refs = buildViewerSourceRefs(
      [
        { source_id: 'a', page: 0 },
        { source_id: 'b', page: -2 },
        { source_id: 'c', page: Number.NaN },
        { source_id: 'd' },
      ],
      [{ source_id: 'answer', page: 3 }],
    );
    expect(refs.map((ref) => ref.page)).toEqual([null, null, null, null, 3]);
    expect(refs[4].role).toBe('answer');
  });

  it('rejects malformed or out-of-page bboxes instead of clamping them', () => {
    expect(normalizeSourceBBox([0.1, 0.2, 0.5, 0.6])).toEqual([0.1, 0.2, 0.5, 0.6]);
    expect(normalizeSourceBBox([0.5, 0.2, 0.1, 0.6])).toBeNull();
    expect(normalizeSourceBBox([-0.1, 0.2, 0.5, 0.6])).toBeNull();
    expect(normalizeSourceBBox([0.1, 0.2, 1.2, 0.6])).toBeNull();
    expect(normalizeSourceBBox('bad')).toBeNull();
  });
});

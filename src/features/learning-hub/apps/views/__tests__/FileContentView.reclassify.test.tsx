/**
 * A3：已导入错误条目在 unsupported 页的原位重识别 UI 契约。
 *
 * 本文件只约束 FileContentView 的用户可见行为：
 * - 初始不自动调用 dstu.reclassifyFile；用户在 unsupported 页显式点击才触发。
 * - 请求进行中显示 busy 且禁用动作，重复点击不会并发发起第二次请求。
 * - recognized 且返回节点 ID 与当前资源一致时，通过 onNodeReclassified 回传一次，
 *   由 UnifiedAppPanel 在同一 tab 内原地改路由。
 * - recognized 但修正节点仍无可用预览模式（如 application/zip）时，必须保留
 *   “已识别但仍不支持预览”的显式反馈，不能清空反馈后静默无变化。
 * - 宿主未提供 onNodeReclassified（如 MediaStudyPage）时不展示重识别动作，
 *   保留原 save/retry，避免成功结果无处回传。
 * - recognized 但 node 为空或 ID 不一致时不得回传。
 * - unknown / missing / corrupt 分别给出可区分提示，且不回传成功节点。
 * - Result.err 或 Promise reject 都显示可重试失败，不假成功。
 * - 切换资源（A→B、A→B→A）或 unmount 后，旧请求的迟到结果不得回传或污染新资源。
 *
 * 文案契约使用语义正则而非 fake testid：实现可调整具体措辞，但必须保留这些
 * 可辨识的中文语义；默认语言由测试 harness 固定为 zh-CN。
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DstuNode } from '@/dstu/types';

const { reclassifyFile } = vi.hoisted(() => ({ reclassifyFile: vi.fn() }));

vi.mock('@/dstu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/dstu')>();
  return {
    ...actual,
    dstu: { ...actual.dstu, reclassifyFile },
  };
});

// 保留昂贵 renderer / IPC 边界的 mock；PreviewStatus 不再 mock，用真实组件断言。
vi.mock('@/hooks/usePdfLoader', () => ({
  usePdfLoader: () => ({
    file: null,
    filePath: null,
    loading: false,
    error: null,
    isLargeFile: false,
    retry: vi.fn(),
  }),
}));
vi.mock('../usePdfFocusListener', () => ({ usePdfFocusListener: () => [null, vi.fn()] }));
vi.mock('@/features/learning-hub/useReferenceToChat', () => ({
  useReferenceToChat: () => ({ referenceToChat: vi.fn() }),
}));
vi.mock('@/features/pdf/components/TextbookPdfViewer', () => ({ TextbookPdfViewer: () => null }));
vi.mock('../RichDocumentPreview', () => ({ RichDocumentPreview: () => null }));
vi.mock('../TextFilePreview', () => ({ TextFilePreview: () => null }));
vi.mock('../EpubPreview', () => ({ default: () => null }));
vi.mock('../media/MediaStudyView', () => ({ MediaStudyView: () => null }));
vi.mock('../saveResourceToDevice', () => ({
  saveFiltersForFileName: vi.fn(),
  saveResourceToDevice: vi.fn(),
}));
vi.mock('../previewPersistence', () => ({
  createPreviewPersistController: () => ({
    dispose: vi.fn(),
    scheduleProgress: vi.fn(),
    scheduleBookmarks: vi.fn(),
  }),
}));

import FileContentView from '../FileContentView';

const UNSUPPORTED_FILE_TITLE = '此文件类型不支持预览';

const RECLASSIFY_NAME = /重新识别|识别中/;
const BUSY_TEXT = /识别中|正在重新识别/;
const UNKNOWN_HINT = /无法识别|未能识别|仍未知|未知类型/;
const MISSING_HINT = /缺失|不存在|已丢失|丢失/;
const CORRUPT_HINT = /损坏/;
const STILL_UNSUPPORTED_HINT = /已识别但仍不支持预览|仍不支持预览/;
const FAILURE_HINT = /重新识别失败|识别失败|boundary unavailable|boundary rejected/;

const unsupportedFile: DstuNode = {
  id: 'file_a3_unsupported',
  sourceId: 'file_a3_unsupported',
  name: 'Thesis Draft',
  type: 'file',
  path: '/file_a3_unsupported',
  createdAt: 1,
  updatedAt: 1,
  previewType: 'none',
  metadata: { mimeType: 'application/octet-stream', contentHash: 'sha_a3_unsupported' },
};

const otherUnsupportedFile: DstuNode = {
  ...unsupportedFile,
  id: 'file_a3_other_unsupported',
  sourceId: 'file_a3_other_unsupported',
  name: 'Second Draft',
  path: '/file_a3_other_unsupported',
  metadata: { mimeType: 'application/octet-stream', contentHash: 'sha_a3_other_unsupported' },
};

const recognizedImage: DstuNode = {
  ...unsupportedFile,
  type: 'image',
  previewType: 'image',
  metadata: { mimeType: 'image/png' },
};

/** recognized 但修正结果仍落在 unsupported 路由：例如 zip 无在线解压预览。 */
const recognizedUnsupportedZip: DstuNode = {
  ...unsupportedFile,
  type: 'file',
  previewType: 'none',
  metadata: { mimeType: 'application/zip', contentHash: 'sha_a3_zip' },
};

interface ReclassifyResponse {
  ok: boolean;
  value?: { status: 'recognized' | 'unknown' | 'missing' | 'corrupt'; node: DstuNode | null };
  error?: { code: string; message: string };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const recognizedResult = (node: DstuNode): ReclassifyResponse => ({
  ok: true,
  value: { status: 'recognized', node },
});

const statusResult = (
  status: 'unknown' | 'missing' | 'corrupt',
): ReclassifyResponse => ({
  ok: true,
  value: { status, node: null },
});

const getReclassifyButton = () =>
  screen.getByRole('button', { name: RECLASSIFY_NAME });

/** 允许同一提示同时出现在标题/描述两处，不做单节点匹配。 */
const expectVisibleText = async (hint: RegExp) => {
  expect((await screen.findAllByText(hint)).length).toBeGreaterThan(0);
};

describe('FileContentView explicit A3 re-identify action', () => {
  beforeEach(() => {
    reclassifyFile.mockReset();
  });

  it('does not call reclassify on mount and offers the explicit action on the unsupported page', async () => {
    const onNodeReclassified = vi.fn();

    render(
      <FileContentView
        node={unsupportedFile}
        onNodeReclassified={onNodeReclassified}
      />,
    );

    // 刷新一次挂载期微任务，确认没有自动触发（不依赖计时器/sleep）。
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(UNSUPPORTED_FILE_TITLE)).toBeInTheDocument();
    expect(getReclassifyButton()).toBeEnabled();
    expect(reclassifyFile).not.toHaveBeenCalled();
    expect(onNodeReclassified).not.toHaveBeenCalled();
  });

  it('shows a busy disabled action while pending and ignores repeated clicks', async () => {
    const pending = deferred<ReclassifyResponse>();
    reclassifyFile.mockReturnValueOnce(pending.promise);
    const onNodeReclassified = vi.fn();

    render(
      <FileContentView
        node={unsupportedFile}
        onNodeReclassified={onNodeReclassified}
      />,
    );

    const button = getReclassifyButton();
    fireEvent.click(button);

    await waitFor(() => {
      const busyButton = getReclassifyButton();
      expect(busyButton).toBeDisabled();
      expect(busyButton).toHaveTextContent(BUSY_TEXT);
    });

    // 禁用态下的重复点击不得发第二次 IPC。
    fireEvent.click(getReclassifyButton());
    expect(reclassifyFile).toHaveBeenCalledTimes(1);
    expect(reclassifyFile).toHaveBeenCalledWith(unsupportedFile.id);

    await act(async () => {
      pending.resolve(recognizedResult(recognizedImage));
      await pending.promise;
    });

    await waitFor(() => expect(onNodeReclassified).toHaveBeenCalledTimes(1));
  });

  it('hands the recognized node with the original id back once for same-tab reroute', async () => {
    reclassifyFile.mockResolvedValue(recognizedResult(recognizedImage));
    const onNodeReclassified = vi.fn();

    render(
      <FileContentView
        node={unsupportedFile}
        onNodeReclassified={onNodeReclassified}
      />,
    );

    fireEvent.click(getReclassifyButton());

    await waitFor(() => expect(reclassifyFile).toHaveBeenCalledWith(unsupportedFile.id));
    await waitFor(() => expect(onNodeReclassified).toHaveBeenCalledTimes(1));

    const correctedNode = onNodeReclassified.mock.calls[0][0] as DstuNode;
    expect(correctedNode.id).toBe(unsupportedFile.id);
    expect(correctedNode.type).toBe('image');
  });

  it('keeps an explicit still-unsupported notice when the recognized node has no preview mode', async () => {
    reclassifyFile.mockResolvedValue(recognizedResult(recognizedUnsupportedZip));
    const onNodeReclassified = vi.fn();

    render(
      <FileContentView
        node={unsupportedFile}
        onNodeReclassified={onNodeReclassified}
      />,
    );

    fireEvent.click(getReclassifyButton());

    // 不得把 recognized 当成“已解决”后静默清空反馈；节点仍是 zip/不支持预览。
    await expectVisibleText(STILL_UNSUPPORTED_HINT);
    expect(reclassifyFile).toHaveBeenCalledWith(unsupportedFile.id);
  });

  it('does not offer reclassify when the host cannot receive the corrected node', () => {
    render(<FileContentView node={unsupportedFile} />);

    expect(screen.getByText(UNSUPPORTED_FILE_TITLE)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: RECLASSIFY_NAME }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '保存到本地打开' }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled();
    expect(reclassifyFile).not.toHaveBeenCalled();
  });

  it('does not hand back a recognized result when the corrected node is missing', async () => {
    reclassifyFile.mockResolvedValue({
      ok: true,
      value: { status: 'recognized', node: null },
    });
    const onNodeReclassified = vi.fn();

    render(
      <FileContentView
        node={unsupportedFile}
        onNodeReclassified={onNodeReclassified}
      />,
    );

    fireEvent.click(getReclassifyButton());

    await expectVisibleText(FAILURE_HINT);
    expect(onNodeReclassified).not.toHaveBeenCalled();
    expect(getReclassifyButton()).toBeEnabled();
  });

  it('does not hand back a recognized result whose id does not match the current resource', async () => {
    reclassifyFile.mockResolvedValue(
      recognizedResult({ ...recognizedImage, id: 'file_a3_wrong_id' }),
    );
    const onNodeReclassified = vi.fn();

    render(
      <FileContentView
        node={unsupportedFile}
        onNodeReclassified={onNodeReclassified}
      />,
    );

    fireEvent.click(getReclassifyButton());

    await expectVisibleText(FAILURE_HINT);
    expect(onNodeReclassified).not.toHaveBeenCalled();
    expect(getReclassifyButton()).toBeEnabled();
  });

  it.each([
    { label: 'unknown', status: 'unknown' as const, hint: UNKNOWN_HINT },
    { label: 'missing', status: 'missing' as const, hint: MISSING_HINT },
    { label: 'corrupt', status: 'corrupt' as const, hint: CORRUPT_HINT },
  ])(
    'reports $label explicitly, keeps the action retryable, and never reports success',
    async ({ status, hint }) => {
      reclassifyFile.mockResolvedValue(statusResult(status));
      const onNodeReclassified = vi.fn();

      render(
        <FileContentView
          node={unsupportedFile}
          onNodeReclassified={onNodeReclassified}
        />,
      );

      fireEvent.click(getReclassifyButton());

      await expectVisibleText(hint);
      expect(onNodeReclassified).not.toHaveBeenCalled();
      expect(getReclassifyButton()).toBeEnabled();
    },
  );

  it.each([
    {
      label: 'an err result',
      arrange: () => {
        reclassifyFile.mockResolvedValue({
          ok: false,
          error: { code: 'RECLASSIFY_UNAVAILABLE', message: 'boundary unavailable' },
        });
      },
    },
    {
      label: 'a rejected promise',
      arrange: () => {
        reclassifyFile.mockRejectedValue(new Error('boundary rejected'));
      },
    },
  ])('shows a retryable failure for $label without reporting success', async ({ arrange }) => {
    arrange();
    const onNodeReclassified = vi.fn();

    render(
      <FileContentView
        node={unsupportedFile}
        onNodeReclassified={onNodeReclassified}
      />,
    );

    fireEvent.click(getReclassifyButton());

    await expectVisibleText(FAILURE_HINT);
    expect(onNodeReclassified).not.toHaveBeenCalled();
    expect(getReclassifyButton()).toBeEnabled();
  });

  it('allows a retry after a failed attempt and only then reports the recognized node', async () => {
    reclassifyFile
      .mockResolvedValueOnce(statusResult('unknown'))
      .mockResolvedValueOnce(recognizedResult(recognizedImage));
    const onNodeReclassified = vi.fn();

    render(
      <FileContentView
        node={unsupportedFile}
        onNodeReclassified={onNodeReclassified}
      />,
    );

    fireEvent.click(getReclassifyButton());
    await expectVisibleText(UNKNOWN_HINT);
    expect(onNodeReclassified).not.toHaveBeenCalled();

    fireEvent.click(getReclassifyButton());

    await waitFor(() => expect(reclassifyFile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onNodeReclassified).toHaveBeenCalledTimes(1));
    expect(onNodeReclassified.mock.calls[0][0]).toMatchObject({
      id: unsupportedFile.id,
      type: 'image',
    });
  });

  it('drops a late recognized result after switching from A to B', async () => {
    const pending = deferred<ReclassifyResponse>();
    reclassifyFile.mockReturnValueOnce(pending.promise);
    const onNodeReclassified = vi.fn();

    const { rerender } = render(
      <FileContentView
        node={unsupportedFile}
        onNodeReclassified={onNodeReclassified}
      />,
    );
    fireEvent.click(getReclassifyButton());

    rerender(
      <FileContentView
        node={otherUnsupportedFile}
        onNodeReclassified={onNodeReclassified}
      />,
    );

    // 切换资源本身不得自动发起重识别。
    expect(reclassifyFile).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(recognizedResult(recognizedImage));
      await pending.promise;
    });

    expect(onNodeReclassified).not.toHaveBeenCalled();
    expect(screen.getByText(UNSUPPORTED_FILE_TITLE)).toBeInTheDocument();
    expect(screen.getByText(/Second Draft/)).toBeInTheDocument();
    expect(screen.queryByText(/Thesis Draft/)).not.toBeInTheDocument();
  });

  it('does not let a late failure from A pollute B after switching resources', async () => {
    const pending = deferred<ReclassifyResponse>();
    reclassifyFile.mockReturnValueOnce(pending.promise);
    const onNodeReclassified = vi.fn();

    const { rerender } = render(
      <FileContentView
        node={unsupportedFile}
        onNodeReclassified={onNodeReclassified}
      />,
    );
    fireEvent.click(getReclassifyButton());

    rerender(
      <FileContentView
        node={otherUnsupportedFile}
        onNodeReclassified={onNodeReclassified}
      />,
    );

    await act(async () => {
      pending.resolve(statusResult('corrupt'));
      await pending.promise;
    });

    expect(onNodeReclassified).not.toHaveBeenCalled();
    expect(screen.queryAllByText(CORRUPT_HINT)).toHaveLength(0);
    expect(screen.getByText(UNSUPPORTED_FILE_TITLE)).toBeInTheDocument();
    expect(screen.getByText(/Second Draft/)).toBeInTheDocument();
  });

  it('drops a stale result after A→B→A while the new request owns the outcome', async () => {
    const staleRequest = deferred<ReclassifyResponse>();
    const freshRequest = deferred<ReclassifyResponse>();
    reclassifyFile
      .mockReturnValueOnce(staleRequest.promise)
      .mockReturnValueOnce(freshRequest.promise);
    const onNodeReclassified = vi.fn();

    const { rerender } = render(
      <FileContentView
        node={unsupportedFile}
        onNodeReclassified={onNodeReclassified}
      />,
    );
    fireEvent.click(getReclassifyButton());

    rerender(
      <FileContentView
        node={otherUnsupportedFile}
        onNodeReclassified={onNodeReclassified}
      />,
    );
    rerender(
      <FileContentView
        node={unsupportedFile}
        onNodeReclassified={onNodeReclassified}
      />,
    );

    // 回到 A 后必须允许重新发起；旧请求不能把按钮永久卡在 busy。
    expect(reclassifyFile).toHaveBeenCalledTimes(1);
    expect(getReclassifyButton()).toBeEnabled();
    fireEvent.click(getReclassifyButton());
    expect(reclassifyFile).toHaveBeenCalledTimes(2);

    await act(async () => {
      staleRequest.resolve(
        recognizedResult({ ...recognizedImage, name: 'Stale Thesis' }),
      );
      await staleRequest.promise;
    });
    expect(onNodeReclassified).not.toHaveBeenCalled();

    await act(async () => {
      freshRequest.resolve(
        recognizedResult({ ...recognizedImage, name: 'Fresh Thesis' }),
      );
      await freshRequest.promise;
    });

    await waitFor(() => expect(onNodeReclassified).toHaveBeenCalledTimes(1));
    const correctedNode = onNodeReclassified.mock.calls[0][0] as DstuNode;
    expect(correctedNode.id).toBe(unsupportedFile.id);
    expect(correctedNode.name).toBe('Fresh Thesis');
  });

  it('drops a late result after unmount', async () => {
    const pending = deferred<ReclassifyResponse>();
    reclassifyFile.mockReturnValueOnce(pending.promise);
    const onNodeReclassified = vi.fn();

    const { unmount } = render(
      <FileContentView
        node={unsupportedFile}
        onNodeReclassified={onNodeReclassified}
      />,
    );
    fireEvent.click(getReclassifyButton());

    unmount();

    await act(async () => {
      pending.resolve(recognizedResult(recognizedImage));
      await pending.promise;
    });

    expect(onNodeReclassified).not.toHaveBeenCalled();
  });
});

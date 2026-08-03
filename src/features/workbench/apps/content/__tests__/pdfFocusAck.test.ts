/**
 * ACR 4.0（A7）— pdfFocusAck 超时竞态与 usePdfFocusListener 卸载回执
 *
 * 保障「回执说失败就真的不会发生」：
 * - 超时后请求被标记 stale，viewer 后续挂载不得再兑现；
 * - 迟到的 acknowledge 是幂等 no-op；
 * - 监听 Hook 真实卸载时显式 ack(false)，不留给 1.5s 超时。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  usePdfFocusListener,
  type PdfFocusEventDetail,
} from '@/features/learning-hub/apps/views/usePdfFocusListener';
import { PDF_FOCUS_ACK_TIMEOUT_MS, requestPdfPageFocus } from '../pdfFocusAck';

function captureDetail(): {
  details: PdfFocusEventDetail[];
  dispose: () => void;
} {
  const details: PdfFocusEventDetail[] = [];
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<PdfFocusEventDetail>).detail;
    if (detail) details.push(detail);
  };
  document.addEventListener('pdf-ref:focus', listener);
  return {
    details,
    dispose: () => document.removeEventListener('pdf-ref:focus', listener),
  };
}

describe('requestPdfPageFocus（pdfFocusAck）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('viewer 同步 ack(true) → handled+acknowledged，且请求不 stale', async () => {
    const { details, dispose } = captureDetail();
    const ackTrue = (event: Event) => {
      (event as CustomEvent<PdfFocusEventDetail>).detail?.acknowledge?.(true);
    };
    document.addEventListener('pdf-ref:focus', ackTrue);

    const result = await requestPdfPageFocus('tb_1', 7);
    expect(result).toEqual({ handled: true, acknowledged: true });
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ sourceId: 'tb_1', pageNumber: 7, path: '/tb_1' });
    expect(details[0].isStale?.()).toBe(false);

    document.removeEventListener('pdf-ref:focus', ackTrue);
    dispose();
  });

  it('超时 → ACTION_UNAVAILABLE，请求标记 stale，迟到 ack(true) 不改写结果', async () => {
    vi.useFakeTimers();
    const { details, dispose } = captureDetail();

    const pending = requestPdfPageFocus('tb_2', 3);
    expect(details).toHaveLength(1);
    expect(details[0].isStale?.()).toBe(false);

    await vi.advanceTimersByTimeAsync(PDF_FOCUS_ACK_TIMEOUT_MS);
    const result = await pending;
    expect(result).toMatchObject({ handled: false, code: 'ACTION_UNAVAILABLE' });

    // 超时后请求作废：viewer 兑现前检查到 stale 必须丢弃
    expect(details[0].isStale?.()).toBe(true);
    // 迟到的成功回执是幂等 no-op，且不解除 stale
    details[0].acknowledge?.(true);
    expect(details[0].isStale?.()).toBe(true);

    dispose();
  });

  it('监听方显式 ack(false)（如卸载）→ 立即失败且 stale，不等待超时', async () => {
    vi.useFakeTimers();
    const { details, dispose } = captureDetail();
    const ackFalse = (event: Event) => {
      (event as CustomEvent<PdfFocusEventDetail>).detail?.acknowledge?.(false);
    };
    document.addEventListener('pdf-ref:focus', ackFalse);

    const result = await requestPdfPageFocus('tb_3', 1);
    expect(result).toMatchObject({ handled: false, code: 'ACTION_UNAVAILABLE' });
    expect(details[0].isStale?.()).toBe(true);

    document.removeEventListener('pdf-ref:focus', ackFalse);
    dispose();
  });
});

describe('usePdfFocusListener 卸载回执', () => {
  it('卸载时对 pending ack 显式回 false（不再留给超时）', () => {
    const acked: boolean[] = [];
    const { result, unmount } = renderHook(() =>
      usePdfFocusListener({
        enabled: true,
        nodeId: 'node_1',
        nodeSourceId: 'tb_1',
        nodePath: '/tb_1',
        nodeName: 'book.pdf',
      }),
    );

    act(() => {
      document.dispatchEvent(new CustomEvent<PdfFocusEventDetail>('pdf-ref:focus', {
        detail: {
          sourceId: 'tb_1',
          pageNumber: 5,
          path: '/tb_1',
          acknowledge: (handled) => acked.push(handled),
        },
      }));
    });
    expect(result.current[0]).toMatchObject({ pageNumber: 5 });
    expect(acked).toEqual([]);

    unmount();
    expect(acked).toEqual([false]);
  });

  it('viewer 兑现（handleFocusHandled）回 ack(true)，卸载时不再重复回执', () => {
    const acked: boolean[] = [];
    const { result, unmount } = renderHook(() =>
      usePdfFocusListener({
        enabled: true,
        nodeId: 'node_1',
        nodeSourceId: 'tb_1',
        nodePath: '/tb_1',
        nodeName: 'book.pdf',
      }),
    );

    act(() => {
      document.dispatchEvent(new CustomEvent<PdfFocusEventDetail>('pdf-ref:focus', {
        detail: {
          sourceId: 'tb_1',
          pageNumber: 2,
          path: '/tb_1',
          acknowledge: (handled) => acked.push(handled),
        },
      }));
    });
    const request = result.current[0];
    expect(request).not.toBeNull();

    act(() => {
      result.current[1](request!.requestId);
    });
    expect(acked).toEqual([true]);
    expect(result.current[0]).toBeNull();

    unmount();
    // pending 表已被消费，卸载不再补发失败回执
    expect(acked).toEqual([true]);
  });

  it('isStale 随事件透传到 focusRequest（viewer 可在兑现前检查）', () => {
    const { result, unmount } = renderHook(() =>
      usePdfFocusListener({
        enabled: true,
        nodeId: 'node_1',
        nodeSourceId: 'tb_1',
        nodePath: '/tb_1',
        nodeName: 'book.pdf',
      }),
    );

    let stale = false;
    act(() => {
      document.dispatchEvent(new CustomEvent<PdfFocusEventDetail>('pdf-ref:focus', {
        detail: {
          sourceId: 'tb_1',
          pageNumber: 9,
          path: '/tb_1',
          isStale: () => stale,
        },
      }));
    });
    expect(result.current[0]?.isStale?.()).toBe(false);
    stale = true;
    expect(result.current[0]?.isStale?.()).toBe(true);
    unmount();
  });
});

/**
 * UnifiedDragDropZone 默认文件大小上限测试（#62）
 *
 * 证明拖拽区在未显式传入 maxFileSize 时，默认上限是 200MB
 * （ATTACHMENT_MAX_SIZE），而不是旧的 50MB 硬编码：
 * - 恰好 200MB 的文件通过校验并回调 onFilesDropped（旧 50MB 上限会拒绝）
 * - 200MB + 1B 的文件被拒绝并回调 onValidationError
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';

type DragDropHandler = (event: { payload: unknown }) => void;

/** 捕获组件注册的 Tauri onDragDropEvent 回调 */
const dragDropHandlers: DragDropHandler[] = [];
/** path → 后端 get_file_size 命令返回的文件大小 */
const fileSizeByPath = new Map<string, number>();

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: DragDropHandler) => {
      dragDropHandlers.push(handler);
      return () => undefined;
    },
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, payload?: Record<string, unknown>) => {
    if (command === 'get_file_size') {
      const path = String(payload?.path ?? '');
      const size = fileSizeByPath.get(path);
      if (size === undefined) throw new Error(`unexpected path: ${path}`);
      return size;
    }
    if (command === 'read_file_bytes') {
      return new ArrayBuffer(4);
    }
    return null;
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  ensureGlobalDragHandlers: vi.fn(),
  markNativeDrop: vi.fn(),
  isNativeDropRecent: () => false,
}));

import { UnifiedDragDropZone } from '../UnifiedDragDropZone';
import {
  ATTACHMENT_MAX_SIZE,
  FILE_SIZE_LIMIT as CORE_FILE_SIZE_LIMIT,
} from '@/features/chat/core/constants';
import { FILE_SIZE_LIMIT as RESOURCE_FILE_SIZE_LIMIT } from '@/features/chat/resources/types';

// ---------------------------------------------------------------------------
// JSDOM 可见性打桩：isDropZoneVisible 依赖 offsetWidth/offsetHeight 与
// getBoundingClientRect，JSDOM 默认全为 0 会让 drop 事件被静默丢弃。
// ---------------------------------------------------------------------------

const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  Element.prototype.getBoundingClientRect = function () {
    return {
      x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

afterAll(() => {
  if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
  if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

beforeEach(() => {
  dragDropHandlers.length = 0;
  fileSizeByPath.clear();
});

/** 通过 Tauri 原生拖拽路径投递文件（该路径经 get_file_size 做大小校验） */
async function dropPaths(paths: string[]) {
  await waitFor(() => expect(dragDropHandlers.length).toBeGreaterThan(0));
  const handler = dragDropHandlers[dragDropHandlers.length - 1];
  await act(async () => {
    handler({ payload: { type: 'drop', position: { x: 100, y: 100 }, paths } });
  });
}

function renderDefaultZone() {
  const onFilesDropped = vi.fn();
  const onValidationError = vi.fn();
  render(
    // 关键：不传 maxFileSize，验证默认值
    <UnifiedDragDropZone
      zoneId="default-max-size-test"
      onFilesDropped={onFilesDropped}
      onValidationError={onValidationError}
    >
      <div>drop here</div>
    </UnifiedDragDropZone>
  );
  return { onFilesDropped, onValidationError };
}

describe('UnifiedDragDropZone 默认 maxFileSize（#62）', () => {
  it('SSOT：ATTACHMENT_MAX_SIZE 为 200MB，各处 FILE_SIZE_LIMIT 与之对齐', () => {
    expect(ATTACHMENT_MAX_SIZE).toBe(200 * 1024 * 1024);
    expect(CORE_FILE_SIZE_LIMIT).toBe(ATTACHMENT_MAX_SIZE);
    expect(RESOURCE_FILE_SIZE_LIMIT).toBe(ATTACHMENT_MAX_SIZE);
  });

  it('默认上限放行恰好 200MB 的文件（旧 50MB 硬编码会拒绝）', async () => {
    const { onFilesDropped, onValidationError } = renderDefaultZone();
    fileSizeByPath.set('/tmp/exactly-200mb.pdf', ATTACHMENT_MAX_SIZE);

    await dropPaths(['/tmp/exactly-200mb.pdf']);

    await waitFor(() => expect(onFilesDropped).toHaveBeenCalledTimes(1));
    const files = onFilesDropped.mock.calls[0][0] as File[];
    expect(files.map((f) => f.name)).toEqual(['exactly-200mb.pdf']);
    expect(onValidationError).not.toHaveBeenCalled();
  });

  it('默认上限拒绝超过 200MB（200MB + 1B）的文件', async () => {
    const { onFilesDropped, onValidationError } = renderDefaultZone();
    fileSizeByPath.set('/tmp/over-200mb.pdf', ATTACHMENT_MAX_SIZE + 1);

    await dropPaths(['/tmp/over-200mb.pdf']);

    await waitFor(() => expect(onValidationError).toHaveBeenCalledTimes(1));
    const rejected = onValidationError.mock.calls[0][1] as string[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain('over-200mb.pdf');
    expect(onFilesDropped).not.toHaveBeenCalled();
  });
});

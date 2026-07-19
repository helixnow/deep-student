import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTauriDragAndDrop } from '@/hooks/useTauriDragAndDrop';
import {
  ATTACHMENT_ALLOWED_EXTENSIONS,
  ATTACHMENT_ALLOWED_TYPES,
} from '@/features/chat/core/constants';

let nativeDragDropHandler: ((event: { payload: { type: string; paths?: string[] } }) => void) | null = null;

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(async (handler) => {
      nativeDragDropHandler = handler;
      return () => {
        nativeDragDropHandler = null;
      };
    }),
  }),
}));

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string) => key,
  },
}));

function createDragEvent(types: string[]) {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget: document.createElement('div'),
    relatedTarget: null,
    dataTransfer: {
      types,
      files: [],
      items: [],
      dropEffect: 'none',
    },
  };
}

describe('useTauriDragAndDrop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeDragDropHandler = null;
  });

  it('ignores internal text drags when computing file drag state', () => {
    const { result } = renderHook(() =>
      useTauriDragAndDrop({
        dropZoneRef: { current: null } as React.RefObject<HTMLElement>,
        onDropFiles: vi.fn(),
      })
    );

    act(() => {
      result.current.dropZoneProps.onDragEnter(createDragEvent(['text/plain']) as unknown as React.DragEvent);
    });

    expect(result.current.isDragging).toBe(false);
  });

  it('marks the drop zone as dragging when files enter', () => {
    const { result } = renderHook(() =>
      useTauriDragAndDrop({
        dropZoneRef: { current: null } as React.RefObject<HTMLElement>,
        onDropFiles: vi.fn(),
      })
    );

    act(() => {
      result.current.dropZoneProps.onDragEnter(createDragEvent(['Files']) as unknown as React.DragEvent);
    });

    expect(result.current.isDragging).toBe(true);
  });

  it('ignores native tauri enter events without file paths', async () => {
    const dropZoneRef = { current: document.createElement('div') } as React.RefObject<HTMLElement>;
    Object.defineProperties(dropZoneRef.current, {
      offsetWidth: { configurable: true, value: 320 },
      offsetHeight: { configurable: true, value: 160 },
    });

    const { result } = renderHook(() =>
      useTauriDragAndDrop({
        dropZoneRef,
        onDropFiles: vi.fn(),
      })
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(nativeDragDropHandler).not.toBeNull();

    act(() => {
      nativeDragDropHandler?.({ payload: { type: 'enter' } });
    });

    expect(result.current.isDragging).toBe(false);
  });

  it('keeps picker validation aligned for audio, video, and archives', () => {
    expect(ATTACHMENT_ALLOWED_EXTENSIONS).toEqual(
      expect.arrayContaining(['mp3', 'mp4', 'zip', 'rar', '7z'])
    );
    expect(ATTACHMENT_ALLOWED_TYPES).toEqual(
      expect.arrayContaining([
        'audio/mpeg',
        'video/mp4',
        'application/zip',
        'application/vnd.rar',
        'application/x-7z-compressed',
      ])
    );
  });

  it('accepts audio, video, and archive files in the web fallback', async () => {
    const onDropFiles = vi.fn();
    const { result } = renderHook(() =>
      useTauriDragAndDrop({
        dropZoneRef: { current: null } as React.RefObject<HTMLElement>,
        onDropFiles,
      })
    );
    const files = [
      new File(['audio'], 'lecture.mp3', { type: 'audio/mpeg' }),
      new File(['video'], 'lesson.mp4', { type: 'video/mp4' }),
      new File(['PK'], 'materials.zip', { type: 'application/zip' }),
      new File(['bad'], 'program.exe', { type: 'application/octet-stream' }),
    ];

    await act(async () => {
      await result.current.dropZoneProps.onDrop({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        currentTarget: document.createElement('div'),
        dataTransfer: { files, types: ['Files'], items: [] },
      } as unknown as React.DragEvent);
    });

    expect(onDropFiles).toHaveBeenCalledTimes(1);
    expect(onDropFiles.mock.calls[0][0].map((file: File) => file.name)).toEqual([
      'lecture.mp3',
      'lesson.mp4',
      'materials.zip',
    ]);
  });
});

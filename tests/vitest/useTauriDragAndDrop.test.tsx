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

// 返回 key 并附带插值参数，便于断言用户可见文案走了 i18n key 而非硬编码
vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) => {
      const vars = Object.entries(options ?? {}).filter(([name]) => name !== 'defaultValue');
      if (vars.length === 0) return key;
      return `${key}{${vars.map(([name, value]) => `${name}=${String(value)}`).join(',')}}`;
    },
  },
}));

const showGlobalNotificationMock = vi.hoisted(() => vi.fn());
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: showGlobalNotificationMock,
}));

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
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

function createVisibleDropZoneRef(): React.RefObject<HTMLElement> {
  const element = document.createElement('div');
  Object.defineProperties(element, {
    offsetWidth: { configurable: true, value: 320 },
    offsetHeight: { configurable: true, value: 160 },
  });
  document.body.appendChild(element);
  return { current: element } as React.RefObject<HTMLElement>;
}

describe('useTauriDragAndDrop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockResolvedValue(null);
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

  it('surfaces unsupported-type rejections through drag_drop i18n keys instead of hardcoded Chinese', async () => {
    const dropZoneRef = createVisibleDropZoneRef();
    const onDropFiles = vi.fn();

    renderHook(() =>
      useTauriDragAndDrop({
        dropZoneRef,
        onDropFiles,
      })
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(nativeDragDropHandler).not.toBeNull();

    await act(async () => {
      nativeDragDropHandler?.({ payload: { type: 'drop', paths: ['C:\\downloads\\program.exe'] } });
    });
    await vi.waitFor(() => expect(showGlobalNotificationMock).toHaveBeenCalled());

    expect(onDropFiles).not.toHaveBeenCalled();
    const [type, message] = showGlobalNotificationMock.mock.calls.at(-1) as [string, string];
    expect(type).toBe('error');
    expect(message).toContain('drag_drop:errors.all_files_failed');
    expect(message).toContain('program.exe: drag_drop:errors.unsupported_type');
    expect(message).not.toContain('不支持的文件类型');
  });

  it('surfaces oversize rejections through drag_drop i18n keys with the size limit interpolated', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_file_size') return 10 * 1024 * 1024;
      if (command === 'read_file_bytes') return new ArrayBuffer(4);
      return null;
    });
    const dropZoneRef = createVisibleDropZoneRef();
    const onDropFiles = vi.fn();

    renderHook(() =>
      useTauriDragAndDrop({
        dropZoneRef,
        onDropFiles,
        maxFileSize: 2 * 1024 * 1024,
      })
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(nativeDragDropHandler).not.toBeNull();

    await act(async () => {
      nativeDragDropHandler?.({ payload: { type: 'drop', paths: ['/tmp/huge-notes.pdf'] } });
    });
    await vi.waitFor(() => expect(showGlobalNotificationMock).toHaveBeenCalled());

    expect(onDropFiles).not.toHaveBeenCalled();
    const [type, message] = showGlobalNotificationMock.mock.calls.at(-1) as [string, string];
    expect(type).toBe('error');
    expect(message).toContain('drag_drop:errors.all_files_failed');
    expect(message).toContain('huge-notes.pdf: drag_drop:errors.file_too_large{size=2.0}');
    expect(message).not.toContain('文件过大');
  });

  it('rejects images above 50MB even when the drop zone allows 200MB files', async () => {
    const readFileBytes = vi.fn(async () => new ArrayBuffer(4));
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_file_size') return 80 * 1024 * 1024;
      if (command === 'read_file_bytes') return readFileBytes();
      return null;
    });
    const dropZoneRef = createVisibleDropZoneRef();
    const onDropFiles = vi.fn();

    renderHook(() =>
      useTauriDragAndDrop({
        dropZoneRef,
        onDropFiles,
        maxFileSize: 200 * 1024 * 1024,
      })
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(nativeDragDropHandler).not.toBeNull();

    await act(async () => {
      nativeDragDropHandler?.({ payload: { type: 'drop', paths: ['/tmp/huge-photo.jpg'] } });
    });
    await vi.waitFor(() => expect(showGlobalNotificationMock).toHaveBeenCalled());

    expect(onDropFiles).not.toHaveBeenCalled();
    expect(readFileBytes).not.toHaveBeenCalled();
    const [type, message] = showGlobalNotificationMock.mock.calls.at(-1) as [string, string];
    expect(type).toBe('error');
    expect(message).toContain('huge-photo.jpg: drag_drop:errors.file_too_large{size=50.0}');
  });
});

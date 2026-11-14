import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTauriDragAndDrop } from '@/hooks/useTauriDragAndDrop';

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

vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

// Workbench windows live in a layer with `pointer-events: none` and restore `auto` on the window.
function dropZoneInWindowLayer(zonePointerEvents: string): React.RefObject<HTMLElement> {
  const layer = document.createElement('div');
  layer.style.pointerEvents = 'none';
  const zone = document.createElement('div');
  zone.style.pointerEvents = zonePointerEvents;
  Object.defineProperties(zone, {
    offsetWidth: { configurable: true, value: 640 },
    offsetHeight: { configurable: true, value: 120 },
  });
  layer.appendChild(zone);
  document.body.appendChild(layer);
  return { current: zone } as React.RefObject<HTMLElement>;
}

describe('B11 drop zone visibility inside workbench window layers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeDragDropHandler = null;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_file_size') return 4;
      if (cmd === 'read_file_bytes') return new Uint8Array([1, 2, 3, 4]).buffer;
      return null;
    });
  });

  it('accepts drops on a zone that restores pointer events under a none layer', async () => {
    const onDropFiles = vi.fn();
    renderHook(() => useTauriDragAndDrop({ dropZoneRef: dropZoneInWindowLayer('auto'), onDropFiles }));
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      nativeDragDropHandler?.({ payload: { type: 'drop', paths: ['/tmp/opencode/notes.txt'] } });
    });

    await vi.waitFor(() => expect(onDropFiles).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith('read_file_bytes', { path: '/tmp/opencode/notes.txt' });
  });

  it('still ignores drops when the zone itself has pointer events disabled', async () => {
    const onDropFiles = vi.fn();
    renderHook(() => useTauriDragAndDrop({ dropZoneRef: dropZoneInWindowLayer('none'), onDropFiles }));
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      nativeDragDropHandler?.({ payload: { type: 'drop', paths: ['/tmp/opencode/notes.txt'] } });
    });
    await act(async () => { await Promise.resolve(); });

    expect(onDropFiles).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

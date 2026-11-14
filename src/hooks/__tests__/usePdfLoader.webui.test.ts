import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({ debugLog: { warn: vi.fn() } }));

import { usePdfLoader } from '../usePdfLoader';

describe('usePdfLoader mobile WebUI streaming', () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.stubGlobal('navigator', { platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', maxTouchPoints: 5 });
    vi.stubGlobal('__DS_WEBUI__', true);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('resolves a streamable blob without reading the entire PDF through IPC', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'vfs_get_file_blob_path') return '/data/pdf.bin';
      if (cmd === 'pdfstream_check_access') return { available: true };
      if (cmd === 'get_file_size') return 464616;
      throw new Error(`Unexpected whole-file fallback: ${cmd}`);
    });
    const { result } = renderHook(() => usePdfLoader({ nodeId: 'file_webui', fileName: 'test.pdf' }));
    await waitFor(() => expect(result.current.loadSource).toBe('stream'));
    expect(result.current.filePath).toBe('/data/pdf.bin');
    expect(result.current.file).toBeNull();
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
      'vfs_get_file_blob_path', 'pdfstream_check_access', 'get_file_size',
    ]);
  });

  it('ignores late document completions after switching or unmounting without creating blob URLs', async () => {
    let finishOld!: (value: string) => void;
    const createUrl = vi.fn();
    vi.stubGlobal('URL', class extends URL { static createObjectURL = createUrl; });
    invoke.mockImplementation(async (cmd: string, args: { id?: string }) => {
      if (cmd === 'vfs_get_file_blob_path') {
        if (args.id === 'old') return new Promise<string>((resolve) => { finishOld = resolve; });
        return '/data/new.pdf';
      }
      if (cmd === 'pdfstream_check_access') return { available: true };
      if (cmd === 'get_file_size') return 123;
      throw new Error(cmd);
    });
    const { result, rerender, unmount } = renderHook(({ id }) => usePdfLoader({ nodeId: id, fileName: `${id}.pdf` }),
      { initialProps: { id: 'old' } });
    rerender({ id: 'new' });
    await waitFor(() => expect(result.current.filePath).toBe('/data/new.pdf'));
    unmount();
    await act(async () => { finishOld('/data/old.pdf'); });
    expect(createUrl).not.toHaveBeenCalled();
  });
});

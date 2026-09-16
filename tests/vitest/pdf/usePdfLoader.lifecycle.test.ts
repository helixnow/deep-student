import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { clearPdfCache, usePdfLoader, type UsePdfLoaderOptions } from '@/hooks/usePdfLoader';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));

const invokeMock = vi.mocked(invoke);
const content = { found: true, content: btoa('%PDF-1.4\nfirst') };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function renderLoader(options: UsePdfLoaderOptions = { nodeId: 'a', fileName: 'a.pdf' }) {
  return renderHook(props => usePdfLoader(props), { initialProps: options });
}

describe('usePdfLoader request ownership', () => {
  beforeEach(() => {
    clearPdfCache();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async command => {
      if (command === 'vfs_get_file_blob_path') return null;
      if (command === 'vfs_get_attachment_content') return content;
      if (command === 'get_file_size') return 100;
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  it('hides the old stream and ignores its size while resolving the next resource', async () => {
    const size = deferred<number>();
    const path = deferred<string | null>();
    invokeMock.mockImplementation(async command => {
      if (command === 'get_file_size') return size.promise;
      if (command === 'vfs_get_file_blob_path') return path.promise;
      if (command === 'vfs_get_attachment_content') return content;
      throw new Error(`Unexpected command: ${command}`);
    });
    const { result, rerender } = renderLoader({ nodeId: 'a', fileName: 'a.pdf', filePath: '/a.pdf' });
    await waitFor(() => expect(result.current.loadSource).toBe('stream'));
    rerender({ nodeId: 'b', fileName: 'b.pdf' });
    expect(result.current.filePath).toBeUndefined();
    expect(result.current.file).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => { size.resolve(25 * 1024 * 1024); });
    expect(result.current.fileSize).toBe(0);
    expect(result.current.isLargeFile).toBe(false);
    await act(async () => { path.resolve(null); });
    await waitFor(() => expect(result.current.file?.name).toBe('b.pdf'));
  });

  it('discards late memory results and failures after switching resources', async () => {
    const first = deferred<typeof content>();
    const nextPath = deferred<string | null>();
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'vfs_get_file_blob_path') {
        return (args as { id: string }).id === 'a' ? null : nextPath.promise;
      }
      if (command === 'vfs_get_attachment_content') return first.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    const { result, rerender } = renderLoader();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'vfs_get_attachment_content', { attachmentId: 'a' },
    ));
    rerender({ nodeId: 'b', fileName: 'b.pdf' });
    await act(async () => { first.resolve(content); });
    expect(result.current.file).toBeNull();
    expect(result.current.loadSource).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('retries both path discovery and content instead of reusing the failed cached file', async () => {
    const { result } = renderLoader();
    await waitFor(() => expect(result.current.file).not.toBeNull());
    const original = result.current.file;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.file).not.toBeNull());
    expect(result.current.file).not.toBe(original);
    expect(invokeMock.mock.calls.filter(([command]) => command === 'vfs_get_file_blob_path')).toHaveLength(2);
    expect(invokeMock.mock.calls.filter(([command]) => command === 'vfs_get_attachment_content')).toHaveLength(2);
  });

  it('does not share cached content between resources with the same version key', async () => {
    const { result, rerender } = renderLoader({ nodeId: 'a', fileName: 'a.pdf', cacheKey: 'v1' });
    await waitFor(() => expect(result.current.file).not.toBeNull());
    rerender({ nodeId: 'b', fileName: 'b.pdf', cacheKey: 'v1' });
    await waitFor(() => expect(result.current.file?.name).toBe('b.pdf'));
    expect(invokeMock).toHaveBeenCalledWith('vfs_get_attachment_content', { attachmentId: 'b' });
  });

  it('clears disabled state and does not retry or publish an outstanding stream result', async () => {
    const size = deferred<number>();
    invokeMock.mockReturnValue(size.promise);
    const { result, rerender } = renderLoader({ nodeId: 'a', fileName: 'a.pdf', filePath: '/a.pdf' });
    await waitFor(() => expect(result.current.loadSource).toBe('stream'));
    rerender({ nodeId: 'a', fileName: 'a.pdf', filePath: '/a.pdf', enabled: false });
    const calls = invokeMock.mock.calls.length;
    act(() => result.current.retry());
    await act(async () => { size.resolve(25 * 1024 * 1024); });
    expect(result.current).toMatchObject({
      file: null, filePath: undefined, loading: false, fileSize: 0,
      loadSource: null, error: null, isLargeFile: false,
    });
    expect(invokeMock).toHaveBeenCalledTimes(calls);
  });

  it('invalidates blob path discovery when the resource version changes', async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'vfs_get_file_blob_path') return '/version-1.pdf';
      if (command === 'pdfstream_check_access') return { available: true };
      if (command === 'get_file_size') return (args as { path: string }).path.length;
      throw new Error(`Unexpected command: ${command}`);
    });
    const { result, rerender } = renderLoader({ nodeId: 'a', fileName: 'a.pdf', cacheKey: 'v1' });
    await waitFor(() => expect(result.current.filePath).toBe('/version-1.pdf'));
    invokeMock.mockImplementation(async command => {
      if (command === 'vfs_get_file_blob_path') return '/version-2.pdf';
      if (command === 'pdfstream_check_access') return { available: true };
      if (command === 'get_file_size') return 200;
      throw new Error(`Unexpected command: ${command}`);
    });
    rerender({ nodeId: 'a', fileName: 'a.pdf', cacheKey: 'v2' });
    await waitFor(() => expect(result.current.filePath).toBe('/version-2.pdf'));
  });
});

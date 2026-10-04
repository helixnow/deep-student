import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  createByteBudgetLimiter,
  shouldUseStagedUpload,
  stageBlobUpload,
  STAGED_UPLOAD_THRESHOLD,
} from '../stagedUpload';

function makeBlob(size: number): Blob {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = i % 251;
  return new Blob([bytes]);
}

describe('stagedUpload', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('routes only large files through staging', () => {
    expect(shouldUseStagedUpload(STAGED_UPLOAD_THRESHOLD)).toBe(false);
    expect(shouldUseStagedUpload(STAGED_UPLOAD_THRESHOLD + 1)).toBe(true);
  });

  it('sends raw binary chunks with id/offset headers on desktop', async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === 'staged_upload_begin' ? 'u1' : 0));
    const progress: number[] = [];
    const id = await stageBlobUpload(makeBlob(10), {
      name: 'a.bin',
      android: false,
      chunkSize: 4,
      onProgress: (loaded) => progress.push(loaded),
    });
    expect(id).toBe('u1');
    expect(invokeMock.mock.calls[0]).toEqual(['staged_upload_begin', { name: 'a.bin', totalSize: 10 }]);
    const appends = invokeMock.mock.calls.filter(([cmd]) => cmd === 'staged_upload_append');
    expect(appends).toHaveLength(3);
    expect(appends.map(([, body]) => (body as Uint8Array).length)).toEqual([4, 4, 2]);
    expect(appends.map(([, , opts]) => opts.headers['x-upload-offset'])).toEqual(['0', '4', '8']);
    expect(appends.every(([, , opts]) => opts.headers['x-upload-id'] === 'u1')).toBe(true);
    expect(progress).toEqual([4, 8, 10]);
  });

  it('sends base64 JSON chunks on Android', async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === 'staged_upload_begin' ? 'u2' : 0));
    await stageBlobUpload(new Blob([new Uint8Array([1, 2, 3, 4, 5])]), {
      name: 'b', android: true, chunkSize: 3,
    });
    const appends = invokeMock.mock.calls.filter(([cmd]) => cmd === 'staged_upload_append');
    expect(appends.map(([, body]) => body)).toEqual([
      { uploadId: 'u2', offset: 0, data: 'AQID' },
      { uploadId: 'u2', offset: 3, data: 'BAU=' },
    ]);
  });

  it('aborts the staged upload on chunk failure', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'staged_upload_begin') return 'u3';
      if (cmd === 'staged_upload_append') throw new Error('disk full');
      return undefined;
    });
    await expect(stageBlobUpload(makeBlob(8), { name: 'c', android: false, chunkSize: 4 }))
      .rejects.toThrow('disk full');
    expect(invokeMock).toHaveBeenCalledWith('staged_upload_abort', { uploadId: 'u3' });
  });

  it('stops and aborts when the signal fires', async () => {
    const controller = new AbortController();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'staged_upload_begin') return 'u4';
      if (cmd === 'staged_upload_append') controller.abort();
      return 0;
    });
    await expect(stageBlobUpload(makeBlob(12), {
      name: 'd', android: false, chunkSize: 4, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'staged_upload_append')).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith('staged_upload_abort', { uploadId: 'u4' });
  });

  it('byte budget limiter caps concurrent bytes but never starves a large task', async () => {
    const run = createByteBudgetLimiter(10);
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const task = (label: string) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${label}`);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return label;
    };
    const results = await Promise.all([
      run(6, task('a')),
      run(6, task('b')),
      run(50, task('huge')),
      run(2, task('c')),
    ]);
    expect(results).toEqual(['a', 'b', 'huge', 'c']);
    expect(maxActive).toBe(1);
    expect(order[0]).toBe('start:a');

    const parallel = createByteBudgetLimiter(10);
    let concurrent = 0;
    let peak = 0;
    await Promise.all([1, 2, 3].map(() => parallel(3, async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent -= 1;
    })));
    expect(peak).toBe(3);
  });
});

import { mkdtemp, open, readdir, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createNodeFiles } from '../index.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

let root: string;
let handle: FileHandle | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'files-stream-cleanup-'));
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it.each(['overwrite', 'append', 'exclusive', 'atomic'] as const)('closes a failed %s write stream, including when piped', async (mode) => {
  const target = join(root, 'out.txt');
  if (mode === 'atomic') await writeFile(target, 'original');
  const realOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
  const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    handle = await realOpen(...args);
    vi.spyOn(handle, 'write').mockRejectedValue(failure);
    return handle;
  });
  const service = createNodeFiles({ roots: [{ name: 'appData', path: root }] });
  const output = await service.openWrite(target, { mode });
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Uint8Array.of(1)); controller.close(); },
  });
  await expect(source.pipeTo(output)).rejects.toMatchObject({ kind: 'StorageFull', cause: failure });
  expect(handle!.fd).toBe(-1);
  if (mode === 'atomic') {
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(await readdir(root)).toEqual(['out.txt']);
  }
});

it('closes the atomic handle and discards its temp file when sync fails', async () => {
  const target = join(root, 'out.txt');
  await writeFile(target, 'original');
  const realOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
  const failure = Object.assign(new Error('sync failed'), { code: 'EIO' });
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    handle = await realOpen(...args);
    vi.spyOn(handle, 'sync').mockRejectedValue(failure);
    return handle;
  });
  const service = createNodeFiles({ roots: [{ name: 'appData', path: root }] });
  const writer = (await service.openWrite(target, { mode: 'atomic' })).getWriter();
  await writer.write(Uint8Array.of(1));
  await expect(writer.close()).rejects.toMatchObject({ kind: 'Other', cause: failure });
  expect(handle!.fd).toBe(-1);
  expect(await readFile(target, 'utf8')).toBe('original');
  expect(await readdir(root)).toEqual(['out.txt']);
});

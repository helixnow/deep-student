import { describe, expect, it } from 'vitest';
import { MobileLocalRuntime, beginMobileStagedUpload, appendMobileStagedUpload, abortMobileStagedUpload } from '../mobile-local-runtime.ts';
import type { FilesService } from '../api.ts';

describe('mobile staged uploads', () => {
  it.each(['document.pdf', 'audio.mp3', 'video.mp4'])('consumes >8 MiB %s across chunks and exposes a media-readable path', name => {
    const tree = new MobileLocalRuntime('/app', () => undefined);
    const bytes = new Uint8Array(9 * 1024 * 1024).fill(37);
    const id = beginMobileStagedUpload(name, bytes.length);
    expect(appendMobileStagedUpload(id, 0, bytes.subarray(0, 4 * 1024 * 1024))).toBe(4 * 1024 * 1024);
    expect(appendMobileStagedUpload(id, 4 * 1024 * 1024, bytes.subarray(4 * 1024 * 1024))).toBe(bytes.length);
    const staged = tree.views().vfs.takeStagedUpload(id);
    expect(staged.name()).toBe(name);
    expect(staged.size()).toBe(bytes.length);
    expect(tree.fileLen(staged.path())).toBe(bytes.length);
    expect(staged.readBounded(bytes.length).every(byte => byte === 37)).toBe(true);
    expect(() => staged.readBounded(8 * 1024 * 1024)).toThrow('File too large');
    expect(() => tree.views().vfs.takeStagedUpload(id)).toThrow('Unknown');
    staged.dispose();
    expect(tree.exists(staged.path())).toBe(false);
  });

  it('decodes Android base64 and rejects incomplete, aborted and out-of-order uploads', () => {
    const tree = new MobileLocalRuntime('/app', () => undefined);
    const id = beginMobileStagedUpload('a.pdf', 3);
    expect(() => appendMobileStagedUpload(id, 1, 'AQID')).toThrow('Unexpected chunk offset');
    expect(appendMobileStagedUpload(id, 0, 'AQID')).toBe(3);
    const staged = tree.views().vfs.takeStagedUpload(id);
    expect([...staged.readBounded(3)]).toEqual([1, 2, 3]);
    staged.dispose();
    const incomplete = beginMobileStagedUpload('b.pdf', 3);
    expect(() => tree.views().vfs.takeStagedUpload(incomplete)).toThrow('Upload incomplete');
    const aborted = beginMobileStagedUpload('c.pdf', 3);
    abortMobileStagedUpload(aborted);
    abortMobileStagedUpload(aborted);
    expect(() => tree.views().vfs.takeStagedUpload(aborted)).toThrow('Unknown');
  });
});

function fakeFiles(store: Map<string, Uint8Array>): Partial<FilesService> {
  const dirs = new Set<string>(['/']);
  const ensure = (path: string): void => {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) { current += `/${part}`; dirs.add(current); }
  };
  return {
    exists: async (path: string) => store.has(path) || dirs.has(path)
      || [...store.keys()].some(key => key.startsWith(`${path}/`)),
    readBytes: async (path: string) => {
      const bytes = store.get(path);
      if (bytes === undefined) throw new Error(`missing ${path}`);
      return bytes.slice();
    },
    writeBytes: async (path: string, data: Uint8Array) => { ensure(path); store.set(path, data.slice()); },
    mkdir: async (path: string) => { ensure(path); },
    rm: async (path: string, options?: { recursive?: boolean }) => {
      for (const key of [...store.keys()]) {
        if (key === path || (options?.recursive === true && key.startsWith(`${path}/`))) store.delete(key);
      }
    },
    rename: async (from: string, to: string) => {
      const bytes = store.get(from);
      if (bytes !== undefined) { store.delete(from); store.set(to, bytes); }
    },
    copyFile: async (from: string, to: string) => {
      const bytes = store.get(from);
      if (bytes !== undefined) store.set(to, bytes.slice());
    },
    append: async (path: string, data: Uint8Array) => {
      const existing = store.get(path) ?? new Uint8Array(0);
      const next = new Uint8Array(existing.byteLength + data.byteLength);
      next.set(existing, 0); next.set(data, existing.byteLength); store.set(path, next);
    },
    async *walk(root: string) {
      for (const [path, bytes] of store.entries()) {
        if (path === root || path.startsWith(`${root}/`)) {
          yield { name: path.split('/').pop()!, path, kind: 'file' as const,
            relativePath: path.slice(root.length), depth: 1 };
        }
      }
    },
  };
}

function runtime(): MobileLocalRuntime {
  const store = new Map<string, Uint8Array>();
  const files = fakeFiles(store) as FilesService;
  return new MobileLocalRuntime('/deep-student', () => files);
}

describe('mobile local runtime', () => {
  it('serves synchronous writes, reads, renames and deletes', () => {
    const r = runtime();
    r.writeBytes('/deep-student/notes_assets/a.txt', new TextEncoder().encode('hello'));
    expect(r.exists('/deep-student/notes_assets/a.txt')).toBe(true);
    expect(r.isFile('/deep-student/notes_assets/a.txt')).toBe(true);
    expect(r.isDir('/deep-student/notes_assets')).toBe(true);
    expect(r.fileLen('/deep-student/notes_assets/a.txt')).toBe(5);
    expect(r.readText('/deep-student/notes_assets/a.txt')).toBe('hello');
    expect(r.readDirNames('/deep-student/notes_assets')).toEqual(['a.txt']);
    r.rename('/deep-student/notes_assets/a.txt', '/deep-student/notes_assets/b.txt');
    expect(r.exists('/deep-student/notes_assets/a.txt')).toBe(false);
    expect(r.readText('/deep-student/notes_assets/b.txt')).toBe('hello');
    r.removeForce('/deep-student/notes_assets/b.txt');
    expect(r.exists('/deep-student/notes_assets/b.txt')).toBe(false);
  });

  it('hydrates files from OPFS on demand', async () => {
    const store = new Map<string, Uint8Array>();
    store.set('/deep-student/slots/slotA/vfs_blobs/abc.pdf', new TextEncoder().encode('pdf'));
    const files = fakeFiles(store) as FilesService;
    const r = new MobileLocalRuntime('/deep-student', () => files);
    await r.startHydration();
    expect(r.isHydrated).toBe(true);
    expect(r.readText('/deep-student/slots/slotA/vfs_blobs/abc.pdf')).toBe('pdf');
    expect(r.readDirNames('/deep-student/slots/slotA/vfs_blobs')).toEqual(['abc.pdf']);
  });
});

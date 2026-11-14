/**
 * original_path containment across path flavours. Rust compares with `Path::starts_with`
 * (attachment_repo.rs:462-506), i.e. per component and per platform; Windows `canonicalize`
 * yields `C:\…`, so a `/`-only prefix check rejects every legitimate blob/slot path there.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { posix, win32 } from 'node:path';
import {
  isInside,
  rustComponents,
  rustIsAbsolute,
  rustParent,
  type AttachmentPathPlatform,
} from '../repository/attachment-utils.ts';
import { AttachmentRepo } from '../repository/attachments.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';

const WIN_SLOT = 'C:\\Users\\Bob\\AppData\\Local\\com.deepstudent.app\\slots\\slotA';
const WIN_BLOBS = `${WIN_SLOT}\\vfs_blobs`;

/**
 * Minimal Windows filesystem: realpath normalises separators, resolves case-insensitively
 * to the stored casing (as `GetFinalPathNameByHandleW` does) and follows symlinks.
 */
function fakeWindowsFs(entries: { dirs: string[]; files: string[]; links?: Record<string, string> }): AttachmentPathPlatform {
  const canonical = new Map<string, { path: string; file: boolean }>();
  for (const dir of entries.dirs) canonical.set(win32.normalize(dir).toLowerCase(), { path: win32.normalize(dir), file: false });
  for (const file of entries.files) canonical.set(win32.normalize(file).toLowerCase(), { path: win32.normalize(file), file: true });
  const links = new Map(Object.entries(entries.links ?? {}).map(([from, to]) => [win32.normalize(from).toLowerCase(), to]));
  const resolve = (value: string) => {
    const key = win32.resolve('C:\\', value).toLowerCase();
    const target = links.get(key);
    return canonical.get((target === undefined ? key : win32.normalize(target)).toLowerCase()) ?? null;
  };
  return {
    path: win32,
    canonicalize: (value) => resolve(value)?.path ?? null,
    isFile: (value) => resolve(value)?.file === true,
  };
}

describe('Rust Path semantics per flavour', () => {
  it('isInside compares whole components on Windows paths', () => {
    expect(isInside(`${WIN_BLOBS}\\ab\\cd.bin`, WIN_BLOBS, win32)).toBe(true);
    expect(isInside(WIN_BLOBS, WIN_BLOBS, win32)).toBe(true);
    expect(isInside(`${WIN_BLOBS}\\`, WIN_BLOBS, win32)).toBe(true);
    expect(isInside(`${WIN_SLOT}\\vfs_blobs2\\x.bin`, WIN_BLOBS, win32)).toBe(false);
    expect(isInside(`${WIN_SLOT}\\textbooks\\a.pdf`, WIN_BLOBS, win32)).toBe(false);
    expect(isInside('D:\\Users\\Bob\\AppData\\Local\\com.deepstudent.app\\slots\\slotA\\vfs_blobs\\x', WIN_BLOBS, win32)).toBe(false);
  });

  it('Windows drive letters are case-insensitive, separators interchangeable, other components exact', () => {
    expect(isInside(`c:${WIN_BLOBS.slice(2)}\\x.bin`, WIN_BLOBS, win32)).toBe(true);
    expect(isInside(`${WIN_BLOBS.replaceAll('\\', '/')}/x.bin`, WIN_BLOBS, win32)).toBe(true);
    expect(isInside(`${WIN_BLOBS.toLowerCase()}\\x.bin`, WIN_BLOBS, win32)).toBe(false);
    expect(isInside('C:relative\\x', 'C:\\relative', win32)).toBe(false);
  });

  it('UNC roots are compared as a whole prefix', () => {
    expect(isInside('\\\\nas\\share\\ds\\slots\\slotA\\x', '\\\\nas\\share\\ds', win32)).toBe(true);
    expect(isInside('\\\\nas\\other\\ds\\slots\\slotA\\x', '\\\\nas\\share\\ds', win32)).toBe(false);
  });

  it('posix flavour keeps the previous behaviour and treats backslash as a name character', () => {
    expect(isInside('/a/b/c', '/a/b', posix)).toBe(true);
    expect(isInside('/a/b', '/a/b/', posix)).toBe(true);
    expect(isInside('/a/bc', '/a/b', posix)).toBe(false);
    expect(isInside('/a/b\\c', '/a/b', posix)).toBe(false);
    expect(isInside('//a//b///c', '/a/b', posix)).toBe(true);
  });

  it('rustParent mirrors Path::parent on both flavours', () => {
    expect(rustParent(`${WIN_BLOBS}\\`, win32)).toBe(WIN_SLOT);
    expect(rustParent('C:\\x', win32)).toBe('C:\\');
    expect(rustParent('C:\\', win32)).toBeNull();
    expect(rustParent('C:/a/b', win32)).toBe('C:/a');
    expect(rustParent('/a/b/', posix)).toBe('/a');
    expect(rustParent('/a', posix)).toBe('/');
    expect(rustParent('/', posix)).toBeNull();
    expect(rustParent('a', posix)).toBe('');
    expect(rustParent('/a/b/.', posix)).toBe('/a');
  });

  it('rustIsAbsolute follows the flavour (Windows needs prefix + root)', () => {
    expect(rustIsAbsolute('C:\\x', win32)).toBe(true);
    expect(rustIsAbsolute('c:/x', win32)).toBe(true);
    expect(rustIsAbsolute('\\\\nas\\share\\x', win32)).toBe(true);
    expect(rustIsAbsolute('C:x', win32)).toBe(false);
    expect(rustIsAbsolute('\\x', win32)).toBe(false);
    expect(rustIsAbsolute('/x', win32)).toBe(false);
    expect(rustIsAbsolute('/x', posix)).toBe(true);
    expect(rustIsAbsolute('C:\\x', posix)).toBe(false);
  });

  it('rustComponents collapses separators and drops non-leading dots', () => {
    expect(rustComponents('c:/a//./b\\', win32)).toEqual(['C:\\', 'a', 'b']);
    expect(rustComponents('./a/./b', posix)).toEqual(['.', 'a', 'b']);
  });
});

describe('AttachmentRepo original_path on Windows', () => {
  const textbook = `${WIN_SLOT}\\textbooks\\Lecture 1.pptx`;
  const blob = `${WIN_BLOBS}\\ab\\cd\\abcdef.bin`;
  const image = `${WIN_SLOT}\\images\\figure.png`;
  const outside = 'C:\\Users\\Bob\\Documents\\secret.docx';
  const leak = `${WIN_SLOT}\\textbooks\\leak.docx`;
  const fs = fakeWindowsFs({
    dirs: [WIN_SLOT, WIN_BLOBS, `${WIN_BLOBS}\\ab\\cd`, `${WIN_SLOT}\\textbooks`, `${WIN_SLOT}\\images`, 'C:\\Users\\Bob\\Documents'],
    files: [textbook, blob, image, outside],
    links: { [leak]: outside },
  });
  const repo = new AttachmentRepo(null, fs);

  it('accepts canonical files inside blobs, textbooks and other slot directories', () => {
    expect(repo.isSafeOriginalPath(WIN_BLOBS, blob)).toBe(true);
    expect(repo.isSafeOriginalPath(WIN_BLOBS, textbook)).toBe(true);
    expect(repo.isSafeOriginalPath(WIN_BLOBS, image)).toBe(true);
    expect(repo.isSafeOriginalPath(WIN_BLOBS, textbook.toLowerCase())).toBe(true);
  });

  it('accepts a not-yet-present file whose parent is inside the slot', () => {
    expect(repo.isSafeOriginalPath(WIN_BLOBS, `${WIN_SLOT}\\textbooks\\restored-later.pdf`)).toBe(true);
    expect(repo.isSafeOriginalPath(WIN_BLOBS, `${WIN_BLOBS}\\ab\\cd\\pending.bin`)).toBe(true);
  });

  it('rejects files outside the slot and symlinks resolving outside', () => {
    expect(repo.isSafeOriginalPath(WIN_BLOBS, outside)).toBe(false);
    expect(repo.isSafeOriginalPath(WIN_BLOBS, leak)).toBe(false);
    expect(repo.isSafeOriginalPath(WIN_BLOBS, 'C:\\Users\\Bob\\Documents\\missing.pdf')).toBe(false);
    expect(repo.isSafeOriginalPath(WIN_BLOBS, `${WIN_SLOT}\\..\\slotB\\x.pdf`)).toBe(false);
  });

  it('treats C:\\ paths as absolute candidates and resolves them', () => {
    expect(repo.buildOriginalPathCandidates(WIN_BLOBS, textbook)[0]).toBe(textbook);
    expect(repo.resolveOriginalPath(WIN_BLOBS, 'att_win', textbook)).toBe(textbook);
    expect(repo.resolveOriginalPath(WIN_BLOBS, 'att_win', leak)).toBeNull();
  });

  it('remaps a path recorded by another Windows profile into the current slot', () => {
    const foreign = 'D:\\Users\\Alice\\AppData\\Local\\com.deepstudent.app\\slots\\slotB\\textbooks\\Lecture 1.pptx';
    expect(repo.resolveOriginalPath(WIN_BLOBS, 'att_win', foreign)).toBe(textbook);
  });

  it('RF-W07-attachment-foreign-original-path: remaps a macOS original_path restored on Windows', () => {
    const mac = '/Users/alice/Library/Application Support/com.deepstudent.app/slots/slotA/textbooks/Lecture 1.pptx';
    expect(repo.resolveOriginalPath(WIN_BLOBS, 'att_mac', mac)).toBe(textbook);
  });

  it('resolves relative original_path against the slot root and the blobs dir', () => {
    expect(repo.buildOriginalPathCandidates(WIN_BLOBS, 'textbooks\\Lecture 1.pptx')).toEqual([
      textbook,
      `${WIN_BLOBS}\\textbooks\\Lecture 1.pptx`,
    ]);
    expect(repo.resolveOriginalPath(WIN_BLOBS, 'att_rel', 'images/figure.png')).toBe(image);
  });
});

describe('AttachmentRepo.getContentSource falls back to a Windows original_path', { timeout: 120_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  beforeEach(async () => {
    ({ root, storage } = await createVfsTestStorage('w07-attachment-win-'));
  }, 120_000);
  afterEach(() => {
    storage?.dispose();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('serves the file when resources.data holds a path (attachments.ts fallback branch)', () => {
    const textbook = `${WIN_SLOT}\\textbooks\\notes.pdf`;
    const repo = new AttachmentRepo(null, fakeWindowsFs({
      dirs: [WIN_SLOT, WIN_BLOBS, `${WIN_SLOT}\\textbooks`],
      files: [textbook],
    }));
    const db = storage.database('vfs');
    const ts = '2026-11-07T00:00:00Z';
    db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
      VALUES ('res_win', 'h-win', 'file', 'external', ?1, 1, 0, 0)`, [textbook]);
    db.run(`INSERT INTO files (id, resource_id, sha256, file_name, original_path, mime_type, type, size, created_at, updated_at)
      VALUES ('att_win', 'res_win', 'sha-win', 'notes.pdf', ?1, 'application/pdf', 'document', 3, ?2, ?2)`, [textbook, ts]);
    db.run(`INSERT INTO files (id, sha256, file_name, original_path, mime_type, type, size, created_at, updated_at)
      VALUES ('att_win_nores', 'sha-win2', 'notes.pdf', ?1, 'application/pdf', 'document', 3, ?2, ?2)`, [textbook, ts]);

    expect(repo.getContentSource(db, WIN_BLOBS, 'att_win')).toEqual({ kind: 'file', path: textbook });
    expect(repo.getContentSource(db, WIN_BLOBS, 'att_win_nores')).toEqual({ kind: 'file', path: textbook });
  });
});

describe('AttachmentRepo original_path on the host filesystem', () => {
  let scratch: string;
  beforeEach(() => { scratch = mkdtempSync(path.join(tmpdir(), 'w07-attachment-native-')); });
  afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

  it('rejects a sibling directory sharing the slot name as a string prefix', () => {
    const slot = path.join(scratch, 'slotA');
    const blobs = path.join(slot, 'vfs_blobs');
    const sibling = path.join(scratch, 'slotA-evil');
    mkdirSync(blobs, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(path.join(sibling, 'x.pdf'), 'x');
    expect(new AttachmentRepo().isSafeOriginalPath(blobs, path.join(sibling, 'x.pdf'))).toBe(false);
  });

  it('RF-W07-attachment-foreign-original-path: remaps a Windows original_path restored on this host', () => {
    const slot = path.join(scratch, 'slots', 'slotA');
    const blobs = path.join(slot, 'vfs_blobs');
    mkdirSync(blobs, { recursive: true });
    mkdirSync(path.join(slot, 'textbooks'), { recursive: true });
    writeFileSync(path.join(slot, 'textbooks', 'a.pptx'), 'pptx');
    const foreign = 'C:\\Users\\bob\\AppData\\Local\\com.deepstudent.app\\slots\\slotB\\textbooks\\a.pptx';
    const resolved = new AttachmentRepo().resolveOriginalPath(blobs, 'att_foreign', foreign);
    expect(resolved).not.toBeNull();
    expect(path.basename(resolved!)).toBe('a.pptx');
  });
});

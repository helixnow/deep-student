/** 外部文件拖放消息校验（SEC-E10，`electron/shell/drag-drop.ts`）。 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkDragDrop, MAX_DROPPED_PATH_LENGTH, MAX_DROPPED_PATHS, type DragDropContext } from '../shell/drag-drop.ts';

const tmp = mkdtempSync(join(tmpdir(), 'dstu-drag-drop-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const dir = join(tmp, 'folder');
const file = join(tmp, 'note.md');
mkdirSync(dir);
writeFileSync(file, 'x');
const posixOnly = process.platform === 'win32' ? it.skip : it;

const enabled: DragDropContext = { dragDropEnabled: true, topFrame: true, platform: process.platform };

describe('checkDragDrop', () => {
  it('a drop of existing files and folders is accepted with each kind and the position', () => {
    expect(checkDragDrop({ phase: 'drop', paths: [file, dir], position: { x: 10, y: 20.5 } }, enabled)).toEqual({
      accept: true, phase: 'drop', position: { x: 10, y: 20.5 }, rejected: [],
      paths: [{ path: file, directory: false }, { path: dir, directory: true }],
    });
    expect(checkDragDrop({ phase: 'leave' }, enabled)).toEqual({ accept: true, phase: 'leave', position: undefined, paths: [], rejected: [] });
    expect(checkDragDrop({ phase: 'over', position: { x: 0, y: 0 }, paths: ['relative'] }, enabled))
      .toEqual({ accept: true, phase: 'over', position: { x: 0, y: 0 }, paths: [], rejected: [] });
  });

  it('windows without dragDropEnabled, sub frames and unknown phases are ignored entirely', () => {
    expect(checkDragDrop({ phase: 'drop', paths: [file] }, { ...enabled, dragDropEnabled: false }))
      .toEqual({ accept: false, reason: 'drag and drop is disabled for this window' });
    expect(checkDragDrop({ phase: 'drop', paths: [file] }, { ...enabled, topFrame: false }))
      .toEqual({ accept: false, reason: 'not sent by the top-level frame' });
    expect(checkDragDrop({ phase: 'grant', paths: [file] }, enabled)).toEqual({ accept: false, reason: 'unknown phase "grant"' });
    expect(checkDragDrop({ paths: [file] }, enabled)).toEqual({ accept: false, reason: 'unknown phase undefined' });
  });

  it('malformed positions and path lists reject the whole message; more than the limit is not truncated', () => {
    for (const position of [null, {}, { x: '1', y: 2 }, { x: Number.NaN, y: 0 }, { x: 0, y: Number.POSITIVE_INFINITY }]) {
      expect(checkDragDrop({ phase: 'drop', paths: [file], position }, enabled)).toEqual({ accept: false, reason: 'malformed position' });
    }
    expect(checkDragDrop({ phase: 'drop', paths: file }, enabled)).toEqual({ accept: false, reason: 'paths is not an array' });
    let stats = 0;
    const counting = { ...enabled, stat: () => { stats += 1; return { isDirectory: () => false }; } };
    expect(checkDragDrop({ phase: 'drop', paths: Array(MAX_DROPPED_PATHS + 1).fill(file) }, counting))
      .toEqual({ accept: false, reason: `${MAX_DROPPED_PATHS + 1} paths exceed the limit of ${MAX_DROPPED_PATHS}` });
    expect(stats).toBe(0);
    expect(checkDragDrop({ phase: 'drop', paths: Array(MAX_DROPPED_PATHS).fill(file) }, counting)).toMatchObject({ accept: true });
    expect(stats).toBe(MAX_DROPPED_PATHS);
  });

  posixOnly('only existing absolute paths reach the scope; the rest are reported and dropped', () => {
    const dangling = join(tmp, 'dangling');
    symlinkSync(join(tmp, 'missing-target'), dangling);
    const raw = [file, 'note.md', '../etc/passwd', '', join(tmp, 'missing'), dangling, `${file}\0.png`, 42, null, { path: file },
      `/${'a'.repeat(MAX_DROPPED_PATH_LENGTH)}`, join(file, 'child'), dir];
    const checked = checkDragDrop({ phase: 'drop', paths: raw, position: { x: 1, y: 1 } }, enabled);
    expect(checked).toMatchObject({ accept: true, paths: [{ path: file, directory: false }, { path: dir, directory: true }] });
    expect(checked.accept && checked.rejected).toEqual(raw.slice(1, -1));
    expect(checkDragDrop({ phase: 'enter', paths: ['relative', dir] }, enabled)).toMatchObject({ paths: [{ path: dir, directory: true }], rejected: ['relative'] });
  });

  it('Windows accepts drive and UNC paths only, never drive-relative or rooted-without-drive paths', () => {
    const seen: string[] = [];
    const win = { ...enabled, platform: 'win32' as const, stat: (path: string) => { seen.push(path); return { isDirectory: () => false }; } };
    const raw = ['C:\\Users\\a\\note.md', 'd:/data/x.pdf', '\\\\server\\share\\x.docx', 'C:note.md', '\\Windows\\x', '/tmp/x', 'note.md', '\\\\'];
    const checked = checkDragDrop({ phase: 'drop', paths: raw }, win);
    expect(checked.accept && checked.paths.map((p) => p.path)).toEqual(raw.slice(0, 3));
    expect(checked.accept && checked.rejected).toEqual(raw.slice(3));
    expect(seen).toEqual(raw.slice(0, 3));
  });
});

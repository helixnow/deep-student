/** v2 self-audit regressions, driven through the registered dstu.shell commands. */
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTestHost } from '../../host/kernel/testing.ts';
import plugin from '../index.ts';

const roots: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'f2-entry-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const host = (dataDir: string) => createTestHost({
  plugins: [plugin],
  app: { platform: 'linux', dataDir },
  shell: (op) => (op === 'app.dataDirs' ? { data: dataDir, localData: null, cache: null } : null),
});

it('read_file_text keeps a leading BOM like String::from_utf8', async () => {
  const dir = temp();
  const file = join(dir, 'bom.txt');
  writeFileSync(file, Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
  const h = await host(dir);
  try {
    await expect(h.invoke('read_file_text', { path: file })).resolves.toBe('\ufeffa');
  } finally { await h.dispose(); }
});

it.skipIf(process.platform !== 'linux')('copy_file closes the source when the target cannot be opened', async () => {
  const dir = temp();
  const source = join(dir, 'src.txt');
  const blocker = join(dir, 'blocker');
  writeFileSync(source, 'x');
  writeFileSync(blocker, 'not a directory');
  const target = join(blocker, 'out.txt');
  const h = await host(dir);
  try {
    const before = readdirSync('/proc/self/fd').length;
    for (let i = 0; i < 20; i++) {
      await expect(h.invoke('copy_file', { sourcePath: source, destPath: target })).rejects.toMatchObject({ error_type: 'FileSystem' });
    }
    expect(readdirSync('/proc/self/fd').length).toBeLessThan(before + 20);
  } finally { await h.dispose(); }
});

it('copy_file rejects saving onto the source file without truncating it', async () => {
  const dir = temp();
  const source = join(dir, 'source.txt');
  const alias = join(dir, 'alias.txt');
  const content = 'original 内容';
  writeFileSync(source, content);
  linkSync(source, alias);
  const h = await host(dir);
  try {
    for (const destPath of [source, `file://${source}`, alias]) {
      await expect(h.invoke('copy_file', { sourcePath: source, destPath })).rejects.toMatchObject({
        error_type: 'Validation', message: '源文件和目标文件不能相同',
      });
      expect(readFileSync(source, 'utf8')).toBe(content);
      expect(readFileSync(alias, 'utf8')).toBe(content);
    }
  } finally { await h.dispose(); }
});

it('load_webview_settings rejects invalid UTF-8 like fs::read_to_string', async () => {
  const dir = temp();
  writeFileSync(join(dir, 'webview_settings.json'), Buffer.from([0x7b, 0xff, 0x7d]));
  const h = await host(dir);
  try {
    await expect(h.invoke('load_webview_settings')).rejects.toEqual({
      error_type: 'FileSystem',
      message: '读取 WebView 设置文件失败: stream did not contain valid UTF-8',
      details: null,
    });
  } finally { await h.dispose(); }
});

it('file commands trim Rust White_Space without removing a filename BOM', async () => {
  const dir = temp();
  const padded = join(dir, 'nel.txt');
  const bom = join(dir, 'bom.txt\ufeff');
  const h = await host(dir);
  try {
    await expect(h.invoke('save_text_to_file', { path: `${padded}\u0085`, content: 'nel' })).resolves.toBeNull();
    expect(readFileSync(padded, 'utf8')).toBe('nel');
    await expect(h.invoke('read_file_text', { path: `\u0085${padded}\u0085` })).resolves.toBe('nel');
    await expect(h.invoke('save_text_to_file', { path: bom, content: 'abc' })).resolves.toBeNull();
    expect(readFileSync(bom, 'utf8')).toBe('abc');
    expect(existsSync(join(dir, 'bom.txt'))).toBe(false);
    await expect(h.invoke('hash_file', { path: bom })).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  } finally { await h.dispose(); }
});

it('open_file_externally uses Rust mode whitespace before the desktop rejection', async () => {
  const h = await host(temp());
  try {
    await expect(h.invoke('open_file_externally', { path: 'unused', mode: '\u0085share\u0085' })).rejects.toEqual({
      error_type: 'Validation', message: 'open_file_externally is only supported on Android', details: null,
    });
    await expect(h.invoke('open_file_externally', { path: 'unused', mode: '\ufeffview' })).rejects.toEqual({
      error_type: 'Validation', message: '不支持的打开方式: \ufeffview', details: null,
    });
  } finally { await h.dispose(); }
});

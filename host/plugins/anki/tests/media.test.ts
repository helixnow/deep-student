import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ANKI_MEDIA_MAX_BYTES, isInsideRoot, readAnkiMediaIn, validateApkgPath } from '../src/files.ts';
import { collectCardMediaPaths, extractMediaFilenames } from '../src/apkg-import-media.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

let dir: string, root: string, env: AnkiTestEnv;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'anki-media-test-'));
  root = path.join(dir, 'anki_media');
  await mkdir(root);
  env = await createAnkiTestEnv({ migrate: false });
}, 120_000);
afterEach(async () => {
  await env.dispose();
  await rm(dir, { recursive: true, force: true });
}, 120_000);

describe('cmd/apkg_import.rs::anki_media_tests', () => {
  it('reads_media_inside_root_as_data_url', async () => {
    const file = path.join(root, 'deck', 'cat.PNG');
    await mkdir(path.dirname(file));
    await writeFile(file, 'png');
    expect(await readAnkiMediaIn(root, ` ${file} `)).toBe('data:image/png;base64,cG5n');
    const hostFile = path.join(env.storage.locations.activeDir, 'anki_media', 'deck', 'cat.PNG');
    await mkdir(path.dirname(hostFile), { recursive: true });
    await writeFile(hostFile, 'png');
    expect(await env.host.invoke('read_anki_media', { path: ` ${hostFile} ` })).toBe('data:image/png;base64,cG5n');
    // The media root is the active slot's, not the data-root's (apkg_import.rs:308-311).
    expect(env.storage.locations.activeDir).not.toBe(env.dir);
    const rootFile = path.join(env.dir, 'anki_media', 'deck', 'cat.PNG');
    await mkdir(path.dirname(rootFile), { recursive: true });
    await writeFile(rootFile, 'png');
    await expect(env.host.invoke('read_anki_media', { path: rootFile })).rejects.toBeDefined();
  });

  it('the media root is the persistent app data dir, never the temp fallback chain (RF-W07-persistent-app-data-no-silent-relocation)', async () => {
    const mediaFile = async (base: string) => {
      const file = path.join(dir, base, 'anki_media', 'cat.png');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'png');
      return file;
    };
    const persistentFile = await mediaFile('persistent');
    const fallbackFile = await mediaFile('fallback');
    env.host.ctx.provide('fileManagerPaths', {
      getPersistentAppDataDir: () => path.join(dir, 'persistent'),
      getTempAppDataDir: () => path.join(dir, 'fallback'),
      getWritableAppDataDir: () => path.join(dir, 'fallback'),
      resolveImagePath: (target: string) => target,
    } as never);
    expect(await env.host.invoke('read_anki_media', { path: persistentFile })).toBe('data:image/png;base64,cG5n');
    await expect(env.host.invoke('read_anki_media', { path: fallbackFile })).rejects.toMatchObject({ error_type: 'Validation' });
  });

  it('media root containment is Path::starts_with per component (`..x` names are inside)', async () => {
    expect(isInsideRoot(root, path.join(root, '..x.png'))).toBe(true);
    expect(isInsideRoot(root, path.join(root, '..deck', 'cat.png'))).toBe(true);
    expect(isInsideRoot(root, path.join(dir, 'cat.png'))).toBe(false);
    const file = path.join(root, '..deck', 'cat.png');
    await mkdir(path.dirname(file));
    await writeFile(file, 'png');
    expect(await readAnkiMediaIn(root, file)).toBe('data:image/png;base64,cG5n');
  });

  it('rejects_paths_that_resolve_outside_root', async () => {
    const outside = path.join(dir, 'secret.png');
    await writeFile(outside, 'x');
    await expect(readAnkiMediaIn(root, path.join(root, '..', 'secret.png'))).rejects.toMatchObject({ error_type: 'Validation' });
    await expect(readAnkiMediaIn(root, outside)).rejects.toMatchObject({ error_type: 'Validation' });
    if (process.platform !== 'win32') {
      const link = path.join(root, 'link.png');
      await symlink(outside, link);
      await expect(readAnkiMediaIn(root, link)).rejects.toMatchObject({ error_type: 'Validation' });
    }
  });

  it('rejects_unknown_types_directories_missing_and_oversized_files', async () => {
    const text = path.join(root, 'notes.txt');
    await writeFile(text, 'x');
    await expect(readAnkiMediaIn(root, text)).rejects.toMatchObject({ error_type: 'Validation' });
    const folder = path.join(root, 'folder.png');
    await mkdir(folder);
    await expect(readAnkiMediaIn(root, folder)).rejects.toMatchObject({ error_type: 'Validation' });
    await expect(readAnkiMediaIn(root, path.join(root, 'missing.png'))).rejects.toMatchObject({ error_type: 'Validation' });
    const big = path.join(root, 'big.mp3'), handle = await open(big, 'w');
    try { await handle.truncate(ANKI_MEDIA_MAX_BYTES + 1); } finally { await handle.close(); }
    await expect(readAnkiMediaIn(root, big)).rejects.toMatchObject({ details: { errorCode: 'apkg_invalid_input' } });
  });

  it('resolves safe bare filenames and anki-media:// refs inside mediaRoot while still rejecting traversal', async () => {
    const img = path.join(root, 'qa_img_01.png');
    const aud = path.join(root, 'qa_audio_01.mp3');
    await writeFile(img, 'png');
    await writeFile(aud, 'mp3');
    expect(await readAnkiMediaIn(root, 'qa_img_01.png')).toBe('data:image/png;base64,cG5n');
    expect(await readAnkiMediaIn(root, 'anki-media://qa_audio_01.mp3')).toBe('data:audio/mpeg;base64,bXAz');
    const outside = path.join(dir, 'secret.png');
    await writeFile(outside, 'x');
    await expect(readAnkiMediaIn(root, '../secret.png')).rejects.toMatchObject({ error_type: 'Validation' });
    await expect(readAnkiMediaIn(root, 'anki-media://../secret.png')).rejects.toMatchObject({ error_type: 'Validation' });
  });

  it('extractMediaFilenames and collectCardMediaPaths handle unquoted src, whitespace, and case-insensitive matches', () => {
    const names = extractMediaFilenames('<img src=qa_img_01.png><img src = "QA_IMG_02.PNG">[sound:qa_audio_01.mp3]');
    expect(names).toEqual(['qa_img_01.png', 'QA_IMG_02.PNG', 'qa_audio_01.mp3']);
    const mediaPaths = new Map([
      ['qa_img_01.png', '/data/anki_media/qa_img_01.png'],
      ['qa_img_02.png', '/data/anki_media/qa_img_02.png'],
      ['qa_audio_01.mp3', '/data/anki_media/qa_audio_01.mp3'],
    ]);
    expect(
      collectCardMediaPaths(['<img src=qa_img_01.png><img src="QA_IMG_02.PNG">[sound:qa_audio_01.mp3]'], mediaPaths),
    ).toEqual([
      '/data/anki_media/qa_img_01.png',
      '/data/anki_media/qa_img_02.png',
      '/data/anki_media/qa_audio_01.mp3',
    ]);
  });
});

describe('cmd/apkg_import.rs::tests', () => {
  it('rejects_blank_path_as_structured_validation_error', async () => {
    await expect(validateApkgPath('  \t\n')).rejects.toMatchObject({ error_type: 'Validation', message: expect.stringContaining('不能为空'), details: { errorCode: 'apkg_invalid_input' } });
  });
  it('rejects_missing_path_as_structured_not_found_error', async () => {
    await expect(validateApkgPath(path.join(dir, 'missing.apkg'))).rejects.toMatchObject({ error_type: 'NotFound', message: expect.stringContaining('missing.apkg'), details: { errorCode: 'apkg_not_found' } });
  });
  it('rejects_directory_as_structured_validation_error', async () => {
    await expect(validateApkgPath(dir)).rejects.toMatchObject({ error_type: 'Validation', message: expect.stringContaining('必须指向文件'), details: { errorCode: 'apkg_not_file' } });
  });
  it('accepts_existing_regular_file_without_rewriting_its_path', async () => {
    const file = path.join(dir, 'regular');
    await writeFile(file, '');
    expect(await validateApkgPath(file)).toBe(file);
  });
});

it('save_json_file preserves bytes and sanitizes suggestedName through Host', async () => {
  const name = `${path.basename(dir)}.json`;
  const output = await env.host.invoke<string>('save_json_file', { content: '{"文字":"\u0000"}', suggestedName: `../${name}` });
  try {
    expect(output).toBe(path.join(tmpdir(), name));
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(output, 'utf8')).toBe('{"文字":"\u0000"}');
  } finally {
    await rm(output);
  }
});

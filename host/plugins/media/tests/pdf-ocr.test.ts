import { expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import { PdfOcrControlState, savePdfToTemp } from '../src/pdf-ocr-sessions.ts';

function settings() {
  return { get: () => null, save: () => undefined };
}

it('pdf OCR session control maps match the AppState semantics', () => {
  const state = new PdfOcrControlState();
  expect(state.cancel('missing')).toBe(false);
  expect(state.pause('missing')).toBe(false);
  expect(state.resume('missing')).toBe(false);

  const signals: boolean[] = [];
  state.cancellations.set('s1', { send: value => signals.push(value) });
  state.pauses.set('s1', { send: value => signals.push(value) });
  expect(state.cancel('s1')).toBe(true);
  expect(state.cancellations.has('s1')).toBe(false);
  expect(state.cancel('s1')).toBe(false);
  expect(state.pause('s1')).toBe(true);
  expect(state.resume('s1')).toBe(true);
  expect(signals).toEqual([true, true, false]);

  expect(state.skip('s2', 4)).toBe(true);
  expect(state.skip('s2', 4)).toBe(true);
  expect([...state.skipPages.get('s2')!]).toEqual([4]);
});

it('temp-dir and save commands create the Rust directory under the F3 temp data dir and reject bad base64', async () => {
  const slot = await mkdtemp(join(tmpdir(), 'media-pdf-ocr-slot-'));
  const host = await createTestHost({ plugins: [media], provide: { storage: unusedStorage(), settings: settings(),
    paths: { appDataDir: process.cwd() }, fileManagerPaths: { getTempAppDataDir: () => slot } } });
  try {
    const dir = await host.invoke('get_pdf_ocr_temp_dir');
    expect(dir).toBe(join(slot, 'pdf_ocr_temp'));
    expect((await stat(dir as string)).isDirectory()).toBe(true);
    expect(existsSync(join(host.app.dataDir, 'pdf_ocr_temp'))).toBe(false);

    expect(await host.invoke('cancel_pdf_ocr_session', { sessionId: 'nope' })).toBe(false);
    expect(await host.invoke('pause_pdf_ocr_session', { sessionId: 'nope' })).toBe(false);
    expect(await host.invoke('resume_pdf_ocr_session', { sessionId: 'nope' })).toBe(false);
    expect(await host.invoke('skip_pdf_ocr_page', { sessionId: 'nope', pageIndex: 2 })).toBe(true);
    expect(await host.invoke('handout_cancel', { requestId: 'r' })).toBeNull();
    expect(await host.invoke('handout_release', { requestId: 'r' })).toBeNull();

    const path = await host.invoke('save_pdf_to_temp', { pdfBase64: 'data:application/pdf;base64,JVBERi0=', fileName: 'x.pdf' }) as string;
    expect(path.startsWith(dir as string)).toBe(true);
    expect(path.slice(-('_x.pdf'.length))).toBe('_x.pdf');
    expect([...(await readFile(path))]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);

    await expect(host.invoke('save_pdf_to_temp', { pdfBase64: 'invalid_base64!', fileName: 'x.pdf' }))
      .rejects.toEqual({ error_type: 'Validation', message: 'Base64 解码失败: Invalid byte 95, offset 7.', details: null });
    await expect(savePdfToTemp(slot, '@@@@', 'x.pdf'))
      .rejects.toMatchObject({ value: { error_type: 'Validation', message: 'Base64 解码失败: Invalid byte 64, offset 0.', details: null } });
  } finally {
    await host.dispose();
    await rm(slot, { recursive: true, force: true });
  }
});

it('temp-dir and save commands fail as configuration errors without F3 fileManagerPaths', async () => {
  const host = await createTestHost({ plugins: [media], provide: { storage: unusedStorage(), settings: settings(), paths: { appDataDir: process.cwd() } } });
  try {
    const missing = { error_type: 'Configuration', message: 'PDF OCR 临时目录需要 F3 fileManagerPaths 服务', details: null };
    await expect(host.invoke('get_pdf_ocr_temp_dir')).rejects.toEqual(missing);
    await expect(host.invoke('save_pdf_to_temp', { pdfBase64: 'JVBERi0=', fileName: 'x.pdf' })).rejects.toEqual(missing);
    expect(existsSync(join(host.app.dataDir, 'pdf_ocr_temp'))).toBe(false);
  } finally { await host.dispose(); }
});

it('L18-M04 pdf OCR control commands and the ocr service share one AppState map set', async () => {
  const host = await createTestHost({ plugins: [media], provide: { storage: unusedStorage(), settings: settings(), paths: { appDataDir: process.cwd() } } });
  try {
    const ocr = host.ctx.ocr as typeof host.ctx.ocr & { state: PdfOcrControlState };
    const signals: boolean[] = [];
    ocr.state.cancellations.set('s1', { send: value => signals.push(value) });
    ocr.state.pauses.set('s1', { send: value => signals.push(value) });

    expect(await host.invoke('pause_pdf_ocr_session', { sessionId: 's1' })).toBe(true);
    expect(ocr.resumeSession('s1')).toBe(true);
    expect(await host.invoke('skip_pdf_ocr_page', { sessionId: 's1', pageIndex: 3 })).toBe(true);
    expect([...ocr.state.skipPages.get('s1')!]).toEqual([3]);
    expect(await host.invoke('cancel_pdf_ocr_session', { sessionId: 's1' })).toBe(true);
    expect(ocr.cancelSession('s1')).toBe(false);
    expect(signals).toEqual([true, false, true]);

    // Session creation needs the L02 page OCR call (L18-B02); no always-throwing stand-ins.
    for (const name of ['startSession', 'addPage', 'processPdf', 'startBackendSession']) {
      expect(name in ocr).toBe(false);
    }
  } finally { await host.dispose(); }
});

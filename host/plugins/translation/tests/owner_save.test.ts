import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
// boundary-allow cross-plugin-impl: this consumer test installs the actual L11 owner plugin
import repositories from '../../vfs-repos/index.ts';
import translation from '../index.ts';
import type { TranslationPersistenceOwner, TranslationToolContext } from '../api.ts';
import { defaultCachedMeta, withTranslationCache, TranslationToolFailure } from '../src/tool_executor.ts';
import { updateTranslationMetadata } from './pending-metadata-owner.ts';

async function fixture(deviceId: string) {
  const root = await mkdtemp('/tmp/opencode/translation-owner-');
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error(report.error ?? 'migration failed');
  const warnings: string[] = [];
  const host = await createTestHost({ plugins: [repositories, translation], provide: {
    storage, paths: { dataSpaceDeviceId: async () => deviceId }, llm: {}, llmCodexAuth: {}, llmHttp: { fetch },
    log: { logger: () => ({ warn: (message: string) => warnings.push(message), info() {}, debug() {}, error() {} }) },
  } });
  const conn = storage.database('vfs');
  const repo = host.ctx.vfsRepo.translations;
  const owner: TranslationPersistenceOwner = {
    createTranslationInFolder: repo.createTranslationInFolder.bind(repo), updateTranslationMetadata,
  };
  const context: TranslationToolContext = { sessionId: deviceId, isCancelled: () => false,
    vfs: { getConnSafe: () => conn }, vfsTranslations: owner };
  return { host, conn, repo, owner, context, warnings, async close() {
    await host.dispose(); storage.dispose(); await rm(root, { recursive: true, force: true });
  } };
}
const inline = { source: 'hello', translated: '你好', source_lang: 'en', target_lang: 'zh' };

describe('R1-TR-03 per-call translation owner consumption', () => {
  it('rejects a missing owner before borrowing a connection or claiming a cached result', async () => {
    const f = await fixture('missing-owner');
    try {
      let borrows = 0;
      let failure: unknown;
      try { f.host.ctx.translation.toolExecutor.save(inline, {
        sessionId: 's', isCancelled: () => false, vfs: { getConnSafe: () => { borrows++; return f.conn; } },
      }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(TranslationToolFailure);
      expect((failure as TranslationToolFailure).payload).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', retryable: true });
      expect(borrows).toBe(0);
      expect(f.conn.pluck('SELECT COUNT(*) FROM translations')).toBe(0);
    } finally { await f.close(); }
  });

  it('maps the actual L11 missing-folder error and releases the claim; metadata failure warns after consuming success', async () => {
    const f = await fixture('cache-owner');
    try {
      const id = withTranslationCache(cache => cache.insertAt({ ownerSessionId: f.context.sessionId,
        source: 'hello', translated: '你好', sourceLang: 'en', targetLang: 'zh', meta: defaultCachedMeta(), nowMs: Date.now() }));
      const executor = f.host.ctx.translation.toolExecutor;
      const failed = await executor.execute({ id: 'missing-folder', name: 'builtin-translation_save',
        arguments: { translation_result_id: id, folder_id: 'folder_missing' } }, f.context);
      expect(failed.success).toBe(false);
      expect(failed.output).toMatchObject({ code: 'FOLDER_NOT_FOUND', message: 'Folder not found: folder_missing',
        hint: 'Choose an existing folder_id or omit it to save at the translation root.', retryable: false });
      expect(f.conn.pluck('SELECT COUNT(*) FROM translations')).toBe(0);
      expect(f.conn.pluck('SELECT COUNT(*) FROM resources')).toBe(0);
      const order: string[] = [];
      const observed: unknown[] = [];
      const result = executor.save({ translation_result_id: id }, { ...f.context,
        vfsTranslations: { createTranslationInFolder: f.owner.createTranslationInFolder,
          updateTranslationMetadata(conn, translationId, metadata) {
            order.push('metadata');
            observed.push(conn, translationId, metadata, withTranslationCache(cache => cache.peekAt(id, f.context.sessionId, Date.now())));
            throw new Error('metadata write failed');
          } }, emitWatchCreated: node => { order.push('watch'); observed.push(node); },
      });
      expect(result).toMatchObject({ source_mode: 'cached_result', translation_result_consumed: true,
        metadata_persisted: false, title: null, engine: null, model: null });
      expect(order).toEqual(['metadata', 'watch']);
      expect(observed[0]).toBe(f.conn);
      expect(observed[1]).toBe(result.translation_id);
      expect(observed[2]).toMatchObject({ origin: 'chat_agent', sourceMode: 'cached_result' });
      expect(observed[3]).toBeUndefined();
      expect(observed[4]).toMatchObject({ metadata: { sourceText: null, translatedText: null } });
      expect(f.repo.getTranslation(f.conn, String(result.translation_id))).toMatchObject({ sourceText: 'hello', translatedText: '你好' });
      expect(f.warnings).toContain(`[TranslationToolExecutor] Failed to persist translation metadata for ${result.translation_id}: metadata write failed`);
    } finally { await f.close(); }
  });

  it('uses each context owner with its own connection and device identity, even with one executor', async () => {
    const first = await fixture('device-first');
    const second = await fixture('device-second');
    try {
      const executor = first.host.ctx.translation.toolExecutor;
      const a = executor.save(inline, first.context);
      const b = executor.save(inline, second.context);
      expect(a.metadata_persisted).toBe(true); expect(b.metadata_persisted).toBe(true);
      expect(first.conn.pluck('SELECT device_id FROM translations WHERE id = ?1', [String(a.translation_id)])).toBe('device-first');
      expect(second.conn.pluck('SELECT device_id FROM translations WHERE id = ?1', [String(b.translation_id)])).toBe('device-second');
      expect(first.repo.getTranslation(first.conn, String(b.translation_id))).toBeNull();
      expect(second.repo.getTranslation(second.conn, String(a.translation_id))).toBeNull();
    } finally { await second.close(); await first.close(); }
  });
});

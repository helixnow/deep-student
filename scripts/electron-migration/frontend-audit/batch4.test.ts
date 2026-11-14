/** Batch 4 targeted probes: Bilibili probe / stream_quality error results without network.
 * Actual media plugin applied in createTestHost; transport settings go through the real
 * media_bilibili_transport_configure command. Only settings/secrets/VFS ports are supplied.
 * Cases already covered by L18's own tests (link parsing, proxy config, link_get) are not repeated.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTestHost } from '../../../host/kernel/testing.ts';
import { createStorageService } from '../../../host/platform/storage/service.ts';
import media from '../../../host/plugins/media/index.ts';
import { MediaTranscriptRepo } from '../../../host/plugins/vfs-repos/repository/media-transcripts.ts';
import { FileRepo } from '../../../host/plugins/vfs-repos/repository/files.ts';
import { AttachmentRepo } from '../../../host/plugins/vfs-repos/repository/attachments.ts';

const settings = () => {
  const values = new Map<string, string>();
  return { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => { values.set(key, value); } };
};
const secrets = () => {
  const values = new Map<string, string>();
  return { openStore: () => ({
    getSecret: async (key: string) => values.get(key) ?? null,
    saveSecret: async (key: string, value: string) => { values.set(key, value); },
    deleteSecret: async (key: string) => { values.delete(key); },
  }) };
};
const log = { logger: () => ({ error() {}, warn() {}, info() {}, debug() {}, trace() {} }) };

async function fixture() {
  const root = fs.mkdtempSync('/tmp/opencode/x2-batch4-');
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  try {
    const report = storage.coordinator().migrateSingle('vfs');
    assert(report.success, JSON.stringify(report));
    const conn = storage.database('vfs');
    const host = await createTestHost({ app: { dataDir: root, platform: 'linux' }, plugins: [media],
      provide: { storage, settings: settings(), secrets: secrets(), log, paths: { appDataDir: root },
        notes: { repository: {} },
        vfsDatabase: { getConnSafe: () => conn, blobsDir: () => `${root}/vfs_blobs` },
        vfsRepo: { files: new FileRepo(), attachments: new AttachmentRepo(), mediaTranscripts: new MediaTranscriptRepo() } } });
    return { host, async dispose() { await host.dispose(); storage.dispose(); fs.rmSync(root, { recursive: true, force: true }); } };
  } catch (e) { storage.dispose(); fs.rmSync(root, { recursive: true, force: true }); throw e; }
}
const rejectionOf = async (p: Promise<unknown>) => { try { await p; return undefined; } catch (e) { return e; } };

test('X2-R32 stream_quality for a missing link item returns Rust 内容缺失 text (fixed on main 6b1b3fa40)', async () => {
  const f = await fixture();
  try {
    const rejection = await rejectionOf(f.host.invoke('media_bilibili_stream_quality', { fileId: 'file_missing_x2' }));
    // bilibili_stream.rs:520-540 -> play_info_for :474 read_link_descriptor (bilibili.rs:950-959)
    // -> resolve_media_source (pipeline.rs:160-162) MediaError::NotFound("媒体文件内容缺失: {id}") -> e.to_string().
    // L18 6b1b3fa40 now resolves the content source first, like Rust.
    // main-red 677f6727c still had the historical "不存在" expectation because
    // the assertion flip (04df0ba34) had not been integrated, not because Rust changed.
    assert.equal(typeof rejection, 'string');
    assert.equal(rejection, '媒体文件内容缺失: file_missing_x2', `observed: ${String(rejection)}`);
    console.log(`X2-R32: ${String(rejection)}`);
  } finally { await f.dispose(); }
});

test('X2-R33/R34 browser_bridge mode without a bridge: probe JSON BiliError and stream_quality plain message match Rust', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.host.invoke('media_bilibili_transport_configure', { config: { mode: 'browser_bridge', proxyInAuto: false } }), null);
    // bilibili.rs:1122-1127 task_client -> session.rs:124-143 begin(media=false) -> select_route :95-101
    // -> MediaError::Transport -> mod.rs:93-96 serde_json of the full BiliError (types.rs:90-117).
    const probe = await rejectionOf(f.host.invoke('media_bilibili_probe', { input: 'https://www.bilibili.com/video/BV1GJ411x7h7' }));
    assert.equal(typeof probe, 'string', String(probe));
    assert.deepEqual(JSON.parse(probe as string), { code: 'bilibili-bridge-offline', message: '浏览器桥未就绪，请连接浏览器',
      stage: 'transport', requestId: 0, attemptId: '', route: 'native', retryable: true, httpStatus: null, businessCode: null });
    // bilibili_stream.rs:466 playback_session -> begin(media=true) fails before any descriptor read; :531-540 e.to_string().
    // Distinct id: bilibili-playback.ts keeps playback sessions in a module-level map (like Rust's
    // static PLAY_SESSIONS), so reusing R32's key would hit that cached Native session.
    const quality = await rejectionOf(f.host.invoke('media_bilibili_stream_quality', { fileId: 'file_bridge_x2' }));
    assert.equal(quality, '浏览器桥未就绪，请连接浏览器');
    console.log(`X2-R33: ${String(probe)}\nX2-R34: ${String(quality)}`);
  } finally { await f.dispose(); }
});

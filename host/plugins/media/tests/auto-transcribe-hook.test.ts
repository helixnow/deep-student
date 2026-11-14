/**
 * `transcriber_hook.rs::MediaResourceCreatedHook` → `commands.rs::spawn_auto_transcribe_if_short_audio`.
 *
 * G3 `bili.link_item.offline_descriptor` step 13（Rust A1/A2 轨迹）：ASR 槽位指向 apiKey 为空的
 * `w0-asr-guard`，`resolve_asr_endpoint` 返回 settings-required，钩子静默跳过；上传后
 * `__change_log` 只有 resources INSERT、files INSERT、folder_items INSERT、resources UPDATE，
 * `processing_status` 保持 NULL。
 *
 * Rust 的 `vfs_upload_file` 只对图片或 ≥ 1 MiB 的文件落 blob（handlers.rs:2429），更小的音频拿不到内容，
 * 不会自动转写。Host 有意偏离：所有上传都保留字节（`vfs/src/upload-file.ts`），所以 ASR 可用时，
 * 时长 < 10 分钟的音频不论大小都会触发；`start_pipeline(file, None)` 的第一笔写入是
 * `update_processing_status(Queued)`：files UPDATE。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';

interface ChangeRow { id: number; table_name: string; record_id: string; operation: string }
interface Step { cmd: string; args: Record<string, unknown> }
interface Scenario { id: string; steps: Step[] }
interface Uploaded { file: { id: string; resourceId: string } }

let host: TestHost | undefined;
let base: string | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
  vi.unstubAllEnvs();
  if (base !== undefined) fs.rmSync(base, { recursive: true, force: true });
  base = undefined;
}, 60_000);

function steps(): Step[] {
  const file = path.join(import.meta.dirname, '../equivalence/bilibili-offline.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8')) as { scenarios: Scenario[] };
  const found = all.scenarios.find(s => s.id === 'bili.link_item.offline_descriptor');
  if (found === undefined) throw new Error('scenario bili.link_item.offline_descriptor missing');
  return found.steps;
}

function step(index: number, cmd: string): Step {
  const found = steps()[index];
  if (found === undefined) throw new Error(`scenario step ${index} missing`);
  expect(found.cmd).toBe(cmd);
  return found;
}

async function boot(): Promise<TestHost> {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'w04-auto-transcribe-'));
  vi.stubEnv('XDG_DATA_HOME', path.join(base, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(base, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(base, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  host = await createTestHost({ app: { dataDir: path.join(base, 'app'), debug: true } });
  // Match the desktop bootstrap: installer authority is injected only into builtins.
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(path.join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  expect(loaded.degraded).toEqual([]);
  return host;
}

/** `apiKey === null` keeps the G3 guard config as-is (`authMode: none`, empty key). */
async function configureAsr(h: TestHost, apiKey: string | null): Promise<void> {
  const save = step(1, 'save_api_configurations');
  const configs = (save.args.configs as Array<Record<string, unknown>>)
    .map(cfg => apiKey === null ? cfg : { ...cfg, apiKey, authMode: 'bearer' });
  await h.invoke('save_api_configurations', { configs });
  await h.invoke('save_model_assignments', step(2, 'save_model_assignments').args);
}

/** 8-bit mono PCM WAV of `seconds` at `rate` Hz; the probe reads the duration from the header. */
function wavBase64(seconds: number, rate: number): string {
  const data = Buffer.alloc(rate * seconds, 0x80);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]).toString('base64');
}

/** ≥ 1 MiB so `vfs_upload_file` stores a blob; 68 s at 16 kHz. */
const SHORT_BLOB_WAV = (): string => wavBase64(68, 16_000);
/** ≥ 1 MiB and 1100 s (> 10 min) at 1 kHz. */
const LONG_BLOB_WAV = (): string => wavBase64(1100, 1000);

function upload(h: TestHost, name: string, mimeType: string, base64Content: string): Promise<Uploaded> {
  return h.invoke('vfs_upload_file', { params: { name, mimeType, base64Content } }) as Promise<Uploaded>;
}

function changeLog(h: TestHost): Array<[string, string, string]> {
  return h.ctx.vfsDatabase.getConnSafe()
    .all<ChangeRow>('SELECT id, table_name, record_id, operation FROM __change_log ORDER BY id')
    .map(r => [r.table_name, r.record_id, r.operation]);
}

function processingStatus(h: TestHost, fileId: string): string | null {
  return h.ctx.vfsDatabase.getConnSafe()
    .pluck<string | null>('SELECT processing_status FROM files WHERE id = ?1', [fileId]) ?? null;
}

async function settle(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for auto transcription');
    await settle(20);
  }
}

/** The first upload also creates the default upload folder; in the G3 run step 3 already did. */
function uploadRows(h: TestHost, before: number, uploaded: Uploaded): Array<[string, string, string]> {
  let rows = changeLog(h).slice(before);
  if (rows[0]?.[0] === 'folders' && rows[0][2] === 'INSERT') rows = rows.slice(1);
  if (rows[0]?.[0] === 'blobs' && rows[0][2] === 'INSERT') rows = rows.slice(1);
  const folderItem = rows[2]?.[1] ?? '';
  expect(rows.slice(0, 4)).toEqual([
    ['resources', uploaded.file.resourceId, 'INSERT'],
    ['files', uploaded.file.id, 'INSERT'],
    ['folder_items', folderItem, 'INSERT'],
    ['resources', uploaded.file.resourceId, 'UPDATE'],
  ]);
  return rows.slice(4);
}

function terminal(status: string | null): boolean {
  return status === 'completed' || status === 'completed_with_issues' || status === 'error';
}

it('ASR slot without an API key skips auto transcription exactly like the Rust trace (step 13)', async () => {
  const h = await boot();
  await configureAsr(h, null);
  const before = changeLog(h).length;
  const upload = await h.invoke('vfs_upload_file', step(13, 'vfs_upload_file').args) as Uploaded;
  await settle(1500);
  expect(uploadRows(h, before, upload)).toEqual([]);
  expect(processingStatus(h, upload.file.id)).toBeNull();
}, 120_000);

it('short audio stored as a blob starts the media pipeline once ASR is configured (Queued is the first write)', async () => {
  const h = await boot();
  await configureAsr(h, 'sk-w04-auto-transcribe');
  const before = changeLog(h).length;
  const uploaded = await upload(h, 'w04-short.wav', 'audio/wav', SHORT_BLOB_WAV());
  const fileId = uploaded.file.id;
  await waitFor(() => processingStatus(h, fileId) !== null, 30_000);
  const after = uploadRows(h, before, uploaded);
  expect(after[0]).toEqual(['files', fileId, 'UPDATE']);
  await waitFor(() => terminal(processingStatus(h, fileId)), 90_000);
}, 180_000);

it('long audio and text do not auto transcribe with ASR configured; short audio does at any size', async () => {
  const h = await boot();
  await configureAsr(h, 'sk-w04-auto-transcribe');
  const inline = await h.invoke('vfs_upload_file', step(13, 'vfs_upload_file').args) as Uploaded;
  const long = await upload(h, 'w04-long.wav', 'audio/wav', LONG_BLOB_WAV());
  const text = await upload(h, 'w04-note.txt', 'text/plain', Buffer.from('hello').toString('base64'));
  const control = await upload(h, 'w04-short.wav', 'audio/wav', SHORT_BLOB_WAV());
  await waitFor(() => processingStatus(h, control.file.id) !== null, 30_000);
  await waitFor(() => terminal(processingStatus(h, control.file.id)), 90_000);
  // `vfs_upload_file` now keeps a blob for every upload, so the short clip below 1 MiB is eligible too.
  await waitFor(() => terminal(processingStatus(h, inline.file.id)), 90_000);
  expect(processingStatus(h, long.file.id)).toBeNull();
  expect(processingStatus(h, text.file.id)).toBeNull();
}, 240_000);

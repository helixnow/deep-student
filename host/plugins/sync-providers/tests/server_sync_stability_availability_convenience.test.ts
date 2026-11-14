import './local-fs-fixture.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RealisticSyncHarness, type RealisticDevice } from './realistic_sync_harness.ts';
import { spawnFakeDav, filePropfindXml } from './fake_dav.ts';
import { spawnFakeS3 } from './fake_s3.ts';
import { spawnFakeFtp } from './fake_ftp.ts';
import { WebDavStorage } from '../src/webdav.ts';
import { S3Storage } from '../src/s3.ts';
import { FtpStorage } from '../src/ftp.ts';
import { getFileWithOptionalResume } from '../src/resume.ts';
import { encodeFramedPack, readPackEntryRange } from '../src/v5_framed_pack.ts';
import { SyncV5RuntimeCoordinator } from '../../sync/api.ts';
import { createPayloadCodec } from '../../sync/src/payload.ts'; // boundary-allow cross-plugin-impl: multi-provider stress benchmark drives internal sync wire codec
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { argon2 } from '../../../platform/native/argon2/index.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import { SqliteSyncStateStore } from '../../sync-support/src/state.ts'; // boundary-allow cross-plugin-impl: multi-provider stress benchmark exercises sync state store directly
import { uploadEnrichedChanges } from '../../sync/src/upload-changes.ts'; // boundary-allow cross-plugin-impl: multi-provider stress benchmark drives upload step directly
import { uploadManifest, ensureRemoteInstanceId } from '../../sync/src/manifest-upload.ts'; // boundary-allow cross-plugin-impl: multi-provider stress benchmark drives manifest step directly
import { readDeviceManifests } from '../../sync/src/remote-manifest.ts'; // boundary-allow cross-plugin-impl: multi-provider stress benchmark reads remote manifests directly
import { downloadChanges, commitDownloadProgress } from '../../sync/src/download-changes.ts'; // boundary-allow cross-plugin-impl: multi-provider stress benchmark drives download step directly
import { parseChangesPayload } from '../../sync/src/download-payload.ts'; // boundary-allow cross-plugin-impl: multi-provider stress benchmark parses change payload directly
import { parseJsonLossless } from '../../../platform/util/lossless-json.ts';
import { applyDownloadedChangesToDatabases } from '../../sync/repository/apply-databases.ts'; // boundary-allow cross-plugin-impl: multi-provider stress benchmark applies changes directly
import { markUploadedChanges } from '../../sync/repository/sync-pass.ts'; // boundary-allow cross-plugin-impl: multi-provider stress benchmark marks uploaded changes directly
import { collectLocalManifest } from '../../sync/src/transfer-commands.ts'; // boundary-allow cross-plugin-impl: multi-provider stress benchmark inspects local manifest directly
import { parseChangeKey } from '../../sync/src/change-keys.ts'; // boundary-allow cross-plugin-impl: multi-provider stress benchmark inspects change keys directly
import { rehydrateUnknownFieldsIfColumnsExist } from '../../sync/src/unknown-fields.ts'; // boundary-allow cross-plugin-impl: multi-provider stress benchmark verifies unknown field rehydration
import { createScopedPluginSyncStore, ensurePluginSyncRecordsTable, PluginQuotaExceededError } from '../../sync/api.ts';
import { createPairingCode, applyPairingCode } from '../../sync/src/device-pairing.ts'; // boundary-allow cross-plugin-impl: multi-provider stress benchmark exercises pairing directly
import { collectSyncChanges } from '../../sync/src/collect-sync-changes.ts'; // boundary-allow cross-plugin-impl: multi-provider stress benchmark collects local changes directly
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { deviceIdShortHash, type CloudStorage } from '../api.ts';

// Loopback measurements are protocol/engine microbenchmarks, not Internet or
// physical mobile-device performance. No credentials or pairing codes are logged.
const metrics: Record<string, unknown> = {};
let startedAt: string, gitCommitStart: string, runId: string;
let workingTreeCleanStart: boolean;
const h = new RealisticSyncHarness();
let scratch: string;
const oldTmpdir = process.env.TMPDIR;
const codecs: Awaited<ReturnType<typeof createPayloadCodec>>[] = [];
const context = { magic: 'DSPK' as const, repoId: 'bench', deviceId: 'desktop', incarnationId: 'inc', containerId: 'pack', contentEpoch: 0 };
const cdc = { gearSeed: 'benchmark', min: 65536, avg: 262144, max: 1048576 };
const fastCdc = { actual: cdc, pinned: cdc };

async function measure(name: string, run: () => Promise<Record<string, unknown>>) {
  const start = performance.now();
  try { metrics[name] = { status: 'passed', ...await run(), elapsedMs: performance.now() - start }; }
  catch (error) { metrics[name] = { status: 'failed', elapsedMs: performance.now() - start, error: String(error) }; throw error; }
}

/** Stateful loopback DAV: actual requests, byte ranges and lease listings. */
async function davServer() {
  const objects = new Map<string, Buffer>();
  let reverseListing = false;
  const server = await spawnFakeDav((method, path, _index, headers, body) => {
    if (method === 'MKCOL') return { status: 201 };
    if (method === 'PUT') { objects.set(path, Buffer.from(body)); return { status: 201 }; }
    if (method === 'DELETE') { objects.delete(path); return { status: 204 }; }
    if (method === 'PROPFIND') {
      const data = objects.get(path);
      if (headers.depth === '0') return data ? { status: 207, body: filePropfindXml(path, data.length) } : { status: 404 };
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const entries = [...objects].filter(([key]) => key.startsWith(prefix));
      if (reverseListing) entries.reverse();
      return { status: 207, body: `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${prefix}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` + entries.map(([key, value]) =>
        `<d:response><d:href>${key}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${value.length}</d:getcontentlength><d:getlastmodified>Mon, 09 Nov 2026 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('') + '</d:multistatus>' };
    }
    const data = objects.get(path);
    if (!data) return { status: 404 };
    return { status: 200, body: data, headers: { ETag: '"bench"' } };
  }, 0, { ranges: true });
  const storage = new WebDavStorage({ endpoint: server.endpoint, username: 'bench', password: 'local-only' }, 'bench', { rateLimitEnv: '0' });
  return { ...server, storage, objects, reverseListings: (enabled: boolean) => { reverseListing = enabled; } };
}

function settings(db: DatabaseHandle, initial: Record<string, string> = {}): SettingsStore {
  db.exec('CREATE TABLE IF NOT EXISTS bench_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const save = (key: string, value: string) => { db.run('INSERT OR REPLACE INTO bench_settings VALUES(?,?)', [key, value]); };
  const get = (key: string) => db.pluck<string>('SELECT value FROM bench_settings WHERE key=?', [key]) ?? null;
  for (const [key, value] of Object.entries(initial)) save(key, value);
  return {
    get, save, delete: key => { db.run('DELETE FROM bench_settings WHERE key=?', [key]); return true; }, deleteByPrefix: () => 0,
    listByPrefix: prefix => db.all<{ key: string; value: string }>('SELECT * FROM bench_settings').filter(row => row.key.startsWith(prefix)).map(row => ({ ...row, updatedAt: '2026-11-09' })),
    getSecret: async key => get(key), saveSecret: async (key, value) => save(key, value),
    deleteSecret: async key => { db.run('DELETE FROM bench_settings WHERE key=?', [key]); return true; },
  };
}

/** Each peer owns a durable SQLite cursor store, codec and provider instance. */
async function peer(name: string, endpoint: string, password = 'benchmark-e2ee', root = 'bench') {
  const device = await h.device(name);
  const codec = await createPayloadCodec(createBackupCrypto({ nativeArgon2: argon2 }), password); codecs.push(codec);
  const state = new SqliteSyncStateStore(() => device.storage.database('sync_state'));
  const storage = new WebDavStorage({ endpoint, username: 'bench', password: 'local-only' }, root, { rateLimitEnv: '0' });
  const options = { deviceId: device.deviceId, codec };
  return { device, storage, options, state, openState: () => state };
}
type Peer = Awaited<ReturnType<typeof peer>>;
async function publish(p: Peer, crashBeforeMark = false) {
  const changes = await collectSyncChanges(p.device.storage, null);
  await uploadEnrichedChanges(p.storage, changes, p.options, p.openState, compression);
  if (crashBeforeMark) throw new Error('injected: remote published before local marking');
  markUploadedChanges(p.device.storage, changes);
  await uploadManifest(p.storage, collectLocalManifest(p.device.storage, p.device.deviceId, false).manifest, p.options, p.openState);
  expect(await collectSyncChanges(p.device.storage, null)).toHaveLength(0);
  return changes.length;
}
async function receive(p: Peer) {
  const downloaded = await downloadChanges(p.storage, 0n, null, p.options, p.openState, compression);
  const applied = applyDownloadedChangesToDatabases(p.device.storage, downloaded.changes, 'KeepLatest', p.device.deviceId);
  if (applied.total_failed || applied.total_incomplete_skipped) throw new Error(`apply failed: ${JSON.stringify(applied.db_errors)}`);
  await commitDownloadProgress(p.storage, downloaded, p.options, p.openState);
  if (downloaded.cursor_advancements.size) await uploadManifest(p.storage, collectLocalManifest(p.device.storage, p.device.deviceId, false).manifest, p.options, p.openState);
  const instance = await ensureRemoteInstanceId(p.storage, p.options, p.openState);
  for (const [writer, seq] of downloaded.cursor_advancements) expect(p.state.getCursor(instance, writer)).toBe(seq);
  return downloaded;
}
function folder(device: RealisticDevice, id: string, title = id) {
  const ms = h.nextMs(); h.db(device, 'vfs').run('INSERT INTO folders(id,title,sort_order,created_at,updated_at) VALUES(?,?,0,?,?)', [id, title, ms, ms]);
}
function business(device: RealisticDevice, prefix: string, count: number) {
  const vfs = h.db(device, 'vfs'), chat = h.db(device, 'chat_v2'), mistakes = h.db(device, 'mistakes');
  const stamps = Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, ts: h.nextIso(), ms: h.nextMs() }));
  vfs.transaction(() => {
    for (const { id, ts, ms } of stamps) {
      vfs.run('INSERT INTO folders(id,title,sort_order,created_at,updated_at) VALUES(?,?,0,?,?)', [id, id, ms, ms]);
      vfs.run("INSERT INTO resources(id,hash,type,data,ref_count,created_at,updated_at,storage_mode) VALUES(?,?,'note',?,1,?,?,'inline')", [`res-${id}`, `hash-${id}`, `body-${id}`, ms, ms]);
      vfs.run("INSERT INTO notes(id,resource_id,title,tags,is_favorite,created_at,updated_at) VALUES(?,?,?,'[]',0,?,?)", [id, `res-${id}`, id, ts, ts]);
    }
  });
  chat.transaction(() => {
    for (const { id, ts, ms } of stamps) {
      chat.run("INSERT INTO chat_v2_sessions(id,mode,title,persist_status,created_at,updated_at) VALUES(?,'chat',?,'active',?,?)", [id, id, ts, ts]);
      chat.run("INSERT INTO chat_v2_messages(id,session_id,role,block_ids_json,timestamp) VALUES(?,?,'user','[]',?)", [id, id, ms]);
    }
  });
  mistakes.transaction(() => {
    for (const { id, ts } of stamps) {
      mistakes.run("INSERT INTO mistakes(id,question_images,analysis_images,user_question,ocr_text,tags,mistake_type,status,created_at,updated_at,last_accessed_at) VALUES(?,'[]','[]',?,'','[]','math','active',?,?,'1970-01-01T00:00:00Z')", [id, id, ts, ts]);
    }
  });
}
function projection(device: RealisticDevice) {
  return {
    folders: h.db(device, 'vfs').all('SELECT id,title,deleted_at FROM folders ORDER BY id'),
    notes: h.db(device, 'vfs').all('SELECT id,title FROM notes ORDER BY id'),
    sessions: h.db(device, 'chat_v2').all('SELECT id,title FROM chat_v2_sessions ORDER BY id'),
    messages: h.db(device, 'chat_v2').all('SELECT id,session_id FROM chat_v2_messages ORDER BY id'),
    mistakes: h.db(device, 'mistakes').all('SELECT id,user_question FROM mistakes ORDER BY id'),
  };
}

beforeAll(async () => {
  startedAt = new Date().toISOString();
  gitCommitStart = execSync('git rev-parse HEAD', { cwd: process.cwd(), encoding: 'utf8' }).trim();
  workingTreeCleanStart = execSync('git status --porcelain', { cwd: process.cwd(), encoding: 'utf8' }).trim().length === 0;
  runId = randomUUID();
  scratch = await mkdtemp(join(tmpdir(), 'lane5-bench-'));
  process.env.TMPDIR = scratch;
  await h.init();
}, 180_000);
afterAll(async () => {
  const finishedAt = new Date().toISOString();
  const gitCommitEnd = execSync('git rev-parse HEAD', { cwd: process.cwd(), encoding: 'utf8' }).trim();
  const dirtyStatus = execSync('git status --porcelain', { cwd: process.cwd(), encoding: 'utf8' }).trim();
  const workingTreeCleanEnd = dirtyStatus.length === 0;
  const reportPath = process.env.SYNC_BENCHMARK_REPORT_PATH ?? '/tmp/opencode/server-sync-benchmark-report.json';
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({
    startedAt, finishedAt, gitCommitStart, gitCommitEnd,
    workingTreeCleanStart, workingTreeCleanEnd,
    workingTreeClean: workingTreeCleanStart && workingTreeCleanEnd,
    runId,
    generatedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    gitCommit: gitCommitEnd,
    protocolCoverage: { legacyRecordSync: ['S1', 'S2', 'S3', 'A3', 'C1'], v5RuntimeCoordinator: ['A2'], providerRangeAndThroughput: ['A1'] },
    node: process.versions.node, electron: process.versions.electron,
    scope: 'Linux Electron, migrated disk SQLite, production E2EE/Zstd record sync over loopback HTTP DAV; five-round DAV/S3/FTP network microbenchmarks, not WAN or physical mobile performance',
    implementationNames: { DsixIndexManager: 'IndexChainManager', FramedPackBuilder: 'encodeFramedPack', PluginSyncSandbox: 'createScopedPluginSyncStore' },
    metrics,
  }, null, 2));
  await h.dispose();
  for (const codec of codecs) codec.dispose();
  if (oldTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmpdir;
  if (scratch) await rm(scratch, { recursive: true, force: true });
}, 180_000);

describe('Linux server sync: stability / availability / convenience', () => {
  it('S1_multi_device_out_of_order_convergence', async () => measure('S1_multi_device_out_of_order_convergence', async () => {
    const dav = await davServer();
    try {
      const a = await peer('s1-A', dav.endpoint), b = await peer('s1-B', dav.endpoint), c = await peer('s1-C', dav.endpoint);
      business(a.device, 'A', 20); business(c.device, 'C', 20);
      // blobs is a real RowSync business table without deleted_at: exercise
      // physical DELETE using its production trigger, not a fixture engine event.
      for (let i = 0; i < 20; i++) h.db(a.device, 'vfs').run('INSERT INTO blobs(hash,relative_path,size,mime_type,ref_count,created_at) VALUES(?,?,0,?,0,?)', [`purged-${i}`, `unused-${i}`, 'application/octet-stream', h.nextMs()]);
      await publish(a); await publish(c);
      await receive(b); // B observes A1 + C1 before A2 exists.
      const deletedAt = h.nextMs();
      for (let i = 0; i < 20; i++) {
        const id = `A-${i}`;
        h.db(a.device, 'vfs').run('UPDATE folders SET title=?,deleted_at=?,updated_at=? WHERE id=?', [`edited-${id}`, i % 2 === 0 ? deletedAt : null, h.nextMs(), id]);
        h.db(a.device, 'chat_v2').run('UPDATE chat_v2_sessions SET title=?,updated_at=? WHERE id=?', [`edited-${id}`, h.nextIso(), id]);
        h.db(a.device, 'mistakes').run('UPDATE mistakes SET user_question=?,updated_at=? WHERE id=?', [`edited-${id}`, h.nextIso(), id]);
        h.db(a.device, 'vfs').run('DELETE FROM blobs WHERE hash=?', [`purged-${i}`]);
      }
      await publish(a);
      // Reverse physical HTTP arrival; the production downloader must still
      // canonicalize sequences rather than acknowledging a hole in A's history.
      const keys = await c.storage.list('data_governance/changes');
      const ownA = keys.filter(x => parseChangeKey(x.key)?.deviceId === deviceIdShortHash(a.device.deviceId)).sort((x, y) => x.key.localeCompare(y.key));
      expect(ownA).toHaveLength(2);
      const arrival = dav.requests.length;
      for (const key of [...ownA].reverse()) expect(await c.storage.get(key.key)).not.toBeNull();
      expect(dav.requests.slice(arrival).filter(r => r.method === 'GET').map(r => r.path)).toEqual([...ownA].reverse().map(k => `/bench/${k.key}`));
      dav.reverseListings(true);
      await receive(c);
      dav.reverseListings(false);
      await receive(b);
      business(b.device, 'B', 20); await publish(b);
      await receive(c); await receive(a); await receive(b);
      // Oracle is derived from the workload specification, never another DB.
      const ids = ['A', 'B', 'C'].flatMap(owner => Array.from({ length: 20 }, (_, i) => `${owner}-${i}`)).sort();
      const oracle = {
        folders: ids.map(id => ({ id, title: id.startsWith('A-') ? `edited-${id}` : id, deleted_at: id.startsWith('A-') && Number(id.slice(2)) % 2 === 0 ? String(deletedAt) : null })),
        notes: ids.map(id => ({ id, title: id })),
        sessions: ids.map(id => ({ id, title: id.startsWith('A-') ? `edited-${id}` : id })),
        messages: ids.map(id => ({ id, session_id: id })),
        mistakes: ids.map(id => ({ id, user_question: id.startsWith('A-') ? `edited-${id}` : id })),
      };
      for (const p of [a, b, c]) {
        expect(projection(p.device)).toEqual(oracle);
        expect(h.db(p.device, 'vfs').all("SELECT hash FROM blobs WHERE hash LIKE 'purged-%'")).toHaveLength(0);
        expect((await receive(p)).changes).toHaveLength(0);
      }
      const manifests = await readDeviceManifests(a.storage, a.options);
      expect(BigInt(manifests.get(a.device.deviceId)!.published_max_seq)).toBe(2n);
      // A second workload shares every business key across three offline writers.
      // Apply actual encrypted remote batches in two orders to independent disk DBs.
      // The legacy downloader intentionally blocks sequence holes; this matrix
      // exercises the production materializer's convergence, not cursor bypass.
      const ma = await peer('matrix-A', dav.endpoint, 'benchmark-e2ee', 'matrix');
      const mb = await peer('matrix-B', dav.endpoint, 'benchmark-e2ee', 'matrix');
      const mc = await peer('matrix-C', dav.endpoint, 'benchmark-e2ee', 'matrix');
      for (let i = 0; i < 12; i++) {
        folder(ma.device, `shared-${i}`);
        h.db(ma.device, 'vfs').run('INSERT INTO blobs(hash,relative_path,size,mime_type,ref_count,created_at) VALUES(?,?,0,?,0,?)', [`shared-blob-${i}`, `initial-${i}`, 'application/octet-stream', h.nextMs()]);
      }
      const nextWallSecond = async () => {
        const beforeSec = Math.floor(Date.now() / 1000);
        while (Math.floor(Date.now() / 1000) <= beforeSec) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      };
      await publish(ma); await receive(mb); await receive(mc);
      await nextWallSecond();
      for (let i = 0; i < 12; i++) {
        h.db(mb.device, 'vfs').run('UPDATE folders SET title=?,updated_at=? WHERE id=?', [`B-${i}`, h.nextMs(), `shared-${i}`]);
        h.db(mb.device, 'vfs').run('UPDATE blobs SET relative_path=? WHERE hash=?', [`B-${i}`, `shared-blob-${i}`]);
      }
      await publish(mb);
      await nextWallSecond();
      const cDeletedAt = h.nextMs();
      for (let i = 0; i < 12; i++) {
        h.db(mc.device, 'vfs').run('UPDATE folders SET title=?,deleted_at=?,updated_at=? WHERE id=?', [`C-${i}`, i % 2 ? cDeletedAt : null, h.nextMs(), `shared-${i}`]);
        if (i % 2) h.db(mc.device, 'vfs').run('DELETE FROM blobs WHERE hash=?', [`shared-blob-${i}`]);
      }
      await publish(mc);
      await nextWallSecond();
      const aDeletedAt = h.nextMs();
      for (let i = 0; i < 12; i++) {
        if (i % 2 === 0) h.db(ma.device, 'vfs').run('UPDATE folders SET title=?,deleted_at=?,updated_at=? WHERE id=?', [`A2-${i}`, aDeletedAt, h.nextMs(), `shared-${i}`]);
        h.db(ma.device, 'vfs').run('DELETE FROM blobs WHERE hash=?', [`shared-blob-${i}`]);
      }
      await publish(ma);
      const matrixPackets = [...dav.objects].filter(([key]) => key.startsWith('/matrix/') && parseChangeKey(key.slice('/matrix/'.length)));
      expect(matrixPackets).toHaveLength(4);
      const aKeys = matrixPackets.filter(([key]) => parseChangeKey(key.slice('/matrix/'.length))!.deviceId === deviceIdShortHash(ma.device.deviceId)).sort(([x], [y]) => x.localeCompare(y));
      const packet = {
        A1: aKeys[0]!, A2: aKeys[1]!,
        B1: matrixPackets.find(([key]) => parseChangeKey(key.slice('/matrix/'.length))!.deviceId === deviceIdShortHash(mb.device.deviceId))!,
        C1: matrixPackets.find(([key]) => parseChangeKey(key.slice('/matrix/'.length))!.deviceId === deviceIdShortHash(mc.device.deviceId))!,
      };
      const orders = [['A1', 'A2', 'B1', 'C1'], ['C1', 'A2', 'B1', 'A1']] as const;
      const matrixOracle = Array.from({ length: 12 }, (_, i) => ({ id: `shared-${i}`, title: i % 2 ? `C-${i}` : `A2-${i}`, deleted_at: String(i % 2 ? cDeletedAt : aDeletedAt) })).sort((x, y) => x.id.localeCompare(y.id));
      for (const [n, order] of orders.entries()) {
        const target = await peer(`matrix-target-${n}`, dav.endpoint, 'benchmark-e2ee', 'matrix');
        const logStart = dav.requests.length;
        for (const label of order) {
          const [key] = packet[label];
          const encrypted = (await target.storage.get(key.slice('/matrix/'.length)))!;
          const decoded = await compression.zstdDecode(await target.options.codec.decode(encrypted));
          const payload = parseChangesPayload(parseJsonLossless(Buffer.from(decoded).toString('utf8')));
          const changes = payload.changes.map(change => ({ ...change, source_device_id: payload.source_device_id, source_seq: payload.source_seq }));
          const result = applyDownloadedChangesToDatabases(target.device.storage, changes, 'KeepLatest', target.device.deviceId);
          expect(result.total_failed).toBe(0); expect(result.total_incomplete_skipped).toBe(0);
        }
        expect(dav.requests.slice(logStart).filter(r => r.method === 'GET').map(r => r.path)).toEqual(order.map(label => packet[label][0]));
        expect(h.db(target.device, 'vfs').all('SELECT id,title,deleted_at FROM folders ORDER BY id')).toEqual(matrixOracle);
        expect(h.db(target.device, 'vfs').all('SELECT hash FROM blobs')).toEqual([]);
      }
      return { devices: 3, oracleRowsPerDevice: ids.length * 5, convergencePercent: 100, resurrectionPercent: 0, softDeletedRows: 10, hardDeletedRows: 20, arrivalOrderC: ['A2', 'A1'], sameKeyConflictMatrix: { writers: 3, independentTargets: 2, sharedFolderKeys: 12, sharedBlobKeys: 12, arrivalOrders: orders, softDeletedPerTarget: 12, hardDeletedPerTarget: 12, convergencePercent: 100, resurrectionPercent: 0 }, commitOrderC: 'production canonical sequence order', transport: 'HTTP WebDAV + production E2EE/Zstd upload/download/apply/commit', hardDeleteScope: 'production blobs table via SQL DELETE triggers; no timestamp modification' };
    } finally { await dav.close(); }
  }), 600_000);

  it('S2_cross_version_unknown_column_preservation', async () => measure('S2_cross_version_unknown_column_preservation', async () => {
    const dav = await davServer();
    try {
      const v1 = await peer('s2-v1', dav.endpoint), v2 = await peer('s2-v2', dav.endpoint);
      const old = h.db(v1.device, 'vfs'), next = h.db(v2.device, 'vfs');
      next.exec('ALTER TABLE folders ADD COLUMN future_col TEXT');
      next.transaction(() => {
        for (let i = 0; i < 100; i++) {
          folder(v2.device, `version-${i}`);
          next.run('UPDATE folders SET future_col=?,updated_at=? WHERE id=?', [`future-${i}`, h.nextMs(), `version-${i}`]);
        }
      });
      expect((await collectSyncChanges(v2.device.storage, null)).length).toBeGreaterThanOrEqual(100);
      await publish(v2); await receive(v1);
      for (let i = 0; i < 100; i++) {
        expect(JSON.parse(old.pluck<string>('SELECT fields_json FROM __sync_unknown_fields WHERE record_id=?', [`version-${i}`])!)).toHaveProperty('future_col', `future-${i}`);
      }
      old.transaction(() => {
        for (let i = 0; i < 100; i++) {
          old.run('UPDATE folders SET title=?,updated_at=? WHERE id=?', ['v1-edited', h.nextMs(), `version-${i}`]);
        }
      });
      await publish(v1); await receive(v2);
      const oracle = Array.from({ length: 100 }, (_, i) => ({ id: `version-${i}`, title: 'v1-edited', future_col: `future-${i}` })).sort((a, b) => a.id.localeCompare(b.id));
      expect(next.all('SELECT id,title,future_col FROM folders ORDER BY id')).toEqual(oracle);
      old.exec('ALTER TABLE folders ADD COLUMN future_col TEXT');
      rehydrateUnknownFieldsIfColumnsExist(old, 'folders');
      expect(old.all('SELECT id,title,future_col FROM folders ORDER BY id')).toEqual(oracle);
      return { records: 100, unknownFieldPreservationPercent: 100, rehydratedFields: 100, lossPercent: 0, capture: 'production folders triggers', transport: 'E2EE/Zstd WebDAV both directions' };
    } finally { await dav.close(); }
  }), 180_000);

  it('S3_network_chaos_and_interruption_recovery', async () => measure('S3_network_chaos_and_interruption_recovery', async () => {
    const dav = await davServer();
    try {
      const payload = randomBytes(128 * 1024);
      const dest = join(scratch, 'recovery.download');
      let diskAtDisconnect = -1;
      const ranges: string[] = [];
      // Unlike destroySocket-before-headers, this sends a real response body.
      // Wait for the client to persist the prefix before cutting the socket.
      const stream = createServer((req, res) => {
        if (req.method === 'PROPFIND') {
          res.writeHead(207); res.end(filePropfindXml('/bench/recovery.dspk', payload.length)); return;
        }
        if (!req.headers.range) {
          res.writeHead(200, { 'Content-Length': payload.length }); res.flushHeaders();
          res.write(payload.subarray(0, 65536));
          const cut = async () => {
            const size = await stat(dest).then(s => s.size, () => 0);
            if (size === 65536) { diskAtDisconnect = size; res.socket?.destroy(); }
            else setTimeout(() => { void cut(); }, 5);
          };
          void cut(); return;
        }
        ranges.push(req.headers.range);
        const offset = Number(/^bytes=(\d+)-/.exec(req.headers.range)![1]);
        res.writeHead(206, { 'Content-Length': payload.length - offset, 'Content-Range': `bytes ${offset}-${payload.length - 1}/${payload.length}` }); res.end(payload.subarray(offset));
      });
      await new Promise<void>(resolve => stream.listen(0, '127.0.0.1', resolve));
      const address = stream.address() as { port: number };
      try {
        const storage = new WebDavStorage({ endpoint: `http://127.0.0.1:${address.port}/`, username: 'bench', password: 'local-only' }, 'bench', { rateLimitEnv: '0' });
        const digest = createHash('sha256').update(payload).digest('hex');
        expect(await getFileWithOptionalResume(storage, 'recovery.dspk', dest, digest)).toBe(digest);
        expect(diskAtDisconnect).toBe(65536); expect(ranges).toContain('bytes=65536-');
        expect(Buffer.compare(await readFile(dest), payload)).toBe(0);
      } finally { await new Promise<void>(resolve => { stream.close(() => resolve()); stream.closeAllConnections(); }); }

      const a = await peer('s3-writer', dav.endpoint), b = await peer('s3-receiver', dav.endpoint);
      folder(a.device, 'crash-1'); folder(a.device, 'crash-2');
      await expect(publish(a, true)).rejects.toThrow('before local marking');
      expect((await collectSyncChanges(a.device.storage, null)).filter(c => c.table_name === 'folders' && c.record_id.startsWith('crash-'))).toHaveLength(2);
      const immutable = new Map([...dav.objects].filter(([key]) => parseChangeKey(key.replace('/bench/', '')) !== null));
      await publish(a); // same writer, same on-disk pending log, no reset.
      for (const [key, bytes] of immutable) expect(Buffer.compare(dav.objects.get(key)!, bytes)).toBe(0);
      const db = h.db(b.device, 'vfs');
      db.exec("CREATE TABLE bench_partial_apply(id TEXT); CREATE TRIGGER bench_fail BEFORE INSERT ON folders WHEN NEW.id='crash-2' BEGIN INSERT INTO bench_partial_apply VALUES(NEW.id); SELECT RAISE(FAIL,'injected apply failure'); END");
      const instance = await ensureRemoteInstanceId(b.storage, b.options, b.openState);
      await expect(receive(b)).rejects.toThrow('apply failed');
      expect(b.state.getCursor(instance, a.device.deviceId)).toBe(0n);
      expect(db.get("SELECT id FROM folders WHERE id='crash-2'")).toBeUndefined();
      expect(db.all('SELECT * FROM bench_partial_apply')).toHaveLength(0);
      // Savepoint failure must not leak sync suppression or an open write lock.
      db.transaction(() => folder(b.device, 'local-after-failure'));
      db.exec('DROP TRIGGER bench_fail');
      await receive(b);
      expect(db.all("SELECT id FROM folders WHERE id LIKE 'crash-%' ORDER BY id")).toEqual([{ id: 'crash-1' }, { id: 'crash-2' }]);
      expect(b.state.getCursor(instance, a.device.deviceId)).toBe(2n);
      return { interruptedDownloads: 1, diskBytesBeforeSocketDestroy: diskAtDisconnect, observedRanges: ranges, recoveredBytes: payload.length, checksum: 'SHA-256 verified', uploadCrashRecoveredOnSameDevice: true, immutableRemoteObjectsPreserved: immutable.size, applySavepointRecoveredOnSameDevice: true, cursorBeforeRetry: 0, cursorAfterRetry: 2 };
    } finally { await dav.close(); }
  }), 180_000);

  it('A1_three_protocols_end_to_end_benchmark', async () => measure('A1_three_protocols_end_to_end_benchmark', async () => {
    const dav = await davServer(); const objects = new Map<string, Buffer>();
    const s3 = await spawnFakeS3(request => {
      if (request.method === 'GET' && request.query.has('list-type')) return { status: 200, body: `<ListBucketResult><IsTruncated>false</IsTruncated>${[...objects].map(([key, value]) => `<Contents><Key>${key.replace('/test-bucket/', '')}</Key><Size>${value.length}</Size><LastModified>2026-11-09T00:00:00Z</LastModified></Contents>`).join('')}</ListBucketResult>` };
      if (request.method === 'PUT') { objects.set(request.path, request.body); return { status: 200 }; }
      if (request.method === 'DELETE') { objects.delete(request.path); return { status: 204 }; }
      const data = objects.get(request.path); if (!data) return { status: 404, body: '<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>' };
      if (request.method === 'HEAD') return { status: 200, declaredLength: data.length };
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
      if (!range) return { status: 200, body: data };
      const start = Number(range[1]), end = range[2] ? Number(range[2]) : data.length - 1;
      return { status: 206, body: data.subarray(start, end + 1), headers: { 'Content-Range': `bytes ${start}-${end}/${data.length}` } };
    });
    const ftp = await spawnFakeFtp();
    const protocols: [string, CloudStorage][] = [ ['webdav', dav.storage], ['s3', new S3Storage({ endpoint: s3.endpoint, bucket: 'test-bucket', accessKeyId: 'local', secretAccessKey: 'local', region: 'us-east-1', pathStyle: true }, 'bench')], ['ftp', new FtpStorage({ host: ftp.host, port: ftp.port, username: 'local', password: 'local', useTls: false }, 'bench')] ];
    const results: Record<string, unknown> = {};
    try {
      for (const [name, storage] of protocols) {
        const rounds = [];
        for (let round = 0; round < 5; round++) {
          const plain = randomBytes(1024 * 1024), mk = randomBytes(32), cid = randomBytes(32), key = `bench-${round}.dspk`;
          let start = performance.now(); const pack = encodeFramedPack([plain], mk, cid, context); const packEncryptMs = performance.now() - start;
          start = performance.now(); await storage.put(key, pack.bytes); const uploadNetworkMs = performance.now() - start;
          start = performance.now(); const downloadedBytes = Buffer.from((await storage.get(key))!); const downloadNetworkMs = performance.now() - start;
          // Exercise each production provider's exact-length range implementation.
          start = performance.now(); const range = await storage.getRange(key, 64, 4096); const rangeReadNetworkMs = performance.now() - start;
          start = performance.now();
          const decoded = await readPackEntryRange({ getRange: async (_key, off, len) => downloadedBytes.subarray(off, off + len) }, key, downloadedBytes.subarray(0, 64), downloadedBytes.length, pack.entries[0]!, mk, cid, context, fastCdc);
          const packDecryptMs = performance.now() - start;
          // Every assertion is outside ALL measured stages; native byte compare
          // avoids Vitest's multi-second per-element Uint8Array traversal.
          expect(Buffer.compare(downloadedBytes, Buffer.from(pack.bytes))).toBe(0);
          expect(Buffer.compare(Buffer.from(decoded), plain)).toBe(0);
          expect(Buffer.compare(Buffer.from(range), downloadedBytes.subarray(64, 4160))).toBe(0);
          rounds.push({ packEncryptMs, uploadNetworkMs, downloadNetworkMs, rangeReadNetworkMs, packDecryptMs, uploadMiBPerSec: 1000 / uploadNetworkMs, downloadMiBPerSec: 1000 / downloadNetworkMs });
          await storage.delete(key);
        }
        const median = (values: number[]) => [...values].sort((a, b) => a - b)[2];
        const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
        results[name] = { plaintextBytes: 1024 * 1024, rounds, medianUploadMs: median(rounds.map(r => r.uploadNetworkMs)), medianDownloadMs: median(rounds.map(r => r.downloadNetworkMs)), medianMiBPerSec: median(rounds.map(r => r.downloadMiBPerSec)), medianUploadMiBPerSec: median(rounds.map(r => r.uploadMiBPerSec)), meanUploadMs: mean(rounds.map(r => r.uploadNetworkMs)), meanDownloadMs: mean(rounds.map(r => r.downloadNetworkMs)), meanMiBPerSec: mean(rounds.map(r => r.downloadMiBPerSec)), rangeReadScope: name === 'ftp' ? 'production getRange: bounded full-object fallback, offset 64 length 4096' : 'production getRange: HTTP bytes=64-4159', decryptSource: 'downloaded network bytes' };
      }
      return results;
    } finally { await dav.close(); await s3.close(); await ftp.server.close(); }
  }), 180_000);

  it('A2_high_frequency_incremental_dsix_compaction', async () => measure('A2_high_frequency_incremental_dsix_compaction', async () => {
    const dav = await davServer();
    const secrets = { kCid: randomBytes(32), masterKeys: new Map([[0, randomBytes(32)]]) };
    const a = await h.device('a2-source'), b = await h.device('a2-target');
    a.storage.database('sync_state').exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    b.storage.database('sync_state').exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    const reader = new WebDavStorage({ endpoint: dav.endpoint, username: 'bench', password: 'local-only' }, 'bench', { rateLimitEnv: '0' });
    const runtime = (device: RealisticDevice, storage: WebDavStorage) => new SyncV5RuntimeCoordinator({
      repoId: 'a2', deviceId: device.deviceId, storage, secrets,
      stateDb: device.storage.database('sync_state'), databases: new Map([['vfs', h.db(device, 'vfs')]]),
    });
    const sender = runtime(a, dav.storage), receiver = runtime(b, reader);
    let peak = 0, peakRetained = 0, compactions = 0, rangeBytes = 0, oldFrameReads = 0;
    const seenFrames = new Set<string>();
    const frameReadLog: { round: number; path: string; range: string }[] = [];
    const inspect = sender as unknown as { unseal(bytes: Uint8Array): { chain: { generation: number; base: { key: string }; deltas: { key: string }[] }; retired: string[][] } };
    try {
      for (let i = 0; i < 300; i++) {
        folder(a, `increment-${i}`);
        const pending = h.collectPending(a, 'vfs');
        const changes = pending.filter(change => change.table_name === 'folders' && change.record_id === `increment-${i}`);
        expect(changes).toHaveLength(1);
        const publishStart = dav.requests.length;
        expect(await sender.publishChangesToV5Cloud(changes)).toEqual({ published: 1 });
        h.markSynced(a, 'vfs', pending);
        const newPacks = new Set(dav.requests.slice(publishStart).filter(r => r.method === 'PUT' && r.path.endsWith('.pack')).map(r => r.path));
        expect(newPacks.size).toBe(1);
        const logStart = dav.requests.length;
        expect(await receiver.pullAndApplyFromV5Cloud()).toEqual({ applied: 1, downloadedEntries: 1 });
        expect(h.db(b, 'vfs').pluck('SELECT title FROM folders WHERE id=?', [`increment-${i}`])).toBe(`increment-${i}`);
        for (const request of dav.requests.slice(logStart)) {
          if (request.method !== 'GET' || !request.path.endsWith('.pack') || request.headers.range === 'bytes=0-63') continue;
          const range = request.headers.range ?? 'full';
          const identity = `${request.path}:${range}`;
          if (seenFrames.has(identity) || !newPacks.has(request.path)) oldFrameReads++;
          seenFrames.add(identity);
          frameReadLog.push({ round: i, path: request.path, range });
          const match = /^bytes=(\d+)-(\d+)$/.exec(range);
          expect(match).not.toBeNull();
          rangeBytes += Number(match![2]) - Number(match![1]) + 1;
        }
        const headBytes = [...dav.objects].find(([key]) => key.includes('/sync-v5/a2/heads/'))![1];
        const head = inspect.unseal(headBytes);
        const active = 1 + head.chain.deltas.length;
        peak = Math.max(peak, active); peakRetained = Math.max(peakRetained, head.retired.length);
        expect(active).toBeLessThanOrEqual(9); expect(head.retired.length).toBeLessThanOrEqual(2);
        const allIndices = [...dav.objects.keys()].filter(key => key.endsWith('.dsix'));
        // A compaction also supersedes its triggering delta, which is never
        // uploaded separately; retained metadata can therefore exceed objects.
        expect(allIndices.length).toBeLessThanOrEqual(active + head.retired.flat().length);
        const permitted = [head.chain.base.key, ...head.chain.deltas.map(index => index.key), ...head.retired.flat()];
        for (const path of allIndices) expect(permitted.some(key => path.endsWith(key.split('/').slice(2).join('/')))).toBe(true);
        expect(allIndices.length).toBeLessThanOrEqual(29);
        if (head.chain.deltas.length === 0) compactions++;
      }
      expect(oldFrameReads).toBe(0); expect(frameReadLog).toHaveLength(300);
      expect(h.db(b, 'vfs').all("SELECT id,title FROM folders WHERE id LIKE 'increment-%' ORDER BY id")).toEqual(Array.from({ length: 300 }, (_, i) => ({ id: `increment-${i}`, title: `increment-${i}` })).sort((x, y) => x.id.localeCompare(y.id)));
      expect(receiver.versionVector.get(`${a.deviceId}@${sender.incarnationId}`)?.contiguousSeq).toBe(300n);
      expect(compactions).toBeGreaterThan(0);
      const parentDevice = await h.device('a2-parent-writer');
      const senderB = runtime(parentDevice, dav.storage);
      const source = h.db(a, 'vfs'), parentSource = h.db(parentDevice, 'vfs'), target = h.db(b, 'vfs');
      source.exec('PRAGMA foreign_keys=ON'); parentSource.exec('PRAGMA foreign_keys=ON'); target.exec('PRAGMA foreign_keys=ON');
      const ms = h.nextMs(), ts = h.nextIso();
      parentSource.run("INSERT INTO resources(id,hash,type,data,ref_count,created_at,updated_at,storage_mode) VALUES('v5-parent','v5-hash','note','body',1,?,?,'inline')", [ms, ms]);
      const parents = h.collectPending(parentDevice, 'vfs').filter(change => change.record_id === 'v5-parent');
      expect((await senderB.publishChangesToV5Cloud(parents)).published).toBe(1);
      h.markSynced(parentDevice, 'vfs', parents);
      expect((await sender.pullAndApplyFromV5Cloud()).applied).toBe(1);
      source.run("INSERT INTO notes(id,resource_id,title,tags,is_favorite,created_at,updated_at) VALUES('v5-child','v5-parent','关联笔记','[]',0,?,?)", [ts, ts]);
      const related = h.collectPending(a, 'vfs').filter(change => change.record_id === 'v5-parent' || change.record_id === 'v5-child');
      expect(related.map(change => change.table_name)).toEqual(['notes']);
      expect((await sender.publishChangesToV5Cloud(related)).published).toBe(1);
      expect((await receiver.pullAndApplyFromV5Cloud()).applied).toBe(2);
      expect(target.get("SELECT n.id,n.resource_id,r.data FROM notes n JOIN resources r ON r.id=n.resource_id WHERE n.id='v5-child'"))
        .toEqual({ id: 'v5-child', resource_id: 'v5-parent', data: 'body' });
      return { rounds: 300, sqliteRows: 300, v5ForeignKeyRows: 2, peakActiveDsixObjects: peak, peakRetainedGenerations: peakRetained, finalTotalDsixObjects: [...dav.objects.keys()].filter(key => key.endsWith('.dsix')).length, compactions, newEntryRangeReads: frameReadLog.length, newFrameCiphertextBytes: rangeBytes, oldFrameReads, observedFrameRequests: frameReadLog, receiverDiscovery: 'production SyncV5RuntimeCoordinator + WebDavStorage.getRange + migrated disk SQLite' };
    } finally { await dav.close(); }
  }), 180_000);

  it('A3_e2ee_wrong_password_and_plugin_quota_isolation', async () => measure('A3_e2ee_wrong_password_and_plugin_quota_isolation', async () => {
    const dav = await davServer();
    try {
      const a = await peer('s4-source', dav.endpoint), wrong = await peer('s4-wrong', dav.endpoint, 'wrong-password'), good = await peer('s4-good', dav.endpoint);
      business(a.device, 'secure', 3); await publish(a);
      const before = projection(wrong.device);
      const requestStart = dav.requests.length;
      const start = performance.now();
      await expect(receive(wrong)).rejects.toThrow('SYNC_E2EE_WRONG_PASSWORD');
      const wrongPasswordRejectMs = performance.now() - start;
      expect(projection(wrong.device)).toEqual(before);
      const instance = await ensureRemoteInstanceId(a.storage, a.options, a.openState);
      expect(wrong.state.cursors(instance).size).toBe(0);
      expect(dav.requests.slice(requestStart).some(r => r.method === 'GET' && r.path.includes('manifests'))).toBe(true);
      const db = h.db(a.device, 'vfs'); ensurePluginSyncRecordsTable(db); let ticks = 0;
      const contextForPlugin = { deviceId: a.device.deviceId, nextHlc: () => `${++ticks}` };
      const alpha = createScopedPluginSyncStore(db, { pluginId: 'plugin.alpha', pluginSchemaVersion: 1 }, contextForPlugin);
      const beta = createScopedPluginSyncStore(db, { pluginId: 'plugin.beta', pluginSchemaVersion: 1 }, contextForPlugin);
      for (let i = 0; i < 80; i++) alpha.put('ns', String(i), 'x'.repeat(65000));
      const count = db.pluck('SELECT count(*) FROM __plugin_sync_records'), log = db.all('SELECT * FROM __change_log ORDER BY id');
      expect(() => alpha.put('ns', 'overflow', 'x'.repeat(65000))).toThrow(PluginQuotaExceededError);
      expect(db.pluck('SELECT count(*) FROM __plugin_sync_records')).toBe(count);
      expect(db.all('SELECT * FROM __change_log ORDER BY id')).toEqual(log);
      beta.put('ns', 'independent', { content: 'beta succeeds after alpha quota' });
      expect(beta.get('ns', 'independent')).toEqual({ content: 'beta succeeds after alpha quota' });
      folder(a.device, 'core-unaffected', 'core'); await publish(a); await receive(good);
      expect(h.db(good.device, 'vfs').pluck("SELECT title FROM folders WHERE id='core-unaffected'")).toBe('core');
      return { wrongPasswordRejectMs, localCoreRowsChangedOnRejection: 0, cursorChangesOnRejection: 0, pluginNamespaces: ['plugin.alpha', 'plugin.beta'], alphaRecords: count, betaWriteSucceeded: true, quotaBytes: 5 * 1024 * 1024, rollbackPreservedRowsAndLog: true, coreCloudSyncUnaffected: true };
    } finally { await dav.close(); }
  }), 180_000);

  it('C1_one_click_pairing_to_first_sync_closed_loop', async () => measure('C1_one_click_pairing_to_first_sync_closed_loop', async () => {
    const dav = await davServer();
    try {
      const initial = {
        'cloud_storage.config.safe_v1': JSON.stringify({ provider: 'webdav', root: 'bench', webdav: { endpoint: dav.endpoint, username: 'bench' } }),
        cloud_storage_credentials: JSON.stringify({ webdavPassword: 'local-only', encryptionPassword: 'benchmark-e2ee' }),
        'cloud_sync.remote_path': '/bench', api_configs: JSON.stringify(['one', 'two', 'three'].map(id => ({ id, apiKey: `local-test-${id}` }))),
        vendor_configs: '[]', 'sync.include_skills': 'true', 'sync.include_plugins': 'true',
      };
      const a = await peer('paired-source', dav.endpoint);
      business(a.device, 'paired', 10); const uploadedRows = await publish(a);
      const blank = await h.device('paired-target');
      const source = settings(h.db(a.device, 'vfs'), initial), target = settings(h.db(blank, 'vfs')); const start = performance.now();
      const created = await createPairingCode(source, { pin: '123456', includeCloudConfig: true, includeLlmKeys: true, includeSyncPrefs: true });
      await applyPairingCode(target, { pairingCode: created.pairingCode, pin: '123456' });
      for (const [key, value] of Object.entries(initial)) expect(await target.getSecret(key)).toBe(value);
      const safe = JSON.parse(target.get('cloud_storage.config.safe_v1')!);
      const credentials = JSON.parse((await target.getSecret('cloud_storage_credentials'))!);
      // All receiver connection and encryption inputs come from its own
      // persisted pairing settings; no sender codec/key/location/provider reuse.
      const codec = await createPayloadCodec(createBackupCrypto({ nativeArgon2: argon2 }), credentials.encryptionPassword); codecs.push(codec);
      const state = new SqliteSyncStateStore(() => blank.storage.database('sync_state'));
      const b: Peer = {
        device: blank,
        storage: new WebDavStorage({ ...safe.webdav, password: credentials.webdavPassword }, safe.root, { rateLimitEnv: '0' }),
        options: { deviceId: blank.deviceId, codec }, state, openState: () => state,
      };
      expect(projection(b.device).folders).toHaveLength(0);
      const received = await receive(b);
      expect(projection(b.device)).toEqual(projection(a.device));
      expect(received.changes.length).toBe(uploadedRows);
      return { pairingAndFirstSyncMs: performance.now() - start, pairingCodeFields: 1, pinDigits: 6, interactionInputsIncludingPin: 2, aiProviders: 3, firstSyncRows: received.changes.length, businessRecords: 50, transport: 'persisted pairing -> independent WebDAV/codec -> production download/apply/commit', sharedSenderSecretsOrLocations: false };
    } finally { await dav.close(); }
  }), 180_000);
});

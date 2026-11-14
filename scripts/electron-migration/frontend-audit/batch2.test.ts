/** Targeted real-plugin/real-kernel probes, NOT the 1,673-site scan.
 * Tested actors: actual chat/memory/media default plugins. Only external shell,
 * settings/log/VFS service ports are supplied through kernel testing.provide.
 * No plugin implementation or command handler is recreated here.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createTestHost, HandlerPanic } from '../../../host/kernel/testing.ts';
import { createStorageService } from '../../../host/platform/storage/service.ts';
import chat from '../../../host/plugins/chat/index.ts';
import memory from '../../../host/plugins/memory/index.ts';
import media from '../../../host/plugins/media/index.ts';
import { MediaTranscriptRepo } from '../../../host/plugins/vfs-repos/repository/media-transcripts.ts';
import { TextbookRepo } from '../../../host/plugins/vfs-repos/repository/textbooks.ts';
import { BlobRepo } from '../../../host/plugins/vfs-repos/repository/blobs.ts';
import { FolderRepo } from '../../../host/plugins/vfs-repos/repository/folders.ts';
import { ContractSet } from '../../../host/kernel/contracts.ts';
import { commandNotFound } from '../../../host/kernel/errors.ts';
import { heic } from '../../../host/platform/native/heic/index.ts';
import { compareShapes, resolveSchema } from './schema.ts';

const settings = () => {
  const values = new Map<string, string>();
  return { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => { values.set(key, value); } };
};
const log = { logger: () => ({ error() {}, warn() {}, info() {}, debug() {}, trace() {} }) };
const unused = () => { throw new Error('unexpected external service access in this probe'); };

type Storage = ReturnType<typeof createStorageService>;
type Extra = Record<string, unknown> | ((storage: Storage, root: string) => Record<string, unknown>);

async function fixture(plugins: any[], extra: Extra = {}, shell?: (op: string, args: unknown) => unknown) {
  const root = fs.mkdtempSync('/tmp/opencode/x2-batch2-');
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  try {
    const more = typeof extra === 'function' ? extra(storage, root) : extra;
    const host = await createTestHost({ app: { dataDir: root, platform: 'linux' }, plugins,
      provide: { storage, settings: settings(), log, paths: { appDataDir: root },
        vfs: { database: { getConnSafe: unused } }, notes: { repository: {} }, vfsRepo: {}, ...more }, shell });
    return { host, storage, root, async dispose() { await host.dispose(); storage.dispose(); fs.rmSync(root, { recursive: true, force: true }); } };
  } catch (e) { storage.dispose(); fs.rmSync(root, { recursive: true, force: true }); throw e; }
}

/** Kernel's own unknown-command rejection (debug or release wording). */
const notFound = (cmd: string, e: unknown) => e === commandNotFound(cmd, true) || e === commandNotFound(cmd, false);

const absentChat = [
  ['X2-R07', 'chat_v2_send_message', { request: { sessionId: 'sess_probe', content: 'hello' } }],
  ['X2-R08', 'chat_v2_retry_message', { sessionId: 'sess_probe', messageId: 'msg_probe' }],
  ['X2-R09', 'chat_v2_edit_and_resend', { sessionId: 'sess_probe', messageId: 'msg_probe', newContent: 'edited' }],
  ['X2-R10', 'chat_v2_continue_message', { sessionId: 'sess_probe', messageId: 'msg_probe' }],
  ['X2-R11', 'chat_v2_compact_session', { sessionId: 'sess_probe', modelConfigId: 'config_probe' }],
  ['X2-R12', 'chat_v2_stage_context_attachments', { sessionId: '', items: [] }],
] as const;

test('X2-R07–R12 real chat apply + kernel invoke: six Rust-defined frontend commands still not registered', async () => {
  const f = await fixture([chat]);
  try {
    const contracts = ContractSet.fromDirectory();
    for (const [id, cmd, args] of absentChat) {
      assert(contracts.get(cmd), `${id}: authoritative contract must exist`);
      assert.equal(f.host.runtime.commands.has(cmd), false, `${id}: actual post-apply registry`);
      let rejection: unknown;
      try { await f.host.invoke(cmd, args); } catch (e) { rejection = e; }
      assert(notFound(cmd, rejection), `${id}: ${String(rejection)}`);
      console.log(`${id}: ${cmd} -> ${rejection}`);
    }
  } finally { await f.dispose(); }
});

test('X2-R13 kill-switch event is emitted through the real registered command, not unproven from a constant', async () => {
  const f = await fixture([chat]);
  try {
    const result = await f.host.invoke('chat_v2_emergency_stop', { reason: '  x2 probe  ' });
    assert.equal((result as any).reason, 'x2 probe');
    assert.equal((result as any).tripped, true);
    assert.deepEqual(f.host.eventsNamed('chat_v2://kill_switch_changed'), [result]);
    const restored = await f.host.invoke('chat_v2_resume_agents');
    assert.equal((restored as any).tripped, false);
    assert.equal(f.host.eventsNamed('chat_v2://kill_switch_changed').length, 2);
  } finally { await f.dispose(); }
});

test('X2-R14–R17 quick-assistant show/hide/apply-enabled + shown event use actual memory handlers', async () => {
  const requests: string[] = [];
  const windows = new Set<string>();
  const f = await fixture([memory], {}, (op, raw) => {
    requests.push(op);
    const args = raw as any;
    switch (op) {
      case 'plugin:window|get_all_windows': return [...windows];
      case 'plugin:window|create': windows.add(args.options.label); return null;
      case 'plugin:window|destroy': windows.delete(args.label); return null;
      case 'plugin:window|is_focused': return false;
      case 'plugin:window|cursor_position': return { x: 10, y: 10 };
      case 'plugin:window|monitor_from_point': return { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } };
      case 'plugin:window|inner_size': return { width: 480, height: 384 };
      case 'plugin:window|outer_position': return { x: 100, y: 120 };
      case 'plugin:window|scale_factor': return 1;
      case 'plugin:window|set_visible_on_all_workspaces':
      case 'plugin:window|set_position':
      case 'plugin:window|set_focus':
      case 'plugin:window|show':
      case 'plugin:window|hide': return null;
      default: throw new Error(`unexpected shell request ${op}`);
    }
  });
  try {
    assert.equal(await f.host.invoke('quick_assistant_show'), null);
    assert(requests.includes('plugin:window|show'));
    assert.deepEqual(f.host.eventsNamed('quick-assistant://shown'), [null]);
    const event = f.host.events.find(e => e.event === 'quick-assistant://shown');
    // Rust quick_assistant.rs:193 uses window.emit; Tauri 2 Emitter::emit broadcasts globally.
    assert.deepEqual(event?.target, { kind: 'Any' });
    requests.length = 0;
    assert.equal(await f.host.invoke('quick_assistant_hide'), null);
    assert(requests.includes('plugin:window|hide'));
    assert.equal(await f.host.invoke('quick_assistant_apply_enabled', { enabled: false }), null);
    assert(requests.includes('plugin:window|destroy'));
    assert.equal(windows.has('quick-assistant'), false);
    console.log('X2-R14–R17: real plugin invoke resolved null; shown payload=null, target=Any; external shell is a port, not a desktop GUI');
  } finally { await f.dispose(); }
});

test('X2-R18 image base64 primary camelCase succeeds; existing snake fallback is rejected before handler', async () => {
  const f = await fixture([media]);
  try {
    fs.writeFileSync(path.join(f.root, 'image.png'), Buffer.from([137, 80, 78, 71]));
    const result = await f.host.invoke('get_image_as_base64', { relativePath: 'image.png' });
    assert.equal(result, 'data:image/png;base64,iVBORw==');
    await assert.rejects(f.host.invoke('get_image_as_base64', { relative_path: 'image.png' }), e => typeof e === 'string' && e.includes('missing required key relativePath'));
    console.log('X2-R18: primary relativePath resolved actual file; snake fallback rejected; not a newly missing Host alias');
  } finally { await f.dispose(); }
});

const mediaDb = (failCancel: boolean) => (storage: Storage) => {
  const report = storage.coordinator().migrateSingle('vfs');
  assert(report.success, JSON.stringify(report));
  const conn = storage.database('vfs');
  conn.run("INSERT INTO files (id,sha256,file_name,size,mime_type,type,status,created_at,updated_at) VALUES ('file_x2','x2sha','test.mp3',1,'audio/mpeg','audio','active','2026-01-01','2026-01-01')");
  return {
    vfsDatabase: { getConnSafe: () => conn },
    vfsRepo: { mediaTranscripts: new MediaTranscriptRepo() },
    // L12 is an external dependency port, not a replacement for the L18 subject.
    vfsIndex: { pdf: { isRunning: () => false, cancelMedia() { if (failCancel) throw new Error('x2 upstream cancel DB failure'); return false; } } },
  };
};

test('X2-R19 media_transcribe_start is registered on current main; not-found error keeps Rust MediaError payload string', async () => {
  const f = await fixture([media], mediaDb(false));
  try {
    assert.equal(f.host.runtime.commands.has('media_transcribe_start'), true);
    let rejection: unknown;
    try { await f.host.invoke('media_transcribe_start', { resourceId: 'file_missing' }); } catch (e) { rejection = e; }
    // Rust pipeline.rs:132-135 + mod.rs:93-98 -> json!({code,message}).to_string()
    assert.equal(rejection, JSON.stringify({ code: 'not-found', message: '媒体文件不存在: file_missing' }));
    console.log(`X2-R19: media_transcribe_start(file_missing) -> ${String(rejection)}`);
  } finally { await f.dispose(); }
});

test('X2-R20 textbooks_add real invoke matches Rust empty/configuration branches and text import DTO, storage and progress', async () => {
  const f = await fixture([media]);
  try {
    assert.equal(f.host.runtime.commands.has('textbooks_add'), true);
    // textbooks.rs:122-130: empty input returns before VFS lookup; nonempty input requires VFS.
    assert.deepEqual(await f.host.invoke('textbooks_add', { sources: [], folderId: null }), []);
    assert.deepEqual(f.host.events, []);
    await assert.rejects(f.host.invoke('textbooks_add', { sources: [path.join(f.root, 'probe.txt')] }), e => {
      assert.deepEqual(e, { error_type: 'Configuration', message: 'VFS database not configured', details: null });
      return true;
    });
    assert.deepEqual(f.host.events, []);
  } finally { await f.dispose(); }

  // Real L11 repositories and migrated VFS; the parser is the media plugin's actual DocsService.
  // No PDF/native render/pipeline replacement is needed for the Rust plain-text branch.
  const imported = await fixture([media], storage => {
    const report = storage.coordinator().migrateSingle('vfs');
    assert(report.success, JSON.stringify(report));
    return {
      vfsDatabase: { getConnSafe: () => storage.database('vfs'), blobsDir: () => path.join(storage.locations.activeDir, 'vfs_blobs') },
      vfsRepo: { textbooks: new TextbookRepo(), blobs: new BlobRepo(), folders: new FolderRepo() },
    };
  });
  try {
    const content = '第一章\n函数与极限\n';
    const src = path.join(imported.root, 'probe.txt');
    fs.writeFileSync(src, content);
    const result = await imported.host.invoke<Array<Record<string, unknown>>>('textbooks_add', { sources: [src], folderId: null });
    assert.equal(result.length, 1);
    const textbook = result[0]!;
    assert.equal(typeof textbook.id, 'string');
    assert.equal(typeof textbook.created_at, 'string');
    assert.equal(typeof textbook.updated_at, 'string');
    const sha = createHash('sha256').update(content).digest('hex');
    // Rust VfsTextbook::to_textbook + textbooks.rs:596-605,683-684 (snake_case legacy DTO).
    assert.deepEqual(textbook, {
      id: textbook.id, sha256: sha, file_name: 'probe.txt', file_path: src, size: Buffer.byteLength(content),
      page_count: 1, tags_json: '[]', favorite: 0, last_opened_at: null, last_page: null,
      bookmarks_json: '[]', cover_key: null, origin_json: null, status: 'active',
      created_at: textbook.created_at, updated_at: textbook.updated_at,
    });
    const row = imported.storage.database('vfs').get(
      'SELECT blob_hash, extracted_text, page_count, original_path FROM files WHERE id = ?', [textbook.id as string]);
    assert.deepEqual(row, { blob_hash: sha, extracted_text: '第一章\n函数与极限', page_count: 1, original_path: src });
    // Rust progress Option fields serialize as null (textbooks.rs:148-155), not omit.
    assert.deepEqual(imported.host.eventsNamed('textbook-import-progress'), [
      ['hashing', 5], ['copying', 10], ['parsing', 15], ['saving', 90], ['indexing', 95], ['done', 100],
    ].map(([stage, progress]) => ({ file_name: 'probe.txt', stage, current_page: null, total_pages: null, progress, error: null })));
    const watch = { type: 'created', path: `/${textbook.id}` };
    assert.deepEqual(imported.host.eventsNamed(`dstu:change:/${textbook.id}`), [watch]);
    assert.deepEqual(imported.host.eventsNamed('dstu:change'), [watch]);
    assert(imported.host.events.every(event => event.target.kind === 'Any'));
    const ordered = imported.host.events.map(event => event.event === 'textbook-import-progress'
      ? (event.payload as { stage: string }).stage : event.event);
    assert.deepEqual(ordered.slice(-4), ['indexing', `dstu:change:/${textbook.id}`, 'dstu:change', 'done']);
    console.log('X2-R20: empty=[], missing VFS=Configuration; text import DTO/storage/null progress/watch events match Rust; PDF and other formats not signed');
  } finally { await imported.dispose(); }
});

test('X2-R21 textbook progress null fields are genuine legacy frontend type mismatch, not omit semantics', () => {
  const doc = JSON.parse(fs.readFileSync('contracts/ipc/L18-media-docs.json', 'utf8'));
  const docs = new Map<string, any>([['L18-media-docs.json', doc]]);
  const event = doc.events.find((e: any) => e.name === 'textbook-import-progress');
  const payload = resolveSchema(event.payload, doc, docs);
  for (const key of ['current_page', 'total_pages', 'error']) {
    const p = payload.properties[key];
    assert.equal(p['x-option'], 'null');
    const mismatch = compareShapes(p, { type: key === 'error' ? 'string' : 'number' });
    assert(mismatch.some(problem => problem.reason.startsWith('type null ->')));
  }
  // Unlike preview's not-found-before-listen path, importActions installs the
  // listener before textbooks_add. Do not claim missing emission from silence.
});

test('X2-R22 media_transcribe_cancel: upstream cancel failure maps to Rust MediaError::Database string (fixed on main a34d959a6)', async () => {
  const f = await fixture([media], mediaDb(true));
  try {
    let rejection: unknown;
    try { await f.host.invoke('media_transcribe_cancel', { resourceId: 'file_x2' }); } catch (e) { rejection = e; }
    // Rust dstu-media commands.rs:375-377: cancel_media error -> MediaError::Database payload string.
    assert.equal(rejection, JSON.stringify({ code: 'database-failed', message: 'x2 upstream cancel DB failure' }));
    console.log(`X2-R22: ${String(rejection)}`);
  } finally { await f.dispose(); }
});

test('X2-R05b HEIC on current main: real media handler + real F7 nativeHeic receive raw CallContext payload; desktop rejection matches Rust text', async () => {
  const f = await fixture([media], { nativeHeic: heic });
  try {
    const invoke = async (args: unknown) => { try { await f.host.invoke('convert_heic_to_jpeg', args); return undefined; } catch (e) { return e; } };
    const message = (e: unknown) => (e as { message?: unknown } | null)?.message;
    // heic_decoder.rs:129-139 (non-Android) and :55-70 (extract_raw_body)
    const desktop = await invoke(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
    assert.equal(message(desktop), 'HEIC_UNSUPPORTED_PLATFORM: native HEIC conversion is only available on Android', JSON.stringify(desktop));
    const empty = await invoke(new Uint8Array());
    assert.equal(message(empty), 'HEIC_INVALID_INPUT: empty image body', JSON.stringify(empty));
    const json = await invoke({});
    assert.equal(message(json), 'HEIC_INVALID_INPUT: expected raw binary request body', JSON.stringify(json));
    // _shared.json AppError: {error_type, message, details}; Rust AppError::validation.
    for (const e of [desktop, empty, json]) assert.deepEqual(Object.keys(e as object).sort(), ['details', 'error_type', 'message']);
    assert.equal((desktop as { error_type?: unknown }).error_type, 'Validation');
    console.log(`X2-R05b: desktop=${JSON.stringify(desktop)} empty=${JSON.stringify(empty)} json=${JSON.stringify(json)}`);
  } finally { await f.dispose(); }
});

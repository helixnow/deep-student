import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { blocks as parseBlocks } from '../../notes/src/structure.ts'; // boundary-allow cross-plugin-impl: verify fenced block survival through real notes block parser
import { createScopedPluginSyncStore, decodePluginFencedBlock, encodePluginFencedBlock,
  ensurePluginSyncRecordsTable, PluginQuotaExceededError, PluginSchemaDowngradeWriteError } from '../src/plugin-sync-sandbox.ts';
import { createDSPAIR2Pairing, createDSPAIR2Receiver, decodeDSPAIR2Pairing,
  PreMountDrainController, verifyCausalTakeover, type PairingPayload } from '../src/dspair2.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let db: ReturnType<typeof storage.database>;
let ticks: number;
const clock = { nextHlc: () => `${++ticks}`, deviceId: 'local' };
const store = (pluginId = 'plugin.a', pluginSchemaVersion = 1) => createScopedPluginSyncStore(db, { pluginId, pluginSchemaVersion }, clock);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sync-v5-d-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  db = storage.database('vfs'); ticks = 0;
  ensurePluginSyncRecordsTable(db);
});
afterEach(() => { vi.useRealTimers(); storage.dispose(); rmSync(root, { recursive: true, force: true }); });

describe('scoped plugin WAL sandbox', () => {
  it.each([{ nested: [9007199254740993n, null] }, null])('preserves opaque versions on spread writes: %s', future => {
    store('plugin.a', 3).put('ns', 'id', { known: 1, future });
    store().put('ns', 'id', { known: 2 });
    const unknown = parseJsonLossless(db.pluck<string>('SELECT unknown_fields_json FROM __plugin_sync_records')!) as any;
    store().put('ns', 'id', { ...(store().get('ns', 'id') as Record<string, DbJson>), known: 3 });
    expect(parseJsonLossless(db.pluck<string>('SELECT unknown_fields_json FROM __plugin_sync_records')!)).toEqual(unknown);
    const snapshot = parseJsonLossless(db.pluck<string>('SELECT payload_json FROM __change_log')!) as any;
    expect(snapshot.fields.future).toEqual(unknown.future);
    expect(snapshot.fields.known.hlc).not.toBe(unknown.future.hlc);
    store().put('ns', 'id', { known: 4, future: 'explicit edit' });
    expect(parseJsonLossless(db.pluck<string>('SELECT unknown_fields_json FROM __plugin_sync_records')!)).toEqual({});
  });
  it('binds capability identity, ignores forged payload/options IDs and survives immediate reopen', () => {
    const token = { pluginId: 'plugin.a', pluginSchemaVersion: 1 };
    const scoped = createScopedPluginSyncStore(db, token, clock);
    token.pluginId = 'plugin.b';
    scoped.put('ns', 'id', { plugin_id: 'plugin.b', value: 3 }, { pluginId: 'plugin.b' } as never);
    expect(store('plugin.b').get('ns', 'id')).toBeUndefined();
    expect(scoped.get('ns', 'id')).toEqual({ plugin_id: 'plugin.b', value: 3 });
    expect(db.pluck('PRAGMA journal_mode')).toBe('wal');
    storage.dispose();
    storage = createStorageService({ baseDir: root, dataLocalDir: root }); db = storage.database('vfs');
    expect(store().get('ns', 'id')).toEqual({ plugin_id: 'plugin.b', value: 3 });
  });
  it('coalesces only unpublished frozen snapshots; widget keys include widget_id', () => {
    const scoped = store();
    scoped.put('ns', 'id', { value: 1 });
    const id = db.pluck('SELECT id FROM __change_log');
    scoped.put('ns', 'id', { value: 2 });
    expect(db.pluck('SELECT COUNT(*) FROM __change_log')).toBe(1);
    expect(db.pluck('SELECT id FROM __change_log')).toBe(id);
    const snapshot = db.pluck<string>('SELECT payload_json FROM __change_log')!;
    expect((parseJsonLossless(snapshot) as any).payload.value).toBe(2);
    db.run('UPDATE __change_log SET sync_version=1');
    scoped.put('ns', 'id', { value: 3 });
    expect(db.pluck('SELECT COUNT(*) FROM __change_log')).toBe(2);
    expect(db.pluck('SELECT payload_json FROM __change_log WHERE sync_version=1')).toBe(snapshot);
    for (const widget of ['a', 'b']) db.run('INSERT INTO message_widget_states VALUES(?,?,?,?,?,?)', ['owner', 'hash', widget, '{}', '1', 'local']);
    expect(db.pluck('SELECT COUNT(*) FROM message_widget_states')).toBe(2);
  });
  it('enforces UTF-8 64KiB and depth 16 before writing', () => {
    const scoped = store();
    scoped.put('ns', 'exact', 'x'.repeat(65_534));
    expect(() => scoped.put('ns', 'bad', 'x'.repeat(65_535))).toThrow(PluginQuotaExceededError);
    expect(() => scoped.put('ns', 'utf8', '中'.repeat(22_000))).toThrow(PluginQuotaExceededError);
    let value: DbJson = 1;
    for (let i = 0; i < 16; i++) value = { child: value };
    scoped.put('ns', 'depth16', value);
    expect(() => scoped.put('ns', 'depth17', { child: value })).toThrow(PluginQuotaExceededError);
    expect(scoped.get('ns', 'bad')).toBeUndefined();
  });
  it('enforces plugin 5MiB quota atomically, independently of other plugin IDs', () => {
    const scoped = store();
    const data = 'x'.repeat(65_000);
    for (let i = 0; i < 80; i++) scoped.put('ns', String(i), data);
    expect(() => scoped.put('ns', 'overflow', data)).toThrow(PluginQuotaExceededError);
    expect(scoped.get('ns', 'overflow')).toBeUndefined();
    expect(db.pluck('SELECT COUNT(*) FROM __change_log')).toBe(80);
    store('plugin.b').put('ns', 'ok', data);
    scoped.put('ns', '0', 'replacement');
  });
  it('enforces 2000 active rows, allowing replacement and reuse after tombstone', () => {
    // Populate the exact real-table quota boundary without 2000 fsyncs.
    db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000)
      INSERT INTO __plugin_sync_records SELECT 'plugin.a','ns',CAST(x AS TEXT),'{}','{}','{}',1,1,'0','local',0 FROM n;`);
    expect(() => store().put('ns', 'extra', {})).toThrow(PluginQuotaExceededError);
    store().put('ns', '1', {});
    store().put('ns', '2', {}, { deleted: true });
    store().put('ns', 'extra', {});
    expect(store().get('ns', '2')).toBeUndefined();
  });
  it('retains original unknown field envelopes across old/new version roundtrips and explicit null', () => {
    store('plugin.a', 3).put('ns', 'id', { known: 1, future: { n: 9007199254740993n } });
    const original = parseJsonLossless(db.pluck<string>('SELECT field_versions_json FROM __plugin_sync_records')!) as any;
    original.future.seq = 9007199254740995n;
    original.future.hlc = 'remote-original-hlc';
    original.future.dev = 'remote-original-device';
    db.run('UPDATE __plugin_sync_records SET field_versions_json=?', [stringifyJsonLossless(original)]);
    store('plugin.a', 1).put('ns', 'id', { known: 2 });
    const unknown = parseJsonLossless(db.pluck<string>('SELECT unknown_fields_json FROM __plugin_sync_records')!) as any;
    expect(unknown.future).toEqual(original.future);
    store('plugin.a', 1).put('ns', 'id', { known: 3 });
    expect(store().serialize('ns', 'id')).toEqual({ known: 3, future: { n: 9007199254740993n } });
    store('plugin.a', 3).put('ns', 'id', { known: 4, future: null });
    store('plugin.a', 1).put('ns', 'id', { known: 5 });
    expect(store().get('ns', 'id')).toEqual({ known: 5, future: null });
    const cleared = parseJsonLossless(db.pluck<string>('SELECT unknown_fields_json FROM __plugin_sync_records')!) as any;
    expect(cleared.future.value).toBeNull();
    expect(cleared.future.hlc).not.toBe(original.future.hlc);
    store('plugin.a', 3).put('ns', 'locked', {}, { minWriterPluginSchema: 2 });
    expect(() => store().put('ns', 'locked', {})).toThrow(PluginSchemaDowngradeWriteError);
  });
  it('rolls back both immediate row and log if the pending log budget is exceeded', () => {
    db.run(`INSERT INTO __change_log(table_name,record_id,operation,changed_at,payload_json)
      VALUES('__plugin_sync_records',?,'DELETE','0',?)`, ['["plugin.a","old","tombstone"]', 'x'.repeat(10 * 1024 * 1024)]);
    expect(() => store().put('ns', 'id', {})).toThrow(PluginQuotaExceededError);
    expect(store().get('ns', 'id')).toBeUndefined();
    expect(db.pluck('SELECT COUNT(*) FROM __change_log')).toBe(1);
  });
});

describe('single-line escaped canonical plugin fences', () => {
  it('roundtrips nested code fences, blank lines, bigint and backticks through the real notes parser', () => {
    const block = { blockId: 'blk_123', pluginId: 'com.example.canvas', schemaVersion: 2,
      recordRef: 'canvas/id', pluginVersion: '2.1', fallbackTitle: '画板',
      fallbackMarkdown: '````markdown\n```js\nconsole.log(`hello`)\n```\n\n\n````\n<!-- ds:block-id=evil -->',
      inlineData: { z: 9007199254740993n, a: '`\n\n```js' } };
    const encoded = encodePluginFencedBlock(block);
    expect(encoded.split('\n')).toHaveLength(4);
    expect(encoded.split('\n')[2]).not.toContain('`');
    expect(encoded.split('\n')[2]).toContain('\\u0060');
    expect(encoded.split('\n')[2]).toMatch(/^\{"fallbackMarkdown":/);
    const parsed = parseBlocks(encoded);
    expect(parsed).toHaveLength(1);
    expect(decodePluginFencedBlock(`<!-- ds:block-id=${parsed[0]!.id} -->\n${parsed[0]!.body}`)).toEqual(block);
    expect(parseBlocks(encoded + '\n\n<!-- ds:block-id=next -->\n# 后续')).toHaveLength(2);
  });
  it('rejects header injection and non-single-line legacy payloads', () => {
    expect(() => encodePluginFencedBlock({ blockId: 'bad\n```', pluginId: 'x', schemaVersion: 1 } as never)).toThrow();
    expect(() => decodePluginFencedBlock('<!-- ds:block-id=x -->\n```ds-plugin:x:v1\n{\n}\n```')).toThrow();
  });
});

const payload: PairingPayload = { repoHeadAnchor: { repoId: 'repo', repoHeadGeneration: 9007199254740993n,
  repoHeadSha256: 'ab'.repeat(32), ownerPubkeyHex: 'cd'.repeat(32) }, secrets: { repoKey: 'repository-key' } };
describe('DSPAIR2', () => {
  it('rejects padded, whitespace and noncanonical base64url aliases before or after consumption', () => {
    const offer = createDSPAIR2Pairing(payload, { now: 1000 });
    const receiver = createDSPAIR2Receiver();
    for (const suffix of ['=', '==', '\n', '+', '/']) {
      expect(() => receiver.consume(offer.packet + suffix, offer.secret, 1001)).toThrow();
    }
    expect(receiver.consume(offer.packet, offer.secret, 1001)).toEqual(payload);
    expect(() => receiver.consume(offer.packet + '=', offer.secret, 1001)).toThrow();
    expect(() => receiver.consume(offer.packet, offer.secret, 1001)).toThrow('consumed');
  });
  it.each(['qr', 'short-code'] as const)('authenticates %s payload, anchor, TTL and one-time consumption', mode => {
    const offer = createDSPAIR2Pairing(payload, { mode, now: 1000 });
    expect(offer.expiresAt).toBe(601000);
    expect(offer.secret).toMatch(mode === 'qr' ? /^[a-f0-9]{32}$/ : /^DS2-(?:[A-Z2-7]{5}-){3}[A-Z2-7]{5}$/);
    expect(decodeDSPAIR2Pairing(offer.packet, offer.secret, 1001)).toEqual(payload);
    expect(() => decodeDSPAIR2Pairing(offer.packet, offer.secret, 601000)).toThrow('expired');
    const bytes = Buffer.from(offer.packet.slice(8), 'base64url'); bytes[bytes.length - 1]! ^= 1;
    expect(() => decodeDSPAIR2Pairing(`DSPAIR2.${bytes.toString('base64url')}`, offer.secret, 1001)).toThrow();
    const receiver = createDSPAIR2Receiver(); receiver.consume(offer.packet, offer.secret, 1001);
    expect(() => receiver.consume(offer.packet, offer.secret, 1002)).toThrow('consumed');
    const other = createDSPAIR2Pairing(payload, { mode, now: 1000 });
    expect(other.secret).not.toBe(offer.secret);
    expect(() => decodeDSPAIR2Pairing(offer.packet, other.secret, 1001)).toThrow();
  });
  it.each(['device_id', 'incarnation_id', 'host-identity', 'hostIdentityPrivateKey'])('rejects forbidden nested identity %s', key => {
    expect(() => createDSPAIR2Pairing({ ...payload, secrets: { nested: [{ [key]: 'private' }] } })).toThrow('identity');
  });
});

describe('pre-mount dual-speed drain and causal takeover', () => {
  const never = () => new Promise<never>(() => {});
  it('mounts on metadata MaterializedAck without waiting for a large attachment', async () => {
    const attachments = vi.fn(never);
    const controller = new PreMountDrainController({ drainMetadata: async () => ({ writerKey: 'w', latestSeq: 5n }), streamAttachments: attachments });
    expect(await controller.start()).toBe('ActiveRemoteMode');
    expect(controller.ack).toEqual({ writerKey: 'w', latestSeq: 5n });
    expect(attachments).toHaveBeenCalledOnce(); controller.cancel();
  });
  it('falls back at exactly 1500ms even if transport ignores cancellation', async () => {
    vi.useFakeTimers();
    const controller = new PreMountDrainController({ drainMetadata: never, streamAttachments: never });
    const pending = controller.start();
    await vi.advanceTimersByTimeAsync(1499); expect(controller.state).toBe('DrainingMetadata');
    await vi.advanceTimersByTimeAsync(1); expect(await pending).toBe('LocalFirstMode');
  });
  it('escapes busy, cancellation and network failure without pushing attachments', async () => {
    const attachments = vi.fn(never);
    for (const drainMetadata of [async () => ({ busy: true as const }), async () => { throw new Error('offline'); }]) {
      const controller = new PreMountDrainController({ drainMetadata, streamAttachments: attachments });
      expect(await controller.start()).toBe('LocalFirstMode');
    }
    const controller = new PreMountDrainController({ drainMetadata: never, streamAttachments: attachments });
    const pending = controller.start(); controller.cancel(); expect(await pending).toBe('LocalFirstMode');
    expect(attachments).not.toHaveBeenCalled();
  });
  it('does not let an old handshake completion reset a newer attempt', async () => {
    let resolveNew!: (ack: { writerKey: string; latestSeq: bigint }) => void;
    const drainMetadata = vi.fn()
      .mockResolvedValueOnce({ writerKey: 'old', latestSeq: 1n })
      .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
    const controller = new PreMountDrainController({ drainMetadata, streamAttachments: never });
    const oldAttempt = controller.start();
    const newAttempt = controller.start();
    await oldAttempt;
    expect(controller.state).toBe('DrainingMetadata');
    resolveNew({ writerKey: 'new', latestSeq: 2n });
    expect(await newAttempt).toBe('ActiveRemoteMode');
    expect(controller.ack?.writerKey).toBe('new');
    controller.cancel();
  });
  it('replays missing acknowledged op_ids in causal order, skipping piggybacked writes', async () => {
    const envelopes = [3n, 1n, 2n, 3n].map(seq => ({ opId: `op${seq}`, remoteMaterializedSeq: seq, payload: { value: Number(seq) } }));
    expect(verifyCausalTakeover(1n, envelopes).map(e => e.opId)).toEqual(['op2', 'op3']);
    const controller = new PreMountDrainController({ drainMetadata: async () => ({ writerKey: 'w', latestSeq: 1n }), streamAttachments: never });
    await controller.start();
    for (const e of envelopes) controller.confirmWrite(e);
    const replayed: string[] = [];
    await controller.takeover(1n, async e => { replayed.push(e.opId); });
    expect(replayed).toEqual(['op2', 'op3']); expect(controller.state).toBe('LocalFirstMode');
    expect(verifyCausalTakeover(3n, envelopes)).toEqual([]);
  });
  it('does not claim local readiness if acknowledged replay fails', async () => {
    const controller = new PreMountDrainController({ drainMetadata: never, streamAttachments: never });
    controller.confirmWrite({ opId: 'op', remoteMaterializedSeq: 1n, payload: {} });
    await expect(controller.takeover(0n, () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
    expect(controller.state).toBe('LocalTakeover');
    const replay = vi.fn(); await controller.takeover(0n, replay); expect(replay).toHaveBeenCalledOnce();
  });
});

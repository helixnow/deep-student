import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  BAD_OBJECT_FAIL_CLOSED_CODE,
  QUARANTINE_PREFIX,
  convergeBadObject,
  isTmpObjectKey,
  type BadObjectOutcome,
  type QuarantineRecord,
} from '../src/bad_object.ts';
import { VERIFIED_PUBLISH_MISMATCH_CODE, unconditionalSpec, verifiedPublish } from '../src/verified_publish.ts';
import { CorruptingStorage, MemoryStorage } from './memory_storage.ts';

const KEY = 'manifests/abcdef0123456789.json';
const GOOD = Buffer.from('{"versions":[],"latest":null}');
const BAD = Buffer.from('{ corrupt json');

function jsonValidate(bytes: Uint8Array): string | null {
  try { JSON.parse(Buffer.from(bytes).toString('utf8')); return null; }
  catch (error) { return `JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`; }
}

function tmpKeyFor(key: string): string {
  return `${key}.${randomUUID()}.tmp`;
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function quarantineKeys(storage: MemoryStorage): string[] {
  return storage.keys().filter(key => key.startsWith(QUARANTINE_PREFIX));
}

function reasonRecords(storage: MemoryStorage): QuarantineRecord[] {
  return quarantineKeys(storage)
    .filter(key => key.endsWith('.reason.json'))
    .map(key => JSON.parse(storage.text(key)!) as QuarantineRecord);
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try { await promise; }
  catch (error) { return error as Error; }
  throw new Error('expected the operation to fail');
}

describe('bad_object.rs', () => {
  it('bad_final_with_verified_tmp_converges', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEY, BAD);
    const tmpKey = tmpKeyFor(KEY);
    await storage.put(tmpKey, GOOD);

    const outcome = await convergeBadObject(storage, 'device-a', KEY, jsonValidate);
    expect(outcome.kind).toBe('RecoveredFromTmp');
    const recovered = outcome as Extract<BadObjectOutcome, { kind: 'RecoveredFromTmp' }>;
    expect(recovered.key).toBe(KEY);
    expect(recovered.tmpKey).toBe(tmpKey);
    expect(Buffer.from(storage.bytes(KEY)!).equals(GOOD)).toBe(true);
    expect(storage.bytes(tmpKey)).toBeNull();

    const record = recovered.quarantine!;
    expect(record.originalKey).toBe(KEY);
    expect(record.badSha256).toBe(sha256Hex(BAD));
    expect(record.originalDeleted).toBe(true);
    expect(record.recoveredFromTmp).toBe(tmpKey);
    expect(Buffer.from(storage.bytes(record.quarantinedKey)!).equals(BAD)).toBe(true);
    const reasons = reasonRecords(storage);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]!.reason).toBe(record.reason);
    expect(reasons[0]!.reason).not.toBe('');
  });

  it('bad_final_without_tmp_fails_closed_and_quarantines', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEY, BAD);

    const error = await failure(convergeBadObject(storage, 'device-a', KEY, jsonValidate));
    expect(error.message).toContain(BAD_OBJECT_FAIL_CLOSED_CODE);

    const quarantined = quarantineKeys(storage);
    expect(quarantined.some(key => key.endsWith('.bad'))).toBe(true);
    expect(quarantined.some(key => key.endsWith('.reason.json'))).toBe(true);
    expect(storage.bytes(KEY)).toBeNull();
  });

  it('user_backup_data_object_is_never_auto_deleted', async () => {
    const storage = new MemoryStorage();
    const backupKey = 'backups/AbCdEf0123456789012345.zip';
    await storage.put(backupKey, BAD);

    const error = await failure(convergeBadObject(storage, 'device-a', backupKey, jsonValidate));
    expect(error.message).toContain(BAD_OBJECT_FAIL_CLOSED_CODE);
    expect(Buffer.from(storage.bytes(backupKey)!).equals(BAD)).toBe(true);
    const reasons = reasonRecords(storage);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]!.originalDeleted).toBe(false);
  });

  it('healthy_final_is_untouched', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEY, GOOD);

    const outcome = await convergeBadObject(storage, 'device-a', KEY, jsonValidate);
    expect(outcome.kind).toBe('AlreadyHealthy');
    expect(Buffer.from(storage.bytes(KEY)!).equals(GOOD)).toBe(true);
    expect(quarantineKeys(storage)).toEqual([]);
  });

  it('unverifiable_tmp_is_not_trusted_and_is_retained', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEY, BAD);
    const badTmp = tmpKeyFor(KEY);
    await storage.put(badTmp, Buffer.from('also { corrupt'));

    const error = await failure(convergeBadObject(storage, 'device-a', KEY, jsonValidate));
    expect(error.message).toContain(BAD_OBJECT_FAIL_CLOSED_CODE);
    expect(storage.bytes(badTmp)).not.toBeNull();
  });

  it('missing_final_with_verified_tmp_converges_without_quarantine', async () => {
    const storage = new MemoryStorage();
    const tmpKey = tmpKeyFor(KEY);
    await storage.put(tmpKey, GOOD);

    const outcome = await convergeBadObject(storage, 'device-a', KEY, jsonValidate);
    expect(outcome.kind).toBe('RecoveredFromTmp');
    expect((outcome as Extract<BadObjectOutcome, { kind: 'RecoveredFromTmp' }>).quarantine).toBeNull();
    expect(Buffer.from(storage.bytes(KEY)!).equals(GOOD)).toBe(true);
    expect(storage.bytes(tmpKey)).toBeNull();
    expect(quarantineKeys(storage)).toEqual([]);
  });

  it('missing_final_without_tmp_is_absent', async () => {
    const storage = new MemoryStorage();
    const outcome = await convergeBadObject(storage, 'device-a', KEY, jsonValidate);
    expect(outcome.kind).toBe('Absent');
  });

  it('newest_verified_tmp_wins', async () => {
    const storage = new MemoryStorage();
    const base = Date.now();
    storage.putAt(KEY, BAD, base);
    const olderTmp = tmpKeyFor(KEY);
    storage.putAt(olderTmp, Buffer.from('{"gen":1}'), base + 10);
    const newerTmp = tmpKeyFor(KEY);
    storage.putAt(newerTmp, Buffer.from('{"gen":2}'), base + 20);

    const outcome = await convergeBadObject(storage, 'device-a', KEY, jsonValidate);
    expect(outcome.kind).toBe('RecoveredFromTmp');
    expect((outcome as Extract<BadObjectOutcome, { kind: 'RecoveredFromTmp' }>).tmpKey).toBe(newerTmp);
    expect(storage.text(KEY)).toBe('{"gen":2}');
    expect(storage.bytes(olderTmp)).not.toBeNull();
  });

  it('verified_publish_style_tmp_residue_converges', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEY, BAD);
    const publishTmp = `${KEY}.tmp-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await storage.put(publishTmp, GOOD);

    const outcome = await convergeBadObject(storage, 'device-a', KEY, jsonValidate);
    expect(outcome.kind).toBe('RecoveredFromTmp');
    expect((outcome as Extract<BadObjectOutcome, { kind: 'RecoveredFromTmp' }>).tmpKey).toBe(publishTmp);
    expect(Buffer.from(storage.bytes(KEY)!).equals(GOOD)).toBe(true);
    expect(storage.bytes(publishTmp)).toBeNull();
  });

  it('tmp_object_key_recognition_covers_both_generations', () => {
    expect(isTmpObjectKey('manifests/a.json.0123abcd.tmp')).toBe(true);
    expect(isTmpObjectKey('manifests/a.json.tmp-0123abcd4567')).toBe(true);
    expect(isTmpObjectKey('manifests/a.json')).toBe(false);
    expect(isTmpObjectKey('manifests/a.json.tmp-0123abcd4567.bad-20250101T000000000Z-cafe0123')).toBe(false);
    expect(isTmpObjectKey('manifests/a.json.tmp-')).toBe(false);
  });

  it('rejects_non_final_keys', async () => {
    const storage = new MemoryStorage();
    for (const key of [
      '',
      '.quarantine/manifests/a.json.x.bad',
      'manifests/a.json.123.tmp',
      'manifests/a.json.tmp-0123abcd4567',
    ]) {
      const error = await failure(convergeBadObject(storage, 'device-a', key, jsonValidate));
      expect(error.message, key).toContain('坏写收敛只接受业务正式对象 key');
    }
  });

  // ==================== [R7-badwrite-converge] 坏写后下一轮收敛 ====================

  it('real_keep_tmp_endgame_converges_on_next_round', async () => {
    const mem = new MemoryStorage();
    const badRound = new CorruptingStorage(mem, key => key === KEY);
    const error = await failure(verifiedPublish(badRound, unconditionalSpec(KEY, 1024, 'KeepTmp'), GOOD));
    expect(error.message).toContain(VERIFIED_PUBLISH_MISMATCH_CODE);

    const corrupted = mem.bytes(KEY)!;
    expect(Buffer.from(corrupted).equals(GOOD)).toBe(false);
    expect(jsonValidate(corrupted)).not.toBeNull();

    const residueTmps = mem.keys().filter(key => key.startsWith(`${KEY}.`) && key.includes('.tmp-'));
    expect(residueTmps).toHaveLength(1);
    const residueTmp = residueTmps[0]!;
    expect(Buffer.from(mem.bytes(residueTmp)!).equals(GOOD)).toBe(true);
    expect(isTmpObjectKey(residueTmp)).toBe(true);

    const outcome = await convergeBadObject(mem, 'device-b', KEY, jsonValidate);
    expect(outcome.kind).toBe('RecoveredFromTmp');
    const recovered = outcome as Extract<BadObjectOutcome, { kind: 'RecoveredFromTmp' }>;
    expect(recovered.key).toBe(KEY);
    expect(recovered.tmpKey).toBe(residueTmp);
    expect(Buffer.from(mem.bytes(KEY)!).equals(GOOD)).toBe(true);
    expect(mem.bytes(residueTmp)).toBeNull();

    const record = recovered.quarantine!;
    expect(record.badSha256).toBe(sha256Hex(corrupted));
    expect(record.recoveredFromTmp).toBe(residueTmp);
    expect(Buffer.from(mem.bytes(record.quarantinedKey)!).equals(corrupted)).toBe(true);

    const again = await convergeBadObject(mem, 'device-b', KEY, jsonValidate);
    expect(again.kind).toBe('AlreadyHealthy');
    expect(Buffer.from(mem.bytes(record.quarantinedKey)!).equals(corrupted)).toBe(true);
  });

  it('real_keep_tmp_staging_endgame_stays_honest_absent', async () => {
    const mem = new MemoryStorage();
    const badRound = new CorruptingStorage(mem, key => key.includes('.tmp-'));
    const error = await failure(verifiedPublish(badRound, unconditionalSpec(KEY, 1024, 'KeepTmp'), GOOD));
    expect(error.message).toContain(VERIFIED_PUBLISH_MISMATCH_CODE);
    expect(mem.bytes(KEY)).toBeNull();

    const outcome = await convergeBadObject(mem, 'device-b', KEY, jsonValidate);
    expect(outcome.kind).toBe('Absent');
    expect(mem.bytes(KEY)).toBeNull();
    const retained = mem.keys().filter(key => key.startsWith(`${KEY}.`) && key.includes('.tmp-'));
    expect(retained).toHaveLength(1);
    expect(quarantineKeys(mem)).toEqual([]);
  });

  it('fail_closed_round_then_next_round_is_honest_absent', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEY, BAD);

    const error = await failure(convergeBadObject(storage, 'device-a', KEY, jsonValidate));
    expect(error.message).toContain(BAD_OBJECT_FAIL_CLOSED_CODE);
    const badCopies = quarantineKeys(storage).filter(key => key.endsWith('.bad'));
    expect(badCopies).toHaveLength(1);
    expect(error.message).toContain(badCopies[0]!);

    const outcome = await convergeBadObject(storage, 'device-a', KEY, jsonValidate);
    expect(outcome.kind).toBe('Absent');
    expect(reasonRecords(storage)).toHaveLength(1);
  });

  it('user_backup_bad_object_survives_repeated_rounds', async () => {
    const storage = new MemoryStorage();
    const backupKey = 'backup-v2/objects/aa/bb/deadbeef';
    await storage.put(backupKey, BAD);

    for (const round of [1, 2]) {
      const error = await failure(convergeBadObject(storage, 'device-a', backupKey, jsonValidate));
      expect(error.message, `第 ${round} 轮`).toContain(BAD_OBJECT_FAIL_CLOSED_CODE);
      expect(Buffer.from(storage.bytes(backupKey)!).equals(BAD), `第 ${round} 轮`).toBe(true);
    }
  });

  it('cross_generation_residue_newest_verified_tmp_wins', async () => {
    const storage = new MemoryStorage();
    const base = Date.now();
    storage.putAt(KEY, BAD, base);
    const legacyTmp = tmpKeyFor(KEY);
    storage.putAt(legacyTmp, Buffer.from('{"gen":1}'), base + 10);
    const publishTmp = `${KEY}.tmp-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    storage.putAt(publishTmp, Buffer.from('{"gen":2}'), base + 20);

    const outcome = await convergeBadObject(storage, 'device-a', KEY, jsonValidate);
    expect(outcome.kind).toBe('RecoveredFromTmp');
    expect((outcome as Extract<BadObjectOutcome, { kind: 'RecoveredFromTmp' }>).tmpKey).toBe(publishTmp);
    expect(storage.text(KEY)).toBe('{"gen":2}');
    expect(storage.bytes(legacyTmp)).not.toBeNull();
  });
});

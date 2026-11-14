import { describe, expect, it } from 'vitest';
import type { PublishRecovery } from '../src/verified_publish.ts';
import {
  VERIFIED_PUBLISH_MISMATCH_CODE,
  VERIFIED_PUBLISH_OVERSIZE_CODE,
  VERIFIED_PUBLISH_UNCONDITIONAL_WRITE_CODE,
  unconditionalSpec,
  verifiedPublish,
} from '../src/verified_publish.ts';
import { CloudStorageError } from '../src/errors.ts';
import { CorruptingStorage, MemoryStorage } from './memory_storage.ts';

const spec = (recovery: PublishRecovery) => unconditionalSpec('dir/state.json', 1024, recovery);

async function failure(promise: Promise<unknown>): Promise<CloudStorageError> {
  try { await promise; }
  catch (error) { return error as CloudStorageError; }
  throw new Error('expected the operation to fail');
}

describe('verified_publish.rs', () => {
  it('happy_path_publishes_and_cleans_tmp', async () => {
    const mem = new MemoryStorage();
    await verifiedPublish(mem, spec('KeepTmp'), Buffer.from('hello'));
    expect(Buffer.from(mem.bytes('dir/state.json')!).toString()).toBe('hello');
    expect(mem.keys()).toEqual(['dir/state.json']);
  });

  it('oversize_data_rejected_before_any_write', async () => {
    const mem = new MemoryStorage();
    const error = await failure(verifiedPublish(mem, unconditionalSpec('k', 4, 'KeepTmp'), Buffer.from('too-long')));
    expect(error.message).toContain(VERIFIED_PUBLISH_OVERSIZE_CODE);
    expect(mem.keys()).toEqual([]);
  });

  it('conditional_publish_fails_closed_without_cas', async () => {
    const mem = new MemoryStorage();
    const conditional = {
      key: 'k',
      maxBytes: 64,
      expectedGeneration: 'etag-123',
      recovery: 'KeepTmp' as PublishRecovery,
    };
    const error = await failure(verifiedPublish(mem, conditional, Buffer.from('x')));
    expect(error.message).toContain(VERIFIED_PUBLISH_UNCONDITIONAL_WRITE_CODE);
    expect(error.message).toContain('无条件写');
    expect(mem.keys()).toEqual([]);
  });

  it('tmp_corruption_keeps_tmp_and_never_touches_final_key', async () => {
    const mem = new MemoryStorage();
    const storage = new CorruptingStorage(mem, key => key.includes('.tmp-'));
    const error = await failure(verifiedPublish(storage, spec('KeepTmp'), Buffer.from('hello')));
    expect(error.message).toContain(VERIFIED_PUBLISH_MISMATCH_CODE);
    const keys = mem.keys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain('.tmp-');
    expect(mem.bytes('dir/state.json')).toBeNull();
  });

  it('final_corruption_with_isolate_bad_renames_bad_object', async () => {
    const mem = new MemoryStorage();
    const storage = new CorruptingStorage(mem, key => key === 'dir/state.json');
    const error = await failure(verifiedPublish(storage, spec('IsolateBad'), Buffer.from('hello')));
    expect(error.message).toContain(VERIFIED_PUBLISH_MISMATCH_CODE);
    const keys = mem.keys();
    expect(mem.bytes('dir/state.json')).toBeNull();
    expect(keys.some(key => key.startsWith('dir/state.json.bad-'))).toBe(true);
    expect(keys.some(key => key.includes('.tmp-'))).toBe(true);
  });

  it('final_corruption_with_keep_tmp_leaves_bad_object_in_place', async () => {
    const mem = new MemoryStorage();
    const storage = new CorruptingStorage(mem, key => key === 'dir/state.json');
    const error = await failure(verifiedPublish(storage, spec('KeepTmp'), Buffer.from('hello')));
    expect(error.message).toContain(VERIFIED_PUBLISH_MISMATCH_CODE);
    const keys = mem.keys();
    expect(mem.bytes('dir/state.json')).not.toBeNull();
    expect(keys.some(key => key.includes('.tmp-'))).toBe(true);
    expect(keys.some(key => key.includes('.bad-'))).toBe(false);
  });

  it('traversal_key_rejected', async () => {
    const mem = new MemoryStorage();
    const error = await failure(verifiedPublish(mem, unconditionalSpec('../evil', 64, 'KeepTmp'), Buffer.from('x')));
    expect(error).toBeInstanceOf(CloudStorageError);
    expect(mem.keys()).toEqual([]);
  });
});

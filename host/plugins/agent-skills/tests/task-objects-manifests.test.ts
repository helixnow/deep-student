/**
 * The 9 F4 `dstu-core/src/task_objects.rs` rows that were still pending:
 * BatchManifest, the v1/v2 serde bridge and the six CorpusManifest cases.
 *
 * Tests call L07 production exports; they do not re-implement manifest logic.
 */
import { describe, expect, it } from 'vitest';
import {
  LEGACY_DERIVED_TRANSFORM_ID, TASK_OBJECT_SCHEMA_VERSION, TaskObjectHandleBuilder,
  buildCorpusManifest, canClaimCompleteSuccess, corpusManifestModelNotice,
  derivedEdge, deserializeBatchManifest, deserializeCorpusManifest,
  deserializeDerivedEdge, deserializeTaskObjectHandle, managedLocator,
  validateCorpusManifest, validateTaskObjectHandle,
  type BatchManifest, type CorpusManifestEntry,
  type TaskObjectHandle,
} from '../api.ts';

function corpusHandle(handleId: string, displayName: string, shaFill: string): TaskObjectHandle {
  return new TaskObjectHandleBuilder(handleId, 'file', displayName, 'chat_context_ref')
    .tool('send_time_attachment_stage')
    .derivedEdge(derivedEdge('res_1', 'attachment.stage_context'))
    .sha256(shaFill.repeat(64))
    .build();
}

function distinctCorpusHandles(count: number): TaskObjectHandle[] {
  const hex = '0123456789abcdef';
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return corpusHandle(
      `attachment:src_${number}:${'0'.repeat(8)}`,
      `file_${number}.bin`,
      hex[number % hex.length]!,
    );
  });
}

function entry(handle: TaskObjectHandle): CorpusManifestEntry {
  return { handle, refCount: 1 };
}

describe('dstu-core task_objects.rs remaining rows', () => {
  it('incomplete_batch_cannot_claim_complete_success', () => {
    const manifest: BatchManifest = {
      manifestId: 'batch_1',
      expectedItems: 2,
      observedItems: 1,
      coverageComplete: false,
      truncated: true,
      items: [{
        itemId: 'one', status: 'succeeded', attempts: 1,
      }],
    };
    expect(canClaimCompleteSuccess(manifest)).toBe(false);
    const complete: BatchManifest = {
      ...manifest,
      observedItems: 2,
      coverageComplete: true,
      truncated: false,
      items: [
        { itemId: 'one', status: 'succeeded', attempts: 1 },
        { itemId: 'two', status: 'succeeded', attempts: 1 },
      ],
    };
    expect(canClaimCompleteSuccess(complete)).toBe(true);
    expect(canClaimCompleteSuccess({ ...complete, items: [...complete.items, complete.items[0]!] }))
      .toBe(false);
    expect(deserializeBatchManifest(JSON.parse(JSON.stringify(complete)))).toEqual(complete);
  });

  it('derived_edge_serializes_v2_and_reads_legacy_string', () => {
    const edge = {
      sourceHandleId: 'obj_src',
      transformId: 'fetch.binary',
      transformParamsHash: 'ab'.repeat(32),
      observedAt: '2026-09-07T00:00:00Z',
    };
    expect(JSON.parse(JSON.stringify(edge))).toEqual(edge);
    expect(deserializeDerivedEdge(edge)).toEqual(edge);

    const legacy = deserializeDerivedEdge('obj_src');
    expect(legacy.sourceHandleId).toBe('obj_src');
    expect(legacy.transformId).toBe(LEGACY_DERIVED_TRANSFORM_ID);
    expect(legacy.transformParamsHash).toBeUndefined();
    expect(legacy.observedAt).toBe('');
  });

  it('schema_v1_handle_with_string_lineage_still_validates', () => {
    const legacyJson = {
      schemaVersion: 1,
      handleId: 'obj_old',
      kind: 'file',
      displayName: 'old.png',
      capabilities: {
        readable: true,
        materializable: false,
        writable: false,
        shareable: false,
        sendable: false,
        deletable: false,
      },
      provenance: {
        source: 'url_download',
        derivedFrom: ['https://example.com/a.png'],
        observedAt: '2026-07-19T00:00:00Z',
      },
    };
    const handle = deserializeTaskObjectHandle(legacyJson);
    expect(handle.schemaVersion).toBe(1);
    expect(handle.provenance.derivedFrom).toHaveLength(1);
    expect(handle.provenance.derivedFrom[0]!.transformId).toBe(LEGACY_DERIVED_TRANSFORM_ID);
    expect(() => validateTaskObjectHandle(handle)).not.toThrow();
    expect(() => validateTaskObjectHandle({
      ...handle,
      schemaVersion: TASK_OBJECT_SCHEMA_VERSION + 1,
    })).toThrow(/unsupported task object schema version/);
  });

  it('corpus_manifest_paginates_without_dropping_any_file', () => {
    const manifest = buildCorpusManifest(
      'corpus_test', 'sess_1', distinctCorpusHandles(25), 20,
    );
    expect(manifest.totalCount).toBe(25);
    expect(manifest.pageSize).toBe(20);
    expect(manifest.pages).toHaveLength(2);
    expect(manifest.pages[0]!.pageNo).toBe(1);
    expect(manifest.pages[0]!.objectHandles).toHaveLength(20);
    expect(manifest.pages[1]!.pageNo).toBe(2);
    expect(manifest.pages[1]!.objectHandles).toHaveLength(5);
    expect(manifest.pages[1]!.objectHandles[0]!.handle.handleId)
      .toBe('attachment:src_21:00000000');
    const all = new Set(
      manifest.pages.flatMap(page => page.objectHandles.map(item => item.handle.handleId)),
    );
    expect(all.size).toBe(25);
    validateCorpusManifest(manifest);

    const parsed = deserializeCorpusManifest(JSON.parse(JSON.stringify(manifest)));
    expect(parsed).toEqual(manifest);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.totalCount).toBe(25);
    expect(parsed.pageSize).toBe(20);
    expect(parsed.pages[0]!.pageNo).toBe(1);
    expect(parsed.pages[0]!.objectHandles[0]!.refCount).toBe(1);
    expect(parsed.createdAt).toBeTruthy();
    expect(parsed.sourceSessionId).toBe('sess_1');
    validateCorpusManifest(parsed);
  });

  it('corpus_manifest_keeps_same_name_files_as_distinct_entries', () => {
    const first = corpusHandle('attachment:src_a:aa', '报告.pdf', 'a');
    const second = corpusHandle('attachment:src_b:bb', '报告.pdf', 'b');
    const manifest = buildCorpusManifest('corpus_test', 'sess_1', [first, second], 20);
    expect(manifest.totalCount).toBe(2);
    const entries = manifest.pages[0]!.objectHandles;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.handle.displayName).toBe('报告.pdf');
    expect(entries[1]!.handle.displayName).toBe('报告.pdf');
    expect(entries[0]!.handle.handleId).not.toBe(entries[1]!.handle.handleId);
    expect(entries.every(item => item.refCount === 1)).toBe(true);
  });

  it('corpus_manifest_dedupes_repeated_refs_and_keeps_ref_count', () => {
    const dup = () => corpusHandle('attachment:src_a:aa', 'a.bin', 'a');
    const manifest = buildCorpusManifest('corpus_test', 'sess_1', [
      dup(),
      corpusHandle('attachment:src_b:bb', 'b.bin', 'b'),
      dup(),
      dup(),
    ], 20);
    expect(manifest.totalCount).toBe(2);
    const entries = manifest.pages[0]!.objectHandles;
    expect(entries[0]!.handle.handleId).toBe('attachment:src_a:aa');
    expect(entries[0]!.refCount).toBe(3);
    expect(entries[1]!.handle.handleId).toBe('attachment:src_b:bb');
    expect(entries[1]!.refCount).toBe(1);
    const refSum = manifest.pages
      .flatMap(page => page.objectHandles)
      .reduce((sum, item) => sum + item.refCount, 0);
    expect(refSum).toBe(4);
  });

  it('corpus_manifest_notice_states_totals_and_readback_path', () => {
    const manifest = buildCorpusManifest(
      'corpus_abc', 'sess_1', distinctCorpusHandles(21), 20,
    );
    const locator = managedLocator('artifacts', 'corpus/corpus_abc.json');
    const notice = corpusManifestModelNotice(manifest, 20, locator);
    expect(notice).toContain('21');
    expect(notice).toContain('第 1 页 20');
    expect(notice).toContain('corpus_abc');
    expect(notice).toContain('共 2 页');
    expect(notice).toContain('artifacts:corpus/corpus_abc.json');
    expect(notice).toContain('object_read');
    expect(notice).toContain('totalCount=21');
    expect(notice).toContain('分母');
  });

  it('corpus_manifest_pages_are_snapshot_immutable_after_source_change', () => {
    const v1 = corpusHandle('attachment:src_a:sha_v1', 'a.bin', 'a');
    const manifest = buildCorpusManifest('corpus_abc', 'sess_1', [v1], 20);
    const before = JSON.stringify(manifest);

    const v2 = corpusHandle('attachment:src_a:sha_v2', 'a.bin', 'b');
    const after = JSON.stringify(manifest);
    expect(after).toBe(before);
    expect(manifest.pages[0]!.objectHandles[0]!.handle.handleId)
      .toBe('attachment:src_a:sha_v1');
    expect(after).toContain('sha_v1');
    expect(after).not.toContain('sha_v2');

    const manifest2 = buildCorpusManifest('corpus_def', 'sess_1', [v2], 20);
    expect(manifest2.pages[0]!.objectHandles[0]!.handle.handleId)
      .toBe('attachment:src_a:sha_v2');
    expect(manifest.manifestId).not.toBe(manifest2.manifestId);
  });

  it('corpus_manifest_validate_rejects_bad_shape', () => {
    expect(() => buildCorpusManifest(
      'm', 's', [corpusHandle('h1', 'a', 'a')], 0,
    )).toThrow(/page_size must be positive/);

    const manifest = buildCorpusManifest('m', 's', [corpusHandle('h1', 'a', 'a')], 20);
    expect(() => validateCorpusManifest({ ...manifest, totalCount: 2 }))
      .toThrow(/total_count 2 does not match 1/);
    expect(() => validateCorpusManifest({
      ...manifest,
      schemaVersion: manifest.schemaVersion + 1,
    })).toThrow(/unsupported corpus manifest schema version/);

    const dup = corpusHandle('h1', 'a', 'a');
    const duplicated = buildCorpusManifest('m', 's', distinctCorpusHandles(2), 1);
    const firstHandle = duplicated.pages[0]!.objectHandles[0]!.handle;
    duplicated.pages[1]!.objectHandles = [entry(firstHandle)];
    expect(() => validateCorpusManifest(duplicated))
      .toThrow(/duplicate handle 'attachment:src_1/);

    const badNo = buildCorpusManifest('m', 's', distinctCorpusHandles(2), 1);
    badNo.pages[1]!.pageNo = 7;
    expect(() => validateCorpusManifest(badNo)).toThrow(/page_no must be sequential/);

    const partialFirst = {
      ...manifest,
      totalCount: 2,
      pageSize: 2,
      pages: [
        { pageNo: 1, objectHandles: [entry(dup)] },
        { pageNo: 2, objectHandles: [entry(corpusHandle('h2', 'b', 'b'))] },
      ],
    };
    expect(() => validateCorpusManifest(partialFirst))
      .toThrow(/non-final page 1 must be full/);

    const emptyPage = {
      ...partialFirst,
      totalCount: 0,
      pages: [{ pageNo: 1, objectHandles: [] }],
    };
    expect(() => validateCorpusManifest(emptyPage)).toThrow(/page 1 is empty/);
  });
});

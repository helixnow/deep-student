/**
 * `crates/dstu-core/src/task_objects.rs::tests` 的跨 lane 契约测试。
 *
 * 实现由 L07 发布在 `host/plugins/agent-skills/api.ts`（生产插件已接线）；
 * F4 只按 Rust 测试名断言共享 crate 的公开行为，不复制实现。
 * `BatchManifest`、`CorpusManifest` 与 serde legacy 解析在 L07 尚未发布，
 * 相关行仍保持 pending（见 `migration/testmap/F4-security.md` 阻塞说明）。
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OBJECT_WRITE_MAX_BYTES,
  TaskObjectHandleBuilder,
  commitConnectorReceipt,
  confirmConnectorReceipt,
  derivedEdge,
  hashTransformParams,
  managedLocator,
  readTaskObjectPage,
  taskObjectHandle,
  validateTaskObjectHandle,
  withParamsHash,
  writeTaskObjectPage,
  type ConnectorOperationReceipt,
  type ObjectProvenance,
  type TaskObjectHandle,
} from '../../../plugins/agent-skills/api.ts';

function provenance(): ObjectProvenance {
  return {
    source: 'chat_attachment',
    derivedFrom: [],
    observedAt: '2026-07-19T00:00:00Z',
  };
}

function pagedLocator(rootId: string, relativePath: string) {
  return managedLocator(rootId, relativePath);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('dstu-core task_objects.rs::tests', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'f4-task-objects-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('managed_locator_rejects_escape_and_absolute_paths', () => {
    expect(() => managedLocator('temp', 'attachments/image.png')).not.toThrow();
    expect(() => managedLocator('temp', '../secret')).toThrow(/unsafe path segment/);
    expect(() => managedLocator('temp', '/etc/passwd')).toThrow();
    expect(() => managedLocator('temp', 'a\\b.txt')).toThrow(/forward slashes/);
  });

  it('materializable_handle_requires_managed_locator', () => {
    const handle = taskObjectHandle('obj_1', 'file', 'image.png', provenance());
    handle.capabilities.materializable = true;
    expect(() => validateTaskObjectHandle(handle)).toThrow(/materializable objects require a managed locator/);
    handle.locator = managedLocator('temp', 'attachments/image.png');
    expect(() => validateTaskObjectHandle(handle)).not.toThrow();
  });

  it('connector_commit_requires_matching_preview_confirmation', () => {
    const receipt: ConnectorOperationReceipt = {
      operationId: 'op_1',
      idempotencyKey: 'idem_1',
      provider: 'mail',
      action: 'send',
      state: 'draft',
      objectHandleIds: ['obj_1'],
      recipientIds: ['user@example.com'],
      irreversible: true,
      previewSha256: 'a'.repeat(64),
    };
    expect(() => commitConnectorReceipt(receipt, '2026-07-19T00:00:00Z'))
      .toThrow(/must be confirmed before commit/);
    expect(() => confirmConnectorReceipt(receipt, 'b'.repeat(64)))
      .toThrow(/operation preview changed/);
    expect(() => confirmConnectorReceipt(receipt, 'a'.repeat(64))).not.toThrow();
    expect(() => commitConnectorReceipt(receipt, '2026-07-19T00:00:00Z')).not.toThrow();
    expect(receipt.state).toBe('committed');
    expect(receipt.committedAt).toBe('2026-07-19T00:00:00Z');
  });

  it('builder_requires_explicit_lineage', () => {
    expect(() => new TaskObjectHandleBuilder('obj_1', 'file', 'a.png', 'test').build())
      .toThrow(/derived_from/);
  });

  it('builder_origin_unknown_builds_with_empty_lineage', () => {
    const handle = new TaskObjectHandleBuilder('obj_1', 'file', 'a.png', 'test')
      .originUnknown('test_no_referrer')
      .build();
    expect(handle.provenance.derivedFrom).toEqual([]);
    expect(handle.schemaVersion).toBe(2);
  });

  it('builder_build_runs_validation', () => {
    expect(() => new TaskObjectHandleBuilder('obj_1', 'file', 'a.png', 'test')
      .derivedEdge(derivedEdge('src', 'test.op'))
      .sha256('not-a-hash')
      .build()).toThrow(/sha256 must be a 64-character hexadecimal digest/);

    const handle: TaskObjectHandle = new TaskObjectHandleBuilder('obj_1', 'file', 'a.png', 'test')
      .derivedEdge(withParamsHash(derivedEdge('src', 'test.op'), hashTransformParams({ k: 'v' })))
      .sha256('a'.repeat(64))
      .build();
    expect(handle.provenance.derivedFrom).toHaveLength(1);
    expect(handle.provenance.derivedFrom[0]!.transformId).toBe('test.op');
    expect(handle.provenance.derivedFrom[0]!.transformParamsHash).toBeDefined();
  });

  it('read_page_multi_page_concat_matches_original_and_sha256', () => {
    let text = '';
    for (let i = 0; i < 200; i += 1) {
      text += `第${i}行：深度学习与程序合成 αβγ🦀\n`;
    }
    writeFileSync(join(dir, 'big.txt'), text);
    const locator = pagedLocator('artifacts', 'big.txt');

    let joined = '';
    let offset = 0;
    let pages = 0;
    let sha = '';
    for (;;) {
      const page = readTaskObjectPage(dir, locator, offset, 4096);
      expect(page.offset).toBe(offset);
      joined += page.content;
      offset = page.next_offset;
      pages += 1;
      if (page.eof) {
        sha = page.sha256;
        break;
      }
    }
    expect(joined).toBe(text);
    expect(sha).toBe(sha256(Buffer.from(text, 'utf8')));
    expect(pages).toBeGreaterThanOrEqual(3);
  });

  it('read_page_rejects_foreign_roots_and_escapes', () => {
    writeFileSync(join(dir, 'f.txt'), 'safe');
    for (const rootId of ['temp', 'workspace', 'skill:x']) {
      expect(() => readTaskObjectPage(dir, pagedLocator(rootId, 'f.txt'), 0, 100))
        .toThrow(/not object-readable/);
    }
    const escape = { rootId: 'artifacts', relativePath: '../outside.txt' };
    expect(() => readTaskObjectPage(dir, escape, 0, 100)).toThrow(/unsafe path segment/);
    const absolute = { rootId: 'artifacts', relativePath: '/etc/passwd' };
    expect(() => readTaskObjectPage(dir, absolute, 0, 100)).toThrow();
    mkdirSync(join(dir, 'subdir'));
    expect(() => readTaskObjectPage(dir, pagedLocator('artifacts', 'subdir'), 0, 100))
      .toThrow(/not a file/);
    expect(() => readTaskObjectPage(dir, pagedLocator('artifacts', 'nope.txt'), 0, 100))
      .toThrow();
  });

  it.runIf(process.platform !== 'win32')('read_page_rejects_symlink_escape', () => {
    const outside = mkdtempSync(join(tmpdir(), 'f4-task-objects-outside-'));
    try {
      writeFileSync(join(outside, 'victim.txt'), 'keep');
      symlinkSync(join(outside, 'victim.txt'), join(dir, 'link.txt'));
      expect(() => readTaskObjectPage(dir, pagedLocator('artifacts', 'link.txt'), 0, 100))
        .toThrow(/escapes the managed root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('read_page_utf8_boundary_and_progress_guarantee', () => {
    writeFileSync(join(dir, 'han.txt'), '汉'.repeat(10));
    const locator = pagedLocator('artifacts', 'han.txt');

    const page = readTaskObjectPage(dir, locator, 0, 7);
    expect(page.content).toBe('汉汉');
    expect(page.next_offset).toBe(6);
    expect(page.eof).toBe(false);
    expect(() => readTaskObjectPage(dir, locator, 1, 7)).toThrow(/splits a UTF-8 character/);

    const single = readTaskObjectPage(dir, locator, 0, 1);
    expect(single.content).toBe('汉');
    expect(single.next_offset).toBe(3);
  });

  it('read_page_binary_returns_base64', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x01]), Buffer.alloc(200, 7)]);
    writeFileSync(join(dir, 'bin.dat'), bytes);
    const locator = pagedLocator('artifacts', 'bin.dat');

    const page = readTaskObjectPage(dir, locator, 0, 100);
    expect(page.encoding).toBe('base64');
    expect(page.next_offset).toBe(100);
    expect(page.eof).toBe(false);
    expect(Buffer.from(page.content, 'base64')).toEqual(bytes.subarray(0, 100));
    expect(page.sha256).toBe(sha256(bytes));

    const whole = readTaskObjectPage(dir, locator, 0, 999_999);
    expect(whole.eof).toBe(true);
    expect(whole.next_offset).toBe(bytes.length);
  });

  it('read_page_offset_edges_and_empty_file', () => {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    writeFileSync(join(dir, 'empty.txt'), '');
    const locator = pagedLocator('artifacts', 'a.txt');
    for (const offset of [5, 99]) {
      const page = readTaskObjectPage(dir, locator, offset, 10);
      expect(page.eof).toBe(true);
      expect(page.content).toBe('');
      expect(page.offset).toBe(5);
      expect(page.next_offset).toBe(5);
      expect(page.total_size).toBe(5);
    }
    const empty = readTaskObjectPage(dir, pagedLocator('artifacts', 'empty.txt'), 0, 10);
    expect(empty.eof).toBe(true);
    expect(empty.total_size).toBe(0);
    expect(empty.encoding).toBe('utf-8');
    expect(() => readTaskObjectPage(dir, locator, 0, 0)).toThrow(/limit must be positive/);
  });

  it('write_page_create_overwrite_and_pwrite', () => {
    const locator = pagedLocator('artifacts', 'notes/out.txt');
    const created = writeTaskObjectPage(dir, locator, Buffer.from('hello world'), null, null);
    expect(created.created).toBe(true);
    expect(created.total_size).toBe(11);
    expect(created.sha256).toBe(sha256(Buffer.from('hello world')));

    const overwritten = writeTaskObjectPage(dir, locator, Buffer.from('ABCDEF'), null, null);
    expect(overwritten.created).toBe(false);
    expect(readFileSync(join(dir, 'notes/out.txt'))).toEqual(Buffer.from('ABCDEF'));

    const pwrite = writeTaskObjectPage(dir, locator, Buffer.from('xy'), 2, null);
    expect(pwrite.written_bytes).toBe(2);
    expect(readFileSync(join(dir, 'notes/out.txt'))).toEqual(Buffer.from('ABxyEF'));

    const extended = writeTaskObjectPage(dir, locator, Buffer.from('ZZZZ'), 4, null);
    expect(extended.total_size).toBe(8);
    expect(readFileSync(join(dir, 'notes/out.txt'))).toEqual(Buffer.from('ABxyZZZZ'));
  });

  it('write_page_optimistic_lock_and_offset_bounds', () => {
    const locator = pagedLocator('artifacts', 'lock.txt');
    writeTaskObjectPage(dir, locator, Buffer.from('v1'), null, null);
    const shaV1 = sha256(Buffer.from('v1'));
    expect(() => writeTaskObjectPage(dir, locator, Buffer.from('v2'), null, shaV1)).not.toThrow();
    expect(() => writeTaskObjectPage(dir, locator, Buffer.from('v3'), null, shaV1))
      .toThrow(/expected_sha256 mismatch/);
    expect(() => writeTaskObjectPage(dir, pagedLocator('artifacts', 'ghost.txt'), Buffer.from('x'), null, shaV1))
      .toThrow(/does not exist/);
    expect(() => writeTaskObjectPage(dir, locator, Buffer.from('x'), 99, null))
      .toThrow(/exceeds current size/);
    const big = Buffer.alloc(OBJECT_WRITE_MAX_BYTES + 1, 0x78);
    expect(() => writeTaskObjectPage(dir, locator, big, null, null)).toThrow();
  });

  it('write_page_rejects_foreign_roots_and_escapes', () => {
    expect(() => writeTaskObjectPage(dir, pagedLocator('temp', 'a.txt'), Buffer.from('x'), null, null))
      .toThrow(/not object-writable/);
    const evil = { rootId: 'artifacts', relativePath: '../evil.txt' };
    expect(() => writeTaskObjectPage(dir, evil, Buffer.from('x'), null, null))
      .toThrow(/unsafe path segment|escapes/);
  });

  it.runIf(process.platform !== 'win32')('write_page_rejects_symlink_escape', () => {
    const outside = mkdtempSync(join(tmpdir(), 'f4-task-objects-outside-'));
    try {
      writeFileSync(join(outside, 'victim.txt'), 'keep');
      symlinkSync(outside, join(dir, 'linked'));
      const locator = pagedLocator('artifacts', 'linked/victim.txt');
      expect(() => writeTaskObjectPage(dir, locator, Buffer.from('pwned'), null, null))
        .toThrow(/escapes the managed root/);
      expect(readFileSync(join(outside, 'victim.txt'))).toEqual(Buffer.from('keep'));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

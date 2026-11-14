import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  FileManagerExecutor, canClaimCompleteSuccess, convertContent, normalizeFilePath,
  parseRequestedItem, serializePlanPreview, sha256Json, validateRequestedItem,
  type BatchManifest, type PlannedItem, type PlanPreview,
} from '../src/tools/file-manager.ts';

const dirs: string[] = [];
const tmp = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l05-file-manager-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('normalization_rejects_absolute_escape_and_hidden_paths', () => {
  expect(normalizeFilePath('reports/./a.json', 'source')).toBe('reports/a.json');
  for (const unsafePath of [
    '../secret',
    '/tmp/file',
    '.env',
    'a/.hidden/file',
    'a\\..\\secret',
  ]) {
    expect(() => normalizeFilePath(unsafePath, 'source')).toThrow();
  }
});

it('preview_hash_binds_expected_hashes_and_destination', () => {
  const preview: PlanPreview = {
    schemaVersion: 1,
    rootId: 'workspace',
    items: [{
      itemId: 'one',
      operation: 'rename',
      sourcePath: 'a.txt',
      destinationPath: 'b.txt',
      expectedCurrentHash: 'a'.repeat(64),
      sizeBytes: 1,
    }],
  };
  const hash = (value: PlanPreview): string => sha256Json(serializePlanPreview(value));
  const first = hash(preview);
  const item = preview.items[0] as PlannedItem;
  item.destinationPath = 'c.txt';
  expect(first).not.toBe(hash(preview));
  item.destinationPath = 'b.txt';
  item.expectedCurrentHash = 'b'.repeat(64);
  expect(first).not.toBe(hash(preview));
});

it('delete_trash_path_is_backend_derived', () => {
  const requested = parseRequestedItem({
    item_id: 'one',
    operation: 'delete',
    source_path: 'a.txt',
    destination_path: 'chosen/by/model',
  });
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  expect(() => validateRequestedItem(requested, dir)).toThrow();
});

it('conversions_are_deterministic', () => {
  const dir = tmp();
  const jsonPath = path.join(dir, 'a.json');
  fs.writeFileSync(jsonPath, '{"b":2,"a":1}');
  const pretty = convertContent(jsonPath, 'json_pretty');
  expect(pretty.equals(convertContent(jsonPath, 'json_pretty'))).toBe(true);
  expect(pretty.toString('utf8')).toContain('\n');
});

it('manifest_never_claims_partial_success', () => {
  const manifest: BatchManifest = {
    manifestId: 'one',
    expectedItems: 2,
    observedItems: 2,
    coverageComplete: true,
    truncated: false,
    items: [
      {
        itemId: 'a',
        status: 'succeeded',
        attempts: 1,
      },
      {
        itemId: 'b',
        status: 'failed',
        attempts: 1,
        error: 'conflict',
      },
    ],
  };
  expect(canClaimCompleteSuccess(manifest)).toBe(false);
});

it('sensitivity_and_concurrency_match_product_contract', () => {
  const executor = new FileManagerExecutor();
  expect(executor.sensitivityLevel('builtin-file_manager_plan')).toBe('low');
  expect(executor.concurrencyClass('builtin-file_manager_plan')).toBe('read_only');
  for (const tool of ['builtin-file_manager_commit', 'builtin-file_manager_restore']) {
    expect(executor.sensitivityLevel(tool)).toBe('medium');
    expect(executor.concurrencyClass(tool)).toBe('serial');
  }
});

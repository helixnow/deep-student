import { test } from 'vitest';
import assert from 'node:assert/strict';
import { classifyDynamic, renderReport } from './audit.ts';
import type { Site } from './scan.ts';

test('R06 classification preserves the reviewed undefined-preview boundary instead of assigning a new L17 task', () => {
  for (const name of ['{}', '{}_start', '{}_end', '{}_error']) {
    const site: Site = {
      file: 'src/components/NoTagTreeShadPanel.tsx', line: 187, column: 1,
      kind: 'listen', via: 'listen', expression: 'eventName', names: [name], dynamic: true,
      shape: { 'x-ts': 'unknown' }, tsType: 'unknown', nameIndex: 0, dataIndex: 1, test: false,
    };
    const classification = classifyDynamic(site);
    assert.match(classification, /X2-R06/);
    assert.match(classification, /订阅前失败/);
    assert.match(classification, /成功通道仍 unproven/);
    assert.match(classification, /不向 L17 新派/);
    assert.doesNotMatch(classification, /交 L17-memory-research 核对返回值/);
  }
});

test('generated report recommends the actual Vitest runner without scanning source or rewriting the historical snapshot', () => {
  const report = renderReport({
    commit: 'fixture', schemaVersion: 1, stats: {}, findings: [], dynamic: [], computedCommands: [],
    frontend: { wrappers: [], forwarding: [], candidates: [] },
  });
  assert.match(report, /npx vitest run -c vitest\.host\.config\.ts scripts\/electron-migration\/frontend-audit/);
  assert.doesNotMatch(report, /node --test/);
});

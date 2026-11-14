import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import secrets from '../../secrets/index.ts';
import storage from '../index.ts';

let base: string;
let host: Awaited<ReturnType<typeof createTestHost>>;
const logs: Array<{ level: string; message: string }> = [];
beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-budget-exact-'));
  host = await createTestHost({
    app: { dataDir: base }, plugins: [secrets, [storage, { dataLocalDir: base }]],
    provide: {
      paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base } },
      log: { logger: () => ({
        debug(message: string) { logs.push({ level: 'debug', message }); },
        info(message: string) { logs.push({ level: 'info', message }); },
        warn() {}, error() {}, trace() {},
      }) },
    },
  });
}, 60_000);
afterAll(async () => { await host?.dispose(); fs.rmSync(base, { recursive: true, force: true }); });

it('test_injection_item_creation through the real public service', () => {
  const item = host.ctx.injectionBudget.newItem('Rag', 'Test content', 2, 'test_source');
  expect(item.injection_type).toBe('Rag');
  expect(item.char_count).toBe(12);
  expect(item.priority).toBe(2);
});

it('test_budget_allocation_basic through the exact owner entry', () => {
  const service = host.ctx.injectionBudget;
  const manager = service.createExactManager(service.defaultExactConfig());
  manager.addItem(service.newItem('Rag', 'A'.repeat(1000), 2, 'rag_source'));
  manager.addItem(service.newItem('Memory', 'B'.repeat(500), 3, 'memory_source'));
  const result = manager.allocate();
  expect(result.selected_items).toHaveLength(2);
  expect(result.total_chars_used).toBe(1500n);
});

it('test_priority_allocation through the exact owner entry', () => {
  const service = host.ctx.injectionBudget, config = service.defaultExactConfig();
  config.total_budget = 1000n; config.reserved_for_user_input = 200n; config.reserved_for_system = 100n;
  const manager = service.createExactManager(config);
  manager.addItem(service.newItem('Rag', 'A'.repeat(600), 4, 'low_priority'));
  manager.addItem(service.newItem('Memory', 'B'.repeat(300), 2, 'high_priority'));
  const result = manager.allocate();
  expect(result.selected_items).toHaveLength(1);
  expect(result.selected_items[0]!.priority).toBe(2);
  expect(result.budget_remaining).toBe(400n);
});

it('test_type_limits through the exact owner entry', () => {
  const service = host.ctx.injectionBudget, config = service.defaultExactConfig();
  config.type_limits.set('Rag', 500n); config.enable_smart_truncation = false;
  const manager = service.createExactManager(config);
  manager.addItem(service.newItem('Rag', 'A'.repeat(800), 2, 'over_limit'));
  const result = manager.allocate();
  expect(result.selected_items).toHaveLength(0);
  expect(result.items_dropped).toHaveLength(1);
});

it('test_smart_truncation through the exact owner entry', () => {
  const service = host.ctx.injectionBudget;
  const manager = service.createExactManager(service.defaultExactConfig());
  const content = 'This is a test sentence. This is another sentence with more content that should be truncated.';
  const truncated = manager.smartTruncate(content, 50n);
  expect(truncated.length).toBeLessThanOrEqual(50);
  expect(truncated.endsWith('...')).toBe(true);
  expect(manager.smartTruncate(content, 18446744073709551615n)).toBe(content);
});

it('R1 L02-04 preserves the one-character budget above 2^53 and exact summary text', () => {
  const service = host.ctx.injectionBudget, config = service.defaultExactConfig();
  config.total_budget = 9007199254740993n;
  config.reserved_for_user_input = 9007199254740992n;
  config.reserved_for_system = 0n;
  config.type_limits.set('Rag', 9007199254740993n);
  const manager = service.createExactManager(config);
  manager.addItem(service.newItem('Rag', '你', 1, 'one-char'));
  manager.addItem(service.newItem('Rag', 'x', 2, 'overflow'));
  const result = manager.allocate();
  expect(result.selected_items.map(item => item.content)).toEqual(['你']);
  expect(result.items_dropped.map(item => item.content)).toEqual(['x']);
  expect(result.total_chars_used).toBe(1n);
  expect(result.budget_remaining).toBe(0n);
  expect(result.allocation_stats.get('Rag')).toBe(1n);
  const summary = manager.generateInjectionSummary(result);
  expect(summary).toContain('- 总预算: 9007199254740993 字符\n');
  expect(summary).toContain('- rag: 1 / 9007199254740993 字符 (0.0%)\n');
  expect(logs).toContainEqual({ level: 'info', message: '开始预算分配，可用预算: 1 字符' });
});

it('R1 L02-04 accepts u64::MAX and retains exact unused budget', () => {
  const service = host.ctx.injectionBudget, config = service.defaultExactConfig();
  config.total_budget = 18446744073709551615n;
  config.reserved_for_user_input = 0n; config.reserved_for_system = 0n;
  config.type_limits.set('Rag', 18446744073709551614n);
  const manager = service.createExactManager(config);
  manager.addItem(service.newItem('Rag', 'ab', 2, 'large-limit'));
  const result = manager.allocate();
  expect(result.total_chars_used).toBe(2n);
  expect(result.budget_remaining).toBe(18446744073709551613n);
  expect(manager.generateInjectionSummary(result)).toContain('rag: 2 / 18446744073709551614 字符 (0.0%)');
});

it('R1 L02-04 applies both saturating_sub operations and preserves Critical-drop warnings', () => {
  const service = host.ctx.injectionBudget, config = service.defaultExactConfig();
  config.total_budget = 1n;
  config.reserved_for_user_input = 18446744073709551615n;
  config.reserved_for_system = 18446744073709551615n;
  const manager = service.createExactManager(config);
  manager.addItem(service.newItem('Rag', 'x', 1, 'critical'));
  const result = manager.allocate();
  expect(result.total_chars_used).toBe(0n);
  expect(result.budget_remaining).toBe(0n);
  expect(result.warnings).toEqual(['关键内容被丢弃，预算不足: rag(1 chars): x']);
});

it('summary follows Rust f32 casts and one-decimal ties-to-even', () => {
  const service = host.ctx.injectionBudget, config = service.defaultExactConfig();
  config.type_limits.set('Rag', 400n); config.type_limits.set('Memory', 400n);
  const manager = service.createExactManager(config);
  manager.addItem(service.newItem('Rag', 'a', 2, 'quarter'));
  manager.addItem(service.newItem('Memory', 'abc', 2, 'three-quarters'));
  const result = manager.allocate();
  const summary = manager.generateInjectionSummary(result);
  // HashMap iteration order is not compared; only the individual source-defined lines.
  expect(summary).toContain('- rag: 1 / 400 字符 (0.2%)');
  expect(summary).toContain('- memory: 3 / 400 字符 (0.8%)');
  result.selected_items[0]!.content = 'changed by caller';
  expect(manager.pending_items[0]!.content).toBe('a');
});

it('the original number-valued service contract remains usable', () => {
  const service = host.ctx.injectionBudget;
  const manager = service.createManager(service.defaultConfig());
  manager.addItem(service.newItem('Rag', 'abc', 2, 'legacy'));
  const result = manager.allocate();
  expect(result.total_chars_used).toBe(3);
  expect(typeof result.budget_remaining).toBe('number');
});

it('exact type truncation keeps the Rust threshold, global-fit branch and original dropped item', () => {
  const service = host.ctx.injectionBudget, config = service.defaultExactConfig();
  config.total_budget = 150n; config.reserved_for_user_input = 0n; config.reserved_for_system = 0n;
  config.type_limits.set('Rag', 150n);
  const manager = service.createExactManager(config);
  manager.addItem(service.newItem('Rag', '💡'.repeat(200), 2, 'unicode'));
  const selected = manager.allocate();
  expect(selected.selected_items[0]!.char_count).toBe(150);
  expect([...selected.selected_items[0]!.content]).toHaveLength(150);
  expect(selected.total_chars_used).toBe(150n);
  expect(selected.warnings).toEqual(['内容已截断: unicode (200 -> 150 字符)']);
  config.total_budget = 149n;
  const overGlobal = manager.allocate();
  expect(overGlobal.selected_items).toEqual([]);
  expect(overGlobal.items_dropped[0]!.content).toBe('💡'.repeat(200));
  expect(overGlobal.warnings).toEqual([]);
  config.type_limits.set('Rag', 100n);
  expect(manager.allocate().selected_items).toEqual([]);
  expect(manager.allocate().warnings).toEqual([]);
});

it('zero-sized content with zero type limit formats the Rust zero percentage branch', () => {
  const service = host.ctx.injectionBudget, config = service.defaultExactConfig();
  config.type_limits.set('Rag', 0n);
  const manager = service.createExactManager(config);
  manager.addItem(service.newItem('Rag', '', 2, 'empty'));
  const result = manager.allocate();
  expect(result.selected_items).toHaveLength(1);
  expect(result.allocation_stats.get('Rag')).toBe(0n);
  expect(manager.generateInjectionSummary(result)).toContain('- rag: 0 / 0 字符 (0.0%)');
});

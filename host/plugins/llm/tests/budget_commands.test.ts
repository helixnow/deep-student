import { describe, expect, it } from 'vitest';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';

describe('injection budget commands (L02-04)', () => {
  it('requires every stored BudgetConfig field and preserves load/parse error contexts', async () => {
    let raw: string | null = '{}', fail = false;
    const host = await createTestHost({ plugins: [plugin], provide: { settings: { get: () => {
      if (fail) throw new Error('read failed'); return raw;
    } }, secrets: {} } });
    try {
      await expect(host.invoke('get_injection_budget_config')).rejects.toMatchObject({ error_type: 'Validation',
        message: '加载注入预算配置失败: Failed to parse injection budget config: missing field `total_budget` at line 1 column 2' });
      await expect(host.invoke('simulate_budget_allocation', { testItems: [] })).rejects.toMatchObject({
        message: '加载配置失败: Failed to parse injection budget config: missing field `total_budget` at line 1 column 2' });
      fail = true;
      await expect(host.invoke('simulate_budget_allocation', { testItems: [] })).rejects.toMatchObject({
        message: '加载配置失败: Failed to load injection budget config: read failed' });
      fail = false; raw = null;
      const result = await host.invoke<{ config: Record<string, unknown> }>('get_injection_budget_config');
      expect(result.config.type_limits).toHaveProperty('LearnerProfile', 4000);
      raw = JSON.stringify({ ...result.config, enable_smart_truncation: null });
      await expect(host.invoke('get_injection_budget_config')).rejects.toMatchObject({ error_type: 'Validation' });
    } finally { await host.dispose(); }
  });
  it('rejects learner_profile as a command input while serializing platform priority enums as Rust names', async () => {
    const host = await createTestHost({ plugins: [plugin], provide: { settings: { get: () => null }, secrets: {} } });
    try {
      await expect(host.invoke('simulate_budget_allocation', { testItems: [{ type: 'learner_profile', content: 'text' }] }))
        .rejects.toMatchObject({ error_type: 'Validation', message: 'Unknown injection type: learner_profile' });
      const result = await host.invoke<{ allocation_result: { selected_items: { priority: string; created_at: string }[]; allocation_stats: unknown }; selected_count: number }>(
        'simulate_budget_allocation', { testItems: [{ type: 'rag', content: 'hello', priority: 'high' }, { type: 'memory', content: 'world', priority: 'unrecognized' }] });
      expect(result.selected_count).toBe(2);
      expect(result.allocation_result.selected_items.map(item => item.priority)).toEqual(['High', 'Medium']);
      expect(result.allocation_result.selected_items[0]?.created_at).toMatch(/Z$/);
      expect(result.allocation_result.allocation_stats).toEqual({ Rag: 5, Memory: 5 });
    } finally { await host.dispose(); }
  });
});

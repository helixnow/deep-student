import { expect, it } from 'vitest';
import {
  InjectionBudgetManager,
  InjectionType,
  Priority,
  defaultBudgetConfig,
  newInjectionItem,
} from '../injection-budget.ts';

it('test_injection_item_creation', () => {
  const item = newInjectionItem(InjectionType.Rag, 'Test content', Priority.High, 'test_source');
  expect(item.injection_type).toBe(InjectionType.Rag);
  expect(item.char_count).toBe(12);
  expect(item.priority).toBe(Priority.High);
  expect(item.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?\+00:00$/);
});

it('test_budget_allocation_basic', () => {
  const manager = InjectionBudgetManager.withDefaultConfig();
  manager.addItem(newInjectionItem(InjectionType.Rag, 'A'.repeat(1000), Priority.High, 'rag_source'));
  manager.addItem(newInjectionItem(InjectionType.Memory, 'B'.repeat(500), Priority.Medium, 'memory_source'));

  const result = manager.allocate();
  expect(result.selected_items).toHaveLength(2);
  expect(result.total_chars_used).toBe(1500);
});

it('test_priority_allocation', () => {
  const config = defaultBudgetConfig();
  config.total_budget = 1000;
  config.reserved_for_user_input = 200;
  config.reserved_for_system = 100;
  const manager = new InjectionBudgetManager(config);

  manager.addItem(newInjectionItem(InjectionType.Rag, 'A'.repeat(600), Priority.Low, 'low_priority'));
  manager.addItem(newInjectionItem(InjectionType.Memory, 'B'.repeat(300), Priority.High, 'high_priority'));

  const result = manager.allocate();
  expect(result.selected_items).toHaveLength(1);
  expect(result.selected_items[0]!.priority).toBe(Priority.High);
});

it('test_type_limits', () => {
  const config = defaultBudgetConfig();
  config.type_limits.set(InjectionType.Rag, 500);
  config.enable_smart_truncation = false;
  const manager = new InjectionBudgetManager(config);

  manager.addItem(newInjectionItem(InjectionType.Rag, 'A'.repeat(800), Priority.High, 'over_limit'));

  const result = manager.allocate();
  expect(result.selected_items).toHaveLength(0);
  expect(result.items_dropped).toHaveLength(1);
});

it('test_smart_truncation', () => {
  const config = defaultBudgetConfig();
  config.enable_smart_truncation = true;
  config.type_limits.set(InjectionType.Rag, 150);
  const manager = new InjectionBudgetManager(config);

  const longContent = 'This is a test sentence. This is another sentence with more content that should be truncated.';
  const truncated = manager.smartTruncate(longContent, 50);
  expect(truncated.length).toBeLessThanOrEqual(50);
  expect(truncated.endsWith('...')).toBe(true);
});

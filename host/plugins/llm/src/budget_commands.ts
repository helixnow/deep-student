/** commands.rs:6913–6995. Allocation remains owned by F3 injectionBudget. */
import type { InjectionBudgetService } from '../../../platform/storage/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { AppError, CommandError } from '../../../platform/errors/api.ts';
import { parseRfc3339, toRfc3339Opts } from '../../../platform/time/index.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';

type BudgetConfig = ReturnType<InjectionBudgetService['defaultConfig']>;
type InjectionItem = ReturnType<InjectionBudgetService['newItem']>;
type InjectionType = Parameters<InjectionBudgetService['newItem']>[0];
type Priority = Parameters<InjectionBudgetService['newItem']>[2];

const TYPES = ['Rag', 'Memory', 'LearnerProfile', 'WebSearch', 'Context', 'SystemPrompt', 'UserInput', 'ToolResults'] as const;
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low', 'Optional'] as const;
const FIELDS = ['total_budget', 'reserved_for_user_input', 'reserved_for_system', 'type_limits', 'priority_weights', 'enable_smart_truncation'] as const;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function decodeBudget(raw: string): BudgetConfig {
  const parsed: unknown = JSON.parse(raw);
  const lines = raw.trimEnd().split('\n');
  const fail = (text: string): never => { throw new Error(`${text} at line ${lines.length} column ${utf8ByteLength(lines.at(-1) ?? '')}`); };
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid type: expected struct BudgetConfig');
  const value = parsed as Record<string, unknown>;
  for (const field of FIELDS) if (!Object.hasOwn(value, field)) fail(`missing field \`${field}\``);
  const usize = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail('invalid type: expected usize');
    return value as number;
  };
  const map = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid type: expected a map');
    return value as Record<string, unknown>;
  };
  const typeLimits = new Map<InjectionType, number>();
  for (const [key, limit] of Object.entries(map(value.type_limits))) {
    if (!TYPES.includes(key as InjectionType)) fail(`unknown variant \`${key}\`, expected one of ${TYPES.map(type => `\`${type}\``).join(', ')}`);
    typeLimits.set(key as InjectionType, usize(limit));
  }
  const weights = new Map<Priority, number>();
  for (const [key, weight] of Object.entries(map(value.priority_weights))) {
    const index = PRIORITIES.indexOf(key as typeof PRIORITIES[number]);
    if (index < 0) fail(`unknown variant \`${key}\`, expected one of ${PRIORITIES.map(type => `\`${type}\``).join(', ')}`);
    if (typeof weight !== 'number' || !Number.isFinite(weight)) fail('invalid type: expected f32');
    weights.set((index + 1) as Priority, Math.fround(weight as number));
  }
  if (typeof value.enable_smart_truncation !== 'boolean') fail('invalid type: expected a boolean');
  return { total_budget: usize(value.total_budget), reserved_for_user_input: usize(value.reserved_for_user_input),
    reserved_for_system: usize(value.reserved_for_system), type_limits: typeLimits, priority_weights: weights,
    enable_smart_truncation: value.enable_smart_truncation as boolean };
}

function wireConfig(config: BudgetConfig) {
  return { ...config, type_limits: Object.fromEntries(config.type_limits),
    priority_weights: Object.fromEntries([...config.priority_weights].map(([key, value]) => [PRIORITIES[key - 1], value])) };
}
function wireItem(item: InjectionItem) {
  const time = parseRfc3339(item.created_at);
  return { ...item, priority: PRIORITIES[item.priority - 1],
    created_at: time === null ? item.created_at : toRfc3339Opts(time.epochNanos, 'AutoSi', true) };
}

export function createBudgetCommands(settings: Pick<SettingsStore, 'get'>, budget: InjectionBudgetService) {
  function load(): BudgetConfig {
    let raw: string | null;
    try { raw = settings.get('injection_budget.config'); }
    catch (error) { throw new Error(`Failed to load injection budget config: ${message(error)}`); }
    if (raw === null) return budget.defaultConfig();
    try { return decodeBudget(raw); }
    catch (error) { throw new Error(`Failed to parse injection budget config: ${message(error)}`); }
  }
  return {
    getConfig() {
      try { return { config: wireConfig(load()), default_config: wireConfig(budget.defaultConfig()) }; }
      catch (error) { throw new CommandError(AppError.validation(`加载注入预算配置失败: ${message(error)}`)); }
    },
    simulate(testItems: unknown[]) {
      let config: BudgetConfig;
      try { config = load(); }
      catch (error) { throw new CommandError(AppError.validation(`加载配置失败: ${message(error)}`)); }
      const manager = budget.createManager(config);
      for (const raw of testItems) {
        const item = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
        if (typeof item.type !== 'string') throw new CommandError(AppError.validation("Missing or invalid 'type' field"));
        const types: Record<string, InjectionType> = { rag: 'Rag', memory: 'Memory', web_search: 'WebSearch', context: 'Context', system_prompt: 'SystemPrompt', user_input: 'UserInput', tool_results: 'ToolResults' };
        const type = Object.hasOwn(types, item.type) ? types[item.type] : undefined;
        if (type === undefined) throw new CommandError(AppError.validation(`Unknown injection type: ${item.type}`));
        if (typeof item.content !== 'string') throw new CommandError(AppError.validation("Missing or invalid 'content' field"));
        const index = ['critical', 'high', 'medium', 'low', 'optional'].indexOf(typeof item.priority === 'string' ? item.priority : 'medium');
        manager.addItem(budget.newItem(type, item.content, (index < 0 ? 3 : index + 1) as Priority,
          typeof item.source === 'string' ? item.source : 'test'));
      }
      const result = manager.allocate();
      return { allocation_result: { ...result, selected_items: result.selected_items.map(wireItem),
        items_dropped: result.items_dropped.map(wireItem), allocation_stats: Object.fromEntries(result.allocation_stats) },
        summary: manager.generateInjectionSummary(result), total_input_items: manager.pending_items.length,
        selected_count: result.selected_items.length, dropped_count: result.items_dropped.length };
    },
  };
}

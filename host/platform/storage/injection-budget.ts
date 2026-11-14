/**
 * Unified injection character budget (dstu-storage/src/injection_budget.rs).
 *
 * Priority allocation is highest-first; type limits are enforced before the
 * global budget, and smart truncation applies to Critical/High/Medium items.
 */
import { rfc3339Now } from './time.ts';
import { storageLog } from './logging.ts';

export type InjectionType =
  | 'Rag'
  | 'Memory'
  | 'LearnerProfile'
  | 'WebSearch'
  | 'Context'
  | 'SystemPrompt'
  | 'UserInput'
  | 'ToolResults';

export const InjectionType = {
  Rag: 'Rag' as const,
  Memory: 'Memory' as const,
  LearnerProfile: 'LearnerProfile' as const,
  WebSearch: 'WebSearch' as const,
  Context: 'Context' as const,
  SystemPrompt: 'SystemPrompt' as const,
  UserInput: 'UserInput' as const,
  ToolResults: 'ToolResults' as const,
};

export const INJECTION_TYPE_NAMES: Record<InjectionType, string> = {
  Rag: 'rag',
  Memory: 'memory',
  LearnerProfile: 'learner_profile',
  WebSearch: 'web_search',
  Context: 'context',
  SystemPrompt: 'system_prompt',
  UserInput: 'user_input',
  ToolResults: 'tool_results',
};

export type Priority = 1 | 2 | 3 | 4 | 5;
export const Priority = {
  Critical: 1 as Priority,
  High: 2 as Priority,
  Medium: 3 as Priority,
  Low: 4 as Priority,
  Optional: 5 as Priority,
};

export interface InjectionItem {
  injection_type: InjectionType;
  content: string;
  priority: Priority;
  source: string;
  metadata: unknown;
  char_count: number;
  created_at: string;
}

function charCount(content: string): number {
  return [...content].length;
}

/** dstu-util/src/utils/text.rs:10. */
function safeTruncate(input: string, maxChars: number): string {
  if (maxChars === 0) return '';
  const chars = [...input];
  if (chars.length <= maxChars) return input;
  return `${chars.slice(0, maxChars).join('')}...`;
}

/** injection_budget.rs:63. */
export function newInjectionItem(
  injectionType: InjectionType,
  content: string,
  priority: Priority,
  source: string,
): InjectionItem {
  return {
    injection_type: injectionType,
    content,
    priority,
    source,
    metadata: null,
    char_count: charCount(content),
    created_at: rfc3339Now(),
  };
}

export function withMetadata(item: InjectionItem, metadata: unknown): InjectionItem {
  item.metadata = metadata;
  return item;
}

/** injection_budget.rs:87. */
export function injectionSummary(item: InjectionItem): string {
  return `${INJECTION_TYPE_NAMES[item.injection_type]}(${item.char_count} chars): ${safeTruncate(item.content, 100)}`;
}

export interface BudgetConfig {
  total_budget: number;
  reserved_for_user_input: number;
  reserved_for_system: number;
  type_limits: Map<InjectionType, number>;
  priority_weights: Map<Priority, number>;
  enable_smart_truncation: boolean;
}

/** Already-decoded desktop usize values. No Number conversion at the owner boundary. */
export interface ExactBudgetConfig extends Omit<BudgetConfig,
  'total_budget' | 'reserved_for_user_input' | 'reserved_for_system' | 'type_limits'> {
  total_budget: bigint;
  reserved_for_user_input: bigint;
  reserved_for_system: bigint;
  type_limits: Map<InjectionType, bigint>;
}

/** injection_budget.rs:109. */
export function defaultBudgetConfig(): BudgetConfig {
  return {
    total_budget: 30000,
    reserved_for_user_input: 4000,
    reserved_for_system: 2000,
    type_limits: new Map<InjectionType, number>([
      ['Rag', 8000],
      ['Memory', 4000],
      ['LearnerProfile', 4000],
      ['WebSearch', 6000],
      ['Context', 3000],
      ['SystemPrompt', 2000],
      ['ToolResults', 5000],
    ]),
    priority_weights: new Map<Priority, number>([
      [Priority.Critical, 10.0],
      [Priority.High, 5.0],
      [Priority.Medium, 2.0],
      [Priority.Low, 1.0],
      [Priority.Optional, 0.5],
    ]),
    enable_smart_truncation: true,
  };
}

export function availableBudget(config: BudgetConfig): number {
  return Number(exactAvailableBudget(toExactConfig(config)));
}

export function typeLimit(config: BudgetConfig, type: InjectionType): number {
  return config.type_limits.get(type) ?? 1000;
}

export function priorityWeight(config: BudgetConfig, priority: Priority): number {
  return config.priority_weights.get(priority) ?? 1.0;
}

export interface AllocationResult {
  selected_items: InjectionItem[];
  total_chars_used: number;
  budget_remaining: number;
  items_dropped: InjectionItem[];
  allocation_stats: Map<InjectionType, number>;
  warnings: string[];
}

export interface ExactAllocationResult extends Omit<AllocationResult,
  'total_chars_used' | 'budget_remaining' | 'allocation_stats'> {
  total_chars_used: bigint;
  budget_remaining: bigint;
  allocation_stats: Map<InjectionType, bigint>;
}

function toExactConfig(config: BudgetConfig): ExactBudgetConfig {
  return {
    ...config,
    total_budget: BigInt(config.total_budget),
    reserved_for_user_input: BigInt(config.reserved_for_user_input),
    reserved_for_system: BigInt(config.reserved_for_system),
    type_limits: new Map([...config.type_limits].map(([type, limit]) => [type, BigInt(limit)])),
  };
}

export function defaultExactBudgetConfig(): ExactBudgetConfig { return toExactConfig(defaultBudgetConfig()); }

const saturatingSub = (a: bigint, b: bigint): bigint => a > b ? a - b : 0n;
function exactAvailableBudget(config: ExactBudgetConfig): bigint {
  return saturatingSub(saturatingSub(config.total_budget, config.reserved_for_user_input), config.reserved_for_system);
}
const LOG_TARGET = 'dstu_storage::injection_budget';
const PRIORITY_NAMES = ['Critical', 'High', 'Medium', 'Low', 'Optional'] as const;

/** The queue/diagnostic behavior is shared by both public numeric representations. */
class InjectionBudgetState {
  pending_items: InjectionItem[] = [];

  addItem(item: InjectionItem): void {
    storageLog(LOG_TARGET, 'debug', `添加注入项: ${injectionSummary(item)}`);
    this.pending_items.push(item);
  }
  addItems(items: InjectionItem[]): void { for (const item of items) this.addItem(item); }
  clear(): void { this.pending_items = []; }
}

export class ExactInjectionBudgetManager extends InjectionBudgetState {
  config: ExactBudgetConfig;

  constructor(config: ExactBudgetConfig) {
    super();
    this.config = config;
  }

  static withDefaultConfig(): ExactInjectionBudgetManager {
    return new ExactInjectionBudgetManager(defaultExactBudgetConfig());
  }

  /** injection_budget.rs:210. */
  allocate(): ExactAllocationResult {
    const available = exactAvailableBudget(this.config);
    storageLog(LOG_TARGET, 'info', `开始预算分配，可用预算: ${available} 字符`);
    const byPriority = new Map<Priority, InjectionItem[]>();
    for (const item of this.pending_items) {
      const group = byPriority.get(item.priority) ?? [];
      group.push(structuredClone(item));
      byPriority.set(item.priority, group);
    }

    const selectedItems: InjectionItem[] = [];
    let remainingBudget = available;
    const itemsDropped: InjectionItem[] = [];
    const allocationStats = new Map<InjectionType, bigint>();
    const warnings: string[] = [];

    const priorities: Priority[] = [Priority.Critical, Priority.High, Priority.Medium, Priority.Low, Priority.Optional];
    for (const priority of priorities) {
      const items = byPriority.get(priority);
      if (!items) continue;
      storageLog(LOG_TARGET, 'debug', `处理优先级 ${PRIORITY_NAMES[priority - 1]} 的 ${items.length} 个项目`);

      for (const item of items) {
        const limit = this.config.type_limits.get(item.injection_type) ?? 1000n;
        const currentUsage = allocationStats.get(item.injection_type) ?? 0n;
        // newItem counts an actual JS string; its individual character count is exact.
        const itemChars = BigInt(item.char_count);

        if (currentUsage + itemChars > limit) {
          if (this.config.enable_smart_truncation && priority <= Priority.Medium) {
            const availableForType = saturatingSub(limit, currentUsage);
            if (availableForType > 100n) {
              const truncated = this.truncateItem(item, availableForType);
              const truncatedChars = BigInt(truncated.char_count);
              if (truncatedChars <= remainingBudget) {
                remainingBudget -= truncatedChars;
                allocationStats.set(item.injection_type, currentUsage + truncatedChars);
                selectedItems.push(truncated);
                warnings.push(`内容已截断: ${item.source} (${item.char_count} -> ${availableForType} 字符)`);
              } else {
                itemsDropped.push(item);
              }
            } else {
              itemsDropped.push(item);
            }
          } else {
            itemsDropped.push(item);
            if (currentUsage === 0n) {
              warnings.push(`类型 ${INJECTION_TYPE_NAMES[item.injection_type]} 的内容过长，超过限制 ${limit} 字符`);
            }
          }
          continue;
        }

        if (itemChars <= remainingBudget) {
          remainingBudget -= itemChars;
          allocationStats.set(item.injection_type, currentUsage + itemChars);
          selectedItems.push(item);
          storageLog(LOG_TARGET, 'debug', `选中项目: ${injectionSummary(item)} (剩余预算: ${remainingBudget})`);
        } else {
          itemsDropped.push(item);
          if (priority === Priority.Critical) {
            warnings.push(`关键内容被丢弃，预算不足: ${injectionSummary(item)}`);
          }
        }
      }
    }

    storageLog(LOG_TARGET, 'info', `预算分配完成: 使用 ${available - remainingBudget} / ${available} 字符，选中 ${selectedItems.length} 项，丢弃 ${itemsDropped.length} 项`);
    return {
      selected_items: selectedItems,
      total_chars_used: available - remainingBudget,
      budget_remaining: remainingBudget,
      items_dropped: itemsDropped,
      allocation_stats: allocationStats,
      warnings,
    };
  }

  /** injection_budget.rs:329. */
  private truncateItem(item: InjectionItem, maxChars: bigint): InjectionItem {
    if (BigInt(item.char_count) <= maxChars) return item;
    const content = this.smartTruncate(item.content, maxChars);
    return { ...item, content, char_count: charCount(content) };
  }

  /** injection_budget.rs:343. */
  smartTruncate(content: string, maxChars: bigint): string {
    const chars = [...content];
    if (BigInt(chars.length) <= maxChars) return content;

    // Only now is maxChars below a materialized array length, so this cast is exact.
    const target = Number(saturatingSub(maxChars, 3n));
    let bestCut = target;

    const searchEnd = Math.min(target, chars.length - 1);
    for (let index = searchEnd; index >= Math.max(0, target - 50); index--) {
      const ch = chars[index];
      if (ch === '.' || ch === '!' || ch === '?' || ch === '\n' || ch === '。' || ch === '！' || ch === '？') {
        bestCut = index + 1;
        break;
      }
    }

    if (bestCut === target) {
      for (let index = searchEnd; index >= Math.max(0, target - 20); index--) {
        const ch = chars[index];
        if (ch === ' ' || ch === '\t' || ch === '-' || ch === '_') {
          bestCut = index;
          break;
        }
      }
    }

    return `${chars.slice(0, bestCut).join('')}...`;
  }

  /** injection_budget.rs:393. */
  generateInjectionSummary(result: ExactAllocationResult): string {
    let summary = '# 注入预算分配报告\n\n';
    summary += `- 总预算: ${this.config.total_budget} 字符\n`;
    summary += `- 已使用: ${result.total_chars_used} 字符\n`;
    summary += `- 剩余: ${result.budget_remaining} 字符\n`;
    summary += `- 选中项目: ${result.selected_items.length} 个\n`;
    summary += `- 丢弃项目: ${result.items_dropped.length} 个\n\n`;
    summary += '## 按类型分配:\n';
    for (const [type, charsUsed] of result.allocation_stats) {
      const limit = this.config.type_limits.get(type) ?? 1000n;
      const percentage = limit > 0n ? Math.fround(Math.fround(usizeAsF32(charsUsed) / usizeAsF32(limit)) * 100) : 0;
      summary += `- ${INJECTION_TYPE_NAMES[type]}: ${charsUsed} / ${limit} 字符 (${formatPercentage(percentage)}%)\n`;
    }
    if (result.warnings.length > 0) {
      summary += '\n## 警告:\n';
      for (const warning of result.warnings) summary += `- ${warning}\n`;
    }
    return summary;
  }
}

/** Rust usize as f32 rounds once, without an intermediate lossy f64 integer conversion. */
function usizeAsF32(value: bigint): number {
  const bits = value.toString(2).length;
  if (bits <= 24) return Number(value);
  const shift = BigInt(bits - 24);
  let mantissa = value >> shift;
  const remainder = value - (mantissa << shift), half = 1n << (shift - 1n);
  if (remainder > half || (remainder === half && (mantissa & 1n) !== 0n)) mantissa += 1n;
  return Number(mantissa) * 2 ** Number(shift);
}

/** Rust {:.1} is nearest/ties-even, unlike JS toFixed's halfway behavior. */
function formatPercentage(value: number): string {
  const scaled = value * 10, lower = Math.floor(scaled), fraction = scaled - lower;
  const rounded = fraction > 0.5 || (fraction === 0.5 && lower % 2 !== 0) ? lower + 1 : lower;
  const tenths = BigInt(rounded);
  return `${tenths / 10n}.${tenths % 10n}`;
}

/** Published number-valued API; all allocation policy is delegated to the exact owner core. */
export class InjectionBudgetManager extends InjectionBudgetState {
  config: BudgetConfig;
  constructor(config: BudgetConfig) { super(); this.config = config; }
  static withDefaultConfig(): InjectionBudgetManager { return new InjectionBudgetManager(defaultBudgetConfig()); }

  private exact(): ExactInjectionBudgetManager {
    const manager = new ExactInjectionBudgetManager(toExactConfig(this.config));
    manager.pending_items = this.pending_items;
    return manager;
  }

  allocate(): AllocationResult {
    const result = this.exact().allocate();
    return {
      ...result,
      total_chars_used: Number(result.total_chars_used),
      budget_remaining: Number(result.budget_remaining),
      allocation_stats: new Map([...result.allocation_stats].map(([type, count]) => [type, Number(count)])),
    };
  }
  smartTruncate(content: string, maxChars: number): string { return this.exact().smartTruncate(content, BigInt(maxChars)); }
  generateInjectionSummary(result: AllocationResult): string {
    return this.exact().generateInjectionSummary({
      ...result,
      total_chars_used: BigInt(result.total_chars_used), budget_remaining: BigInt(result.budget_remaining),
      allocation_stats: new Map([...result.allocation_stats].map(([type, count]) => [type, BigInt(count)])),
    });
  }
}

import { parseComponentReason, type ParsedComponentReason } from '@/components/system-status/componentReason';
import type { StartupComponentIssue } from '@/stores/systemStatusStore';

/** 恢复页说明的第二句应当描述的情况。 */
export type ComponentRecoveryDescription = 'kept' | 'restored' | 'removed' | 'restore_failed' | 'mixed';

type Outcome = Exclude<ComponentRecoveryDescription, 'mixed'> | 'neutral' | 'other';

const KEPT_IN_PLACE = 'the database file was kept in place at ';

function outcomeOf(parsed: ParsedComponentReason | null): Outcome {
  if (parsed === null) return 'other';
  switch (parsed.kind) {
    case 'dependency_blocked':
    case 'dependency_restore_failed':
      return 'neutral';
    case 'migration_failed':
      return parsed.recovery?.kind ?? 'other';
    case 'remains_blocked':
      return parsed.restoreError.includes(KEPT_IN_PLACE) ? 'kept' : 'restore_failed';
    case 'read_failed':
      return 'kept';
    case 'startup':
      if (parsed.step === 'recovered_old_schema') return 'restored';
      return parsed.step === 'audit_init' ? 'neutral' : 'other';
    case 'unknown':
      return 'other';
  }
}

/**
 * 只有能从原因里确认的结果才写进说明；多种结果并存或认不出时返回 `mixed`，
 * 说明只指向下方逐个组件的原因，不再笼统承诺“数据文件仍在原位置”。
 */
export function describeComponentRecovery(issues: readonly StartupComponentIssue[]): ComponentRecoveryDescription {
  const outcomes = new Set<Outcome>();
  for (const issue of issues) {
    if (issue.status === 'healthy') continue;
    const outcome = outcomeOf(issue.reason ? parseComponentReason(issue.reason) : null);
    if (outcome !== 'neutral') outcomes.add(outcome);
  }
  if (outcomes.size === 0) return 'kept';
  if (outcomes.size > 1) return 'mixed';
  const [only] = outcomes;
  return only === 'other' || only === 'neutral' ? 'mixed' : only;
}

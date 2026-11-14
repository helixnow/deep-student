import type { DatabaseHandle, SqlExecutor, SqlParam } from '../../../platform/storage/api.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { serializeSyncChange } from '../src/change-payload.ts';
import { mergeField, fieldMergeColumnsForTable } from '../src/field-merge.ts';
import { ClockDriftSuspectedError, SyncError } from '../src/errors.ts';
import { syncClassificationRegistry } from '../src/classification.ts';
import { MAX_DRIFT_MS } from '../src/hlc.ts';
import { isJsonFloat, isJsonObject, parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { compareLwwTimestamps, lwwDevicePair, lwwTimestampMillis, timestampValueToLwwString } from '../src/lww.ts';
import { recomputeTodoCompletedPomodorosIfRelevant } from './pomodoro-counts.ts';
import { snapshotRecordWithData } from './history.ts';
import { newBatchId, REASON_POLICY_OVERRIDE } from '../src/history.ts';
import { canonicalizeSyncValueForCompare, getRecordData, recordsSemanticallyEqualForSync, SYNC_FIELD_DELTAS_KEY } from './record-data.ts';
import { saveConflictRecord, ensureConflictTable, resolveOne } from './conflict-resolver.ts';
import {
  buildPrimaryKeyPredicate,
  columnDeclaredType,
  ensureTableAllowedAndExists,
  getTableColumns,
  isLocalDerivedSyncColumn,
  jsonValueToAliasKey,
  jsonValueToSqlParam,
  parseRecordKeyValues,
  pluckSafe,
  primaryKeyColumns,
  quoteIdentifier,
  rowToJson,
  selectWithTypes,
  tableColumnNames,
  tableExists,
  tableHasColumn,
} from './sqlite-values.ts';
import {
  type ApplyChangeFailure,
  type ApplyChangesResult,
  type ApplyContext,
  type NoteHistoryHooks,
  beginApplySavepoint,
  databaseError,
  emptyApplyChangesResult,
  getDefaultNoteHistory,
  keyOf,
  message,
  releaseApplySavepoint,
  rollbackAndReleaseApplySavepoint,
  setDefaultNoteHistory,
  suppressEchoChangeLog,
} from './apply-shared.ts';

export function isIncompleteUpsert(change: EngineChange): boolean {
  return (change.operation === 'Insert' || change.operation === 'Update') && change.data === null;
}

export function orderedChangesForApply(changes: readonly EngineChange[]): EngineChange[] {
  const todoIndexById = new Map<string, number>();
  changes.forEach((change, index) => {
    if (change.table_name === 'todo_items'
      && (change.operation === 'Insert' || change.operation === 'Update')
      && change.data !== null) {
      if (!todoIndexById.has(change.record_id)) todoIndexById.set(change.record_id, index);
    }
  });

  const emitted = new Set<number>();
  const ordered: number[] = [];
  const emit = (index: number, visiting: Set<number>): void => {
    if (emitted.has(index)) return;
    if (visiting.has(index)) return;
    visiting.add(index);
    const change = changes[index] as EngineChange;
    if (change.table_name === 'todo_items'
      && (change.operation === 'Insert' || change.operation === 'Update')
      && change.data !== null
      && typeof change.data === 'object'
      && !Array.isArray(change.data)
      && !isJsonFloat(change.data)) {
      const parentId = change.data.parent_id;
      if (typeof parentId === 'string' && parentId !== '') {
        const parentIndex = todoIndexById.get(parentId);
        if (parentIndex !== undefined && parentIndex !== index) emit(parentIndex, visiting);
      }
    }
    visiting.delete(index);
    if (!emitted.has(index)) {
      emitted.add(index);
      ordered.push(index);
    }
  };
  for (let index = 0; index < changes.length; index += 1) emit(index, new Set<number>());

  const positionByIndex = new Map<number, number>();
  ordered.forEach((index, position) => positionByIndex.set(index, position));
  ordered.sort((left, right) => {
    const leftRank = applyDependencyRank(changes[left] as EngineChange);
    const rightRank = applyDependencyRank(changes[right] as EngineChange);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return (positionByIndex.get(left) ?? left) - (positionByIndex.get(right) ?? right);
  });
  return ordered.map(index => changes[index] as EngineChange);
}

export function applyDependencyRank(change: EngineChange): number {
  const insertRank = (() => {
    switch (change.table_name) {
      case 'resources': return 10;
      case 'blobs': return 20;
      case 'chat_v2_session_groups': return 30;
      case 'chat_v2_sessions': return 35;
      case 'folders':
      case 'todo_lists': return 30;
      case 'mistakes': return 30;
      case 'chat_v2_messages': return 38;
      case 'document_tasks':
      case 'review_sessions':
      case 'review_analyses': return 38;
      case 'notes':
      case 'files':
      case 'exam_sheets':
      case 'translations':
      case 'essays':
      case 'mindmaps':
      case 'todo_items': return 40;
      case 'chat_v2_blocks': return 42;
      case 'note_document_formats': return 43;
      case 'note_document_revisions': return 45;
      case 'qbank_sources': return 44;
      case 'qbank_materials': return 45;
      case 'qbank_groups': return 46;
      case 'qbank_group_materials': return 47;
      case 'qbank_papers': return 48;
      case 'qbank_practice_attempts': return 65;
      case 'note_learning_relations': return 70;
      case 'chat_v2_compactions': return 45;
      case 'questions':
      case 'essay_sessions':
      case 'pomodoro_records': return 50;
      case 'chat_messages':
      case 'review_chat_messages':
      case 'anki_cards':
      case 'review_session_mistakes': return 55;
      case 'chat_v2_attachments': return 55;
      case 'chat_v2_session_mistakes': return 60;
      case 'answer_submissions':
      case 'review_plans':
      case 'folder_items': return 60;
      default: return 100;
    }
  })();
  return change.operation === 'Delete' ? 1000 - insertRank : insertRank;
}

export function shouldSkipShadowedIncompleteUpsert(
  change: EngineChange,
  shadowed: ReadonlySet<string>,
): boolean {
  return isIncompleteUpsert(change) && shadowed.has(keyOf(change.table_name, change.record_id));
}

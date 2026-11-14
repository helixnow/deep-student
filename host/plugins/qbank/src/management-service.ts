/** Command-facing wrapper for qbank_management.rs. */
import { AppError } from '../../../platform/errors/api.ts';
import { f64Atom } from '../../../platform/serde-compat/index.ts';
import type { SourceRef } from '../api.ts';
import { QbankServiceError } from './question-service.ts';
import type { QbankPorts } from './ports.ts';
import {
  ManagementConflict, ManagementNotFound, ManagementValidation, deleteGroup, deleteUnusedMaterials, listStructure, updateGroup,
  type DeleteMode, type GroupDelete, type GroupUpdate, type MaterialDeletion, type MaterialExpectation,
  type Structure,
} from '../repository/management.ts';

export interface ManagementHost extends QbankPorts {
  readonly db: import('../../../platform/storage/api.ts').DatabaseHandle;
}

function invoke<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ManagementConflict) throw new QbankServiceError(AppError.validation(error.message));
    if (error instanceof ManagementNotFound) throw new QbankServiceError(AppError.not_found(error.message));
    if (error instanceof ManagementValidation) throw new QbankServiceError(AppError.validation(error.message));
    if (error instanceof QbankServiceError) throw error;
    throw new QbankServiceError(AppError.database(error instanceof Error ? error.message : String(error)));
  }
}

/** IPC 与工具输出（qbank_executor.rs:5247 `json!(view)`）：`SourceRef.bbox` 是 `[f64; 4]`（qbank_types.rs:16），serde_json 写 `1.0`。 */
function spellBboxes(structure: Structure): Structure {
  const spell = (refs: SourceRef[]): SourceRef[] => refs.map(ref => (ref.bbox == null ? ref
    : { ...ref, bbox: ref.bbox.map(f64Atom) as unknown as SourceRef['bbox'] }));
  return { ...structure, materials: structure.materials.map(material => ({
    ...material, source_refs: spell(material.source_refs) })) };
}

export function getStructure(host: ManagementHost, examId: string): Structure {
  return spellBboxes(invoke(() => listStructure(host.db, examId)));
}

export function updateGroupMembers(host: ManagementHost, groupId: string, label: string,
  questionIds: string[], materialIds: string[], expectedVersion: number): GroupUpdate {
  return invoke(() => updateGroup(host.db, groupId, label, questionIds, materialIds, expectedVersion, host));
}

export function deleteQuestionGroup(host: ManagementHost, groupId: string, mode: DeleteMode,
  expectedVersion: number): GroupDelete {
  return invoke(() => deleteGroup(host.db, groupId, mode, expectedVersion, host));
}

export function deleteUnused(host: ManagementHost, examId: string,
  expected: MaterialExpectation[]): MaterialDeletion {
  return invoke(() => deleteUnusedMaterials(host.db, examId, expected, host));
}

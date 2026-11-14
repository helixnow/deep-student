/**
 * `masteryProfileSink` — Cordis adapter for Rust
 * `dstu-memory/src/memory/mastery_hook.rs`.
 *
 * The review lane owns mastery and calls this sink after a committed mastery
 * transaction. The `conn` parameter belongs to the review database; memory
 * writes its learner profile through its own VFS database (as the Rust
 * `LearnerProfileMasterySink` does with `vfs_db`), so it is deliberately
 * ignored here.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type {
  MasteryProfileSink, MasteryWeakPointEvidence,
} from '../../review/api.ts';

/** Subset of `MemoryServiceImpl` used by the sink. */
export interface MasterySinkTarget {
  upsertWeakPointFromMastery(concept: string, evidence: MasteryWeakPointEvidence): void;
  removeWeakPointFromMastery(concept: string): void;
}

export function createMasteryProfileSink(target: MasterySinkTarget): MasteryProfileSink {
  return {
    upsertWeakPointFromMastery(_conn: SqlExecutor, concept: string,
      evidence: MasteryWeakPointEvidence): void {
      target.upsertWeakPointFromMastery(concept, evidence);
    },
    removeWeakPointFromMastery(_conn: SqlExecutor, concept: string): void {
      target.removeWeakPointFromMastery(concept);
    },
  };
}

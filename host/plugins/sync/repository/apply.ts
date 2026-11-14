/** Downloaded-change engine: public exports for the split apply implementations.
 * Batch IMMEDIATE transactions, per-row SAVEPOINTs, quarantine and derived counts
 * retain the mod.rs apply semantics. Note hooks resolve the published notes service.
 */
export * from './apply-shared.ts';
export * from './apply-record.ts';
export * from './apply-order.ts';
export * from './apply-quarantine.ts';
export * from './apply-fk.ts';
export * from './apply-refcounts.ts';
export * from './apply-id-aliases.ts';
export * from './apply-batch.ts';
export * from './apply-force.ts';
export * from './apply-guard.ts';
export { ensureConflictTable } from './conflict-resolver.ts';

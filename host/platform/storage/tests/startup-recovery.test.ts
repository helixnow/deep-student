import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { prepareStartupRecovery, StartupRecoveryState, incidentDir } from '../startup-recovery.ts';
let base: string;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-recover-')); });
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });
function db(file: string, marker: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); const connection = new Database(file);
  try { connection.exec('CREATE TABLE recovery_marker (value TEXT NOT NULL)'); connection.prepare('INSERT INTO recovery_marker VALUES (?)').run(marker); } finally { connection.close(); }
}
function marker(file: string): string {
  const connection = new Database(file, { readonly: true });
  try { return connection.prepare('SELECT value FROM recovery_marker LIMIT 1').pluck().get() as string; } finally { connection.close(); }
}
function conflict() { db(path.join(base, 'slots/slotB/chat_v2.db'), 'slot-b'); db(path.join(base, 'mistakes.db'), 'legacy'); }
it('startup_recovery_detects_conflict_and_quarantines_legacy_root', () => {
  conflict(); const incident = prepareStartupRecovery(base)!; expect(incident).not.toBeNull(); const dir = incidentDir(base, incident.incident_id);
  expect(fs.existsSync(path.join(base, 'mistakes.db'))).toBe(false); expect(marker(path.join(dir, 'legacy-root/mistakes.db'))).toBe('legacy');
  const legacy = incident.candidates.find(c => c.id === 'legacy')!;
  expect(legacy.has_data).toBe(true); expect(legacy.has_database).toBe(true); expect(legacy.selectable).toBe(true);
  expect(legacy.core_database_filenames).toEqual(['mistakes.db']); expect(legacy.valid_core_database_filenames).toEqual(['mistakes.db']);
  expect(fs.statSync(path.join(dir, 'manifest.json')).isFile()).toBe(true); expect(fs.statSync(path.join(dir, 'journal.json')).isFile()).toBe(true);
});
it('startup_recovery_can_select_existing_slot_without_merging_legacy', () => {
  conflict(); const incident = prepareStartupRecovery(base)!; const state = new StartupRecoveryState(base, incident);
  const response = state.resolve('slotB'); expect(response.resolved).toBe(true); expect(response.restart_required).toBe(true); expect(response.selected_candidate).toBe('slotB');
  const selected = JSON.parse(fs.readFileSync(path.join(base, 'slots/state.json'), 'utf8'));
  expect(selected.active).toBe('slotB'); expect(selected.pending).toBeNull(); expect(selected.restore_cutover_pending).toBeUndefined();
  expect(fs.statSync(path.join(base, 'slots/.legacy_migration_complete')).isFile()).toBe(true);
  expect(fs.statSync(path.join(incidentDir(base, incident.incident_id), 'legacy-root/mistakes.db')).isFile()).toBe(true);
  const history = state.incidents(); expect(history).toHaveLength(1); expect(history[0]!.resolved).toBe(true); expect(history[0]!.selected_candidate).toBe('slotB');
});
it('startup_recovery_can_restore_legacy_and_archive_slot_a', () => {
  db(path.join(base, 'slots/slotA/llm_usage.db'), 'slot-a-old'); db(path.join(base, 'slots/slotB/chat_v2.db'), 'slot-b'); db(path.join(base, 'mistakes.db'), 'legacy-selected');
  const incident = prepareStartupRecovery(base)!; new StartupRecoveryState(base, incident).resolve('legacy');
  expect(marker(path.join(base, 'slots/slotA/mistakes.db'))).toBe('legacy-selected');
  expect(marker(path.join(incidentDir(base, incident.incident_id), 'slotA-before-legacy/llm_usage.db'))).toBe('slot-a-old');
  expect(marker(path.join(base, 'slots/slotB/chat_v2.db'))).toBe('slot-b');
  expect(JSON.parse(fs.readFileSync(path.join(base, 'slots/state.json'), 'utf8')).active).toBe('slotA');
});
it('startup_recovery_reinspection_is_idempotent', () => {
  conflict(); const first = prepareStartupRecovery(base)!, second = prepareStartupRecovery(base)!;
  expect(first.incident_id).toBe(second.incident_id); expect(marker(path.join(incidentDir(base, second.incident_id), 'legacy-root/mistakes.db'))).toBe('legacy');
  expect(fs.existsSync(path.join(base, 'mistakes.db'))).toBe(false);
  second.selected_candidate = 'slotB'; fs.writeFileSync(path.join(incidentDir(base, second.incident_id), 'manifest.json'), JSON.stringify(second));
  expect(prepareStartupRecovery(base)).toBeNull(); expect(JSON.parse(fs.readFileSync(path.join(base, 'slots/state.json'), 'utf8')).active).toBe('slotB');
});
it('startup_recovery_rejects_candidates_without_known_core_databases', () => {
  fs.mkdirSync(path.join(base, 'slots/slotB'), { recursive: true }); fs.writeFileSync(path.join(base, 'slots/slotB/cache.db'), 'not-core'); fs.writeFileSync(path.join(base, 'unrelated.db'), 'not-core');
  const incident = prepareStartupRecovery(base)!; expect(incident.candidates.every(c => !c.selectable)).toBe(true);
  const state = new StartupRecoveryState(base, incident); expect(() => state.resolve('slotB')).toThrow('核心数据库'); expect(state.status().incident?.recovery_error).toBeDefined();
});
it('startup_recovery_resolution_error_remains_visible_and_retryable', () => {
  fs.mkdirSync(path.join(base, 'slots/slotB'), { recursive: true }); const selected = path.join(base, 'slots/slotB/chat_v2.db');
  fs.writeFileSync(selected, 'slot-b'); db(path.join(base, 'mistakes.db'), 'legacy');
  const incident = prepareStartupRecovery(base)!; fs.unlinkSync(selected); const state = new StartupRecoveryState(base, incident);
  expect(() => state.resolve('slotB')).toThrow(); expect(state.status().recovery_required).toBe(true);
  expect(state.status().incident?.failed_operation).toBe('resolve_selection'); expect(state.status().incident?.recovery_error).toBeDefined();
});
it('startup_recovery_can_expose_an_ephemeral_preflight_failure', () => {
  const state = StartupRecoveryState.failed(base, 'startup_preflight', 'synthetic failure');
  expect(state.status().recovery_required).toBe(true); expect(state.status().incident?.failed_operation).toBe('startup_preflight');
  expect(state.status().incident?.recovery_error).toBe('synthetic failure');
});

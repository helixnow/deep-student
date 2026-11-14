/** Startup timeline conflict journal, data_space.rs:97-994. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StartupRecoveryCandidate, StartupRecoveryIncident, StartupRecoveryResolveResponse, StartupRecoveryStatus } from '../../../contracts/ipc/generated/F3-storage.ts';
import { DataSpace, dirHasData, isLegacyRootEntry } from './locations.ts';
import { atomicWriteBytes, atomicWriteJson, errorText, isDirectory, isFile, movePathPreserving, readJson, removeFileIfExists, syncDirectory, timestampCompact, utcNow } from './data-space-files.ts';
import { storageLog } from './logging.ts';
import { isValidSqliteDatabase } from './repository/data-space.ts';
import { rfc3339FromDate } from './time.ts';
import { decodeUtf8Strict, utf8ErrorMessage } from '../util/portable.ts';

const LOG_TARGET = 'dstu_storage::data_space';

interface RecoveryJournal { quarantined: string[]; restored_to_slot_a: string[]; slot_a_archived: boolean }
export function incidentDir(base: string, id: string): string { return path.join(base, 'recovery/incidents', id); }
function manifestPath(base: string, id: string): string { return path.join(incidentDir(base, id), 'manifest.json'); }
function pointerPath(base: string): string { return path.join(base, 'recovery/current-startup-incident.json'); }
function requiresRestart(operation: string): boolean { return ['data_space_init', 'active_data_directory', 'startup_cleanup', 'startup_cleanup_marker'].includes(operation); }
function failureIncident(operation: string, error: unknown): StartupRecoveryIncident {
  return { incident_id: `startup-preflight-${randomUUID()}`, created_at: utcNow(), resolved: false, recovery_error: errorText(error), failed_operation: operation, retry_requires_restart: requiresRestart(operation), candidates: [], legacy_entries: [] };
}
export class StartupRecoveryState {
  readonly baseDir: string;
  private incident: StartupRecoveryIncident | null;
  constructor(baseDir: string, incident: StartupRecoveryIncident | null) { this.baseDir = baseDir; this.incident = incident; }
  static failed(base: string, operation: string, error: unknown): StartupRecoveryState { return new StartupRecoveryState(base, failureIncident(operation, error)); }
  setFailure(operation: string, error: unknown): void { this.incident = failureIncident(operation, error); }
  status(): StartupRecoveryStatus { return { recovery_required: this.incident !== null && !this.incident.resolved, ...(this.incident ? { incident: structuredClone(this.incident) } : {}) }; }
  incidents(): StartupRecoveryIncident[] {
    const root = path.join(this.baseDir, 'recovery/incidents'); if (!isDirectory(root)) return [];
    const results: StartupRecoveryIncident[] = [];
    for (const name of fs.readdirSync(root)) {
      if (!isDirectory(path.join(root, name))) continue;
      const file = manifestPath(this.baseDir, name); if (!isFile(file)) continue;
      try { results.push(readIncident(file)); }
      catch (error) { storageLog(LOG_TARGET, 'warn', `[DataSpace] 跳过无法读取的恢复事件 ${file}: ${errorText(error)}`); }
    }
    return results.sort((a, b) => a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0);
  }
  resolve(candidateId: string): StartupRecoveryResolveResponse {
    if (!this.incident) throw new Error('当前没有待处理的启动恢复事件');
    let response: StartupRecoveryResolveResponse;
    try { response = resolveIncident(this.baseDir, this.incident, candidateId); }
    catch (error) { recordError(this.baseDir, this.incident, 'resolve_selection', error); throw error; }
    this.incident = null; return response;
  }
  retryPreflight(): StartupRecoveryStatus {
    if (this.incident?.failed_operation && requiresRestart(this.incident.failed_operation)) return this.status();
    try { this.incident = prepareStartupRecovery(this.baseDir); }
    catch (error) { this.incident = failureIncident('startup_preflight', error); }
    return this.status();
  }
  incidentDirectory(id: string): string {
    if (!id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') throw new Error('恢复事件 id 无效');
    const root = path.join(this.baseDir, 'recovery/incidents'), candidate = path.join(root, id);
    if (!isDirectory(candidate)) throw new Error('恢复事件目录不存在');
    const canonicalRoot = fs.realpathSync(root), canonical = fs.realpathSync(candidate), relative = path.relative(canonicalRoot, canonical);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('恢复事件目录越界');
    return canonical;
  }
}
function readIncident(file: string): StartupRecoveryIncident {
  const value = readJson<StartupRecoveryIncident>(file, '启动恢复事件清单');
  if (typeof value.incident_id !== 'string' || typeof value.created_at !== 'string' || typeof value.resolved !== 'boolean' || !Array.isArray(value.candidates)) throw new Error('解析启动恢复事件清单失败: 缺少必填字段');
  value.retry_requires_restart ??= false; value.legacy_entries ??= [];
  for (const c of value.candidates) { c.core_database_filenames ??= []; c.valid_core_database_filenames ??= []; c.selectable ??= false; }
  return value;
}
function readJournal(file: string): RecoveryJournal {
  if (fs.existsSync(file)) {
    const j = readJson<Partial<RecoveryJournal>>(file, '启动恢复操作日志');
    return { quarantined: j.quarantined ?? [], restored_to_slot_a: j.restored_to_slot_a ?? [], slot_a_archived: j.slot_a_archived ?? false };
  }
  const j = { quarantined: [], restored_to_slot_a: [], slot_a_archived: false }; atomicWriteJson(file, j); return j;
}
function recordError(base: string, incident: StartupRecoveryIncident, operation: string, error: unknown): void {
  incident.recovery_error = errorText(error); incident.failed_operation = operation; incident.retry_requires_restart = requiresRestart(operation);
  const file = manifestPath(base, incident.incident_id);
  if (isDirectory(path.dirname(file))) {
    try { atomicWriteJson(file, incident); }
    catch (writeError) { storageLog(LOG_TARGET, 'warn', `[DataSpace] 无法持久化恢复错误 ${file}: ${errorText(writeError)}`); }
  }
}
function legacyRootEntryNames(base: string): string[] {
  if (!isDirectory(base)) return [];
  const names: string[] = [];
  for (const bytes of fs.readdirSync(base, { encoding: 'buffer' })) {
    if (utf8ErrorMessage(bytes) !== null) throw new Error('旧版数据根目录包含非 UTF-8 文件名，无法建立恢复清单');
    const name = decodeUtf8Strict(bytes);
    // 平台安全工件由 F4 secrets 在 Host 插件装配期创建；Rust 的
    // `prepare_startup_recovery`（lib.rs:933）早于 `SecureStore::new_with_dir`，预检时
    // 这些路径还不存在。它们不属于数据时间线，不能触发恢复事件。
    if (isLegacyRootEntry(name)) names.push(name);
  }
  return names.sort();
}
export function prepareStartupRecovery(base: string): StartupRecoveryIncident | null {
  const pointer = pointerPath(base), recovery = path.join(base, 'recovery');
  if (fs.existsSync(pointer)) {
    const p = readJson<{ incident_id: string }>(pointer, '启动恢复 current pointer');
    if (typeof p.incident_id !== 'string') throw new Error('解析启动恢复 current pointer失败: missing field `incident_id`');
    const incident = readIncident(manifestPath(base, p.incident_id));
    if (incident.incident_id !== p.incident_id) throw new Error('启动恢复 current pointer 与事件清单不匹配');
    if (incident.resolved) { removeFileIfExists(pointer); syncDirectory(recovery); return null; }
    try { quarantineLegacyEntries(base, incident); } catch (error) { recordError(base, incident, 'quarantine_legacy', error); return incident; }
    if (incident.selected_candidate != null) {
      try { resolveIncident(base, incident, incident.selected_candidate); return null; } catch (error) { recordError(base, incident, 'resume_selection', error); }
    }
    return incident;
  }
  if (fs.existsSync(path.join(base, 'slots/.legacy_migration_complete')) || fs.existsSync(path.join(base, 'slots/.legacy_migration_pending'))) return null;
  const entries = legacyRootEntryNames(base); if (!entries.length) return null;
  const space = new DataSpace(base);
  if (!dirHasData(space.slotDir('slotB')) && !entries.some(name => fs.existsSync(path.join(space.slotDir('slotA'), name)))) return null;
  const incidents = path.join(recovery, 'incidents'); fs.mkdirSync(incidents, { recursive: true }); syncDirectory(recovery);
  const compact = timestampCompact(); const id = `${compact.slice(0, 8)}T${compact.slice(8)}Z-${randomUUID()}`;
  const directory = incidentDir(base, id); fs.mkdirSync(directory); fs.mkdirSync(path.join(directory, 'legacy-root')); syncDirectory(incidents);
  const incident: StartupRecoveryIncident = { incident_id: id, created_at: utcNow(), resolved: false, retry_requires_restart: false, candidates: inspectStartupCandidates(base, id), legacy_entries: entries };
  atomicWriteJson(manifestPath(base, id), incident); atomicWriteJson(path.join(directory, 'journal.json'), { quarantined: [], restored_to_slot_a: [], slot_a_archived: false });
  atomicWriteJson(pointer, { incident_id: id });
  try { quarantineLegacyEntries(base, incident); } catch (error) { recordError(base, incident, 'quarantine_legacy', error); }
  return incident;
}
function quarantineLegacyEntries(base: string, incident: StartupRecoveryIncident): void {
  const directory = incidentDir(base, incident.incident_id), legacy = path.join(directory, 'legacy-root'); fs.mkdirSync(legacy, { recursive: true });
  const file = path.join(directory, 'journal.json'), j = readJournal(file);
  for (const name of incident.legacy_entries) {
    if (j.quarantined.includes(name)) continue;
    movePathPreserving(path.join(base, name), path.join(legacy, name)); j.quarantined.push(name); j.quarantined.sort(); atomicWriteJson(file, j);
  }
  incident.candidates = inspectStartupCandidates(base, incident.incident_id); atomicWriteJson(manifestPath(base, incident.incident_id), incident);
}
function inspectStartupCandidates(base: string, id: string): StartupRecoveryCandidate[] {
  const candidates = [inspectCandidate('legacy', path.join(incidentDir(base, id), 'legacy-root')), inspectCandidate('slotA', path.join(base, 'slots/slotA')), inspectCandidate('slotB', path.join(base, 'slots/slotB'))];
  let active: unknown;
  try { const state = JSON.parse(fs.readFileSync(path.join(base, 'slots/state.json'), 'utf8')); active = state.active; } catch { active = undefined; }
  let recommended = candidates.find(c => c.id === active && c.selectable);
  let reason = 'state.json 中记录的活动插槽有效';
  if (!recommended) { const valid = candidates.filter(c => c.selectable); if (valid.length === 1) { recommended = valid[0]; reason = '仅此候选检测到受支持的核心数据库'; } }
  for (const c of candidates) {
    c.recommended = recommended?.id === c.id;
    c.recommendation_reason = recommended ? c.recommended ? reason : `推荐候选为 ${recommended.id}` : '候选时间线存在歧义，需要人工选择';
  }
  return candidates;
}
function inspectCandidate(id: string, root: string): StartupRecoveryCandidate {
  let size = 0, latest: number | null = null; const databases: string[] = [];
  function walk(dir: string) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name), meta = fs.lstatSync(file); if (meta.isSymbolicLink()) continue;
      latest = latest === null ? meta.mtimeMs : Math.max(latest, meta.mtimeMs);
      if (meta.isDirectory()) walk(file); else if (meta.isFile()) { size += meta.size; if (/\.(db|sqlite|sqlite3)$/.test(name.toLowerCase())) databases.push(path.relative(root, file)); }
    }
  }
  if (isDirectory(root)) walk(root); databases.sort();
  const core = databases.filter(name => ['mistakes.db', 'chat_v2.db', 'llm_usage.db', 'databases/vfs.db'].includes(name.replaceAll('\\', '/').toLowerCase()));
  const valid = core.filter(name => isValidSqliteDatabase(path.join(root, name))), selectable = valid.length > 0;
  return { id, exists: fs.existsSync(root), has_data: dirHasData(root), has_database: databases.length > 0, size_bytes: size,
    latest_modified: latest === null ? null : rfc3339FromDate(new Date(latest)), database_filenames: databases,
    core_database_filenames: core, valid_core_database_filenames: valid, selectable,
    ...(!selectable ? { selection_block_reason: '未检测到 Deep Student 核心数据库' } : {}), recommended: false, recommendation_reason: '' };
}
function finishLegacyMigration(base: string): void {
  const slots = path.join(base, 'slots'); fs.mkdirSync(slots, { recursive: true }); atomicWriteBytes(path.join(slots, '.legacy_migration_complete'), '1');
  removeFileIfExists(path.join(slots, '.legacy_migration_pending')); syncDirectory(slots);
}
function resolveIncident(base: string, incident: StartupRecoveryIncident, candidateId: string): StartupRecoveryResolveResponse {
  if (incident.resolved) throw new Error('启动恢复事件已经解决');
  if (!['legacy', 'slotA', 'slotB'].includes(candidateId)) throw new Error('候选 id 必须是 legacy、slotA 或 slotB');
  if (incident.selected_candidate != null && incident.selected_candidate !== candidateId) throw new Error(`恢复事件已开始选择 ${incident.selected_candidate}，不能改选 ${candidateId}`);
  incident.candidates = inspectStartupCandidates(base, incident.incident_id); delete incident.recovery_error; delete incident.failed_operation; incident.retry_requires_restart = false;
  if (incident.selected_candidate == null) {
    const selected = incident.candidates.find(c => c.id === candidateId); if (!selected) throw new Error('恢复候选不存在');
    if (!selected.selectable) throw new Error(`恢复候选 ${candidateId} 不包含受支持的核心数据库，拒绝将其激活`);
    incident.selected_candidate = candidateId; atomicWriteJson(manifestPath(base, incident.incident_id), incident);
  }
  const space = new DataSpace(base); fs.mkdirSync(space.slotsDir, { recursive: true });
  if (candidateId === 'legacy') {
    const directory = incidentDir(base, incident.incident_id), file = path.join(directory, 'journal.json'), j = readJournal(file), slotA = space.slotDir('slotA');
    if (!j.slot_a_archived) {
      if (fs.existsSync(slotA)) movePathPreserving(slotA, path.join(directory, 'slotA-before-legacy'));
      j.slot_a_archived = true; atomicWriteJson(file, j);
    }
    fs.mkdirSync(slotA, { recursive: true }); syncDirectory(space.slotsDir);
    for (const name of incident.legacy_entries) {
      if (j.restored_to_slot_a.includes(name)) continue;
      movePathPreserving(path.join(directory, 'legacy-root', name), path.join(slotA, name));
      j.restored_to_slot_a.push(name); j.restored_to_slot_a.sort(); atomicWriteJson(file, j);
    }
  }
  space.writeState({ active: candidateId === 'legacy' ? 'slotA' : candidateId, pending: null }); finishLegacyMigration(base);
  incident.resolved = true; incident.resolved_at = utcNow(); atomicWriteJson(manifestPath(base, incident.incident_id), incident);
  removeFileIfExists(pointerPath(base)); syncDirectory(path.join(base, 'recovery'));
  return { resolved: true, restart_required: true, selected_candidate: candidateId, incident_id: incident.incident_id };
}

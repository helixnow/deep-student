/** types.rs:1196-1248: typed SessionSkillState serde and its legacy projections. */
import { isJsonObject, parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import type { SessionState } from '../api.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

const vectorKeys = ['manualPinnedSkillIds', 'modeRequiredBundleIds', 'agenticSessionSkillIds',
  'branchLocalSkillIds', 'effectiveAllowedExternalServers'] as const;
export interface SkillState {
  manualPinnedSkillIds: string[];
  modeRequiredBundleIds: string[];
  agenticSessionSkillIds: string[];
  branchLocalSkillIds: string[];
  effectiveAllowedExternalServers: string[];
  version: number | bigint;
  legacyMigrated?: boolean;
}
const U64_MAX = 18446744073709551615n;

export function incrementSkillVersion(version: number | bigint): number | bigint {
  const next = BigInt(version) < U64_MAX ? BigInt(version) + 1n : U64_MAX;
  return next <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(next) : next;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}
export function parseSkillIds(raw: string | null | undefined): string[] {
  if (raw == null) return [];
  try { const value: unknown = JSON.parse(raw); return strings(value) ? value : []; }
  catch { return []; }
}
export function parseSkillState(raw: string | null | undefined): SkillState | undefined {
  if (raw == null) return undefined;
  let value: DbJson;
  try { value = parseJsonLossless(raw); } catch { return undefined; }
  if (!isJsonObject(value)) return undefined;
  const result: SkillState = { manualPinnedSkillIds: [], modeRequiredBundleIds: [], agenticSessionSkillIds: [],
    branchLocalSkillIds: [], effectiveAllowedExternalServers: [], version: 0 };
  for (const key of vectorKeys) {
    const field = value[key];
    if (field === undefined) continue;
    if (!strings(field)) return undefined;
    result[key] = field;
  }
  const version = value.version;
  if (version !== undefined) {
    if (typeof version === 'bigint') {
      if (version < 0n || version > U64_MAX) return undefined;
    } else if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) return undefined;
    result.version = version;
  }
  if (value.legacyMigrated != null) {
    if (typeof value.legacyMigrated !== 'boolean') return undefined;
    result.legacyMigrated = value.legacyMigrated;
  }
  return result;
}
export function resolveSkillState(state: SessionState): SkillState {
  return parseSkillState(state.skillStateJson) ?? {
    manualPinnedSkillIds: parseSkillIds(state.activeSkillIdsJson), modeRequiredBundleIds: [],
    agenticSessionSkillIds: parseSkillIds(state.loadedSkillIdsJson), branchLocalSkillIds: [],
    effectiveAllowedExternalServers: [], version: 0, legacyMigrated: true,
  };
}
export function serializeSkillState(state: SkillState): string {
  const value: Record<string, DbJson> = {};
  for (const key of vectorKeys) if (state[key].length > 0) value[key] = state[key];
  value.version = state.version;
  if (state.legacyMigrated !== undefined) value.legacyMigrated = state.legacyMigrated;
  return stringifyJsonLossless(value);
}
export function sortedSkillIds(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => compareUtf8(a, b));
}

/** SessionState::set_skill_state keeps the legacy columns as sorted projections. */
export function applySkillState(state: SessionState, skillState: SkillState): void {
  state.skillStateJson = serializeSkillState(skillState);
  const activeIds = sortedSkillIds(skillState.manualPinnedSkillIds);
  state.activeSkillIdsJson = activeIds.length === 0 ? undefined : JSON.stringify(activeIds);
  const loadedIds = sortedSkillIds([...skillState.agenticSessionSkillIds,
    ...skillState.branchLocalSkillIds, ...skillState.modeRequiredBundleIds]);
  state.loadedSkillIdsJson = loadedIds.length === 0 ? undefined : JSON.stringify(loadedIds);
}

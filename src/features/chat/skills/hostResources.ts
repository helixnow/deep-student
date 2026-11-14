/** Host-shipped builtin skills: discover metadata now, read their single resource on activation. */
import { parseSkillFile } from './parser';
import { skillRegistry } from './registry';
import type { SkillDefinition } from './types';

export interface HostSkillResource { id: string; markdown: string; schemaToolIds: string[] }
interface Source {
  skill: SkillDefinition;
  schemaToolIds: string[];
  read: () => Promise<HostSkillResource>;
  loaded: boolean;
}
const sources = new Map<string, Source>();

function parse(resource: HostSkillResource): SkillDefinition {
  const result = parseSkillFile(resource.markdown, `builtin://${resource.id}`, resource.id, 'builtin');
  if (!result.skill) throw new Error(result.error ?? `Invalid Host skill: ${resource.id}`);
  return { ...result.skill, isBuiltin: true };
}

export function registerHostSkill(resource: HostSkillResource, read: () => Promise<HostSkillResource>): () => void {
  const source = { skill: parse(resource), schemaToolIds: resource.schemaToolIds, read, loaded: false };
  sources.set(resource.id, source);
  skillRegistry.register(source.skill);
  return () => {
    if (sources.get(resource.id) !== source) return;
    sources.delete(resource.id);
    if (skillRegistry.get(resource.id) === source.skill) skillRegistry.unregister(resource.id);
  };
}

export function restoreHostSkillSummaries(): void {
  for (const source of sources.values()) skillRegistry.register(source.skill);
}

export async function ensureHostSkillContent(id: string): Promise<void> {
  const source = sources.get(id);
  if (!source || source.loaded) return;
  const resource = await source.read();
  if (sources.get(id) !== source) return;
  if (resource.id !== id) throw new Error(`Host skill id mismatch: ${id}`);
  source.skill = parse(resource);
  source.loaded = true;
  skillRegistry.register(source.skill);
}

export function hostSkillSchemaToolIds(activeIds: readonly string[]): string[] {
  return [...new Set(activeIds.flatMap(id => sources.get(id)?.schemaToolIds ?? []))];
}

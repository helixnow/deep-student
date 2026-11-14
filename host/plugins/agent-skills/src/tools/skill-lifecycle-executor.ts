/**
 * Skill lifecycle governance tools, ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/tools/skill_lifecycle_executor.rs`.
 *
 * `skill_set_enabled` and trust grant/revoke are delegated to the front end
 * through the lifecycle bridge; `skill_remove` is a high-risk direct delete.
 * This module owns the shared validation and sensitivity contract.
 */
import { isPortableSkillPathComponent } from '../skill-package.ts';

export const SKILL_SET_ENABLED = 'skill_set_enabled';
export const SKILL_REMOVE = 'skill_remove';
export const SKILL_TRUST_REQUEST = 'skill_trust_request';

export const BRIDGE_REQUEST_EVENT = 'skill-lifecycle-bridge-request';
export const BRIDGE_RESPONSE_PREFIX = 'skill-lifecycle-bridge-response:';
export const BRIDGE_TIMEOUT_MS = 10_000;
export const PROVENANCE_SETTINGS_PREFIX = 'skill.provenance.';

export interface SkillDescription {
  found: boolean;
  isBuiltin: boolean;
  disabled: boolean;
  trustStatus?: string;
  packageRoot?: string;
  name?: string;
}

export function skillDescriptionFromValue(value: unknown): SkillDescription {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return {
    found: record.found === true,
    isBuiltin: record.isBuiltin === true,
    disabled: record.disabled === true,
    ...(typeof record.trustStatus === 'string' ? { trustStatus: record.trustStatus } : {}),
    ...(typeof record.packageRoot === 'string' ? { packageRoot: record.packageRoot } : {}),
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
  };
}

export function stripNamespace(toolName: string): string {
  if (toolName.startsWith('builtin-')) return toolName.slice(8);
  if (toolName.startsWith('mcp_')) return toolName.slice(4);
  return toolName;
}

export function validateSkillId(skillId: string): string {
  const trimmed = skillId.trim();
  if (trimmed === '') throw new Error('skill_id must not be empty');
  if (!/^[\p{L}\p{N}_-]+$/u.test(trimmed) || !isPortableSkillPathComponent(trimmed)) {
    throw new Error(
      'skill_id must be a portable directory name containing only letters, numbers, '
      + 'hyphens, and underscores',
    );
  }
  return trimmed;
}

export function requiredSkillId(args: unknown): string {
  const record = typeof args === 'object' && args !== null && !Array.isArray(args)
    ? args as Record<string, unknown> : {};
  const raw = record.skill_id ?? record.skillId;
  if (typeof raw !== 'string') throw new Error('skill_id is required');
  return validateSkillId(raw);
}

export function normalizeLifecycleSha256(raw: string, field: string): string {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length !== 64 || !/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${field} must be a 64-character SHA-256 hex digest`);
  }
  return normalized;
}

export function lifecycleRiskRank(level: string): number {
  const normalized = level.toLowerCase();
  if (normalized === 'high') return 3;
  if (normalized === 'medium') return 2;
  return 1;
}

export class SkillLifecycleExecutor {
  static stripNamespace(toolName: string): string { return stripNamespace(toolName); }
  static validateSkillId(skillId: string): string { return validateSkillId(skillId); }
  static requiredSkillId(args: unknown): string { return requiredSkillId(args); }
  static normalizeSha256(raw: string, field: string): string {
    return normalizeLifecycleSha256(raw, field);
  }
  static riskRank(level: string): number { return lifecycleRiskRank(level); }

  canHandle(toolName: string): boolean {
    const stripped = stripNamespace(toolName);
    return stripped === SKILL_SET_ENABLED
      || stripped === SKILL_REMOVE
      || stripped === SKILL_TRUST_REQUEST;
  }

  sensitivityLevel(toolName: string): 'low' | 'medium' | 'high' {
    const stripped = stripNamespace(toolName);
    if (stripped === SKILL_REMOVE || stripped === SKILL_TRUST_REQUEST) return 'high';
    if (stripped === SKILL_SET_ENABLED) return 'medium';
    return 'low';
  }

  sensitivityLevelForCall(toolName: string, argumentsValue: unknown): 'low' | 'medium' | 'high' {
    if (stripNamespace(toolName) === SKILL_TRUST_REQUEST
      && typeof argumentsValue === 'object' && argumentsValue !== null
      && (argumentsValue as Record<string, unknown>).action === 'inspect') return 'low';
    return this.sensitivityLevel(toolName);
  }

  hasDynamicSensitivity(toolName: string): boolean {
    return stripNamespace(toolName) === SKILL_TRUST_REQUEST;
  }

  name(): string { return 'SkillLifecycleExecutor'; }
}

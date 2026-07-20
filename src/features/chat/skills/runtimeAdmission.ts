/**
 * Skill runtime admission policy.
 *
 * Keep this module independent from the registry so prompt generation, manual
 * activation, load_skills, and request serialization can share one fail-closed
 * decision without creating a registry <-> trust-storage import cycle.
 */

import type { SkillDefinition } from './types';
import { isSkillDisabled } from './skillEnableStorage';
import { getRequiresGate } from './requiresGating';
import { resolveEffectiveTrustStatus } from './skillTrustStorage';

export type SkillRuntimeAdmissionCode =
  | 'untrusted'
  | 'disabled'
  | 'requires_unsatisfied'
  | 'dependency_unavailable';

export interface SkillRuntimeAdmission {
  allowed: boolean;
  code?: SkillRuntimeAdmissionCode;
  /**
   * Stable, locale-neutral interpolation values for user-facing clients.
   * `message` remains an English technical diagnostic for logs/model paths.
   */
  params?: Record<string, string>;
  message?: string;
}

function formatMissingRequires(skillId: string): string {
  const gate = getRequiresGate(skillId);
  const missing = [
    ...(gate?.missingBins ?? []).map((name) => `missing command ${name}`),
    ...(gate?.missingEnv ?? []).map((name) => `missing environment variable ${name}`),
  ];
  return missing.length > 0 ? missing.join(', ') : 'runtime requirements are not satisfied';
}

/** Whether any model-facing metadata for this skill may be disclosed. */
export function isSkillPromptVisible(skill: SkillDefinition): boolean {
  return resolveEffectiveTrustStatus(skill) !== 'untrusted' && !isSkillDisabled(skill.id);
}

/** Full runtime admission used by every frontend skill-load entry point. */
export function getSkillRuntimeAdmission(skill: SkillDefinition): SkillRuntimeAdmission {
  if (resolveEffectiveTrustStatus(skill) === 'untrusted') {
    return {
      allowed: false,
      code: 'untrusted',
      params: { skillId: skill.id },
      message: `Skill "${skill.id}" is untrusted and cannot be loaded`,
    };
  }

  if (isSkillDisabled(skill.id)) {
    return {
      allowed: false,
      code: 'disabled',
      params: { skillId: skill.id },
      message: `Skill "${skill.id}" is disabled and cannot be loaded`,
    };
  }

  const gate = getRequiresGate(skill.id);
  if (gate && !gate.satisfied) {
    return {
      allowed: false,
      code: 'requires_unsatisfied',
      params: {
        skillId: skill.id,
        missingBins: gate.missingBins.join(', ') || '-',
        missingEnv: gate.missingEnv.join(', ') || '-',
      },
      message: `Skill "${skill.id}" cannot be loaded: ${formatMissingRequires(skill.id)}`,
    };
  }

  return { allowed: true };
}

/**
 * Runtime admission including the complete dependency graph.
 *
 * The resolver is injected to keep this module independent from the registry
 * and avoid reintroducing the registry/trust-storage import cycle.
 */
export function getSkillRuntimeAdmissionWithDependencies(
  skill: SkillDefinition,
  resolveDependency: (skillId: string) => SkillDefinition | undefined,
  path: string[] = [],
): SkillRuntimeAdmission {
  const direct = getSkillRuntimeAdmission(skill);
  if (!direct.allowed) return direct;
  if (path.includes(skill.id)) {
    return {
      allowed: false,
      code: 'dependency_unavailable',
      params: {
        skillId: skill.id,
        dependencyId: skill.id,
        reason: 'circular',
      },
      message: `Skill "${skill.id}" cannot be loaded because its dependency graph is circular`,
    };
  }

  for (const dependencyId of skill.dependencies ?? []) {
    const dependency = resolveDependency(dependencyId);
    if (!dependency) {
      return {
        allowed: false,
        code: 'dependency_unavailable',
        params: {
          skillId: skill.id,
          dependencyId,
          reason: 'missing',
        },
        message: `Skill "${skill.id}" cannot be loaded because dependency "${dependencyId}" is missing`,
      };
    }
    const dependencyAdmission = getSkillRuntimeAdmissionWithDependencies(
      dependency,
      resolveDependency,
      [...path, skill.id],
    );
    if (!dependencyAdmission.allowed) {
      return {
        allowed: false,
        code: 'dependency_unavailable',
        params: {
          skillId: skill.id,
          dependencyId,
          reason: dependencyAdmission.code ?? 'unavailable',
        },
        message: `Skill "${skill.id}" cannot be loaded because dependency "${dependencyId}" is unavailable: ${dependencyAdmission.message}`,
      };
    }
  }

  return { allowed: true };
}

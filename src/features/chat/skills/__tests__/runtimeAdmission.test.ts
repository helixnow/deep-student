import { afterEach, describe, expect, it } from 'vitest';

import {
  getSkillRuntimeAdmission,
  getSkillRuntimeAdmissionWithDependencies,
} from '../runtimeAdmission';
import { __setRequiresGateForTest } from '../requiresGating';
import { setSkillDisabled } from '../skillEnableStorage';
import type { SkillDefinition } from '../types';

function builtinSkill(id: string, dependencies: string[] = []): SkillDefinition {
  return {
    id,
    name: id,
    description: id,
    version: '1.0.0',
    content: '',
    location: 'builtin',
    sourcePath: `builtin://${id}`,
    trustStatus: 'builtin',
    dependencies,
  };
}

describe('skill dependency runtime admission', () => {
  afterEach(() => {
    setSkillDisabled('dependency', false);
    __setRequiresGateForTest('requires-skill', null);
  });

  it('returns locale-neutral params with technical diagnostics', () => {
    const untrusted = {
      ...builtinSkill('external-skill'),
      location: 'external',
      trustStatus: 'untrusted',
    } as SkillDefinition;
    expect(getSkillRuntimeAdmission(untrusted)).toMatchObject({
      allowed: false,
      code: 'untrusted',
      params: { skillId: 'external-skill' },
    });

    const requiresSkill = builtinSkill('requires-skill');
    __setRequiresGateForTest(requiresSkill.id, {
      satisfied: false,
      missingBins: ['python'],
      missingEnv: ['API_TOKEN'],
      missingPythonPackages: ['pymupdf'],
    });
    const admission = getSkillRuntimeAdmission(requiresSkill);
    expect(admission).toMatchObject({
      allowed: false,
      code: 'requires_unsatisfied',
      params: {
        skillId: 'requires-skill',
        missingBins: 'python',
        missingEnv: 'API_TOKEN',
        missingPythonPackages: 'pymupdf',
      },
    });
    expect(admission.message).toContain('missing command python');
    expect(admission.message).toContain('missing Python package pymupdf');
  });

  it('rejects a parent when a dependency is disabled', () => {
    const dependency = builtinSkill('dependency');
    const parent = builtinSkill('parent', ['dependency']);
    const skills = new Map([
      [parent.id, parent],
      [dependency.id, dependency],
    ]);
    setSkillDisabled(dependency.id, true);

    const admission = getSkillRuntimeAdmissionWithDependencies(
      parent,
      (skillId) => skills.get(skillId),
    );

    expect(admission.allowed).toBe(false);
    expect(admission.code).toBe('dependency_unavailable');
    expect(admission.params).toMatchObject({
      skillId: 'parent',
      dependencyId: 'dependency',
      reason: 'disabled',
    });
    expect(admission.message).toContain('disabled');
  });

  it('rejects missing and circular dependency graphs', () => {
    const missingParent = builtinSkill('missing-parent', ['missing']);
    expect(
      getSkillRuntimeAdmissionWithDependencies(missingParent, () => undefined).allowed,
    ).toBe(false);

    const a = builtinSkill('a', ['b']);
    const b = builtinSkill('b', ['a']);
    const skills = new Map([
      [a.id, a],
      [b.id, b],
    ]);
    const admission = getSkillRuntimeAdmissionWithDependencies(
      a,
      (skillId) => skills.get(skillId),
    );
    expect(admission.allowed).toBe(false);
    expect(admission.message).toContain('circular');
  });
});

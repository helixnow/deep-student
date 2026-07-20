import { afterEach, describe, expect, it } from 'vitest';

import {
  getSkillRuntimeAdmissionWithDependencies,
} from '../runtimeAdmission';
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

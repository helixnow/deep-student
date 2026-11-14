import { describe, expect, it } from 'vitest';
import {
  SkillLifecycleExecutor, normalizeLifecycleSha256, requiredSkillId, validateSkillId,
} from '../src/tools/skill-lifecycle-executor.ts';

describe('skill_lifecycle_executor.rs', () => {
  it('validate_skill_id_rejects_invalid_chars', () => {
    expect(validateSkillId('good-skill_1')).toBe('good-skill_1');
    expect(() => validateSkillId('../evil')).toThrow();
    expect(() => validateSkillId('a/b')).toThrow();
    expect(() => validateSkillId('')).toThrow();
    expect(() => validateSkillId('  ')).toThrow();
  });

  it('sensitivity_mapping_matches_governance_contract', () => {
    const executor = new SkillLifecycleExecutor();
    expect(executor.sensitivityLevel('builtin-skill_set_enabled')).toBe('medium');
    expect(executor.sensitivityLevel('builtin-skill_remove')).toBe('high');
    expect(executor.sensitivityLevel('builtin-skill_trust_request')).toBe('high');
  });

  it('trust_request_inspect_is_low_but_grant_and_unknown_stay_high', () => {
    const executor = new SkillLifecycleExecutor();
    expect(executor.hasDynamicSensitivity('builtin-skill_trust_request')).toBe(true);
    expect(executor.hasDynamicSensitivity('builtin-skill_remove')).toBe(false);
    expect(executor.sensitivityLevelForCall(
      'builtin-skill_trust_request', { action: 'inspect', skill_id: 'x' },
    )).toBe('low');
    expect(executor.sensitivityLevelForCall(
      'builtin-skill_trust_request', { action: 'grant', skill_id: 'x' },
    )).toBe('high');
    // Missing / unknown action: fail-closed, stays High.
    expect(executor.sensitivityLevelForCall('builtin-skill_trust_request', {}))
      .toBe('high');
  });

  it('normalize_sha256_rejects_invalid', () => {
    expect(() => normalizeLifecycleSha256('abc', 'expected')).toThrow(
      'expected must be a 64-character SHA-256 hex digest',
    );
    expect(normalizeLifecycleSha256(
      '0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef',
      'expected',
    )).toBe('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  });

  it('can_handle_covers_all_three_tools_with_prefixes', () => {
    const executor = new SkillLifecycleExecutor();
    for (const name of [
      'skill_set_enabled',
      'builtin-skill_set_enabled',
      'skill_remove',
      'builtin-skill_remove',
      'skill_trust_request',
      'builtin-skill_trust_request',
    ]) {
      expect(executor.canHandle(name), name).toBe(true);
    }
    expect(executor.canHandle('skill_install')).toBe(false);
    expect(executor.canHandle('skill_workshop_apply')).toBe(false);
  });

  it('requiredSkillId accepts the camelCase alias and rejects non-strings', () => {
    expect(requiredSkillId({ skill_id: 'a-b' })).toBe('a-b');
    expect(requiredSkillId({ skillId: 'a-b' })).toBe('a-b');
    expect(() => requiredSkillId({ skill_id: 1 })).toThrow('skill_id is required');
    expect(() => requiredSkillId(null)).toThrow('skill_id is required');
  });
});

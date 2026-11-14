import { describe, expect, it } from 'vitest';
import {
  builtInAgentProfile, DEFAULT_PROFILE_ID, EXPLORER_PROFILE_ID, resolveAgentProfile,
  WORKER_PROFILE_ID,
} from '../src/agent-profile.ts';

describe('workspace/agent_profile.rs resolution', () => {
  it('profile_resolution_defaults_to_worker_and_applies_model_override', () => {
    const profile = resolveAgentProfile({
      profileId: null,
      skillId: 'custom_skill',
      overrides: { model: 'model-config-2' },
    });
    expect(profile.id).toBe('worker');
    expect(profile.model).toBe('model-config-2');
    expect(profile.skills).toEqual(['custom_skill']);

    expect(() => resolveAgentProfile({ profileId: 'nonexistent' })).toThrow(/Unknown agent profile/);
  });

  it('legacy_skill_resolves_to_real_worker_profile', () => {
    const profile = resolveAgentProfile({ skillId: 'code_review' });
    expect(profile.id).toBe('worker');
    expect(profile.skills).toEqual(['code_review']);
  });

  it('explicit_builtin_ids_select_the_matching_profile', () => {
    expect(resolveAgentProfile({ profileId: DEFAULT_PROFILE_ID }).id).toBe(DEFAULT_PROFILE_ID);
    expect(resolveAgentProfile({ profileId: EXPLORER_PROFILE_ID }).id).toBe(EXPLORER_PROFILE_ID);
    expect(resolveAgentProfile({ skillId: 'explorer' }).id).toBe('explorer');
    const explorer = resolveAgentProfile({ profileId: 'explorer' });
    expect(explorer.permissions.sandbox).toBe('read_only');
    expect(explorer.contextInheritance).toEqual({ mode: 'last_n_turns', turns: 8 });
    expect(explorer.allowedTools).toContain('builtin-memory_read');
    expect(builtInAgentProfile('missing')).toBeNull();
  });

  it('unknown_custom_persona_is_selectable_when_loaded', () => {
    const profile = resolveAgentProfile({ profileId: 'paper-summarizer' }, {
      customProfiles: [{
        id: 'paper-summarizer',
        description: '论文摘要',
        instructions: 'Summarize papers.',
        allowedTools: ['builtin-resource_read'],
      }],
    });
    expect(profile.id).toBe('paper-summarizer');
    expect(profile.allowedTools).toEqual(['builtin-resource_read']);
    expect(resolveAgentProfile({ profileId: WORKER_PROFILE_ID }).id).toBe(WORKER_PROFILE_ID);
  });
});

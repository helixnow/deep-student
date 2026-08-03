import { afterEach, describe, expect, it } from 'vitest';

import { skillRegistry } from '../registry';
import {
  clearSessionSkills,
  DEFAULT_PROGRESSIVE_DISCLOSURE_CONFIG,
  generateAvailableSkillsPrompt,
  getLoadedSkills,
  getProgressiveDisclosureConfig,
  handleLoadSkillsToolCall,
} from '../progressiveDisclosure';
import { setSkillDisabled } from '../skillEnableStorage';
import { __setRequiresGateForTest } from '../requiresGating';
import type { SkillDefinition } from '../types';

describe('progressive disclosure defaults', () => {
  afterEach(() => {
    for (const id of [
      'legacy-load-test-skill',
      'untrusted-runtime-skill',
      'disabled-runtime-skill',
      'gated-runtime-skill',
    ]) {
      skillRegistry.unregister(id);
      setSkillDisabled(id, false);
      __setRequiresGateForTest(id, null);
    }
    clearSessionSkills('legacy-load-test-session');
  });

  it('does not auto-load skills by default', () => {
    expect(DEFAULT_PROGRESSIVE_DISCLOSURE_CONFIG.autoLoadSkills).toEqual([]);
    expect(getProgressiveDisclosureConfig().autoLoadSkills).toEqual([]);
  });

  it('legacy load_skills handler returns light metadata without skill instructions', () => {
    const skill: SkillDefinition = {
      id: 'legacy-load-test-skill',
      name: 'Legacy Load Test Skill',
      description: 'Ensures legacy tool result stays lightweight',
      location: 'builtin',
      sourcePath: 'builtin://legacy-load-test-skill',
      content: 'private legacy skill instructions',
      embeddedTools: [
        {
          name: 'builtin-legacy_test_tool',
          description: 'Legacy test tool',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    };
    skillRegistry.register(skill);

    const result = handleLoadSkillsToolCall('legacy-load-test-session', {
      skills: ['legacy-load-test-skill'],
    });

    expect(result).not.toContain('<skill_loaded');
    expect(result).not.toContain('<instructions>');
    expect(result).not.toContain('private legacy skill instructions');
    expect(JSON.parse(result)).toMatchObject({
      result: {
        status: 'success',
        loaded_skill_ids: ['legacy-load-test-skill'],
        loaded_tool_names: ['builtin-legacy_test_tool'],
        loaded_tools: [{
          name: 'builtin-legacy_test_tool',
          skill_id: 'legacy-load-test-skill',
        }],
      },
    });
  });

  it('keeps untrusted descriptions and embedded schemas out of every runtime path', () => {
    const secret = 'UNTRUSTED_SECRET_DESCRIPTION';
    skillRegistry.register({
      id: 'untrusted-runtime-skill',
      name: 'Untrusted Runtime Skill',
      description: secret,
      location: 'global',
      sourcePath: '/tmp/untrusted/SKILL.md',
      trustStatus: 'untrusted',
      content: 'UNTRUSTED_SECRET_BODY',
      embeddedTools: [{
        name: 'builtin-untrusted_secret_tool',
        description: 'UNTRUSTED_SECRET_SCHEMA',
        inputSchema: { type: 'object', properties: {} },
      }],
    });

    expect(generateAvailableSkillsPrompt()).not.toContain('untrusted-runtime-skill');
    expect(generateAvailableSkillsPrompt()).not.toContain(secret);
    expect(skillRegistry.generateMetadataPrompt()).not.toContain(secret);

    const result = JSON.parse(handleLoadSkillsToolCall('legacy-load-test-session', {
      skills: ['untrusted-runtime-skill'],
    }));
    expect(result.result).toMatchObject({
      status: 'error',
      loaded_skill_ids: [],
      loaded_tool_names: [],
      rejected_skills: [{
        skillId: 'untrusted-runtime-skill',
        code: 'untrusted',
      }],
    });
    expect(getLoadedSkills('legacy-load-test-session')).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('UNTRUSTED_SECRET_BODY');
    expect(JSON.stringify(result)).not.toContain('UNTRUSTED_SECRET_SCHEMA');
  });

  it('rejects disabled skills with an explicit disabled result', () => {
    skillRegistry.register({
      id: 'disabled-runtime-skill',
      name: 'Disabled Runtime Skill',
      description: 'Disabled load admission regression test',
      location: 'builtin',
      sourcePath: 'builtin://disabled-runtime-skill',
      trustStatus: 'builtin',
      content: '# disabled',
    });
    setSkillDisabled('disabled-runtime-skill', true);

    const result = JSON.parse(handleLoadSkillsToolCall('legacy-load-test-session', {
      skills: ['disabled-runtime-skill'],
    }));
    expect(result.result.status).toBe('error');
    expect(result.result.rejected_skills).toEqual([
      expect.objectContaining({
        skillId: 'disabled-runtime-skill',
        code: 'disabled',
        message: expect.stringMatching(/disabled/i),
      }),
    ]);
    expect(generateAvailableSkillsPrompt()).not.toContain('disabled-runtime-skill');
  });

  it('rejects manual load when requires are unsatisfied', () => {
    skillRegistry.register({
      id: 'gated-runtime-skill',
      name: 'Gated Runtime Skill',
      description: 'Requires gate load admission regression test',
      location: 'builtin',
      sourcePath: 'builtin://gated-runtime-skill',
      trustStatus: 'builtin',
      content: '# gated',
      requires: { bins: ['missing-tool'] },
    });
    __setRequiresGateForTest('gated-runtime-skill', {
      satisfied: false,
      missingBins: ['missing-tool'],
      missingEnv: [],
      missingPythonPackages: [],
    });

    const result = JSON.parse(handleLoadSkillsToolCall('legacy-load-test-session', {
      skills: ['gated-runtime-skill'],
    }));
    expect(result.result.status).toBe('error');
    expect(result.result.rejected_skills).toEqual([
      expect.objectContaining({
        skillId: 'gated-runtime-skill',
        code: 'requires_unsatisfied',
        message: expect.stringContaining('missing command missing-tool'),
      }),
    ]);
    expect(getLoadedSkills('legacy-load-test-session')).toEqual([]);
  });
});

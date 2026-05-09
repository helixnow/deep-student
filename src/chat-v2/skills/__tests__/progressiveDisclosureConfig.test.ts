import { afterEach, describe, expect, it } from 'vitest';

import { skillRegistry } from '../registry';
import { clearSessionSkills, DEFAULT_PROGRESSIVE_DISCLOSURE_CONFIG, getProgressiveDisclosureConfig, handleLoadSkillsToolCall } from '../progressiveDisclosure';
import type { SkillDefinition } from '../types';

describe('progressive disclosure defaults', () => {
  afterEach(() => {
    skillRegistry.unregister('legacy-load-test-skill');
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
      },
    });
  });
});

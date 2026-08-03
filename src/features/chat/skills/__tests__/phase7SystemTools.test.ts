import { describe, expect, it } from 'vitest';

import {
  dataGovernanceToolsSkill,
  getBuiltinToolSkillById,
  llmUsageToolsSkill,
  settingsToolsSkill,
} from '../builtin-tools';
import type { SkillDefinition } from '../types';

function tool(skill: SkillDefinition, name: string) {
  const matches = skill.embeddedTools?.filter((entry) => entry.name === name) ?? [];
  expect(matches).toHaveLength(1);
  return matches[0];
}

function expectClosedContract(skill: SkillDefinition) {
  expect(skill.allowedTools).toEqual(skill.embeddedTools?.map((entry) => entry.name));
  expect(new Set(skill.allowedTools).size).toBe(skill.allowedTools.length);
}

describe('phase 7 settings, usage and governance skill contracts', () => {
  it('registers all three progressive-disclosure skills exactly once', () => {
    expect(getBuiltinToolSkillById('settings-tools')).toBe(settingsToolsSkill);
    expect(getBuiltinToolSkillById('llm-usage-tools')).toBe(llmUsageToolsSkill);
    expect(getBuiltinToolSkillById('data-governance-tools')).toBe(dataGovernanceToolsSkill);
    expectClosedContract(settingsToolsSkill);
    expectClosedContract(llmUsageToolsSkill);
    expectClosedContract(dataGovernanceToolsSkill);
  });

  it('keeps settings writes on a strict key/value oneOf and models on OCC', () => {
    const get = tool(settingsToolsSkill, 'builtin-settings_get');
    const set = tool(settingsToolsSkill, 'builtin-settings_set');
    const assignmentSet = tool(settingsToolsSkill, 'builtin-model_assignments_set');

    expect(get.inputSchema.additionalProperties).toBe(false);
    expect(get.inputSchema.properties?.prefix.enum).not.toContain('api_key');
    expect(set.inputSchema.oneOf).toHaveLength(12);
    expect(set.inputSchema.oneOf.every((branch: any) => branch.additionalProperties === false)).toBe(true);
    expect(assignmentSet.inputSchema.required).toEqual([
      'slot',
      'config_id',
      'expected_current_config_id',
    ]);
    expect(JSON.stringify(settingsToolsSkill)).not.toMatch(/embedding_model_config_id"/);
    expect(settingsToolsSkill.content).toContain('API key');
    expect(settingsToolsSkill.content).toContain('OCC');
  });

  it('uses mutually exclusive usage action schemas and estimated-cost language', () => {
    const query = tool(llmUsageToolsSkill, 'builtin-llm_usage_query');
    expect(query.inputSchema.oneOf).toHaveLength(5);
    const actions = query.inputSchema.oneOf.map((branch: any) => branch.properties.action.enum[0]);
    expect(actions).toEqual(['summary', 'trends', 'by_model', 'by_caller', 'recent']);
    expect(query.inputSchema.oneOf.every((branch: any) => branch.additionalProperties === false)).toBe(true);
    expect(query.inputSchema.properties.offset.maximum).toBe(100_000);
    expect(query.inputSchema.oneOf[4].properties.offset.maximum).toBe(100_000);
    expect(llmUsageToolsSkill.content).toContain('estimated cost');
    expect(llmUsageToolsSkill.content).toContain('cost.priceCoverage');
    expect(llmUsageToolsSkill.content).toContain('cost.estimatedUsd');
    expect(llmUsageToolsSkill.content).not.toContain('pricing_coverage');
    expect(llmUsageToolsSkill.content).toContain('不代表免费');
  });

  it('makes backup completion observable and keeps sync credentials out of schemas', () => {
    const create = tool(dataGovernanceToolsSkill, 'builtin-backup_create');
    const job = tool(dataGovernanceToolsSkill, 'builtin-backup_job_status');
    const sync = tool(dataGovernanceToolsSkill, 'builtin-sync_run');

    expect(create.inputSchema.additionalProperties).toBe(false);
    expect(job.inputSchema.required).toEqual(['job_id']);
    expect(sync.inputSchema.required).toEqual(['direction']);
    expect(Object.keys(sync.inputSchema.properties ?? {})).toEqual(['direction', 'strategy']);
    expect(JSON.stringify(sync.inputSchema)).not.toMatch(/password|secret|token|credential|cloud_config/i);
    expect(dataGovernanceToolsSkill.content).toContain('cloud_probed=false');
    expect(dataGovernanceToolsSkill.content).toContain('result.success');
    expect(dataGovernanceToolsSkill.content).toContain('明确不开放');
  });
});

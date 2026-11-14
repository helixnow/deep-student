import { describe, expect, it } from 'vitest';
import {
  buildLoadSkillsOutput, classifyRequestedSkills, collectAvailableRuntimeSkillIds,
  buildLoadSkillsMessage, parseSkillsArgument, SkillsExecutor, type LoadSkillsOutcomeInput,
} from '../src/tools/skills-executor.ts';

function outcome(patch: Partial<LoadSkillsOutcomeInput>): LoadSkillsOutcomeInput {
  return {
    requestedSkillIds: [],
    loadedSkillIds: [],
    alreadyLoadedSkillIds: [],
    missingSkillIds: [],
    rejectedSkills: new Map(),
    availableSkillIds: [],
    sessionLoadedSkillIds: [],
    loadedTools: [],
    skillStateVersion: 0,
    hasUntrustedRejection: false,
    includeAvailableHint: true,
    ...patch,
  };
}

describe('skills_executor.rs', () => {
  it('test_is_load_skills_tool', () => {
    expect(SkillsExecutor.isLoadSkillsTool('load_skills')).toBe(true);
    expect(SkillsExecutor.isLoadSkillsTool('builtin-load_skills')).toBe(true);
    expect(SkillsExecutor.isLoadSkillsTool('builtin:load_skills')).toBe(true);
    expect(SkillsExecutor.isLoadSkillsTool('mcp_load_skills')).toBe(true);
    expect(SkillsExecutor.isLoadSkillsTool('other_tool')).toBe(false);
    expect(SkillsExecutor.isLoadSkillsTool('mcp_other_tool')).toBe(false);
  });

  it('test_strip_prefix', () => {
    expect(SkillsExecutor.stripPrefix('builtin-load_skills')).toBe('load_skills');
    expect(SkillsExecutor.stripPrefix('builtin:load_skills')).toBe('load_skills');
    expect(SkillsExecutor.stripPrefix('mcp_load_skills')).toBe('load_skills');
    expect(SkillsExecutor.stripPrefix('load_skills')).toBe('load_skills');
  });

  it('admission_errors_reject_disabled_skills_before_content_lookup', () => {
    const requested = ['disabled-skill', 'ok-skill'];
    const contents = new Map([
      ['disabled-skill', 'must not load'],
      ['ok-skill', 'ok'],
    ]);
    const admissionErrors = new Map([
      ['disabled-skill', 'disabled: Skill "disabled-skill" is disabled and cannot be loaded'],
    ]);

    const { loaded, notFound, rejected } = classifyRequestedSkills(
      requested, contents, admissionErrors,
    );

    expect(loaded).toEqual(['ok-skill']);
    expect(notFound).toEqual([]);
    expect(rejected.get('disabled-skill')!.startsWith('disabled:')).toBe(true);
  });

  it('available_runtime_ids_are_exact_sorted_and_exclude_rejections', () => {
    const contents = new Map([
      ['qbank-tools', 'qbank'],
      ['dstu-tools', 'dstu'],
      ['rejected-skill', 'must not be advertised'],
      ['', 'empty id'],
    ]);
    const admissionErrors = new Map([
      ['rejected-skill', 'untrusted: Skill "rejected-skill" is untrusted'],
    ]);

    expect(collectAvailableRuntimeSkillIds(contents, admissionErrors))
      .toEqual(['dstu-tools', 'qbank-tools']);
  });

  it('missing_skill_message_returns_exact_loadable_ids_and_never_autoloads', () => {
    const requested = ['question_bank', '题库'];
    const missing = [...requested];
    const available = ['dstu-tools', 'qbank-tools'];
    const output = buildLoadSkillsOutput(outcome({
      requestedSkillIds: requested,
      missingSkillIds: missing,
      availableSkillIds: available,
    }));

    expect(output.status).toBe('error');
    expect(output.loaded_skill_ids).toEqual([]);
    expect(output.newly_loaded_skill_ids).toEqual([]);
    expect(output.requested_skill_ids).toEqual(requested);
    expect(output.missing_skill_ids).toEqual(missing);
    expect(output.available_skill_ids).toEqual(available);
    expect(output.message).toContain('qbank-tools');
    expect(output.message).toContain('dstu-tools');
    expect(output.message).toContain('do not guess');
    expect(output.message).not.toContain('Skills loaded.');
  });

  it('rejected_skills_are_reported_separately_from_available_ids', () => {
    const requested = ['untrusted-skill'];
    const rejected = new Map([
      ['untrusted-skill', 'untrusted: Skill "untrusted-skill" is untrusted and cannot be loaded'],
    ]);
    const available = ['qbank-tools'];
    const output = buildLoadSkillsOutput(outcome({
      requestedSkillIds: requested,
      rejectedSkills: rejected,
      availableSkillIds: available,
      skillStateVersion: 7,
      hasUntrustedRejection: true,
    }));

    expect(output.status).toBe('error');
    expect(output.available_skill_ids).toEqual(available);
    expect(output.rejected_skill_ids).toEqual(['untrusted-skill']);
    expect(output.message).toContain('Rejected: untrusted-skill (untrusted:');
    expect(output.message).toContain('Available skill IDs');
    expect(output.message).toContain('Do not retry load_skills in this request');
    expect(output.message).not.toContain('Skills loaded.');
  });

  it('empty_request_reports_available_ids_without_loading_anything', () => {
    const output = buildLoadSkillsOutput(outcome({
      availableSkillIds: ['qbank-tools'],
      sessionLoadedSkillIds: ['already-loaded-tool'],
      skillStateVersion: 3,
    }));

    expect(output.status).toBe('error');
    expect(output.newly_loaded_skill_ids).toEqual([]);
    expect(output.loaded_skill_ids).toEqual(['already-loaded-tool']);
    expect(output.message).toContain('No skills were requested');
    expect(output.message).toContain('qbank-tools');
  });

  it('already_loaded_ids_do_not_claim_a_new_load', () => {
    const requested = ['qbank-tools'];
    const output = buildLoadSkillsOutput(outcome({
      requestedSkillIds: requested,
      loadedSkillIds: requested,
      alreadyLoadedSkillIds: requested,
      availableSkillIds: requested,
      sessionLoadedSkillIds: requested,
      skillStateVersion: 2,
      includeAvailableHint: false,
    }));

    expect(output.status).toBe('success');
    expect(output.newly_loaded_skill_ids).toEqual([]);
    expect(output.already_loaded_skill_ids).toEqual(requested);
    expect(output.message).toContain('Skills already loaded.');
  });

  it('parseSkillsArgument accepts arrays and stringified arrays', () => {
    expect(parseSkillsArgument(['a', 'b'])).toEqual(['a', 'b']);
    expect(parseSkillsArgument('["a","b"]')).toEqual(['a', 'b']);
    expect(() => parseSkillsArgument('not json')).toThrow(
      'invalid stringified array: \'not json\', expected a JSON array string like \'["a", "b"]\'',
    );
    expect(() => parseSkillsArgument('[1]')).toThrow('invalid stringified array');
  });

  it('buildLoadSkillsMessage sorts rejected entries and de-duplicates tool names', () => {
    const message = buildLoadSkillsMessage(
      ['a'], [], [], new Map([['z', 'Z'], ['a', 'A']]), ['a'], false, false,
    );
    expect(message).toContain('Rejected: a (A), z (Z)');
    const output = buildLoadSkillsOutput(outcome({
      requestedSkillIds: ['a'],
      loadedSkillIds: ['a'],
      sessionLoadedSkillIds: ['a'],
      loadedTools: [
        { name: 'tool_b', skill_id: 'a' },
        { name: 'tool_a', skill_id: 'a' },
        { name: 'tool_a', skill_id: 'b' },
      ],
      includeAvailableHint: false,
    }));
    expect(output.loaded_tool_names).toEqual(['tool_a', 'tool_b']);
  });
});

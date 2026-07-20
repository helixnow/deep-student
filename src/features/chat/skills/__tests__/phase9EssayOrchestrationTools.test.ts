import { describe, expect, it } from 'vitest';

import { essayGradingSkill } from '../builtin-tools/essay-grading';
import { workspaceToolsSkill } from '../builtin-tools/workspace-tools';

function tool(skill: typeof essayGradingSkill | typeof workspaceToolsSkill, name: string) {
  const matches = skill.embeddedTools?.filter((entry) => entry.name === name) ?? [];
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe('phase 9 essay and orchestration contracts', () => {
  it('exposes model selection and custom grading modes without widening essay tools', () => {
    expect(essayGradingSkill.allowedTools).toEqual(
      essayGradingSkill.embeddedTools?.map((entry) => entry.name),
    );
    const gradeSchema = tool(essayGradingSkill, 'builtin-essay_grade').inputSchema;
    expect(gradeSchema.properties.model_config_id?.type).toBe('string');
    expect(gradeSchema.properties.mode_id?.description).toContain('自定义');
    expect(gradeSchema.properties.mode_id?.description).toContain('必须来自 essay_list_modes');
    expect(tool(essayGradingSkill, 'builtin-essay_list_modes').description).toContain('自定义');
    expect(tool(essayGradingSkill, 'builtin-essay_list_modes').description).toContain('is_builtin');
    expect(essayGradingSkill.content).toContain('CustomModeManager');
    expect(essayGradingSkill.content).toContain('不要猜测未列出的 ID');
  });

  it('documents only the real attachment-to-OCR-to-grading route in order', () => {
    const route = [
      'builtin-attachment_stage',
      'builtin-dstu_upload_file',
      'builtin-document_parse',
      'builtin-document_parse_status',
      'builtin-resource_read',
      'builtin-essay_grade',
    ];
    let cursor = -1;
    for (const name of route) {
      const index = essayGradingSkill.content.indexOf(name, cursor + 1);
      expect(index, `${name} should follow the previous OCR step`).toBeGreaterThan(cursor);
      cursor = index;
    }
    expect(essayGradingSkill.content).not.toContain('ocr_extract');
  });

  it('routes FSRS through existing ChatAnki tools and exposes no rating tool', () => {
    expect(essayGradingSkill.content).toContain('builtin-chatanki_enqueue_review');
    expect(essayGradingSkill.content).toContain('builtin-chatanki_review_stats');
    expect(essayGradingSkill.allowedTools).not.toContain('builtin-fsrs_rate');
    expect(essayGradingSkill.embeddedTools?.map((entry) => entry.name)).not.toContain(
      'builtin-fsrs_rate',
    );
  });

  it('makes subagent_call discoverable inside the workspace three-piece contract', () => {
    expect(workspaceToolsSkill.allowedTools).toEqual(
      workspaceToolsSkill.embeddedTools?.map((entry) => entry.name),
    );
    const subagent = tool(workspaceToolsSkill, 'builtin-subagent_call');
    expect(subagent.inputSchema.additionalProperties).toBe(false);
    expect(subagent.inputSchema.required).toEqual(['task']);
    // C6: profile 是自由字符串（内建三型 + 自定义 profile），不再限定 enum
    expect(subagent.inputSchema.properties.profile?.type).toBe('string');
    expect(subagent.inputSchema.properties.profile?.enum).toBeUndefined();
    // C7: 续跑参数存在，描述提及 resumed 返回键
    expect(Object.keys(subagent.inputSchema.properties)).toContain('resume_agent_session_id');
    expect(subagent.inputSchema.properties.resume_agent_session_id?.description).toContain('resumed');
    expect(subagent.inputSchema.properties.wait?.default).toBe(true);
    expect(subagent.inputSchema.properties.skill_id?.description).toContain('subagent-worker');
    expect(subagent.inputSchema.properties.skill_id?.description).not.toContain("'translation'");
    expect(workspaceToolsSkill.content).toContain('Workspace 三件套');
    expect(workspaceToolsSkill.content).toContain('subagent_call');
    expect(workspaceToolsSkill.content).toContain('workspace_create_agent');
  });
});

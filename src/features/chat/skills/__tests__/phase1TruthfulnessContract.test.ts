import { describe, expect, it } from 'vitest';

import { attachmentToolsSkill } from '../builtin-tools/attachment-tools';
import { reviewPlanningSkill } from '../builtin-tools/review-planning';
import { sessionManagerSkill } from '../builtin-tools/session-manager';
import { workbenchToolsSkill } from '../builtin-tools/workbench-tools';

describe('phase 1 truthfulness contracts', () => {
  it('describes session_get as metadata-only', () => {
    const tool = sessionManagerSkill.embeddedTools?.find(
      (candidate) => candidate.name === 'builtin-session_get',
    );
    expect(tool?.description).toContain('仅获取');
    expect(tool?.description).toContain('不返回消息正文');
    expect(sessionManagerSkill.content).toContain('session_get 只补充');
  });

  it('advertises only attachment types the executor can read', () => {
    const list = attachmentToolsSkill.embeddedTools?.find(
      (candidate) => candidate.name === 'builtin-attachment_list',
    );
    expect(list?.inputSchema.properties.type.enum).toEqual(['image', 'document', 'all']);
    expect(attachmentToolsSkill.content).toContain('不提供音频转写或视频解析');
  });

  it.each([
    ['builtin-review_suspend', 'Medium'],
    ['builtin-review_resume', 'Medium'],
    ['builtin-review_delete', 'High'],
  ])('keeps %s in allowedTools and embeddedTools with %s risk', (name, risk) => {
    expect(reviewPlanningSkill.allowedTools).toContain(name);
    const tool = reviewPlanningSkill.embeddedTools?.find((candidate) => candidate.name === name);
    expect(tool).toBeDefined();
    expect(tool!.description).toContain(risk);
    expect(tool!.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['plan_id'],
    });
    expect(tool!.inputSchema.properties.plan_id).toMatchObject({
      type: 'string',
      minLength: 1,
    });
  });

  it('requires ask_user before irreversible review deletion', () => {
    const deletion = reviewPlanningSkill.embeddedTools?.find(
      (candidate) => candidate.name === 'builtin-review_delete',
    );
    expect(deletion?.description).toContain('builtin-ask_user');
    expect(deletion?.description).toContain('不可恢复');
    expect(reviewPlanningSkill.content).toContain('load_skills(["ask-user"])');
    expect(reviewPlanningSkill.content).not.toContain('可在复习界面暂停');
  });

  it('documents the non-Windows browser fallback', () => {
    expect(workbenchToolsSkill.content).toContain('browser 领域工具当前只在 Windows 暴露');
    expect(workbenchToolsSkill.content).toContain('macOS/Linux');
    expect(workbenchToolsSkill.content).toContain('请用户接管');
  });
});

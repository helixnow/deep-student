import { describe, expect, it } from 'vitest';

import { canvasNoteSkill } from '../builtin-tools/canvas-note';
import { workbenchToolsSkill } from '../builtin-tools/workbench-tools';

describe('visible note demo skill contract', () => {
  it('routes visible note demonstrations through Workbench and an existing note', () => {
    expect(canvasNoteSkill.description).toContain('workbench-tools');
    expect(canvasNoteSkill.content).toContain('可见操作演示');
    expect(canvasNoteSkill.content).toContain('builtin-note_list');
    expect(canvasNoteSkill.content).toContain('打开并聚焦');
    expect(canvasNoteSkill.content).toContain('不得为了演示而自行创建笔记');
    expect(canvasNoteSkill.content).toContain('不得为了演示而自行创建笔记、编造笔记主题、覆盖整篇内容');
  });

  it('defines the Workbench and domain-tool sequence for a real ACR performance', () => {
    const content = workbenchToolsSkill.content;
    const listWindows = content.indexOf('builtin-workbench_list_windows');
    const openApp = content.indexOf('builtin-workbench_open_app', listWindows);
    const domainEdit = content.indexOf('builtin-note_append', openApp);
    const confirmation = content.indexOf('最后读取笔记或查询窗口状态确认结果', domainEdit);

    expect(workbenchToolsSkill.description).toContain('展示/演示/让我看你操作');
    expect(content).toContain('可见笔记演示');
    expect(content).toContain('probe -> apply_ops');
    expect(content).toContain('AgentStrip、AI 光标/高亮、节奏与进度');
    expect(listWindows).toBeGreaterThanOrEqual(0);
    expect(openApp).toBeGreaterThan(listWindows);
    expect(domainEdit).toBeGreaterThan(openApp);
    expect(confirmation).toBeGreaterThan(domainEdit);
    expect(content).toContain('单纯“展示能力”不等于授权创建、覆盖或改写用户内容');
  });
});

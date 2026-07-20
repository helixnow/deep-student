/**
 * ACR 4.0 A3 — skills AppAgentManifest
 *
 * 观察投影（清单/启用态/分组/截断）+ search / focusSkill / openSkill / setEnabled
 * 的真实 surface 语义（只操作观察到的技能；setEnabled 可逆）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { skillsAgentManifest } from '../agentManifests';
import {
  registerSkillsAgentSurface,
  type SkillsAgentSnapshot,
} from '../agentSurfaceRegistry';

const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.innerHTML = '';
});

const context = (windowId: string) => ({
  windowId,
  typeId: 'skills',
  instanceKey: null,
});

function makeSurface(windowId: string) {
  let snapshot: SkillsAgentSnapshot = {
    searchQuery: '',
    locationFilter: 'all',
    selectedSkillId: null,
    editorOpen: false,
    loading: false,
    skills: [
      {
        id: 'sk-1',
        name: '论文精读',
        description: '结构化精读论文',
        location: 'global',
        builtin: false,
        enabled: true,
        defaultEnabled: true,
      },
      {
        id: 'sk-2',
        name: 'deep-student',
        location: 'builtin',
        builtin: true,
        enabled: true,
        defaultEnabled: false,
      },
    ],
    totalSkills: 2,
  };
  cleanups.push(registerSkillsAgentSurface(windowId, {
    snapshot: () => snapshot,
    search: (query) => {
      snapshot = { ...snapshot, searchQuery: query };
      return true;
    },
    focusSkill: (skillId) => {
      if (!snapshot.skills.some((skill) => skill.id === skillId)) return false;
      snapshot = { ...snapshot, selectedSkillId: skillId };
      return true;
    },
    openSkill: (skillId) => {
      if (!snapshot.skills.some((skill) => skill.id === skillId)) return false;
      snapshot = { ...snapshot, selectedSkillId: skillId, editorOpen: true };
      return true;
    },
    setEnabled: (skillId, enabled) => {
      if (!snapshot.skills.some((skill) => skill.id === skillId)) return false;
      snapshot = {
        ...snapshot,
        skills: snapshot.skills.map((skill) =>
          skill.id === skillId ? { ...skill, enabled } : skill,
        ),
      };
      return true;
    },
  }));
  return () => snapshot;
}

describe('skills Agent manifest（ACR 4.0 A3）', () => {
  it('surface 未挂载时 observe 只报 not-ready，不虚报能力', () => {
    const observation = skillsAgentManifest.observe?.(context('skills-unmounted'));
    expect(observation).toMatchObject({
      route: 'skills/unmounted',
      busy: true,
      availableActions: [],
      state: { ready: false },
    });
  });

  it('observe 投影技能清单：id/名称/启用态/分组/默认注入 + 截断标记', () => {
    makeSurface('skills-window');
    const observation = skillsAgentManifest.observe?.(context('skills-window'));
    expect(observation).toMatchObject({
      route: 'skills/all/none',
      availableActions: ['search', 'focusSkill', 'openSkill', 'setEnabled'],
      state: {
        ready: true,
        skillCount: 2,
        skillsTruncated: false,
        enabledCount: 2,
        disabledCount: 0,
      },
    });
    expect(observation?.entities).toEqual([
      expect.objectContaining({
        ref: 'skills:skill:sk-1',
        kind: 'skill',
        label: '论文精读',
        state: expect.objectContaining({
          location: 'global',
          builtin: false,
          enabled: true,
          defaultEnabled: true,
        }),
      }),
      expect.objectContaining({ ref: 'skills:skill:sk-2' }),
    ]);
  });

  it('search / focusSkill 走真实 surface 并携带撤销', async () => {
    const getSnapshot = makeSurface('skills-window');
    const ctx = context('skills-window');

    expect(await skillsAgentManifest.execute?.(ctx, {
      name: 'search',
      args: { query: '论文' },
    })).toMatchObject({ handled: true, acknowledged: true, changed: true });
    expect(getSnapshot().searchQuery).toBe('论文');

    const focused = await skillsAgentManifest.execute?.(ctx, {
      name: 'focusSkill',
      args: { skillId: 'sk-1' },
      targetRef: 'skills:skill:sk-1',
    });
    expect(focused).toMatchObject({
      handled: true,
      acknowledged: true,
      changed: true,
      entityRefs: ['skills:skill:sk-1'],
    });
    expect(getSnapshot().selectedSkillId).toBe('sk-1');
    expect(skillsAgentManifest.observe?.(ctx)).toMatchObject({
      selection: ['skills:skill:sk-1'],
    });
  });

  it('focusSkill 成功后对 data-agent-entity 锚点做一次 flash', async () => {
    makeSurface('skills-window');
    const row = document.createElement('div');
    row.setAttribute('data-agent-entity', 'skills:sk-1');
    document.body.appendChild(row);

    await skillsAgentManifest.execute?.(context('skills-window'), {
      name: 'focusSkill',
      args: { skillId: 'sk-1' },
    });
    // flashAfterRender 双 rAF 后落 data-agent-flash
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(row.hasAttribute('data-agent-flash')).toBe(true);
  });

  it('openSkill 打开详情编辑器并回执 editorOpen 后置条件', async () => {
    const getSnapshot = makeSurface('skills-window');
    const result = await skillsAgentManifest.execute?.(context('skills-window'), {
      name: 'openSkill',
      args: { skillId: 'sk-2' },
      targetRef: 'skills:skill:sk-2',
    });
    expect(result).toMatchObject({
      handled: true,
      acknowledged: true,
      changed: true,
      postconditions: expect.arrayContaining([
        { kind: 'state_equals', path: 'editorOpen', value: true },
      ]),
    });
    expect(getSnapshot().editorOpen).toBe(true);
    expect(getSnapshot().selectedSkillId).toBe('sk-2');
  });

  it('setEnabled 真实切换启用态，重复设置回执 changed:false，撤销为反向切换', async () => {
    const getSnapshot = makeSurface('skills-window');
    const ctx = context('skills-window');

    const disabled = await skillsAgentManifest.execute?.(ctx, {
      name: 'setEnabled',
      args: { skillId: 'sk-1', enabled: false },
      targetRef: 'skills:skill:sk-1',
    });
    expect(disabled).toMatchObject({ handled: true, acknowledged: true, changed: true });
    expect(disabled?.undo?.inverse).toMatchObject({
      name: 'setEnabled',
      args: { skillId: 'sk-1', enabled: true },
    });
    expect(getSnapshot().skills.find((skill) => skill.id === 'sk-1')?.enabled).toBe(false);
    expect(skillsAgentManifest.observe?.(ctx)).toMatchObject({
      state: { enabledCount: 1, disabledCount: 1 },
    });

    const repeated = await skillsAgentManifest.execute?.(ctx, {
      name: 'setEnabled',
      args: { skillId: 'sk-1', enabled: false },
    });
    expect(repeated).toMatchObject({ handled: true, changed: false });
    expect(repeated?.undo).toBeUndefined();
  });

  it('未观察到的技能一律 ENTITY_NOT_FOUND，targetRef 不一致被拒绝', async () => {
    makeSurface('skills-window');
    const ctx = context('skills-window');
    expect(await skillsAgentManifest.execute?.(ctx, {
      name: 'setEnabled',
      args: { skillId: 'ghost', enabled: false },
    })).toMatchObject({ handled: false, code: 'ENTITY_NOT_FOUND' });
    expect(await skillsAgentManifest.execute?.(ctx, {
      name: 'focusSkill',
      args: { skillId: 'sk-1' },
      targetRef: 'skills:skill:sk-2',
    })).toMatchObject({ handled: false, code: 'TARGET_REF_MISMATCH' });
  });
});

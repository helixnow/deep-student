import { expect, it } from 'vitest';
import { developmentSkill, developmentSkillResource, interactiveExplainerSkill, interactiveExplainerSkillResource } from '../src/resources.ts';
import { WorkshopCatalog } from '../src/catalog.ts';

it('exposes the shipped skill frontmatter separately from its on-demand body', async () => {
  const metadata = await developmentSkillResource();
  const full = await developmentSkillResource(true);
  expect(metadata.id).toBe('dstu-plugin-development');
  expect(metadata.markdown).toContain('description: Create or modify a dstu plugin');
  expect(metadata.markdown).not.toContain('# dstu plugin development');
  expect(full.markdown).toBe(await developmentSkill());
  expect(Buffer.byteLength(full.markdown)).toBeLessThanOrEqual(8192);
});

it('exposes interactive explainer metadata, body and all shipped references', async () => {
  const metadata = await interactiveExplainerSkillResource();
  const full = await interactiveExplainerSkillResource(true);
  expect(metadata.id).toBe('interactive-explainer');
  expect(metadata.markdown).toContain('name: 可视化讲解');
  expect(metadata.markdown).toContain('description:');
  expect(metadata.markdown).not.toContain('## 先选表达方式');
  expect(full.markdown).toBe(await interactiveExplainerSkill());
  expect(full.markdown).toContain('## 先选表达方式');
  const catalog = new WorkshopCatalog(() => []);
  const base = 'resources:resources/dstu-workshop/skills/interactive-explainer';
  expect((await catalog.read(`${base}/SKILL.md`, 'test')).content).toBe(full.markdown);
  const { entries } = await catalog.list('resources');
  for (const name of ['chart', 'explore', 'host-question', 'manipulate', 'practice', 'runtime', 'simulation', 'static-diagrams', 'stepper']) {
    const id = `${base}/references/${name}.md`;
    expect(entries.some(entry => entry.id === id)).toBe(true);
    expect((await catalog.read(id, 'test')).content).toEqual(expect.stringMatching(/\S/));
  }
});

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { pluginServiceName } from '../../../kernel/plugin-id.ts';
import type { WorkshopCard } from '../api.ts';

export const workshopResources = fileURLToPath(new URL('../../../../resources/dstu-workshop/', import.meta.url));
export const developmentSkillId = 'dstu-plugin-development';
export const interactiveExplainerSkillId = 'interactive-explainer';
export async function interactiveExplainerSkill(): Promise<string> {
  return readFile(join(workshopResources, 'skills', interactiveExplainerSkillId, 'SKILL.md'), 'utf8');
}
export async function interactiveExplainerSkillResource(includeContent = false): Promise<{ id: string; markdown: string }> {
  const markdown = await interactiveExplainerSkill();
  const end = markdown.indexOf('\n---', 3);
  if (end < 0) throw new Error('WORKSHOP_INVALID: interactive explainer skill frontmatter missing');
  return { id: interactiveExplainerSkillId, markdown: includeContent ? markdown : markdown.slice(0, end + 4) + '\n' };
}
export async function developmentSkill(): Promise<string> {
  return readFile(join(workshopResources, 'skills', developmentSkillId, 'SKILL.md'), 'utf8');
}
/** Metadata and body share the single shipped resource (including in app.asar). */
export async function developmentSkillResource(includeContent = false): Promise<{ id: string; markdown: string }> {
  const markdown = await developmentSkill();
  const end = markdown.indexOf('\n---', 3);
  if (end < 0) throw new Error('WORKSHOP_INVALID: development skill frontmatter missing');
  return { id: developmentSkillId, markdown: includeContent ? markdown : markdown.slice(0, end + 4) + '\n' };
}
export async function seedTemplate(source: string, card: WorkshopCard): Promise<void> {
  const template = join(workshopResources, 'templates', card.template);
  const service = pluginServiceName(card.pluginId);
  const title = card.title?.trim() || '每日回忆';
  await mkdir(source, { recursive: true });
  for (const entry of await readdir(template)) {
    let content = (await readFile(join(template, entry), 'utf8'))
      .replaceAll('__PLUGIN_ID__', card.pluginId)
      .replaceAll('__SERVICE__', service)
      .replaceAll('每日回忆', title);
    if (entry === 'package.json') {
      const pkg = JSON.parse(content) as { deepStudent?: Record<string, unknown> };
      if (pkg.deepStudent) {
        pkg.deepStudent.displayName = title;
        if (card.description?.trim()) pkg.deepStudent.description = card.description.trim();
        content = `${JSON.stringify(pkg, null, 2)}\n`;
      }
    }
    await writeFile(join(source, entry), content, { flag: 'wx' });
  }
}

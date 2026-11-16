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

/** Shipped, compilable recipes beyond the two seed templates; keyed by the template they extend (the default one). */
export const workshopRecipes = { 'host-tool': 'agent-tool', 'learning-tool': 'selection-model' } as const;
/**
 * Every shipped recipe: the defaults, the reference app (list + search + data, formulas with MathText) and the service
 * recipes (a scheduled nightly summary, a PDF selection button, chat slash commands).
 */
export const allWorkshopRecipes = ['agent-tool', 'selection-model', 'reference-app', 'nightly-summary', 'pdf-selection', 'chat-command'] as const;
/** Proposal wording that picks a service recipe, checked in this order before the selection / reference rules. */
export const SCHEDULE_WORDS = /定时|每晚|每天晚上|每天|每周|提醒|自动运行|schedule|nightly|daily|reminder/i;
export const PDF_WORDS = /PDF|划词|讲义|课件/i;
export const COMMAND_WORDS = /斜杠|命令|指令|slash|\/[a-z]+|command/i;
export type WorkshopRecipeName = typeof allWorkshopRecipes[number];
/**
 * The recipe closest to what the card asks for. A learning tool that runs on a schedule (定时, 每晚, 提醒…), works on
 * PDF selections (PDF, 划词) or adds chat commands (斜杠, 命令) gets that service recipe; one that reads like a
 * reference / lookup app (速查, 列表, 搜索, 公式…) without a selection button gets the reference-app recipe; otherwise
 * the template's default.
 */
export function recipeFor(card: Pick<WorkshopCard, 'template' | 'title' | 'description' | 'changes'>): WorkshopRecipeName {
  if (card.template !== 'learning-tool') return workshopRecipes[card.template];
  const text = [card.title, card.description, ...(card.changes ?? [])].join(' ');
  if (SCHEDULE_WORDS.test(text)) return 'nightly-summary';
  if (PDF_WORDS.test(text)) return 'pdf-selection';
  if (COMMAND_WORDS.test(text)) return 'chat-command';
  if (/选中|选区|工具栏|按钮|selection|toolbar/i.test(text)) return 'selection-model';
  return /速查|查询|查找|列表|搜索|公式|词典|字典|清单|小应用|应用|reference|lookup|search|formula|list/i.test(text) ? 'reference-app' : 'selection-model';
}
/** Source files of a recipe (placeholders left in place for the Host to fill); a template means its default recipe. */
export async function recipeFiles(recipe: WorkshopCard['template'] | WorkshopRecipeName): Promise<{ name: string; files: Record<string, string> }> {
  const name = recipe === 'host-tool' || recipe === 'learning-tool' ? workshopRecipes[recipe] : recipe;
  const directory = join(workshopResources, 'recipes', name);
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory)) files[entry] = await readFile(join(directory, entry), 'utf8');
  return { name, files };
}

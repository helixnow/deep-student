/**
 * Style Lab 组合配方契约 — 每套 recipe 必须 parse + registry 校验通过。
 */
import { describe, it, expect } from 'vitest';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import { parseGenerativeUIIntent, validateBlockProps } from '@/features/generative-ui/schema';
import {
  INTENT_RECIPE_IDS,
  INTENT_RECIPES,
  getIntentRecipe,
  listIntentRecipes,
  type IntentRecipe,
} from '@/features/generative-ui/demo/intentRecipes';
import { buildAllBlocksGridIntent } from '@/features/generative-ui/demo/allBlocksFixture';
import { buildStyleLabHpiasResearchIntent } from '@/features/generative-ui/demo/styleLabHpiasDemo';

import '@/features/generative-ui/blocks';

function expectParseAndRegistry(intent: unknown, label: string) {
  const parsed = parseGenerativeUIIntent(JSON.stringify(intent));
  expect(parsed.ok, `${label} parseGenerativeUIIntent`).toBe(true);
  if (!parsed.ok) return;

  expect(parsed.intent.blocks.length).toBeGreaterThan(0);
  for (const block of parsed.intent.blocks) {
    const config = generativeUIRegistry.get(block.type);
    expect(config, `${label} registry missing type ${block.type}`).toBeDefined();
    const validation = validateBlockProps(config!.propsSchema, block.props ?? {});
    expect(validation.ok, `${label} ${block.type} props: ${JSON.stringify(validation)}`).toBe(true);
  }
}

function typesOf(recipe: IntentRecipe): string[] {
  return recipe.intent.blocks.map((block) => block.type);
}

describe('intentRecipes contract', () => {
  it('exports at least 6 combination recipes with stable ids', () => {
    expect(INTENT_RECIPES.length).toBeGreaterThanOrEqual(6);
    expect(INTENT_RECIPE_IDS).toEqual(
      expect.arrayContaining([
        'learning-dashboard',
        'research-briefing',
        'translation-chart',
        'mistake-table',
        'empty-markdown',
        'v11-grid-two-col',
      ]),
    );
    expect(listIntentRecipes().map((recipe) => recipe.id)).toEqual([...INTENT_RECIPE_IDS]);
  });

  it.each(INTENT_RECIPES)(
    'recipe "$id" passes parseGenerativeUIIntent + registry validateBlockProps',
    (recipe) => {
      expectParseAndRegistry(recipe.intent, recipe.id);
      for (const type of recipe.requiredTypes) {
        expect(typesOf(recipe), `${recipe.id} missing ${type}`).toContain(type);
      }
    },
  );

  it('learning dashboard combines chart + table + steps', () => {
    const recipe = getIntentRecipe('learning-dashboard');
    expect(recipe).toBeDefined();
    expect(typesOf(recipe!)).toEqual(expect.arrayContaining(['chart', 'table', 'steps']));
  });

  it('research briefing combines markdown + research-plan (Style Lab HPIAS)', () => {
    const recipe = getIntentRecipe('research-briefing');
    expect(recipe).toBeDefined();
    expect(typesOf(recipe!)).toEqual(expect.arrayContaining(['markdown', 'research-plan']));
    expect(recipe!.intent).toEqual(buildStyleLabHpiasResearchIntent());
  });

  it('translation recipe is chart-led', () => {
    const recipe = getIntentRecipe('translation-chart');
    expect(recipe).toBeDefined();
    expect(typesOf(recipe!)).toContain('chart');
  });

  it('mistake recipe combines table + mistake-analysis', () => {
    const recipe = getIntentRecipe('mistake-table');
    expect(recipe).toBeDefined();
    expect(typesOf(recipe!)).toEqual(expect.arrayContaining(['table', 'mistake-analysis']));
  });

  it('empty-state recipe is markdown-only', () => {
    const recipe = getIntentRecipe('empty-markdown');
    expect(recipe).toBeDefined();
    expect(typesOf(recipe!)).toEqual(['markdown']);
  });

  it('v1.1 grid recipe is two columns', () => {
    const recipe = getIntentRecipe('v11-grid-two-col');
    expect(recipe).toBeDefined();
    expect(recipe!.intent.version).toBe('1.1');
    expect(recipe!.intent.layout).toEqual({ mode: 'grid', columns: 2 });
    expect(recipe!.intent.blocks.some((block) => block.span === 2)).toBe(true);
  });

  it('18-block v1.1 grid showcase also passes parse + registry', () => {
    const intent = buildAllBlocksGridIntent();
    expect(intent.version).toBe('1.1');
    expect(intent.layout).toEqual({ mode: 'grid', columns: 2 });
    expect(intent.blocks).toHaveLength(18);
    expectParseAndRegistry(intent, 'all-blocks-grid');
  });
});

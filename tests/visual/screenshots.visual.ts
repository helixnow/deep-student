/**
 * 12 scenes × desktop 1440×900 | mobile 390×844 × light | dark = 48 screenshots of the demo shell,
 * plus a font-environment fingerprint so a changed font stack fails loudly instead of as 48 diffs.
 */
import { expect, test } from '@playwright/test';
import { newScenePage } from './lib/page.mjs';
import { VISUAL_SCENES, openScene } from './lib/scenes.mjs';
import { serveDirectory } from './lib/serve.mjs';
import { defaultDemoDir } from './lib/build.mjs';

const wanted = process.env.DS_VISUAL_SCENES ? new Set(process.env.DS_VISUAL_SCENES.split(',')) : null;
const scenes = VISUAL_SCENES.filter((scene) => !wanted || wanted.has(scene.id));

let base = process.env.DS_VISUAL_BASE ?? '';
let close: (() => Promise<unknown>) | undefined;

test.beforeAll(async () => {
  if (base) return;
  const server = await serveDirectory(process.env.DS_VISUAL_DIST ?? defaultDemoDir);
  base = server.url;
  close = server.close;
});

test.afterAll(async () => {
  await close?.();
});

test('font environment', async ({ browser }) => {
  const { context, page } = await newScenePage(browser, {});
  try {
    await page.setContent('<!doctype html><html><body></body></html>');
    const probe = await page.evaluate(() => {
      const stacks = {
        ui: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif',
        cjk: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
        app: '"PingFang SC", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Microsoft YaHei", sans-serif',
        mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      };
      const ctx = document.createElement('canvas').getContext('2d')!;
      const sample = 'Deep Student 深度学习 0123456789 — The quick brown fox 资源库';
      return Object.fromEntries(Object.entries(stacks).map(([name, stack]) => {
        ctx.font = `16px ${stack}`;
        return [name, Math.round(ctx.measureText(sample).width * 100) / 100];
      }));
    });
    expect(`${JSON.stringify(probe, null, 2)}\n`).toMatchSnapshot('font-environment.json');
  } finally {
    await context.close();
  }
});

for (const scene of scenes) {
  for (const viewport of ['desktop', 'mobile'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${scene.id} ${viewport} ${theme}`, async ({ browser }) => {
        const { context, page, errors } = await newScenePage(browser, { viewport, theme });
        try {
          expect(await openScene(page, base, scene, theme), 'scene readiness').toBe(true);
          await expect(page).toHaveScreenshot(`${scene.id}-${viewport}-${theme}.png`);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }
}

import React from 'react';
import fs from 'node:fs';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import shellPlugin from '@/ui-plugins/official/shell';
import { actualAppHarness } from './actualAppHarness';

vi.mock('@/styles/motion-springs', () => ({ prefersReducedMotion: () => true }));
afterEach(() => cleanup());

const file = 'src/app/shell/__golden__/actual-app-assembly.json';
const sequence = [
  'chat-v2', 'dashboard', 'settings', 'task-dashboard', 'skills-management',
  'data-management', 'template-management', 'ui-lab', 'learning-hub', 'media',
  'sandbox-workbench', 'pdf-reader', 'todo', 'flashcards', 'crepe-demo',
  'chat-v2-test', 'llm-playground', 'settings', 'learning-hub', 'chat-v2',
];

it('compares the actual App render/assembly with the e73e0d98 oracle (all 17 views)', async () => {
  const revision = process.env.W38_APP_BASELINE;
  // Capturing is permitted ONLY from the pre-refactor git objects, never HEAD.
  if (revision) expect(revision).toBe('e73e0d98');
  const scenarios = [];
  for (const small of [false, true]) {
    let now = 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => ++now);
    const media = vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
      matches: query === '(pointer: coarse)' && small,
      media: query, onchange: null, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    }));
    const kernel = new UiKernel();
    await kernel.install(shellPlugin, { origin: 'builtin' });
    const app = actualAppHarness({ revision, small });
    render(<UiKernelProvider kernel={kernel}><app.App /></UiKernelProvider>);
    const steps = [];
    for (const view of sequence) {
      await act(async () => { app.navigate(view); });
      steps.push({ view,
        layers: Array.from(document.querySelectorAll<HTMLElement>('[data-view-layer-shell]')).map(el => ({
          id: el.dataset.viewLayerShell, class: el.className, style: el.getAttribute('style'),
          pages: Array.from(el.querySelectorAll('[data-page]')).map(page => page.getAttribute('data-page')),
          scaffolds: el.querySelectorAll('[data-scaffold]').length,
        })),
        chrome: Array.from(document.querySelectorAll<HTMLElement>('[data-shell-role], [data-shell-layer], [data-shell-slot]')).map(el => ({
          role: el.dataset.shellRole ?? null, layer: el.dataset.shellLayer ?? null,
          slot: el.dataset.shellSlot ?? null, class: el.className, style: el.getAttribute('style'),
        })),
      });
    }
    if (!revision) {
      for (const module of ['AppShellChrome.tsx', 'useViewLayer.tsx', 'useAppViewState.ts', 'useAppNavigation.ts']) {
        expect(app.executed).toContain(`src/app/shell/${module}`);
      }
    }
    expect(new Set(steps.flatMap(step => step.layers.map(layer => layer.id))).size).toBe(17);
    expect(Math.max(...steps.map(step => step.layers.length))).toBe(small ? 4 : 8);
    scenarios.push({ small, steps });
    cleanup();
    await kernel.dispose();
    clock.mockRestore();
    media.mockRestore();
  }
  if (revision) fs.writeFileSync(file, `${JSON.stringify({ baseline: revision, sequence, scenarios }, null, 2)}\n`);
  expect({ baseline: 'e73e0d98', sequence, scenarios }).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
});

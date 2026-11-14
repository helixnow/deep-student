// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { observeBoot, type BootCase } from './boot-entry-harness';
import { UiKernel, BUILTIN_SLOTS } from '../../ui-kernel/kernel';
import { installOfficialUiPlugins } from '../official/install';
import { memoryRegistryAdapters } from './registries';

export const bootCases: Record<string, BootCase> = {
  normal: { entry: 'main' },
  production: { entry: 'main', production: true, tauri: true },
  'mobile-strict': { entry: 'main', width: 390, strict: true },
  recovery: { entry: 'main', scenario: 'recovery', tauri: true },
  blocked: { entry: 'main', scenario: 'blocked', tauri: true },
  'preflight-desktop-error': { entry: 'main', scenario: 'preflight-error', tauri: true },
  'preflight-web-error': { entry: 'main', scenario: 'preflight-error' },
  'debug-conflict': { entry: 'main', scenario: 'debug:startup-conflict' },
  'debug-preflight': { entry: 'main', scenario: 'debug:startup-preflight-failure' },
  'debug-migration': { entry: 'main', scenario: 'debug:core-migration-failure' },
  pomodoro: { entry: 'main', search: '?window=pomodoro-mini' },
  assistant: { entry: 'main', search: '?window=quick-assistant' },
  demo: { entry: 'demo' },
  'demo-desktop-dark': { entry: 'demo', search: '?desktop=1&theme=dark' },
  'demo-app': { entry: 'demo-app', search: '?app=fixture&theme=dark' },
  'demo-app-missing': { entry: 'demo-app', search: '?app=missing' },
};

describe('actual boot entry behavior before/after UI kernel wiring', () => {
  for (const [name, input] of Object.entries(bootCases)) {
    it(name, async () => {
      const kernels: UiKernel[] = [];
      const providers: UiKernel[] = [];
      const file = path.resolve(`src/ui-plugins/testing/__golden__/boot/${name}.json`);
      const actual = await observeBoot(input, (kernel) => kernels.push(kernel), (kernel) => providers.push(kernel));
      expect(actual).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
      const expectedKernel = !['recovery', 'blocked', 'preflight-desktop-error', 'debug-conflict', 'debug-preflight', 'debug-migration', 'demo-app-missing', 'pomodoro', 'assistant'].includes(name);
      expect(kernels).toHaveLength(expectedKernel ? 1 : 0);
      expect(providers).toEqual(kernels);
      if (expectedKernel) {
        const reference = new UiKernel(memoryRegistryAdapters());
        await installOfficialUiPlugins(reference);
        expect(kernels[0].list()).toEqual(reference.list());
        for (const { name } of BUILTIN_SLOTS) {
          const metadata = (kernel: UiKernel) => kernel.slots.list(name).map(({ id, key, order, owner, origin }) => ({ id, key, order, owner, origin }));
          expect(metadata(kernels[0])).toEqual(metadata(reference));
          expect(metadata(kernels[0]).every((entry) => entry.origin === 'builtin')).toBe(true);
        }
        await reference.dispose();
        await kernels[0].dispose();
      }
      if (input.entry !== 'main') {
        expect(actual.demo).toBe(true);
        const mockAt = actual.trace.findIndex((e: any[]) => e[0] === 'mocks');
        const businessAt = actual.trace.findIndex((e: any[]) => e[0] === 'import' && /\/(App|features|components|hooks|contexts)\b/.test(e[1]));
        if (businessAt !== -1) expect(mockAt).toBeLessThan(businessAt);
      }
    });
  }
});

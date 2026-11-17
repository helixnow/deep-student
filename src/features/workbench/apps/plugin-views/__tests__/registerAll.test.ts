import { afterEach, expect, it, vi } from 'vitest';
import { UiKernel, defineUiPlugin } from '@/ui-kernel/kernel';
import { provideAppUiKernel } from '@/ui-kernel/app-kernel';
import { appRegistry } from '../../../core/appRegistry';

// Keep the production assembly entry real while leaving unrelated built-in applications out of this focused fixture.
vi.mock('../../chat/register', () => ({}));
vi.mock('../../content/register', () => ({}));
vi.mock('../../notes/register', () => ({}));
vi.mock('../../files/register', () => ({}));
vi.mock('../../preview/register', () => ({}));
vi.mock('../../ai-dashboard/register', () => ({}));
vi.mock('../../system/register', () => ({ registerSystemApps: vi.fn() }));
vi.mock('../../sandbox/register', () => ({ registerSandboxApp: vi.fn() }));
vi.mock('../../browser/register', () => ({ registerBrowserApp: vi.fn() }));
vi.mock('../../desktop/register', () => ({ registerDesktopAgentTarget: vi.fn() }));

const kernel = new UiKernel();
afterEach(async () => { await kernel.dispose(); provideAppUiKernel(undefined); });

it('starts the community view mirror from the actual Workbench registration entry', async () => {
  await import('../../registerAll');
  provideAppUiKernel(kernel);
  await kernel.install(defineUiPlugin({
    meta: { id: 'workshop.boot-test', version: '1.0.0' },
    apply(ctx) { ctx.ui.views.register({ id: 'boot-test', titleKey: 'title', component: () => null }); },
  }));
  expect(appRegistry.get('plugin-view.boot-test')).toMatchObject({
    typeId: 'plugin-view.boot-test', agentManifest: { capabilities: [], observe: expect.any(Function) },
  });
  await kernel.unload('workshop.boot-test');
  expect(appRegistry.get('plugin-view.boot-test')).toBeUndefined();
});
